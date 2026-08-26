import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Field, Header, Screen, spacing } from '../components/ui';
import {
  UnifiedPipelineStageView,
  type UnifiedPipelineStageItem,
  type UnifiedPipelineStageStatus,
} from '../components/UnifiedPipelineStageView';
import { useThemeStore } from '../store/themeStore';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import {
  CommonActions,
  NavigationRouteContext,
  useNavigation,
  type NavigationProp,
  type ParamListBase,
  type RouteProp,
} from '@react-navigation/native';
import * as db from '../services/database';
import { computeInputFingerprint } from '../services/outlineContextBuilder';
import { adoptPipelineTaskResult } from '../services/multiChapterBatch/batchAdoption';
import {
  createOutlineResumeWritingKernelExecution,
  createOutlineWritingKernelExecution,
  runWritingKernel,
} from '../services/writing';
import {
  CURRENT_OUTLINE_WORKFLOW_VERSION,
  PHASE2_CONTEXT_BUDGET_VERSION,
  isCompactPipelineTopology,
  isCurrentOutlinePipelineContextBudgetVersion,
} from '../services/pipeline/outlineWorkflowVersion';
import {
  resetFailedStageCheckpointsForResume,
} from '../data/repositories/pipelineStageCheckpointRepository';
import { getOutboxByDedupe } from '../services/continuation/generation/generationRepository';
import { createDerivedFinalRewriteTask } from '../services/pipeline/derivedFinalRewrite';
import { FinalManuscriptCard } from '../components/FinalManuscriptCard';
import { buildFinalArtifactFromOutlineTask } from '../services/writing/finalArtifactData';
import { navigateToChapterEditor } from '../navigation/navigationRef';
import type { PipelineStageResult, PipelineTask } from '../types/pipeline';
import type {
  WritingKernelStage,
  WritingKernelStageEvent,
  WritingKernelTrace,
} from '../services/writing/contracts/frozenWritingContext';

type ResultRouteProp = RouteProp<{ PipelineResult: { taskId: string } }, 'PipelineResult'>;

const STAGE_LABELS: Record<PipelineStageResult['stage'], string> = {
  draft: '初稿',
  // Phase 4 §7.2: the unified qa stage replaces the legacy trio for the
  // compact Standard path; the label surfaces in the result screen so users
  // can correlate against the QA call in the ledger.
  qa: 'QA 检查',
  review: '审阅/评估',
  factCheck: '事实核查',
  brief: '终稿 Brief',
  proof: '终稿',
};

const STATUS_LABELS: Record<PipelineStageResult['status'], string> = {
  success: '成功',
  failed: '失败',
  skipped: '已跳过',
};

const BRIEF_IMMUTABLE_KEYS = new Set([
  'sourceHash',
  'requiredSourceIds',
  'protectedFacts',
  'hardConstraints',
  'mustNotAdvance',
  'outlineObligations',
  'endingBoundary',
]);

/**
 * Local Brief-envelope ownership is an expected normalization, not an
 * actionable warning. Keep it in the durable warning array for diagnostics,
 * but render it as a compact neutral notice so a successful Brief does not
 * look like a failed stage. Historical tasks may use either 信封 or 封套.
 */
export function splitStageWarnings(stage: PipelineStageResult): {
  warnings: string[];
  notices: string[];
} {
  if (stage.stage !== 'brief' || !stage.warnings?.length) {
    return { warnings: stage.warnings || [], notices: [] };
  }

  const notices: string[] = [];
  const warnings: string[] = [];
  for (const message of stage.warnings) {
    const isImmutableOverride = [...BRIEF_IMMUTABLE_KEYS].some(key =>
      new RegExp(
        `^Brief ${key} 已由本地不可变(?:信封|封套)覆盖$`,
      ).test(message),
    );
    const isCoverageDiagnostic = message.startsWith(
      'Brief coveredRequiredIds 仅作为诊断；最终覆盖集合已由 mustFix.sourceIds 本地计算',
    );
    const isExecutionNote =
      /^Brief Compiler.*（.*）$/.test(message) ||
      /^Contract Formatter（.*）$/.test(message) ||
      /^合同首轮通过/.test(message);
    if (isImmutableOverride || isCoverageDiagnostic || isExecutionNote) {
      notices.push(message);
    } else {
      warnings.push(message);
    }
  }
  return { warnings, notices };
}

/**
 * Render stage body for the result cards.
 * Audit stages must only show validated JSON reports — never raw novel prose
 * or model reasoning (those are never persisted as stage text after the audit
 * validity fix). Failed empty stages surface the structured error message.
 */
const OUTLINE_STATUS_LABELS: Record<string, string> = {
  aligned: '一致',
  partial: '部分一致',
  deviated: '偏离主线',
  over_advanced: '进度超前',
};

/**
 * One effective result per stage (prefer success > skipped > failed; last wins).
 * Result page must not guess via unbounded .find on append-only history.
 */
export function uniqueStageResults(
  stageResults: PipelineStageResult[],
): PipelineStageResult[] {
  const priority: Record<string, number> = {
    success: 50,
    skipped: 40,
    failed: 30,
  };
  const map = new Map<string, PipelineStageResult>();
  for (const row of stageResults || []) {
    if (!row?.stage) continue;
    const prev = map.get(row.stage);
    const pri = priority[row.status] ?? 0;
    const prevPri = prev ? priority[prev.status] ?? 0 : -1;
    if (!prev || pri >= prevPri) {
      map.set(row.stage, row);
    }
  }
  return ['draft', 'qa', 'review', 'factCheck', 'brief', 'proof']
    .map(s => map.get(s))
    .filter(Boolean) as PipelineStageResult[];
}

/** Parse review-stage outlineAssessment for the dedicated report card. */
export function parseOutlineAssessmentFromReview(
  stageResults: PipelineStageResult[],
): {
  status: string;
  fulfilledBeats: string[];
  missingBeats: string[];
  deviations: string[];
  prematureBeats: string[];
  factRollbackRisks: string[];
} | null {
  const review = uniqueStageResults(stageResults).find(
    s => s.stage === 'review' && s.status === 'success' && s.text,
  );
  if (!review?.text) return null;
  try {
    const parsed = JSON.parse(review.text);
    const oa = parsed?.outlineAssessment;
    if (!oa || typeof oa !== 'object') return null;
    return {
      status: String(oa.status || ''),
      fulfilledBeats: Array.isArray(oa.fulfilledBeats) ? oa.fulfilledBeats : [],
      missingBeats: Array.isArray(oa.missingBeats) ? oa.missingBeats : [],
      deviations: Array.isArray(oa.deviations) ? oa.deviations : [],
      prematureBeats: Array.isArray(oa.prematureBeats) ? oa.prematureBeats : [],
      factRollbackRisks: Array.isArray(oa.factRollbackRisks)
        ? oa.factRollbackRisks
        : [],
    };
  } catch {
    return null;
  }
}

export function formatStageText(stage: PipelineStageResult): string {
  if (stage.status === 'failed' && !stage.text?.trim()) {
    return stage.error || '该阶段失败。';
  }
  if (!stage.text) {
    return stage.status === 'skipped' ? '该阶段已跳过。' : '';
  }
  if (
    stage.stage !== 'review' &&
    stage.stage !== 'factCheck' &&
    stage.stage !== 'brief'
  ) {
    return stage.text;
  }
  try {
    return JSON.stringify(JSON.parse(stage.text), null, 2);
  } catch {
    // Safety net: never dump long invalid body into the audit card.
    if (stage.text.length > 400) {
      return stage.error || '审核结果格式异常，已隐藏无效内容。';
    }
    return stage.text;
  }
}

function parseOutlineKernelTrace(
  pipelineContextJson: string | null | undefined,
): WritingKernelTrace | null {
  if (!pipelineContextJson) return null;
  try {
    const parsed = JSON.parse(pipelineContextJson);
    const trace =
      parsed?.draftContext?.writingKernelTrace || parsed?.writingKernelTrace;
    return trace && Array.isArray(trace.events)
      ? (trace as WritingKernelTrace)
      : null;
  } catch {
    return null;
  }
}

function latestKernelEvent(
  trace: WritingKernelTrace | null,
  stage: WritingKernelStage,
): WritingKernelStageEvent | null {
  if (!trace) return null;
  for (let index = trace.events.length - 1; index >= 0; index -= 1) {
    const event = trace.events[index];
    if (event.stage === stage) return event;
  }
  return null;
}

function mapKernelStatus(
  event: WritingKernelStageEvent | null,
): UnifiedPipelineStageStatus {
  if (!event) return 'pending';
  if (event.status === 'completed') return 'success';
  if (event.status === 'skipped') return 'skipped';
  if (event.status === 'blocked') return 'failed';
  return 'running';
}

function mapPipelineStageStatus(
  result: PipelineStageResult | null,
): UnifiedPipelineStageStatus {
  if (!result) return 'pending';
  if (result.status === 'success') return 'success';
  if (result.status === 'skipped') return 'skipped';
  return 'failed';
}

function readOutlineExecutionProfile(
  task: Pick<PipelineTask, 'pipelineContextJson'>,
): 'standard' | 'one_shot' {
  const trace = parseOutlineKernelTrace(task.pipelineContextJson);
  const frozenProfile = (trace as any)?.observability?.executionProfile;
  if (frozenProfile === 'one_shot') return 'one_shot';
  try {
    const parsed = task.pipelineContextJson
      ? JSON.parse(task.pipelineContextJson)
      : null;
    const profile =
      parsed?.execution?.executionProfile ||
      parsed?.draftContext?.frozenWritingContext?.stagePolicy?.values
        ?.executionProfile ||
      parsed?.frozenWritingContext?.stagePolicy?.values?.executionProfile;
    return profile === 'one_shot' ? 'one_shot' : 'standard';
  } catch {
    return 'standard';
  }
}

export function isUnifiedOutlinePipelineTask(
  task: Pick<PipelineTask, 'pipelineTopologyVersion' | 'pipelineContextJson'>,
): boolean {
  if (isCompactPipelineTopology(task.pipelineTopologyVersion)) return true;
  const trace = parseOutlineKernelTrace(task.pipelineContextJson);
  const topology = (trace as any)?.frozenWritingContext?.stagePolicy?.values
    ?.pipelineTopologyVersion;
  if (topology === 'compact_standard') return true;
  try {
    const parsed = task.pipelineContextJson
      ? JSON.parse(task.pipelineContextJson)
      : null;
    return (
      parsed?.execution?.pipelineTopologyVersion === 'compact_standard' ||
      parsed?.draftContext?.frozenWritingContext?.stagePolicy?.values
        ?.pipelineTopologyVersion === 'compact_standard'
    );
  } catch {
    return false;
  }
}

export type OutlineMemoryOutboxState = 'pending' | 'running' | 'completed' | 'failed';

function outlineMemoryOutboxDedupeKey(
  trace: WritingKernelTrace | null,
): string | null {
  const event = trace?.writingPersistedEvent;
  if (!event || event.scenario !== 'outline') return null;
  return `rebuild_story_memory:outline:${event.projectId}:${event.chapterId}:${event.finalBodyFingerprint}`;
}

/** Build the shared current-task view; Legacy task rows keep their audit UI. */
export function buildUnifiedOutlineStageItems(
  task: Pick<
    PipelineTask,
    | 'stageResults'
    | 'pipelineContextJson'
    | 'status'
    | 'finalText'
    | 'resolvedAction'
    | 'error'
  >,
  options: { memoryOutboxState?: OutlineMemoryOutboxState | null } = {},
  ): UnifiedPipelineStageItem[] {
  const trace = parseOutlineKernelTrace(task.pipelineContextJson);
  const resultFor = (stage: PipelineStageResult['stage']) =>
    uniqueStageResults(task.stageResults).find(row => row.stage === stage) ||
    null;
  const resultItem = (
    id: UnifiedPipelineStageItem['id'],
    result: PipelineStageResult | null,
    eventStage: WritingKernelStage,
  ): UnifiedPipelineStageItem => {
    const event = latestKernelEvent(trace, eventStage);
    const status = result ? mapPipelineStageStatus(result) : mapKernelStatus(event);
    const observed = trace?.observability?.stages.find(
      row => row.stage === eventStage,
    );
    const detail =
      result?.error ||
      result?.errorCode ||
      event?.skipReason ||
      event?.detail ||
      (status === 'pending' ? '尚未进入该阶段。' : undefined);
    const meta = observed
      ? `逻辑 ${observed.logicalStageCallCount} · Formatter ${observed.formatterCallCount} · 物理 ${observed.physicalRequestCount} · Fallback ${observed.protocolFallbackCount} · ${(observed.inputTokens + observed.outputTokens).toLocaleString()} tokens`
      : result?.tokens
      ? `逻辑调用 ${result.status === 'skipped' ? 0 : 1} 次 · ${result.tokens.total.toLocaleString()} tokens`
      : event?.status === 'skipped'
        ? '0 次付费调用'
        : undefined;
    return {
      id,
      status,
      detail,
      meta,
      body: result?.text ? formatStageText(result) : undefined,
    };
  };

  const freezeEvent = latestKernelEvent(trace, 'freeze');
  const finalValidateEvent = latestKernelEvent(trace, 'finalValidate');
  const persistEvent = latestKernelEvent(trace, 'persist');
  const postWritingEvent = latestKernelEvent(trace, 'postWritingUpdate');
  const adopted = task.resolvedAction === 'accept';
  const postWritingClosed = postWritingEvent?.status === 'completed';
  const memoryOutboxState = options.memoryOutboxState ?? null;
  const finalTextAvailable = Boolean(task.finalText?.trim());

  return [
    {
      id: 'freeze',
      status: mapKernelStatus(freezeEvent),
      detail:
        freezeEvent?.detail ||
        (freezeEvent ? undefined : '等待共享 Context Freeze。'),
      meta: freezeEvent?.status === 'completed' ? 'Frozen Context 已绑定' : undefined,
    },
    resultItem('draft', resultFor('draft'), 'draft'),
    resultItem('qa', resultFor('qa'), 'qa'),
    resultItem('revision', resultFor('brief'), 'revision'),
    {
      id: 'finalValidate',
      status:
        finalValidateEvent
          ? mapKernelStatus(finalValidateEvent)
          : task.status === 'completed' && finalTextAvailable
            ? 'success'
            : task.status === 'failed'
              ? 'failed'
              : 'pending',
      detail:
        finalValidateEvent?.detail ||
        (task.status === 'failed' ? task.error || 'FinalValidate 未通过。' : undefined),
      meta: finalValidateEvent?.status === 'completed' ? 'Local Gate' : undefined,
    },
    {
      id: 'persist',
      status:
        persistEvent
          ? mapKernelStatus(persistEvent)
          : task.status === 'completed' && finalTextAvailable
            ? 'success'
            : task.status === 'failed'
              ? 'failed'
              : 'pending',
      detail:
        persistEvent?.detail ||
        (adopted
          ? '生成账本已交由采纳闭环处理。'
          : '终稿通过后生成账本等待采纳。'),
      meta: persistEvent?.status === 'completed' ? '统一 Persist' : undefined,
    },
    {
      id: 'postWriting',
      status: postWritingEvent
        ? mapKernelStatus(postWritingEvent)
        : 'pending',
      detail:
        postWritingEvent?.detail ||
        (adopted
          ? '正文已采纳但仍为草稿；定稿后才启用唯一 PostWriting 闭环。'
          : '采纳后才启用 PostWriting。'),
      meta: postWritingEvent?.status === 'completed' ? '已完成' : undefined,
    },
    {
      id: 'memory',
      status: !postWritingClosed
        ? 'pending'
        : memoryOutboxState === 'completed'
          ? 'success'
          : memoryOutboxState === 'failed'
            ? 'failed'
            : 'running',
      detail: !postWritingClosed
        ? adopted
          ? '正文仍为草稿；定稿后的 PostWriting 才会创建 ONE Memory outbox。'
          : '采纳并定稿后由唯一 ONE Memory outbox 接续。'
        : memoryOutboxState === 'completed'
          ? 'ONE Memory outbox 已完成；最终 through_chapter 以只读 DB 为准。'
          : memoryOutboxState === 'failed'
            ? 'ONE Memory outbox 失败；可通过冷启动/显式重试恢复，未伪报完成。'
            : memoryOutboxState === 'pending'
              ? 'WritingPersistedEvent 已闭合，ONE Memory outbox 等待消费。'
              : memoryOutboxState === 'running'
                ? 'ONE Memory outbox 正在消费。'
                : 'PostWriting 已闭合，正在读取唯一 ONE Memory outbox 状态。',
      meta:
        memoryOutboxState === 'completed'
          ? '已完成'
          : memoryOutboxState === 'failed'
            ? '失败'
            : postWritingClosed
              ? '等待结算'
              : undefined,
    },
  ];
}

export function summarizePipelineTokens(stageResults: PipelineStageResult[]): { inputTokens: number; totalTokens: number } {
  return stageResults.reduce(
    (summary, stage) => ({
      inputTokens: summary.inputTokens + (stage.tokens?.input || 0),
      totalTokens: summary.totalTokens + (stage.tokens?.total || 0),
    }),
    { inputTokens: 0, totalTokens: 0 },
  );
}

export interface PipelineResultScreenProps {
  taskId?: string;
  onClose?: () => void;
  onAdopted?: (text: string) => void;
}

export function closePipelineResult(
  navigation: Pick<NavigationProp<ParamListBase>, 'dispatch' | 'getState' | 'goBack'>,
  onClose?: () => void,
): void {
  if (onClose) {
    onClose();
    return;
  }

  const state = navigation.getState();
  if (state.index > 0) {
    navigation.goBack();
    return;
  }

  const fallbackRoute = state.routeNames.includes('SettingsMain')
    ? 'SettingsMain'
    : state.routeNames.includes('EditorMain')
      ? 'EditorMain'
      : null;
  if (fallbackRoute) {
    navigation.dispatch(CommonActions.reset({
      index: 0,
      routes: [{ name: fallbackRoute }],
    }));
    return;
  }

  navigation.goBack();
}

export const PipelineResultScreen: React.FC<PipelineResultScreenProps> = ({ taskId: propTaskId, onClose, onAdopted }) => {
  const { theme } = useThemeStore();
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  // Hook 必须在顶层调用：直接读取 NavigationRouteContext，避免 useRoute 在
  // 非导航上下文（Modal 模式）中抛错。用可选链安全访问 params。
  const route = useContext(NavigationRouteContext) as ResultRouteProp | undefined;
  const routeTaskId: string | undefined = route?.params?.taskId;
  const taskId = propTaskId ?? routeTaskId;
  const { tasks, resolveTask, loadTaskDetails } = usePipelineTaskStore();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showDetails, setShowDetails] = useState(false);
  const [chapterTitle, setChapterTitle] = useState<string | null>(null);
  // 10.2: 采纳进行中状态，disable 采纳/放弃按钮防止重复点击触发多次 updateChapter
  const [adopting, setAdopting] = useState(false);
  const [rewriteVisible, setRewriteVisible] = useState(false);
  const [rewriteInstruction, setRewriteInstruction] = useState('');
  const [outlineMemoryOutboxState, setOutlineMemoryOutboxState] =
    useState<OutlineMemoryOutboxState | null>(null);
  const detailLoadAttemptedRef = useRef<Set<string>>(new Set());
  // 标记是否已被 handleAccept 标记为 accept，避免 unmount cleanup 的
  // setTimeout 与 handleAccept 的 resolveTask('accept') 竞态重复 resolve。
  const acceptedRef = useRef(false);

  const handleClose = useCallback(
    () => closePipelineResult(navigation, onClose),
    [navigation, onClose],
  );

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      handleClose();
      return true;
    });
    return () => subscription.remove();
  }, [handleClose]);

  useEffect(() => {
    if (!taskId || detailLoadAttemptedRef.current.has(taskId)) return;
    const current = tasks.find(item => item.id === taskId);
    const needsDetails =
      !current ||
      current.pipelineContextJson == null ||
      ((current.status === 'completed' || current.status === 'failed') &&
        current.finalText == null);
    if (needsDetails && typeof loadTaskDetails === 'function') {
      detailLoadAttemptedRef.current.add(taskId);
      void loadTaskDetails(taskId).catch(error => {
        console.warn('[pipeline] failed to load result details:', error);
      });
    }
  }, [loadTaskDetails, taskId, tasks]);

  useEffect(() => {
    const current = tasks.find(item => item.id === taskId);
    const trace = current ? parseOutlineKernelTrace(current.pipelineContextJson) : null;
    const postWritingEvent = latestKernelEvent(trace, 'postWritingUpdate');
    const dedupeKey = outlineMemoryOutboxDedupeKey(trace);
    if (
      !current ||
      !isUnifiedOutlinePipelineTask(current) ||
      postWritingEvent?.status !== 'completed' ||
      !dedupeKey
    ) {
      setOutlineMemoryOutboxState(null);
      return;
    }

    let cancelled = false;
    setOutlineMemoryOutboxState(null);
    getOutboxByDedupe(dedupeKey)
      .then(outbox => {
        if (cancelled) return;
        const state = String(outbox?.state || '');
        setOutlineMemoryOutboxState(
          state === 'pending' ||
            state === 'running' ||
            state === 'completed' ||
            state === 'failed'
            ? state
            : null,
        );
      })
      .catch(() => {
        // A read failure keeps the UI in the explicit unknown/waiting state;
        // it must never be rendered as Memory success.
        if (!cancelled) setOutlineMemoryOutboxState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, tasks]);

  const task = tasks.find((t) => t.id === taskId);

  const finalArtifact = useMemo(
    () =>
      task && task.finalText
        ? buildFinalArtifactFromOutlineTask(task as any)
        : null,
    [task],
  );

  useEffect(() => {
    let cancelled = false;
    if (task?.targetType === 'chapter') {
      db.getChapterById(task.targetId)
        .then(chapter => {
          if (!cancelled) setChapterTitle(chapter?.title ?? null);
        })
        .catch(() => {
          if (!cancelled) setChapterTitle(null);
        });
    } else {
      setChapterTitle(null);
    }
    return () => {
      cancelled = true;
    };
  }, [task?.id, task?.targetType, task?.targetId]);

  // Closing this screen means “look at it later”, not “discard the result”.
  // Resolving it from unmount made a completed-but-unadopted task disappear
  // from the task centre, forcing the user to run the pipeline again.  Only
  // the explicit 放弃/采纳 actions below resolve a task.

  if (!task) {
    return (
      <Screen>
        <Header title="流水线结果" action={<Button label="返回" variant="ghost" onPress={handleClose} />} />
        <Text style={{ padding: spacing.lg, color: theme.colors.textSecondary }}>任务不存在或已被清除。</Text>
      </Screen>
    );
  }

  const isUnifiedTask = isUnifiedOutlinePipelineTask(task);
  const unifiedProfile = readOutlineExecutionProfile(task);
  const unifiedTrace = isUnifiedTask
    ? parseOutlineKernelTrace(task.pipelineContextJson)
    : null;
  const unifiedStageItems = isUnifiedTask
    ? buildUnifiedOutlineStageItems(task, {
        memoryOutboxState: outlineMemoryOutboxState,
      })
    : [];
  const observedLlm = unifiedTrace?.observability?.llm;
  const tokenSummary = summarizePipelineTokens(task.stageResults);
  const inputTokens = observedLlm?.inputTokens ?? tokenSummary.inputTokens;
  const totalTokens = observedLlm
    ? observedLlm.inputTokens + observedLlm.outputTokens
    : tokenSummary.totalTokens;
  const unifiedCallSummary = observedLlm
    ? `逻辑 ${observedLlm.logicalStageCallCount} · Formatter ${observedLlm.formatterCallCount} · 物理 ${observedLlm.physicalRequestCount} · Fallback ${observedLlm.protocolFallbackCount} · Retry 0`
    : null;
  const skippedCount = task.stageResults.filter((stage) => stage.status === 'skipped').length;
  const failedAuditCount = task.stageResults.filter(
    (stage) =>
      (stage.stage === 'review' || stage.stage === 'factCheck') &&
      stage.status === 'failed',
  ).length;
  const proofStage = uniqueStageResults(task.stageResults).find(
    stage => stage.stage === 'proof',
  );
  const duration = task.updatedAt - task.createdAt;
  const durationText = duration > 60000
    ? `${Math.floor(duration / 60000)}m ${Math.round((duration % 60000) / 1000)}s`
    : `${Math.round(duration / 1000)}s`;
  const retainedDraft =
    task.status === 'failed' && Boolean(task.finalText && task.finalText.trim());
  // 任务仍在后台运行（idle/排队/初稿/审阅/核查/终审）：结果页只展示
  // 历史阶段卡，不允许采纳/放弃（finalText 是旧初稿），也不显示重启。
  const RUNNING_STATUSES = new Set([
    'idle',
    'queued',
    'drafting',
    'reviewing',
    'factChecking',
    'briefing',
    'proofing',
  ]);
  const isRunning = RUNNING_STATUSES.has(task.status);
  const RUNNING_STAGE_LABEL: Record<string, string> = {
    idle: '准备中',
    queued: '排队中',
    drafting: isUnifiedTask ? '生成' : '初稿生成',
    reviewing: isUnifiedTask ? '检查/修订' : '审阅/评估',
    factChecking: isUnifiedTask ? '检查' : '事实核查',
    briefing: isUnifiedTask ? '修订' : 'Brief 编译',
    proofing: isUnifiedTask ? '校验' : '终审',
  };
  const statusSummary =
    task.status === 'completed'
      ? failedAuditCount > 0
        ? `已完成（${failedAuditCount} 项审核失败）`
        : '已完成'
      : isRunning
        ? `进行中 · ${RUNNING_STAGE_LABEL[task.status] || '运行中'}`
        : task.status === 'failed'
          ? retainedDraft
            ? '未完整完成（已保留初稿）'
            : proofStage?.status === 'failed'
              ? '终稿失败，可从失败节点重试'
              : '异常终止'
          : task.status === 'interrupted'
            ? retainedDraft
              ? '已中断（已保留初稿）'
              : '已中断，可从失败阶段继续'
            : task.status === 'cancelled'
              ? '已取消'
              : '进行中';

  const toggleExpanded = (stage: string) => {
    const next = new Set(expanded);
    if (next.has(stage)) next.delete(stage);
    else next.add(stage);
    setExpanded(next);
  };

  const handleAccept = async () => {
    // 10.2: 防止按钮被重复点击触发多次 updateChapter
    if (adopting) return;
    if (!task.finalText || task.targetType !== 'chapter') {
      Alert.alert('无法采纳', '该任务不支持直接采纳，请手动复制文本。');
      return;
    }
    setAdopting(true);
    try {
      const chapter = await db.getChapterById(task.targetId);
      if (!chapter) {
        Alert.alert('章节不存在');
        return;
      }

      // Adopt-time drift detection (Schema 37): if the task carries a frozen
      // input fingerprint, recompute the live one and warn the user when the
      // outline or chapter changed between generation and adoption. The user
      // may still proceed — this is a warning, not a block.
      const baselineFp = task.inputFingerprint;
      if (baselineFp) {
        try {
          const liveFp = await computeInputFingerprint({
            projectId: chapter.project_id,
            chapterId: chapter.id,
            chapterUpdatedAt: chapter.updated_at,
          });
          if (liveFp !== baselineFp) {
            const proceed = await new Promise<boolean>(resolve => {
              Alert.alert(
                '资料已变化',
                '本结果基于任务启动时的大纲/章节版本。当前大纲或章节资料已变化，采纳前请确认结果仍然合适。',
                [
                  { text: '取消', style: 'cancel', onPress: () => resolve(false) },
                  { text: '仍然采纳', style: 'destructive', onPress: () => resolve(true) },
                ],
              );
            });
            if (!proceed) {
              setAdopting(false);
              return;
            }
          }
        } catch {
          /* best-effort: drift check failure never blocks adoption */
        }
      }

      // Phase 7: manual and batch adoption share ONE domain service. The
      // service keeps every side effect (old-body revision, chapter write,
      // updated_at, task resolved, story memory dirty mark). Drift warning
      // below is UI-only (batch adoption is guarded by the batch state
      // machine instead).
      await adoptPipelineTaskResult({
        taskId: task.id,
        chapterId: task.targetId,
        source: 'manual',
      });
      acceptedRef.current = true; // 标记已 accept，阻止 unmount cleanup 重复 resolve
      Alert.alert('已采纳', '流水线正文已覆盖到章节并保存。');
      onAdopted?.(task.finalText);
      handleClose();
    } catch (error: any) {
      Alert.alert('采纳失败', error.message);
      setAdopting(false);
    }
  };

  const handleReject = () => {
    // 10.2: 采纳进行中时禁止 reject，避免竞态
    if (adopting) return;
    resolveTask(task.id, 'reject');
    handleClose();
  };

  // F2-07: 失败/中断时从失败环节重启 —— 只重跑失败的 stage（复用 frozen
  // request），已成功的阶段不重复计费。仅 draft 失败（无成功阶段）也必须
  // 提供重试入口：状态机从初稿 checkpoint 重新开始，与首次运行等价。
  // interrupted（进程被杀/超时/后台重启未完成）同样必须能继续：它只是
  // 尚未跑完，不是终态。只有 completed / cancelled / running 中的任务
  // 不提供重启入口。
  const failedStages = uniqueStageResults(task.stageResults).filter(
    s => s.status === 'failed',
  );
  const succeededStages = uniqueStageResults(task.stageResults).filter(
    s => s.status === 'success',
  );
  const isCurrentTask =
    Number(task.outlineWorkflowVersion) === CURRENT_OUTLINE_WORKFLOW_VERSION &&
    isCurrentOutlinePipelineContextBudgetVersion(task.contextBudgetVersion);
  const canResumeFailed =
    task.targetType === 'chapter' &&
    isCurrentTask &&
    (task.status === 'failed' || task.status === 'interrupted') &&
    (failedStages.length > 0 || task.status === 'interrupted');
  const legacyIncomplete =
    task.targetType === 'chapter' &&
    !isCurrentTask &&
    (task.status === 'failed' || task.status === 'interrupted');
  const resumeLabel =
    succeededStages.length > 0 ? '从失败节点重试' : '重新尝试';

  const isCurrentStructuredTask = (() => {
    if (
      Number(task.outlineWorkflowVersion) !== CURRENT_OUTLINE_WORKFLOW_VERSION ||
      !isCurrentOutlinePipelineContextBudgetVersion(
        task.contextBudgetVersion,
      ) ||
      !task.pipelineContextJson
    ) {
      return false;
    }
    try {
      const parsed = JSON.parse(task.pipelineContextJson);
      return Number(parsed?.execution?.reasoningProfileVersion) === 5;
    } catch {
      return false;
    }
  })();
  const canRewriteFinal =
    task.targetType === 'chapter' &&
    task.status === 'completed' &&
    Boolean(task.finalText?.trim()) &&
    isCurrentStructuredTask;

  const handleResumeFailed = async () => {
    if (adopting) return;
    if (!canResumeFailed) return;
    const failedLabels = failedStages
      .map(s => STAGE_LABELS[s.stage])
      .join('、');
    const proceedCopy =
      succeededStages.length > 0
        ? isUnifiedTask
          ? `仅重试未完成阶段（${failedLabels || '剩余阶段'}），已成功的生成/检查/修订/校验阶段将直接复用，不会重复计费。确定继续？`
          : `仅重试未完成阶段（${failedLabels || '剩余阶段'}），已成功的阶段（初稿/审阅/核查/Brief）将直接复用，不会重复计费。确定继续？`
        : isUnifiedTask
          ? '从共享 Freeze 后的生成阶段重新运行，不会重复计费已完成的请求。确定继续？'
          : '从初稿阶段重新运行完整流水线，不会重复计费未完成的请求。确定继续？';
    const proceed = await new Promise<boolean>(resolve => {
      Alert.alert(
        succeededStages.length > 0 ? '从失败节点重试' : '重新尝试',
        proceedCopy,
        [
          { text: '取消', style: 'cancel', onPress: () => resolve(false) },
          { text: '重试', onPress: () => resolve(true) },
        ],
      );
    });
    if (!proceed) return;
    setAdopting(true);
    try {
      const chapter = await db.getChapterById(task.targetId);
      if (!chapter) {
        Alert.alert('章节不存在');
        setAdopting(false);
        return;
      }
      // 失败/中断的 checkpoint 重置为 pending；pipeline 状态机只重跑这些。
      await resetFailedStageCheckpointsForResume(task.id);
      const resumedAt = Date.now();
      // task 转 interrupted（resume 路径）；若旧任务已有 finalText 也保留，
      // 但 V3 失败路径不会把初稿写成可采纳终稿。
      await db.updatePipelineTaskResumeState(task.id, resumedAt);
      usePipelineTaskStore
        .getState()
        .registerPersistedTask({
          ...task,
          status: 'interrupted',
          error: null,
          updatedAt: resumedAt,
          resolvedAt: null,
          resolvedAction: null,
        });
      await runWritingKernel(
        createOutlineResumeWritingKernelExecution({
          taskId: task.id,
          chapter,
        }),
      );
      Alert.alert('已重试', '流水线已从失败节点继续，可在任务中心查看进度。');
      handleClose();
    } catch (error: any) {
      Alert.alert('重试失败', error?.message || '未知错误');
      setAdopting(false);
    }
  };

  const handleRestartLegacy = async () => {
    if (adopting || isCurrentTask || task.targetType !== 'chapter') return;
    const proceed = await new Promise<boolean>(resolve => {
      Alert.alert(
        '按新版重新生成',
        '旧版未完成任务不能继续。将创建一条新的完整流水线任务，旧任务和尝试记录会保留。',
        [
          { text: '取消', style: 'cancel', onPress: () => resolve(false) },
          { text: '创建新版任务', onPress: () => resolve(true) },
        ],
      );
    });
    if (!proceed) return;
    setAdopting(true);
    try {
      const chapter = await db.getChapterById(task.targetId);
      if (!chapter) throw new Error('章节不存在');
      const newTaskId = await usePipelineTaskStore.getState().createTask(
        'chapter',
        task.targetId,
        {
          outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
          contextBudgetVersion: PHASE2_CONTEXT_BUDGET_VERSION,
        },
      );
      Alert.alert('新版任务已创建', '完整流水线已开始，可在任务中心查看进度。');
      runWritingKernel(
        createOutlineWritingKernelExecution({
          taskId: newTaskId,
          chapter,
        }),
      ).catch(error => {
        console.warn('[pipeline] current restart failed:', error);
      });
      handleClose();
    } catch (error: any) {
      Alert.alert('创建新版任务失败', error?.message || '请重试');
      setAdopting(false);
    }
  };

  const handleCreateFinalRewrite = async () => {
    if (adopting) return;
    const instruction = rewriteInstruction.trim();
    if (!instruction) {
      Alert.alert('需要修订要求', '请补充一条希望终稿调整的要求。');
      return;
    }
    const proceed = await new Promise<boolean>(resolve => {
      Alert.alert(
        '确认仅重写终稿',
        '将复用原任务冻结的 Draft、审阅、核查、Brief 和连续性证据，只新增一次 Final API 调用并产生费用。Brief 硬约束、人物/世界观事实和大纲边界优先于这条要求。继续吗？',
        [
          { text: '取消', style: 'cancel', onPress: () => resolve(false) },
          { text: '确认并执行', onPress: () => resolve(true) },
        ],
      );
    });
    if (!proceed) return;
    setAdopting(true);
    try {
      const chapter = await db.getChapterById(task.targetId);
      if (!chapter) {
        Alert.alert('章节不存在');
        setAdopting(false);
        return;
      }
      const derived = await createDerivedFinalRewriteTask(task.id, instruction);
      setRewriteVisible(false);
      setRewriteInstruction('');
      setAdopting(false);
      runWritingKernel(
        createOutlineResumeWritingKernelExecution({
          taskId: derived.id,
          chapter,
        }),
      ).catch(error => {
        console.warn('[pipeline] derived Final rewrite failed:', error);
      });
      Alert.alert('已创建派生任务', '仅重写终稿已开始，可在任务中心查看新结果。');
      handleClose();
    } catch (error: any) {
      Alert.alert('无法创建派生任务', error?.message || '未知错误');
      setAdopting(false);
    }
  };

  const renderStageCard = (stage: PipelineStageResult) => {
    const isExpanded = expanded.has(stage.stage);
    const textLength = stage.text?.length || 0;
    const statusColor = stage.status === 'failed'
      ? theme.colors.danger
      : stage.status === 'skipped'
        ? theme.colors.textMuted
        : theme.colors.accent;
    const lengthLabel =
      stage.status === 'failed' && !stage.text?.trim()
        ? '无有效报告'
        : `${textLength} 字`;

    return (
      <View key={stage.stage} style={[styles.card, { backgroundColor: theme.colors.card }]}>
        <Button
          label={`${STAGE_LABELS[stage.stage]} · ${STATUS_LABELS[stage.status]} (${lengthLabel})`}
          variant="ghost"
          onPress={() => toggleExpanded(stage.stage)}
        />
        <Text
          style={[styles.stageMeta, { color: statusColor }]}
        >
          耗时 {Math.round(stage.durationMs / 1000)}s
          {stage.tokens ? ` · ${stage.tokens.total.toLocaleString()} tokens` : ''}
          {stage.tokens?.visible != null
            ? ` · 可见 ${stage.tokens.visible.toLocaleString()}`
            : ''}
          {stage.tokens?.reasoning != null
            ? ` · Thinking ${stage.tokens.reasoning.toLocaleString()}`
            : ''}
          {stage.error ? ` · ${stage.error}` : ''}
        </Text>
        {(() => {
          const { warnings, notices } = splitStageWarnings(stage);
          return (
            <>
              {notices.length ? (
                <Text style={[styles.stageMeta, { color: theme.colors.textSecondary }]}>
                  说明：{notices.join('；')}
                </Text>
              ) : null}
              {warnings.length ? (
                <Text style={[styles.stageMeta, { color: theme.colors.warning }]}>
                  提示：{warnings.join('；')}
                </Text>
              ) : null}
            </>
          );
        })()}
        {isExpanded && (
          <Text
            style={[styles.stageText, { color: theme.colors.textPrimary }]}
            selectable
          >
            {formatStageText(stage)}
          </Text>
        )}
      </View>
    );
  };

  return (
    <Screen>
      <Header
        title="流水线结果"
        action={<Button label="返回" variant="ghost" onPress={handleClose} />}
      />
      <ScrollView contentContainerStyle={styles.content}>
        {chapterTitle ? (
          <Text style={[styles.chapterTitle, { color: theme.colors.textPrimary }]}>
            {chapterTitle}
          </Text>
        ) : null}
        {finalArtifact ? (
          <View style={styles.finalArtifactWrap}>
            <FinalManuscriptCard
              artifact={finalArtifact}
              onEdit={() => navigateToChapterEditor(task.targetId)}
            />
          </View>
        ) : null}
        {!isUnifiedTask && !isRunning && proofStage?.status === 'skipped' && failedAuditCount > 0 ? (
          <Text style={[styles.summary, { color: theme.colors.danger }]}>
            审核未通过，未执行终审，已保留初稿
          </Text>
        ) : null}
        {!isUnifiedTask && !isRunning && proofStage?.status === 'failed' ? (
          <Text style={[styles.summary, { color: theme.colors.danger }]}>
            {proofStage.error || '终稿失败，请从失败节点重试'}
          </Text>
        ) : null}
        {isRunning ? (
          <Text style={[styles.summary, { color: theme.colors.warning }]}>
            任务仍在后台运行，页面显示的是已完成阶段的历史记录；运行结束后
            可在此查看最终结果并采纳。
          </Text>
        ) : null}
        {(task.finalText && !isRunning) || canResumeFailed || legacyIncomplete ? (
          <View testID="pipeline-result-actions" style={[styles.actions, styles.topActions]}>
            {legacyIncomplete ? (
              <Button
                label="按新版重新生成"
                variant="ghost"
                compact
                onPress={handleRestartLegacy}
                disabled={adopting}
              />
            ) : null}
            {canResumeFailed ? (
              <Button
                label={resumeLabel}
                variant="ghost"
                compact
                onPress={handleResumeFailed}
                disabled={adopting}
              />
            ) : null}
            {task.finalText && !isRunning ? (
              <>
                <Button label="放弃" variant="ghost" compact onPress={handleReject} disabled={adopting} />
                <Button label={adopting ? '采纳中…' : '采纳'} compact onPress={handleAccept} disabled={adopting} />
              </>
            ) : null}
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          style={styles.detailsToggle}
          onPress={() => setShowDetails(prev => !prev)}
        >
          <Text style={[styles.detailsToggleText, { color: theme.colors.textSecondary }]}>
            {showDetails ? '▼' : '▶'} 生成详情（Token / 调用 / 阶段）
          </Text>
        </Pressable>
        {showDetails ? (
          <View style={styles.detailsBody}>
            <Text style={[styles.summary, { color: theme.colors.textSecondary }]}>
              {statusSummary} · 耗时 {durationText} · {totalTokens.toLocaleString()} tokens · 跳过 {skippedCount} 阶段
            </Text>
            <Text style={[styles.summary, { color: theme.colors.textSecondary }]}>
              本次输入上下文 tokens：{inputTokens.toLocaleString()}
            </Text>
            {!isUnifiedTask
              ? (() => {
                  const assessment = parseOutlineAssessmentFromReview(task.stageResults);
                  if (!assessment) return null;
                  const list = (title: string, items: string[]) =>
                    items.length > 0 ? (
                      <View key={title} style={{ marginTop: spacing.sm }}>
                        <Text style={[styles.stageMeta, { color: theme.colors.textSecondary }]}>
                          {title}
                        </Text>
                        {items.map((item, idx) => (
                          <Text
                            key={`${title}-${idx}`}
                            style={[styles.stageText, { color: theme.colors.textPrimary }]}
                          >
                            · {item}
                          </Text>
                        ))}
                      </View>
                    ) : null;
                  return (
                    <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
                      <Text style={[styles.summary, { color: theme.colors.textPrimary }]}>
                        大纲执行报告 ·{' '}
                        {OUTLINE_STATUS_LABELS[assessment.status] || assessment.status || '未知'}
                      </Text>
                      {list('已完成节点', assessment.fulfilledBeats)}
                      {list('遗漏节点', assessment.missingBeats)}
                      {list('主线偏离', assessment.deviations)}
                      {list('提前发生节点', assessment.prematureBeats)}
                      {list('历史回滚风险', assessment.factRollbackRisks)}
                      {!assessment.fulfilledBeats.length &&
                      !assessment.missingBeats.length &&
                      !assessment.deviations.length &&
                      !assessment.prematureBeats.length &&
                      !assessment.factRollbackRisks.length ? (
                        <Text style={[styles.stageText, { color: theme.colors.textMuted }]}>
                          未发现额外的大纲节点问题。
                        </Text>
                      ) : null}
                    </View>
                  );
                })()
              : null}
            {isUnifiedTask ? (
              <UnifiedPipelineStageView
                profile={unifiedProfile}
                compact
                items={unifiedStageItems}
                summary={`${statusSummary} · ${unifiedCallSummary || `${totalTokens.toLocaleString()} tokens`} · 正式跳过 ${skippedCount} 阶段`}
              />
            ) : (
              uniqueStageResults(task.stageResults).map(renderStageCard)
            )}
          </View>
        ) : null}
        {canRewriteFinal ? (
          <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
            <Text style={[styles.summary, { color: theme.colors.textPrimary }]}>
              仅重写终稿
            </Text>
            <Text style={[styles.stageMeta, { color: theme.colors.textSecondary }]}>
              复用全部前置证据，只执行一次新的 Final；原任务与原终稿保持不变。
            </Text>
            {rewriteVisible ? (
              <>
                <Field
                  label="补充一条修订要求"
                  value={rewriteInstruction}
                  onChangeText={setRewriteInstruction}
                  multiline
                  maxLength={2000}
                  placeholder="例如：放慢对话节奏，增加环境感官描写，但不要改变事实和结尾边界。"
                  inputStyle={styles.rewriteInput}
                />
                <View style={styles.rewriteActions}>
                  <Button
                    label="取消"
                    variant="ghost"
                    onPress={() => setRewriteVisible(false)}
                    disabled={adopting}
                  />
                  <Button
                    label={adopting ? '创建中…' : '确认并执行'}
                    onPress={handleCreateFinalRewrite}
                    disabled={adopting}
                  />
                </View>
              </>
            ) : (
              <Button
                label="仅重写终稿"
                variant="ghost"
                onPress={() => setRewriteVisible(true)}
                disabled={adopting}
              />
            )}
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: 72 },
  summary: { fontSize: 13, fontWeight: '700' },
  finalArtifactWrap: { marginTop: spacing.sm },
  chapterTitle: {
    fontSize: 22,
    fontFamily: 'serif',
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  detailsToggle: {
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
  },
  detailsToggleText: { fontSize: 13, fontWeight: '600' },
  detailsBody: { gap: spacing.sm, marginBottom: spacing.md },
  card: { borderRadius: 8, padding: spacing.md, gap: spacing.sm },
  stageMeta: { fontSize: 12, fontWeight: '700' },
  stageText: { fontSize: 14, lineHeight: 22, marginTop: spacing.sm },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.sm },
  topActions: { justifyContent: 'flex-start', marginTop: 0, marginBottom: spacing.xs, flexWrap: 'wrap' },
  rewriteInput: { minHeight: 96, textAlignVertical: 'top' },
  rewriteActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md },
});

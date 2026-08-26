/**
 * Continuation generation result page (Spec §10.2, fix-plan §4).
 * Independent from freeform PipelineResultScreen adoption path.
 *
 * Branches on run.state so the user can complete every workflow the services
 * already support:
 *  - awaiting_user + pending plan → confirm plan and continue, or abandon
 *  - interrupted (app was killed) → resume from the last persisted stage, or abandon
 *  - failed → short error + retry guidance (no prompt/body/credentials)
 *  - outdated (Source/Canon changed) → adoption blocked, re-launch against latest
 *  - awaiting_user with an artifact → adopt as draft / abandon (original path)
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { Button, Card, Header, Screen, spacing } from '../../components/ui';
import {
  UnifiedPipelineStageView,
  type UnifiedPipelineStageItem,
  type UnifiedPipelineStageStatus,
} from '../../components/UnifiedPipelineStageView';
import { useThemeStore } from '../../store/themeStore';
import { FinalManuscriptCard } from '../../components/FinalManuscriptCard';
import {
  buildFinalArtifactFromContinuationArtifacts,
  type FinalWritingArtifact,
} from '../../services/writing/finalArtifactData';
import {
  abandonRun,
  adoptArtifactAsDraft,
  confirmPlanAndContinue,
  repairContinuationArtifactOnce,
} from '../../services/writing/persist/continuationAdoption';
import {
  getArtifactForRun,
  getLatestArtifact,
  getLatestArtifactForStage,
  getLatestEligibleArtifact,
  getPlan,
  getRunById,
  getRunContextSnapshotJson,
  listStageResults,
  listChecksForArtifact,
  type ContinuationArtifact,
  type ContinuationCheckResult,
  type ContinuationGenerationRun,
  type ContinuationGenerationStageResult,
  type ContinuationPlan,
} from '../../services/continuation/generation';
import { getChapterById } from '../../services/database';
import { runContinuationWritingKernel } from '../../services/writing';
import {
  ContinuationConflictError,
  ContinuationOutdatedError,
} from '../../services/continuation/generation/types';
import type {
  WritingKernelStage,
  WritingKernelStageEvent,
  WritingKernelTrace,
} from '../../services/writing/contracts/frozenWritingContext';

interface Props {
  runId: string;
  onClose: () => void;
}

const V4_LENGTH_ADVISORY_TEXT = '篇幅偏差仅供参考，未因此触发自动 Repair。';

type RejectedRepairAudit = {
  content: string;
  rejectionCode?: string | null;
  repairOutputJson?: string | null;
  localVerifyOutputJson?: string | null;
};

function parseStageJson(value: string | null | undefined): any | null {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * The persisted workflowVersion is a continuation contract version, not the
 * active execution profile.  The old result page used workflowVersion=5 as a
 * proxy for the V1/V2/V3 three-draft UI, which made a unified One-Shot run
 * look like the retired V5 route.  Read the frozen profile instead.
 */
export function readContinuationExecutionProfile(
  contextSnapshotJson: string | null | undefined,
): 'standard' | 'one_shot' {
  if (!contextSnapshotJson) return 'standard';
  try {
    const snapshot = JSON.parse(contextSnapshotJson);
    return snapshot?.frozenWritingContext?.stagePolicy?.values
      ?.executionProfile === 'one_shot'
      ? 'one_shot'
      : 'standard';
  } catch {
    return 'standard';
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

function mapContinuationStageStatus(
  result: ContinuationGenerationStageResult | null,
): UnifiedPipelineStageStatus {
  if (!result) return 'pending';
  if (result.status === 'success') return 'success';
  if (result.status === 'skipped') return 'skipped';
  if (result.status === 'running' || result.status === 'queued') {
    return 'running';
  }
  return 'failed';
}

function chooseContinuationStageResult(
  rows: ContinuationGenerationStageResult[],
  stage: ContinuationGenerationStageResult['stage'],
): ContinuationGenerationStageResult | null {
  const priority: Record<string, number> = {
    success: 50,
    skipped: 40,
    running: 30,
    queued: 20,
    failed: 10,
    interrupted: 10,
  };
  return rows
    .filter(row => row.stage === stage)
    .sort(
      (left, right) =>
        (priority[right.status] ?? 0) - (priority[left.status] ?? 0) ||
        String(right.updatedAt).localeCompare(String(left.updatedAt)),
    )[0] ?? null;
}

function continuationStageDetail(
  result: ContinuationGenerationStageResult | null,
  event: WritingKernelStageEvent | null,
): string | undefined {
  const parsed = parseStageJson(result?.outputJson);
  return (
    result?.errorMessage ||
    result?.errorCode ||
    event?.skipReason ||
    parsed?.envelope?.skipReason ||
    event?.detail ||
    (result?.status === 'skipped' ? '正式跳过' : undefined)
  );
}

function continuationStageMeta(
  result: ContinuationGenerationStageResult | null,
  trace: WritingKernelTrace | null,
  stage: UnifiedPipelineStageItem['id'],
): string | undefined {
  const kernelStage =
    stage === 'draft'
      ? 'draft'
      : stage === 'qa'
        ? 'qa'
        : stage === 'revision'
          ? 'revision'
          : stage === 'finalValidate'
            ? 'finalValidate'
            : null;
  const observed = kernelStage
    ? trace?.observability?.stages.find(row => row.stage === kernelStage)
    : null;
  if (observed) {
    const tokens = observed.inputTokens + observed.outputTokens;
    return `逻辑 ${observed.logicalStageCallCount} · Formatter ${observed.formatterCallCount} · 物理 ${observed.physicalRequestCount} · Fallback ${observed.protocolFallbackCount} · ${tokens} tokens`;
  }
  if (!result) return undefined;
  const tokens =
    result.inputTokens != null || result.outputTokens != null
      ? ` · ${(result.inputTokens ?? 0) + (result.outputTokens ?? 0)} tokens`
      : '';
  return `${result.requestCount} 次物理请求${tokens}`;
}

function continuationStageBody(
  result: ContinuationGenerationStageResult | null,
  artifact?: ContinuationArtifact | null,
): string | undefined {
  if (artifact?.content) return artifact.content;
  const parsed = parseStageJson(result?.outputJson);
  if (!parsed) return undefined;
  return JSON.stringify(parsed, null, 2);
}

export function buildUnifiedContinuationStageItems(input: {
  run: Pick<
    ContinuationGenerationRun,
    'state' | 'completionReason' | 'finalizedRevisionHash'
  >;
  stageResults: ContinuationGenerationStageResult[];
  kernelTrace: WritingKernelTrace | null;
  draftArtifact?: ContinuationArtifact | null;
  revisionArtifact?: ContinuationArtifact | null;
  finalArtifact?: ContinuationArtifact | null;
}): UnifiedPipelineStageItem[] {
  const { run, stageResults, kernelTrace } = input;
  const resultFor = (stage: ContinuationGenerationStageResult['stage']) =>
    chooseContinuationStageResult(stageResults, stage);
  const eventFor = (stage: WritingKernelStage) =>
    latestKernelEvent(kernelTrace, stage);
  const resultItem = (
    id: UnifiedPipelineStageItem['id'],
    result: ContinuationGenerationStageResult | null,
    eventStage: WritingKernelStage,
    artifact?: ContinuationArtifact | null,
  ): UnifiedPipelineStageItem => {
    const event = eventFor(eventStage);
    const status = result
      ? mapContinuationStageStatus(result)
      : mapKernelStatus(event);
    return {
      id,
      status,
      detail: continuationStageDetail(result, event),
      meta: continuationStageMeta(result, kernelTrace, id),
      body: continuationStageBody(result, artifact),
    };
  };

  const adopted =
    run.state === 'completed' &&
    (run.completionReason === 'adopted' || Boolean(run.finalizedRevisionHash));
  const postWriting = eventFor('postWritingUpdate');
  return [
    {
      id: 'freeze',
      status: mapKernelStatus(eventFor('freeze')),
      detail: eventFor('freeze')?.detail || 'Frozen Context 已绑定。',
      meta: eventFor('freeze')?.status === 'completed' ? 'Context immutable' : undefined,
    },
    resultItem('draft', resultFor('draft_writer'), 'draft', input.draftArtifact),
    resultItem('qa', resultFor('unified_qa'), 'qa'),
    resultItem(
      'revision',
      resultFor('revision_writer'),
      'revision',
      input.revisionArtifact,
    ),
    resultItem('finalValidate', resultFor('final_validate'), 'finalValidate'),
    {
      id: 'persist',
      status: mapKernelStatus(eventFor('persist')),
      detail: eventFor('persist')?.detail || '统一 Persist 只保存 Final Candidate。',
      meta: eventFor('persist')?.status === 'completed' ? '已写入生成账本' : undefined,
      body: continuationStageBody(resultFor('final_validate'), input.finalArtifact),
    },
    {
      id: 'postWriting',
      status: postWriting
        ? mapKernelStatus(postWriting)
        : adopted
          ? 'running'
          : 'pending',
      detail:
        postWriting?.detail ||
        (adopted
          ? '采纳后由唯一 PostWriting 闭环接续。'
          : '采纳后才启用 PostWriting。'),
      meta: postWriting?.status === 'completed' ? '已完成' : undefined,
    },
    {
      id: 'memory',
      status: adopted ? 'running' : 'pending',
      detail: adopted
        ? '由唯一 ONE Memory outbox 接续；最终状态以账本与 outbox 为准。'
        : '采纳后由唯一 ONE Memory outbox 接续。',
      meta: adopted ? '等待 Memory 结算' : undefined,
    },
  ];
}

export const ContinuationResultScreen: React.FC<Props> = ({
  runId,
  onClose,
}) => {
  const { theme } = useThemeStore();
  const colors = theme.colors;
  const [loading, setLoading] = useState(true);
  const [run, setRun] = useState<ContinuationGenerationRun | null>(null);
  const [plan, setPlan] = useState<ContinuationPlan | null>(null);
  const [planConfirmationStatus, setPlanConfirmationStatus] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [repairRound, setRepairRound] = useState(0);
  const [checks, setChecks] = useState<ContinuationCheckResult[]>([]);
  const [stageTelemetry, setStageTelemetry] = useState<Record<string, any>>({});
  const [executionProfile, setExecutionProfile] = useState<
    'standard' | 'one_shot'
  >('standard');
  const [kernelTrace, setKernelTrace] = useState<WritingKernelTrace | null>(
    null,
  );
  const [stageResults, setStageResults] = useState<ContinuationGenerationStageResult[]>([]);
  const [v5DraftArtifact, setV5DraftArtifact] =
    useState<ContinuationArtifact | null>(null);
  const [v5RevisionArtifact, setV5RevisionArtifact] =
    useState<ContinuationArtifact | null>(null);
  const [v5FinalArtifact, setV5FinalArtifact] =
    useState<ContinuationArtifact | null>(null);
  const [rejectedRepair, setRejectedRepair] = useState<RejectedRepairAudit | null>(null);
  const [showRejectedRepair, setShowRejectedRepair] = useState(false);
  const [finalArtifact, setFinalArtifact] = useState<FinalWritingArtifact | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getRunById(runId);
      setRun(r);
      if (!r) return;
      let frozenSnapshot: string | null = null;
      try {
        frozenSnapshot = await getRunContextSnapshotJson(r.id);
      } catch {
        // Historical rows may not have a readable snapshot; keep the safe
        // Standard display rather than making the result screen fail closed.
      }
      setExecutionProfile(readContinuationExecutionProfile(frozenSnapshot));
      const parsedSnapshot = parseStageJson(frozenSnapshot);
      setKernelTrace(
        parsedSnapshot?.writingKernelTrace &&
          Array.isArray(parsedSnapshot.writingKernelTrace.events)
          ? (parsedSnapshot.writingKernelTrace as WritingKernelTrace)
          : null,
      );
      try {
        const usage = JSON.parse(r.tokenUsageJson || '{}');
        setStageTelemetry(usage.stages ?? {});
      } catch {
        setStageTelemetry({});
      }
      const p = await getPlan(runId);
      setPlan(p?.plan ?? null);
      setPlanConfirmationStatus(p?.confirmationStatus ?? null);
      const isV4 = r.workflowVersion === 4;
      const isV5 = r.workflowVersion === 5;
      const art =
        isV4 || isV5
          ? await getLatestEligibleArtifact(runId)
          : await getLatestArtifact(runId);
      setBody(art?.content ?? '');
      setRepairRound(
        art?.stage === 'repair' || art?.stage === 'final' ? art.repairRound : 0,
      );
      if (art) {
        setChecks(await listChecksForArtifact(runId, art.id));
      } else {
        setChecks([]);
      }
      if (isV4 || isV5) {
        const results = await listStageResults(runId);
        setStageResults(results);
        if (isV5) {
          const [draftArt, revisionArt, finalArt] = await Promise.all([
            getLatestArtifactForStage(runId, 'draft'),
            getLatestArtifactForStage(runId, 'revision_1'),
            getLatestArtifactForStage(runId, 'final'),
          ]);
          setV5DraftArtifact(draftArt);
          setV5RevisionArtifact(revisionArt);
          // Prefer eligible final for display body; fall back to any final row.
          const displayFinalArt = art?.stage === 'final' ? art : finalArt ?? art ?? null;
          setV5FinalArtifact(displayFinalArt);
          setFinalArtifact(
            buildFinalArtifactFromContinuationArtifacts({
              runId: r.id,
              chapterId: Number((r as any).chapterId ?? (r as any).chapter_id ?? 0),
              draftRow: draftArt,
              finalRow: displayFinalArt,
              kernelTrace: parsedSnapshot?.writingKernelTrace ?? null,
            }),
          );
          setRejectedRepair(null);
        } else if (isV4) {
          setV5DraftArtifact(null);
          setV5RevisionArtifact(null);
          setV5FinalArtifact(null);
          const repair = results.find(result => result.stage === 'repair');
          const localVerify = results.find(
            result => result.stage === 'local_verify',
          );
          if (repair?.artifactId) {
            const candidate = await getArtifactForRun(runId, repair.artifactId);
            setRejectedRepair(
              candidate?.eligibilityStatus === 'rejected'
                ? {
                    content: candidate.content,
                    rejectionCode: candidate.rejectionCode,
                    repairOutputJson: repair.outputJson,
                    localVerifyOutputJson: localVerify?.outputJson ?? null,
                  }
                : null,
            );
          } else {
            setRejectedRepair(null);
          }
        }
      } else {
        setStageResults([]);
        setV5DraftArtifact(null);
        setV5RevisionArtifact(null);
        setV5FinalArtifact(null);
        setRejectedRepair(null);
      }
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    reload().catch(() => setLoading(false));
  }, [reload]);

  const doAdopt = async (
    options: { forceOverwrite?: boolean; allowOpenChecks?: boolean } = {},
  ) => {
    setBusy(true);
    try {
      await adoptArtifactAsDraft({
        runId,
        forceOverwrite: options.forceOverwrite,
        allowOpenChecks: options.allowOpenChecks,
      });
      Toast.show({
        type: 'success',
        text1: options.allowOpenChecks
          ? '已按用户选择采纳风险候选'
          : '已采纳为章节草稿',
      });
      onClose();
    } catch (e: any) {
      if (e instanceof ContinuationConflictError) {
        Alert.alert('章节已变更', e.message, [
          { text: '取消', style: 'cancel' },
          {
            text: '仍要覆盖',
            style: 'destructive',
            onPress: () => {
              doAdopt({
                forceOverwrite: true,
                allowOpenChecks: options.allowOpenChecks,
              }).catch(() => {});
            },
          },
        ]);
      } else if (e instanceof ContinuationOutdatedError) {
        Toast.show({
          type: 'error',
          text1: '续写已过期',
          text2: '原著或 Canon 已更新，请按最新版本重新发起。',
        });
        await reload();
      } else {
        Toast.show({
          type: 'error',
          text1: '采纳失败',
          text2: e?.message,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const doAbandon = async () => {
    setBusy(true);
    try {
      await abandonRun(runId);
      Toast.show({ type: 'info', text1: '已放弃本次续写' });
      onClose();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '放弃失败', text2: e?.message });
    } finally {
      setBusy(false);
    }
  };

  const doConfirmPlan = async () => {
    setBusy(true);
    try {
      await confirmPlanAndContinue(runId);
      Toast.show({ type: 'success', text1: '已确认规划，继续生成' });
      await reload();
    } catch (e: any) {
      // Never expose prompt/body/credentials; only the short service message.
      Toast.show({ type: 'error', text1: '确认失败', text2: e?.message });
    } finally {
      setBusy(false);
    }
  };

  const doResume = async () => {
    setBusy(true);
    try {
      if (!run) throw new Error('找不到待重启的续写任务');
      const chapter = await getChapterById(run.chapterId);
      if (!chapter) throw new Error('章节不存在，无法重启续写');
      const restarted = await runContinuationWritingKernel({
        projectId: run.projectId,
        chapterId: run.chapterId,
        targetPosition: Number(run.targetPosition),
        userInstruction: run.userInstruction,
        currentChapterContent: chapter.content || '',
      });
      Toast.show({
        type: 'success',
        text1: '已按新版 Writing Kernel 重启',
        text2: `新任务 ${restarted.id.slice(0, 12)} 已开始`,
      });
      onClose();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '恢复失败', text2: e?.message });
    } finally {
      setBusy(false);
    }
  };

  const headerAction = (
    <Button label="返回" variant="ghost" onPress={onClose} />
  );

  if (loading) {
    return (
      <Screen>
        <Header title="流水线结果" action={headerAction} />
        <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />
      </Screen>
    );
  }

  if (!run) {
    return (
      <Screen>
        <Header title="流水线结果" action={headerAction} />
        <Text style={{ color: colors.textPrimary, padding: spacing.md }}>
          找不到续写任务 {runId}
        </Text>
      </Screen>
    );
  }

  const isV4LengthAdvisoryCheck = (check: ContinuationCheckResult) =>
    run.workflowVersion === 4 &&
    (String(check.subtype).startsWith('chapter_length_') ||
      String(check.subtype).startsWith('repair_length_'));
  const displaySeverity = (check: ContinuationCheckResult) =>
    isV4LengthAdvisoryCheck(check) ? 'warning' : check.severity;
  const blocking = checks.filter(
    c => displaySeverity(c) === 'blocking' && c.resolutionStatus === 'open',
  ).length;
  const errors = checks.filter(
    c => displaySeverity(c) === 'error' && c.resolutionStatus === 'open',
  ).length;
  const warnings = checks.filter(
    c => displaySeverity(c) === 'warning' && c.resolutionStatus === 'open',
  ).length;
  const overlapBlocked = checks.some(
    c =>
      c.resolutionStatus === 'open' &&
      c.severity === 'error' &&
      (c.subtype === 'source_overlap' ||
        c.subtype === 'continuation_anchor_overlap'),
  );
  const reviewBlocked = blocking + errors > 0;
  const additionalRepairUsed =
    Number(stageTelemetry.repair?.additionalRequestCount ?? 0) > 0;
  const firstRepairAttempted =
    Number(stageTelemetry.repair?.requestCount ?? 0) > 0;
  const additionalRepairAvailable =
    run.workflowVersion === 2 &&
    reviewBlocked &&
    (repairRound > 0 || firstRepairAttempted) &&
    !additionalRepairUsed;
  const repairCandidateRejected =
    stageTelemetry.repair?.warning ===
    'repair_candidate_rejected_as_over_contracted';

  const toggleExpanded = (section: string) => {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const renderPlan = () => {
    if (!plan) return null;
    return (
      <View style={styles.block}>
        <Text style={[styles.h, { color: colors.textPrimary }]}>
          {run.workflowVersion === 2 ? 'Writer 同次生成的章节计划' : '规划'}
        </Text>
        <Text style={{ color: colors.textPrimary }}>{plan.chapterGoal}</Text>
        <Text style={{ color: colors.textSecondary }}>
          冲突：{plan.centralConflict}
        </Text>
        {plan.beats.length > 0 && (
          <Text style={{ color: colors.textSecondary, marginTop: 4 }}>
            节拍：{plan.beats.map(b => b.summary).join(' / ')}
          </Text>
        )}
        {plan.risks.length > 0 && (
          <View style={{ marginTop: 6 }}>
            <Text style={[styles.h, { color: colors.textPrimary, fontSize: 13 }]}>
              风险项
            </Text>
            {plan.risks.map((r, i) => (
              <Text
                key={i}
                style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 2 }}
              >
                [{r.severity}] {r.description}
              </Text>
            ))}
          </View>
        )}
        {plan.participatingCharacterIds.length > 0 && (
          <Text style={{ color: colors.textSecondary, marginTop: 4 }}>
            参与人物：{plan.participatingCharacterIds.join('、')}
          </Text>
        )}
      </View>
    );
  };

  const renderChecks = () => (
    <View style={styles.block}>
      <Text style={[styles.h, { color: colors.textPrimary }]}>
        一致性 · blocking {blocking} · error {errors} · warning {warnings}
      </Text>
      {checks.slice(0, 30).map(c => (
        <Text
          key={c.id}
          style={{ color: colors.textPrimary, marginBottom: 6, fontSize: 13 }}
        >
          [{displaySeverity(c)}/{c.category}] {c.description}
          {c.evidenceIds.length
            ? ` · 证据#${c.evidenceIds.join(',')}`
            : c.subtype === 'source_overlap' ||
                c.subtype === 'continuation_anchor_overlap'
              ? ' · 本地确定性命中（连续原文）'
            : ' · 无证据(推测)'}
        </Text>
      ))}
      {checks.length === 0 && (
        <Text style={{ color: colors.textSecondary }}>暂无检查结果</Text>
      )}
    </View>
  );

  const renderBodyPreview = () => (
    <View style={styles.block}>
      <Text style={[styles.h, { color: colors.textPrimary }]}>正文预览</Text>
      <Text style={{ color: colors.textPrimary }}>
        {body || '（尚无正文）'}
      </Text>
    </View>
  );

  const v4Stage = (stage: ContinuationGenerationStageResult['stage']) =>
    stageResults.find(result => result.stage === stage) ?? null;

  const v4StageStatus = (stage: ContinuationGenerationStageResult['stage']) => {
    const result = v4Stage(stage);
    if (!result) return '未开始';
    switch (result.status) {
      case 'success':
        return '成功';
      case 'failed':
        return '降级/失败';
      case 'interrupted':
        return '已中断';
      case 'skipped':
        return '已短路';
      case 'running':
        return '进行中';
      default:
        return '排队中';
    }
  };

  const v4StageText = (stage: ContinuationGenerationStageResult['stage']) => {
    const result = v4Stage(stage);
    if (!result) return '暂无持久化结果。';
    if (stage === 'writer') {
      return body || 'Writer 尚未落库完整正文。';
    }
    if (stage === 'checker') {
      try {
        const parsed = result.outputJson ? JSON.parse(result.outputJson) : null;
        const issues = Array.isArray(parsed?.issues) ? parsed.issues : [];
        return issues.length
          ? issues.map((issue: any) => `[${issue.severity || 'warning'}] ${issue.description || '语义问题'}`).join('\n')
          : '未发现可操作的冻结 Canon/状态语义问题。';
      } catch {
        return result.errorMessage || 'Checker 结果不可解析。';
      }
    }
    if (stage === 'control') {
      try {
        const parsed = result.outputJson ? JSON.parse(result.outputJson) : null;
        const referenceTarget =
          parsed?.targetHan ?? parsed?.referenceTargetHan ?? '—';
        const actualHan = parsed?.currentHan ?? parsed?.actualWriterHan ?? '—';
        const metrics = parsed
          ? `用户参考篇幅：${referenceTarget}\n实际汉字：${actualHan}\n${V4_LENGTH_ADVISORY_TEXT}`
          : `本地篇幅诊断已由客户端计算；${V4_LENGTH_ADVISORY_TEXT}`;

        // Prefer explicit styleIssues / styleWarnings; fall back to findings.
        const readyList: any[] = Array.isArray(parsed?.styleIssues)
          ? parsed.styleIssues
          : Array.isArray(parsed?.findings)
            ? parsed.findings.filter((f: any) => f?.repairReady)
            : [];
        const warningList: any[] = Array.isArray(parsed?.styleWarnings)
          ? parsed.styleWarnings
          : Array.isArray(parsed?.findings)
            ? parsed.findings.filter((f: any) => !f?.repairReady)
            : [];

        const renderStyleRow = (item: any, tag: string) => {
          const dim =
            item?.styleDimension || item?.subtype || item?.dimension || 'style';
          const desc = item?.description || item?.rewriteGoal || '文风观察';
          const goal = item?.rewriteGoal || item?.suggestedFix;
          const excerpt = item?.generatedExcerpt
            ? ` 摘录：「${String(item.generatedExcerpt).slice(0, 48)}」`
            : '';
          const ready =
            item?.repairReady === true
              ? ' → 进入 Repair'
              : ' → 仅审计，不进入 Repair';
          const evidence = Array.isArray(item?.styleEvidenceIds)
            ? `；证据=${item.styleEvidenceIds.join(',') || 'none'}`
            : '';
          const confidence =
            typeof item?.confidence === 'number'
              ? `；confidence=${item.confidence}`
              : '；confidence=missing';
          const binding = item?.bindingStatus
            ? `；绑定=${item.bindingStatus}`
            : '';
          return `[${tag}/${dim}] ${desc}${excerpt}${
            goal ? `\n  改写目标：${goal}` : ''
          }${evidence}${confidence}${binding}${ready}`;
        };

        const detailLines = [
          ...readyList.map((item: any) => renderStyleRow(item, '可执行')),
          ...warningList.map((item: any) => renderStyleRow(item, 'warning')),
        ];

        let mode: string;
        if (result.status === 'failed' || result.status === 'interrupted') {
          mode = `Control LLM 未完成文风审查（${
            result.errorCode || result.errorMessage || 'failed'
          }）。本地 fallback 不含强制文风任务，本 run 无 style finding 注入 Repair。`;
        } else if (detailLines.length === 0) {
          mode =
            '原著文风审查已完成：未发现可定位、可修订的局部文风问题。因此没有文风任务进入 Repair（0 项 style finding）。';
        } else {
          mode = `原著文风审查：可执行 ${readyList.length} 项，audit warning ${warningList.length} 项。\n${detailLines.join(
            '\n',
          )}`;
        }
        return `${metrics}\n${mode}`;
      } catch {
        return result.errorMessage || 'Control 结果不可解析。';
      }
    }
    if (stage === 'repair') {
      if (
        result.errorCode === 'repair_output_truncated' ||
        parseStageJson(result.outputJson)?.reason === 'repair_output_truncated'
      ) {
        return 'Repair 输出被模型最大输出限制截断，未形成完整终稿，系统已保留 Writer 初稿。';
      }
      if (
        result.errorCode === 'repair_prompt_budget_exceeded' ||
        parseStageJson(result.outputJson)?.reason === 'repair_prompt_budget_exceeded'
      ) {
        return 'Repair 未发出请求：真实 Repair Prompt 超出冻结上下文窗口，系统已保留 Writer 初稿；当前默认可采纳的是 Writer 初稿。';
      }
      if (rejectedRepair) {
        const code = rejectedRepair.rejectionCode || 'local_final_gate_failed';
        const repairOutput = parseStageJson(rejectedRepair.repairOutputJson);
        const localVerifyOutput = parseStageJson(rejectedRepair.localVerifyOutputJson);
        const diagnostics = repairOutput?.failureDiagnostics ?? {};
        const taskDetails = Array.isArray(diagnostics.unappliedIssueDetails)
          ? diagnostics.unappliedIssueDetails.map((item: any) => {
              const source = item.source || item.kind || 'unknown';
              const excerpt = item.generatedExcerpt
                ? `；摘录：「${String(item.generatedExcerpt).slice(0, 64)}」`
                : '';
              return `${item.id || '—'}（${source}/${item.subtype || 'unknown'}）：${item.description || '未提供描述'}${excerpt}`;
            })
          : [];
        const qualityDetails = [
          ...(Array.isArray(diagnostics.qualityGateFailures)
            ? diagnostics.qualityGateFailures
            : []),
          ...(Array.isArray(diagnostics.complianceFailures)
            ? diagnostics.complianceFailures
            : []),
        ].map(
          (item: any) =>
            `${item.subtype || 'unknown'} [${item.severity || 'error'}]：${item.description || '未提供描述'}`,
        );
        const currentSource =
          diagnostics.currentCandidateSource ||
          localVerifyOutput?.currentCandidateSource ||
          'Writer';
        const status = diagnostics.repairStatus?.rejected
          ? 'returned_rejected'
          : 'rejected';
        return [
          'Repair 已返回候选正文，但未通过完整性、协议或安全检查。当前展示和默认可采纳的是 Writer 初稿。被拒 Repair 仅供审计。',
          `候选来源：${currentSource}；Repair 状态：${status}；拒绝代码：${code}。`,
          taskDetails.length
            ? `未落实任务：${taskDetails.join('；')}`
            : '未落实任务：无结构化记录。',
          qualityDetails.length
            ? `质量/合规门禁：${qualityDetails.join('；')}`
            : '质量/合规门禁：未提供结构化明细。',
        ].join('\n');
      }
      try {
        const parsed = result.outputJson ? JSON.parse(result.outputJson) : null;
        if (!parsed) return 'Repair 已完成精准最小干预修订。';
        if (result.status === 'skipped') {
          return '未发现需要自动修订的五维资料或文风问题，保留 Writer 原稿。';
        }
        const injectedChecker = parsed.injectedCheckerIssueCount ?? null;
        const appliedChecker = parsed.appliedCheckerIssueIds?.length ?? 0;
        const injectedStyle = parsed.injectedControlFindingCount ?? parsed.styleActionableIssueCount ?? null;
        const appliedStyle = parsed.appliedControlFindingIds?.length ?? parsed.appliedStyleFindingCount ?? 0;
        const writerHan = parsed.writerHan ?? null;
        const candidateHan = parsed.candidateHan ?? null;
        const parts: string[] = [
          'Repair 已完成精准修订，并通过完整章节与本地安全检查。',
          '未进行第二次 LLM 语义复核。',
        ];
        parts.push(
          injectedChecker != null
            ? `Checker：注入 ${injectedChecker} 项五维/安全任务，Repair 声明应用 ${appliedChecker} 项。`
            : `Repair 声明应用 Checker issue ${appliedChecker} 项。`,
        );
        parts.push(
          injectedStyle != null
            ? `Control：注入 ${injectedStyle} 项文风任务，Repair 声明应用 ${appliedStyle} 项。`
            : `Repair 声明应用文风 finding ${appliedStyle} 项。`,
        );
        if (writerHan != null && candidateHan != null) {
          const delta = candidateHan - writerHan;
          const sign = delta >= 0 ? '+' : '';
          parts.push(
            `用户参考篇幅 / 实际汉字：参考 ${parsed.referenceTargetHan ?? '—'}，Writer ${writerHan} → Repair ${candidateHan}（${sign}${delta}）；篇幅仅作提示，不影响候选资格。`,
          );
        }
        if (parsed.unaffectedRetentionRatio != null) {
          parts.push(
            `完整性：未涉及段落保留率 ${Math.round(parsed.unaffectedRetentionRatio * 100)}%；相对 Writer 比例 ${
              parsed.candidateToWriterHanRatio != null
                ? `${Math.round(parsed.candidateToWriterHanRatio * 100)}%`
                : '—'
            }。`,
          );
        }
        return parts.join('\n');
      } catch {
        return result.errorMessage || 'Repair 结果不可解析。';
      }
    }
    try {
      const parsed = result.outputJson ? JSON.parse(result.outputJson) : null;
      const checkSubtypes = Array.isArray(parsed?.checkSubtypes)
        ? parsed.checkSubtypes
        : [];
      const lengthWarnings = checkSubtypes.filter((subtype: unknown) =>
        typeof subtype === 'string' &&
        (subtype.startsWith('chapter_length_') ||
          subtype.startsWith('repair_length_')),
      );
      const hardSubtypes = checkSubtypes.filter(
        (subtype: unknown) =>
          typeof subtype !== 'string' ||
          (!subtype.startsWith('chapter_length_') &&
            !subtype.startsWith('repair_length_')),
      );
      if (parsed?.passed === false && hardSubtypes.length > 0) {
        return `完整性与确定性安全检查未通过：${checkSubtypes.join('、') || '存在硬门禁问题'}。当前默认候选为 Writer。`;
      }
      if (lengthWarnings.length > 0) {
        return `已完成完整性与确定性安全检查；${V4_LENGTH_ADVISORY_TEXT}（${lengthWarnings.join('、')}）未影响候选资格；未进行第二次 LLM 语义复核。`;
      }
      return '已完成完整性与确定性安全检查；未进行第二次 LLM 语义复核。';
    } catch {
      return result.errorMessage || 'Local Final Gate 尚无结果。';
    }
  };

  const renderV4StageCards = () => {
    const repairEligible =
      !rejectedRepair &&
      v4Stage('repair')?.status === 'success' &&
      v4Stage('local_verify')?.status === 'success';
    const stageDefinitions: Array<{
      id: ContinuationGenerationStageResult['stage'];
      label: string;
      meta: string;
    }> = [
      { id: 'writer', label: 'Writer', meta: '完整初稿；参考篇幅弱提示；默认文学基线候选' },
      { id: 'checker', label: 'Checker', meta: '原著五维资料一致性审查' },
      { id: 'control', label: 'Control', meta: '原著文风一致性审查' },
      { id: 'repair', label: 'Repair', meta: '精准最小干预修订，输出完整章节' },
      { id: 'local_verify', label: 'Local Final Gate', meta: '完整性与确定性安全检查' },
    ];
    return (
      <>
        <Text style={[styles.summary, { color: colors.textSecondary }]}>
          V4 FULL-Control · 物理请求 {stageResults.reduce((sum, item) => sum + item.requestCount, 0)}/4 · 默认可采纳：{rejectedRepair ? 'Writer' : repairEligible ? 'Repair' : body ? 'Writer' : '—'}
        </Text>
        {stageDefinitions.map(stage => {
          const result = v4Stage(stage.id);
          const requestText = result?.requestCount
            ? ` · ${result.requestCount} 次请求`
            : '';
          const tokenText = result &&
              (result.inputTokens != null || result.outputTokens != null)
            ? ` · token ${result.inputTokens ?? '—'}→${result.outputTokens ?? '—'}`
            : '';
          const durationText = result
            ? ` · ${formatStageDuration(result.startedAt, result.completedAt)}`
            : '';
          const label = `${stage.label} · ${v4StageStatus(stage.id)}${requestText}${tokenText}${durationText}`;
          return (
            <View
              key={stage.id}
              style={[styles.resultCard, { backgroundColor: colors.card }]}
            >
              <Button
                label={label}
                variant="ghost"
                onPress={() => toggleExpanded(`v4_${stage.id}`)}
              />
              <Text style={[styles.stageMeta, { color: colors.accent }]}>
                {stage.meta}
                {result?.errorCode ? ` · ${result.errorCode}` : ''}
              </Text>
              {expanded.has(`v4_${stage.id}`) && (
                <Text selectable style={[styles.stageText, { color: colors.textPrimary }]}>
                  {v4StageText(stage.id)}
                </Text>
              )}
            </View>
          );
        })}
      </>
    );
  };

  const renderV4StateBranch = () => {
    if (run.state === 'failed' || run.state === 'interrupted') {
      return (
        <Card>
          <Text style={[styles.h, { color: run.state === 'failed' ? colors.danger : colors.textPrimary }]}>
            {run.state === 'failed' ? 'V4 生成未完成' : 'V4 生成已中断'}
          </Text>
          <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
            {run.errorMessage || `当前阶段：${stageLabel(run.stage)}。已 reservation 的节点不会自动重发。`}
          </Text>
          <View style={styles.actions}>
            <Button label={busy ? '处理中…' : '按新版 Kernel 重启'} onPress={doResume} disabled={busy} />
            <Button label="放弃" variant="secondary" onPress={doAbandon} disabled={busy} />
          </View>
        </Card>
      );
    }
    if (run.state !== 'awaiting_user') return null;
    const risk = reviewBlocked || Boolean(rejectedRepair);
    const repairEligible =
      !rejectedRepair &&
      v4Stage('repair')?.status === 'success' &&
      v4Stage('local_verify')?.status === 'success';
    return (
      <Card>
        <Text style={[styles.h, { color: risk ? colors.danger : colors.textPrimary }]}>
          {rejectedRepair ? 'Repair 被本地门禁拒绝' : risk ? '默认候选仍有待人工确认问题' : 'V4 终稿已待采纳'}
        </Text>
          <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
            {rejectedRepair
            ? 'Repair 已返回候选正文，但未通过完整性、协议或安全检查。当前展示和默认可采纳的是 Writer 初稿。被拒 Repair 仅供审计。'
            : repairEligible
              ? 'Repair 已完成精准修订，并通过完整章节与本地安全检查。未进行第二次 LLM 语义复核，请在采纳前人工审阅。'
              : '未发现需要自动修订的五维资料或文风问题，或仅有篇幅/audit 提示；当前默认候选为 Writer 原稿。'}
          </Text>
        {rejectedRepair && (
          <View style={[styles.resultCard, { backgroundColor: colors.background }]}>
            <Button
              label={showRejectedRepair ? '收起被拒 Repair 候选' : '查看被拒 Repair 候选'}
              variant="secondary"
              onPress={() => setShowRejectedRepair(value => !value)}
            />
            {showRejectedRepair && (
              <Text selectable style={[styles.stageText, { color: colors.textPrimary }]}>
                {rejectedRepair.content}
              </Text>
            )}
          </View>
        )}
        <View style={styles.actions}>
          <Button
            label={risk ? '采纳当前 eligible 候选（风险自负）' : busy ? '采纳中…' : '采纳'}
            onPress={() => doAdopt({ allowOpenChecks: risk })}
            disabled={busy || !body}
          />
          <Button label="放弃并返回" variant="ghost" onPress={doAbandon} disabled={busy} />
        </View>
      </Card>
    );
  };

  const renderCompletedResult = () => {
    const planText = plan
      ? [
          plan.chapterGoal,
          `冲突：${plan.centralConflict}`,
          plan.beats.length > 0
            ? `节拍：${plan.beats.map(beat => beat.summary).join(' / ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '本次没有可展示的章节计划。';
    const checkText = checks.length
      ? checks
          .map(
            check =>
              `[${check.severity}/${check.category}] ${check.description}`,
          )
          .join('\n')
      : '一致性检查通过，无待处理问题。';
    const resultSections = [
      {
        id: 'plan',
        label: `${run.workflowVersion === 2 ? 'Writer 同次计划' : '规划'} · ${
          plan ? '成功' : '未生成'
        }`,
        text: planText,
        meta: plan
          ? run.workflowVersion === 2
            ? '与正文由同一次 Writer JSON completion 共同生成；没有独立 Planner 或确认步骤'
            : '已根据 Canon 与续写状态生成本章规划'
          : '没有可展示的章节计划',
      },
      {
        id: 'writer',
        label: `正文 · 成功 (${body.length} 字)`,
        text: body,
        meta: '已生成续写正文',
      },
      {
        id: 'checker',
        label: `一致性检查 · 成功 (${checks.length} 项)`,
        text: checkText,
        meta: `blocking ${blocking} · error ${errors} · warning ${warnings}`,
      },
    ];
    if (repairRound > 0) {
      resultSections.splice(2, 0, {
        id: 'repair',
        label: `一致性修复 · 成功 (${repairRound} 轮)`,
        text: '已根据 blocking / error 检查项生成修复版候选正文；已完成本地复核，未进行第二次 LLM 复检；采纳将写入此版本。',
        meta: '只修复冲突片段，已本地复核，未进行第二次 LLM 复检',
      });
    }

    return (
      <>
        <Text style={[styles.summary, { color: colors.textSecondary }]}>
          已完成 · Canon r{run.canonRevision}
          {repairRound > 0 ? ` · 已自动修复 ${repairRound} 轮` : ''}
          {` · 正文 ${body.length} 字`}
        </Text>
        {resultSections.map(section => (
          <View
            key={section.id}
            style={[styles.resultCard, { backgroundColor: colors.card }]}
          >
            <Button
              label={section.label}
              variant="ghost"
              onPress={() => toggleExpanded(section.id)}
            />
            <Text style={[styles.stageMeta, { color: colors.accent }]}>
              {section.meta}
            </Text>
            {expanded.has(section.id) && (
              <Text
                selectable
                style={[styles.stageText, { color: colors.textPrimary }]}
              >
                {section.text}
              </Text>
            )}
          </View>
        ))}
      </>
    );
  };

  const doAdditionalRepair = async () => {
    setBusy(true);
    try {
      await repairContinuationArtifactOnce(runId);
      Toast.show({ type: 'success', text1: '额外修正完成，已进行本地复核' });
      await reload();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '额外修正失败', text2: e?.message });
      await reload();
    } finally {
      setBusy(false);
    }
  };

  // ---- state-driven branches (fix-plan §4.1) ----
  const renderStateBranch = () => {
    if (run.state === 'outdated') {
      return (
        <Card>
          <Text style={[styles.h, { color: colors.danger }]}>
            续写已过期
          </Text>
          <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
            原著源或 Canon 快照已更新，本次生成的上下文不再有效，无法采纳。
            请按最新的原著与 Canon 重新发起续写；旧执行不会被恢复或重复计费。
          </Text>
          <View style={styles.decisionActions}>
            <Button
              label={busy ? '处理中…' : '按最新资料重试'}
              compact
              onPress={doResume}
              disabled={busy}
            />
            <Button
              label="返回"
              variant="secondary"
              compact
              onPress={onClose}
              disabled={busy}
            />
          </View>
        </Card>
      );
    }

    if (run.state === 'failed') {
      // Show only the short service message; never prompt/body/credentials.
      return (
        <Card>
          <Text style={[styles.h, { color: colors.danger }]}>生成失败</Text>
          <Text style={{ color: colors.textSecondary, marginBottom: spacing.sm }}>
            {run.errorMessage || `错误码：${run.errorCode ?? '未知'}`}
          </Text>
          {run.errorCode === 'continuation_capability_blocked' && (
            <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
              Canon 快照不一致或未就绪，请重新分析原著后再发起。
            </Text>
          )}
          {run.errorCode === 'cold_start' ? (
            <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
              应用重启中断了生成；旧执行态不继续复用，将按新版 Kernel 重新开始。
            </Text>
          ) : (
            <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
              请检查模型配置与网络后重新发起。
            </Text>
          )}
          <View style={styles.actions}>
            {run.errorCode === 'cold_start' && (
              <Button
                label={busy ? '处理中…' : '从此阶段继续'}
                onPress={doResume}
                disabled={busy}
              />
            )}
            <Button
              label="放弃"
              variant="secondary"
              onPress={doAbandon}
              disabled={busy}
            />
          </View>
        </Card>
      );
    }

    if (run.state === 'interrupted') {
      return (
        <Card>
          <Text style={[styles.h, { color: colors.textPrimary }]}>
            生成已中断
          </Text>
          <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
            应用上次退出时停留在「{stageLabel(run.stage)}」阶段，可从此处继续，或放弃本次续写。
          </Text>
          <View style={styles.actions}>
            <Button
              label={busy ? '处理中…' : '从此阶段继续'}
              onPress={doResume}
              disabled={busy}
            />
            <Button
              label="放弃"
              variant="secondary"
              onPress={doAbandon}
              disabled={busy}
            />
          </View>
        </Card>
      );
    }

    // awaiting_user with a pending plan needing confirmation (fix-plan §4.1)
    if (
      run.state === 'awaiting_user' &&
      run.stage === 'awaiting_user' &&
      planConfirmationStatus === 'pending' &&
      plan
    ) {
      return (
        <Card>
          <Text style={[styles.h, { color: colors.textPrimary }]}>
            等待确认规划
          </Text>
          <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
            请查看下方规划与风险，确认后将进入正文生成。
          </Text>
          {renderPlan()}
          <View style={styles.actions}>
            <Button
              label={busy ? '处理中…' : '确认并继续生成'}
              onPress={doConfirmPlan}
              disabled={busy}
            />
            <Button
              label="放弃"
              variant="secondary"
              onPress={doAbandon}
              disabled={busy}
            />
          </View>
        </Card>
      );
    }

    // awaiting_user with an adoptable artifact (original path)
    if (run.state === 'awaiting_user') {
      if (reviewBlocked) {
        return (
          <>
            <Card>
              <Text style={[styles.h, { color: colors.danger }]}>本地复核仍有待处理问题</Text>
              <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
                {overlapBlocked
                  ? 'Repair 后本地复核仍发现正文与接缝存在连续重合。你可以承担风险采纳当前候选，或确认再进行一次额外 Repair；额外 Repair 后只做本地复核，不会再次调用 LLM Checker。'
                  : repairCandidateRejected
                  ? 'Repair 返回的终稿篇幅明显坍缩，已保留完整的 Writer 正文；原检查问题仍待处理。你可以承担风险采纳当前候选，或确认再进行一次额外 Repair；额外 Repair 后只做本地复核，不会再次调用 LLM Checker。'
                  : 'Repair 后本地复核仍发现 error / blocking。你可以承担风险采纳当前候选，或确认再进行一次额外 Repair；额外 Repair 后只做本地复核，不会再次调用 LLM Checker。'}
              </Text>
              <View style={styles.actions}>
                <Button
                  label="采纳错误候选（风险自负）"
                  variant="secondary"
                  onPress={() => doAdopt({ allowOpenChecks: true })}
                  disabled={busy}
                />
                {additionalRepairAvailable && (
                  <Button
                    label="额外修正一次（增加 1 次 LLM）"
                    onPress={doAdditionalRepair}
                    disabled={busy}
                  />
                )}
                <Button
                  label="放弃并返回"
                  variant="ghost"
                  onPress={doAbandon}
                  disabled={busy}
                />
              </View>
            </Card>
            {renderChecks()}
          </>
        );
      }
      return (
        <View style={styles.decisionActions}>
        <Button
            label="放弃"
            variant="ghost"
            compact
            onPress={doAbandon}
            disabled={busy}
          />
          <Button
            label={busy ? '采纳中…' : '采纳'}
            compact
            onPress={() => doAdopt()}
            disabled={busy || !body}
          />
        </View>
      );
    }

    return null;
  };

  const renderV5StageCards = () => {
    const observed = kernelTrace?.observability?.llm;
    const physical = observed?.physicalRequestCount ?? stageResults.reduce(
      (sum, item) => sum + item.requestCount,
      0,
    );
    const logical = observed?.logicalStageCallCount ?? physical;
    const formatter = observed?.formatterCallCount ?? 0;
    const fallback = observed?.protocolFallbackCount ?? 0;
    const retry = Number(stageTelemetry.primaryRetryCount ?? 0);
    const totalTokens = observed
      ? observed.inputTokens + observed.outputTokens
      : stageResults.reduce(
          (sum, item) => sum + (item.inputTokens ?? 0) + (item.outputTokens ?? 0),
          0,
        );
    const targetHan = (() => {
      try {
        return JSON.parse(run.settingsSnapshotJson || '{}')?.values
          ?.targetChapterChars;
      } catch {
        return null;
      }
    })();
    return (
      <UnifiedPipelineStageView
        profile={executionProfile}
        compact
        items={buildUnifiedContinuationStageItems({
          run,
          stageResults,
          kernelTrace,
          draftArtifact: v5DraftArtifact,
          revisionArtifact: v5RevisionArtifact,
          finalArtifact: v5FinalArtifact,
        })}
        summary={`阶段视图统一；逻辑 ${logical} · Formatter ${formatter} · 物理 ${physical} · Fallback ${fallback} · Retry ${retry} · ${totalTokens} tokens${
          targetHan != null ? ` · 目标 ${targetHan} 字` : ''
        }`}
      />
    );
    /*
    const usage = (() => {
      try {
        return JSON.parse(run.tokenUsageJson || '{}');
      } catch {
        return {};
      }
    })() as Record<string, any>;
    const physical = stageResults
      .filter(item => item.stage !== 'final_validate')
      .reduce((sum, item) => sum + item.requestCount, 0);
    const targetHan =
      usage.targetHan ??
      (() => {
        try {
          return JSON.parse(run.settingsSnapshotJson || '{}')?.values
            ?.targetChapterChars;
        } catch {
          return null;
        }
      })();

    const v5Stage = (id: ContinuationGenerationStageResult['stage']) =>
      stageResults.find(item => item.stage === id) ?? null;

    if (executionProfile === 'one_shot') {
      const draftResult = v5Stage('draft_writer');
      const qaResult = v5Stage('unified_qa');
      const revisionResult = v5Stage('revision_writer');
      const finalValidateResult = v5Stage('final_validate');
      const draftContent = v5DraftArtifact?.content ?? '';
      const draftTokens =
        draftResult?.outputTokens ??
        parseStageJson(draftResult?.outputJson)?.length?.completionTokens ??
        null;
      const draftHan =
        draftContent.length > 0
          ? countHanCharacters(draftContent)
          : parseStageJson(draftResult?.outputJson)?.length?.actualHan ?? null;
      const skipReason = (result: ContinuationGenerationStageResult | null) =>
        parseStageJson(result?.outputJson)?.envelope?.skipReason || '正式跳过';
      const oneShotRows = [
        {
          key: 'draft',
          label: `Draft · 生成 Tokens ${draftTokens ?? '—'} · 汉字 ${
            draftHan ?? '—'
          }`,
          detail: draftResult?.status === 'success' ? '逻辑调用 1 次' : '未完成',
        },
        {
          key: 'qa',
          label: 'QA · 0 次付费调用',
          detail: `${qaResult?.status === 'skipped' ? skipReason(qaResult) : '正式状态缺失'}`,
        },
        {
          key: 'revision',
          label: 'Revision · 0 次付费调用',
          detail: `${
            revisionResult?.status === 'skipped'
              ? skipReason(revisionResult)
              : '正式状态缺失'
          }`,
        },
        {
          key: 'final-validate',
          label: `FinalValidate · ${
            finalValidateResult?.status === 'success' ? '已完成' : '未完成'
          }`,
          detail: 'Local Gate',
        },
        {
          key: 'persist',
          label: `Persist · ${run.state === 'completed' ? '已完成' : '等待采纳'}`,
          detail: '统一 Kernel',
        },
      ];
      return (
        <>
          <Text style={[styles.summary, { color: colors.textSecondary }]}>
            One-Shot · 单稿
            {physical > 0 ? ` · 请求 ${physical}/1` : ''}
            {targetHan != null ? ` · 目标 ${targetHan} 字` : ''}
          </Text>
          {oneShotRows.map(row => (
            <View
              key={row.key}
              style={[styles.resultCard, { backgroundColor: colors.card }]}
            >
              <Text style={[styles.stageMeta, { color: colors.textPrimary }]}>
                {row.label}
              </Text>
              <Text
                style={[
                  styles.stageMeta,
                  { color: colors.textMuted, marginTop: spacing.xs },
                ]}
              >
                {row.detail}
              </Text>
            </View>
          ))}
        </>
      );
    }

    const rows: Array<{
      key: 'v1' | 'v2' | 'v3';
      title: string;
      stageId: ContinuationGenerationStageResult['stage'];
      artifact: ContinuationArtifact | null;
      adoptable: boolean;
    }> = [
      {
        key: 'v1',
        title: 'V1',
        stageId: 'draft_writer',
        artifact: v5DraftArtifact,
        adoptable: false,
      },
      {
        key: 'v2',
        title: 'V2',
        stageId: 'revision_writer',
        artifact: v5RevisionArtifact,
        adoptable: false,
      },
      {
        key: 'v3',
        title: 'V3',
        stageId: 'final_reviser',
        artifact: v5FinalArtifact,
        adoptable: true,
      },
    ];

    return (
      <>
        <Text style={[styles.summary, { color: colors.textSecondary }]}>
          V5 · 三稿
          {physical > 0 ? ` · 请求 ${physical}/5` : ''}
          {targetHan != null ? ` · 目标 ${targetHan} 字` : ''}
        </Text>
        {v3ChangeRatio && (() => {
          const percent = (v3ChangeRatio.ratio * 100).toFixed(1);
          const hint = v3ChangeRatio.sameHash
            ? 'V3 与 V2 正文一致，未做润色'
            : '基于汉字序列 LCS，反映定点润色幅度';
          return (
            <Text
              style={[
                styles.summary,
                { color: colors.textMuted, fontWeight: '400' },
              ]}
            >
              V3 改动占比：约 {percent}%（{hint}）
            </Text>
          );
        })()}
        {rows.map(row => {
          const result = v5Stage(row.stageId);
          const content = row.artifact?.content ?? '';
          const han =
            content.length > 0
              ? countHanCharacters(content)
              : (() => {
                  // Prefer length telemetry when artifact body is not available.
                  const fromJson = parseStageJson(result?.outputJson);
                  const actual = fromJson?.length?.actualHan;
                  return typeof actual === 'number' ? actual : null;
                })();
          const tokens =
            result?.outputTokens != null
              ? result.outputTokens
              : (() => {
                  const fromJson = parseStageJson(result?.outputJson);
                  const t = fromJson?.length?.completionTokens;
                  return typeof t === 'number' ? t : null;
                })();
          const label = `${row.title} · 生成 Tokens ${
            tokens != null ? tokens : '—'
          } · 汉字 ${han != null ? han : '—'}`;
          return (
            <View
              key={row.key}
              style={[styles.resultCard, { backgroundColor: colors.card }]}
            >
              <Text
                style={[styles.stageMeta, { color: colors.textPrimary }]}
              >
                {label}
              </Text>
              {!row.adoptable && (
                <Text
                  style={[
                    styles.stageMeta,
                    { color: colors.textMuted, marginTop: spacing.xs },
                  ]}
                >
                  过程稿 · 不可采纳
                </Text>
              )}
              {row.adoptable && row.artifact?.eligibilityStatus === 'eligible' && (
                <Text
                  style={[
                    styles.stageMeta,
                    { color: colors.accent, marginTop: spacing.xs },
                  ]}
                >
                  可交付终稿
                </Text>
              )}
            </View>
          );
        })}
      </>
    );
    */
  };

  const renderV5StateBranch = () => {
    if (run.state === 'running' || run.state === 'queued') {
      return (
        <Card>
          <Text style={[styles.h, { color: colors.textPrimary }]}>
            生成进行中
          </Text>
          <Text style={{ color: colors.textSecondary }}>
            当前：{continuationRunStageLabel(run)}。
            {executionProfile === 'one_shot'
              ? '完成后将在同一阶段视图中标记 QA/Revision 的正式跳过。'
              : '完成后将在同一阶段视图中展示生成、检查、修订与校验结果。'}
          </Text>
        </Card>
      );
    }
    if (run.state === 'outdated') {
      return (
        <Card>
          <Text style={[styles.h, { color: colors.danger }]}>续写已过期</Text>
          <Text
            style={{ color: colors.textSecondary, marginBottom: spacing.md }}
          >
            原著源或 Canon 快照已更新，本次生成的上下文不再有效，无法采纳。
            请按最新的原著与 Canon 重新发起续写；旧执行不会被恢复或重复计费。
          </Text>
          <View style={styles.decisionActions}>
            <Button
              label={busy ? '处理中…' : '按最新资料重试'}
              compact
              onPress={doResume}
              disabled={busy}
            />
            <Button
              label="返回"
              variant="secondary"
              compact
              onPress={onClose}
              disabled={busy}
            />
          </View>
        </Card>
      );
    }
    if (run.state === 'failed' || run.state === 'interrupted') {
      return (
        <Card>
          <Text
            style={[
              styles.h,
              {
                color:
                  run.state === 'failed' ? colors.danger : colors.textPrimary,
              },
            ]}
          >
            {run.state === 'failed' ? '生成未完成' : '生成已中断'}
          </Text>
          <Text
            style={{ color: colors.textSecondary, marginBottom: spacing.md }}
          >
            {run.errorMessage ||
              `当前阶段：${continuationRunStageLabel(run)}。可从已保存进度继续，或放弃。`}
          </Text>
          <View style={styles.actions}>
            <Button
              label={busy ? '处理中…' : '从已保存进度继续'}
              onPress={doResume}
              disabled={busy}
            />
            <Button
              label="放弃"
              variant="secondary"
              onPress={doAbandon}
              disabled={busy}
            />
          </View>
        </Card>
      );
    }
    if (run.state === 'awaiting_regeneration') {
      return (
        <Card>
          <Text style={[styles.h, { color: colors.danger }]}>
            未形成可交付终稿
          </Text>
          <Text
            style={{ color: colors.textSecondary, marginBottom: spacing.md }}
          >
            {run.errorMessage ||
              '请重新生成，或放弃本次结果。上方可展开已有过程稿对照。'}
          </Text>
          <View style={styles.actions}>
            <Button
              label="重新生成"
              onPress={onClose}
              disabled={busy}
            />
            <Button
              label="放弃"
              variant="secondary"
              onPress={doAbandon}
              disabled={busy}
            />
          </View>
        </Card>
      );
    }
    if (run.state === 'awaiting_user') {
      return (
        <View style={styles.decisionActions}>
          <Button
            label="放弃"
            variant="ghost"
            onPress={doAbandon}
            disabled={busy}
          />
          <Button
            label={busy ? '采纳中…' : '采纳'}
            onPress={() => doAdopt()}
            disabled={busy || !body}
          />
        </View>
      );
    }
    return null;
  };

  return (
    <Screen>
      <Header title="流水线结果" action={headerAction} />
      <ScrollView contentContainerStyle={styles.pad}>
        {run.workflowVersion === 5 ? (
          <>
            {run.state !== 'running' && finalArtifact ? (
              <View style={styles.finalArtifactWrap}>
                <FinalManuscriptCard artifact={finalArtifact} />
              </View>
            ) : null}
            {renderV5StateBranch()}
            {renderV5StageCards()}
          </>
        ) : run.workflowVersion === 4 ? (
          <>
            {renderV4StateBranch()}
            {renderV4StageCards()}
          </>
        ) : (
          <>
            {run.state === 'awaiting_user' &&
            planConfirmationStatus !== 'pending' &&
            !reviewBlocked
              ? renderCompletedResult()
              : null}
            {/* Non-final branches keep their workflow-specific guidance. */}
            {run.state !== 'awaiting_user' &&
              run.state !== 'outdated' &&
              run.state !== 'failed' &&
              !(run.state === 'interrupted' && !body) &&
              renderPlan()}
            {run.state !== 'awaiting_user' &&
              run.state !== 'outdated' &&
              run.state !== 'failed' &&
              !(run.state === 'interrupted' && !body) &&
              body.length > 0 &&
              renderChecks()}
            {run.state !== 'awaiting_user' &&
              run.state !== 'outdated' &&
              run.state !== 'failed' &&
              !(run.state === 'interrupted' && !body) &&
              renderBodyPreview()}
            {renderStateBranch()}
          </>
        )}
      </ScrollView>
    </Screen>
  );
};

function continuationRunStageLabel(run: Pick<ContinuationGenerationRun, 'workflowVersion' | 'stage'>): string {
  if (run.workflowVersion === 5) {
    switch (run.stage) {
      case 'round1':
      case 'writer':
      case 'draft_writer':
        return '生成';
      case 'round2':
        return '检查';
      case 'revision_writer':
      case 'round3':
      case 'round4':
        return '修订';
      case 'final_validate':
        return '校验';
      case 'awaiting_user':
        return '保存 / 等待采纳';
      default:
        return '共享 Writing Kernel';
    }
  }
  return stageLabel(run.stage);
}

function stageLabel(stage: string): string {
  switch (stage) {
    case 'context':
      return '上下文构建';
    case 'planner':
      return '规划';
    case 'writer':
      return '正文生成';
    case 'auditing':
      return 'Checker/Control 并行审查';
    case 'checker':
      return '一致性检查';
    case 'control':
      return '篇幅与结构控制';
    case 'repair':
      return '修复';
    case 'local_verify':
      return '本地 Final Gate';
    case 'awaiting_user':
      return '等待确认';
    case 'round1':
      return 'V1 初稿与 A1 架构';
    case 'round2':
      return 'V2 修订与 C2 审阅';
    case 'round3':
      return 'V3 终稿润色';
    case 'draft_writer':
      return '生成初稿 V1';
    case 'narrative_architect':
      return '规划叙事架构 A1';
    case 'revision_writer':
      return '扩写修订 V2';
    case 'adversarial_auditor':
      return '审阅 V2 并生成润色任务';
    case 'final_reviser':
      return '润色终稿 V3';
    case 'final_validate':
      return '校验终稿';
    default:
      return stage;
  }
}

function formatStageDuration(
  startedAt: string | null,
  completedAt: string | null,
): string {
  if (!startedAt) return '耗时—';
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return '耗时—';
  }
  return `耗时 ${Math.max(0, end - start)}ms`;
}

const styles = StyleSheet.create({
  pad: { padding: spacing.md, paddingBottom: 48 },
  finalArtifactWrap: { marginTop: spacing.sm, marginBottom: spacing.sm },
  summary: { fontSize: 13, fontWeight: '700', marginBottom: spacing.md },
  resultCard: { borderRadius: 8, padding: spacing.md, gap: spacing.sm, marginBottom: spacing.md },
  stageMeta: { fontSize: 12, fontWeight: '700' },
  stageText: { fontSize: 14, lineHeight: 22, marginTop: spacing.sm },
  block: { marginBottom: 16 },
  h: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  actions: { gap: 12, marginTop: 8 },
  // Keep the final decision in the same left-to-right order and visual weight
  // as the outline pipeline result screen: discard first, adopt second.
  decisionActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
});

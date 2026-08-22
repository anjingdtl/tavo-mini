/**
 * Multi-chapter batch screen (Phase 8) — outline mode only.
 *
 * One screen with internal views:
 *   1. create   — summary, N and target words
 *   2. preview  — editable plan (title/synopsis/beats/carryIn/carryOut/words)
 *   3. running  — serial progress, attempts, retry time, budget usage
 *   4. paused   — cause-specific actions
 *   5. report   — completion summary + token/call usage
 *
 * The batch state lives in SQLite; this screen mirrors it via the store.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Play, Pause, X, RefreshCw, ListChecks } from 'lucide-react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { EditorStackParamList } from '../navigation/TabNavigator';
import { Button, Card, Header, Screen, Section, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { useProjectStore } from '../store/projectStore';
import { useMultiChapterBatchStore } from '../store/multiChapterBatchStore';
import {
  BATCH_DEFAULT_CHAPTERS,
  BATCH_DEFAULT_TARGET_WORDS,
  BATCH_MAX_CHAPTERS,
  BATCH_MIN_CHAPTERS,
} from '../types/multiChapterBatch';
import type {
  BatchChapterPlanItem,
  MultiChapterWritingMode,
} from '../types/multiChapterBatch';
import type { PipelineReasoningEffort } from '../types/pipeline';
import { PIPELINE_REASONING_EFFORT_OPTIONS } from '../services/pipeline/reasoningPolicy';
import {
  getPipelineStageOrder,
  STAGE_LABELS,
} from '../utils/stages';
import { CURRENT_OUTLINE_WORKFLOW_VERSION } from '../services/pipeline/outlineWorkflowVersion';
import {
  getContinuationChapterNumbering,
  makeContinuationChapterNumbering,
} from '../services/continuation/chapterNumbering/continuationChapterNumbering';
import * as db from '../services/database';

type BatchView = 'create' | 'preview' | 'running' | 'paused' | 'report';

export function resolveMultiChapterRouteMode(
  routeMode: MultiChapterWritingMode | undefined,
  projectMode: string | null | undefined,
): MultiChapterWritingMode {
  return (
    routeMode || (projectMode === 'continuation' ? 'continuation' : 'outline')
  );
}

type PersistedBatchItemForHydration = {
  ordinal: number;
  title: string;
  synopsis: string;
  keyBeatsJson: string;
  carryIn: string | null;
  carryOut: string | null;
  targetWords: number;
};

function isCompleteBatchPlan(items: readonly BatchChapterPlanItem[]): boolean {
  return (
    items.length > 0 &&
    items.every(
      item =>
        Number.isFinite(item.ordinal) &&
        item.title.trim().length > 0 &&
        item.synopsis.trim().length > 0 &&
        item.keyBeats.length > 0 &&
        item.keyBeats.every(beat => beat.trim().length > 0) &&
        Number.isFinite(item.targetWords) &&
        item.targetWords > 0,
    )
  );
}

/**
 * Restore the editable preview from durable data without promoting placeholder
 * rows to a valid plan. During a cold re-entry the batch row and item rows can
 * arrive in separate reads; plannerOutputJson is authoritative while items
 * still contain empty placeholders.
 */
export function hydratePersistedBatchPlan(
  plannerOutputJson: string | null | undefined,
  items: readonly PersistedBatchItemForHydration[],
): BatchChapterPlanItem[] {
  if (plannerOutputJson) {
    try {
      const parsed: unknown = JSON.parse(plannerOutputJson);
      const chapters =
        parsed && typeof parsed === 'object' && 'chapters' in parsed
          ? (parsed as { chapters?: unknown }).chapters
          : null;
      if (Array.isArray(chapters)) {
        const fromPlanner = chapters.map((chapter: unknown) => {
          const c =
            chapter && typeof chapter === 'object'
              ? (chapter as Record<string, unknown>)
              : {};
          return {
            ordinal: Number(c.ordinal),
            title: String(c.title ?? ''),
            synopsis: String(c.synopsis ?? ''),
            keyBeats: Array.isArray(c.keyBeats)
              ? c.keyBeats.map(String).map(value => value.trim()).filter(Boolean)
              : [],
            carryIn: String(c.carryIn ?? ''),
            carryOut: String(c.carryOut ?? ''),
            targetWords: Number(c.targetWords) || BATCH_DEFAULT_TARGET_WORDS,
          } satisfies BatchChapterPlanItem;
        });
        if (isCompleteBatchPlan(fromPlanner)) return fromPlanner;
      }
    } catch {
      // Fall through to a complete item-row snapshot, if one exists.
    }
  }

  const fromItems = items.map(item => {
    let keyBeats: string[] = [];
    try {
      const parsed: unknown = JSON.parse(item.keyBeatsJson || '[]');
      keyBeats = Array.isArray(parsed)
        ? parsed.map(String).map(value => value.trim()).filter(Boolean)
        : [];
    } catch {
      keyBeats = [];
    }
    return {
      ordinal: item.ordinal,
      title: item.title,
      synopsis: item.synopsis,
      keyBeats,
      carryIn: item.carryIn || '',
      carryOut: item.carryOut || '',
      targetWords: item.targetWords,
    } satisfies BatchChapterPlanItem;
  });

  return isCompleteBatchPlan(fromItems) ? fromItems : [];
}

/**
 * The batch progress view uses the same user-facing stage vocabulary as the
 * unified result view. Legacy round names remain accepted as compatibility
 * inputs, but they must never leak into the production UI.
 */
const CONTINUATION_STAGE_LABELS: Record<string, string> = {
  round1: 'Draft',
  round2: 'ONE QA / Conditional Revision',
  round3: 'FinalValidate',
  draft_writer: 'Draft',
  unified_qa: 'ONE QA',
  narrative_architect: 'ONE QA',
  revision_writer: 'Conditional Revision',
  adversarial_auditor: 'ONE QA',
  final_reviser: 'Conditional Revision',
  final_validate: 'FinalValidate',
  adoption: 'Persist',
  finalize: 'Persist',
  state_sync: 'PostWriting / ONE Memory',
};

const CONTINUATION_STAGE_ORDER = [
  'draft_writer',
  'unified_qa',
  'revision_writer',
  'final_validate',
  'adoption',
  'finalize',
  'state_sync',
];

const CONTINUATION_PAUSE_REASONS: Record<string, string> = {
  BATCH_CONTINUATION_SOURCE_CHANGED: '原著源已变化',
  BATCH_CONTINUATION_BOUNDARY_CHANGED: '续写起点（边界）已变化',
  BATCH_CONTINUATION_CANON_CHANGED: 'Canon 已变化',
  BATCH_CONTINUATION_FINAL_REJECTED: '最终稿未通过校验',
  BATCH_CONTINUATION_FINAL_NEEDS_REVIEW: '最终稿需人工确认',
  BATCH_CONTINUATION_RUN_FAILED: '续写运行失败',
  BATCH_CONTINUATION_RUN_OUTDATED: '续写结果已过期',
  BATCH_CONTINUATION_ADOPTION_FAILED: '采用失败',
  BATCH_CONTINUATION_FINALIZE_FAILED: '定稿失败',
  BATCH_CONTINUATION_STATE_SYNC_FAILED: '状态同步失败',
  BATCH_CONTINUATION_STATE_CONFLICT: '状态冲突待确认',
  BATCH_CONTINUATION_STATE_SYNC_TIMEOUT: '状态同步超时',
  BATCH_CONTINUATION_CHAPTER_CONFLICT: '章节被手动修改',
};

export function MultiChapterBatchScreen(): React.ReactElement {
  const navigation =
    useNavigation<NativeStackNavigationProp<EditorStackParamList>>();
  const route = useRoute<RouteProp<EditorStackParamList, 'MultiChapterBatch'>>();
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const store = useMultiChapterBatchStore();
  const [view, setView] = useState<BatchView>('create');
  const [resumeSubmitting, setResumeSubmitting] = useState(false);
  // React state updates are batched. Keep an imperative guard as well so two
  // rapid taps cannot both enter the confirmation/resume path before the
  // disabled button has re-rendered.
  const resumeGuardRef = useRef(false);
  const [form, setForm] = useState({
    sourcePrompt: '',
    chapterCount: String(BATCH_DEFAULT_CHAPTERS),
    targetWords: String(BATCH_DEFAULT_TARGET_WORDS),
  });
  const [edited, setEdited] = useState<BatchChapterPlanItem[]>([]);
  const hydratedPlanRef = useRef(false);
  /** Continuation anchor summary for the create/preview views. */
  const [continuationAnchorInfo, setContinuationAnchorInfo] = useState<{
    boundaryChapterNumber: number | null;
    /** 0-based internal position the first batch chapter will occupy. */
    nextPosition: number;
    getDisplayNumber: (position: number) => number;
  } | null>(null);

  // Route mode decides the CREATION mode only (doc §29); once an active batch
  // exists its persisted writingMode is authoritative. When a nested editor
  // route survives a project switch, there may be no fresh route params, so
  // the current project's mode is the safe fallback instead of defaulting to
  // outline.
  const routeMode = resolveMultiChapterRouteMode(
    route.params?.writingMode,
    currentProject?.mode,
  );
  const batchForCurrentProject =
    currentProject && store.batch?.projectId === currentProject.id
      ? store.batch
      : null;
  const mode: MultiChapterWritingMode =
    batchForCurrentProject?.writingMode ?? routeMode;
  const isContinuation = mode === 'continuation';

  const refresh = useCallback(() => {
    if (store.batch) {
      store.refresh().catch(() => {});
    }
  }, [store]);

  const loadAnchorInfo = useCallback(async () => {
    if (!currentProject) return;
    try {
      const numbering = await getContinuationChapterNumbering(currentProject.id);
      const chapters = await db.getChaptersByProject(currentProject.id);
      const nextPosition =
        chapters.length > 0
          ? Math.max(...chapters.map((c: any) => Number(c.position))) + 1
          : 0;
      setContinuationAnchorInfo({
        boundaryChapterNumber: numbering.boundaryChapterNumber,
        nextPosition,
        getDisplayNumber: (position: number) =>
          numbering.getDisplayNumber(position as any),
      });
    } catch {
      const fallback = makeContinuationChapterNumbering(null);
      setContinuationAnchorInfo({
        boundaryChapterNumber: null,
        nextPosition: 0,
        getDisplayNumber: position => fallback.getDisplayNumber(position as any),
      });
    }
  }, [currentProject]);

  useEffect(() => {
    if (isContinuation && (view === 'create' || view === 'preview')) {
      loadAnchorInfo().catch(() => {});
    }
  }, [isContinuation, view, loadAnchorInfo]);

  // 进入页面时自动加载当前项目的活跃批次：规划后的计划持久化在 SQLite，
  // 退出/杀进程后重新进入必须回到规划预览（而不是创建页）。
  useEffect(() => {
    if (currentProject) {
      store.loadActiveBatchForProject(currentProject.id).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id]);

  // A nested stack route can stay mounted while the user changes project or
  // switches between outline/continuation workspaces. Local form/plan state
  // must not leak across that boundary; durable batch state is re-hydrated by
  // the active-batch load above.
  useEffect(() => {
    setForm({
      sourcePrompt: '',
      chapterCount: String(BATCH_DEFAULT_CHAPTERS),
      targetWords: String(BATCH_DEFAULT_TARGET_WORDS),
    });
    setEdited([]);
    hydratedPlanRef.current = false;
    setContinuationAnchorInfo(null);
    setView('create');
  }, [currentProject?.id, routeMode]);

  // 运行页轮询（运行中每 2s 刷新一次状态）。
  useEffect(() => {
    if (!store.batch || view !== 'running') return;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [store.batch, view, refresh]);

  const batchStatus = batchForCurrentProject?.status;
  useEffect(() => {
    // After the user confirms a resume, keep the progress view visible while
    // the store re-arms the checkpoint and starts its background drive. The
    // in-memory row may still say paused until refreshBatch completes.
    if (resumeSubmitting) return;
    if (!batchStatus) {
      setView('create');
    } else if (batchStatus === 'completed' || batchStatus === 'cancelled') {
      setView('report');
    } else if (batchStatus.startsWith('paused_')) {
      setView('paused');
    } else if (
      batchStatus === 'planning' ||
      batchStatus === 'draft' ||
      batchStatus === 'ready'
    ) {
      // 批次状态在第一章采用前一直是 ready。此时若协调器正在驱动
      // （reconciling）或 item 已有执行痕迹（章节已建/等待重试），说明
      // 批次已启动——必须显示运行页（包括运行中切走再切回的重新挂载），
      // 不能掉回预览/创建页误导用户重新开始。
      const hasExecutionTraces = store.items.some(
        i =>
          i.status !== 'pending' ||
          i.chapterId != null ||
          i.activePipelineTaskId != null,
      );
      if (store.reconciling || hasExecutionTraces) {
        setView('running');
      } else {
        setView('preview');
      }
    } else {
      setView('running');
    }
  }, [
    batchStatus,
    store.reconciling,
    store.items,
    resumeSubmitting,
    currentProject?.id,
    routeMode,
  ]);

  // 冷启动恢复：编辑计划从持久化数据重建（本地 edited state 是易失的，
  // 新进程后为空）。等待一份完整的 durable plan，避免 batch 行和 item 行
  // 分开加载时把空占位行锁进 edited state。
  useEffect(() => {
    if (
      view !== 'preview' ||
      hydratedPlanRef.current ||
      store.items.length === 0
    ) {
      return;
    }
    const hydrated = hydratePersistedBatchPlan(
      store.batch?.plannerOutputJson,
      store.items,
    );
    if (hydrated.length === 0) return;
    hydratedPlanRef.current = true;
    setEdited(hydrated);
  }, [view, store.items, store.batch?.plannerOutputJson]);

  const handleCreate = async () => {
    const count = Number(form.chapterCount);
    if (count < BATCH_MIN_CHAPTERS || count > BATCH_MAX_CHAPTERS) {
      Alert.alert('章节数不合法', `请在 ${BATCH_MIN_CHAPTERS}～${BATCH_MAX_CHAPTERS} 之间选择`);
      return;
    }
    if (!form.sourcePrompt.trim()) {
      Alert.alert(isContinuation ? '本批续写目标不能为空' : '剧情摘要不能为空');
      return;
    }
    if (!currentProject) return;
    try {
      const id = await store.createDraftBatch({
        projectId: currentProject.id,
        sourcePrompt: form.sourcePrompt.trim(),
        chapterCount: count,
        targetWordsPerChapter: Number(form.targetWords) || BATCH_DEFAULT_TARGET_WORDS,
        pipelineMode: 'full',
        writingMode: routeMode,
        projectMode: currentProject.mode,
      });
      const plan = await store.runPlanner(id);
      hydratedPlanRef.current = true;
      setEdited(plan.chapters.map(c => ({ ...c })));
      setView('preview');
    } catch (error: any) {
      Alert.alert('规划失败', String(error?.message || '请检查模型配置后重试'));
    }
  };

  const handleStart = async () => {
    if (!batchForCurrentProject) return;
    const valid = edited.length > 0;
    if (!valid) {
      Alert.alert('请先完成计划');
      return;
    }
    try {
      await store.saveEditedPlan(batchForCurrentProject.id, edited);
      // 立即切到运行页：store.start 非阻塞驱动 reconcile，页面通过轮询
      // 刷新进度（此前 await 整批完成后才切页，用户以为按钮没响应）。
      setView('running');
      await store.start(batchForCurrentProject.id);
    } catch (error: any) {
      Alert.alert('启动失败', String(error?.message || '请检查计划后重试'));
    }
  };

  const handleResume = async () => {
    if (!batchForCurrentProject || resumeGuardRef.current) return;
    if (
      Number(batchForCurrentProject.outlineWorkflowVersion) !==
      CURRENT_OUTLINE_WORKFLOW_VERSION
    ) {
      Alert.alert(
        '旧版批次已停止恢复',
        '已完成章节保留。请按新版重新规划剩余章节。',
      );
      return;
    }
    resumeGuardRef.current = true;
    setResumeSubmitting(true);
    const proceed = await new Promise<boolean>(resolve => {
      let decisionMade = false;
      const decide = (value: boolean) => {
        if (decisionMade) return;
        decisionMade = true;
        resolve(value);
      };
      Alert.alert(
        '确认后继续批次',
        '当前章节会按 checkpoint 精确恢复：已成功的阶段直接复用，失败或尚未成功的阶段可能重新调用模型并产生 API 费用；结果未知时可能产生重复费用。是否继续？',
        [
          { text: '取消', style: 'cancel', onPress: () => decide(false) },
          { text: '确认继续', onPress: () => decide(true) },
        ],
        { onDismiss: () => decide(false) },
      );
    });
    if (!proceed) {
      resumeGuardRef.current = false;
      setResumeSubmitting(false);
      return;
    }
    // Return immediately to the one-tap N-chapter progress page. Resume and
    // reconciliation are intentionally asynchronous and may take minutes.
    setView('running');
    try {
      await store.resume(batchForCurrentProject.id);
      resumeGuardRef.current = false;
      setResumeSubmitting(false);
    } catch (error: any) {
      resumeGuardRef.current = false;
      setResumeSubmitting(false);
      Alert.alert('恢复失败', String(error?.message || '请稍后重试'));
    }
  };

  const handlePause = async () => {
    if (!batchForCurrentProject) return;
    try {
      await store.pause(batchForCurrentProject.id);
    } catch {
      // store surfaces errors via state
    }
  };

  const handleRestartLegacyBatch = async () => {
    if (!batchForCurrentProject) return;
    try {
      await store.restartLegacyBatch(batchForCurrentProject.id);
      setEdited(useMultiChapterBatchStore.getState().plan?.chapters.map(c => ({ ...c })) || []);
      setView('preview');
      Alert.alert('新版批次已创建', '已保留旧批次历史，并把未完成章节转入新版批次。请确认计划后开始写作。');
    } catch (error: any) {
      Alert.alert('无法创建新版批次', String(error?.message || '请稍后重试'));
    }
  };

  const handleCancel = () => {
    if (!batchForCurrentProject) return;
    const batchId = batchForCurrentProject.id;
    Alert.alert('结束批次', '已完成章节会保留，未完成章节将被放弃。确定结束？', [
      { text: '取消', style: 'cancel' },
      {
        text: '结束批次',
        style: 'destructive',
        onPress: () => store.cancel(batchId).catch(() => {}),
      },
    ]);
  };

  const headerTitle =
    view === 'create'
      ? isContinuation
        ? '一键续写 N 章'
        : '一键写 N 章'
      : view === 'preview'
          ? isContinuation
            ? '续写计划预览'
            : '规划预览'
          : view === 'report'
            ? '批次报告'
            : batchForCurrentProject
              ? `第 ${batchForCurrentProject.currentOrdinal}/${batchForCurrentProject.chapterCount} 章`
              : isContinuation
                ? '一键续写 N 章'
                : '一键写 N 章';

  return (
    <Screen>
      <Header
        title={headerTitle}
        action={
          <Button
            label="返回"
            variant="ghost"
            compact
            onPress={() => {
              // 返回按钮始终离开批次页回到章节列表。批次状态已持久化，
              // 运行中/暂停中离开不会中断后台任务；创建/预览页也不能
              // 通过 setView('create') 留在当前路由，否则按钮看起来无效。
              navigation.goBack();
            }}
          />
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        {view === 'create' && (
          <>
            {isContinuation ? (
              <Card style={styles.cardMb}>
                <Text style={[styles.bold, { color: theme.colors.textPrimary }]}>
                  当前承接
                </Text>
                <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
                  {continuationAnchorInfo?.boundaryChapterNumber != null
                    ? `原著第 ${continuationAnchorInfo.boundaryChapterNumber} 章`
                    : '原著边界未就绪'}
                </Text>
                <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
                  本批将从第 {continuationAnchorInfo?.getDisplayNumber(continuationAnchorInfo.nextPosition) ?? '—'} 章开始续写
                </Text>
              </Card>
            ) : null}
            <Section title={isContinuation ? '本批续写目标' : '剧情摘要'}>
              <TextInput
                style={[styles.inputMultiline, { backgroundColor: theme.colors.card, color: theme.colors.textPrimary }]}
                placeholder={
                  isContinuation
                    ? '输入本批续写的总体目标、剧情走向或阶段任务…'
                    : '输入较长的局部剧情摘要、阶段目标或故事弧提示词…'
                }
                placeholderTextColor={theme.colors.textMuted}
                multiline
                value={form.sourcePrompt}
                onChangeText={t => setForm(f => ({ ...f, sourcePrompt: t }))}
              />
            </Section>
            <Section title="生成参数">
              <Field label="生成章数 (1~10)">
                <TextInput
                  style={[styles.input, { backgroundColor: theme.colors.card, color: theme.colors.textPrimary }]}
                  keyboardType="numeric"
                  value={form.chapterCount}
                  onChangeText={t => setForm(f => ({ ...f, chapterCount: t }))}
                />
              </Field>
              <Field label="每章目标字数">
                <TextInput
                  style={[styles.input, { backgroundColor: theme.colors.card, color: theme.colors.textPrimary }]}
                  keyboardType="numeric"
                  value={form.targetWords}
                  onChangeText={t => setForm(f => ({ ...f, targetWords: t }))}
                />
              </Field>
            </Section>
            <View style={styles.row}>
              <Button
                label={store.loading ? '正在规划…' : isContinuation ? '生成续写计划' : '开始规划'}
                icon={ListChecks}
                onPress={handleCreate}
                disabled={store.loading}
              />
            </View>
          </>
        )}

        {view === 'preview' && (
          <>
            {store.batch?.reasoningEffort ? (
              <Card style={styles.cardMb}>
                <Text style={[styles.bold, { color: theme.colors.textPrimary }]}>思考强度</Text>
                <Text style={[styles.mt4, { color: theme.colors.accent }]}>批次已冻结：{reasoningEffortLabel(store.batch.reasoningEffort, store.batch.executionProfile)}</Text>
                <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>后续章节任务会继承该档位；修改流水线配置不会影响本批次。</Text>
              </Card>
            ) : null}
            <Section title={isContinuation ? '续写计划预览（可编辑）' : '计划预览（可编辑）'}>
              {edited.length === 0 && store.plan ? (
                <Text style={{ color: theme.colors.textSecondary }}>
                  计划已生成，共 {store.plan.chapters.length} 章。请逐章确认。
                </Text>
              ) : null}
              {edited.map((chapter, index) => (
                <Card key={chapter.ordinal} style={styles.cardMb}>
                  <Text style={[styles.bold, { color: theme.colors.accent }]}>
                    {isContinuation && continuationAnchorInfo
                      ? `第 ${continuationAnchorInfo.getDisplayNumber(
                          continuationAnchorInfo.nextPosition + chapter.ordinal - 1,
                        )} 章 · 批次 ${chapter.ordinal}/${store.batch?.chapterCount ?? edited.length}`
                      : `第 ${chapter.ordinal} 章`}
                  </Text>
                  <TextInput
                    style={[styles.input, { backgroundColor: theme.colors.background, color: theme.colors.textPrimary }]}
                    value={chapter.title}
                    placeholder="章节标题"
                    placeholderTextColor={theme.colors.textMuted}
                    onChangeText={t =>
                      setEdited(prev => prev.map((c, i) => (i === index ? { ...c, title: t } : c)))
                    }
                  />
                  <TextInput
                    style={[styles.synopsisInput, { backgroundColor: theme.colors.background, color: theme.colors.textPrimary }]}
                    multiline
                    value={chapter.synopsis}
                    placeholder="本章摘要（可在写作中随时调优）"
                    placeholderTextColor={theme.colors.textMuted}
                    onChangeText={t =>
                      setEdited(prev => prev.map((c, i) => (i === index ? { ...c, synopsis: t } : c)))
                    }
                  />
                  <TextInput
                    style={[styles.input, { backgroundColor: theme.colors.background, color: theme.colors.textPrimary }]}
                    keyboardType="numeric"
                    value={String(chapter.targetWords)}
                    placeholder="目标字数"
                    placeholderTextColor={theme.colors.textMuted}
                    onChangeText={t =>
                      setEdited(prev =>
                        prev.map((c, i) =>
                          i === index ? { ...c, targetWords: Number(t) || 0 } : c,
                        ),
                      )
                    }
                  />
                </Card>
              ))}
            </Section>
            <View style={styles.row}>
              <Button
                label={store.loading ? '保存中…' : isContinuation ? '开始批量续写' : '开始批量写作'}
                icon={Play}
                onPress={handleStart}
                disabled={store.loading || store.reconciling}
              />
              <Button label="放弃" variant="ghost" icon={X} onPress={handleCancel} />
            </View>
          </>
        )}

        {view === 'running' && batchForCurrentProject && (
          <RunningView
            theme={theme}
            store={store}
            isContinuation={isContinuation}
            displayNumberOf={
              isContinuation && continuationAnchorInfo
                ? ordinal =>
                    continuationAnchorInfo.getDisplayNumber(
                      continuationAnchorInfo.nextPosition + ordinal - 1,
                    )
                : undefined
            }
            onPause={handlePause}
            onCancel={handleCancel}
            onRefresh={refresh}
          />
        )}

        {view === 'paused' && batchForCurrentProject && (
          <PausedView
            theme={theme}
            store={store}
            isContinuation={isContinuation}
            onResume={handleResume}
            resumeBusy={resumeSubmitting}
            onRestartLegacy={handleRestartLegacyBatch}
            onCancel={handleCancel}
            onViewTask={() => {
              // F2-07: 直达当前章的流水线结果页（查看失败详情/已成功阶段）。
              const taskId = store.items.find(
                i => i.ordinal === store.batch!.currentOrdinal,
              )?.activePipelineTaskId;
              if (taskId) {
                navigation.navigate('PipelineResult', { taskId });
              }
            }}
          />
        )}

        {view === 'report' && batchForCurrentProject && (
          <ReportView
            theme={theme}
            store={store}
            onLeave={() => {
              // 完成确认后直接离开批次页，回到章节工作台（EditorMain：续写
              // 项目是续写工作台，大纲项目是章节列表）。不能 setView('create')
              // 留在批次页——那会把用户带回一键写 N 章表单，体验割裂。
              // 已完成批次不是 active，重进批次页会自然回到创建页。
              navigation.goBack();
            }}
          />
        )}

        {store.error ? (
          <Text style={styles.errorBox}>
            {store.error}
          </Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function reasoningEffortLabel(
  value: PipelineReasoningEffort,
  executionProfile?: 'standard' | 'one_shot' | null,
): string {
  if (executionProfile === 'one_shot') return '极速';
  return PIPELINE_REASONING_EFFORT_OPTIONS.find(option => option.value === value)?.label || value;
}

function RunningView(props: {
  theme: any;
  store: ReturnType<typeof useMultiChapterBatchStore.getState>;
  isContinuation?: boolean;
  displayNumberOf?: (ordinal: number) => number;
  onPause: () => void;
  onCancel: () => void;
  onRefresh: () => void;
}) {
  const { theme, store, isContinuation, displayNumberOf } = props;
  // BN-12: the "last update" label must come from the durable SQLite state
  // (batch.updatedAt / current attempt.last_progress_at), NOT a local clock
  // that ticks every 2s. The store already mirrors SQLite; we read its
  // updatedAt here. A local timer is kept only to re-render periodically so
  // the label visually updates as time passes — but the value is real.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick(t => (t + 1) % 1_000_000), 2000);
    return () => clearInterval(timer);
  }, []);
  const batch = store.batch;
  if (!batch) {
    return <Text style={{ color: theme.colors.textSecondary }}>批次不存在</Text>;
  }
  const current = store.items.find(i => i.ordinal === batch.currentOrdinal);
  const completed = store.items.filter(i => i.status.startsWith('succeeded'));
  // 总体进度 = 已完成章 + 当前章内阶段进度（保证运行中进度条持续移动）。
  const stageOrder: string[] = isContinuation
    ? CONTINUATION_STAGE_ORDER
    : getPipelineStageOrder(batch.pipelineMode, {
        outlineWorkflowVersion: batch.outlineWorkflowVersion,
        contextBudgetVersion: batch.contextBudgetVersion,
      });
  const stageLabel = (stage: string | null) =>
    isContinuation
      ? CONTINUATION_STAGE_LABELS[stage as string] || stage || ''
      : STAGE_LABELS[stage as keyof typeof STAGE_LABELS] || stage || '';
  const currentStage =
    store.lastStage ||
    (current?.errorCode === 'BATCH_CONTINUATION_STATE_SYNC_WAIT'
      ? 'state_sync'
      : null);
  const stageIdx = currentStage
    ? stageOrder.indexOf(currentStage as any)
    : -1;
  const stagePct = stageIdx >= 0 ? (stageIdx / stageOrder.length) * 100 : 0;
  const overallPct = Math.min(
    100,
    Math.round(
      (((batch.currentOrdinal - 1) + stagePct / 100) /
        Math.max(1, batch.chapterCount)) *
        100,
    ),
  );
  // Real "last update" from batch.updatedAt (mirrors SQLite). If the batch
  // has not advanced in > 60s, surface a hint that progress may be stalled.
  const updatedAtMs = Number(batch.updatedAt) || 0;
  const updatedLabel = updatedAtMs
    ? new Date(updatedAtMs).toLocaleTimeString('zh-CN', { hour12: false })
    : '—';
  const idleSeconds = updatedAtMs
    ? Math.floor((Date.now() - updatedAtMs) / 1000)
    : 0;
  const stalled = idleSeconds >= 60 && batch.status !== 'completed';
  return (
    <>
      <Section title={`批次进度 ${batch.completedCount}/${batch.chapterCount}`}>
        {batch.reasoningEffort ? (
          <Text style={[styles.mt4, { color: theme.colors.accent }]}>思考强度：{reasoningEffortLabel(batch.reasoningEffort, batch.executionProfile)}（批次冻结）</Text>
        ) : null}
        <View
          style={[
            styles.progressTrack,
            { backgroundColor: theme.colors.border },
          ]}
        >
          <View
            style={[
              styles.progressFill,
              {
                width: `${overallPct}%`,
                backgroundColor: theme.colors.accent,
              },
            ]}
          />
        </View>
        <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
          总进度 {overallPct}% · 最后更新 {updatedLabel}
          {stalled ? `（已 ${idleSeconds}s 未更新，可能在等待服务端响应）` : ''}
        </Text>
        <Card style={styles.cardMb}>
          <Text style={[styles.bold, { color: theme.colors.textPrimary }]}>
            当前章：第 {batch.currentOrdinal}/{batch.chapterCount} 章
            {isContinuation && displayNumberOf
              ? ` · 第 ${displayNumberOf(batch.currentOrdinal)} 章`
              : ''}
            {current ? ` · ${current.title}` : ''}
          </Text>
          {currentStage ? (
            <Text style={[styles.mt4, { color: theme.colors.accent }]}>
              当前阶段：{stageLabel(currentStage)}
            </Text>
          ) : null}
          {isContinuation ? (
            <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
              随后：FinalValidate → Persist → PostWriting / ONE Memory，全部完成后才进入下一章
            </Text>
          ) : null}
          {current?.errorCode === 'BATCH_CONTINUATION_STATE_SYNC_WAIT' ? (
            <Text style={[styles.mt4, { color: theme.colors.accent }]}>
              正在同步人物状态与故事记忆…
            </Text>
          ) : null}
          {current ? (
            <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
              章节状态：{current.status}
              {current.retryCount > 0 ? ` · 重试 ${current.retryCount} 次` : ''}
            </Text>
          ) : null}
          {store.lastMessage ? (
            <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
              {store.lastMessage}
            </Text>
          ) : null}
          {current?.nextRetryAt ? (
            <Text style={[styles.mt4, { color: theme.colors.warning }]}>
              下次重试时间：{new Date(current.nextRetryAt).toLocaleTimeString()}
            </Text>
          ) : null}
        </Card>
        <Card style={styles.cardMb}>
          <Text style={[styles.bold, { color: theme.colors.textPrimary }]}>批次消耗</Text>
          <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
            LLM 调用：{batch.usedLlmCalls}
            {batch.maxLlmCalls != null ? ` / ${batch.maxLlmCalls}` : ''}
          </Text>
          <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
            输入 tokens：{batch.usedInputTokens.toLocaleString()}
            {batch.maxInputTokens != null ? ` / ${batch.maxInputTokens.toLocaleString()}` : ''}
          </Text>
          <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
            输出 tokens：{batch.usedOutputTokens.toLocaleString()}
            {batch.maxOutputTokens != null ? ` / ${batch.maxOutputTokens.toLocaleString()}` : ''}
          </Text>
        </Card>
        {completed.length > 0 ? (
          <Card>
            <Text style={[styles.bold, { color: theme.colors.textPrimary }]}>已完成章节</Text>
            {completed.map(item => (
              <Text key={item.ordinal} style={[styles.mt4, { color: theme.colors.textSecondary }]}>
                第 {item.ordinal} 章 · {item.title} · {item.completionQuality || 'full_pipeline'}
              </Text>
            ))}
          </Card>
        ) : null}
      </Section>
      <View style={styles.row}>
        <Button label="暂停" variant="ghost" icon={Pause} onPress={props.onPause} />
        <Button label="刷新" variant="ghost" icon={RefreshCw} onPress={props.onRefresh} />
        <Button label="结束批次" variant="ghost" icon={X} onPress={props.onCancel} />
      </View>
    </>
  );
}

function PausedView(props: {
  theme: any;
  store: ReturnType<typeof useMultiChapterBatchStore.getState>;
  isContinuation?: boolean;
  onResume: () => void;
  resumeBusy?: boolean;
  onRestartLegacy: () => void;
  onCancel: () => void;
  onViewTask?: () => void;
}) {
  const { theme, store, isContinuation } = props;
  const batch = store.batch!;
  const reasonLabels: Record<string, string> = {
    paused_timeout_unknown: '结果未知',
    paused_account_quota: '账户额度不足',
    paused_context_budget: '上下文预算不足',
    paused_batch_budget: '批次消耗预算已达上限',
    paused_project_changed: '项目章节已变化',
    paused_user: '已暂停',
  };
  const continuationDrift =
    isContinuation &&
    (batch.errorCode === 'BATCH_CONTINUATION_SOURCE_CHANGED' ||
      batch.errorCode === 'BATCH_CONTINUATION_BOUNDARY_CHANGED' ||
      batch.errorCode === 'BATCH_CONTINUATION_CANON_CHANGED' ||
      batch.status === 'paused_project_changed');
  const reason = isContinuation
    ? CONTINUATION_PAUSE_REASONS[batch.errorCode || ''] ||
      reasonLabels[batch.status] ||
      batch.status
    : reasonLabels[batch.status] || batch.status;
  const legacyWorkflow =
    !isContinuation &&
    Number(batch.outlineWorkflowVersion) !== CURRENT_OUTLINE_WORKFLOW_VERSION;
  const actions: Array<[string, () => void, boolean?]> = [];
  const resumeLabel = props.resumeBusy ? '正在恢复…' : '确认后继续';
  if (legacyWorkflow) {
    actions.push(['按新版继续剩余章节', props.onRestartLegacy]);
  } else if (isContinuation) {
    if (!continuationDrift) {
      actions.push([resumeLabel, props.onResume, props.resumeBusy]);
    }
  } else if (batch.status !== 'paused_project_changed') {
    actions.push([resumeLabel, props.onResume, props.resumeBusy]);
  }
  if (!legacyWorkflow && !isContinuation && batch.status === 'paused_account_quota') {
    actions.push([
      props.resumeBusy ? '正在恢复…' : '更换模型后继续',
      props.onResume,
      props.resumeBusy,
    ]);
  }
  if (!legacyWorkflow && !isContinuation && batch.status === 'paused_context_budget') {
    actions.push([
      props.resumeBusy ? '正在恢复…' : '重新编译后继续',
      props.onResume,
      props.resumeBusy,
    ]);
  }
  // F2-07: 结果未知（network_error 等）时提供直达当前章流水线结果页的
  // 入口，用户可先查看失败详情/已成功阶段，再决定继续方式。
  if (
    !isContinuation &&
    batch.status === 'paused_timeout_unknown' &&
    props.onViewTask
  ) {
    actions.push(['查看任务详情', props.onViewTask]);
  }
  actions.push(['结束批次', props.onCancel]);
  return (
    <>
      <Section title="批次已暂停">
        <Card>
          <Text style={[styles.bold, { color: theme.colors.textPrimary }]}>{reason}</Text>
          <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
            {batch.errorMessage || '请选择下一步操作'}
          </Text>
          {legacyWorkflow ? (
            <Text style={[styles.mt8, { color: theme.colors.warning }]}>旧版未完成任务不会继续执行；已完成章节和历史记录保留。</Text>
          ) : null}
          {isContinuation && continuationDrift ? (
            <Text style={[styles.mt8, { color: theme.colors.warning }]}>
              原著或 Canon 已变化，继续旧批次可能偏离最新设定；已生成章节保留。如需继续，请确认变更符合预期后在原边界下重新发起批次。
            </Text>
          ) : null}
          {isContinuation && batch.errorCode === 'BATCH_CONTINUATION_FINAL_NEEDS_REVIEW' ? (
            <Text style={[styles.mt8, { color: theme.colors.textSecondary }]}>
              可在续写工作台打开本章的续写结果人工确认；确认采用后回到这里点击「确认后继续」。
            </Text>
          ) : null}
          {isContinuation && batch.errorCode === 'BATCH_CONTINUATION_CHAPTER_CONFLICT' ? (
            <Text style={[styles.mt8, { color: theme.colors.textSecondary }]}>
              本章在生成期间被手动编辑过；继续前请先确认章节正文，批次不会静默覆盖你的修改。
            </Text>
          ) : null}
          {!legacyWorkflow && !isContinuation && batch.status === 'paused_timeout_unknown' ? (
            <Text style={[styles.mt8, { color: theme.colors.warning }]}>
              提示：请求可能已在服务端执行，重新执行可能产生重复费用。
            </Text>
          ) : null}
          {!legacyWorkflow && !isContinuation && batch.status === 'paused_context_budget' ? (
            <Text style={[styles.mt8, { color: theme.colors.textSecondary }]}>
              当前章尚未调用模型；可重新弹性编译、更换更大上下文模型、降低目标字数或编辑当前章纲。
            </Text>
          ) : null}
          {!legacyWorkflow && !isContinuation && batch.status === 'paused_batch_budget' ? (
            <Text style={[styles.mt8, { color: theme.colors.textSecondary }]}>
              可增加预算、减少剩余章数、降低后续字数或结束批次。
            </Text>
          ) : null}
        </Card>
      </Section>
      <View style={styles.column}>
        {actions.map(([label, fn, disabled]) => (
          <View key={label} style={{ marginBottom: spacing.sm }}>
            <Button label={label} onPress={fn} disabled={disabled} />
          </View>
        ))}
      </View>
    </>
  );
}

function ReportView(props: {
  theme: any;
  store: ReturnType<typeof useMultiChapterBatchStore.getState>;
  onLeave: () => void;
}) {
  const { theme, store } = props;
  const batch = store.batch!;
  const full = store.items.filter(i => i.completionQuality === 'full_pipeline').length;
  const draft = store.items.filter(i => i.completionQuality === 'draft_only').length;
  return (
    <>
      <Section title={batch.status === 'completed' ? '批次完成' : '批次已结束'}>
        <Card>
          {batch.reasoningEffort ? (
            <Text style={[styles.mt4, { color: theme.colors.accent }]}>思考强度：{reasoningEffortLabel(batch.reasoningEffort, batch.executionProfile)}（批次冻结）</Text>
          ) : null}
          <Text
            style={[styles.bold, { color: theme.colors.textPrimary }]}
          >
            成功：{batch.completedCount}/{batch.chapterCount}
          </Text>
          <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
            完整流水线：{full} · 采用草稿：{draft}
          </Text>
          <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
            总调用：{batch.usedLlmCalls}
          </Text>
          <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
            输入 tokens：{batch.usedInputTokens.toLocaleString()}
          </Text>
          <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>
            输出 tokens：{batch.usedOutputTokens.toLocaleString()}
          </Text>
          {batch.errorCode ? (
            <Text style={[styles.mt8, { color: theme.colors.danger }]}>
              结束原因：{batch.errorMessage || batch.errorCode}
            </Text>
          ) : null}
        </Card>
        {batch.status === 'completed' ? (
          <View style={{ marginTop: spacing.md }}>
            <Button label="返回章节列表" onPress={props.onLeave} />
          </View>
        ) : null}
      </Section>
    </>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: spacing.sm }}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, paddingBottom: 80 },
  bold: { fontWeight: '600' },
  mt4: { marginTop: 4 },
  mt8: { marginTop: 8 },
  cardMb: { marginBottom: spacing.md },
  progressTrack: {
    height: 10,
    borderRadius: 5,
    overflow: 'hidden',
    marginBottom: spacing.sm,
  },
  progressFill: { height: '100%', borderRadius: 5 },
  errorBox: { color: '#c00', paddingVertical: spacing.md },
  inputMultiline: {
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    minHeight: 60,
    textAlignVertical: 'top',
    marginBottom: spacing.sm,
  },
  synopsisInput: {
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    minHeight: 80,
    maxHeight: 160,
    textAlignVertical: 'top',
    marginBottom: spacing.sm,
  },
  input: {
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    minHeight: 44,
    textAlignVertical: 'top',
    marginBottom: spacing.sm,
  },
  row: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginTop: spacing.sm },
  column: { marginTop: spacing.md },
  fieldLabel: { fontSize: 12, marginBottom: 4 },
});

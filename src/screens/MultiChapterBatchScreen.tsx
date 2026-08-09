/**
 * Multi-chapter batch screen (Phase 8) — outline mode only.
 *
 * One screen with internal views:
 *   1. create   — summary, N, target words, mode, optional budget caps
 *   2. preview  — editable plan (title/synopsis/beats/carryIn/carryOut/words)
 *   3. running  — serial progress, attempts, retry time, budget usage
 *   4. paused   — cause-specific actions
 *   5. report   — completion summary + token/call usage
 *
 * The batch state lives in SQLite; this screen mirrors it via the store.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Play, Pause, X, RefreshCw, ListChecks } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
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
import type { BatchChapterPlanItem } from '../types/multiChapterBatch';
import type { PipelineReasoningEffort } from '../types/pipeline';
import { PIPELINE_REASONING_EFFORT_OPTIONS } from '../services/pipeline/reasoningPolicy';
import {
  getPipelineStageOrder,
  STAGE_LABELS,
} from '../utils/stages';

type BatchView = 'create' | 'preview' | 'running' | 'paused' | 'report';

export function MultiChapterBatchScreen(): React.ReactElement {
  const navigation =
    useNavigation<NativeStackNavigationProp<EditorStackParamList>>();
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const store = useMultiChapterBatchStore();
  const [view, setView] = useState<BatchView>('create');
  const [form, setForm] = useState({
    sourcePrompt: '',
    chapterCount: String(BATCH_DEFAULT_CHAPTERS),
    targetWords: String(BATCH_DEFAULT_TARGET_WORDS),
    pipelineMode: 'full' as 'draft_only' | 'fast' | 'full',
  });
  const [edited, setEdited] = useState<BatchChapterPlanItem[]>([]);

  const refresh = useCallback(() => {
    if (store.batch) {
      store.refresh().catch(() => {});
    }
  }, [store]);

  // 进入页面时自动加载当前项目的活跃批次：规划后的计划持久化在 SQLite，
  // 退出/杀进程后重新进入必须回到规划预览（而不是创建页）。
  useEffect(() => {
    if (currentProject) {
      store.loadActiveBatchForProject(currentProject.id).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id]);

  // 运行页轮询（运行中每 2s 刷新一次状态）。
  useEffect(() => {
    if (!store.batch || view !== 'running') return;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [store.batch, view, refresh]);

  const batchStatus = store.batch?.status;
  useEffect(() => {
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
  }, [batchStatus, store.reconciling, store.items]);

  // 冷启动恢复：编辑计划从已持久化的批次条目重建（本地 edited state 是
  // 易失的，新进程后为空）。
  useEffect(() => {
    if (view === 'preview' && edited.length === 0 && store.items.length > 0) {
      setEdited(
        store.items.map(item => ({
          ordinal: item.ordinal,
          title: item.title,
          synopsis: item.synopsis,
          keyBeats: (() => {
            try {
              const parsed = JSON.parse(item.keyBeatsJson || '[]');
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          })(),
          carryIn: item.carryIn || '',
          carryOut: item.carryOut || '',
          targetWords: item.targetWords,
        })),
      );
    }
  }, [view, edited.length, store.items]);

  const handleCreate = async () => {
    const count = Number(form.chapterCount);
    if (count < BATCH_MIN_CHAPTERS || count > BATCH_MAX_CHAPTERS) {
      Alert.alert('章节数不合法', `请在 ${BATCH_MIN_CHAPTERS}～${BATCH_MAX_CHAPTERS} 之间选择`);
      return;
    }
    if (!form.sourcePrompt.trim()) {
      Alert.alert('剧情摘要不能为空');
      return;
    }
    if (!currentProject) return;
    try {
      const id = await store.createDraftBatch({
        projectId: currentProject.id,
        sourcePrompt: form.sourcePrompt.trim(),
        chapterCount: count,
        targetWordsPerChapter: Number(form.targetWords) || BATCH_DEFAULT_TARGET_WORDS,
        pipelineMode: form.pipelineMode,
      });
      const plan = await store.runPlanner(id);
      setEdited(plan.chapters.map(c => ({ ...c })));
      setView('preview');
    } catch (error: any) {
      Alert.alert('规划失败', String(error?.message || '请检查模型配置后重试'));
    }
  };

  const handleStart = async () => {
    if (!store.batch) return;
    const valid = edited.length > 0;
    if (!valid) {
      Alert.alert('请先完成计划');
      return;
    }
    try {
      await store.saveEditedPlan(store.batch.id, edited);
      // 立即切到运行页：store.start 非阻塞驱动 reconcile，页面通过轮询
      // 刷新进度（此前 await 整批完成后才切页，用户以为按钮没响应）。
      setView('running');
      await store.start(store.batch.id);
    } catch (error: any) {
      Alert.alert('启动失败', String(error?.message || '请检查计划后重试'));
    }
  };

  const handleResume = async () => {
    if (!store.batch) return;
    try {
      await store.resume(store.batch.id);
    } catch (error: any) {
      Alert.alert('恢复失败', String(error?.message || '请稍后重试'));
    }
  };

  const handlePause = async () => {
    if (!store.batch) return;
    try {
      await store.pause(store.batch.id);
    } catch {
      // store surfaces errors via state
    }
  };

  const handleCancel = () => {
    if (!store.batch) return;
    const batchId = store.batch.id;
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
      ? '一键写 N 章'
      : view === 'preview'
        ? '规划预览'
        : view === 'report'
          ? '批次报告'
          : store.batch
            ? `第 ${store.batch.currentOrdinal}/${store.batch.chapterCount} 章`
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
              // F2-07: running/paused 视图的返回必须真正离开批次页（goBack），
              // 批次在后台继续。原实现 setView('create') + loadActiveBatchForProject
              // 会把运行中的批次重新加载进 store，view effect 又强制切回 running，
              // 导致按钮"无反应"。创建/预览视图保持清表单回到创建页。
              if (view === 'running' || view === 'paused') {
                navigation.goBack();
                return;
              }
              setView('create');
              store.loadActiveBatchForProject(
                currentProject?.id ?? 0,
              ).catch(() => {});
            }}
          />
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        {view === 'create' && (
          <>
            <Section title="剧情摘要">
              <TextInput
                style={[styles.inputMultiline, { backgroundColor: theme.colors.card, color: theme.colors.textPrimary }]}
                placeholder="输入较长的局部剧情摘要、阶段目标或故事弧提示词…"
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
              <SegmentedMode
                theme={theme}
                value={form.pipelineMode}
                onChange={v => setForm(f => ({ ...f, pipelineMode: v }))}
              />
            </Section>
            <View style={styles.row}>
              <Button
                label={store.loading ? '正在规划…' : '开始规划'}
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
                <Text style={[styles.bold, { color: theme.colors.textPrimary }]}>V3 思考强度</Text>
                <Text style={[styles.mt4, { color: theme.colors.accent }]}>批次已冻结：{reasoningEffortLabel(store.batch.reasoningEffort)}</Text>
                <Text style={[styles.mt4, { color: theme.colors.textSecondary }]}>后续章节任务会继承该档位；修改流水线配置不会影响本批次。</Text>
              </Card>
            ) : null}
            <Section title="计划预览（可编辑）">
              {edited.length === 0 && store.plan ? (
                <Text style={{ color: theme.colors.textSecondary }}>
                  计划已生成，共 {store.plan.chapters.length} 章。请逐章确认。
                </Text>
              ) : null}
              {edited.map((chapter, index) => (
                <Card key={chapter.ordinal} style={styles.cardMb}>
                  <Text style={[styles.bold, { color: theme.colors.accent }]}>
                    第 {chapter.ordinal} 章
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
                label={store.loading ? '保存中…' : '开始批量写作'}
                icon={Play}
                onPress={handleStart}
                disabled={store.loading || store.reconciling}
              />
              <Button label="放弃" variant="ghost" icon={X} onPress={handleCancel} />
            </View>
          </>
        )}

        {view === 'running' && store.batch && (
          <RunningView
            theme={theme}
            store={store}
            onPause={handlePause}
            onCancel={handleCancel}
            onRefresh={refresh}
          />
        )}

        {view === 'paused' && store.batch && (
          <PausedView
            theme={theme}
            store={store}
            onResume={handleResume}
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

        {view === 'report' && store.batch && (
          <ReportView theme={theme} store={store} onStartNew={() => {
            store.loadActiveBatchForProject(currentProject?.id ?? 0).catch(() => {});
            setView('create');
          }} />
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

function reasoningEffortLabel(value: PipelineReasoningEffort): string {
  return PIPELINE_REASONING_EFFORT_OPTIONS.find(option => option.value === value)?.label || value;
}

function SegmentedMode(props: {
  theme: any;
  value: 'draft_only' | 'fast' | 'full';
  onChange: (v: 'draft_only' | 'fast' | 'full') => void;
}) {
  return (
    <View style={styles.row}>
      {(
        [
          ['draft_only', '仅草稿'],
          ['fast', '快速'],
          ['full', '完整'],
        ] as const
      ).map(([value, label]) => (
        <Button
          key={value}
          label={label}
          variant={props.value === value ? 'primary' : 'ghost'}
          compact
          onPress={() => props.onChange(value)}
        />
      ))}
    </View>
  );
}

function RunningView(props: {
  theme: any;
  store: ReturnType<typeof useMultiChapterBatchStore.getState>;
  onPause: () => void;
  onCancel: () => void;
  onRefresh: () => void;
}) {
  const { theme, store } = props;
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
  const stageOrder = getPipelineStageOrder(batch.pipelineMode, {
    outlineWorkflowVersion: batch.outlineWorkflowVersion,
    contextBudgetVersion: batch.contextBudgetVersion,
  });
  const stageIdx = store.lastStage
    ? stageOrder.indexOf(store.lastStage as any)
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
          <Text style={[styles.mt4, { color: theme.colors.accent }]}>V3 思考强度：{reasoningEffortLabel(batch.reasoningEffort)}（批次冻结）</Text>
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
            {current ? ` · ${current.title}` : ''}
          </Text>
          {store.lastStage ? (
            <Text style={[styles.mt4, { color: theme.colors.accent }]}>
              当前阶段：{STAGE_LABELS[store.lastStage as keyof typeof STAGE_LABELS] || store.lastStage}
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
  onResume: () => void;
  onCancel: () => void;
  onViewTask?: () => void;
}) {
  const { theme, store } = props;
  const batch = store.batch!;
  const reasonLabels: Record<string, string> = {
    paused_timeout_unknown: '结果未知',
    paused_account_quota: '账户额度不足',
    paused_context_budget: '上下文预算不足',
    paused_batch_budget: '批次消耗预算已达上限',
    paused_project_changed: '项目章节已变化',
    paused_user: '已暂停',
  };
  const reason = reasonLabels[batch.status] || batch.status;
  const actions: Array<[string, () => void]> = [];
  if (batch.status !== 'paused_project_changed') {
    actions.push(['确认后继续', props.onResume]);
  }
  if (batch.status === 'paused_account_quota') {
    actions.push(['更换模型后继续', props.onResume]);
  }
  if (batch.status === 'paused_context_budget') {
    actions.push(['重新编译后继续', props.onResume]);
  }
  // F2-07: 结果未知（network_error 等）时提供直达当前章流水线结果页的
  // 入口，用户可先查看失败详情/已成功阶段，再决定继续方式。
  if (batch.status === 'paused_timeout_unknown' && props.onViewTask) {
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
          {batch.status === 'paused_timeout_unknown' ? (
            <Text style={[styles.mt8, { color: theme.colors.warning }]}>
              提示：请求可能已在服务端执行，重新执行可能产生重复费用。
            </Text>
          ) : null}
          {batch.status === 'paused_context_budget' ? (
            <Text style={[styles.mt8, { color: theme.colors.textSecondary }]}>
              当前章尚未调用模型；可重新弹性编译、更换更大上下文模型、降低目标字数或编辑当前章纲。
            </Text>
          ) : null}
          {batch.status === 'paused_batch_budget' ? (
            <Text style={[styles.mt8, { color: theme.colors.textSecondary }]}>
              可增加预算、减少剩余章数、降低后续字数或结束批次。
            </Text>
          ) : null}
        </Card>
      </Section>
      <View style={styles.column}>
        {actions.map(([label, fn]) => (
          <View key={label} style={{ marginBottom: spacing.sm }}>
            <Button label={label} onPress={fn} />
          </View>
        ))}
      </View>
    </>
  );
}

function ReportView(props: {
  theme: any;
  store: ReturnType<typeof useMultiChapterBatchStore.getState>;
  onStartNew: () => void;
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
            <Text style={[styles.mt4, { color: theme.colors.accent }]}>V3 思考强度：{reasoningEffortLabel(batch.reasoningEffort)}（批次冻结）</Text>
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
            <Button label="返回章节列表" onPress={props.onStartNew} />
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

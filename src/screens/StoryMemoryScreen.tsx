import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Toast from 'react-native-toast-message';
import {
  Button,
  Card,
  EmptyState,
  Header,
  LoadingState,
  Screen,
  spacing,
} from '../components/ui';
import * as db from '../services/database';
import {
  describeStoryMemoryPolicy,
  listPendingChapters,
  STORY_MEMORY_DEFAULT_INTERVAL,
} from '../services/storyMemory/storyMemoryPolicy';
import {
  cancelStoryMemoryMaintenance,
  requestStoryMemoryMaintenance,
} from '../services/storyMemory/storyMemoryService';
import type {
  StoryMemoryPolicy,
  StoryMemoryState,
  StoryMemoryUpdateMode,
} from '../services/storyMemory/storyMemoryTypes';
import { listStoryMemoryRequestAttempts } from '../data/repositories/storyMemoryRequestAttemptRepository';
import {
  storyMemoryTaskId,
  type StoryMemoryTaskProgress,
  useStoryMemoryTaskStore,
} from '../store/storyMemoryTaskStore';
import { useProjectStore } from '../store/projectStore';
import { useThemeStore } from '../store/themeStore';
import { getContinuationChapterNumbering } from '../services/continuation/chapterNumbering/continuationChapterNumbering';
import type { ContinuationChapterPosition } from '../types/novel';

const STATUS_LABEL: Record<string, string> = {
  empty: '尚未初始化',
  clean: '正常',
  dirty: '需要重新整理',
  rebuilding: '整理中',
  failed: '整理失败',
};

function chapterLabel(
  getDisplayNumber: ((position: number) => number) | null,
  position: number,
): string {
  const n = getDisplayNumber ? getDisplayNumber(position) : position + 1;
  return `第 ${n} 章`;
}

const MODE_OPTIONS: Array<{ mode: StoryMemoryUpdateMode; label: string }> = [
  { mode: 'smart', label: '智能更新（推荐）' },
  { mode: 'fixed', label: '固定间隔' },
  { mode: 'every_chapter', label: '每章更新' },
  { mode: 'manual', label: '仅手动更新' },
];

function formatLocalTime(iso: string): string {
  if (!iso) return '无';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function characterName(state: StoryMemoryState, characterId: string): string {
  const character = state.characters[characterId];
  return character?.canonicalName || `未知人物（${shortId(characterId)}）`;
}

function isTaskRunning(task: StoryMemoryTaskProgress | null): boolean {
  return Boolean(
    task &&
      !['completed', 'failed', 'cancelled', 'outcome_unknown'].includes(
        task.phase,
      ),
  );
}

export const StoryMemoryScreen: React.FC<{ onClose?: () => void }> = ({
  onClose,
}) => {
  const { currentProject } = useProjectStore();
  const { theme } = useThemeStore();
  const [state, setState] = useState<StoryMemoryState | null>(null);
  const [policy, setPolicy] = useState<StoryMemoryPolicy | null>(null);
  const [pendingRange, setPendingRange] = useState('');
  const [pendingCount, setPendingCount] = useState(0);
  const [unknownCount, setUnknownCount] = useState(0);
  const [unknownAttemptIds, setUnknownAttemptIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [showPolicy, setShowPolicy] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [intervalText, setIntervalText] = useState(
    String(STORY_MEMORY_DEFAULT_INTERVAL),
  );
  const [displayOf, setDisplayOf] = useState<
    ((position: number) => number) | null
  >(null);
  const [clock, setClock] = useState(Date.now());

  const task = useStoryMemoryTaskStore(stateValue =>
    currentProject
      ? stateValue.tasks[storyMemoryTaskId(currentProject.id)] || null
      : null,
  );
  const taskRunning = isTaskRunning(task);

  const load = useCallback(async () => {
    if (!currentProject) {
      setState(null);
      setPolicy(null);
      setDisplayOf(null);
      setLoading(false);
      return;
    }
    const record = await db.ensureProjectStoryMemoryRow(currentProject.id);
    const contextConfig = await db.getContextConfig();
    const nextPolicy = await db.ensureStoryMemoryPolicy(
      currentProject.id,
      contextConfig.slidingWindowSize,
    );
    const chapters = await db.getChaptersByProject(currentProject.id);
    const pending = listPendingChapters(
      chapters.filter(
        chapter =>
          Boolean(chapter.content?.trim()) &&
          (chapter.status === 'final' || chapter.finalized_at != null),
      ),
      record.state.throughChapterPosition,
    );
    let nextDisplayOf: ((position: number) => number) | null = null;
    try {
      const numbering = await getContinuationChapterNumbering(currentProject.id);
      nextDisplayOf = position =>
        numbering.getDisplayNumber(position as ContinuationChapterPosition);
    } catch {
      nextDisplayOf = position => position + 1;
    }
    let unresolved = [] as Awaited<
      ReturnType<typeof listStoryMemoryRequestAttempts>
    >;
    try {
      unresolved = await listStoryMemoryRequestAttempts(currentProject.id, [
        'prepared',
        'sent',
        'outcome_unknown',
      ]);
    } catch {
      // Older test fixtures / pre-Schema-50 databases have no ledger yet.
    }
    setDisplayOf(() => nextDisplayOf);
    setState(record.state);
    setPolicy(nextPolicy);
    setIntervalText(String(nextPolicy.intervalChapters));
    setPendingCount(pending.length);
    setUnknownCount(unresolved.length);
    const firstLogicalBatchId = unresolved[0]?.logicalBatchId;
    setUnknownAttemptIds(
      unresolved
        .filter(item => item.logicalBatchId === firstLogicalBatchId)
        .map(item => item.attemptId),
    );
    if (pending.length === 0) {
      setPendingRange('无');
    } else {
      const fromLabel = chapterLabel(nextDisplayOf, pending[0].position);
      const toLabel = chapterLabel(
        nextDisplayOf,
        pending[pending.length - 1].position,
      );
      setPendingRange(
        fromLabel === toLabel
          ? `${fromLabel}（1章）`
          : `${fromLabel}～${toLabel}（${pending.length}章）`,
      );
    }
    setLoading(false);
  }, [currentProject]);

  useEffect(() => {
    load().catch(error => {
      setLoading(false);
      Toast.show({
        type: 'error',
        text1: '故事记忆读取失败',
        text2: error?.message,
      });
    });
  }, [load]);

  useEffect(() => {
    if (!taskRunning) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [taskRunning]);

  const savePolicy = useCallback(
    async (patch: Partial<StoryMemoryPolicy>) => {
      if (!currentProject || !policy) return;
      const next = await db.upsertStoryMemoryPolicy({
        ...policy,
        ...patch,
        projectId: currentProject.id,
        updatedAt: new Date().toISOString(),
      });
      setPolicy(next);
      setIntervalText(String(next.intervalChapters));
      Toast.show({ type: 'success', text1: '更新策略已保存' });
    },
    [currentProject, policy],
  );

  const finalThroughPosition = useCallback(async () => {
    if (!currentProject) return state?.throughChapterPosition ?? -1;
    const chapters = await db.getChaptersByProject(currentProject.id);
    return (
      chapters
        .filter(
          chapter =>
            Boolean(chapter.content?.trim()) &&
            (chapter.status === 'final' || chapter.finalized_at != null),
        )
        .sort((a, b) => a.position - b.position)
        .at(-1)?.position ?? state?.throughChapterPosition ?? -1
    );
  }, [currentProject, state]);

  const startMaintenance = useCallback(
    async (options: {
      clearFirst?: boolean;
      mode?: 'auto' | 'full' | 'legacy_bootstrap';
      acknowledgeUnknown?: boolean;
    } = {}) => {
      if (!currentProject || taskRunning) return;
      const throughPosition = await finalThroughPosition();
      try {
        await requestStoryMemoryMaintenance({
          projectId: currentProject.id,
          throughPosition,
          reason: 'manual',
          priority: 'manual',
          clearFirst: options.clearFirst,
          mode: options.mode,
          userAcknowledgedUnknown: options.acknowledgeUnknown,
          acknowledgedAttemptIds: options.acknowledgeUnknown
            ? unknownAttemptIds
            : undefined,
        });
        Toast.show({ type: 'success', text1: '长期记忆已整理完成' });
      } catch (error: any) {
        if (error?.code === 'MEMORY_CHECKPOINT_OUTCOME_UNKNOWN') {
          Toast.show({
            type: 'info',
            text1: '仍有未确认请求',
            text2: '请逐项确认后再继续，避免重复计费。',
          });
        } else if (
          error?.code !== 'MEMORY_REBUILD_CANCELLED' &&
          error?.code !== 'MEMORY_CHECKPOINT_CANCELLED'
        ) {
          Toast.show({
            type: 'error',
            text1: '长期记忆整理失败',
            text2: error?.message,
          });
        }
      } finally {
        await load();
      }
    },
    [currentProject, finalThroughPosition, load, taskRunning, unknownAttemptIds],
  );

  const handleUnknown = useCallback(() => {
    if (!currentProject || taskRunning) return;
    Alert.alert(
      '继续整理可能再次调用模型 API',
      '如果上一请求实际上已经由服务端处理，可能产生重复调用费用。是否继续恢复？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '继续恢复',
          onPress: () =>
            startMaintenance({ acknowledgeUnknown: true }).catch(() => undefined),
        },
      ],
    );
  }, [currentProject, startMaintenance, taskRunning]);

  const primaryLabel = taskRunning
    ? '停止整理'
    : unknownCount > 0
      ? '处理未确认任务'
      : state?.metadata.status === 'empty'
        ? '初始化长期记忆'
        : state?.metadata.status === 'dirty' || state?.metadata.status === 'failed'
          ? '继续整理'
          : pendingCount > 0
            ? '整理长期记忆'
            : null;

  const toggleSection = (key: string) =>
    setExpandedSections(current => ({ ...current, [key]: !current[key] }));

  if (loading) {
    return (
      <Screen>
        <Header title="故事记忆" />
        <LoadingState label="正在读取故事状态..." />
      </Screen>
    );
  }
  if (!currentProject || !state || !policy) {
    return (
      <Screen>
        <Header
          title="故事记忆"
          action={
            onClose ? <Button label="关闭" variant="ghost" onPress={onClose} /> : undefined
          }
        />
        <EmptyState title="请先选择小说项目" />
      </Screen>
    );
  }

  const characters = Object.values(state.characters);
  const relationships = Object.values(state.relationships);
  const mainline = state.mainline;
  const openThreads = Object.values(mainline.openThreads);
  const unpaidForeshadowing = Object.values(mainline.foreshadowing).filter(
    item => item.status !== 'paid',
  );
  const mainlineIsEmpty =
    !mainline.currentArc &&
    !mainline.currentObjective.trim() &&
    Object.keys(mainline.activeConflicts).length === 0 &&
    Object.keys(mainline.openThreads).length === 0 &&
    unpaidForeshadowing.length === 0;
  const hasMainlineHistory =
    mainline.recentCompletedBeats.length > 0 ||
    mainline.recentResolvedThreads.length > 0 ||
    Boolean(mainline.archiveDigest.trim());
  const showUnrecognizedMainlineDiagnostic =
    state.metadata.status === 'clean' &&
    state.throughChapterPosition >= 5 &&
    mainlineIsEmpty &&
    !hasMainlineHistory;

  return (
    <Screen>
      <Header
        title="故事记忆"
        subtitle={currentProject.name}
        action={
          onClose ? <Button label="关闭" variant="ghost" onPress={onClose} /> : undefined
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Text style={[styles.title, { color: theme.colors.textPrimary }]} accessibilityRole="header">
            长期记忆：{taskRunning ? '正在整理' : unknownCount > 0 ? '需要处理未确认请求' : STATUS_LABEL[state.metadata.status] || state.metadata.status}
          </Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>已整理到：{state.throughChapterPosition >= 0 ? chapterLabel(displayOf, state.throughChapterPosition) : '无'}</Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>待整理：{pendingRange}</Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>更新方式：{describeStoryMemoryPolicy(policy)}</Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>最后更新：{formatLocalTime(state.metadata.updatedAt)}</Text>
          {primaryLabel ? (
            <Button
              label={primaryLabel}
              onPress={() => {
                if (taskRunning) {
                  cancelStoryMemoryMaintenance(currentProject.id);
                } else if (unknownCount > 0) {
                  handleUnknown();
                } else {
                  startMaintenance().catch(() => undefined);
                }
              }}
            />
          ) : (
            <Text style={[styles.latest, { color: theme.colors.accent }]}>已是最新</Text>
          )}
        </Card>

        {taskRunning && task ? (
          <Card>
            <Text style={[styles.title, { color: theme.colors.textPrimary }]} accessibilityLiveRegion="polite">正在整理</Text>
            <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>当前范围：{task.currentFromPosition == null ? '准备中' : `${chapterLabel(displayOf, task.currentFromPosition)}${task.currentThroughPosition !== task.currentFromPosition ? `～${chapterLabel(displayOf, task.currentThroughPosition ?? task.currentFromPosition)}` : ''}`}</Text>
            <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>批次：{task.completedBatches} / {task.totalBatches || 1}</Text>
            <View style={[styles.progressTrack, { backgroundColor: theme.colors.border }]}>
              <View style={[styles.progressFill, { width: `${task.percent}%`, backgroundColor: theme.colors.accent }]} />
            </View>
            <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>{task.percent}% · 已完成 {task.completedChapters} / {task.totalChapters} 章 · 已用时 {formatElapsed(task.startedAt, clock)}</Text>
            <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>{task.message}</Text>
          </Card>
        ) : null}

        <Card>
          <Button
            label={`更新设置：${describeStoryMemoryPolicy(policy)}  >`}
            variant="secondary"
            onPress={() => setShowPolicy(value => !value)}
          />
          {showPolicy ? (
            <View style={styles.actions}>
              {MODE_OPTIONS.map(option => (
                <Button
                  key={option.mode}
                  label={`${policy.mode === option.mode ? '● ' : '○ '}${option.label}`}
                  variant={policy.mode === option.mode ? 'primary' : 'secondary'}
                  onPress={() => savePolicy({ mode: option.mode })}
                />
              ))}
              {(policy.mode === 'smart' || policy.mode === 'fixed') && (
                <View style={styles.row}>
                  <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>每</Text>
                  <TextInput
                    value={intervalText}
                    onChangeText={setIntervalText}
                    onEndEditing={() => {
                      const n = Number(intervalText);
                      if (Number.isFinite(n)) savePolicy({ intervalChapters: n }).catch(() => undefined);
                    }}
                    keyboardType="number-pad"
                    style={[styles.intervalInput, { color: theme.colors.textPrimary, borderColor: theme.colors.border }]}
                    accessibilityLabel="检查点间隔章节数"
                  />
                  <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>章</Text>
                </View>
              )}
            </View>
          ) : null}
        </Card>

        <Card>
          <Button
            label={showDiagnostics ? '收起维护与诊断' : '维护与诊断  >'}
            variant="secondary"
            onPress={() => setShowDiagnostics(value => !value)}
          />
          {showDiagnostics ? (
            <View style={styles.actions}>
              <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>上下文覆盖：{state.metadata.status === 'dirty' ? '需重新整理' : pendingCount > 0 ? '由近期正文桥接' : '完整'}</Text>
              <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>需要重新整理的位置：{state.metadata.dirtyFromPosition == null ? '无' : chapterLabel(displayOf, state.metadata.dirtyFromPosition)}</Text>
              <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>整理来源：{state.metadata.source === 'legacy_bootstrap' ? '旧摘要快速初始化' : '章节正文'}</Text>
              {state.metadata.lastError ? <Text style={styles.error}>最近错误：{state.metadata.lastError}</Text> : null}
              <Button label="重新整理长期记忆" variant="secondary" onPress={() => startMaintenance().catch(() => undefined)} />
              <Button
                label="清空并重新构建"
                variant="danger"
                onPress={() =>
                  Alert.alert('清空并重建', '将删除现有结构化记忆并从正文重建，章节正文不会删除。', [
                    { text: '取消', style: 'cancel' },
                    { text: '继续', style: 'destructive', onPress: () => startMaintenance({ clearFirst: true, mode: 'full' }).catch(() => undefined) },
                  ])
                }
              />
            </View>
          ) : null}
        </Card>

        <Card>
          <Button label={`登场人物（${characters.length}） ${expandedSections.characters ? '⌄' : '>'}`} variant="secondary" onPress={() => toggleSection('characters')} />
          {expandedSections.characters ? (characters.length ? characters.map(item => <Text key={item.id} style={[styles.item, { color: theme.colors.textSecondary }]}>• {item.canonicalName}｜{item.role || '身份未知'}｜{item.currentState.location || '位置未知'}｜目标：{item.currentState.currentGoal || '无'}｜{item.status === 'active' ? '活跃' : item.status}</Text>) : <Text style={[styles.item, { color: theme.colors.textSecondary }]}>无</Text>) : null}
        </Card>
        <Card>
          <Button label={`人物关系（${relationships.length}） ${expandedSections.relationships ? '⌄' : '>'}`} variant="secondary" onPress={() => toggleSection('relationships')} />
          {expandedSections.relationships ? (relationships.length ? relationships.map(item => <Text key={item.id} style={[styles.item, { color: theme.colors.textSecondary }]}>• {characterName(state, item.fromCharacterId)} {item.direction === 'bidirectional' ? '↔' : '→'} {characterName(state, item.toCharacterId)}｜{item.relationType}｜{item.currentState}</Text>) : <Text style={[styles.item, { color: theme.colors.textSecondary }]}>无</Text>) : null}
        </Card>
        <Card>
          <Button label={`故事主线 ${expandedSections.mainline ? '⌄' : '>'}`} variant="secondary" onPress={() => toggleSection('mainline')} />
          {expandedSections.mainline ? (
            <>
              {showUnrecognizedMainlineDiagnostic ? <Text style={[styles.diagnostic, { color: theme.colors.warning }]}>已完成多章长期记忆整理，但尚未识别到有效故事主线。可在维护与诊断中清空并重建。</Text> : null}
              <Text style={[styles.item, { color: theme.colors.textSecondary }]}>剧情弧：{mainline.currentArc ? [mainline.currentArc.name, mainline.currentArc.summary].filter(Boolean).join('｜') : '无'}</Text>
              <Text style={[styles.item, { color: theme.colors.textSecondary }]}>当前目标：{mainline.currentObjective || '无'}</Text>
              <Text style={[styles.item, { color: theme.colors.textSecondary }]}>活跃冲突：{Object.values(mainline.activeConflicts).map(item => [item.title, item.state, item.stakes ? '代价：' + item.stakes : ''].filter(Boolean).join('｜')).join('、') || '无'}</Text>
            </>
          ) : null}
        </Card>
        <Card>
          <Button label={`未解决线索（${openThreads.length}） ${expandedSections.openThreads ? '⌄' : '>'}`} variant="secondary" onPress={() => toggleSection('openThreads')} />
          {expandedSections.openThreads ? (openThreads.length ? openThreads.map(item => <Text key={item.id} style={[styles.item, { color: theme.colors.textSecondary }]}>• {item.title}｜{item.description || '暂无说明'}</Text>) : <Text style={[styles.item, { color: theme.colors.textSecondary }]}>无</Text>) : null}
        </Card>
        <Card>
          <Button label={`未兑现伏笔（${unpaidForeshadowing.length}） ${expandedSections.foreshadowing ? '⌄' : '>'}`} variant="secondary" onPress={() => toggleSection('foreshadowing')} />
          {expandedSections.foreshadowing ? (unpaidForeshadowing.length ? unpaidForeshadowing.map(item => <Text key={item.id} style={[styles.item, { color: theme.colors.textSecondary }]}>• {[item.setup, item.expectedPayoff].filter(Boolean).join(' → ')}</Text>) : <Text style={[styles.item, { color: theme.colors.textSecondary }]}>无</Text>) : null}
        </Card>
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 100, gap: spacing.md },
  title: { fontSize: 16, fontWeight: '800', marginBottom: spacing.sm },
  latest: { fontSize: 14, fontWeight: '800', marginTop: spacing.sm },
  meta: { fontSize: 12, lineHeight: 20 },
  item: { fontSize: 13, lineHeight: 21, marginBottom: spacing.xs },
  diagnostic: { fontSize: 12, lineHeight: 20, marginBottom: spacing.sm },
  error: { color: '#dc2626', fontSize: 12, marginTop: spacing.sm },
  actions: { gap: spacing.sm, marginTop: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  intervalInput: { minWidth: 48, minHeight: 44, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, textAlign: 'center' },
  progressTrack: { height: 8, borderRadius: 4, overflow: 'hidden', marginVertical: spacing.sm },
  progressFill: { height: 8, borderRadius: 4 },
});

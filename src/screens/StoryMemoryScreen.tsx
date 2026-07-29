import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
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
  predictNextCheckpointPosition,
} from '../services/storyMemory/storyMemoryPolicy';
import {
  rebuildStoryMemory,
  type StoryMemoryRebuildProgress,
} from '../services/storyMemory/storyMemoryRebuild';
import type {
  StoryMemoryPolicy,
  StoryMemoryState,
  StoryMemoryUpdateMode,
} from '../services/storyMemory/storyMemoryTypes';
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

/** User-visible chapter label; continues from source boundary for continuation (Spec §11.3). */
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

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function characterName(state: StoryMemoryState, characterId: string): string {
  const character = state.characters[characterId];
  if (character?.canonicalName) return character.canonicalName;
  return `未知人物（${shortId(characterId)}）`;
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
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<StoryMemoryRebuildProgress | null>(
    null,
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [intervalText, setIntervalText] = useState('3');
  const [displayOf, setDisplayOf] = useState<
    ((position: number) => number) | null
  >(null);
  const controllerRef = useRef<AbortController | null>(null);

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
      chapters.filter(chapter => Boolean(chapter.content?.trim())),
      record.state.throughChapterPosition,
    );
    // Spec §11.3: user-visible chapter numbers continue from the source boundary.
    let nextDisplayOf: ((position: number) => number) | null = null;
    try {
      const numbering = await getContinuationChapterNumbering(currentProject.id);
      nextDisplayOf = position =>
        numbering.getDisplayNumber(position as ContinuationChapterPosition);
    } catch {
      nextDisplayOf = position => position + 1;
    }
    setDisplayOf(() => nextDisplayOf);
    setState(record.state);
    setPolicy(nextPolicy);
    setIntervalText(String(nextPolicy.intervalChapters));
    setPendingCount(pending.length);
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
    return () => controllerRef.current?.abort();
  }, [load]);

  const nextTrigger = useMemo(() => {
    if (!policy || !state) return '—';
    if (policy.mode === 'manual') return '仅手动或覆盖不足时';
    const next = predictNextCheckpointPosition(
      policy,
      state.throughChapterPosition,
      pendingCount,
    );
    // predictNextCheckpointPosition returns a display-ish 1-based schedule mark
    // based on internal position math; map via numbering when available.
    if (next == null) return '—';
    // next is already a 1-based "after chapter N finalize" using internal+1 semantics.
    // Convert back to 0-based position then re-label for continuation boundary.
    const internalPos = next - 1;
    return `${chapterLabel(displayOf, internalPos)}定稿后`;
  }, [policy, state, pendingCount, displayOf]);

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

  const runRebuild = useCallback(
    async (mode: 'auto' | 'full' | 'legacy_bootstrap', clearFirst = false) => {
      if (!currentProject || controllerRef.current) return;
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        if (clearFirst) await db.clearStoryMemory(currentProject.id);
        const result = await rebuildStoryMemory(currentProject.id, {
          mode,
          signal: controller.signal,
          onProgress: setProgress,
        });
        setState(result.state);
        Toast.show({ type: 'success', text1: '故事记忆已重建完成' });
        await load();
      } catch (error: any) {
        if (error?.code !== 'MEMORY_REBUILD_CANCELLED') {
          Toast.show({
            type: 'error',
            text1: '故事记忆重建失败',
            text2: error?.message,
          });
        }
        await load();
      } finally {
        controllerRef.current = null;
        setProgress(null);
      }
    },
    [currentProject, load],
  );

  const runCheckpointNow = useCallback(async () => {
    if (!currentProject || controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const record = await db.ensureProjectStoryMemoryRow(currentProject.id);
      if (record.status === 'dirty') {
        const rebuilt = await rebuildStoryMemory(currentProject.id, {
          mode: 'auto',
          signal: controller.signal,
          onProgress: setProgress,
        });
        setState(rebuilt.state);
        Toast.show({
          type: 'success',
          text1: `长期记忆已从变更位置重建到${chapterLabel(
            displayOf,
            rebuilt.state.throughChapterPosition,
          )}`,
        });
        await load();
        return;
      }
      const { withProjectMemoryLock } = await import(
        '../services/storyMemory/storyMemoryService'
      );
      const { advanceStoryMemoryCheckpointsUnlocked } = await import(
        '../services/storyMemory/storyMemoryCheckpointService'
      );
      const result = await withProjectMemoryLock(currentProject.id, () =>
        advanceStoryMemoryCheckpointsUnlocked({
          projectId: currentProject.id,
          signal: controller.signal,
        }),
      );
      setState(result.state);
      Toast.show({
        type: 'success',
        text1:
          result.batchesApplied > 0
            ? `长期记忆已整理到${chapterLabel(
                displayOf,
                result.state.throughChapterPosition,
              )}`
            : '没有待整理章节',
      });
      await load();
    } catch (error: any) {
      if (error?.code !== 'MEMORY_CHECKPOINT_CANCELLED') {
        Toast.show({
          type: 'error',
          text1: '长期记忆整理失败',
          text2: error?.message,
        });
      }
      await load();
    } finally {
      controllerRef.current = null;
      setProgress(null);
    }
  }, [currentProject, load, displayOf]);

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
            onClose ? (
              <Button label="关闭" variant="ghost" onPress={onClose} />
            ) : undefined
          }
        />
        <EmptyState title="请先选择小说项目" />
      </Screen>
    );
  }

  const characters = Object.values(state.characters);
  const relationships = Object.values(state.relationships);
  const mainline = state.mainline;
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
  const showClosedMainlineNotice = mainlineIsEmpty && hasMainlineHistory;
  const showLegacyBootstrap =
    state.metadata.status === 'empty' ||
    state.metadata.source === 'legacy_bootstrap';

  return (
    <Screen>
      <Header
        title="故事记忆"
        subtitle={currentProject.name}
        action={
          onClose ? (
            <Button label="关闭" variant="ghost" onPress={onClose} />
          ) : undefined
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Text
            style={[styles.title, { color: theme.colors.textPrimary }]}
            accessibilityRole="header"
          >
            长期记忆：
            {STATUS_LABEL[state.metadata.status] || state.metadata.status}
          </Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
            已整理到：
            {state.throughChapterPosition >= 0
              ? chapterLabel(displayOf, state.throughChapterPosition)
              : '无'}
          </Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
            待整理：{pendingRange}
          </Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
            更新方式：{describeStoryMemoryPolicy(policy)}
          </Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
            预计下次：{nextTrigger}
          </Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
            上下文覆盖：
            {state.metadata.status === 'dirty'
              ? '需重新整理'
              : pendingCount > 0
              ? '由近期正文桥接'
              : '完整'}
          </Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
            需要重新整理的位置：
            {state.metadata.dirtyFromPosition == null
              ? '无'
              : chapterLabel(displayOf, state.metadata.dirtyFromPosition)}
          </Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
            整理来源：
            {state.metadata.source === 'legacy_bootstrap'
              ? '旧摘要快速初始化'
              : '章节正文'}
          </Text>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
            更新时间：{formatLocalTime(state.metadata.updatedAt)}
          </Text>
          {state.metadata.lastError ? (
            <Text style={styles.error}>
              最近错误：{state.metadata.lastError}
            </Text>
          ) : null}
        </Card>

        <Card>
          <Text style={[styles.section, { color: theme.colors.textPrimary }]}>
            更新策略
          </Text>
          {MODE_OPTIONS.map(option => (
            <Button
              key={option.mode}
              label={`${policy.mode === option.mode ? '● ' : '○ '}${
                option.label
              }`}
              variant={policy.mode === option.mode ? 'primary' : 'secondary'}
              onPress={() => savePolicy({ mode: option.mode })}
            />
          ))}
          {(policy.mode === 'smart' || policy.mode === 'fixed') && (
            <View style={styles.row}>
              <Text
                style={[styles.meta, { color: theme.colors.textSecondary }]}
              >
                固定间隔：每
              </Text>
              <TextInput
                value={intervalText}
                onChangeText={setIntervalText}
                onEndEditing={() => {
                  const n = Number(intervalText);
                  if (Number.isFinite(n)) {
                    savePolicy({ intervalChapters: n }).catch(() => {});
                  }
                }}
                keyboardType="number-pad"
                style={[
                  styles.intervalInput,
                  {
                    color: theme.colors.textPrimary,
                    borderColor: theme.colors.border,
                  },
                ]}
                accessibilityLabel="检查点间隔章节数"
              />
              <Text
                style={[styles.meta, { color: theme.colors.textSecondary }]}
              >
                章
              </Text>
            </View>
          )}
        </Card>

        {progress ? (
          <Card>
            <Text
              style={[styles.title, { color: theme.colors.textPrimary }]}
              accessibilityLiveRegion="polite"
            >
              重建进度 {progress.completedChapters}/{progress.totalChapters}
            </Text>
            <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
              复用 {progress.reusedPatches} · 重新生成{' '}
              {progress.regeneratedPatches}
            </Text>
            <Button
              label="取消重建"
              variant="secondary"
              onPress={() => controllerRef.current?.abort()}
            />
          </Card>
        ) : null}

        <View style={styles.actions}>
          <Button label="立即整理长期记忆" onPress={runCheckpointNow} />
          <Button
            label={showAdvanced ? '收起高级操作' : '高级操作'}
            variant="secondary"
            onPress={() => setShowAdvanced(value => !value)}
          />
          {showAdvanced ? (
            <>
              <Button
                label="从上次失败处继续"
                variant="secondary"
                onPress={() => runRebuild('auto')}
              />
              <Button
                label="从有效检查点重建"
                variant="secondary"
                onPress={() => runRebuild('auto')}
              />
              {showLegacyBootstrap ? (
                <Button
                  label="快速初始化"
                  variant="secondary"
                  onPress={() => runRebuild('legacy_bootstrap')}
                />
              ) : null}
              <Button
                label="清空并重建"
                variant="danger"
                onPress={() =>
                  Alert.alert(
                    '清空并重建',
                    '将删除现有结构化记忆并从正文重建，章节正文不会删除。',
                    [
                      { text: '取消', style: 'cancel' },
                      {
                        text: '继续',
                        style: 'destructive',
                        onPress: () => runRebuild('full', true),
                      },
                    ],
                  )
                }
              />
            </>
          ) : null}
        </View>

        <Card>
          <Text style={[styles.section, { color: theme.colors.textPrimary }]}>
            登场人物（{characters.length}）
          </Text>
          {characters.length ? (
            characters.map(item => (
              <Text
                key={item.id}
                style={[styles.item, { color: theme.colors.textSecondary }]}
              >
                • {item.canonicalName}｜{item.role || '身份未知'}｜
                {item.currentState.location || '位置未知'}｜目标：
                {item.currentState.currentGoal || '无'}｜
                {item.status === 'active' ? '活跃' : item.status}
              </Text>
            ))
          ) : (
            <Text style={[styles.item, { color: theme.colors.textSecondary }]}>
              无
            </Text>
          )}
        </Card>
        <Card>
          <Text style={[styles.section, { color: theme.colors.textPrimary }]}>
            人物关系（{relationships.length}）
          </Text>
          {relationships.length ? (
            relationships.map(item => (
              <Text
                key={item.id}
                style={[styles.item, { color: theme.colors.textSecondary }]}
              >
                • {characterName(state, item.fromCharacterId)}{' '}
                {item.direction === 'bidirectional' ? '↔' : '→'}{' '}
                {characterName(state, item.toCharacterId)}｜{item.relationType}
                ｜{item.currentState}
              </Text>
            ))
          ) : (
            <Text style={[styles.item, { color: theme.colors.textSecondary }]}>
              无
            </Text>
          )}
        </Card>
        <Card>
          <Text style={[styles.section, { color: theme.colors.textPrimary }]}>
            故事主线
          </Text>
          {showUnrecognizedMainlineDiagnostic ? (
            <Text style={[styles.diagnostic, { color: theme.colors.warning }]}>
              已完成多章长期记忆整理，但尚未识别到有效故事主线。若正文包含持续目标、冲突或悬念，可在高级操作中清空并重建。
            </Text>
          ) : null}
          {showClosedMainlineNotice ? (
            <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
              当前没有活跃主线事项，最近主线节点已闭合。
            </Text>
          ) : null}
          <Text style={[styles.item, { color: theme.colors.textSecondary }]}>
            剧情弧：
            {mainline.currentArc
              ? [mainline.currentArc.name, mainline.currentArc.summary]
                  .filter(Boolean)
                  .join('｜')
              : '无'}
          </Text>
          <Text style={[styles.item, { color: theme.colors.textSecondary }]}>
            当前目标：{mainline.currentObjective || '无'}
          </Text>
          <Text style={[styles.item, { color: theme.colors.textSecondary }]}>
            活跃冲突：
            {Object.values(mainline.activeConflicts)
              .map(item =>
                [
                  item.title,
                  item.state,
                  item.stakes ? '代价：' + item.stakes : '',
                ]
                  .filter(Boolean)
                  .join('｜'),
              )
              .join('、') || '无'}
          </Text>
          <Text style={[styles.item, { color: theme.colors.textSecondary }]}>
            未解决线索：
            {Object.values(mainline.openThreads)
              .map(item =>
                [item.title, item.description].filter(Boolean).join('｜'),
              )
              .join('、') || '无'}
          </Text>
          <Text style={[styles.item, { color: theme.colors.textSecondary }]}>
            未兑现伏笔：
            {unpaidForeshadowing
              .map(item =>
                [item.setup, item.expectedPayoff].filter(Boolean).join(' → '),
              )
              .join('、') || '无'}
          </Text>
        </Card>
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 100, gap: spacing.md },
  title: { fontSize: 16, fontWeight: '800', marginBottom: spacing.sm },
  section: { fontSize: 16, fontWeight: '800', marginBottom: spacing.sm },
  meta: { fontSize: 12, lineHeight: 20 },
  item: { fontSize: 13, lineHeight: 21, marginBottom: spacing.xs },
  diagnostic: { fontSize: 12, lineHeight: 20, marginBottom: spacing.sm },
  error: { color: '#dc2626', fontSize: 12, marginTop: spacing.sm },
  actions: { gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  intervalInput: {
    minWidth: 48,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    textAlign: 'center',
  },
});

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ArrowUp, Bot, Eye, FileText, Focus, History, Inbox, Square, Trash2, Volume2 } from 'lucide-react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import Toast from 'react-native-toast-message';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { cancelPipeline, runChapterPipeline } from '../services/pipelineRunner';
import { suppressGlobalPipelinePrompt } from '../navigation/pipelinePromptSuppression';
import { Button, Field, Header, Screen, spacing } from '../components/ui';
import { PipelineProgress } from '../components/PipelineProgress';
import { useThemeStore } from '../store/themeStore';
import { useVoiceStore } from '../store/voiceStore';
import { debounce } from '../utils/debounce';
import { estimateTokens } from '../utils/tokenEstimator';
import * as db from '../services/database';
import { createRevision } from '../services/revisionService';
import { generateMemorySummary } from '../services/summaryGenerator';
import type { Chapter } from '../types/novel';
import type { PipelineStageName, PipelineTask, PipelineTaskStatus } from '../types/pipeline';

type SaveStatus = 'saved' | 'saving' | 'failed';
type RunningPipelineStatus = Extract<PipelineTaskStatus, 'idle' | 'drafting' | 'reviewing' | 'proofing'>;

const RUNNING_PIPELINE_STATUSES: RunningPipelineStatus[] = ['idle', 'drafting', 'reviewing', 'proofing'];

function isRunningPipelineStatus(status: PipelineTaskStatus): status is RunningPipelineStatus {
  return RUNNING_PIPELINE_STATUSES.includes(status as RunningPipelineStatus);
}

function stageFromTaskStatus(status: RunningPipelineStatus): PipelineStageName | 'idle' {
  if (status === 'drafting') return 'draft';
  if (status === 'reviewing') return 'review';
  if (status === 'proofing') return 'proof';
  return 'idle';
}

interface Props {
  chapterId: number;
  onClose: () => void;
}

export const ChapterEditor: React.FC<Props> = ({ chapterId, onClose }) => {
  const { theme } = useThemeStore();
  const { isSynthesizing, isPlaying, loadVoiceConfig, playChapter, stop } = useVoiceStore();
  const navigation = useNavigation();
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [generating, setGenerating] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  // Phase9-BUG#2: 清空正文时的进行中状态，避免重复点击
  const [clearing, setClearing] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [currentStage, setCurrentStage] = useState<PipelineStageName | 'idle'>('idle');
  const [progressStartedAt, setProgressStartedAt] = useState(Date.now());
  const [progressVisible, setProgressVisible] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  // Tracks the most recent taskId whose result screen we have surfaced, so a
  // redundant store update does not navigate to the same result twice.
  const resultTaskIdRef = useRef<string | null>(null);
  // 每个终态 taskId 在本屏只触发一次 Alert/跳转，避免切屏期间 failTask
  // 触发的 subscribe 与全局 PipelineResultPrompt Modal 双弹。
  const seenTerminalRef = useRef<Set<string>>(new Set());
  // Accumulate field edits across multiple changeField calls within one debounce
  // window. Without this, a fast title+synopsis edit would overwrite the pending
  // args and lose one of the edits (debounce only keeps the latest call's args).
  const pendingFieldsRef = useRef<Partial<Chapter>>({});
  const pendingChapterIdRef = useRef<number | null>(null);
  const autoSaveRef = useRef(
    debounce(async () => {
      // Snapshot and clear the accumulator under the debounce callback so any
      // edits queued during the DB write land in the next window.
      const id = pendingChapterIdRef.current;
      const fields = pendingFieldsRef.current;
      pendingFieldsRef.current = {};
      if (id == null) return;
      try {
        await db.updateChapter(id, fields);
        setSaveStatus('saved');
      } catch {
        // Restore the failed fields so a later flush can retry them.
        pendingFieldsRef.current = { ...fields, ...pendingFieldsRef.current };
        setSaveStatus('failed');
      }
    }, 900),
  );

  const loadChapter = useCallback(async () => {
    // Phase9-BUG#1: 包裹 try-catch，DB 异常时不再产生 unhandled rejection 导致白屏
    try {
      setChapter(await db.getChapterById(chapterId));
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
    }
  }, [chapterId]);

  const openPipelineResult = useCallback((taskId: string) => {
    if (taskId === resultTaskIdRef.current) return;
    resultTaskIdRef.current = taskId;
    setProgressVisible(false);
    setGenerating(false);
    // @ts-ignore
    navigation.navigate('PipelineResult', { taskId });
  }, [navigation]);

  const attachRunningPipelineTask = useCallback((task: PipelineTask) => {
    if (!isRunningPipelineStatus(task.status)) return;
    setCurrentStage(stageFromTaskStatus(task.status));
    setProgressStartedAt(task.updatedAt || task.createdAt);
    setProgressVisible(true);
    setGenerating(true);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadChapter();
    }, [loadChapter]),
  );

  // Flush on background/inactive
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        autoSaveRef.current.flush().catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  // Cleanup: flush instead of cancel
  useEffect(() => {
    const autoSave = autoSaveRef.current;
    return () => { autoSave.flush().catch(() => {}); };
  }, []);

  useEffect(() => {
    loadVoiceConfig();
  }, [loadVoiceConfig]);

  useEffect(() => {
    return () => { stop().catch(() => {}); };
  }, [stop]);

  // Subscribe to the pipeline store for this chapter. If a task started on
  // this screen is still running in the background (e.g. the user navigated
  // away and came back), surface its current state in the progress bar and
  // auto-open the result screen the moment it transitions to completed. This
  // mirrors the global prompt in src/main/index.tsx, scoped to tasks that
  // belong to the chapter the user is currently editing.
  const [, setTrackedTaskId] = useState<string | null>(null);
  useEffect(() => {
    if (!chapter) return;
    const findTask = () => usePipelineTaskStore.getState().tasks.find(
      (t) => t.targetType === 'chapter' && t.targetId === chapter.id && t.resolvedAt === null
        && (t.status === 'idle' || t.status === 'drafting' || t.status === 'reviewing' || t.status === 'proofing'
          || t.status === 'completed' || t.status === 'failed'),
    );
    const handleTerminal = (t: { id: string; status: string; error?: string | null }) => {
      if (t.id === resultTaskIdRef.current) return;
      if (seenTerminalRef.current.has(t.id)) return;
      seenTerminalRef.current.add(t.id);
      if (t.status === 'completed') {
        openPipelineResult(t.id);
      } else if (t.status === 'failed') {
        resultTaskIdRef.current = t.id;
        setProgressVisible(false);
        setGenerating(false);
        // 失败提示交给全局 PipelineResultPrompt Modal 统一展示，避免双重弹窗
      }
    };
    const initial = findTask();
    if (initial) {
      setTrackedTaskId(initial.id);
      attachRunningPipelineTask(initial);
      // If the task finished while we were off-screen, open the result
      // screen immediately. This is the key UX fix: returning to the
      // chapter editor after a background pipeline should feel the same
      // as staying on the screen throughout the run.
      if (initial.status === 'completed' || initial.status === 'failed') {
        handleTerminal(initial as any);
      }
    }
    const unsubscribe = usePipelineTaskStore.subscribe((state, prevState) => {
      if (state.tasks === prevState.tasks) return;
      const tasks = state.tasks;
      const t = tasks.find(
        (task) => task.targetType === 'chapter' && task.targetId === chapterId
          && (task.status === 'idle' || task.status === 'drafting' || task.status === 'reviewing'
            || task.status === 'proofing' || task.status === 'completed' || task.status === 'failed')
          && task.resolvedAt === null,
      );
      if (t) {
        setTrackedTaskId((prev) => (prev === t.id ? prev : t.id));
        attachRunningPipelineTask(t);
        handleTerminal(t as any);
      }
    });
    return unsubscribe;
  }, [attachRunningPipelineTask, chapter, chapterId, openPipelineResult]);

  // Intercept hardware back / swipe-back so pending edits are flushed before
  // leaving the screen. The default goBack() does not trigger flushAndClose.
  // We only prevent the default when there is unsaved content; otherwise we
  // let navigation proceed immediately to avoid blocking the user.
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e: any) => {
      if (!autoSaveRef.current.pending()) return;
      // Defer flush then resume navigation. We do not surface a modal here
      // (the hardware back button has no UI to host one reliably). flush 失败
      // 时不能继续离开，否则会静默丢失未保存内容；改为只在成功时 dispatch。
      e.preventDefault();
      autoSaveRef.current.flush()
        .then(() => {
          navigation.dispatch(e.data.action);
        })
        .catch(() => {
          setSaveStatus('failed');
          Toast.show({
            type: 'error',
            text1: '保存失败',
            text2: '请手动复制未保存内容',
          });
        });
    });
    return unsubscribe;
  }, [navigation]);

  const changeField = (field: keyof Chapter, value: string) => {
    if (!chapter) return;
    const next = { ...chapter, [field]: value };
    setChapter(next);
    setSaveStatus('saving');
    pendingFieldsRef.current = { ...pendingFieldsRef.current, [field]: value };
    pendingChapterIdRef.current = chapter.id;
    autoSaveRef.current.call();
  };

  const flushAndClose = async () => {
    // Nothing pending → safe to close immediately, skipping the debounce flush
    // to avoid a redundant (and potentially failing) DB write.
    if (!autoSaveRef.current.pending()) {
      onClose();
      return;
    }
    try {
      await autoSaveRef.current.flush();
      onClose();
    } catch {
      setSaveStatus('failed');
      Alert.alert('保存失败', '内容尚未保存，是否仍然退出？', [
        // Retry only the flush (not the whole close flow) so a persistently
        // failing DB write does not recurse indefinitely. If flush keeps
        // failing the user can still choose to discard.
        { text: '重试保存', onPress: () => { flushAndClose(); } },
        { text: '仍然退出', style: 'destructive', onPress: onClose },
      ]);
    }
  };

  const saveLabel = saveStatus === 'saved' ? '已保存' : saveStatus === 'saving' ? '保存中...' : '保存失败';

  const finalizeChapter = async () => {
    if (!chapter || finalizing) return;
    setFinalizing(true);
    try {
      // 先 flush 自动保存队列中尚未落盘的编辑，避免后续 loadChapter 用 DB
      // 旧值覆盖内存最新值（pending 的 title/synopsis/content 会丢失）。
      await autoSaveRef.current?.flush();
      await db.updateChapter(chapter.id, {
        title: chapter.title,
        synopsis: chapter.synopsis,
        content: chapter.content,
      });
      setSaveStatus('saved');
      const memorySummary = await generateMemorySummary(chapter.id, 200);
      await db.updateChapter(chapter.id, {
        memory_summary: memorySummary,
        memory_summary_tokens: estimateTokens(memorySummary),
      });
      await loadChapter();
    } catch (error: any) {
      // The chapter body was already saved above; only the memory summary
      // failed. Leave saveStatus as-is (saved) but surface the summary error.
      Alert.alert('摘要生成失败', error?.message || '章节已保存，但自动记忆摘要生成失败。');
    } finally {
      setFinalizing(false);
    }
  };

  const clearContent = () => {
    if (!chapter || clearing) return;
    Alert.alert('清空正文', '确定要清空当前章节的全部正文内容？', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: async () => {
          // Phase9-BUG#2: 包裹 try-catch + Toast + clearing 状态，避免清空失败时静默无反馈
          setClearing(true);
          try {
            await createRevision({
              projectId: chapter.project_id,
              targetType: 'chapter',
              targetId: chapter.id,
              title: chapter.title,
              content: chapter.content,
              source: 'before_clear',
            });
            await db.updateChapter(chapter.id, { content: '' });
            await loadChapter();
            setSaveStatus('saved');
          } catch (e: any) {
            Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
          } finally {
            setClearing(false);
          }
        },
      },
    ]);
  };

  const manualCheckpoint = async () => {
    if (!chapter) return;
    // Phase9-BUG#3: 包裹 try-catch，失败时不弹"版本已保存"误导用户
    try {
      await createRevision({
        projectId: chapter.project_id,
        targetType: 'chapter',
        targetId: chapter.id,
        title: chapter.title,
        content: chapter.content,
        source: 'manual_checkpoint',
      });
      Alert.alert('版本已保存', '当前内容已保存为手动版本快照。');
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
    }
  };

  const toggleTts = async () => {
    if (!chapter) return;
    // Phase9-BUG#4: 包裹 try-catch + Toast，朗读启停失败时给用户反馈
    try {
      if (isSynthesizing || isPlaying) {
        await stop();
        return;
      }
      await playChapter(chapter.content);
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '操作失败', text2: e?.message });
    }
  };

  const runPipeline = async () => {
    if (!chapter) return;

    const { createTask, getActiveTaskForTarget } = usePipelineTaskStore.getState();
    const existing = getActiveTaskForTarget('chapter', chapter.id);
    if (existing) {
      Alert.alert('已有进行中的流水线', '请等待当前任务完成或到任务中心取消。');
      return;
    }

    if (chapter.content.trim()) {
      Alert.alert('覆盖正文', '当前章节已有正文内容，流水线生成将覆盖现有正文。确定继续？', [
        { text: '取消', style: 'cancel' },
        {
          text: '覆盖并生成',
          onPress: () => executeRunPipeline(createTask),
        },
      ]);
    } else {
      executeRunPipeline(createTask);
    }
  };

  const executeRunPipeline = async (createTask: (targetType: 'chapter' | 'freeform', targetId: number) => string) => {
    if (!chapter) return;
    setGenerating(true);
    setProgressVisible(true);
    const taskId = createTask('chapter', chapter.id);
    suppressGlobalPipelinePrompt(taskId);
    try {
      await runChapterPipeline(taskId, chapter, (info) => {
        if (typeof info === 'object') {
          setCurrentStage(info.stage);
          setProgressStartedAt(info.startedAt);
        }
      });
      setProgressVisible(false);
      const store = usePipelineTaskStore.getState();
      const finishedTask = store.tasks.find((t) => t.id === taskId);
      if (finishedTask?.status === 'completed') {
        openPipelineResult(taskId);
      } else if (finishedTask?.status === 'failed') {
        resultTaskIdRef.current = taskId;
        Alert.alert('流水线失败', finishedTask.error || '未知错误');
      }
    } catch (error: any) {
      setProgressVisible(false);
      Alert.alert('流水线异常', error.message || '请检查 API 配置。');
    } finally {
      setGenerating(false);
    }
  };

  const stopPipeline = () => {
    // 立即重置 UI 状态，避免用户点完按钮还要等 fetch 超时
    setGenerating(false);
    setProgressVisible(false);
    // 找到当前章节正在跑的 taskId，通知 runner 立即 abort fetch
    const runningTask = usePipelineTaskStore
      .getState()
      .tasks.find(
        (t) =>
          t.targetType === 'chapter' &&
          t.targetId === chapterId &&
          (t.status === 'idle' || t.status === 'drafting' || t.status === 'reviewing' || t.status === 'proofing') &&
          t.resolvedAt === null,
      );
    if (runningTask) {
      cancelPipeline(runningTask.id);
    }
  };

  // 性能优化：memoize token 估算，避免每次渲染都重新计算
  const content = chapter?.content || '';
  const estimatedTokenCount = useMemo(
    () => estimateTokens(content),
    [content],
  );

  if (!chapter) {
    return (
      <Screen>
        <Header title="章节编辑" action={<Button label="返回" variant="ghost" onPress={onClose} />} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title={focusMode ? '专注模式' : '章节编辑'} subtitle={saveLabel} action={
        <View style={styles.headerActions}>
          <Button label={focusMode ? '退出' : '专注'} icon={Focus} variant="ghost" onPress={() => setFocusMode(!focusMode)} compact />
          <Button label="返回" variant="ghost" onPress={flushAndClose} compact />
        </View>
      } />
      {progressVisible && !focusMode && (
        <PipelineProgress
          stage={currentStage}
          startedAt={progressStartedAt}
          visible={progressVisible}
        />
      )}
      <ScrollView ref={scrollRef} contentContainerStyle={styles.content}>
        {!focusMode && (
          <>
            <Field label="章节标题" value={chapter.title} onChangeText={(value) => changeField('title', value)} placeholder="章节标题" />
            <Field
              label="章节概要"
              value={chapter.synopsis}
              onChangeText={(value) => changeField('synopsis', value)}
              placeholder="写下本章目标、冲突和结尾"
              multiline
              inputStyle={styles.synopsis}
            />
          </>
        )}
        {!focusMode && (
        <View style={styles.toolbar}>
          <ScrollView
            testID="chapter-toolbar-scroll"
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.toolbarRow}
          >
            <Button
              label={generating ? '续写中…' : '续写'}
              icon={Bot}
              onPress={runPipeline}
              disabled={generating || finalizing}
              compact
              minWidth={72}
            />
            {generating && (
              <Button
                label="停止"
                icon={Square}
                variant="secondary"
                onPress={stopPipeline}
                compact
                minWidth={72}
              />
            )}
            <Button
              label={finalizing ? '定稿中…' : '定稿'}
              icon={FileText}
              variant="secondary"
              onPress={finalizeChapter}
              disabled={finalizing || generating}
              compact
              minWidth={72}
            />
            <Button
              label="版本"
              icon={History}
              variant="secondary"
              onPress={manualCheckpoint}
              compact
              minWidth={72}
            />
            <Button
              label={clearing ? '清空中…' : '清空'}
              icon={Trash2}
              variant="ghost"
              onPress={clearContent}
              disabled={generating || finalizing || clearing}
              compact
              minWidth={72}
            />
            <Button
              label="摘要"
              icon={FileText}
              variant="ghost"
              onPress={() => Alert.alert('章节摘要', chapter.memory_summary || '暂无记忆摘要。')}
              compact
              minWidth={72}
            />
            <Button
              label="历史"
              icon={History}
              variant="ghost"
              onPress={() => {
                // @ts-ignore
                navigation.navigate('RevisionHistory', { targetType: 'chapter', targetId: chapter.id, projectId: chapter.project_id });
              }}
              compact
              minWidth={72}
            />
            <Button
              label={isSynthesizing ? '生成中…' : isPlaying ? '停止' : '朗读'}
              icon={isPlaying ? Square : Volume2}
              variant={isPlaying ? 'secondary' : 'ghost'}
              onPress={toggleTts}
              disabled={!chapter.content.trim() && !isSynthesizing && !isPlaying}
              compact
              minWidth={72}
            />
            <Button
              label="上下文"
              icon={Eye}
              variant="ghost"
              onPress={() => {
                // @ts-ignore
                navigation.navigate('ContextPreview', { chapterId: chapter.id });
              }}
              compact
              minWidth={72}
            />
            <Button
              label="草稿"
              icon={Inbox}
              variant="ghost"
              onPress={() => {
                // @ts-ignore
                navigation.navigate('DraftPreview', { targetType: 'chapter', targetId: chapter.id, projectId: chapter.project_id });
              }}
              compact
              minWidth={72}
            />
          </ScrollView>
        </View>
        )}
        <Field label="正文" value={chapter.content} onChangeText={(value) => changeField('content', value)} placeholder="开始写作..." multiline inputStyle={focusMode ? styles.focusEditor : styles.editor} />
        {chapter.memory_summary ? (
          <View style={[styles.summaryBox, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}>
            <Text style={[styles.summaryTitle, { color: theme.colors.textPrimary }]}>记忆摘要</Text>
            <Text style={[styles.summaryText, { color: theme.colors.textSecondary }]}>{chapter.memory_summary}</Text>
          </View>
        ) : null}
        <View style={styles.footer}>
          <Text style={[styles.footerText, { color: theme.colors.textSecondary }]}>
            {chapter.content.length} 字 · 预估 {estimatedTokenCount} tokens · {saveLabel}
          </Text>
        </View>
        <Button
          label="回到顶部"
          icon={ArrowUp}
          variant="secondary"
          onPress={() => scrollRef.current?.scrollTo({ y: 0, animated: true })}
        />
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 120 },
  synopsis: { minHeight: 76, textAlignVertical: 'top' },
  toolbar: { marginVertical: spacing.lg },
  toolbarRow: { flexDirection: 'row', gap: spacing.sm, paddingRight: spacing.lg },
  editor: { minHeight: 420, textAlignVertical: 'top', fontSize: 16, lineHeight: 25 },
  focusEditor: { minHeight: 600, textAlignVertical: 'top', fontSize: 18, lineHeight: 30 },
  headerActions: { flexDirection: 'row', gap: spacing.xs },
  footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  footerText: { flex: 1, fontSize: 12, fontWeight: '700' },
  summaryBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: spacing.md, marginBottom: spacing.md },
  summaryTitle: { fontSize: 14, fontWeight: '800', marginBottom: spacing.xs },
  summaryText: { fontSize: 13, lineHeight: 20 },
});

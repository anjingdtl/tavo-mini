import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ArrowUp, Bot, Eye, FileText, Focus, History, Inbox, Trash2 } from 'lucide-react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { runChapterPipeline } from '../services/pipelineRunner';
import { Button, Field, Header, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { debounce } from '../utils/debounce';
import { estimateTokens } from '../utils/tokenEstimator';
import * as db from '../services/database';
import { createRevision } from '../services/revisionService';
import { generateMemorySummary } from '../services/summaryGenerator';
import type { Chapter } from '../types/novel';

type SaveStatus = 'saved' | 'saving' | 'failed';

interface Props {
  chapterId: number;
  onClose: () => void;
}

export const ChapterEditor: React.FC<Props> = ({ chapterId, onClose }) => {
  const { theme } = useThemeStore();
  const navigation = useNavigation();
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [generating, setGenerating] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
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
    setChapter(await db.getChapterById(chapterId));
  }, [chapterId]);

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

  // Intercept hardware back / swipe-back so pending edits are flushed before
  // leaving the screen. The default goBack() does not trigger flushAndClose.
  // We only prevent the default when there is unsaved content; otherwise we
  // let navigation proceed immediately to avoid blocking the user.
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e: any) => {
      if (!autoSaveRef.current.pending()) return;
      // Defer flush then resume navigation. We do not surface a modal here
      // (the hardware back button has no UI to host one reliably); a failed
      // flush is swallowed so the user is never trapped on the screen.
      e.preventDefault();
      autoSaveRef.current.flush().catch(() => {}).finally(() => {
        navigation.dispatch(e.data.action);
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
    if (!chapter) return;
    Alert.alert('清空正文', '确定要清空当前章节的全部正文内容？', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: async () => {
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
        },
      },
    ]);
  };

  const manualCheckpoint = async () => {
    if (!chapter) return;
    await createRevision({
      projectId: chapter.project_id,
      targetType: 'chapter',
      targetId: chapter.id,
      title: chapter.title,
      content: chapter.content,
      source: 'manual_checkpoint',
    });
    Alert.alert('版本已保存', '当前内容已保存为手动版本快照。');
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
    const taskId = createTask('chapter', chapter.id);
    try {
      await runChapterPipeline(taskId, chapter, () => {});
      const store = usePipelineTaskStore.getState();
      const finishedTask = store.tasks.find((t) => t.id === taskId);
      if (finishedTask?.status === 'completed') {
        // @ts-ignore
        navigation.navigate('PipelineResult', { taskId });
      } else if (finishedTask?.status === 'failed') {
        Alert.alert('流水线失败', finishedTask.error || '未知错误');
      }
    } catch (error: any) {
      Alert.alert('流水线异常', error.message || '请检查 API 配置。');
    } finally {
      setGenerating(false);
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
          <Button label={generating ? '生成中...' : 'AI 续写'} icon={Bot} onPress={runPipeline} disabled={generating || finalizing} compact flex />
          <Button label={finalizing ? '定稿中...' : '保存定稿'} icon={FileText} variant="secondary" onPress={finalizeChapter} disabled={finalizing || generating} compact flex />
          <Button label="摘要" icon={FileText} variant="secondary" onPress={() => Alert.alert('章节摘要', chapter.memory_summary || '暂无记忆摘要。')} compact flex />
          <Button label="版本" icon={History} variant="secondary" onPress={manualCheckpoint} compact flex />
          <Button label="历史" icon={History} variant="ghost" onPress={() => {
            // @ts-ignore
            navigation.navigate('RevisionHistory', { targetType: 'chapter', targetId: chapter.id, projectId: chapter.project_id });
          }} compact flex />
          <Button label="上下文" icon={Eye} variant="ghost" onPress={() => {
            // @ts-ignore
            navigation.navigate('ContextPreview', { chapterId: chapter.id });
          }} compact flex />
          <Button label="草稿" icon={Inbox} variant="ghost" onPress={() => {
            // @ts-ignore
            navigation.navigate('DraftPreview', { targetType: 'chapter', targetId: chapter.id, projectId: chapter.project_id });
          }} compact flex />
          <Button label="清空" icon={Trash2} variant="ghost" onPress={clearContent} disabled={generating || finalizing} compact flex />
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
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginVertical: spacing.lg },
  editor: { minHeight: 420, textAlignVertical: 'top', fontSize: 16, lineHeight: 25 },
  focusEditor: { minHeight: 600, textAlignVertical: 'top', fontSize: 18, lineHeight: 30 },
  headerActions: { flexDirection: 'row', gap: spacing.xs },
  footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  footerText: { flex: 1, fontSize: 12, fontWeight: '700' },
  summaryBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: spacing.md, marginBottom: spacing.md },
  summaryTitle: { fontSize: 14, fontWeight: '800', marginBottom: spacing.xs },
  summaryText: { fontSize: 13, lineHeight: 20 },
});

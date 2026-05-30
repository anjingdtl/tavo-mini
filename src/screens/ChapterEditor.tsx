import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ArrowUp, Bot, FileText, Trash2 } from 'lucide-react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { runChapterPipeline } from '../services/pipelineRunner';
import { Button, Field, Header, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { debounce } from '../utils/debounce';
import { estimateTokens } from '../utils/tokenEstimator';
import * as db from '../services/database';
import { generateMemorySummary } from '../services/summaryGenerator';
import type { Chapter } from '../types/novel';

interface Props {
  chapterId: number;
  onClose: () => void;
}

export const ChapterEditor: React.FC<Props> = ({ chapterId, onClose }) => {
  const { theme } = useThemeStore();
  const navigation = useNavigation();
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [saveState, setSaveState] = useState('已保存');
  const [generating, setGenerating] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const autoSaveRef = useRef(
    debounce(async (id: number, fields: Partial<Chapter>) => {
      await db.updateChapter(id, fields);
      setSaveState('已保存');
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

  useEffect(() => {
    const autoSave = autoSaveRef.current;
    return () => autoSave.cancel();
  }, []);

  const changeField = (field: keyof Chapter, value: string) => {
    if (!chapter) return;
    const next = { ...chapter, [field]: value };
    setChapter(next);
    setSaveState('保存中...');
    autoSaveRef.current.call(chapter.id, { [field]: value } as Partial<Chapter>);
  };

  const finalizeChapter = async () => {
    if (!chapter || finalizing) return;
    setFinalizing(true);
    try {
      await db.updateChapter(chapter.id, {
        title: chapter.title,
        synopsis: chapter.synopsis,
        content: chapter.content,
      } as any);
      setSaveState('已保存，正在生成摘要...');
      const memorySummary = await generateMemorySummary(chapter.id, 200);
      await db.updateChapter(chapter.id, {
        memory_summary: memorySummary,
        memory_summary_tokens: estimateTokens(memorySummary),
      } as any);
      await loadChapter();
      setSaveState('已保存并生成摘要');
    } catch (error: any) {
      setSaveState('已保存，摘要生成失败');
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
          await db.updateChapter(chapter.id, { content: '' });
          await loadChapter();
          setSaveState('已清空');
        },
      },
    ]);
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
      <Header title="章节编辑" subtitle={saveState} action={<Button label="返回" variant="ghost" onPress={onClose} />} />
      <ScrollView ref={scrollRef} contentContainerStyle={styles.content}>
        <Field label="章节标题" value={chapter.title} onChangeText={(value) => changeField('title', value)} placeholder="章节标题" />
        <Field
          label="章节概要"
          value={chapter.synopsis}
          onChangeText={(value) => changeField('synopsis', value)}
          placeholder="写下本章目标、冲突和结尾"
          multiline
          inputStyle={styles.synopsis}
        />
        <View style={styles.toolbar}>
          <Button label={generating ? '生成中...' : 'AI 续写'} icon={Bot} onPress={runPipeline} disabled={generating || finalizing} compact flex />
          <Button label={finalizing ? '定稿中...' : '保存定稿'} icon={FileText} variant="secondary" onPress={finalizeChapter} disabled={finalizing || generating} compact flex />
          <Button label="摘要" icon={FileText} variant="secondary" onPress={() => Alert.alert('章节摘要', chapter.memory_summary || '暂无记忆摘要。')} compact flex />
          <Button label="清空" icon={Trash2} variant="ghost" onPress={clearContent} disabled={generating || finalizing} compact flex />
        </View>
        <Field label="正文" value={chapter.content} onChangeText={(value) => changeField('content', value)} placeholder="开始写作..." multiline inputStyle={styles.editor} />
        {chapter.memory_summary ? (
          <View style={[styles.summaryBox, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}>
            <Text style={[styles.summaryTitle, { color: theme.colors.textPrimary }]}>记忆摘要</Text>
            <Text style={[styles.summaryText, { color: theme.colors.textSecondary }]}>{chapter.memory_summary}</Text>
          </View>
        ) : null}
        <View style={styles.footer}>
          <Text style={[styles.footerText, { color: theme.colors.textSecondary }]}>
            {chapter.content.length} 字 · 预估 {estimatedTokenCount} tokens · {saveState}
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
  footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  footerText: { flex: 1, fontSize: 12, fontWeight: '700' },
  summaryBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: spacing.md, marginBottom: spacing.md },
  summaryTitle: { fontSize: 14, fontWeight: '800', marginBottom: spacing.xs },
  summaryText: { fontSize: 13, lineHeight: 20 },
});

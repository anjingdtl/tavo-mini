import React, { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BarChart3, Bot, FileText, Network, Plus, Settings2, Trash2 } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button, Card, EmptyState, Field, Header, Screen, spacing } from '../components/ui';
import { useProjectStore } from '../store/projectStore';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';
import { buildContext } from '../services/contextBuilder';
import { callLLMResult } from '../services/llm';
import { generateMemorySummary } from '../services/summaryGenerator';
import type { EditorStackParamList } from '../navigation/TabNavigator';
import type { Chapter } from '../types/novel';

type Navigation = NativeStackNavigationProp<EditorStackParamList>;

export const OutlineEditor: React.FC = () => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const navigation = useNavigation<Navigation>();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [showBatch, setShowBatch] = useState(false);
  const [batchCount, setBatchCount] = useState('3');
  const [batchOutline, setBatchOutline] = useState('');
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState('');

  const loadChapters = useCallback(async () => {
    if (!currentProject) {
      setChapters([]);
      return;
    }
    setChapters(await db.getChaptersByProject(currentProject.id));
  }, [currentProject]);

  useEffect(() => {
    loadChapters();
  }, [loadChapters]);

  const addChapter = async () => {
    if (!currentProject) return;
    const id = await db.createChapter(currentProject.id, chapters.length);
    await loadChapters();
    navigation.navigate('ChapterEditor', { chapterId: id });
  };

  const deleteChapter = (chapter: Chapter) => {
    Alert.alert('删除章节', `确定删除「${chapter.title}」？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          await db.deleteChapter(chapter.id);
          await loadChapters();
        },
      },
    ]);
  };

  const runBatchGenerate = async () => {
    if (!currentProject || batchRunning) return;
    const count = Math.max(1, Number(batchCount) || 1);
    setBatchRunning(true);
    try {
      const outlineLines = batchOutline
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      let working = await db.getChaptersByProject(currentProject.id);
      while (working.length < count) {
        const index = working.length;
        const line = outlineLines[index] || '';
        const title = line.replace(/^\d+[.、\s-]*/, '').split(/[：:]/)[0] || `第 ${index + 1} 章`;
        const id = await db.createChapter(currentProject.id, index, title);
        if (line) await db.updateChapter(id, { synopsis: line });
        working = await db.getChaptersByProject(currentProject.id);
      }

      const targets = working
        .filter((chapter) => chapter.status !== 'final')
        .slice(0, count);

      if (targets.length === 0) {
        Alert.alert('无需生成', '前 N 章都已经定稿。');
        return;
      }

      for (let index = 0; index < targets.length; index++) {
        const chapter = targets[index];
        setBatchProgress(`正在生成 ${index + 1}/${targets.length}：${chapter.title}`);
        const config = await db.getContextConfig();
        const presets = await db.getPresetsByProject(chapter.project_id);
        const freshChapter = (await db.getChapterById(chapter.id)) || chapter;
        const messages = await buildContext(freshChapter, config, chapter.project_id, presets[0]);
        messages.push({
          role: 'user',
          content: `请根据章节标题和概要创作完整正文。\n\n章节：${freshChapter.title}\n概要：${freshChapter.synopsis || outlineLines[index] || '请承接前文自然推进剧情。'}\n\n要求：只输出正文，不要输出分析或标题。`,
        });
        const result = await callLLMResult(messages, presets[0]?.max_tokens || 4000, {
          max_tokens: presets[0]?.max_tokens || 4000,
          scenario: 'batch_chapter_generate',
        });
        if (result.text?.trim()) {
          await db.updateChapter(chapter.id, { content: result.text.trim(), status: 'draft' });
          try {
            await generateMemorySummary(chapter.id, 200);
          } catch {
            // Batch writing should continue even if one memory summary fails.
          }
        }
      }

      setShowBatch(false);
      setBatchProgress('');
      await loadChapters();
      Alert.alert('批量生成完成', `已串行生成 ${targets.length} 章。`);
    } catch (error: any) {
      Alert.alert('批量生成失败', error?.message || '请检查 API 配置。');
    } finally {
      setBatchRunning(false);
    }
  };

  if (!currentProject) {
    return (
      <Screen>
        <Header title="写作" subtitle="请先在项目页创建或选择项目" />
        <EmptyState title="没有当前项目" description="进入项目页选择项目后，这里会显示章节和写作工具。" />
      </Screen>
    );
  }

  const renderChapter = ({ item }: { item: Chapter }) => (
    <TouchableOpacity activeOpacity={0.78} onPress={() => navigation.navigate('ChapterEditor', { chapterId: item.id })}>
      <Card>
        <View style={styles.chapterHeader}>
          <View style={styles.chapterBody}>
            <Text style={[styles.chapterTitle, { color: theme.colors.textPrimary }]}>{item.title || `第 ${item.position + 1} 章`}</Text>
            <Text style={[styles.meta, { color: theme.colors.textSecondary }]} numberOfLines={2}>
              {item.synopsis || item.memory_summary || '未填写章节概要'}
            </Text>
          </View>
          <TouchableOpacity accessibilityLabel="删除章节" onPress={() => deleteChapter(item)} style={styles.iconCell}>
            <Trash2 size={17} color={theme.colors.danger} />
          </TouchableOpacity>
        </View>
        <View style={styles.statusRow}>
          <Text style={[styles.status, { color: theme.colors.textSecondary }]}>{statusLabel(item.status)}</Text>
          <Text style={[styles.status, { color: theme.colors.textSecondary }]}>{item.content.length} 字</Text>
        </View>
      </Card>
    </TouchableOpacity>
  );

  return (
    <Screen>
      <Header title={currentProject.name} subtitle="章节、大纲、摘要和上下文" action={<Button label="章节" icon={Plus} onPress={addChapter} />} />
      <View style={styles.quickActions}>
        <Button label="AI 写 N 章" icon={Bot} onPress={() => setShowBatch(true)} />
        <Button label="情节线" icon={Network} variant="secondary" onPress={() => navigation.navigate('PlotlineManager')} />
        <Button label="故事概览" icon={BarChart3} variant="secondary" onPress={() => navigation.navigate('StoryOverview')} />
        <Button label="上下文" icon={Settings2} variant="secondary" onPress={() => navigation.navigate('ContextConfig')} />
      </View>
      {chapters.length === 0 ? (
        <EmptyState title="还没有章节" description="先创建一个章节，然后补充概要和正文。" action={<Button label="创建章节" icon={FileText} onPress={addChapter} />} />
      ) : (
        <FlatList data={chapters} keyExtractor={(item) => String(item.id)} renderItem={renderChapter} contentContainerStyle={styles.list} />
      )}
      <Modal visible={showBatch} transparent animationType="slide" onRequestClose={() => setShowBatch(false)}>
        <Pressable style={styles.overlay} onPress={() => (batchRunning ? undefined : setShowBatch(false))}>
          <Pressable style={[styles.modal, { backgroundColor: theme.colors.surface }]} onPress={(event) => event.stopPropagation()}>
            <Text style={[styles.modalTitle, { color: theme.colors.textPrimary }]}>AI 一键写 N 章</Text>
            <Field label="生成章数" value={batchCount} onChangeText={setBatchCount} keyboardType="number-pad" />
            <Field
              label="整体大纲（可选；每行一章，不足章节时用于补齐）"
              value={batchOutline}
              onChangeText={setBatchOutline}
              multiline
              inputStyle={styles.outlineInput}
            />
            {batchProgress ? <Text style={[styles.progress, { color: theme.colors.textSecondary }]}>{batchProgress}</Text> : null}
            <View style={styles.modalActions}>
              <Button label="取消" variant="ghost" onPress={() => setShowBatch(false)} disabled={batchRunning} />
              <Button label={batchRunning ? '生成中...' : '开始生成'} onPress={runBatchGenerate} disabled={batchRunning} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
};

function statusLabel(status: Chapter['status']): string {
  if (status === 'draft') return '草稿';
  if (status === 'revision') return '修订';
  if (status === 'final') return '定稿';
  return '计划';
}

const styles = StyleSheet.create({
  quickActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, padding: spacing.lg, paddingBottom: 0 },
  list: { padding: spacing.lg, paddingBottom: 96 },
  chapterHeader: { flexDirection: 'row', gap: spacing.md },
  chapterBody: { flex: 1 },
  chapterTitle: { fontSize: 16, fontWeight: '800', marginBottom: 6 },
  meta: { fontSize: 13, lineHeight: 19 },
  iconCell: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.md },
  status: { fontSize: 12, fontWeight: '700' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  modal: { borderTopLeftRadius: 8, borderTopRightRadius: 8, padding: spacing.lg, gap: spacing.md },
  modalTitle: { fontSize: 18, fontWeight: '800' },
  outlineInput: { minHeight: 140, textAlignVertical: 'top' },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md },
  progress: { fontSize: 13, fontWeight: '700' },
});

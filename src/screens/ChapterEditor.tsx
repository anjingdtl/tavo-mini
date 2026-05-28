import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Bot, CheckCircle2, FileText, Save } from 'lucide-react-native';
import { Button, Field, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { debounce } from '../utils/debounce';
import * as db from '../services/database';
import { buildContext } from '../services/contextBuilder';
import { callLLMStream } from '../services/llm';
import type { Chapter, ChapterStatus } from '../types/novel';

const STATUS_OPTIONS: { value: ChapterStatus; label: string }[] = [
  { value: 'planned', label: '计划' },
  { value: 'draft', label: '草稿' },
  { value: 'revision', label: '修订' },
  { value: 'final', label: '定稿' },
];

interface Props {
  chapterId: number;
  onClose: () => void;
}

export const ChapterEditor: React.FC<Props> = ({ chapterId, onClose }) => {
  const { theme } = useThemeStore();
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [saveState, setSaveState] = useState('已保存');
  const [generating, setGenerating] = useState(false);
  const autoSaveRef = useRef(
    debounce(async (id: number, fields: Partial<Chapter>) => {
      await db.updateChapter(id, fields);
      setSaveState('已保存');
    }, 900),
  );

  const loadChapter = useCallback(async () => {
    setChapter(await db.getChapterById(chapterId));
  }, [chapterId]);

  useEffect(() => {
    loadChapter();
    const autoSave = autoSaveRef.current;
    return () => autoSave.cancel();
  }, [loadChapter]);

  const changeField = (field: keyof Chapter, value: string) => {
    if (!chapter) return;
    const next = { ...chapter, [field]: value };
    setChapter(next);
    setSaveState('保存中...');
    autoSaveRef.current.call(chapter.id, { [field]: value } as Partial<Chapter>);
  };

  const changeStatus = async (status: ChapterStatus) => {
    if (!chapter) return;
    setChapter({ ...chapter, status });
    await db.updateChapter(chapter.id, { status });
  };

  const generateContinuation = async () => {
    if (!chapter) return;
    setGenerating(true);
    try {
      const config = await db.getContextConfig();
      const presets = await db.getPresetsByProject(chapter.project_id);
      const messages = await buildContext(chapter, config, chapter.project_id, presets[0]);
      messages.push({
        role: 'user',
        content: `请继续创作章节「${chapter.title}」。当前正文如下：\n\n${chapter.content || '（空）'}\n\n要求：延续已建立的语气和情节，不重复前文。`,
      });
      const result = await callLLMStream(messages, { max_tokens: presets[0]?.max_tokens || 1600 });
      if (result) {
        const content = `${chapter.content || ''}${chapter.content ? '\n\n' : ''}${result.trim()}`;
        setChapter({ ...chapter, content });
        await db.updateChapter(chapter.id, { content, status: 'draft' });
        setSaveState('已保存');
      }
    } catch (error: any) {
      Alert.alert('生成失败', error.message || '请检查 API 配置。');
    } finally {
      setGenerating(false);
    }
  };

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
      <ScrollView contentContainerStyle={styles.content}>
        <Field label="章节标题" value={chapter.title} onChangeText={(value) => changeField('title', value)} placeholder="章节标题" />
        <Field label="章节概要" value={chapter.synopsis} onChangeText={(value) => changeField('synopsis', value)} placeholder="写下本章目标、冲突和结尾" multiline inputStyle={styles.synopsis} />
        <SegmentedControl value={chapter.status} options={STATUS_OPTIONS} onChange={changeStatus} />
        <View style={styles.toolbar}>
          <Button label={generating ? '生成中...' : 'AI 续写'} icon={Bot} onPress={generateContinuation} disabled={generating} />
          <Button label="保存" icon={Save} variant="secondary" onPress={() => db.updateChapter(chapter.id, chapter).then(() => setSaveState('已保存'))} />
          <Button label="摘要" icon={FileText} variant="secondary" onPress={() => Alert.alert('章节摘要', '请从章节列表进入摘要页，或在故事概览中查看。')} />
        </View>
        <Field label="正文" value={chapter.content} onChangeText={(value) => changeField('content', value)} placeholder="开始写作..." multiline inputStyle={styles.editor} />
        <View style={styles.footer}>
          <CheckCircle2 size={16} color={theme.colors.success} />
          <Text style={[styles.footerText, { color: theme.colors.textSecondary }]}>{chapter.content.length} 字 · {saveState}</Text>
        </View>
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 120 },
  synopsis: { minHeight: 76, textAlignVertical: 'top' },
  toolbar: { flexDirection: 'row', gap: spacing.sm, marginVertical: spacing.lg },
  editor: { minHeight: 420, textAlignVertical: 'top', fontSize: 16, lineHeight: 25 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  footerText: { fontSize: 12, fontWeight: '700' },
});

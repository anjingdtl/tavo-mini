import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Bot, Save } from 'lucide-react-native';
import { Button, Field, Header, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';
import { generateSummary } from '../services/summaryGenerator';
import type { Chapter, ChapterSummary as ChapterSummaryType } from '../types/novel';

interface Props {
  chapterId: number;
  onClose: () => void;
}

const emptySummary: ChapterSummaryType = {
  brief: '',
  plotPoints: [],
  characterStates: [],
  sceneChanges: [],
};

export const ChapterSummaryScreen: React.FC<Props> = ({ chapterId, onClose }) => {
  const { theme } = useThemeStore();
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [summary, setSummary] = useState<ChapterSummaryType>(emptySummary);
  const [generating, setGenerating] = useState(false);

  const loadChapter = useCallback(async () => {
    const item = await db.getChapterById(chapterId);
    setChapter(item);
    setSummary(item?.summary_json || emptySummary);
  }, [chapterId]);

  useEffect(() => {
    loadChapter();
  }, [loadChapter]);

  const runGenerate = async () => {
    setGenerating(true);
    try {
      await generateSummary(chapterId);
      await loadChapter();
      Alert.alert('摘要已生成', '结构化摘要已写入章节。');
    } catch (error: any) {
      Alert.alert('生成失败', error.message);
    } finally {
      setGenerating(false);
    }
  };

  const save = async () => {
    await db.updateChapter(chapterId, { summary_json: summary } as any);
    Alert.alert('已保存', '摘要已更新。');
  };

  const updateList = (field: keyof Omit<ChapterSummaryType, 'brief'>, text: string) => {
    setSummary({ ...summary, [field]: text.split('\n').map((item) => item.trim()).filter(Boolean) });
  };

  return (
    <Screen>
      <Header title="章节摘要" subtitle={chapter?.title || '结构化记忆'} action={<Button label="返回" variant="ghost" onPress={onClose} />} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>摘要会被用于后续章节上下文，适合记录关键剧情、人物状态和场景变化。</Text>
        <Field label="简述" value={summary.brief} onChangeText={(brief) => setSummary({ ...summary, brief })} multiline inputStyle={styles.longField} />
        <Field label="情节要点（每行一个）" value={summary.plotPoints.join('\n')} onChangeText={(text) => updateList('plotPoints', text)} multiline inputStyle={styles.longField} />
        <Field label="人物状态（每行一个）" value={summary.characterStates.join('\n')} onChangeText={(text) => updateList('characterStates', text)} multiline inputStyle={styles.longField} />
        <Field label="场景变化（每行一个）" value={summary.sceneChanges.join('\n')} onChangeText={(text) => updateList('sceneChanges', text)} multiline inputStyle={styles.longField} />
        <View style={styles.actions}>
          <Button label={generating ? '生成中...' : 'AI 生成'} icon={Bot} onPress={runGenerate} disabled={generating} />
          <Button label="保存摘要" icon={Save} variant="secondary" onPress={save} />
        </View>
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 100 },
  hint: { fontSize: 13, lineHeight: 20, marginBottom: spacing.lg },
  longField: { minHeight: 92, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
});

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { Button, Card, EmptyState, Header, Screen, spacing } from '../components/ui';
import { useProjectStore } from '../store/projectStore';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';
import type { Chapter } from '../types/novel';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { EditorStackParamList } from '../navigation/TabNavigator';

export const StoryOverview: React.FC = () => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const navigation = useNavigation<NativeStackNavigationProp<EditorStackParamList>>();
  const [chapters, setChapters] = useState<Chapter[]>([]);

  const load = useCallback(async () => {
    if (!currentProject) return;
    setChapters(await db.getChaptersByProject(currentProject.id));
  }, [currentProject]);

  useEffect(() => {
    load();
  }, [load]);

  const stats = useMemo(() => {
    const totalChapters = chapters.length;
    const totalWords = chapters.reduce((sum, ch) => sum + (ch.content?.length || 0), 0);
    const chaptersWithContent = chapters.filter(ch => ch.content?.trim().length > 0).length;
    const chaptersWithSynopsis = chapters.filter(ch => ch.synopsis?.trim().length > 0).length;
    const avgWordsPerChapter = totalChapters > 0 ? Math.round(totalWords / totalChapters) : 0;
    return { totalChapters, totalWords, chaptersWithContent, chaptersWithSynopsis, avgWordsPerChapter };
  }, [chapters]);

  return (
    <Screen>
      <Header title="故事概览" subtitle={currentProject?.name || '请先选择项目'} action={<Button label="故事记忆" variant="secondary" compact onPress={() => navigation.navigate('StoryMemory')} />} />
      {chapters.length === 0 ? (
        <EmptyState title="还没有可概览的章节" description="创建章节并补充摘要后，这里会形成故事进展视图。" />
      ) : (
        <FlatList
          data={chapters}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <View style={[styles.statsRow, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
              <View style={styles.statItem}>
                <Text style={[styles.statValue, { color: theme.colors.accent }]}>{stats.totalChapters}</Text>
                <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>总章节</Text>
              </View>
              <View style={styles.statItem}>
                <Text style={[styles.statValue, { color: theme.colors.accent }]}>{stats.totalWords.toLocaleString()}</Text>
                <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>总字数</Text>
              </View>
              <View style={styles.statItem}>
                <Text style={[styles.statValue, { color: theme.colors.accent }]}>{stats.chaptersWithContent}</Text>
                <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>已写</Text>
              </View>
              <View style={styles.statItem}>
                <Text style={[styles.statValue, { color: theme.colors.accent }]}>{stats.avgWordsPerChapter.toLocaleString()}</Text>
                <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>均字</Text>
              </View>
            </View>
          }
          renderItem={({ item }) => (
            <Card>
              <Text style={[styles.title, { color: theme.colors.textPrimary }]}>第 {item.position + 1} 章 · {item.title}</Text>
              <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>{item.summary_json?.brief || item.synopsis || '暂无摘要'}</Text>
              <Text style={[styles.wordCount, { color: theme.colors.textSecondary }]}>
                {(item.content?.length || 0).toLocaleString()} 字
              </Text>
            </Card>
          )}
        />
      )}
    </Screen>
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.lg, paddingBottom: 96 },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  statItem: { alignItems: 'center' },
  statValue: { fontSize: 20, fontWeight: '800' },
  statLabel: { fontSize: 11, fontWeight: '600', marginTop: 2 },
  title: { fontSize: 16, fontWeight: '800', marginBottom: 6 },
  meta: { fontSize: 13, lineHeight: 20 },
  wordCount: { fontSize: 11, fontWeight: '600', marginTop: 4 },
});

import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text } from 'react-native';
import { Card, EmptyState, Header, Screen, spacing } from '../components/ui';
import { useProjectStore } from '../store/projectStore';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';
import type { Chapter } from '../types/novel';

export const StoryOverview: React.FC = () => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const [chapters, setChapters] = useState<Chapter[]>([]);

  const load = useCallback(async () => {
    if (!currentProject) return;
    setChapters(await db.getChaptersByProject(currentProject.id));
  }, [currentProject]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Screen>
      <Header title="故事概览" subtitle={currentProject?.name || '请先选择项目'} />
      {chapters.length === 0 ? (
        <EmptyState title="还没有可概览的章节" description="创建章节并补充摘要后，这里会形成故事进展视图。" />
      ) : (
        <FlatList
          data={chapters}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Card>
              <Text style={[styles.title, { color: theme.colors.textPrimary }]}>第 {item.position + 1} 章 · {item.title}</Text>
              <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>{item.summary_json?.brief || item.synopsis || '暂无摘要'}</Text>
            </Card>
          )}
        />
      )}
    </Screen>
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.lg, paddingBottom: 96 },
  title: { fontSize: 16, fontWeight: '800', marginBottom: 6 },
  meta: { fontSize: 13, lineHeight: 20 },
});

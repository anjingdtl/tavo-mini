import React, { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BarChart3, FileText, Network, Plus, Settings2, Trash2 } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button, Card, EmptyState, Header, Screen, spacing } from '../components/ui';
import { useProjectStore } from '../store/projectStore';
import { useThemeStore } from '../store/themeStore';
import * as db from '../services/database';
import type { EditorStackParamList } from '../navigation/TabNavigator';
import type { Chapter } from '../types/novel';

type Navigation = NativeStackNavigationProp<EditorStackParamList>;

export const OutlineEditor: React.FC = () => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const navigation = useNavigation<Navigation>();
  const [chapters, setChapters] = useState<Chapter[]>([]);

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
      { text: '删除', style: 'destructive', onPress: async () => { await db.deleteChapter(chapter.id); await loadChapters(); } },
    ]);
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
              {item.synopsis || '未填写章节概要'}
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
      <Header
        title={currentProject.name}
        subtitle="章节、大纲、摘要和上下文"
        action={<Button label="章节" icon={Plus} onPress={addChapter} />}
      />
      <View style={styles.quickActions}>
        <Button label="情节线" icon={Network} variant="secondary" onPress={() => navigation.navigate('PlotlineManager')} />
        <Button label="故事概览" icon={BarChart3} variant="secondary" onPress={() => navigation.navigate('StoryOverview')} />
        <Button label="上下文" icon={Settings2} variant="secondary" onPress={() => navigation.navigate('ContextConfig')} />
      </View>
      {chapters.length === 0 ? (
        <EmptyState title="还没有章节" description="先创建一个章节，然后补充概要和正文。" action={<Button label="创建章节" icon={FileText} onPress={addChapter} />} />
      ) : (
        <FlatList data={chapters} keyExtractor={(item) => String(item.id)} renderItem={renderChapter} contentContainerStyle={styles.list} />
      )}
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
  quickActions: { flexDirection: 'row', gap: spacing.sm, padding: spacing.lg, paddingBottom: 0 },
  list: { padding: spacing.lg, paddingBottom: 96 },
  chapterHeader: { flexDirection: 'row', gap: spacing.md },
  chapterBody: { flex: 1 },
  chapterTitle: { fontSize: 16, fontWeight: '800', marginBottom: 6 },
  meta: { fontSize: 13, lineHeight: 19 },
  iconCell: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.md },
  status: { fontSize: 12, fontWeight: '700' },
});

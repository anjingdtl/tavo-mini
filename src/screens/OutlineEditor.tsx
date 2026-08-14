import React, { useCallback, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, ToastAndroid, TouchableOpacity, View } from 'react-native';
import { BarChart3, FileText, Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
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

  useFocusEffect(
    useCallback(() => {
      loadChapters();
    }, [loadChapters]),
  );

  const addChapter = async () => {
    if (!currentProject) return;
    try {
      const id = await db.createChapter(currentProject.id, chapters.length);
      await loadChapters();
      navigation.navigate('ChapterEditor', { chapterId: id });
    } catch (e: any) {
      Alert.alert('创建章节失败', e?.message || '未知错误');
    }
  };

  const deleteChapter = useCallback((chapter: Chapter) => {
    Alert.alert('删除章节', `确定删除「${chapter.title}」？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await db.deleteChapter(chapter.id);
            await loadChapters();
          } catch (e: any) {
            Alert.alert('删除章节失败', e?.message || '未知错误');
          }
        },
      },
    ]);
  }, [loadChapters]);

  const moveChapter = useCallback(async (fromIndex: number, toIndex: number) => {
    if (!currentProject) return;
    try {
      const allChapters = await db.getChaptersByProject(currentProject.id);
      if (fromIndex < 0 || fromIndex >= allChapters.length || toIndex < 0 || toIndex >= allChapters.length) return;
      const moved = allChapters.splice(fromIndex, 1)[0];
      allChapters.splice(toIndex, 0, moved);
      // 用 allSettled：单条 update 失败不应让整个排序回滚，部分失败用 Toast 提示。
      const results = await Promise.allSettled(
        allChapters.map((ch, idx) => db.updateChapter(ch.id, { position: idx })),
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        ToastAndroid.show(`${failed} 个章节位置更新失败`, ToastAndroid.SHORT);
      }
      await loadChapters();
    } catch (e: any) {
      Alert.alert('调整顺序失败', e?.message || '未知错误');
    }
  }, [currentProject, loadChapters]);

  const renderChapter = useCallback(({ item, index }: { item: Chapter; index: number }) => (
    <TouchableOpacity testID={`writing-chapter-${item.id}`} accessibilityLabel={item.title || `第 ${item.position + 1} 章`} activeOpacity={0.78} onPress={() => navigation.navigate('ChapterEditor', { chapterId: item.id })}>
      <Card style={[styles.chapterCard, { borderLeftColor: theme.colors.accent }]}>
        <View style={styles.chapterHeader}>
          <View style={styles.chapterBody}>
            <Text style={[styles.chapterTitle, { color: theme.colors.textPrimary }]}>{item.title || `第 ${item.position + 1} 章`}</Text>
            <Text style={[styles.meta, { color: theme.colors.textSecondary }]} numberOfLines={2}>
              {item.synopsis || item.memory_summary || '未填写章节概要'}
            </Text>
          </View>
          <View style={styles.chapterActions}>
            <Button label="" icon={ArrowUp} variant="ghost" compact onPress={() => moveChapter(index, index - 1)} disabled={index === 0} />
            <Button label="" icon={ArrowDown} variant="ghost" compact onPress={() => moveChapter(index, index + 1)} disabled={index === chapters.length - 1} />
            <TouchableOpacity accessibilityLabel="删除章节" onPress={() => deleteChapter(item)} style={styles.iconCell}>
              <Trash2 size={17} color={theme.colors.danger} />
            </TouchableOpacity>
          </View>
        </View>
        <View style={styles.statusRow}>
          <Text style={[styles.status, { color: theme.colors.textSecondary }]}>{statusLabel(item.status)}</Text>
          <Text style={[styles.status, { color: theme.colors.textSecondary }]}>{(item.content || '').length} 字</Text>
        </View>
      </Card>
    </TouchableOpacity>
  ), [chapters.length, deleteChapter, moveChapter, navigation, theme]);

  if (!currentProject) {
    return (
      <Screen>
        <Header title="写作" subtitle="请先在项目页创建或选择项目" />
        <EmptyState title="没有当前项目" description="进入项目页选择项目后，这里会显示章节和写作工具。" />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header testID="writing-home" title={currentProject.name} subtitle="章节 · 大纲 · 摘要 · 上下文" action={<Button testID="writing-add-chapter" label="章节" icon={Plus} variant="ghost" onPress={addChapter} compact />} />
      <View style={styles.quickActions}>
        <Button label="故事概览" icon={BarChart3} variant="secondary" onPress={() => navigation.navigate('StoryOverview')} compact flex />
        <Button
          label="一键写 N 章"
          icon={FileText}
          variant="secondary"
          compact
          flex
          onPress={() => navigation.navigate('MultiChapterBatch')}
        />
      </View>
      <View style={[styles.chapterMeta, { borderBottomColor: theme.colors.border }]}>
        <Text style={[styles.chapterMetaTitle, { color: theme.colors.accent }]}>正文卷</Text>
        <Text style={[styles.chapterMetaCount, { color: theme.colors.textMuted }]}>{chapters.length} 章</Text>
      </View>
      {chapters.length === 0 ? (
        <EmptyState title="还没有章节" description="先创建一个章节，然后补充概要和正文。" action={<Button testID="writing-create-chapter" label="创建章节" icon={FileText} onPress={addChapter} />} />
      ) : (
        <FlatList testID="writing-chapter-list" data={chapters} keyExtractor={(item) => String(item.id)} renderItem={renderChapter} contentContainerStyle={styles.list} />
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
  quickActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, padding: spacing.lg, paddingBottom: 0 },
  list: { padding: spacing.lg, paddingBottom: 96 },
  chapterCard: { borderLeftWidth: 3, paddingLeft: spacing.md + 2 },
  chapterHeader: { flexDirection: 'row', gap: spacing.md },
  chapterBody: { flex: 1 },
  chapterActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  chapterTitle: { fontSize: 18, fontFamily: 'serif', fontWeight: '700', marginBottom: 6 },
  meta: { fontSize: 13, lineHeight: 20 },
  iconCell: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.md },
  status: { fontSize: 12, fontWeight: '600' },
  chapterMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: spacing.lg, marginTop: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  chapterMetaTitle: { fontSize: 14, fontFamily: 'serif', fontWeight: '700', letterSpacing: 0.5 },
  chapterMetaCount: { fontSize: 12 },
});

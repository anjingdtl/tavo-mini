import React, { useCallback, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BookOpen, FileSearch, FilePlus2, Inbox, Layers, Network, Sparkles, Trash2 } from 'lucide-react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Button, Card, EmptyState, Header, Screen, spacing } from '../../components/ui';
import { useProjectStore } from '../../store/projectStore';
import * as db from '../../services/database';
import { useThemeStore } from '../../store/themeStore';
import type { Chapter } from '../../types/novel';
import {
  getContinuationChapterNumbering,
  getNextContinuationChapterPosition,
  makeContinuationChapterNumbering,
} from '../../services/continuation/chapterNumbering/continuationChapterNumbering';
import { listPendingReviewRunsForProject } from '../../services/continuation/generation';

/** Mode-specific root: continuation never enters the ordinary outline workbench. */
export const ContinuationWorkspaceScreen: React.FC = () => {
  const { currentProject } = useProjectStore();
  const { theme } = useThemeStore();
  const navigation = useNavigation<any>();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [pendingRunByChapter, setPendingRunByChapter] = useState<
    Record<number, string>
  >({});
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    if (!currentProject) {
      setChapters([]);
      setPendingRunByChapter({});
      return;
    }
    const [chapterRows, pendingRuns] = await Promise.all([
      db.getChaptersByProject(currentProject.id),
      listPendingReviewRunsForProject(currentProject.id).catch(() => []),
    ]);
    setChapters(chapterRows);
    // Keep only the newest awaiting_user run per chapter (query is DESC).
    const map: Record<number, string> = {};
    for (const run of pendingRuns) {
      if (map[run.chapterId] == null) map[run.chapterId] = run.id;
    }
    setPendingRunByChapter(map);
  }, [currentProject]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const add = async () => {
    if (!currentProject || adding) return;
    setAdding(true);
    try {
      // New continuation chapter position = max(existing) + 1, never chapters.length
      // (Spec §11.4: deletions/imports/non-contiguous positions must not duplicate).
      const position = await getNextContinuationChapterPosition(currentProject.id);
      // Default title continues from the boundary source chapter (Spec §11.2/§11.6):
      // a boundary at the end of source chapter 20 → first continuation is 第21章.
      const numbering = await getContinuationChapterNumbering(currentProject.id);
      const id = await db.createChapter(
        currentProject.id,
        Number(position),
        numbering.getDefaultTitle(position),
      );
      navigation.navigate('ChapterEditor', { chapterId: id });
    } finally {
      setAdding(false);
    }
  };
  if (!currentProject) return <Screen><Header title="原著续写" /><EmptyState title="请先选择续写项目" description="在作品库中创建或选择一个原著续写项目。" /></Screen>;
  return <Screen>
    <Header
      testID="continuation-workspace"
      title={currentProject.name}
      subtitle="原著续写工作台"
      action={
        <View style={styles.headerActions}>
          <Button
            testID="continuation-batch-entry"
            label="一键续写 N 章"
            icon={Layers}
            compact
            onPress={() =>
              navigation.navigate('MultiChapterBatch', {
                writingMode: 'continuation',
              })
            }
          />
          <Button
            testID="continuation-add-chapter"
            label="新建续写章节"
            icon={FilePlus2}
            compact
            onPress={() => add().catch(() => {})}
          />
        </View>
      }
    />
    <View style={styles.summary}>
      <Card style={styles.summaryCard}>
        <TouchableOpacity onPress={() => navigation.navigate('Resources')} accessibilityRole="button" accessibilityLabel="打开原著与 Canon 资料" style={styles.summaryItem}>
          <Network size={16} color={theme.colors.accent} />
          <View style={styles.summaryText}><Text style={[styles.summaryTitle, { color: theme.colors.textPrimary }]}>Canon 驱动续写</Text><Text style={[styles.summaryMeta, { color: theme.colors.textSecondary }]} numberOfLines={1}>原著、边界与 Canon 统一调度</Text></View>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.navigate('Resources')} accessibilityRole="button" accessibilityLabel="打开外部补充资料" style={[styles.summaryItem, styles.summaryItemSecondary, { borderTopColor: theme.colors.border }]}>
          <Sparkles size={16} color={theme.colors.accent} />
          <View style={styles.summaryText}><Text style={[styles.summaryTitle, { color: theme.colors.textPrimary }]}>外部补充资料</Text><Text style={[styles.summaryMeta, { color: theme.colors.textSecondary }]} numberOfLines={1}>标为“外部补充”的资料会注入续写</Text></View>
        </TouchableOpacity>
      </Card>
    </View>
    <View style={styles.section}><Text style={[styles.title, { color: theme.colors.textPrimary }]}>续写章节</Text><Text style={[styles.meta, { color: theme.colors.textSecondary }]}>{chapters.length} 章</Text></View>
    {chapters.length === 0 ? <EmptyState title="还没有续写章节" description="请先在资料页完成原著接入与 Canon 分析，再开始 AI 续写。" action={<Button label="新建续写章节" icon={BookOpen} onPress={() => add().catch(() => {})} />} /> : <ContinuationChapterList chapters={chapters} pendingRunByChapter={pendingRunByChapter} navigation={navigation} onDeleted={load} />}
  </Screen>;
};

/**
 * Renders continuation chapters with boundary-aware display titles (Spec §11.2).
 * Internal position stays 0-based ContinuationChapterPosition; the visible number
 * continues from the source boundary. User-custom titles are never overwritten.
 */
const ContinuationChapterList: React.FC<{
  chapters: Chapter[];
  pendingRunByChapter: Record<number, string>;
  navigation: ReturnType<typeof useNavigation<any>>;
  onDeleted: () => void;
}> = ({ chapters, pendingRunByChapter, navigation, onDeleted }) => {
  const { theme } = useThemeStore();
  const [numbering, setNumbering] = useState<{ getDisplayTitle: (c: { title: string; position: number }) => string } | null>(null);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const { currentProject } = useProjectStore.getState();
      if (!currentProject) return;
      getContinuationChapterNumbering(currentProject.id)
        .then(n => { if (!cancelled) setNumbering(n); })
        .catch(() => {});
      return () => { cancelled = true; };
    }, []),
  );
  const titleOf = (item: Chapter) =>
    numbering?.getDisplayTitle(item) ||
    item.title ||
    makeContinuationChapterNumbering(null).getDefaultTitle(item.position as any);
  const deleteChapter = (chapter: Chapter) => {
    Alert.alert('删除章节', `确定删除「${titleOf(chapter)}」？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await db.deleteChapter(chapter.id);
            onDeleted();
          } catch (e: any) {
            Alert.alert('删除章节失败', e?.message || '未知错误');
          }
        },
      },
    ]);
  };
  return (
    <FlatList
      data={chapters}
      keyExtractor={item => String(item.id)}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => {
        const pendingRunId = pendingRunByChapter[item.id];
        return (
          <Card>
            <TouchableOpacity
              onPress={() =>
                navigation.navigate('ChapterEditor', { chapterId: item.id })
              }
              accessibilityRole="button"
              accessibilityLabel={`编辑${titleOf(item)}`}
            >
              <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
                {titleOf(item)}
              </Text>
              <Text
                style={[styles.meta, { color: theme.colors.textSecondary }]}
                numberOfLines={2}
              >
                {item.synopsis || '未填写续写要求'}
              </Text>
              {pendingRunId ? (
                <Text
                  style={[styles.pendingBadge, { color: theme.colors.accent }]}
                >
                  有待采纳的续写结果
                </Text>
              ) : null}
            </TouchableOpacity>
            <View style={styles.contextAction}>
              {pendingRunId ? (
                <Button
                  testID={`open-pending-continuation-${item.id}`}
                  label="查看续写结果"
                  icon={Inbox}
                  variant="secondary"
                  compact
                  onPress={() =>
                    navigation.navigate('ContinuationResult', {
                      runId: pendingRunId,
                    })
                  }
                />
              ) : (
                <Button
                  label="查看实际上下文"
                  icon={FileSearch}
                  variant="secondary"
                  compact
                  onPress={() =>
                    navigation.navigate('ContextPreview', {
                      chapterId: item.id,
                    })
                  }
                />
              )}
              <View style={styles.actionRowEnd}>
                {pendingRunId ? (
                  <Button
                    label="上下文"
                    icon={FileSearch}
                    variant="ghost"
                    compact
                    onPress={() =>
                      navigation.navigate('ContextPreview', {
                        chapterId: item.id,
                      })
                    }
                  />
                ) : null}
                <TouchableOpacity
                  accessibilityLabel="删除章节"
                  onPress={() => deleteChapter(item)}
                  style={styles.iconCell}
                >
                  <Trash2 size={17} color={theme.colors.danger} />
                </TouchableOpacity>
              </View>
            </View>
          </Card>
        );
      }}
    />
  );
};

const styles = StyleSheet.create({
  summary: { padding: spacing.lg },
  headerActions: { flexDirection: 'row', gap: spacing.xs, alignItems: 'center' },
  summaryCard: { paddingVertical: 0 },
  summaryItem: {
    minHeight: 52,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  summaryItemSecondary: { borderTopWidth: StyleSheet.hairlineWidth },
  summaryText: { flex: 1 },
  summaryTitle: { fontSize: 14, fontWeight: '800' },
  summaryMeta: { fontSize: 11, lineHeight: 16, marginTop: 1 },
  title: { fontSize: 16, fontWeight: '800' },
  meta: { fontSize: 13, lineHeight: 19, marginTop: 4 },
  pendingBadge: { fontSize: 12, fontWeight: '700', marginTop: 6 },
  section: {
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  list: {
    padding: spacing.lg,
    gap: spacing.sm,
    paddingBottom: 96,
  },
  contextAction: {
    marginTop: spacing.md,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  actionRowEnd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  iconCell: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
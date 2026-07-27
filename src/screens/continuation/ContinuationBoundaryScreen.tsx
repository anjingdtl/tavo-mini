/**
 * Continuation boundary screen — set the continuation point (Spec §8.4, §12.3).
 *
 * Phase 1 scope: choose boundary mode (end_of_source / end_of_chapter) and
 * the boundary chapter. custom_offset (mid-chapter) is supported by the service
 * layer; the UI for an in-chapter slider is a Phase 2 polish item.
 */
import React, { useEffect, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text } from 'react-native';
import Toast from 'react-native-toast-message';
import { Button, Card, EmptyState, Header, Screen, spacing } from '../../components/ui';
import { useProjectStore } from '../../store/projectStore';
import { useThemeStore } from '../../store/themeStore';
import { getActiveContinuationSource } from '../../services/continuation/continuationImportService';
import {
  getChaptersBySource,
} from '../../services/continuation/continuationSourceRepository';
import { updateContinuationBoundary } from '../../services/continuation/continuationSettingsService';
import type {
  ContinuationSource,
  ContinuationSourceChapter,
} from '../../services/continuation/types';

export const ContinuationBoundaryScreen: React.FC<{
  navigation: { goBack: () => void };
}> = ({ navigation }) => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const [source, setSource] = useState<ContinuationSource | null>(null);
  const [chapters, setChapters] = useState<ContinuationSourceChapter[]>([]);

  const reload = async () => {
    if (!currentProject) return;
    try {
      const src = await getActiveContinuationSource(currentProject.id);
      setSource(src);
      if (src) setChapters(await getChaptersBySource(src.id));
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '加载失败', text2: e?.message });
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [currentProject?.id]);

  const handleSetEndOfSource = async () => {
    if (!currentProject) return;
    try {
      await updateContinuationBoundary(currentProject.id, { mode: 'end_of_source' });
      Toast.show({ type: 'success', text1: '续写起点已设为原著末尾' });
      navigation.goBack();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '设置失败', text2: e?.message });
    }
  };

  const handleSetEndOfChapter = async (position: number) => {
    if (!currentProject) return;
    Alert.alert(
      '设置续写起点',
      `确定将续写起点设为「第 ${position + 1} 章」末尾？\n此章之后的原文将默认不进入分析和生成，Phase 2 分析状态会被标记为过期。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '确定',
          onPress: async () => {
            try {
              await updateContinuationBoundary(currentProject.id, {
                mode: 'end_of_chapter',
                chapterPosition: position,
              });
              Toast.show({ type: 'success', text1: '续写起点已更新' });
              navigation.goBack();
            } catch (e: any) {
              Toast.show({ type: 'error', text1: '设置失败', text2: e?.message });
            }
          },
        },
      ],
    );
  };

  if (!currentProject) {
    return (
      <Screen>
        <Header title="续写起点" action={<Button label="返回" variant="ghost" onPress={() => navigation.goBack()} />} />
        <EmptyState title="请先选择项目" />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="续写起点" subtitle={currentProject.name} action={<Button label="返回" variant="ghost" onPress={() => navigation.goBack()} />} />
      {!source ? (
        <EmptyState title="尚未导入原著" description="导入原著后可设置续写起点。" />
      ) : (
        <FlatList
          style={styles.list}
          contentContainerStyle={{ paddingBottom: spacing.xl }}
          ListHeaderComponent={
            <Card>
              <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
                续写起点之后的原文默认不进入 AI 分析和生成。可在下方选择章节作为起点，或将整个原著作为可读范围。
              </Text>
              <Text
                accessibilityRole="button"
                onPress={handleSetEndOfSource}
                style={[styles.endSource, { color: theme.colors.accent }]}
              >
                设为原著末尾（全部可读）
              </Text>
            </Card>
          }
          data={chapters.filter(c => !c.isExcluded)}
          keyExtractor={item => String(item.id)}
          renderItem={({ item }) => (
            <Card>
              <Text style={[styles.chapterTitle, { color: theme.colors.textPrimary }]}>
                第 {item.position + 1} 章 · {item.title}
              </Text>
              <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
                {item.charCount.toLocaleString('zh-CN')} 字
              </Text>
              <Text
                accessibilityRole="button"
                onPress={() => handleSetEndOfChapter(item.position)}
                style={[styles.setAction, { color: theme.colors.accent }]}
              >
                设此章末尾为续写起点
              </Text>
            </Card>
          )}
        />
      )}
    </Screen>
  );
};

const styles = StyleSheet.create({
  list: { flex: 1, padding: spacing.lg },
  hint: { fontSize: 13, lineHeight: 20 },
  endSource: { fontSize: 15, fontWeight: '600', marginTop: spacing.sm },
  chapterTitle: { fontSize: 15, fontWeight: '600' },
  meta: { fontSize: 12, marginTop: 4 },
  setAction: { fontSize: 14, fontWeight: '600', marginTop: spacing.sm },
});

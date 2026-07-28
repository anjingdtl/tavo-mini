import React, { useCallback, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { FileText, Trash2, Upload } from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import { Button, Card, EmptyState, Header, Screen, spacing } from '../../components/ui';
import { useProjectStore } from '../../store/projectStore';
import { useThemeStore } from '../../store/themeStore';
import { getActiveContinuationSource } from '../../services/continuation/continuationImportService';
import { PROJECT_MODE_LABELS } from '../../services/continuation/projectMode';
import type { ContinuationSource } from '../../services/continuation/types';

/**
 * Minimal navigation surface used by the continuation home. Kept as a structural
 * type so the body can be embedded inside ResourceLibrary (which forwards its
 * own navigation) or rendered as a standalone stack screen.
 */
export type ContinuationHomeNavigation = {
  navigate: (screen: string, params?: any) => void;
};

/**
 * Shared state + handlers for the continuation home body.
 *
 * Extracted so the same logic backs both the standalone ContinuationHomeScreen
 * (deep-link/stack entry, keeps its own Header) and the embedded body rendered
 * inside ResourceLibrary's 续写 tab (no Header — the library owns the header).
 */
export function useContinuationHome(navigation: ContinuationHomeNavigation) {
  const { currentProject } = useProjectStore();
  const [activeSource, setActiveSource] = useState<ContinuationSource | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!currentProject) {
      setLoading(false);
      return;
    }
    try {
      const src = await getActiveContinuationSource(currentProject.id);
      setActiveSource(src);
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '加载失败', text2: e?.message });
    } finally {
      setLoading(false);
    }
  }, [currentProject]);

  // The screen remains mounted while its child screens perform an import or
  // change the boundary. Reload on focus so returning from those flows shows
  // the committed source rather than the stale pre-import empty state.
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      reload().catch(() => {});
    }, [reload]),
  );

  const handleImport = useCallback(() => {
    navigation.navigate('ContinuationSourceChapters', {});
  }, [navigation]);

  const handleAnalysis = useCallback(() => {
    navigation.navigate('CanonAnalysisOverview', {});
  }, [navigation]);

  const handleViewChapters = useCallback(() => {
    navigation.navigate('ContinuationSourceChapters', {});
  }, [navigation]);

  const handleBoundary = useCallback(() => {
    navigation.navigate('ContinuationBoundary', {});
  }, [navigation]);

  const handleDelete = useCallback(() => {
    if (!activeSource || !currentProject) return;
    Alert.alert(
      '删除原著',
      `确定删除「${activeSource.displayName}」的原著数据？\n\n此操作会清除原著源、章节和续写起点，但不会影响你的续写章节。Phase 2 分析状态将被标记为过期。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            try {
              const { deleteContinuationSource } = await import(
                '../../services/continuation/continuationImportService'
              );
              await deleteContinuationSource(currentProject.id);
              await reload();
              Toast.show({ type: 'success', text1: '原著已删除' });
            } catch (e: any) {
              Toast.show({ type: 'error', text1: '删除失败', text2: e?.message });
            }
          },
        },
      ],
    );
  }, [activeSource, currentProject, reload]);

  return {
    currentProject,
    activeSource,
    loading,
    reload,
    handleImport,
    handleAnalysis,
    handleViewChapters,
    handleBoundary,
    handleDelete,
  };
}

/**
 * Continuation home body — the cards/metadata/actions, WITHOUT any Screen or
 * Header wrapper. Intended to be embedded inside ResourceLibrary's 续写 tab,
 * which already provides the page header. The standalone {@link ContinuationHomeScreen}
 * wraps this same body in a Screen+Header for deep-link/stack entry.
 */
export const ContinuationHomeBody: React.FC<{
  navigation: ContinuationHomeNavigation;
}> = ({ navigation }) => {
  const { theme } = useThemeStore();
  const home = useContinuationHome(navigation);
  const { currentProject, activeSource, loading } = home;

  if (!currentProject) {
    return (
      <View style={styles.emptyWrap}>
        <EmptyState
          title="请先选择项目"
          description="在「项目」Tab 选择一个原著续写项目后，再回到这里导入原著。"
        />
      </View>
    );
  }

  if (currentProject.mode !== 'continuation') {
    return (
      <View style={styles.emptyWrap}>
        <EmptyState
          title="当前项目不是原著续写项目"
          description={`「${currentProject.name}」是${
            PROJECT_MODE_LABELS[currentProject.mode] ?? currentProject.mode
          }项目，续写资料仅对原著续写项目开放。`}
        />
      </View>
    );
  }

  return (
    <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: spacing.xl }}>
      {loading ? (
        <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>加载中…</Text>
      ) : !activeSource ? (
        <Card>
          <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
            导入 TXT 原著
          </Text>
          <Text style={[styles.body2, { color: theme.colors.textSecondary }]}>
            导入一部 TXT 原著，指定续写起点，系统会在设备本地解析章节并建立原著边界。AI 将只读取续写起点之前的原文。
          </Text>
          <Text style={[styles.privacy, { color: theme.colors.textMuted }]}>
            · 支持UTF-8、GBK、GB18030、UTF-16 编码{'\n'}
            · 原著仅保存在本设备，Phase 1 不会上传{'\n'}
            · 请确认你拥有该原著的合法使用权
          </Text>
          <Button
            label="导入 TXT 原著"
            onPress={home.handleImport}
            icon={Upload}
          />
        </Card>
      ) : (
        <Card>
          <View style={styles.rowBetween}>
            <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
              {activeSource.displayName}
            </Text>
            <FileText size={20} color={theme.colors.accent} />
          </View>
          <View style={styles.metaGrid}>
            <MetaRow label="原文件" value={activeSource.originalFileName} theme={theme} />
            <MetaRow
              label="大小"
              value={`${(activeSource.fileSizeBytes / 1024).toFixed(1)} KB`}
              theme={theme}
            />
            <MetaRow
              label="规范化字符数"
              value={activeSource.normalizedCharCount.toLocaleString('zh-CN')}
              theme={theme}
            />
            <MetaRow
              label="识别章节"
              value={`${activeSource.chapterCount} 章`}
              theme={theme}
            />
            <MetaRow
              label="编码"
              value={activeSource.detectedEncoding}
              theme={theme}
            />
            <MetaRow
              label="导入时间"
              value={new Date(activeSource.activatedAt ?? activeSource.createdAt).toLocaleString('zh-CN')}
              theme={theme}
            />
          </View>

          <View style={styles.actions}>
            <Button
              label="查看章节"
              variant="ghost"
              onPress={home.handleViewChapters}
            />
            <Button
              label="设置续写起点"
              variant="ghost"
              onPress={home.handleBoundary}
            />
            <Button
              label="原著分析"
              onPress={home.handleAnalysis}
            />
          </View>
          <TouchableOpacity
            accessibilityLabel="删除原著"
            onPress={home.handleDelete}
            style={styles.deleteRow}
          >
            <Trash2 size={16} color={theme.colors.danger} />
            <Text style={[styles.deleteText, { color: theme.colors.danger }]}>删除原著</Text>
          </TouchableOpacity>
        </Card>
      )}
    </ScrollView>
  );
};

/**
 * Continuation resource home (Spec §8.4).
 *
 * Shows the not-imported vs imported state for the active project's original
 * work, and gates AI continuation when no source is active. Non-continuation
 * projects see a clear "this is not a continuation project" message and cannot
 * import here.
 *
 * This standalone screen keeps its own Header for deep-link / stack entry. For
 * the embedded variant used inside ResourceLibrary's 续写 tab, use
 * {@link ContinuationHomeBody} instead.
 */
export const ContinuationHomeScreen: React.FC<{
  navigation: ContinuationHomeNavigation;
}> = ({ navigation }) => {
  return (
    <Screen>
      <Header title="续写" />
      <ContinuationHomeBody navigation={navigation} />
    </Screen>
  );
};

const MetaRow: React.FC<{ label: string; value: string; theme: any }> = ({
  label,
  value,
  theme,
}) => (
  <View style={styles.metaRow}>
    <Text style={[styles.metaLabel, { color: theme.colors.textMuted }]}>{label}</Text>
    <Text style={[styles.metaValue, { color: theme.colors.textPrimary }]}>{value}</Text>
  </View>
);

const styles = StyleSheet.create({
  body: { flex: 1, padding: spacing.lg },
  emptyWrap: { flex: 1, justifyContent: 'center', padding: spacing.lg },
  title: { fontSize: 18, fontWeight: '700', marginBottom: spacing.sm },
  body2: { fontSize: 14, lineHeight: 22, marginBottom: spacing.md },
  privacy: { fontSize: 12, lineHeight: 20, marginBottom: spacing.md },
  hint: { fontSize: 14, textAlign: 'center', marginTop: spacing.xl },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  metaGrid: { gap: spacing.xs, marginBottom: spacing.md },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between' },
  metaLabel: { fontSize: 13 },
  metaValue: { fontSize: 13, fontWeight: '500' },
  actions: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  deleteRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: spacing.xs },
  deleteText: { fontSize: 14 },
});

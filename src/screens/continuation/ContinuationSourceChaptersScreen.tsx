/**
 * Continuation source chapters — read-only chapter list + import entry
 * (Spec §8.3, §12.2).
 *
 * Phase 1 scope: list the parsed source chapters (read-only) and provide the
 * TXT-import entry point. Chapter preview editing (merge/split/rename/exclude)
 * is supported via the import preview flow; this screen focuses on viewing an
 * already-active source. AI 续写 entries are gated until a source is active.
 */
import React, { useEffect, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Upload } from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import { Button, Card, EmptyState, Header, Screen, spacing } from '../../components/ui';
import { useProjectStore } from '../../store/projectStore';
import { useThemeStore } from '../../store/themeStore';
import { getActiveContinuationSource } from '../../services/continuation/continuationImportService';
import {
  getChaptersBySource,
} from '../../services/continuation/continuationSourceRepository';
import type { ContinuationSource, ContinuationSourceChapter } from '../../services/continuation/types';

export const ContinuationSourceChaptersScreen: React.FC<{
  navigation: { navigate: (screen: string, params?: any) => void; goBack: () => void };
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
      if (src) {
        const list = await getChaptersBySource(src.id);
        setChapters(list);
      } else {
        setChapters([]);
      }
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '加载失败', text2: e?.message });
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [currentProject?.id]);

  const handleImport = () => {
    if (!currentProject) return;
    if (currentProject.mode !== 'continuation') {
      Alert.alert('无法导入', '只有原著续写项目可以导入原著。');
      return;
    }
    // The actual file-pick + import flow lives in the import wizard, which is
    // launched from here. Phase 1 wires the entry; the full wizard UI is a
    // follow-up task tracked in the施工报告.
    Alert.alert(
      '导入 TXT 原著',
      '请通过文件选择器选择 TXT 文件。导入向导将处理编码识别、章节解析和续写起点设置。',
      [{ text: '我知道了' }],
    );
  };

  if (!currentProject) {
    return (
      <Screen>
        <Header title="原著章节" action={<Button label="返回" variant="ghost" onPress={() => navigation.goBack()} />} />
        <EmptyState title="请先选择项目" />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="原著章节" subtitle={currentProject.name} action={<Button label="返回" variant="ghost" onPress={() => navigation.goBack()} />} />
      {!source ? (
        <View style={styles.empty}>
          <EmptyState
            title="尚未导入原著"
            description="导入 TXT 原著后，解析出的章节会显示在这里（只读）。"
          />
          <TouchableOpacity
            accessibilityLabel="导入 TXT 原著"
            onPress={handleImport}
            style={[styles.importBtn, { borderColor: theme.colors.accent }]}
          >
            <Upload size={16} color={theme.colors.accent} />
            <Text style={[styles.importText, { color: theme.colors.accent }]}>导入 TXT 原著</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          style={styles.list}
          contentContainerStyle={{ paddingBottom: spacing.xl }}
          data={chapters}
          keyExtractor={item => String(item.id)}
          renderItem={({ item }) => (
            <Card>
              <View style={styles.row}>
                <Text style={[styles.position, { color: theme.colors.textMuted }]}>
                  第 {item.position + 1} 章
                </Text>
                {item.isExcluded ? (
                  <Text style={[styles.excluded, { color: theme.colors.danger }]}>已排除</Text>
                ) : null}
              </View>
              <Text style={[styles.chapterTitle, { color: theme.colors.textPrimary }]}>
                {item.title}
              </Text>
              <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
                {item.charCount.toLocaleString('zh-CN')} 字 · {item.paragraphCount} 段
              </Text>
              {item.volumeTitle ? (
                <Text style={[styles.volume, { color: theme.colors.textMuted }]}>
                  卷：{item.volumeTitle}
                </Text>
              ) : null}
            </Card>
          )}
          ListEmptyComponent={<EmptyState title="未解析到章节" />}
        />
      )}
    </Screen>
  );
};

const styles = StyleSheet.create({
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.lg },
  importBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderRadius: 8,
    marginTop: spacing.md,
  },
  importText: { fontSize: 14, fontWeight: '600' },
  list: { flex: 1, padding: spacing.lg },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  position: { fontSize: 12, fontWeight: '600' },
  excluded: { fontSize: 12 },
  chapterTitle: { fontSize: 16, fontWeight: '600', marginTop: 4 },
  meta: { fontSize: 12, marginTop: 4 },
  volume: { fontSize: 12, marginTop: 2 },
});

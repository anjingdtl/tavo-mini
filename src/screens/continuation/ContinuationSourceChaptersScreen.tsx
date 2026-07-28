/**
 * Continuation source chapters — read-only chapter list + import entry
 * (Spec §8.3, §12.2).
 *
 * Phase 1 scope: list the parsed source chapters (read-only) and provide the
 * TXT-import entry point. Chapter preview editing (merge/split/rename/exclude)
 * is supported via the import preview flow; this screen focuses on viewing an
 * already-active source. AI 续写 entries are gated until a source is active.
 */
import React, { useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Upload } from 'lucide-react-native';
import { useFocusEffect } from '@react-navigation/native';
import {
  errorCodes,
  isErrorWithCode,
  keepLocalCopy,
  pick,
  types,
} from '@react-native-documents/picker';
import Toast from 'react-native-toast-message';
import { Button, Card, EmptyState, Header, Screen, spacing } from '../../components/ui';
import { useProjectStore } from '../../store/projectStore';
import { useThemeStore } from '../../store/themeStore';
import {
  cancelContinuationImport,
  confirmContinuationSource,
  getActiveContinuationSource,
  getActiveImportJob,
  previewParsedSource,
  resumeContinuationImport,
  startContinuationImport,
} from '../../services/continuation/continuationImportService';
import type { ImportJob } from '../../services/continuation/continuationImportService';
import {
  getChaptersBySource,
} from '../../services/continuation/continuationSourceRepository';
import type { ContinuationSource, ContinuationSourceChapter } from '../../services/continuation/types';
import { requireContinuationTextImport } from '../../native/ContinuationTextImportModule';

/**
 * If encoding detection confidence is low (< 0.7, e.g. a BOM-less file that
 * could be GBK or UTF-8), prompt the user to confirm the encoding before the
 * full parse. Returns:
 *   - undefined → proceed with auto-detection
 *   - a string   → user-confirmed encoding override (e.g. 'gb18030')
 *   - null       → user cancelled the whole import
 */
function confirmEncodingIfNeeded(localPath: string): Promise<string | undefined | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: string | undefined | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    requireContinuationTextImport()
      .detectEncoding(localPath)
      .then(detected => {
        if (detected.confidence >= 0.7) {
          finish(undefined);
          return;
        }
        Alert.alert(
          '编码不确定',
          `自动探测为「${detected.encoding}」（置信度低）。若解析后出现乱码，请选择其他编码重试。`,
          [
            { text: '取消', style: 'cancel', onPress: () => finish(null) },
            { text: '使用 UTF-8', onPress: () => finish('utf-8') },
            { text: '使用 GBK', onPress: () => finish('gb18030') },
            { text: '按探测继续', onPress: () => finish(undefined) },
          ],
        );
      })
      .catch(() => finish(undefined)); // detection failure is handled by the import pipeline
    });
}

export const ContinuationSourceChaptersScreen: React.FC<{
  navigation: { navigate: (screen: string, params?: any) => void; goBack: () => void };
}> = ({ navigation }) => {
  const { theme } = useThemeStore();
  const { currentProject } = useProjectStore();
  const [source, setSource] = useState<ContinuationSource | null>(null);
  const [chapters, setChapters] = useState<ContinuationSourceChapter[]>([]);
  const [importing, setImporting] = useState(false);
  // A job left interrupted (app killed mid-import) that the user can resume or
  // cancel. Surfaced as a card above the chapter list / import entry.
  const [interruptedJob, setInterruptedJob] = useState<ImportJob | null>(null);

  const reload = async () => {
    if (!currentProject) return;
    try {
      const [src, job] = await Promise.all([
        getActiveContinuationSource(currentProject.id),
        getActiveImportJob(currentProject.id),
      ]);
      setSource(src);
      setInterruptedJob(job && job.state === 'interrupted' ? job : null);
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

  // Reload on focus so returning from a child flow (or the app returning to the
  // foreground after a kill) reflects the committed source / interrupted job.
  // reload closes over currentProject?.id; we only want to re-subscribe when the
  // project changes, so the dependency is the id rather than reload itself.
  const reloadOnFocus = React.useCallback(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id]);
  useFocusEffect(reloadOnFocus);

  const handleResume = async () => {
    if (!interruptedJob) return;
    setImporting(true);
    try {
      const job = await resumeContinuationImport(interruptedJob.id);
      const preview = await previewParsedSource(job.id);
      Alert.alert(
        '解析完成',
        `已识别 ${preview.chapterCount} 章、${preview.detectedEncoding} 编码。\n将以原著末尾作为默认续写起点；之后可在“续写起点”中调整。`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '确认导入',
            onPress: async () => {
              try {
                await confirmContinuationSource(job.id, { mode: 'end_of_source' });
                await reload();
                Toast.show({ type: 'success', text1: '原著导入完成' });
              } catch (e: any) {
                Toast.show({ type: 'error', text1: '确认导入失败', text2: e?.message });
              }
            },
          },
        ],
      );
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '恢复导入失败', text2: e?.message });
    } finally {
      setImporting(false);
    }
  };

  const handleCancelJob = () => {
    if (!interruptedJob) return;
    Alert.alert(
      '取消未完成的导入',
      '将清除上次未完成的原著解析数据。已导入的原著不受影响。',
      [
        { text: '保留', style: 'cancel' },
        {
          text: '取消导入',
          style: 'destructive',
          onPress: async () => {
            try {
              await cancelContinuationImport(interruptedJob.id);
              await reload();
              Toast.show({ type: 'success', text1: '已取消未完成的导入' });
            } catch (e: any) {
              Toast.show({ type: 'error', text1: '取消失败', text2: e?.message });
            }
          },
        },
      ],
    );
  };

  const handleImport = async () => {
    if (!currentProject) return;
    if (currentProject.mode !== 'continuation') {
      Alert.alert('无法导入', '只有原著续写项目可以导入原著。');
      return;
    }
    try {
      const [selected] = await pick({
        mode: 'import',
        type: [types.plainText, types.allFiles],
        allowMultiSelection: false,
      });
      if (!selected) return;
      if (selected.name && !selected.name.toLowerCase().endsWith('.txt')) {
        Alert.alert('无法导入', '请选择 .txt 格式的原著文件。');
        return;
      }
      setImporting(true);
      const [copy] = await keepLocalCopy({
        files: [{ uri: selected.uri, fileName: selected.name || 'original.txt' }],
        destination: 'cachesDirectory',
      });
      if (copy.status === 'error') {
        throw new Error(copy.copyError || '复制导入文件失败。');
      }
      const localPath = copy.localUri.replace(/^file:\/\//, '');
      // If encoding detection is low-confidence (no BOM + ambiguous bytes),
      // ask the user to confirm before parsing — a wrong guess yields garbled
      // text or a decode_failed error. Spec §10.1 sets the threshold at 0.7.
      const encodingOverride = await confirmEncodingIfNeeded(localPath);
      if (encodingOverride === null) return; // user cancelled
      const job = await startContinuationImport({
        projectId: currentProject.id,
        localPath,
        originalFileName: selected.name || 'original.txt',
        ...(encodingOverride ? { encodingOverride } : {}),
      });
      const preview = await previewParsedSource(job.id);
      Alert.alert(
        '解析完成',
        `已识别 ${preview.chapterCount} 章、${preview.detectedEncoding} 编码。\n将以原著末尾作为默认续写起点；之后可在“续写起点”中调整。`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '确认导入',
            onPress: async () => {
              try {
                await confirmContinuationSource(job.id, { mode: 'end_of_source' });
                await reload();
                Toast.show({ type: 'success', text1: '原著导入完成' });
              } catch (e: any) {
                Toast.show({ type: 'error', text1: '确认导入失败', text2: e?.message });
              }
            },
          },
        ],
      );
    } catch (e: any) {
      if (isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) return;
      Toast.show({ type: 'error', text1: '导入失败', text2: e?.message || '请重试' });
    } finally {
      setImporting(false);
    }
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
      {interruptedJob ? (
        <View style={styles.interruptedWrap}>
          <Card>
            <Text style={[styles.interruptedTitle, { color: theme.colors.textPrimary }]}>
              上次导入未完成
            </Text>
            <Text style={[styles.interruptedDesc, { color: theme.colors.textSecondary }]}>
              原著解析在上次进行中被中断（{interruptedJob.stage ?? '未知阶段'}）。你可以从私有副本继续解析，或取消并重新导入。
            </Text>
            <View style={styles.interruptedActions}>
              <Button
                label="继续导入"
                onPress={() => handleResume().catch(() => {})}
                disabled={importing}
              />
              <Button
                label="取消"
                variant="ghost"
                onPress={handleCancelJob}
                disabled={importing}
              />
            </View>
          </Card>
        </View>
      ) : null}
      {!source ? (
        <View style={styles.empty}>
          <EmptyState
            title="尚未导入原著"
            description="导入 TXT 原著后，解析出的章节会显示在这里（只读）。"
          />
          <TouchableOpacity
            accessibilityLabel="导入 TXT 原著"
            onPress={() => handleImport().catch(() => {})}
            disabled={importing}
            style={[styles.importBtn, { borderColor: theme.colors.accent }]}
          >
            <Upload size={16} color={theme.colors.accent} />
            <Text style={[styles.importText, { color: theme.colors.accent }]}>{importing ? '正在解析…' : '导入 TXT 原著'}</Text>
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
  interruptedWrap: { padding: spacing.lg, paddingBottom: 0 },
  interruptedTitle: { fontSize: 16, fontWeight: '700', marginBottom: spacing.xs },
  interruptedDesc: { fontSize: 13, lineHeight: 20, marginBottom: spacing.md },
  interruptedActions: { flexDirection: 'row', gap: spacing.sm },
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

/**
 * Continuation source ordering preview (Spec §2026-07-31 multi-txt import).
 *
 * Shown when the user picks multiple TXT files in ContinuationSourceChaptersScreen.
 * Samples head/tail of each file via the native chunked decoder, asks the LLM
 * ordering service for a suggested order, then lets the user adjust (up/down/
 * remove) before confirming and kicking off the multi-file import pipeline.
 *
 * Phase 1 scope: order is applied to the import batch; the pipeline itself
 * concatenates files in the chosen order and tags chunks/chapters with
 * `file_index` provenance (Task 4).
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { ChevronDown, ChevronUp, Check, X } from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import { Button, Card, EmptyState, Header, Screen, spacing } from '../../components/ui';
import { useThemeStore } from '../../store/themeStore';
import { useSettingsStore } from '../../store/settingsStore';
import {
  orderSourceFiles,
  type OrderingResult,
} from '../../services/continuation/continuationOrderingService';
import {
  confirmContinuationSource,
  previewParsedSource,
  startContinuationImport,
} from '../../services/continuation/continuationImportService';
import { unlinkPickerTempCopies } from '../../services/continuation/continuationPickerTempLifecycle';
import { requireContinuationTextImport } from '../../native/ContinuationTextImportModule';

interface RouteFile {
  localPath: string;
  originalFileName: string;
  detectedEncoding: string;
  fileSizeBytes: number;
  encodingOverride?: string;
}

interface FileItem extends RouteFile {
  headSample: string;
  tailSample: string;
}

export const ContinuationSourceOrderingScreen: React.FC<{
  route: { params: { projectId: number; files: RouteFile[] } };
  navigation: { navigate: (screen: string, params?: unknown) => void; goBack: () => void };
}> = ({ route, navigation }) => {
  const { theme } = useThemeStore();
  const settings = useSettingsStore();
  const { projectId, files: rawFiles } = route.params;

  const [files, setFiles] = useState<FileItem[]>(
    rawFiles.map(f => ({ ...f, headSample: '', tailSample: '' })),
  );
  const [ordering, setOrdering] = useState<OrderingResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

  // Sample ~1500 chars from head and tail of each file using the native
  // chunked decoder. Tail sampling seeks to `fileSizeBytes - SAMPLE_BYTES`
  // (clamped to 0) so we read the final bytes regardless of length.
  const sampleFile = useCallback(
    async (
      localPath: string,
      fileSizeBytes: number,
      detectedEncoding: string,
    ): Promise<{ headSample: string; tailSample: string }> => {
      const mod = requireContinuationTextImport();
      // ~1500 CJK chars ≈ 4500 bytes UTF-8; 4096 keeps reads cheap.
      const SAMPLE_BYTES = 4096;
      let headSample = '';
      let tailSample = '';
      try {
        const headDecoded = await mod.decodeChunk(
          localPath,
          detectedEncoding,
          0,
          SAMPLE_BYTES,
          null,
        );
        headSample = headDecoded.text;
      } catch {
        // sampling is best-effort; LLM can still work from filename + size
      }
      try {
        const tailOffset = Math.max(0, fileSizeBytes - SAMPLE_BYTES);
        const tailDecoded = await mod.decodeChunk(
          localPath,
          detectedEncoding,
          tailOffset,
          SAMPLE_BYTES,
          null,
        );
        tailSample = tailDecoded.text;
      } catch {
        // ignore
      }
      return { headSample, tailSample };
    },
    [],
  );

  // Initialize: sample each file then run LLM ordering (or fall back to
  // filename sort when no LLM is configured). Runs once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let samplingFailedCount = 0;
        const sampled = await Promise.all(
          rawFiles.map(async f => {
            const { headSample, tailSample } = await sampleFile(
              f.localPath,
              f.fileSizeBytes,
              f.detectedEncoding,
            );
            if (!headSample && !tailSample) samplingFailedCount += 1;
            return { ...f, headSample, tailSample };
          }),
        );
        if (cancelled) return;
        if (samplingFailedCount > 0) {
          // 2026-08-01 修复：采样失败不再完全静默，提示用户将仅按文件名排序。
          Toast.show({
            type: 'info',
            text1: '部分文件预览失败',
            text2: '将仅按文件名排序',
          });
        }
        setFiles(sampled);

        const llmConfig = settings.llmConfig;
        const hasLlm = !!llmConfig && !!llmConfig.base_url;
        if (hasLlm) {
          const result = await orderSourceFiles(
            sampled.map((f, idx) => ({
              index: idx,
              fileName: f.originalFileName,
              fileSizeBytes: f.fileSizeBytes,
              headSample: f.headSample,
              tailSample: f.tailSample,
            })),
            llmConfig.id,
          );
          if (cancelled) return;
          const ordered = result.orderedFileIndexes.map(i => sampled[i]);
          setFiles(ordered);
          setOrdering(result);
        } else {
          setOrdering({
            orderedFileIndexes: sampled.map((_, i) => i),
            confidence: 0,
            reasoning: '未配置 LLM，按选择顺序排列',
            method: 'fallback_filename',
          });
        }
      } catch (e: any) {
        if (!cancelled) {
          Toast.show({ type: 'error', text1: '初始化失败', text2: e?.message });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const moveUp = useCallback((index: number) => {
    if (index === 0) return;
    setFiles(prev => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }, []);

  const moveDown = useCallback((index: number) => {
    setFiles(prev => {
      if (index >= prev.length - 1) return prev;
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  }, []);

  const removeFile = useCallback((index: number) => {
    setFiles(prev => {
      const removed = prev[index];
      if (removed?.localPath) {
        void unlinkPickerTempCopies([removed.localPath]);
      }
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  // Picker cache copies are owned by this screen after multi-file handoff.
  // Clean after durable jobDir copy, on remove, or when user presses 返回.
  // (No unmount-effect cleanup: React Strict Mode remount would delete too early.)
  const cleanupPickerCopies = useCallback((paths: string[]) => {
    void unlinkPickerTempCopies(paths.filter(Boolean));
  }, []);

  const handleBack = useCallback(() => {
    cleanupPickerCopies(files.map(f => f.localPath));
    navigation.goBack();
  }, [files, navigation, cleanupPickerCopies]);

  const handleConfirm = useCallback(async () => {
    if (files.length === 0) return;
    setImporting(true);
    const pickerPaths = files.map(f => f.localPath);
    try {
      const job = await startContinuationImport({
        projectId,
        files: files.map(f => ({
          localPath: f.localPath,
          originalFileName: f.originalFileName,
          ...(f.encodingOverride ? { encodingOverride: f.encodingOverride } : {}),
        })),
      });
      // Durable copies now live under continuation-imports/<jobId>/; drop caches.
      cleanupPickerCopies(pickerPaths);
      const preview = await previewParsedSource(job.id);
      Alert.alert(
        '解析完成',
        `已识别 ${preview.chapterCount} 章、共 ${files.length} 个文件。\n将以原著末尾作为默认续写起点。`,
        [
          {
            text: '取消',
            style: 'cancel',
            // Job stays awaiting_review; chapters screen shows confirm/abandon card.
            onPress: () => {
              navigation.navigate('ContinuationSourceChapters', {});
            },
          },
          {
            text: '确认导入',
            onPress: async () => {
              try {
                await confirmContinuationSource(job.id, { mode: 'end_of_source' });
                Toast.show({ type: 'success', text1: '原著导入完成' });
                navigation.navigate('ContinuationHome', {});
              } catch (e: any) {
                Toast.show({ type: 'error', text1: '确认导入失败', text2: e?.message });
              }
            },
          },
        ],
      );
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '导入失败', text2: e?.message || '请重试' });
    } finally {
      setImporting(false);
    }
  }, [files, projectId, navigation, cleanupPickerCopies]);

  const renderItem = useCallback(
    ({ item, index }: { item: FileItem; index: number }) => {
      const isLast = index === files.length - 1;
      return (
        <Card>
          <View style={styles.fileHeader}>
            <Text style={[styles.fileIndex, { color: theme.colors.accent }]}>
              #{index + 1}
            </Text>
            <Text
              style={[styles.fileName, { color: theme.colors.textPrimary }]}
              numberOfLines={1}
            >
              {item.originalFileName}
            </Text>
            <Text style={[styles.fileSize, { color: theme.colors.textSecondary }]}>
              {(item.fileSizeBytes / 1024).toFixed(0)} KB
            </Text>
          </View>

          {item.headSample ? (
            <Text
              style={[styles.sample, { color: theme.colors.textSecondary }]}
              numberOfLines={3}
            >
              头部: {item.headSample.slice(0, 200)}...
            </Text>
          ) : null}
          {item.tailSample ? (
            <Text
              style={[styles.sample, { color: theme.colors.textSecondary }]}
              numberOfLines={3}
            >
              尾部: ...{item.tailSample.slice(-200)}
            </Text>
          ) : null}

          <View style={styles.buttonRow}>
            <TouchableOpacity
              onPress={() => moveUp(index)}
              disabled={index === 0}
              accessibilityLabel="上移"
              style={styles.iconBtn}
            >
              <ChevronUp
                size={20}
                color={index === 0 ? theme.colors.textMuted : theme.colors.accent}
              />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => moveDown(index)}
              disabled={isLast}
              accessibilityLabel="下移"
              style={styles.iconBtn}
            >
              <ChevronDown
                size={20}
                color={isLast ? theme.colors.textMuted : theme.colors.accent}
              />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => removeFile(index)}
              accessibilityLabel="移除"
              style={styles.iconBtn}
            >
              <X size={20} color={theme.colors.danger} />
            </TouchableOpacity>
          </View>
        </Card>
      );
    },
    [files.length, moveUp, moveDown, removeFile, theme.colors],
  );

  if (loading) {
    return (
      <Screen>
        <Header
          title="排序原著文件"
          action={
            <Button label="返回" variant="ghost" onPress={handleBack} />
          }
        />
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={theme.colors.accent} />
          <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
            正在分析文件顺序...
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Header
        title="排序原著文件"
        subtitle={`共 ${files.length} 个文件`}
        action={
          <Button label="返回" variant="ghost" onPress={handleBack} />
        }
      />
      <FlatList
        data={files}
        renderItem={renderItem}
        keyExtractor={(item, index) => `${item.originalFileName}-${index}`}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl }}
        ListHeaderComponent={
          ordering ? (
            <View
              style={[
                styles.noticeBar,
                { backgroundColor: theme.colors.accentSoft },
              ]}
            >
              <Text
                style={[
                  styles.noticeText,
                  {
                    color:
                      ordering.method === 'fallback_filename'
                        ? theme.colors.warning
                        : theme.colors.accent,
                  },
                ]}
              >
                {ordering.method === 'fallback_filename'
                  ? `${ordering.reasoning}，可手动调整`
                  : `LLM 排序理由: ${ordering.reasoning}`}
              </Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <EmptyState title="已移除所有文件" description="请返回重新选择原著文件。" />
        }
      />
      <View style={[styles.footer, { borderTopColor: theme.colors.border }]}>
        <Button
          label="确认顺序并导入"
          onPress={() => handleConfirm().catch(() => {})}
          disabled={importing || files.length === 0}
          icon={importing ? undefined : Check}
          flex
        />
        {importing ? (
          <ActivityIndicator size="small" color={theme.colors.accent} style={styles.spinner} />
        ) : null}
      </View>
    </Screen>
  );
};

const styles = StyleSheet.create({
  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { textAlign: 'center', marginTop: spacing.md, fontSize: 14 },
  noticeBar: {
    padding: spacing.md,
    borderRadius: 8,
    marginBottom: spacing.md,
  },
  noticeText: { fontSize: 13, lineHeight: 20 },
  fileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  fileIndex: { fontSize: 16, fontWeight: '700', marginRight: spacing.sm },
  fileName: { flex: 1, fontSize: 14, fontWeight: '600' },
  fileSize: { fontSize: 12 },
  sample: { fontSize: 12, marginBottom: 4, fontStyle: 'italic' },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: spacing.sm,
  },
  iconBtn: { padding: spacing.sm, marginLeft: spacing.sm },
  footer: {
    padding: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  spinner: { marginLeft: spacing.xs },
});

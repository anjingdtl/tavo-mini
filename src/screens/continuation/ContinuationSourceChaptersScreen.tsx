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
  isAwaitingReviewJob,
  MAX_IMPORT_FILE_BYTES,
  previewParsedSource,
  resumeContinuationImport,
  startContinuationImport,
} from '../../services/continuation/continuationImportService';
import type { ImportJob } from '../../services/continuation/continuationImportService';
import {
  getChaptersBySource,
} from '../../services/continuation/continuationSourceRepository';
import { getSourceChapterDisplayNumber } from '../../services/continuation/chapterNumbering/continuationChapterNumbering';
import type { ContinuationSource, ContinuationSourceChapter } from '../../services/continuation/types';
import { requireContinuationTextImport } from '../../native/ContinuationTextImportModule';
import { localFileUriToPath } from '../../utils/localFileUri';
import {
  mapImportErrorToUserMessage,
  formatFailedFilesList,
} from '../../services/continuation/errorMessaging';
import {
  cleanupFailedPickerCopy,
  decidePickerTempCleanup,
  unlinkPickerTempCopies,
} from '../../services/continuation/continuationPickerTempLifecycle';

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
      .catch(() => {
        // 2026-08-01 修复：探测失败不再静默吞。提示用户将按 UTF-8 兜底，
        // 避免乱码/解码失败时用户完全无感知。
        Toast.show({
          type: 'error',
          text1: '编码探测失败',
          text2: '将按 UTF-8 兜底解析，若出现乱码请改用单文件导入并手动指定编码',
        });
        finish(undefined);
      });
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
  // Active import job the user must resolve: interrupted (resume/cancel) or
  // awaiting_review (confirm/abandon). IMP-006: cancelling the parse-complete
  // Alert left awaiting_review with no UI entry — surface it here.
  const [pendingJob, setPendingJob] = useState<ImportJob | null>(null);

  const reload = async () => {
    if (!currentProject) return;
    try {
      const [src, job] = await Promise.all([
        getActiveContinuationSource(currentProject.id),
        getActiveImportJob(currentProject.id),
      ]);
      setSource(src);
      const pending =
        job &&
        (job.state === 'interrupted' ||
          job.state === 'awaiting_review' ||
          isAwaitingReviewJob(job))
          ? job
          : null;
      setPendingJob(pending);
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

  const showAwaitingReviewAlert = async (jobId: string) => {
    const preview = await previewParsedSource(jobId);
    Alert.alert(
      '解析完成',
      `已识别 ${preview.chapterCount} 章、${preview.detectedEncoding} 编码。\n将以原著末尾作为默认续写起点；之后可在“续写起点”中调整。`,
      [
        {
          text: '取消',
          style: 'cancel',
          // Keep awaiting_review but refresh so the pending card is visible.
          onPress: () => {
            void reload();
          },
        },
        {
          text: '确认导入',
          onPress: async () => {
            try {
              await confirmContinuationSource(jobId, { mode: 'end_of_source' });
              await reload();
              Toast.show({ type: 'success', text1: '原著导入完成' });
            } catch (e: any) {
              Toast.show({
                type: 'error',
                text1: '确认导入失败',
                text2: e?.message,
              });
            }
          },
        },
      ],
    );
  };

  const handleResume = async () => {
    // Mid-pipeline interrupt only — awaiting_review uses confirm path below.
    if (!pendingJob || pendingJob.state !== 'interrupted') return;
    if (isAwaitingReviewJob(pendingJob)) return;
    setImporting(true);
    try {
      const job = await resumeContinuationImport(pendingJob.id);
      await showAwaitingReviewAlert(job.id);
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '恢复导入失败', text2: e?.message });
    } finally {
      setImporting(false);
    }
  };

  const handleConfirmPendingReview = async () => {
    if (!pendingJob || !isAwaitingReviewJob(pendingJob)) return;
    setImporting(true);
    try {
      // Works for true awaiting_review and for legacy cold-start rows where
      // state was wrongly flipped to interrupted while stage stayed awaiting_review.
      await showAwaitingReviewAlert(pendingJob.id);
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '加载解析结果失败', text2: e?.message });
    } finally {
      setImporting(false);
    }
  };

  const handleCancelJob = () => {
    if (!pendingJob) return;
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
              await cancelContinuationImport(pendingJob.id);
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
    // 声明在 try 外：finally 决定是否清理 cachesDirectory 临时副本。
    // 多文件会把路径交给排序页，此时必须保留副本（IMP-003 回归）。
    const fileInfos: Array<{
      localPath: string;
      originalFileName: string;
      encodingOverride?: string;
      detectedEncoding: string;
      fileSizeBytes: number;
    }> = [];
    let handedOffToOrdering = false;
    // 部分失败弹窗把所有权推迟到用户点「继续/取消」，期间不可 finally 删除。
    let deferredPartialDecision = false;
    try {
      const selected = await pick({
        mode: 'import',
        type: [types.plainText, types.allFiles],
        allowMultiSelection: true,
      });
      if (!selected || selected.length === 0) return;

      // 全部必须是 .txt
      for (const f of selected) {
        if (f.name && !f.name.toLowerCase().endsWith('.txt')) {
          Alert.alert('无法导入', `文件 ${f.name} 不是 .txt 格式，请只选择 TXT 文件。`);
          return;
        }
      }

      setImporting(true);

      // 2026-08-01 修复：逐个 keepLocalCopy → 逐个 detectEncoding，失败文件
      // 收集到 failedFiles 而不是 throw 中止整批；keepLocalCopy 成功后立即
      // 记入 fileInfos，保证 finally 清理覆盖所有已复制副本（含后续步骤失败）。
      const proceedWithFiles = async (
        files: Array<{
          localPath: string;
          originalFileName: string;
          encodingOverride?: string;
          detectedEncoding: string;
          fileSizeBytes: number;
        }>,
      ): Promise<'ordering' | 'single' | 'none'> => {
        if (!currentProject || files.length === 0) return 'none';
        if (files.length === 1) {
          // 单文件：走原路径（durable copy 在 startContinuationImport 内完成）
          const info = files[0];
          const job = await startContinuationImport({
            projectId: currentProject.id,
            files: [
              {
                localPath: info.localPath,
                originalFileName: info.originalFileName,
                ...(info.encodingOverride
                  ? { encodingOverride: info.encodingOverride }
                  : {}),
              },
            ],
          });
          await showAwaitingReviewAlert(job.id);
          return 'single';
        }
        // 多文件：跳转排序预览页；caller 必须保留 picker 副本。
        navigation.navigate('ContinuationSourceOrdering', {
          projectId: currentProject.id,
          files: files.map(f => ({
            localPath: f.localPath,
            originalFileName: f.originalFileName,
            detectedEncoding: f.detectedEncoding,
            fileSizeBytes: f.fileSizeBytes,
            ...(f.encodingOverride
              ? { encodingOverride: f.encodingOverride }
              : {}),
          })),
        });
        return 'ordering';
      };

      const mod = requireContinuationTextImport();
      const failedFiles: Array<{ fileName: string; message: string }> = [];
      const successFiles: Array<{
        localPath: string;
        originalFileName: string;
        encodingOverride?: string;
        detectedEncoding: string;
        fileSizeBytes: number;
      }> = [];
      let userCancelled = false;
      for (const f of selected) {
        try {
          const [copy] = await keepLocalCopy({
            files: [{ uri: f.uri, fileName: f.name || 'original.txt' }],
            destination: 'cachesDirectory',
          });
          if (copy.status === 'error') {
            // IMP-004: keepLocalCopy may leave Caches/<uuid>/<name> even on
            // error (and sometimes without localUri). Always best-effort clean.
            await cleanupFailedPickerCopy({
              localUri: copy.localUri,
              originalFileName: f.name || 'original.txt',
            });
            const rawMsg = copy.copyError || `复制文件 ${f.name} 失败。`;
            // Normalize picker English message for empty files
            if (/no data was copied/i.test(rawMsg)) {
              throw new Error('文件为空或无法读取，请选择包含正文的 TXT。');
            }
            throw new Error(rawMsg);
          }
          const localPath = localFileUriToPath(copy.localUri);
          // 立即登记副本路径（占位数据），finally / 排序页负责清理
          const info: {
            localPath: string;
            originalFileName: string;
            encodingOverride?: string;
            detectedEncoding: string;
            fileSizeBytes: number;
          } = {
            localPath,
            originalFileName: f.name || 'original.txt',
            detectedEncoding: '',
            fileSizeBytes: 0,
          };
          fileInfos.push(info);
          // If encoding detection is low-confidence (no BOM + ambiguous bytes),
          // ask the user to confirm before parsing — a wrong guess yields garbled
          // text or a decode_failed error. Spec §10.1 sets the threshold at 0.7.
          const encodingOverride = await confirmEncodingIfNeeded(localPath);
          if (encodingOverride === null) {
            userCancelled = true; // 用户取消整个导入
            break;
          }
          const detected = await mod.detectEncoding(localPath);
          const detectedEncoding = encodingOverride ?? detected.encoding;
          const meta = await mod.readFileMeta(localPath);
          info.detectedEncoding = detectedEncoding;
          info.fileSizeBytes = meta.fileSizeBytes;
          if (encodingOverride) info.encodingOverride = encodingOverride;
          successFiles.push(info);
        } catch (e: any) {
          const mapped = mapImportErrorToUserMessage(
            e?.errorCode,
            e?.message || '未知错误',
          );
          const detail = mapped.suggestion
            ? `${mapped.title}（${mapped.suggestion}）`
            : mapped.title;
          failedFiles.push({
            fileName: f.name || 'original.txt',
            message: detail,
          });
        }
      }
      if (userCancelled) return; // finally 会清理已复制副本

      // 总大小预检（仅对成功读取的文件）
      const totalSize = successFiles.reduce((s, f) => s + f.fileSizeBytes, 0);
      if (totalSize > MAX_IMPORT_FILE_BYTES) {
        const mb = (MAX_IMPORT_FILE_BYTES / (1024 * 1024)).toFixed(0);
        Alert.alert('无法导入', `原著总大小超过 ${mb} MB 限制。`);
        return;
      }

      // 汇总失败清单：全部成功 → 直接继续；部分成功 → 提供继续选项；
      // 全部失败 → 阻止导入。
      if (failedFiles.length > 0) {
        if (successFiles.length === 0) {
          Alert.alert('导入失败', formatFailedFilesList(failedFiles));
          return;
        }
        // 部分失败：用户决策前必须保留成功文件的 picker 副本。
        deferredPartialDecision = true;
        const successPaths = successFiles.map(f => f.localPath);
        const failedOnlyPaths = fileInfos
          .map(f => f.localPath)
          .filter(p => !successPaths.includes(p));
        // 失败文件的副本可立即清理
        void unlinkPickerTempCopies(failedOnlyPaths);
        Alert.alert(
          '部分文件导入失败',
          `成功 ${successFiles.length} 个，失败 ${failedFiles.length} 个：\n${formatFailedFilesList(failedFiles)}`,
          [
            {
              text: '取消',
              style: 'cancel',
              onPress: () => {
                void unlinkPickerTempCopies(successPaths);
              },
            },
            {
              text: '继续导入成功文件',
              onPress: () => {
                void (async () => {
                  try {
                    const outcome = await proceedWithFiles(successFiles);
                    if (outcome === 'ordering') {
                      // 排序页接管清理
                      return;
                    }
                    // 单文件：durable 已复制，清理 picker 副本
                    await unlinkPickerTempCopies(successPaths);
                  } catch (e: any) {
                    await unlinkPickerTempCopies(successPaths);
                    Toast.show({
                      type: 'error',
                      text1: '导入失败',
                      text2: e?.message || '请重试',
                    });
                  }
                })();
              },
            },
          ],
        );
        return;
      }
      const outcome = await proceedWithFiles(successFiles);
      if (outcome === 'ordering') {
        handedOffToOrdering = true;
      }
    } catch (e: any) {
      if (isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) return;
      Toast.show({ type: 'error', text1: '导入失败', text2: e?.message || '请重试' });
    } finally {
      setImporting(false);
      // 多文件排序页仍依赖 caches 副本；部分失败弹窗等待用户决策。
      // 除此之外立即清理 picker 临时副本（单文件 durable 已拷贝 / 取消 / 失败）。
      if (deferredPartialDecision) {
        return;
      }
      const decision = decidePickerTempCleanup({
        handedOffToOrdering,
        localPaths: fileInfos.map(f => f.localPath),
      });
      if (decision.action === 'unlink_now') {
        void unlinkPickerTempCopies(decision.paths);
      }
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
      {pendingJob && isAwaitingReviewJob(pendingJob) ? (
        <View style={styles.interruptedWrap}>
          <Card>
            <Text style={[styles.interruptedTitle, { color: theme.colors.textPrimary }]}>
              原著已解析，待确认
            </Text>
            <Text style={[styles.interruptedDesc, { color: theme.colors.textSecondary }]}>
              上次解析已完成但尚未确认导入。可确认设为当前原著，或放弃后重新选择文件。
            </Text>
            <View style={styles.interruptedActions}>
              <Button
                label="确认导入"
                onPress={() => handleConfirmPendingReview().catch(() => {})}
                disabled={importing}
              />
              <Button
                label="放弃"
                variant="ghost"
                onPress={handleCancelJob}
                disabled={importing}
              />
            </View>
          </Card>
        </View>
      ) : null}
      {pendingJob?.state === 'interrupted' && !isAwaitingReviewJob(pendingJob) ? (
        <View style={styles.interruptedWrap}>
          <Card>
            <Text style={[styles.interruptedTitle, { color: theme.colors.textPrimary }]}>
              上次导入未完成
            </Text>
            <Text style={[styles.interruptedDesc, { color: theme.colors.textSecondary }]}>
              原著解析在上次进行中被中断（{pendingJob.stage ?? '未知阶段'}）。你可以从私有副本继续解析，或取消并重新导入。
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
                  第 {getSourceChapterDisplayNumber(item.position)} 章
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

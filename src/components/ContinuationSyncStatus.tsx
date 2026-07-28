/**
 * Continuation outbox sync status card (Spec §11, fix-plan §4.3).
 *
 * Surfaces the per-project outbox health (pending / failed counts and the most
 * recent failure reason) and offers single + batch retry. Never displays the
 * prompt, chapter body, or any credentials — only the worker's short last_error
 * and the dedupe key. All async buttons guard against double-taps and reload
 * after completion.
 */
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Toast from 'react-native-toast-message';
import { Button, Card, spacing } from './ui';
import { useThemeStore } from '../store/themeStore';
import {
  getOutboxSummary,
  listOutboxForProject,
  retryContinuationOutbox,
  retryFailedContinuationOutbox,
  processContinuationOutbox,
  type ContinuationOutboxItem,
} from '../services/continuation/generation';

const OPERATION_LABELS: Record<string, string> = {
  extract_state: '状态提取',
  apply_event: '状态应用',
  rebuild_story_memory: '记忆重建',
};

export const ContinuationSyncStatus: React.FC<{ projectId: number | null }> = ({
  projectId,
}) => {
  const { theme } = useThemeStore();
  const colors = theme.colors;
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<{
    pendingCount: number;
    failedCount: number;
    lastError: string | null;
  } | null>(null);
  const [failedRows, setFailedRows] = useState<ContinuationOutboxItem[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (projectId == null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const s = await getOutboxSummary(projectId);
      setSummary(s);
      const rows = await listOutboxForProject(projectId, 'failed');
      setFailedRows(rows);
    } catch {
      // keep last known state; the card is informational
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useFocusEffect(
    useCallback(() => {
      reload().catch(() => {});
    }, [reload]),
  );

  const doRetryOne = async (id: string) => {
    setBusy(true);
    try {
      const ok = await retryContinuationOutbox(id);
      if (!ok) {
        Toast.show({ type: 'info', text1: '该任务当前不可重试' });
      } else {
        // Kick the worker so the retried row is processed promptly. This is
        // acceleration only; reliable delivery is the outbox + cold-start path.
        processContinuationOutbox({ limit: 3 }).catch(() => {});
        Toast.show({ type: 'success', text1: '已重新加入队列' });
      }
      await reload();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '重试失败', text2: e?.message });
    } finally {
      setBusy(false);
    }
  };

  const doRetryAll = async () => {
    if (projectId == null) return;
    setBusy(true);
    try {
      const n = await retryFailedContinuationOutbox(projectId);
      processContinuationOutbox({ limit: 10 }).catch(() => {});
      Toast.show({
        type: n > 0 ? 'success' : 'info',
        text1: n > 0 ? `已重新加入 ${n} 个任务` : '没有可重试的失败任务',
      });
      await reload();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '批量重试失败', text2: e?.message });
    } finally {
      setBusy(false);
    }
  };

  if (projectId == null) return null;

  const pending = summary?.pendingCount ?? 0;
  const failed = summary?.failedCount ?? 0;
  // Hide the card entirely when there is nothing to surface.
  if (!loading && pending === 0 && failed === 0) return null;

  return (
    <Card>
      <Text style={[styles.h, { color: colors.textPrimary }]}>状态同步</Text>
      {loading ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <>
          <View style={styles.row}>
            <Text style={[styles.meta, { color: colors.textSecondary }]}>
              待处理 {pending}
            </Text>
            <Text
              style={[
                styles.meta,
                { color: failed > 0 ? colors.danger : colors.textSecondary },
              ]}
            >
              失败 {failed}
            </Text>
          </View>
          {failed > 0 && (
            <Button
              label={busy ? '处理中…' : '全部重试'}
              variant="secondary"
              onPress={doRetryAll}
              disabled={busy}
              compact
            />
          )}
          {failedRows.slice(0, 5).map(r => (
            <View key={r.id} style={styles.failedRow}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.meta, { color: colors.textSecondary }]}>
                  {OPERATION_LABELS[r.operation] ?? r.operation} ·{' '}
                  {r.dedupeKey.slice(0, 24)}
                </Text>
                <Text
                  style={[styles.error, { color: colors.danger }]}
                  numberOfLines={2}
                >
                  {r.lastError ?? '未知错误'}
                </Text>
              </View>
              <Button
                label="重试"
                variant="ghost"
                onPress={() => doRetryOne(r.id)}
                disabled={busy}
                compact
              />
            </View>
          ))}
        </>
      )}
    </Card>
  );
};

const styles = StyleSheet.create({
  h: { fontSize: 15, fontWeight: '600', marginBottom: spacing.xs },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.xs,
  },
  meta: { fontSize: 13 },
  failedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  error: { fontSize: 12, marginTop: 2 },
});

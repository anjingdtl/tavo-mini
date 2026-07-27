/**
 * Continuation generation result page (Spec §10.2).
 * Independent from freeform PipelineResultScreen adoption path.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { Button, Header, Screen, spacing } from '../../components/ui';
import { useThemeStore } from '../../store/themeStore';
import {
  abandonRun,
  adoptArtifactAsDraft,
  getLatestArtifact,
  getPlan,
  getRunById,
  listChecksForArtifact,
  summarizeTrace,
  type ContinuationCheckResult,
  type ContinuationGenerationRun,
  type ContinuationPlan,
} from '../../services/continuation/generation';
import { ContinuationConflictError } from '../../services/continuation/generation/types';

interface Props {
  runId: string;
  onClose: () => void;
}

export const ContinuationResultScreen: React.FC<Props> = ({
  runId,
  onClose,
}) => {
  const { theme } = useThemeStore();
  const colors = theme.colors;
  const [loading, setLoading] = useState(true);
  const [run, setRun] = useState<ContinuationGenerationRun | null>(null);
  const [plan, setPlan] = useState<ContinuationPlan | null>(null);
  const [body, setBody] = useState('');
  const [checks, setChecks] = useState<ContinuationCheckResult[]>([]);
  const [traceSummary, setTraceSummary] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getRunById(runId);
      setRun(r);
      if (!r) return;
      const p = await getPlan(runId);
      setPlan(p?.plan ?? null);
      const art = await getLatestArtifact(runId);
      setBody(art?.content ?? '');
      if (art) {
        setChecks(await listChecksForArtifact(runId, art.id));
      }
      if (r.contextTraceJson) {
        try {
          setTraceSummary(summarizeTrace(JSON.parse(r.contextTraceJson)));
        } catch {
          setTraceSummary('');
        }
      }
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    reload().catch(() => setLoading(false));
  }, [reload]);

  const doAdopt = async (force = false) => {
    setBusy(true);
    try {
      await adoptArtifactAsDraft({ runId, forceOverwrite: force });
      Toast.show({ type: 'success', text1: '已采纳为章节草稿' });
      onClose();
    } catch (e: any) {
      if (e instanceof ContinuationConflictError) {
        Alert.alert('章节已变更', e.message, [
          { text: '取消', style: 'cancel' },
          {
            text: '仍要覆盖',
            style: 'destructive',
            onPress: () => {
              doAdopt(true).catch(() => {});
            },
          },
        ]);
      } else {
        Toast.show({
          type: 'error',
          text1: '采纳失败',
          text2: e?.message,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const doAbandon = async () => {
    setBusy(true);
    try {
      await abandonRun(runId);
      Toast.show({ type: 'info', text1: '已放弃本次续写' });
      onClose();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '放弃失败', text2: e?.message });
    } finally {
      setBusy(false);
    }
  };

  const headerAction = (
    <Button label="返回" variant="ghost" onPress={onClose} />
  );

  if (loading) {
    return (
      <Screen>
        <Header title="AI 续写结果" action={headerAction} />
        <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />
      </Screen>
    );
  }

  if (!run) {
    return (
      <Screen>
        <Header title="AI 续写结果" action={headerAction} />
        <Text style={{ color: colors.textPrimary, padding: spacing.md }}>
          找不到续写任务 {runId}
        </Text>
      </Screen>
    );
  }

  const blocking = checks.filter(
    c => c.severity === 'blocking' && c.resolutionStatus === 'open',
  ).length;
  const errors = checks.filter(
    c => c.severity === 'error' && c.resolutionStatus === 'open',
  ).length;
  const warnings = checks.filter(
    c => c.severity === 'warning' && c.resolutionStatus === 'open',
  ).length;

  return (
    <Screen>
      <Header title="AI 续写结果" action={headerAction} />
      <ScrollView contentContainerStyle={styles.pad}>
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          run={run.id} · state={run.state} · stage={run.stage}
        </Text>
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          Canon {run.canonSnapshotId?.slice(0, 10)} @r{run.canonRevision}
        </Text>
        {!!traceSummary && (
          <Text style={[styles.trace, { color: colors.textSecondary }]}>
            Context: {traceSummary}
          </Text>
        )}
        {plan && (
          <View style={styles.block}>
            <Text style={[styles.h, { color: colors.textPrimary }]}>规划</Text>
            <Text style={{ color: colors.textPrimary }}>{plan.chapterGoal}</Text>
            <Text style={{ color: colors.textSecondary }}>
              冲突：{plan.centralConflict}
            </Text>
          </View>
        )}
        <View style={styles.block}>
          <Text style={[styles.h, { color: colors.textPrimary }]}>
            一致性 · blocking {blocking} · error {errors} · warning {warnings}
          </Text>
          {checks.slice(0, 30).map(c => (
            <Text
              key={c.id}
              style={{ color: colors.textPrimary, marginBottom: 6, fontSize: 13 }}
            >
              [{c.severity}/{c.category}] {c.description}
              {c.evidenceIds.length
                ? ` · 证据#${c.evidenceIds.join(',')}`
                : ' · 无证据(推测)'}
            </Text>
          ))}
          {checks.length === 0 && (
            <Text style={{ color: colors.textSecondary }}>暂无检查结果</Text>
          )}
        </View>
        <View style={styles.block}>
          <Text style={[styles.h, { color: colors.textPrimary }]}>正文预览</Text>
          <Text style={{ color: colors.textPrimary }}>
            {body || '（尚无正文）'}
          </Text>
        </View>
        <View style={styles.actions}>
          <Button
            label={busy ? '处理中…' : '采纳为草稿'}
            onPress={() => doAdopt(false)}
            disabled={busy || !body || run.state === 'completed'}
          />
          <Button
            label="放弃"
            variant="secondary"
            onPress={doAbandon}
            disabled={busy || run.state === 'completed'}
          />
        </View>
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  pad: { padding: spacing.md, paddingBottom: 48 },
  meta: { fontSize: 12, marginBottom: 4 },
  trace: { fontSize: 11, marginBottom: 12 },
  block: { marginBottom: 16 },
  h: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  actions: { gap: 12, marginTop: 8 },
});

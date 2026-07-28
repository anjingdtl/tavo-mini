/**
 * Continuation generation result page (Spec §10.2, fix-plan §4).
 * Independent from freeform PipelineResultScreen adoption path.
 *
 * Branches on run.state so the user can complete every workflow the services
 * already support:
 *  - awaiting_user + pending plan → confirm plan and continue, or abandon
 *  - interrupted (app was killed) → resume from the last persisted stage, or abandon
 *  - failed → short error + retry guidance (no prompt/body/credentials)
 *  - outdated (Source/Canon changed) → adoption blocked, re-launch against latest
 *  - awaiting_user with an artifact → adopt as draft / abandon (original path)
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
import { Button, Card, Header, Screen, spacing } from '../../components/ui';
import { useThemeStore } from '../../store/themeStore';
import {
  abandonRun,
  adoptArtifactAsDraft,
  confirmPlanAndContinue,
  getLatestArtifact,
  getPlan,
  getRunById,
  listChecksForArtifact,
  resumeInterruptedRun,
  summarizeTrace,
  type ContinuationCheckResult,
  type ContinuationGenerationRun,
  type ContinuationPlan,
} from '../../services/continuation/generation';
import {
  ContinuationConflictError,
  ContinuationOutdatedError,
} from '../../services/continuation/generation/types';

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
  const [planConfirmationStatus, setPlanConfirmationStatus] = useState<string | null>(null);
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
      setPlanConfirmationStatus(p?.confirmationStatus ?? null);
      const art = await getLatestArtifact(runId);
      setBody(art?.content ?? '');
      if (art) {
        setChecks(await listChecksForArtifact(runId, art.id));
      } else {
        setChecks([]);
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
      } else if (e instanceof ContinuationOutdatedError) {
        Toast.show({
          type: 'error',
          text1: '续写已过期',
          text2: '原著或 Canon 已更新，请按最新版本重新发起。',
        });
        await reload();
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

  const doConfirmPlan = async () => {
    setBusy(true);
    try {
      await confirmPlanAndContinue(runId);
      Toast.show({ type: 'success', text1: '已确认规划，继续生成' });
      await reload();
    } catch (e: any) {
      // Never expose prompt/body/credentials; only the short service message.
      Toast.show({ type: 'error', text1: '确认失败', text2: e?.message });
    } finally {
      setBusy(false);
    }
  };

  const doResume = async () => {
    setBusy(true);
    try {
      await resumeInterruptedRun(runId);
      Toast.show({ type: 'success', text1: '已从上次中断处继续' });
      await reload();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '恢复失败', text2: e?.message });
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

  const renderPlan = () => {
    if (!plan) return null;
    return (
      <View style={styles.block}>
        <Text style={[styles.h, { color: colors.textPrimary }]}>规划</Text>
        <Text style={{ color: colors.textPrimary }}>{plan.chapterGoal}</Text>
        <Text style={{ color: colors.textSecondary }}>
          冲突：{plan.centralConflict}
        </Text>
        {plan.beats.length > 0 && (
          <Text style={{ color: colors.textSecondary, marginTop: 4 }}>
            节拍：{plan.beats.map(b => b.summary).join(' / ')}
          </Text>
        )}
        {plan.risks.length > 0 && (
          <View style={{ marginTop: 6 }}>
            <Text style={[styles.h, { color: colors.textPrimary, fontSize: 13 }]}>
              风险项
            </Text>
            {plan.risks.map((r, i) => (
              <Text
                key={i}
                style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 2 }}
              >
                [{r.severity}] {r.description}
              </Text>
            ))}
          </View>
        )}
      </View>
    );
  };

  const renderChecks = () => (
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
  );

  const renderBodyPreview = () => (
    <View style={styles.block}>
      <Text style={[styles.h, { color: colors.textPrimary }]}>正文预览</Text>
      <Text style={{ color: colors.textPrimary }}>
        {body || '（尚无正文）'}
      </Text>
    </View>
  );

  // ---- state-driven branches (fix-plan §4.1) ----
  const renderStateBranch = () => {
    if (run.state === 'outdated') {
      return (
        <Card>
          <Text style={[styles.h, { color: colors.danger }]}>
            续写已过期
          </Text>
          <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
            原著源或 Canon 快照已更新，本次生成的上下文不再有效，无法采纳。
            请按最新的原著与 Canon 重新发起续写。
          </Text>
          <Button label="返回" variant="secondary" onPress={onClose} disabled={busy} />
        </Card>
      );
    }

    if (run.state === 'failed') {
      // Show only the short service message; never prompt/body/credentials.
      return (
        <Card>
          <Text style={[styles.h, { color: colors.danger }]}>生成失败</Text>
          <Text style={{ color: colors.textSecondary, marginBottom: spacing.sm }}>
            {run.errorMessage || `错误码：${run.errorCode ?? '未知'}`}
          </Text>
          {run.errorCode === 'continuation_capability_blocked' && (
            <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
              Canon 快照不一致或未就绪，请重新分析原著后再发起。
            </Text>
          )}
          {run.errorCode === 'cold_start' ? (
            <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
              应用重启中断了生成，可从此前阶段恢复。
            </Text>
          ) : (
            <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
              请检查模型配置与网络后重新发起。
            </Text>
          )}
          <View style={styles.actions}>
            {run.errorCode === 'cold_start' && (
              <Button
                label={busy ? '处理中…' : '从此阶段继续'}
                onPress={doResume}
                disabled={busy}
              />
            )}
            <Button
              label="放弃"
              variant="secondary"
              onPress={doAbandon}
              disabled={busy}
            />
          </View>
        </Card>
      );
    }

    if (run.state === 'interrupted') {
      return (
        <Card>
          <Text style={[styles.h, { color: colors.textPrimary }]}>
            生成已中断
          </Text>
          <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
            应用上次退出时停留在「{stageLabel(run.stage)}」阶段，可从此处继续，或放弃本次续写。
          </Text>
          <View style={styles.actions}>
            <Button
              label={busy ? '处理中…' : '从此阶段继续'}
              onPress={doResume}
              disabled={busy}
            />
            <Button
              label="放弃"
              variant="secondary"
              onPress={doAbandon}
              disabled={busy}
            />
          </View>
        </Card>
      );
    }

    // awaiting_user with a pending plan needing confirmation (fix-plan §4.1)
    if (
      run.state === 'awaiting_user' &&
      run.stage === 'awaiting_user' &&
      planConfirmationStatus === 'pending' &&
      plan
    ) {
      return (
        <Card>
          <Text style={[styles.h, { color: colors.textPrimary }]}>
            等待确认规划
          </Text>
          <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
            请查看下方规划与风险，确认后将进入正文生成。
          </Text>
          {renderPlan()}
          <View style={styles.actions}>
            <Button
              label={busy ? '处理中…' : '确认并继续生成'}
              onPress={doConfirmPlan}
              disabled={busy}
            />
            <Button
              label="放弃"
              variant="secondary"
              onPress={doAbandon}
              disabled={busy}
            />
          </View>
        </Card>
      );
    }

    // awaiting_user with an adoptable artifact (original path)
    if (run.state === 'awaiting_user') {
      return (
        <View style={styles.actions}>
          <Button
            label={busy ? '处理中…' : '采纳为草稿'}
            onPress={() => doAdopt(false)}
            disabled={busy || !body}
          />
          <Button
            label="放弃"
            variant="secondary"
            onPress={doAbandon}
            disabled={busy}
          />
        </View>
      );
    }

    return null;
  };

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
        {/* Plan/checks/body shown for branches that produced them; hidden for
            failed/outdated/interrupted-before-writer to avoid stale display. */}
        {run.state !== 'outdated' &&
          run.state !== 'failed' &&
          !(run.state === 'interrupted' && !body) &&
          !(run.state === 'awaiting_user' &&
            run.stage === 'awaiting_user' &&
            planConfirmationStatus === 'pending') &&
          renderPlan()}
        {run.state !== 'outdated' &&
          run.state !== 'failed' &&
          !(run.state === 'interrupted' && !body) &&
          body.length > 0 &&
          renderChecks()}
        {run.state !== 'outdated' &&
          run.state !== 'failed' &&
          !(run.state === 'interrupted' && !body) &&
          renderBodyPreview()}
        {renderStateBranch()}
      </ScrollView>
    </Screen>
  );
};

function stageLabel(stage: string): string {
  switch (stage) {
    case 'context':
      return '上下文构建';
    case 'planner':
      return '规划';
    case 'writer':
      return '正文生成';
    case 'checker':
      return '一致性检查';
    case 'repair':
      return '修复';
    case 'awaiting_user':
      return '等待确认';
    default:
      return stage;
  }
}

const styles = StyleSheet.create({
  pad: { padding: spacing.md, paddingBottom: 48 },
  meta: { fontSize: 12, marginBottom: 4 },
  trace: { fontSize: 11, marginBottom: 12 },
  block: { marginBottom: 16 },
  h: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  actions: { gap: 12, marginTop: 8 },
});

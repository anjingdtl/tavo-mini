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
  repairContinuationArtifactOnce,
  resumeInterruptedRun,
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
  const [repairRound, setRepairRound] = useState(0);
  const [checks, setChecks] = useState<ContinuationCheckResult[]>([]);
  const [stageTelemetry, setStageTelemetry] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getRunById(runId);
      setRun(r);
      if (!r) return;
      try {
        const usage = JSON.parse(r.tokenUsageJson || '{}');
        setStageTelemetry(usage.stages ?? {});
      } catch {
        setStageTelemetry({});
      }
      const p = await getPlan(runId);
      setPlan(p?.plan ?? null);
      setPlanConfirmationStatus(p?.confirmationStatus ?? null);
      const art = await getLatestArtifact(runId);
      setBody(art?.content ?? '');
      setRepairRound(art?.stage === 'repair' ? art.repairRound : 0);
      if (art) {
        setChecks(await listChecksForArtifact(runId, art.id));
      } else {
        setChecks([]);
      }
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    reload().catch(() => setLoading(false));
  }, [reload]);

  const doAdopt = async (
    options: { forceOverwrite?: boolean; allowOpenChecks?: boolean } = {},
  ) => {
    setBusy(true);
    try {
      await adoptArtifactAsDraft({
        runId,
        forceOverwrite: options.forceOverwrite,
        allowOpenChecks: options.allowOpenChecks,
      });
      Toast.show({
        type: 'success',
        text1: options.allowOpenChecks
          ? '已按用户选择采纳风险候选'
          : '已采纳为章节草稿',
      });
      onClose();
    } catch (e: any) {
      if (e instanceof ContinuationConflictError) {
        Alert.alert('章节已变更', e.message, [
          { text: '取消', style: 'cancel' },
          {
            text: '仍要覆盖',
            style: 'destructive',
            onPress: () => {
              doAdopt({
                forceOverwrite: true,
                allowOpenChecks: options.allowOpenChecks,
              }).catch(() => {});
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
        <Header title="流水线结果" action={headerAction} />
        <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />
      </Screen>
    );
  }

  if (!run) {
    return (
      <Screen>
        <Header title="流水线结果" action={headerAction} />
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
  const overlapBlocked = checks.some(
    c =>
      c.resolutionStatus === 'open' &&
      c.severity === 'error' &&
      (c.subtype === 'source_overlap' ||
        c.subtype === 'continuation_anchor_overlap'),
  );
  const reviewBlocked = blocking + errors > 0;
  const additionalRepairUsed =
    Number(stageTelemetry.repair?.additionalRequestCount ?? 0) > 0;
  const firstRepairAttempted =
    Number(stageTelemetry.repair?.requestCount ?? 0) > 0;
  const additionalRepairAvailable =
    run.workflowVersion === 2 &&
    reviewBlocked &&
    (repairRound > 0 || firstRepairAttempted) &&
    !additionalRepairUsed;
  const repairCandidateRejected =
    stageTelemetry.repair?.warning ===
    'repair_candidate_rejected_as_over_contracted';

  const toggleExpanded = (section: string) => {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const renderPlan = () => {
    if (!plan) return null;
    return (
      <View style={styles.block}>
        <Text style={[styles.h, { color: colors.textPrimary }]}>
          {run.workflowVersion === 2 ? 'Writer 同次生成的章节计划' : '规划'}
        </Text>
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
        {plan.participatingCharacterIds.length > 0 && (
          <Text style={{ color: colors.textSecondary, marginTop: 4 }}>
            参与人物：{plan.participatingCharacterIds.join('、')}
          </Text>
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
            : c.subtype === 'source_overlap' ||
                c.subtype === 'continuation_anchor_overlap'
              ? ' · 本地确定性命中（连续原文）'
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

  const renderCompletedResult = () => {
    const planText = plan
      ? [
          plan.chapterGoal,
          `冲突：${plan.centralConflict}`,
          plan.beats.length > 0
            ? `节拍：${plan.beats.map(beat => beat.summary).join(' / ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '本次没有可展示的章节计划。';
    const checkText = checks.length
      ? checks
          .map(
            check =>
              `[${check.severity}/${check.category}] ${check.description}`,
          )
          .join('\n')
      : '一致性检查通过，无待处理问题。';
    const resultSections = [
      {
        id: 'plan',
        label: `${run.workflowVersion === 2 ? 'Writer 同次计划' : '规划'} · ${
          plan ? '成功' : '未生成'
        }`,
        text: planText,
        meta: plan
          ? run.workflowVersion === 2
            ? '与正文由同一次 Writer JSON completion 共同生成；没有独立 Planner 或确认步骤'
            : '已根据 Canon 与续写状态生成本章规划'
          : '没有可展示的章节计划',
      },
      {
        id: 'writer',
        label: `正文 · 成功 (${body.length} 字)`,
        text: body,
        meta: '已生成续写正文',
      },
      {
        id: 'checker',
        label: `一致性检查 · 成功 (${checks.length} 项)`,
        text: checkText,
        meta: `blocking ${blocking} · error ${errors} · warning ${warnings}`,
      },
    ];
    if (repairRound > 0) {
      resultSections.splice(2, 0, {
        id: 'repair',
        label: `一致性修复 · 成功 (${repairRound} 轮)`,
        text: '已根据 blocking / error 检查项生成修复版候选正文；已完成本地复核，未进行第二次 LLM 复检；采纳将写入此版本。',
        meta: '只修复冲突片段，已本地复核，未进行第二次 LLM 复检',
      });
    }

    return (
      <>
        <Text style={[styles.summary, { color: colors.textSecondary }]}>
          已完成 · Canon r{run.canonRevision}
          {repairRound > 0 ? ` · 已自动修复 ${repairRound} 轮` : ''}
          {` · 正文 ${body.length} 字`}
        </Text>
        {resultSections.map(section => (
          <View
            key={section.id}
            style={[styles.resultCard, { backgroundColor: colors.card }]}
          >
            <Button
              label={section.label}
              variant="ghost"
              onPress={() => toggleExpanded(section.id)}
            />
            <Text style={[styles.stageMeta, { color: colors.accent }]}>
              {section.meta}
            </Text>
            {expanded.has(section.id) && (
              <Text
                selectable
                style={[styles.stageText, { color: colors.textPrimary }]}
              >
                {section.text}
              </Text>
            )}
          </View>
        ))}
      </>
    );
  };

  const doAdditionalRepair = async () => {
    setBusy(true);
    try {
      await repairContinuationArtifactOnce(runId);
      Toast.show({ type: 'success', text1: '额外修正完成，已进行本地复核' });
      await reload();
    } catch (e: any) {
      Toast.show({ type: 'error', text1: '额外修正失败', text2: e?.message });
      await reload();
    } finally {
      setBusy(false);
    }
  };

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
      if (reviewBlocked) {
        return (
          <>
            <Card>
              <Text style={[styles.h, { color: colors.danger }]}>本地复核仍有待处理问题</Text>
              <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
                {overlapBlocked
                  ? 'Repair 后本地复核仍发现正文与接缝存在连续重合。你可以承担风险采纳当前候选，或确认再进行一次额外 Repair；额外 Repair 后只做本地复核，不会再次调用 LLM Checker。'
                  : repairCandidateRejected
                  ? 'Repair 返回的终稿篇幅明显坍缩，已保留完整的 Writer 正文；原检查问题仍待处理。你可以承担风险采纳当前候选，或确认再进行一次额外 Repair；额外 Repair 后只做本地复核，不会再次调用 LLM Checker。'
                  : 'Repair 后本地复核仍发现 error / blocking。你可以承担风险采纳当前候选，或确认再进行一次额外 Repair；额外 Repair 后只做本地复核，不会再次调用 LLM Checker。'}
              </Text>
              <View style={styles.actions}>
                <Button
                  label="采纳错误候选（风险自负）"
                  variant="secondary"
                  onPress={() => doAdopt({ allowOpenChecks: true })}
                  disabled={busy}
                />
                {additionalRepairAvailable && (
                  <Button
                    label="额外修正一次（增加 1 次 LLM）"
                    onPress={doAdditionalRepair}
                    disabled={busy}
                  />
                )}
                <Button
                  label="放弃并返回"
                  variant="ghost"
                  onPress={doAbandon}
                  disabled={busy}
                />
              </View>
            </Card>
            {renderChecks()}
          </>
        );
      }
      return (
        <View style={styles.decisionActions}>
          <Button
            label="放弃"
            variant="ghost"
            onPress={doAbandon}
            disabled={busy}
          />
          <Button
            label={busy ? '采纳中…' : '采纳'}
            onPress={() => doAdopt()}
            disabled={busy || !body}
          />
        </View>
      );
    }

    return null;
  };

  return (
    <Screen>
      <Header title="流水线结果" action={headerAction} />
      <ScrollView contentContainerStyle={styles.pad}>
        {run.state === 'awaiting_user' &&
        planConfirmationStatus !== 'pending' &&
        !reviewBlocked
          ? renderCompletedResult()
          : null}
        {/* Non-final branches keep their workflow-specific guidance. */}
        {run.state !== 'awaiting_user' &&
          run.state !== 'outdated' &&
          run.state !== 'failed' &&
          !(run.state === 'interrupted' && !body) &&
          renderPlan()}
        {run.state !== 'awaiting_user' &&
          run.state !== 'outdated' &&
          run.state !== 'failed' &&
          !(run.state === 'interrupted' && !body) &&
          body.length > 0 &&
          renderChecks()}
        {run.state !== 'awaiting_user' &&
          run.state !== 'outdated' &&
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
  summary: { fontSize: 13, fontWeight: '700', marginBottom: spacing.md },
  resultCard: { borderRadius: 8, padding: spacing.md, gap: spacing.sm, marginBottom: spacing.md },
  stageMeta: { fontSize: 12, fontWeight: '700' },
  stageText: { fontSize: 14, lineHeight: 22, marginTop: spacing.sm },
  block: { marginBottom: 16 },
  h: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  actions: { gap: 12, marginTop: 8 },
  // Keep the final decision in the same left-to-right order and visual weight
  // as the outline pipeline result screen: discard first, adopt second.
  decisionActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
});

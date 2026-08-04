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
  getArtifactForRun,
  getLatestArtifact,
  getLatestEligibleArtifact,
  getPlan,
  getRunById,
  listStageResults,
  listChecksForArtifact,
  repairContinuationArtifactOnce,
  resumeInterruptedRun,
  type ContinuationCheckResult,
  type ContinuationGenerationRun,
  type ContinuationGenerationStageResult,
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
  const [stageResults, setStageResults] = useState<ContinuationGenerationStageResult[]>([]);
  const [rejectedRepair, setRejectedRepair] = useState<{ content: string; rejectionCode?: string | null } | null>(null);
  const [showRejectedRepair, setShowRejectedRepair] = useState(false);
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
      const isV4 = r.workflowVersion === 4;
      const art = isV4
        ? await getLatestEligibleArtifact(runId)
        : await getLatestArtifact(runId);
      setBody(art?.content ?? '');
      setRepairRound(art?.stage === 'repair' ? art.repairRound : 0);
      if (art) {
        setChecks(await listChecksForArtifact(runId, art.id));
      } else {
        setChecks([]);
      }
      if (isV4) {
        const results = await listStageResults(runId);
        setStageResults(results);
        const repair = results.find(result => result.stage === 'repair');
        if (repair?.artifactId) {
          const candidate = await getArtifactForRun(runId, repair.artifactId);
          setRejectedRepair(
            candidate?.eligibilityStatus === 'rejected'
              ? {
                  content: candidate.content,
                  rejectionCode: candidate.rejectionCode,
                }
              : null,
          );
        } else {
          setRejectedRepair(null);
        }
      } else {
        setStageResults([]);
        setRejectedRepair(null);
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

  const v4Stage = (stage: ContinuationGenerationStageResult['stage']) =>
    stageResults.find(result => result.stage === stage) ?? null;

  const v4StageStatus = (stage: ContinuationGenerationStageResult['stage']) => {
    const result = v4Stage(stage);
    if (!result) return '未开始';
    switch (result.status) {
      case 'success':
        return '成功';
      case 'failed':
        return '降级/失败';
      case 'interrupted':
        return '已中断';
      case 'skipped':
        return '已短路';
      case 'running':
        return '进行中';
      default:
        return '排队中';
    }
  };

  const v4StageText = (stage: ContinuationGenerationStageResult['stage']) => {
    const result = v4Stage(stage);
    if (!result) return '暂无持久化结果。';
    if (stage === 'writer') {
      return body || 'Writer 尚未落库完整正文。';
    }
    if (stage === 'checker') {
      try {
        const parsed = result.outputJson ? JSON.parse(result.outputJson) : null;
        const issues = Array.isArray(parsed?.issues) ? parsed.issues : [];
        return issues.length
          ? issues.map((issue: any) => `[${issue.severity || 'warning'}] ${issue.description || '语义问题'}`).join('\n')
          : '未发现可操作的冻结 Canon/状态语义问题。';
      } catch {
        return result.errorMessage || 'Checker 结果不可解析。';
      }
    }
    if (stage === 'control') {
      try {
        const parsed = result.outputJson ? JSON.parse(result.outputJson) : null;
        const referenceTarget =
          parsed?.targetHan ?? parsed?.referenceTargetHan ?? '—';
        const actualHan = parsed?.currentHan ?? parsed?.actualWriterHan ?? '—';
        const metrics = parsed
          ? `用户参考篇幅：${referenceTarget}\n实际汉字：${actualHan}\n篇幅仅作提示，不影响候选资格`
          : '本地篇幅诊断已由客户端计算；篇幅仅作提示。';

        // Prefer explicit styleIssues / styleWarnings; fall back to findings.
        const readyList: any[] = Array.isArray(parsed?.styleIssues)
          ? parsed.styleIssues
          : Array.isArray(parsed?.findings)
            ? parsed.findings.filter((f: any) => f?.repairReady)
            : [];
        const warningList: any[] = Array.isArray(parsed?.styleWarnings)
          ? parsed.styleWarnings
          : Array.isArray(parsed?.findings)
            ? parsed.findings.filter((f: any) => !f?.repairReady)
            : [];

        const renderStyleRow = (item: any, tag: string) => {
          const dim =
            item?.styleDimension || item?.subtype || item?.dimension || 'style';
          const desc = item?.description || item?.rewriteGoal || '文风观察';
          const goal = item?.rewriteGoal || item?.suggestedFix;
          const excerpt = item?.generatedExcerpt
            ? ` 摘录：「${String(item.generatedExcerpt).slice(0, 48)}」`
            : '';
          const ready =
            item?.repairReady === true
              ? ' → 进入 Repair'
              : ' → 仅审计，不进入 Repair';
          return `[${tag}/${dim}] ${desc}${excerpt}${
            goal ? `\n  改写目标：${goal}` : ''
          }${ready}`;
        };

        const detailLines = [
          ...readyList.map((item: any) => renderStyleRow(item, '可执行')),
          ...warningList.map((item: any) => renderStyleRow(item, 'warning')),
        ];

        let mode: string;
        if (result.status === 'failed' || result.status === 'interrupted') {
          mode = `Control LLM 未完成文风审查（${
            result.errorCode || result.errorMessage || 'failed'
          }）。本地 fallback 不含强制文风任务，本 run 无 style finding 注入 Repair。`;
        } else if (detailLines.length === 0) {
          mode =
            '原著文风审查已完成：未发现可定位、可修订的局部文风问题。因此没有文风任务进入 Repair（0 项 style finding）。';
        } else {
          mode = `原著文风审查：可执行 ${readyList.length} 项，audit warning ${warningList.length} 项。\n${detailLines.join(
            '\n',
          )}`;
        }
        return `${metrics}\n${mode}`;
      } catch {
        return result.errorMessage || 'Control 结果不可解析。';
      }
    }
    if (stage === 'repair') {
      if (rejectedRepair) {
        const code = rejectedRepair.rejectionCode || 'local_final_gate_failed';
        const reasonHint =
          code.includes('partial') || code.includes('collapsed') || code.includes('summary')
            ? 'Repair 只返回了局部内容或摘要，或丢失了大量未修改正文。'
            : code.includes('compliance')
              ? 'Repair 仍保留明确问题，或未通过协议回填检查。'
              : 'Repair 未通过完整性或安全检查。';
        return `Repair 已返回候选正文，但未通过完整性或安全检查。\n${reasonHint}\n当前默认可采纳候选为 Writer 初稿。拒绝码：${code}`;
      }
      try {
        const parsed = result.outputJson ? JSON.parse(result.outputJson) : null;
        if (!parsed) return 'Repair 已完成精准最小干预修订。';
        if (result.status === 'skipped') {
          return '未发现需要自动修订的五维资料或文风问题，保留 Writer 原稿。';
        }
        const injectedChecker = parsed.injectedCheckerIssueCount ?? null;
        const appliedChecker = parsed.appliedCheckerIssueIds?.length ?? 0;
        const injectedStyle = parsed.injectedControlFindingCount ?? parsed.styleActionableIssueCount ?? null;
        const appliedStyle = parsed.appliedControlFindingIds?.length ?? parsed.appliedStyleFindingCount ?? 0;
        const writerHan = parsed.writerHan ?? null;
        const candidateHan = parsed.candidateHan ?? null;
        const parts: string[] = [
          'Repair 已完成精准修订，并通过完整章节与本地安全检查。',
          '未进行第二次 LLM 语义复核。',
        ];
        parts.push(
          injectedChecker != null
            ? `Checker：注入 ${injectedChecker} 项五维/安全任务，Repair 声明应用 ${appliedChecker} 项。`
            : `Repair 声明应用 Checker issue ${appliedChecker} 项。`,
        );
        parts.push(
          injectedStyle != null
            ? `Control：注入 ${injectedStyle} 项文风任务，Repair 声明应用 ${appliedStyle} 项。`
            : `Repair 声明应用文风 finding ${appliedStyle} 项。`,
        );
        if (writerHan != null && candidateHan != null) {
          const delta = candidateHan - writerHan;
          const sign = delta >= 0 ? '+' : '';
          parts.push(
            `用户参考篇幅 / 实际汉字：参考 ${parsed.referenceTargetHan ?? '—'}，Writer ${writerHan} → Repair ${candidateHan}（${sign}${delta}）；篇幅仅作提示，不影响候选资格。`,
          );
        }
        if (parsed.unaffectedRetentionRatio != null) {
          parts.push(
            `完整性：未涉及段落保留率 ${Math.round(parsed.unaffectedRetentionRatio * 100)}%；相对 Writer 比例 ${
              parsed.candidateToWriterHanRatio != null
                ? `${Math.round(parsed.candidateToWriterHanRatio * 100)}%`
                : '—'
            }。`,
          );
        }
        return parts.join('\n');
      } catch {
        return result.errorMessage || 'Repair 结果不可解析。';
      }
    }
    try {
      const parsed = result.outputJson ? JSON.parse(result.outputJson) : null;
      const checkSubtypes = Array.isArray(parsed?.checkSubtypes)
        ? parsed.checkSubtypes
        : [];
      const lengthWarnings = checkSubtypes.filter((subtype: unknown) =>
        typeof subtype === 'string' && subtype.startsWith('chapter_length_'),
      );
      if (parsed?.passed === false) {
        return `完整性与确定性安全检查未通过：${checkSubtypes.join('、') || '存在硬门禁问题'}。当前默认候选为 Writer。`;
      }
      if (lengthWarnings.length > 0) {
        return `已完成完整性与确定性安全检查；篇幅仅作提示（${lengthWarnings.join('、')}），不影响候选资格；未进行第二次 LLM 语义复核。`;
      }
      return '已完成完整性与确定性安全检查；未进行第二次 LLM 语义复核。';
    } catch {
      return result.errorMessage || 'Local Final Gate 尚无结果。';
    }
  };

  const renderV4StageCards = () => {
    const repairEligible =
      !rejectedRepair &&
      v4Stage('repair')?.status === 'success' &&
      v4Stage('local_verify')?.status === 'success';
    const stageDefinitions: Array<{
      id: ContinuationGenerationStageResult['stage'];
      label: string;
      meta: string;
    }> = [
      { id: 'writer', label: 'Writer', meta: '完整初稿；参考篇幅弱提示；默认文学基线候选' },
      { id: 'checker', label: 'Checker', meta: '原著五维资料一致性审查' },
      { id: 'control', label: 'Control', meta: '原著文风一致性审查' },
      { id: 'repair', label: 'Repair', meta: '精准最小干预修订，输出完整章节' },
      { id: 'local_verify', label: 'Local Final Gate', meta: '完整性与确定性安全检查' },
    ];
    return (
      <>
        <Text style={[styles.summary, { color: colors.textSecondary }]}>
          V4 FULL-Control · 物理请求 {stageResults.reduce((sum, item) => sum + item.requestCount, 0)}/4 · 默认可采纳：{rejectedRepair ? 'Writer' : repairEligible ? 'Repair' : body ? 'Writer' : '—'}
        </Text>
        {stageDefinitions.map(stage => {
          const result = v4Stage(stage.id);
          const requestText = result?.requestCount
            ? ` · ${result.requestCount} 次请求`
            : '';
          const tokenText = result &&
              (result.inputTokens != null || result.outputTokens != null)
            ? ` · token ${result.inputTokens ?? '—'}→${result.outputTokens ?? '—'}`
            : '';
          const durationText = result
            ? ` · ${formatStageDuration(result.startedAt, result.completedAt)}`
            : '';
          const label = `${stage.label} · ${v4StageStatus(stage.id)}${requestText}${tokenText}${durationText}`;
          return (
            <View
              key={stage.id}
              style={[styles.resultCard, { backgroundColor: colors.card }]}
            >
              <Button
                label={label}
                variant="ghost"
                onPress={() => toggleExpanded(`v4_${stage.id}`)}
              />
              <Text style={[styles.stageMeta, { color: colors.accent }]}>
                {stage.meta}
                {result?.errorCode ? ` · ${result.errorCode}` : ''}
              </Text>
              {expanded.has(`v4_${stage.id}`) && (
                <Text selectable style={[styles.stageText, { color: colors.textPrimary }]}>
                  {v4StageText(stage.id)}
                </Text>
              )}
            </View>
          );
        })}
      </>
    );
  };

  const renderV4StateBranch = () => {
    if (run.state === 'failed' || run.state === 'interrupted') {
      return (
        <Card>
          <Text style={[styles.h, { color: run.state === 'failed' ? colors.danger : colors.textPrimary }]}>
            {run.state === 'failed' ? 'V4 生成未完成' : 'V4 生成已中断'}
          </Text>
          <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
            {run.errorMessage || `当前阶段：${stageLabel(run.stage)}。已 reservation 的节点不会自动重发。`}
          </Text>
          <View style={styles.actions}>
            <Button label={busy ? '处理中…' : '从已持久化阶段继续'} onPress={doResume} disabled={busy} />
            <Button label="放弃" variant="secondary" onPress={doAbandon} disabled={busy} />
          </View>
        </Card>
      );
    }
    if (run.state !== 'awaiting_user') return null;
    const risk = reviewBlocked || Boolean(rejectedRepair);
    const repairEligible =
      !rejectedRepair &&
      v4Stage('repair')?.status === 'success' &&
      v4Stage('local_verify')?.status === 'success';
    return (
      <Card>
        <Text style={[styles.h, { color: risk ? colors.danger : colors.textPrimary }]}>
          {rejectedRepair ? 'Repair 被本地门禁拒绝' : risk ? '默认候选仍有待人工确认问题' : 'V4 终稿已待采纳'}
        </Text>
          <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
            {rejectedRepair
            ? 'Repair 未通过完整性或安全检查，当前默认候选为 Writer。已保留 rejected Repair 供审计；不能绕过 Local Final Gate 直接采纳。'
            : repairEligible
              ? 'Repair 已完成精准修订，并通过完整章节与本地安全检查。未进行第二次 LLM 语义复核，请在采纳前人工审阅。'
              : '未发现需要自动修订的五维资料或文风问题，或仅有篇幅/audit 提示；当前默认候选为 Writer 原稿。'}
          </Text>
        {rejectedRepair && (
          <View style={[styles.resultCard, { backgroundColor: colors.background }]}>
            <Button
              label={showRejectedRepair ? '收起被拒 Repair 候选' : '查看被拒 Repair 候选'}
              variant="secondary"
              onPress={() => setShowRejectedRepair(value => !value)}
            />
            {showRejectedRepair && (
              <Text selectable style={[styles.stageText, { color: colors.textPrimary }]}>
                {rejectedRepair.content}
              </Text>
            )}
          </View>
        )}
        <View style={styles.actions}>
          <Button
            label={risk ? '采纳当前 eligible 候选（风险自负）' : busy ? '采纳中…' : '采纳'}
            onPress={() => doAdopt({ allowOpenChecks: risk })}
            disabled={busy || !body}
          />
          <Button label="放弃并返回" variant="ghost" onPress={doAbandon} disabled={busy} />
        </View>
      </Card>
    );
  };

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
        {run.workflowVersion === 4 ? (
          <>
            {renderV4StageCards()}
            {renderV4StateBranch()}
          </>
        ) : (
          <>
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
          </>
        )}
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
    case 'auditing':
      return 'Checker/Control 并行审查';
    case 'checker':
      return '一致性检查';
    case 'control':
      return '篇幅与结构控制';
    case 'repair':
      return '修复';
    case 'local_verify':
      return '本地 Final Gate';
    case 'awaiting_user':
      return '等待确认';
    default:
      return stage;
  }
}

function formatStageDuration(
  startedAt: string | null,
  completedAt: string | null,
): string {
  if (!startedAt) return '耗时—';
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return '耗时—';
  }
  return `耗时 ${Math.max(0, end - start)}ms`;
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

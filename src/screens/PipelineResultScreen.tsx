import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Alert, BackHandler, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Header, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import {
  CommonActions,
  NavigationRouteContext,
  useNavigation,
  type NavigationProp,
  type ParamListBase,
  type RouteProp,
} from '@react-navigation/native';
import * as db from '../services/database';
import { computeInputFingerprint } from '../services/outlineContextBuilder';
import { adoptPipelineTaskResult } from '../services/multiChapterBatch/batchAdoption';
import { resumePipeline } from '../services/pipelineRunner';
import {
  resetFailedStageCheckpointsForResume,
} from '../data/repositories/pipelineStageCheckpointRepository';
import type { PipelineStageResult } from '../types/pipeline';

type ResultRouteProp = RouteProp<{ PipelineResult: { taskId: string } }, 'PipelineResult'>;

const STAGE_LABELS: Record<PipelineStageResult['stage'], string> = {
  draft: '初稿',
  review: '审阅/评估',
  factCheck: '事实核查',
  brief: '终稿 Brief',
  proof: '终稿',
};

const STATUS_LABELS: Record<PipelineStageResult['status'], string> = {
  success: '成功',
  failed: '失败',
  skipped: '已跳过',
};

/**
 * Render stage body for the result cards.
 * Audit stages must only show validated JSON reports — never raw novel prose
 * or model reasoning (those are never persisted as stage text after the audit
 * validity fix). Failed empty stages surface the structured error message.
 */
const OUTLINE_STATUS_LABELS: Record<string, string> = {
  aligned: '一致',
  partial: '部分一致',
  deviated: '偏离主线',
  over_advanced: '进度超前',
};

/**
 * One effective result per stage (prefer success > skipped > failed; last wins).
 * Result page must not guess via unbounded .find on append-only history.
 */
export function uniqueStageResults(
  stageResults: PipelineStageResult[],
): PipelineStageResult[] {
  const priority: Record<string, number> = {
    success: 50,
    skipped: 40,
    failed: 30,
  };
  const map = new Map<string, PipelineStageResult>();
  for (const row of stageResults || []) {
    if (!row?.stage) continue;
    const prev = map.get(row.stage);
    const pri = priority[row.status] ?? 0;
    const prevPri = prev ? priority[prev.status] ?? 0 : -1;
    if (!prev || pri >= prevPri) {
      map.set(row.stage, row);
    }
  }
  return ['draft', 'review', 'factCheck', 'brief', 'proof']
    .map(s => map.get(s))
    .filter(Boolean) as PipelineStageResult[];
}

/** Parse review-stage outlineAssessment for the dedicated report card. */
export function parseOutlineAssessmentFromReview(
  stageResults: PipelineStageResult[],
): {
  status: string;
  fulfilledBeats: string[];
  missingBeats: string[];
  deviations: string[];
  prematureBeats: string[];
  factRollbackRisks: string[];
} | null {
  const review = uniqueStageResults(stageResults).find(
    s => s.stage === 'review' && s.status === 'success' && s.text,
  );
  if (!review?.text) return null;
  try {
    const parsed = JSON.parse(review.text);
    const oa = parsed?.outlineAssessment;
    if (!oa || typeof oa !== 'object') return null;
    return {
      status: String(oa.status || ''),
      fulfilledBeats: Array.isArray(oa.fulfilledBeats) ? oa.fulfilledBeats : [],
      missingBeats: Array.isArray(oa.missingBeats) ? oa.missingBeats : [],
      deviations: Array.isArray(oa.deviations) ? oa.deviations : [],
      prematureBeats: Array.isArray(oa.prematureBeats) ? oa.prematureBeats : [],
      factRollbackRisks: Array.isArray(oa.factRollbackRisks)
        ? oa.factRollbackRisks
        : [],
    };
  } catch {
    return null;
  }
}

export function formatStageText(stage: PipelineStageResult): string {
  if (stage.status === 'failed' && !stage.text?.trim()) {
    return stage.error || '该阶段失败。';
  }
  if (!stage.text) {
    return stage.status === 'skipped' ? '该阶段已跳过。' : '';
  }
  if (
    stage.stage !== 'review' &&
    stage.stage !== 'factCheck' &&
    stage.stage !== 'brief'
  ) {
    return stage.text;
  }
  try {
    return JSON.stringify(JSON.parse(stage.text), null, 2);
  } catch {
    // Safety net: never dump long invalid body into the audit card.
    if (stage.text.length > 400) {
      return stage.error || '审核结果格式异常，已隐藏无效内容。';
    }
    return stage.text;
  }
}

export function summarizePipelineTokens(stageResults: PipelineStageResult[]): { inputTokens: number; totalTokens: number } {
  return stageResults.reduce(
    (summary, stage) => ({
      inputTokens: summary.inputTokens + (stage.tokens?.input || 0),
      totalTokens: summary.totalTokens + (stage.tokens?.total || 0),
    }),
    { inputTokens: 0, totalTokens: 0 },
  );
}

export interface PipelineResultScreenProps {
  taskId?: string;
  onClose?: () => void;
  onAdopted?: (text: string) => void;
}

export function closePipelineResult(
  navigation: Pick<NavigationProp<ParamListBase>, 'dispatch' | 'getState' | 'goBack'>,
  onClose?: () => void,
): void {
  if (onClose) {
    onClose();
    return;
  }

  const state = navigation.getState();
  if (state.index > 0) {
    navigation.goBack();
    return;
  }

  const fallbackRoute = state.routeNames.includes('SettingsMain')
    ? 'SettingsMain'
    : state.routeNames.includes('EditorMain')
      ? 'EditorMain'
      : null;
  if (fallbackRoute) {
    navigation.dispatch(CommonActions.reset({
      index: 0,
      routes: [{ name: fallbackRoute }],
    }));
    return;
  }

  navigation.goBack();
}

export const PipelineResultScreen: React.FC<PipelineResultScreenProps> = ({ taskId: propTaskId, onClose, onAdopted }) => {
  const { theme } = useThemeStore();
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  // Hook 必须在顶层调用：直接读取 NavigationRouteContext，避免 useRoute 在
  // 非导航上下文（Modal 模式）中抛错。用可选链安全访问 params。
  const route = useContext(NavigationRouteContext) as ResultRouteProp | undefined;
  const routeTaskId: string | undefined = route?.params?.taskId;
  const taskId = propTaskId ?? routeTaskId;
  const { tasks, resolveTask } = usePipelineTaskStore();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 10.2: 采纳进行中状态，disable 采纳/放弃按钮防止重复点击触发多次 updateChapter
  const [adopting, setAdopting] = useState(false);
  // 标记是否已被 handleAccept 标记为 accept，避免 unmount cleanup 的
  // setTimeout 与 handleAccept 的 resolveTask('accept') 竞态重复 resolve。
  const acceptedRef = useRef(false);

  const handleClose = useCallback(
    () => closePipelineResult(navigation, onClose),
    [navigation, onClose],
  );

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      handleClose();
      return true;
    });
    return () => subscription.remove();
  }, [handleClose]);

  const task = tasks.find((t) => t.id === taskId);

  // Closing this screen means “look at it later”, not “discard the result”.
  // Resolving it from unmount made a completed-but-unadopted task disappear
  // from the task centre, forcing the user to run the pipeline again.  Only
  // the explicit 放弃/采纳 actions below resolve a task.

  if (!task) {
    return (
      <Screen>
        <Header title="流水线结果" action={<Button label="返回" variant="ghost" onPress={handleClose} />} />
        <Text style={{ padding: spacing.lg, color: theme.colors.textSecondary }}>任务不存在或已被清除。</Text>
      </Screen>
    );
  }

  const { inputTokens, totalTokens } = summarizePipelineTokens(task.stageResults);
  const skippedCount = task.stageResults.filter((stage) => stage.status === 'skipped').length;
  const failedAuditCount = task.stageResults.filter(
    (stage) =>
      (stage.stage === 'review' || stage.stage === 'factCheck') &&
      stage.status === 'failed',
  ).length;
  const proofStage = uniqueStageResults(task.stageResults).find(
    stage => stage.stage === 'proof',
  );
  const duration = task.updatedAt - task.createdAt;
  const durationText = duration > 60000
    ? `${Math.floor(duration / 60000)}m ${Math.round((duration % 60000) / 1000)}s`
    : `${Math.round(duration / 1000)}s`;
  const retainedDraft =
    task.status === 'failed' && Boolean(task.finalText && task.finalText.trim());
  // 任务仍在后台运行（idle/排队/初稿/审阅/核查/终审）：结果页只展示
  // 历史阶段卡，不允许采纳/放弃（finalText 是旧初稿），也不显示重启。
  const RUNNING_STATUSES = new Set([
    'idle',
    'queued',
    'drafting',
    'reviewing',
    'factChecking',
    'briefing',
    'proofing',
  ]);
  const isRunning = RUNNING_STATUSES.has(task.status);
  const RUNNING_STAGE_LABEL: Record<string, string> = {
    idle: '准备中',
    queued: '排队中',
    drafting: '初稿生成',
    reviewing: '审阅/评估',
    factChecking: '事实核查',
    briefing: 'Brief 编译',
    proofing: '终审',
  };
  const statusSummary =
    task.status === 'completed'
      ? failedAuditCount > 0
        ? `已完成（${failedAuditCount} 项审核失败）`
        : '已完成'
      : isRunning
        ? `进行中 · ${RUNNING_STAGE_LABEL[task.status] || '运行中'}`
        : task.status === 'failed'
          ? retainedDraft
            ? '未完整完成（已保留初稿）'
            : proofStage?.status === 'failed'
              ? '终稿失败，可从失败节点重试'
              : '异常终止'
          : task.status === 'interrupted'
            ? retainedDraft
              ? '已中断（已保留初稿）'
              : '已中断，可从失败阶段继续'
            : task.status === 'cancelled'
              ? '已取消'
              : '进行中';

  const toggleExpanded = (stage: string) => {
    const next = new Set(expanded);
    if (next.has(stage)) next.delete(stage);
    else next.add(stage);
    setExpanded(next);
  };

  const handleAccept = async () => {
    // 10.2: 防止按钮被重复点击触发多次 updateChapter
    if (adopting) return;
    if (!task.finalText || task.targetType !== 'chapter') {
      Alert.alert('无法采纳', '该任务不支持直接采纳，请手动复制文本。');
      return;
    }
    setAdopting(true);
    try {
      const chapter = await db.getChapterById(task.targetId);
      if (!chapter) {
        Alert.alert('章节不存在');
        return;
      }

      // Adopt-time drift detection (Schema 37): if the task carries a frozen
      // input fingerprint, recompute the live one and warn the user when the
      // outline or chapter changed between generation and adoption. The user
      // may still proceed — this is a warning, not a block.
      const baselineFp = task.inputFingerprint;
      if (baselineFp) {
        try {
          const liveFp = await computeInputFingerprint({
            projectId: chapter.project_id,
            chapterId: chapter.id,
            chapterUpdatedAt: chapter.updated_at,
          });
          if (liveFp !== baselineFp) {
            const proceed = await new Promise<boolean>(resolve => {
              Alert.alert(
                '资料已变化',
                '本结果基于任务启动时的大纲/章节版本。当前大纲或章节资料已变化，采纳前请确认结果仍然合适。',
                [
                  { text: '取消', style: 'cancel', onPress: () => resolve(false) },
                  { text: '仍然采纳', style: 'destructive', onPress: () => resolve(true) },
                ],
              );
            });
            if (!proceed) {
              setAdopting(false);
              return;
            }
          }
        } catch {
          /* best-effort: drift check failure never blocks adoption */
        }
      }

      // Phase 7: manual and batch adoption share ONE domain service. The
      // service keeps every side effect (old-body revision, chapter write,
      // updated_at, task resolved, story memory dirty mark). Drift warning
      // below is UI-only (batch adoption is guarded by the batch state
      // machine instead).
      await adoptPipelineTaskResult({
        taskId: task.id,
        chapterId: task.targetId,
        source: 'manual',
      });
      acceptedRef.current = true; // 标记已 accept，阻止 unmount cleanup 重复 resolve
      Alert.alert('已采纳', '流水线正文已覆盖到章节并保存。');
      onAdopted?.(task.finalText);
      handleClose();
    } catch (error: any) {
      Alert.alert('采纳失败', error.message);
      setAdopting(false);
    }
  };

  const handleReject = () => {
    // 10.2: 采纳进行中时禁止 reject，避免竞态
    if (adopting) return;
    resolveTask(task.id, 'reject');
    handleClose();
  };

  // F2-07: 失败/中断时从失败环节重启 —— 只重跑失败的 stage（复用 frozen
  // request），已成功的阶段不重复计费。仅 draft 失败（无成功阶段）也必须
  // 提供重试入口：状态机从初稿 checkpoint 重新开始，与首次运行等价。
  // interrupted（进程被杀/超时/后台重启未完成）同样必须能继续：它只是
  // 尚未跑完，不是终态。只有 completed / cancelled / running 中的任务
  // 不提供重启入口。
  const failedStages = uniqueStageResults(task.stageResults).filter(
    s => s.status === 'failed',
  );
  const succeededStages = uniqueStageResults(task.stageResults).filter(
    s => s.status === 'success',
  );
  const canResumeFailed =
    task.targetType === 'chapter' &&
    (task.status === 'failed' || task.status === 'interrupted') &&
    (failedStages.length > 0 || task.status === 'interrupted');
  const resumeLabel =
    succeededStages.length > 0 ? '从失败节点重试' : '重新尝试';

  const handleResumeFailed = async () => {
    if (adopting) return;
    if (!canResumeFailed) return;
    const failedLabels = failedStages
      .map(s => STAGE_LABELS[s.stage])
      .join('、');
    const proceedCopy =
      succeededStages.length > 0
        ? `仅重试未完成阶段（${failedLabels || '剩余阶段'}），已成功的阶段（初稿/审阅/核查）将直接复用，不会重复计费。确定继续？`
        : `从初稿阶段重新运行完整流水线，不会重复计费未完成的请求。确定继续？`;
    const proceed = await new Promise<boolean>(resolve => {
      Alert.alert(
        succeededStages.length > 0 ? '从失败节点重试' : '重新尝试',
        proceedCopy,
        [
          { text: '取消', style: 'cancel', onPress: () => resolve(false) },
          { text: '重试', onPress: () => resolve(true) },
        ],
      );
    });
    if (!proceed) return;
    setAdopting(true);
    try {
      const chapter = await db.getChapterById(task.targetId);
      if (!chapter) {
        Alert.alert('章节不存在');
        setAdopting(false);
        return;
      }
      // 失败/中断的 checkpoint 重置为 pending；pipeline 状态机只重跑这些。
      await resetFailedStageCheckpointsForResume(task.id);
      const resumedAt = Date.now();
      // task 转 interrupted（resume 路径）；若旧任务已有 finalText 也保留，
      // 但 V3 失败路径不会把初稿写成可采纳终稿。
      await db.updatePipelineTaskResumeState(task.id, resumedAt);
      usePipelineTaskStore
        .getState()
        .registerPersistedTask({
          ...task,
          status: 'interrupted',
          error: null,
          updatedAt: resumedAt,
          resolvedAt: null,
          resolvedAction: null,
        });
      await resumePipeline(task.id, chapter);
      Alert.alert('已重试', '流水线已从失败节点继续，可在任务中心查看进度。');
      handleClose();
    } catch (error: any) {
      Alert.alert('重试失败', error?.message || '未知错误');
      setAdopting(false);
    }
  };

  const renderStageCard = (stage: PipelineStageResult) => {
    const isExpanded = expanded.has(stage.stage);
    const textLength = stage.text?.length || 0;
    const statusColor = stage.status === 'failed'
      ? theme.colors.danger
      : stage.status === 'skipped'
        ? theme.colors.textMuted
        : theme.colors.accent;
    const lengthLabel =
      stage.status === 'failed' && !stage.text?.trim()
        ? '无有效报告'
        : `${textLength} 字`;

    return (
      <View key={stage.stage} style={[styles.card, { backgroundColor: theme.colors.card }]}>
        <Button
          label={`${STAGE_LABELS[stage.stage]} · ${STATUS_LABELS[stage.status]} (${lengthLabel})`}
          variant="ghost"
          onPress={() => toggleExpanded(stage.stage)}
        />
        <Text
          style={[styles.stageMeta, { color: statusColor }]}
        >
          耗时 {Math.round(stage.durationMs / 1000)}s
          {stage.tokens ? ` · ${stage.tokens.total.toLocaleString()} tokens` : ''}
          {stage.tokens?.visible != null
            ? ` · 可见 ${stage.tokens.visible.toLocaleString()}`
            : ''}
          {stage.tokens?.reasoning != null
            ? ` · Thinking ${stage.tokens.reasoning.toLocaleString()}`
            : ''}
          {stage.error ? ` · ${stage.error}` : ''}
        </Text>
        {stage.warnings?.length ? (
          <Text style={[styles.stageMeta, { color: theme.colors.warning }]}>
            提示：{stage.warnings.join('；')}
          </Text>
        ) : null}
        {isExpanded && (
          <Text
            style={[styles.stageText, { color: theme.colors.textPrimary }]}
            selectable
          >
            {formatStageText(stage)}
          </Text>
        )}
      </View>
    );
  };

  return (
    <Screen>
      <Header
        title="流水线结果"
        action={<Button label="返回" variant="ghost" onPress={handleClose} />}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.summary, { color: theme.colors.textSecondary }]}>
          {statusSummary} · 耗时 {durationText} · {totalTokens.toLocaleString()} tokens · 跳过 {skippedCount} 阶段
        </Text>
        {!isRunning && proofStage?.status === 'skipped' && failedAuditCount > 0 ? (
          <Text style={[styles.summary, { color: theme.colors.danger }]}>
            审核未通过，未执行终审，已保留初稿
          </Text>
        ) : null}
        {!isRunning && proofStage?.status === 'failed' ? (
          <Text style={[styles.summary, { color: theme.colors.danger }]}>
            {proofStage.error || '终稿失败，请从失败节点重试'}
          </Text>
        ) : null}
        {isRunning ? (
          <Text style={[styles.summary, { color: theme.colors.warning }]}>
            任务仍在后台运行，页面显示的是已完成阶段的历史记录；运行结束后
            可在此查看最终结果并采纳。
          </Text>
        ) : null}
        <Text style={[styles.summary, { color: theme.colors.textSecondary }]}>
          本次输入上下文 tokens：{inputTokens.toLocaleString()}
        </Text>
        {(() => {
          const assessment = parseOutlineAssessmentFromReview(task.stageResults);
          if (!assessment) return null;
          const list = (title: string, items: string[]) =>
            items.length > 0 ? (
              <View key={title} style={{ marginTop: spacing.sm }}>
                <Text style={[styles.stageMeta, { color: theme.colors.textSecondary }]}>
                  {title}
                </Text>
                {items.map((item, idx) => (
                  <Text
                    key={`${title}-${idx}`}
                    style={[styles.stageText, { color: theme.colors.textPrimary }]}
                  >
                    · {item}
                  </Text>
                ))}
              </View>
            ) : null;
          return (
            <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
              <Text style={[styles.summary, { color: theme.colors.textPrimary }]}>
                大纲执行报告 ·{' '}
                {OUTLINE_STATUS_LABELS[assessment.status] || assessment.status || '未知'}
              </Text>
              {list('已完成节点', assessment.fulfilledBeats)}
              {list('遗漏节点', assessment.missingBeats)}
              {list('主线偏离', assessment.deviations)}
              {list('提前发生节点', assessment.prematureBeats)}
              {list('历史回滚风险', assessment.factRollbackRisks)}
              {!assessment.fulfilledBeats.length &&
              !assessment.missingBeats.length &&
              !assessment.deviations.length &&
              !assessment.prematureBeats.length &&
              !assessment.factRollbackRisks.length ? (
                <Text style={[styles.stageText, { color: theme.colors.textMuted }]}>
                  未发现额外的大纲节点问题。
                </Text>
              ) : null}
            </View>
          );
        })()}
        {uniqueStageResults(task.stageResults).map(renderStageCard)}
        {(task.finalText && !isRunning) || canResumeFailed ? (
          <View style={styles.actions}>
            {canResumeFailed ? (
              <Button
                label={resumeLabel}
                variant="ghost"
                onPress={handleResumeFailed}
                disabled={adopting}
              />
            ) : null}
            {task.finalText && !isRunning ? (
              <>
                <Button label="放弃" variant="ghost" onPress={handleReject} disabled={adopting} />
                <Button label={adopting ? '采纳中…' : '采纳'} onPress={handleAccept} disabled={adopting} />
              </>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: 120 },
  summary: { fontSize: 13, fontWeight: '700' },
  card: { borderRadius: 8, padding: spacing.md, gap: spacing.sm },
  stageMeta: { fontSize: 12, fontWeight: '700' },
  stageText: { fontSize: 14, lineHeight: 22, marginTop: spacing.sm },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md, marginTop: spacing.lg },
});

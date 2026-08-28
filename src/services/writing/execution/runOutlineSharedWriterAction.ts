import { usePipelineTaskStore } from '../../../store/pipelineTaskStore';
import type { Chapter } from '../../../types/novel';
import type { PipelineAction } from '../../pipeline/types';
import { executeClaimedStage } from '../../pipeline/executeClaimedStage';
import type { ReconcileOptions } from '../../pipeline/reconcile';
import {
  createStageAttempt,
  getStageAttempts,
  updateStageAttempt,
} from '../../../data/repositories/pipelineStageAttemptRepository';
import type { FrozenWritingContext } from '../contracts/frozenWritingContext';
import type { SharedWritingStage } from '../contracts/writingStage';
import type {
  WritingDurablePersistAdapter,
  WritingStageArtifacts,
} from '../contracts/writingStage';
import { createOutlineDurableAdapter } from '../persistence/outlineDurableAdapter';
import { runWritingStages } from '../stages/writingStageRunner';
import { evaluateRuntimeStageSkip } from '../stages/evaluateRuntimeStageSkip';
import { resolveSharedStageSkip } from '../contracts/writingPolicy';
import { isCompactPipelineTopology } from '../../pipeline/outlineWorkflowVersion';
import type { SharedWriterFailureDiagnostics } from '../stages/writerCore';
import { compactWritingRequestReceipt } from '../contracts/writingRequestReceipt';

function nonNegativeReceiptNumber(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nullableReceiptNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function safeReceiptList(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => compactWritingRequestReceipt(item as any));
}

function receiptRuntimeProjection(item: any): Record<string, unknown> {
  return {
    requestId: item?.requestId || null,
    writingRunId: item?.writingRunId || null,
    generationTraceId: item?.generationTraceId || null,
    scenario: item?.scenario || null,
    stage: item?.stage || null,
    providerAdapterId: item?.providerAdapterId || null,
    llmConfigId: item?.llmConfigId ?? null,
    model: item?.model || null,
    qualityProfile: item?.qualityProfile || null,
    executionProfile: item?.executionProfile || null,
    thinking: item?.thinking || null,
    reasoningEffort: item?.reasoningEffort || null,
    targetChars: item?.targetChars ?? null,
    actualPromptTokens: item?.actualPromptTokens ?? null,
    configuredContextWindow: item?.configuredContextWindow ?? null,
    completionCapability: item?.completionCapability ?? null,
    wireMaxTokens: item?.wireMaxTokens ?? null,
    providerCompletionLimit: item?.providerCompletionLimit ?? null,
    timings: item?.timings || null,
    usage: item?.usage || null,
    finishReason: item?.finishReason ?? null,
    emptyReason: item?.emptyReason ?? null,
    failureClass: item?.failureClass ?? null,
    requestMayHaveExecuted: item?.requestMayHaveExecuted ?? null,
    providerRequestId: item?.providerRequestId ?? null,
    physicalRequestCount: item?.physicalRequestCount ?? 0,
    protocolFallbackCount: item?.protocolFallbackCount ?? 0,
    outcome: item?.outcome || null,
  };
}

function safeFrozenModelSnapshot(frozenContext: FrozenWritingContext): string {
  return JSON.stringify({
    version: 1,
    configId: frozenContext.model.configId,
    provider: frozenContext.model.provider,
    providerAdapterId: frozenContext.model.providerAdapterId ?? null,
    model: frozenContext.model.modelName,
    contextWindow: frozenContext.model.contextWindow,
    maxOutputTokens: frozenContext.model.maxOutputTokens,
    thinking: frozenContext.model.thinking ?? null,
    reasoningEffort: frozenContext.model.reasoningEffort ?? null,
  });
}

/**
 * Reserve billing/attempt bookkeeping only for a stage that can actually
 * issue a physical request. Runtime Revision skips depend on the already
 * persisted QA artifact, so they must be decided before createStageAttempt.
 */
export async function shouldReserveOutlineStageAttempt(input: {
  stage: SharedWritingStage;
  frozenContext: FrozenWritingContext;
  adapter: WritingDurablePersistAdapter;
}): Promise<boolean> {
  const policySkip = resolveSharedStageSkip(
    input.frozenContext.stagePolicy,
    input.stage,
  );
  if (policySkip.skip) return false;
  // Historical legacy Resume keeps its pre-compact attempt ledger shape. The
  // zero-token reservation bug is a Compact Standard defect; do not rewrite
  // legacy task accounting while repairing the active topology.
  if (
    input.stage !== 'revision' ||
    !isCompactPipelineTopology(
      input.frozenContext.stagePolicy.values?.pipelineTopologyVersion,
    ) ||
    !input.adapter.loadExisting
  ) {
    return true;
  }

  const artifacts: WritingStageArtifacts = {};
  for (const stage of ['qa', 'review', 'audit', 'factCheck'] as const) {
    const existing = await input.adapter.loadExisting(stage);
    if (existing) artifacts[stage] = existing;
  }
  const runtimeSkip = evaluateRuntimeStageSkip({
    stage: input.stage,
    artifacts,
    pipelineTopologyVersion:
      input.frozenContext.stagePolicy.values?.pipelineTopologyVersion,
  });
  return !runtimeSkip.skip;
}

const ACTION_TO_STAGES: Partial<Record<PipelineAction['type'], SharedWritingStage[]>> = {
  run_draft: ['draft'],
  run_review: ['review'],
  run_fact_check: ['factCheck'],
  run_review_and_fact_check: ['review', 'factCheck'],
  // Phase 4 §7.2: the unified qa action maps to one qa kernel stage.
  run_qa: ['qa'],
  run_brief: ['revision'],
  run_proof: ['proof'],
};

export async function runSharedOutlineWriterAction(input: {
  taskId: string;
  chapter: Chapter;
  action: PipelineAction;
  onStageUpdate?: ReconcileOptions['onStageUpdate'];
  abortSignal?: AbortSignal;
  options: ReconcileOptions;
}): Promise<void> {
  const stages = ACTION_TO_STAGES[input.action.type] || [];
  if (stages.length === 0) {
    throw new Error(`Shared Outline writer does not handle ${input.action.type}`);
  }
  const store = usePipelineTaskStore.getState();
  const task = store.tasks.find(item => item.id === input.taskId);
  if (!task?.pipelineContextJson) {
    throw new Error('WRITING_FROZEN_CONTEXT_MISSING: outline envelope');
  }
  const envelope = JSON.parse(task.pipelineContextJson);
  const frozenContext = (input.options.frozenWritingContext ||
    envelope?.draftContext?.frozenWritingContext) as
    | FrozenWritingContext
    | undefined;
  const trace =
    input.options.writingKernelTrace ||
    envelope?.draftContext?.writingKernelTrace;
  if (!frozenContext?.freezeFingerprint || !trace?.freezeFingerprint) {
    throw new Error('WRITING_FROZEN_CONTEXT_MISSING: outline shared writer');
  }
  const persistAdapter = createOutlineDurableAdapter({
    taskId: input.taskId,
    chapter: input.chapter,
  });
  const claim = await executeClaimedStage({
    taskId: input.taskId,
    stage: stages[0] === 'revision' ? 'brief' : (stages[0] as any),
    abortSignal: input.abortSignal,
    isCancelled: () => Boolean(input.options.abortSignal?.aborted),
    onClaimed: async () => {
      input.onStageUpdate?.({
        stage: (stages[0] === 'revision' ? 'brief' : stages[0]) as any,
        label: `正在执行 ${stages[0]}`,
        startedAt: Date.now(),
      });
    },
    run: async () => {
      const attempts: Array<{ id: string; stage: SharedWritingStage; index: number }> = [];
      const requestVersion = stages[0] === 'draft' ? 1 : 32;
      for (let index = 0; index < stages.length; index += 1) {
        const stage = stages[index];
        const recordedStage = stage === 'revision' ? 'brief' : stage;
        const reserveAttempt = await shouldReserveOutlineStageAttempt({
          stage,
          frozenContext,
          adapter: persistAdapter,
        });
        if (!reserveAttempt) continue;
        const previous = await getStageAttempts(input.taskId, recordedStage);
        const attemptNo = previous.length + 1;
        const attemptId = `att_${input.taskId}_${recordedStage}_${attemptNo}_${Date.now()}`;
        await createStageAttempt({
          id: attemptId,
          pipelineTaskId: input.taskId,
          stage: recordedStage,
          attemptNo,
          requestVersion,
          requestFingerprint: `${trace.freezeFingerprint}:${recordedStage}`,
          llmConfigId: frozenContext.model.configId,
          llmConfigSnapshotJson: safeFrozenModelSnapshot(frozenContext),
          clientRequestId: attemptId,
        });
        attempts.push({ id: attemptId, stage, index });
      }
      try {
        const results = await runWritingStages({
          frozenContext,
          trace,
          stages,
          persistAdapter,
          chapterId: input.chapter.id,
          abortSignal: input.abortSignal,
        });
        await Promise.all(
          attempts.map(({ id, stage, index }) => {
            const usage = (
              results[index]?.artifact as { usage?: {
                inputTokens?: number;
                outputTokens?: number;
                totalTokens?: number;
                physicalRequestCount?: number;
                protocolFallbackCount?: number;
              } } | undefined
            )?.usage;
            const receipts = (
              results[index]?.artifact as {
                requestReceipts?: unknown;
              } | undefined
            )?.requestReceipts;
            const receiptList = Array.isArray(receipts) ? receipts : [];
            const primaryReceipt = receiptList.find(
              item => (item as { kind?: unknown })?.kind === 'logical_stage',
            ) as
              | {
                  requestFingerprint?: unknown;
                  finishReason?: unknown;
                  emptyReason?: unknown;
                  providerRequestId?: unknown;
                  failureClass?: unknown;
                  requestMayHaveExecuted?: unknown;
                  physicalRequestCount?: unknown;
                  protocolFallbackCount?: unknown;
                  timings?: { parseCompletedAt?: unknown };
                  usage?: {
                    inputTokens?: unknown;
                    outputTokens?: unknown;
                    totalTokens?: unknown;
                    reasoningTokens?: unknown;
                    visibleOutputTokens?: unknown;
                  };
                }
              | undefined;
            const primaryUsage = primaryReceipt?.usage;
            const physicalRequestCount = receiptList.reduce(
              (sum, item) =>
                sum +
                nonNegativeReceiptNumber(
                  (item as { physicalRequestCount?: unknown })
                    ?.physicalRequestCount,
                  1,
                ),
              0,
            );
            const protocolFallbackCount = receiptList.reduce(
              (sum, item) =>
                sum +
                Math.max(
                  0,
                  Number(
                    (item as { protocolFallbackCount?: unknown })
                      ?.protocolFallbackCount,
                  ) || 0,
                ),
              0,
            );
            const usagePhysicalRequestCount = nonNegativeReceiptNumber(
              usage?.physicalRequestCount,
              physicalRequestCount,
            );
            const usageProtocolFallbackCount = nonNegativeReceiptNumber(
              usage?.protocolFallbackCount,
              protocolFallbackCount,
            );
            const persistedReceipts = safeReceiptList(receipts);
            if (
              receiptList.length > 0 &&
              (usagePhysicalRequestCount !== physicalRequestCount ||
                usageProtocolFallbackCount !== protocolFallbackCount)
            ) {
              throw new Error(
                `WRITING_ACCOUNTING_RECEIPT_MISMATCH: stage=${stage} usage=${usagePhysicalRequestCount}/${usageProtocolFallbackCount} receipt=${physicalRequestCount}/${protocolFallbackCount}`,
              );
            }
            return updateStageAttempt({
              id,
              status: 'succeeded',
              requestFingerprint:
                typeof primaryReceipt?.requestFingerprint === 'string'
                  ? primaryReceipt.requestFingerprint
                  : undefined,
              completedAt: Date.now(),
              formatterUsed: Boolean(
                (results[index]?.artifact as { formatterUsed?: boolean } | undefined)
                  ?.formatterUsed,
              ),
              lastProgressAt: nullableReceiptNumber(
                primaryReceipt?.timings?.parseCompletedAt,
              ),
              inputTokens:
                primaryUsage && Object.prototype.hasOwnProperty.call(primaryReceipt, 'usage')
                  ? nullableReceiptNumber(primaryUsage.inputTokens)
                  : nullableReceiptNumber(usage?.inputTokens),
              outputTokens:
                primaryUsage && Object.prototype.hasOwnProperty.call(primaryReceipt, 'usage')
                  ? nullableReceiptNumber(primaryUsage.outputTokens)
                  : nullableReceiptNumber(usage?.outputTokens),
              totalTokens:
                primaryUsage && Object.prototype.hasOwnProperty.call(primaryReceipt, 'usage')
                  ? nullableReceiptNumber(primaryUsage.totalTokens)
                  : nullableReceiptNumber(usage?.totalTokens),
              reasoningTokens: nullableReceiptNumber(primaryUsage?.reasoningTokens),
              finishReason:
                typeof primaryReceipt?.finishReason === 'string'
                  ? primaryReceipt.finishReason
                  : null,
              emptyReason:
                typeof primaryReceipt?.emptyReason === 'string'
                  ? primaryReceipt.emptyReason
                  : null,
              providerRequestId:
                typeof primaryReceipt?.providerRequestId === 'string'
                  ? primaryReceipt.providerRequestId
                  : null,
              visibleOutputTokens: nullableReceiptNumber(
                primaryUsage?.visibleOutputTokens,
              ),
              validationDetailsJson: JSON.stringify({
                version: 1,
                requestReceiptCount: receiptList.length,
                physicalRequestCount: usagePhysicalRequestCount,
                protocolFallbackCount: usageProtocolFallbackCount,
                runtimeObservability: receiptList.map(receiptRuntimeProjection),
                finishReasons: receiptList.map(item =>
                  typeof (item as { finishReason?: unknown })?.finishReason ===
                    'string'
                    ? (item as { finishReason: string }).finishReason
                    : null,
                ),
              }),
              frozenRequestJson:
                persistedReceipts.length > 0
                  ? JSON.stringify(persistedReceipts)
                  : null,
            });
          }),
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        const writerDiagnostics = (
          error as { writerDiagnostics?: SharedWriterFailureDiagnostics }
        ).writerDiagnostics;
        const errorRecord =
          error && typeof error === 'object'
            ? (error as Record<string, unknown>)
            : {};
        const failureClass =
          (error as { failureClass?: string }).failureClass ||
          (error as { code?: string }).code ||
          null;
        const status =
          failureClass === 'safe_retry'
            ? 'safe_to_retry'
            : failureClass === 'outcome_unknown'
            ? 'outcome_unknown'
            : 'failed';
        const failedReceipts = (error as { requestReceipts?: unknown })
          .requestReceipts;
        const failedReceiptList = Array.isArray(failedReceipts)
          ? failedReceipts
          : [];
        const failedPrimaryReceipt = failedReceiptList.find(
          item => (item as { kind?: unknown })?.kind === 'logical_stage',
        ) as
          | {
              requestFingerprint?: unknown;
              providerRequestId?: unknown;
              failureClass?: unknown;
              requestMayHaveExecuted?: unknown;
              timings?: { parseCompletedAt?: unknown };
              usage?: {
                inputTokens?: unknown;
                outputTokens?: unknown;
                totalTokens?: unknown;
                reasoningTokens?: unknown;
                visibleOutputTokens?: unknown;
              };
              finishReason?: unknown;
              emptyReason?: unknown;
            }
          | undefined;
        const failedPrimaryUsage = failedPrimaryReceipt?.usage;
        const failedPersistedReceipts = safeReceiptList(failedReceipts);
        const failedHasReceiptUsage =
          failedPrimaryReceipt != null &&
          Object.prototype.hasOwnProperty.call(failedPrimaryReceipt, 'usage');
        const failedInputTokens = failedHasReceiptUsage
          ? nullableReceiptNumber(failedPrimaryUsage?.inputTokens)
          : writerDiagnostics?.inputTokens ?? null;
        const failedOutputTokens = failedHasReceiptUsage
          ? nullableReceiptNumber(failedPrimaryUsage?.outputTokens)
          : writerDiagnostics?.outputTokens ?? null;
        const failedTotalTokens = failedHasReceiptUsage
          ? nullableReceiptNumber(failedPrimaryUsage?.totalTokens)
          : writerDiagnostics?.totalTokens ?? null;
        const failedReasoningTokens = failedHasReceiptUsage
          ? nullableReceiptNumber(failedPrimaryUsage?.reasoningTokens)
          : writerDiagnostics?.reasoningTokens ?? null;
        const failedVisibleOutputTokens = failedHasReceiptUsage
          ? nullableReceiptNumber(failedPrimaryUsage?.visibleOutputTokens)
          : writerDiagnostics?.visibleOutputTokens ?? null;
        const failedFailureClass =
          typeof failureClass === 'string'
            ? failureClass
            : typeof failedPrimaryReceipt?.failureClass === 'string'
            ? failedPrimaryReceipt.failureClass
            : null;
        await Promise.all(
          attempts.map(({ id }) =>
            updateStageAttempt({
              id,
              status,
              requestFingerprint:
                typeof failedPrimaryReceipt?.requestFingerprint === 'string'
                  ? failedPrimaryReceipt.requestFingerprint
                  : undefined,
              failureClass: failedFailureClass,
              errorCode:
                typeof errorRecord.code === 'string'
                  ? errorRecord.code
                  : writerDiagnostics?.errorCode || null,
              errorMessage: message,
              httpStatus:
                typeof errorRecord.status === 'number'
                  ? errorRecord.status
                  : null,
              providerRequestId:
                typeof errorRecord.providerRequestId === 'string'
                  ? errorRecord.providerRequestId
                  : typeof failedPrimaryReceipt?.providerRequestId === 'string'
                  ? failedPrimaryReceipt.providerRequestId
                  : null,
              formatterUsed: Boolean(
                (error as { formatterUsed?: boolean }).formatterUsed,
              ),
              completedAt: Date.now(),
              lastProgressAt: nullableReceiptNumber(
                failedPrimaryReceipt?.timings?.parseCompletedAt,
              ),
              inputTokens: failedInputTokens,
              outputTokens: failedOutputTokens,
              totalTokens: failedTotalTokens,
              reasoningTokens: failedReasoningTokens,
              finishReason:
                typeof failedPrimaryReceipt?.finishReason === 'string'
                  ? failedPrimaryReceipt.finishReason
                  : writerDiagnostics?.finishReason ?? null,
              emptyReason:
                typeof failedPrimaryReceipt?.emptyReason === 'string'
                  ? failedPrimaryReceipt.emptyReason
                  : writerDiagnostics?.emptyReason ?? null,
              responseChannel: writerDiagnostics?.responseChannel,
              visibleOutputTokens: failedVisibleOutputTokens,
              parseFailureCode: writerDiagnostics?.parseFailureCode,
              responseCandidateChannel:
                writerDiagnostics?.responseCandidateChannel,
              validationDetailsJson: JSON.stringify({
                version: 1,
                writerDiagnostics: writerDiagnostics?.validationDetailsJson
                  ? JSON.parse(writerDiagnostics.validationDetailsJson)
                  : null,
                runtimeObservability: failedReceiptList.map(
                  receiptRuntimeProjection,
                ),
                failureClass: failedFailureClass,
                requestMayHaveExecuted:
                  failedPrimaryReceipt?.requestMayHaveExecuted ??
                  (typeof errorRecord.requestMayHaveExecuted === 'boolean'
                    ? errorRecord.requestMayHaveExecuted
                    : null),
              }),
              frozenRequestJson:
                failedPersistedReceipts.length > 0
                  ? JSON.stringify(failedPersistedReceipts)
                  : null,
            }),
          ),
        );
        throw error;
      }
    },
  });
  if (!claim.claimed) {
    throw Object.assign(new Error('任务已在运行'), {
      code: 'TASK_ALREADY_RUNNING',
    });
  }
}

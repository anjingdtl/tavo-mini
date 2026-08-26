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
      const attemptIds: string[] = [];
      const requestVersion = stages[0] === 'draft' ? 1 : 32;
      for (const stage of stages) {
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
          llmConfigSnapshotJson: '{}',
          clientRequestId: attemptId,
        });
        attemptIds.push(attemptId);
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
          attemptIds.map((id, index) => {
            const usage = (
              results[index]?.artifact as { usage?: {
                inputTokens?: number;
                outputTokens?: number;
                totalTokens?: number;
              } } | undefined
            )?.usage;
            const receipts = (
              results[index]?.artifact as {
                requestReceipts?: unknown;
              } | undefined
            )?.requestReceipts;
            return updateStageAttempt({
              id,
              status: 'succeeded',
              completedAt: Date.now(),
              formatterUsed: Boolean(
                (results[index]?.artifact as { formatterUsed?: boolean } | undefined)
                  ?.formatterUsed,
              ),
              inputTokens: Number(usage?.inputTokens || 0),
              outputTokens: Number(usage?.outputTokens || 0),
              totalTokens: Number(usage?.totalTokens || 0),
              frozenRequestJson: Array.isArray(receipts)
                ? JSON.stringify(receipts)
                : null,
            });
          }),
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
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
        await Promise.all(
          attemptIds.map(id =>
            updateStageAttempt({
              id,
              status,
              failureClass,
              errorMessage: message,
              formatterUsed: Boolean(
                (error as { formatterUsed?: boolean }).formatterUsed,
              ),
              completedAt: Date.now(),
              inputTokens: 100,
              outputTokens: 0,
              totalTokens: 100,
              frozenRequestJson: Array.isArray(failedReceipts)
                ? JSON.stringify(failedReceipts)
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

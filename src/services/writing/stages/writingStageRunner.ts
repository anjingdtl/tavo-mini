import type {
  FrozenWritingContext,
  WritingKernelTrace,
} from '../contracts/frozenWritingContext';
import type {
  SharedWritingStage,
  SharedWritingStageInput,
  SharedWritingStageResult,
  WritingDurablePersistAdapter,
  WritingStageArtifacts,
} from '../contracts/writingStage';
import { runAuditStage } from './audit';
import { runDraftStage } from './draft';
import { runFactCheckStage } from './factCheck';
import { runFinalValidateStage } from './finalValidate';
import { runPersistStage } from './persist';
import { runProofStage } from './proof';
import { runRevisionStage } from './revision';
import { runReviewStage } from './review';
import type { SemanticApplyCheckInput } from './semanticApply';
import type { StageLlmCaller } from '../scenario/continuationWritingTypes';
import { toFrozenStageModelConfig } from '../contracts/freezeModelConfig';

export interface WritingStagesRunInput {
  frozenContext: FrozenWritingContext;
  trace: WritingKernelTrace;
  stages: SharedWritingStage[];
  artifacts?: WritingStageArtifacts;
  persistAdapter?: WritingDurablePersistAdapter;
  semanticApply?:
    | SemanticApplyCheckInput
    | (() => Promise<SemanticApplyCheckInput>);
  callStage?: StageLlmCaller;
  abortSignal?: AbortSignal;
}

/** The only stage dispatcher used after Freeze by both durable substrates. */
export async function runWritingStages(
  input: WritingStagesRunInput,
): Promise<SharedWritingStageResult[]> {
  const results: SharedWritingStageResult[] = [];
  const artifacts: WritingStageArtifacts = { ...(input.artifacts || {}) };
  if (input.persistAdapter?.loadExisting) {
    for (const stage of [
      'draft',
      'review',
      'audit',
      'factCheck',
      'revision',
      'proof',
      'finalValidate',
    ] as const) {
      if (artifacts[stage]) continue;
      const existing = await input.persistAdapter.loadExisting(stage);
      if (existing?.body) artifacts[stage] = existing;
    }
  }
  for (const stage of input.stages) {
    const stageInput: SharedWritingStageInput = {
      frozenContext: input.frozenContext,
      artifacts,
      requirements: input.frozenContext.requirements,
      stagePolicy: {
        ...input.frozenContext.stagePolicy,
        outputContract:
          input.frozenContext.stagePolicy.outputContract ||
          (input.frozenContext.stagePolicy.reviewMode === 'continuation-v5'
            ? 'json_envelope'
            : 'prose'),
        skipRules: input.frozenContext.stagePolicy.skipRules || {},
      },
      modelConfig: toFrozenStageModelConfig(input.frozenContext.model),
      trace: input.trace,
      semanticApply: input.semanticApply,
      persistAdapter: input.persistAdapter,
      callStage: input.callStage,
      abortSignal: input.abortSignal,
    };
    let result: SharedWritingStageResult;
    switch (stage) {
      case 'draft':
        result = await runDraftStage(stageInput);
        break;
      case 'review':
        result = await runReviewStage(stageInput);
        break;
      case 'audit':
        result = await runAuditStage(stageInput);
        break;
      case 'factCheck':
        result = await runFactCheckStage(stageInput);
        break;
      case 'revision':
        result = await runRevisionStage(stageInput);
        break;
      case 'proof':
        result = await runProofStage(stageInput);
        break;
      case 'finalValidate':
        result = await runFinalValidateStage(stageInput);
        break;
      case 'persist':
        result = await runPersistStage(stageInput);
        break;
    }
    results.push(result);
    if (result.artifact) {
      artifacts[stage] = result.artifact;
    }
    if (result.status === 'skipped') {
      continue;
    }
    if (result.status !== 'completed') {
      const error =
        result.error instanceof Error
          ? result.error
          : Object.assign(
              new Error(
                `Shared ${stage} stage ${result.status}: ${result.diagnostics.join('; ')}`,
              ),
              { code: result.diagnostics[0] },
            );
      await input.persistAdapter?.persistStageFailure?.(stage, error);
      throw error;
    }
  }
  return results;
}

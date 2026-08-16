import type {
  FrozenWritingContext,
  WritingKernelTrace,
} from '../contracts/frozenWritingContext';
import type {
  SharedWritingStage,
  SharedWritingStageInput,
  SharedWritingStageResult,
} from '../contracts/writingStage';
import { runAuditStage } from './audit';
import { runDraftStage } from './draft';
import { runFactCheckStage } from './factCheck';
import { runFinalValidateStage } from './finalValidate';
import { runPersistStage } from './persist';
import { runProofStage } from './proof';
import { runRevisionStage } from './revision';
import { runReviewStage } from './review';

export interface WritingStagesRunInput {
  frozenContext: FrozenWritingContext;
  trace: WritingKernelTrace;
  stages: Array<{
    stage: SharedWritingStage;
    execute: () => Promise<unknown>;
    semanticApply?: SharedWritingStageInput['semanticApply'];
  }>;
}

/** The only stage dispatcher used after Freeze by both durable substrates. */
export async function runWritingStages(
  input: WritingStagesRunInput,
): Promise<SharedWritingStageResult[]> {
  const results: SharedWritingStageResult[] = [];
  for (const requested of input.stages) {
    const stageInput: SharedWritingStageInput = {
      frozenContext: input.frozenContext,
      artifacts: {},
      requirements: input.frozenContext.requirements,
      stagePolicy: input.frozenContext.stagePolicy,
      modelConfig: {
        configId: input.frozenContext.model.configId,
        name: input.frozenContext.model.modelName,
        providerType: input.frozenContext.model.provider,
        url: '',
        modelName: input.frozenContext.model.modelName,
        contextWindow: input.frozenContext.model.contextWindow,
        maxOutputTokens: input.frozenContext.model.maxOutputTokens,
      },
      trace: input.trace,
      semanticApply: requested.semanticApply,
      execute: requested.execute,
    };
    let result: SharedWritingStageResult;
    switch (requested.stage) {
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
    if (result.status !== 'completed') {
      if (result.error) throw result.error;
      const error = new Error(
        `Shared ${requested.stage} stage failed: ${result.diagnostics.join('; ')}`,
      );
      (error as Error & { code?: string }).code = result.diagnostics[0];
      throw error;
    }
  }
  return results;
}

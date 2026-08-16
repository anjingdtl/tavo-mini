import type {
  SharedWritingStageInput,
  SharedWritingStageResult,
} from '../contracts/writingStage';
import { runSharedStage } from './sharedStage';
import { checkSemanticRequirementApplication } from './semanticApply';

export async function runFinalValidateStage<T = unknown>(
  input: SharedWritingStageInput,
): Promise<SharedWritingStageResult<T>> {
  const result = await runSharedStage<T>({
    stage: 'finalValidate',
    stageInput: input,
  });
  if (
    result.status === 'completed' &&
    input.stagePolicy.semanticApplyRequired &&
    input.semanticApply
  ) {
    const semanticInput =
      typeof input.semanticApply === 'function'
        ? await input.semanticApply()
        : input.semanticApply;
    const semantic = checkSemanticRequirementApplication(semanticInput);
    if (!semantic.ok) {
      return {
        ...result,
        status: 'failed',
        diagnostics: [
          ...result.diagnostics,
          semantic.code || 'SEMANTIC_APPLY_FAILED',
        ],
      };
    }
  }
  return result;
}

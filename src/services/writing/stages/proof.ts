import type {
  SharedWritingStageInput,
  SharedWritingStageResult,
} from '../contracts/writingStage';
import { preflightSharedStage } from './sharedStage';
import {
  evaluateStageRequirements,
  executeSharedWriterStage,
  resolveStageSkipOrNull,
  skippedStageResult,
} from './writerCore';
import { evaluateRuntimeStageSkip } from './evaluateRuntimeStageSkip';

export async function runProofStage(
  input: SharedWritingStageInput,
): Promise<SharedWritingStageResult> {
  const blocked = preflightSharedStage({ stage: 'proof', stageInput: input });
  if (blocked) return blocked;
  const skip = resolveStageSkipOrNull('proof', input);
  if (skip.skip) {
    return skippedStageResult('proof', input, skip.skipReason, skip.policyRuleId);
  }
  const runtimeSkip = evaluateRuntimeStageSkip({
    stage: 'proof',
    artifacts: input.artifacts,
    proofPolicy: input.stagePolicy.values?.proofPolicy,
  });
  if (runtimeSkip.skip) {
    return skippedStageResult(
      'proof',
      input,
      runtimeSkip.skipReason,
      runtimeSkip.policyRuleId,
    );
  }
  try {
    const artifact = await executeSharedWriterStage({
      stage: 'proof',
      stageInput: input,
    });
    return {
      stage: 'proof',
      status: 'completed',
      artifact,
      diagnostics: artifact.diagnostics || [],
      requirementResult: evaluateStageRequirements(input, artifact),
    };
  } catch (error) {
    return {
      stage: 'proof',
      status: 'failed',
      diagnostics: [error instanceof Error ? error.message : String(error)],
      error,
      requirementResult: evaluateStageRequirements(input, {
        stage: 'proof',
        body: '',
      }),
    };
  }
}

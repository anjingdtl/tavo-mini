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

export async function runRevisionStage(
  input: SharedWritingStageInput,
): Promise<SharedWritingStageResult> {
  const blocked = preflightSharedStage({
    stage: 'revision',
    stageInput: input,
  });
  if (blocked) return blocked;
  const skip = resolveStageSkipOrNull('revision', input);
  if (skip.skip) {
    return skippedStageResult(
      'revision',
      input,
      skip.skipReason,
      skip.policyRuleId,
    );
  }
  const runtimeSkip = evaluateRuntimeStageSkip({
    stage: 'revision',
    artifacts: input.artifacts,
    pipelineTopologyVersion:
      input.frozenContext.stagePolicy?.values?.pipelineTopologyVersion,
  });
  if (runtimeSkip.skip) {
    return skippedStageResult(
      'revision',
      input,
      runtimeSkip.skipReason,
      runtimeSkip.policyRuleId,
    );
  }
  try {
    const artifact = await executeSharedWriterStage({
      stage: 'revision',
      stageInput: input,
    });
    return {
      stage: 'revision',
      status: 'completed',
      artifact,
      diagnostics: artifact.diagnostics || [],
      requirementResult: evaluateStageRequirements(input, artifact),
    };
  } catch (error) {
    return {
      stage: 'revision',
      status: 'failed',
      diagnostics: [error instanceof Error ? error.message : String(error)],
      error,
      requirementResult: evaluateStageRequirements(input, {
        stage: 'revision',
        body: '',
      }),
    };
  }
}

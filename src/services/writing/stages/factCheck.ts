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

export async function runFactCheckStage(
  input: SharedWritingStageInput,
): Promise<SharedWritingStageResult> {
  const blocked = preflightSharedStage({
    stage: 'factCheck',
    stageInput: input,
  });
  if (blocked) return blocked;
  const skip = resolveStageSkipOrNull('factCheck', input);
  if (skip.skip) {
    return skippedStageResult(
      'factCheck',
      input,
      skip.skipReason,
      skip.policyRuleId,
    );
  }
  try {
    const artifact = await executeSharedWriterStage({
      stage: 'factCheck',
      stageInput: input,
    });
    return {
      stage: 'factCheck',
      status: 'completed',
      artifact,
      diagnostics: artifact.diagnostics || [],
      requirementResult: evaluateStageRequirements(input, artifact),
    };
  } catch (error) {
    return {
      stage: 'factCheck',
      status: 'failed',
      diagnostics: [error instanceof Error ? error.message : String(error)],
      error,
      requirementResult: evaluateStageRequirements(input, {
        stage: 'factCheck',
        body: '',
      }),
    };
  }
}

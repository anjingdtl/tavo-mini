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

export async function runReviewStage(
  input: SharedWritingStageInput,
): Promise<SharedWritingStageResult> {
  const blocked = preflightSharedStage({ stage: 'review', stageInput: input });
  if (blocked) return blocked;
  const skip = resolveStageSkipOrNull('review', input);
  if (skip.skip) {
    return skippedStageResult(
      'review',
      input,
      skip.skipReason,
      skip.policyRuleId,
    );
  }
  try {
    const artifact = await executeSharedWriterStage({
      stage: 'review',
      stageInput: input,
    });
    return {
      stage: 'review',
      status: 'completed',
      artifact,
      diagnostics: artifact.diagnostics || [],
      requirementResult: evaluateStageRequirements(input, artifact),
    };
  } catch (error) {
    return {
      stage: 'review',
      status: 'failed',
      diagnostics: [error instanceof Error ? error.message : String(error)],
      error,
      requirementResult: evaluateStageRequirements(input, {
        stage: 'review',
        body: '',
      }),
    };
  }
}

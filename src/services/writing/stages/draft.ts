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

export async function runDraftStage(
  input: SharedWritingStageInput,
): Promise<SharedWritingStageResult> {
  const blocked = preflightSharedStage({ stage: 'draft', stageInput: input });
  if (blocked) return blocked;
  const skip = resolveStageSkipOrNull('draft', input);
  if (skip.skip) {
    return skippedStageResult('draft', input, skip.skipReason, skip.policyRuleId);
  }
  try {
    const artifact = await executeSharedWriterStage({
      stage: 'draft',
      stageInput: input,
    });
    return {
      stage: 'draft',
      status: 'completed',
      artifact,
      diagnostics: artifact.diagnostics || [],
      requirementResult: evaluateStageRequirements(input, artifact),
    };
  } catch (error) {
    return {
      stage: 'draft',
      status: 'failed',
      diagnostics: [error instanceof Error ? error.message : String(error)],
      error,
      requirementResult: evaluateStageRequirements(input, {
        stage: 'draft',
        body: '',
      }),
    };
  }
}

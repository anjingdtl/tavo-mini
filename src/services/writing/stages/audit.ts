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

export async function runAuditStage(
  input: SharedWritingStageInput,
): Promise<SharedWritingStageResult> {
  const blocked = preflightSharedStage({ stage: 'audit', stageInput: input });
  if (blocked) return blocked;
  const skip = resolveStageSkipOrNull('audit', input);
  if (skip.skip) {
    return skippedStageResult('audit', input, skip.skipReason, skip.policyRuleId);
  }
  try {
    const artifact = await executeSharedWriterStage({
      stage: 'audit',
      stageInput: input,
    });
    return {
      stage: 'audit',
      status: 'completed',
      artifact,
      diagnostics: artifact.diagnostics || [],
      requirementResult: evaluateStageRequirements(input, artifact),
    };
  } catch (error) {
    return {
      stage: 'audit',
      status: 'failed',
      diagnostics: [error instanceof Error ? error.message : String(error)],
      error,
      requirementResult: evaluateStageRequirements(input, {
        stage: 'audit',
        body: '',
      }),
    };
  }
}

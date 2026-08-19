/**
 * Phase 4 (二 §7.2): ONE QA implementation.
 *
 * The compact Standard pipeline uses this single `runQaStage()` as its only
 * QA stage. It replaces the legacy `runReviewStage` / `runAuditStage` /
 * `runFactCheckStage` for the active path. Legacy resume keeps the old
 * adapters; they delegate here only when called, so historical tasks
 * honoring the frozen legacy topology resume through the unified compiler
 * but never re-dispatch from a compact path.
 *
 * Scenario differences (Outline obligations vs Continuation Canon/Boundary/
 * Seam/Anchor) are delivered exclusively through frozen requirements — the
 * ONE QA compiler / writer / context projection is unchanged.
 */
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

export async function runQaStage(
  input: SharedWritingStageInput,
): Promise<SharedWritingStageResult> {
  const blocked = preflightSharedStage({ stage: 'qa', stageInput: input });
  if (blocked) return blocked;
  const skip = resolveStageSkipOrNull('qa', input);
  if (skip.skip) {
    return skippedStageResult(
      'qa',
      input,
      skip.skipReason,
      skip.policyRuleId,
    );
  }
  try {
    const artifact = await executeSharedWriterStage({
      stage: 'qa',
      stageInput: input,
    });
    return {
      stage: 'qa',
      status: 'completed',
      artifact,
      diagnostics: artifact.diagnostics || [],
      requirementResult: evaluateStageRequirements(input, artifact),
    };
  } catch (error) {
    return {
      stage: 'qa',
      status: 'failed',
      diagnostics: [error instanceof Error ? error.message : String(error)],
      error,
      requirementResult: evaluateStageRequirements(input, {
        stage: 'qa',
        body: '',
      }),
    };
  }
}
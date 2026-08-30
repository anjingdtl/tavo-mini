import type {
  SharedWritingArtifact,
  SharedWritingStageInput,
  SharedWritingStageResult,
} from '../contracts/writingStage';
import { evaluateWritingRequirements } from '../contracts/writingRequirement';
import { preflightSharedStage } from './sharedStage';
import { resolveStageSkipOrNull, skippedStageResult } from './writerCore';
import {
  finalCandidateModeForPolicy,
  resolvePersistenceBoundaryCandidate,
} from './finalCandidate';

export async function runPersistStage(
  input: SharedWritingStageInput,
): Promise<SharedWritingStageResult> {
  const blocked = preflightSharedStage({
    stage: 'persist',
    stageInput: input,
  });
  if (blocked) return blocked;
  const skip = resolveStageSkipOrNull('persist', input);
  if (skip.skip) {
    return skippedStageResult(
      'persist',
      input,
      skip.skipReason,
      skip.policyRuleId,
    );
  }
  // The validated Final Candidate is the single source of truth. Persist does
  // NOT re-derive its own proof→revision→draft chain (no dual truth). Under
  // the compact contract this never reads a Proof artifact at all.
  const candidateBody = resolvePersistenceBoundaryCandidate(input.artifacts, {
    mode: finalCandidateModeForPolicy(input.stagePolicy),
  }).body;
  if (!candidateBody.trim()) {
    return {
      stage: 'persist',
      status: 'failed',
      diagnostics: ['PERSIST_BODY_MISSING'],
      requirementResult: evaluateWritingRequirements({
        requirements: input.requirements,
        satisfiedIds: [],
      }),
    };
  }
  const artifact: SharedWritingArtifact = {
    stage: 'persist',
    body: candidateBody,
    diagnostics: ['persisted'],
  };
  try {
    if (input.persistAdapter?.persistFinal) {
      await input.persistAdapter.persistFinal(input.artifacts);
    } else {
      await input.persistAdapter?.persistStageArtifact('persist', artifact);
    }
    return {
      stage: 'persist',
      status: 'completed',
      artifact,
      diagnostics: ['persisted'],
      requirementResult: evaluateWritingRequirements({
        requirements: input.requirements,
        satisfiedIds: [],
      }),
    };
  } catch (error) {
    return {
      stage: 'persist',
      status: 'failed',
      diagnostics: [error instanceof Error ? error.message : String(error)],
      error,
      requirementResult: evaluateWritingRequirements({
        requirements: input.requirements,
        satisfiedIds: [],
      }),
    };
  }
}

import { evaluateWritingRequirements } from '../contracts/writingRequirement';
import type {
  SharedWritingStageInput,
  SharedWritingStageResult,
} from '../contracts/writingStage';
import type { SharedWritingStageName } from '../contracts/writingPolicy';

/**
 * The single post-Freeze stage boundary. Scenario adapters can only supply a
 * durable operation; validation, requirement binding and failure semantics are
 * owned here and therefore cannot drift between Outline and Continuation.
 */
export async function runSharedStage<T = unknown>(input: {
  stage: SharedWritingStageName;
  stageInput: SharedWritingStageInput;
}): Promise<SharedWritingStageResult<T>> {
  const { stage, stageInput } = input;
  const diagnostics: string[] = [];
  if (
    stageInput.stagePolicy.requirementsFingerprint !==
    stageInput.requirements.fingerprint
  ) {
    return {
      stage,
      status: 'blocked',
      diagnostics: ['WRITING_REQUIREMENT_FINGERPRINT_DRIFT'],
      requirementResult: {
        ok: false,
        satisfiedIds: [],
        missingIds: [],
        blockingIds: [],
        falseAppliedIds: [],
      },
    };
  }
  if (!stageInput.frozenContext.freezeFingerprint) {
    return {
      stage,
      status: 'blocked',
      diagnostics: ['WRITING_FROZEN_CONTEXT_MISSING'],
      requirementResult: {
        ok: false,
        satisfiedIds: [],
        missingIds: [],
        blockingIds: [],
        falseAppliedIds: [],
      },
    };
  }
  if (
    stageInput.trace.freezeFingerprint !==
    stageInput.frozenContext.freezeFingerprint
  ) {
    return {
      stage,
      status: 'blocked',
      diagnostics: ['WRITING_FREEZE_FINGERPRINT_DRIFT'],
      requirementResult: {
        ok: false,
        satisfiedIds: [],
        missingIds: [],
        blockingIds: [],
        falseAppliedIds: [],
      },
    };
  }
  if (
    stageInput.trace.requirementsFingerprint &&
    stageInput.trace.requirementsFingerprint !==
      stageInput.requirements.fingerprint
  ) {
    return {
      stage,
      status: 'blocked',
      diagnostics: ['WRITING_REQUIREMENT_FINGERPRINT_DRIFT'],
      requirementResult: {
        ok: false,
        satisfiedIds: [],
        missingIds: [],
        blockingIds: [],
        falseAppliedIds: [],
      },
    };
  }

  // Binding the frozen requirement IDs here records that every stage received
  // the same Canon/Boundary/Seam/Anchor/Style/Obligation contract. Semantic
  // satisfaction is evaluated by Review/Audit/Final Validate plugins.
  const requirementResult = evaluateWritingRequirements({
    requirements: stageInput.requirements,
    satisfiedIds: stageInput.requirements.items.map(item => item.id),
  });
  try {
    const artifact = (await stageInput.execute()) as T;
    return {
      stage,
      status: 'completed',
      artifact,
      diagnostics,
      requirementResult,
    };
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
    return {
      stage,
      status: 'failed',
      diagnostics,
      error,
      requirementResult,
    };
  }
}

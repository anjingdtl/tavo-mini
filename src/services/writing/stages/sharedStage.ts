import { evaluateWritingRequirements } from '../contracts/writingRequirement';
import type {
  SharedWritingStageInput,
  SharedWritingStageResult,
} from '../contracts/writingStage';
import type { SharedWritingStageName } from '../contracts/writingPolicy';
import {
  emptyRequirementResult,
  gateSharedStageInput,
} from './writerCore';

/**
 * Shared pre-flight for every post-Freeze stage. It never executes a
 * scenario writer and never marks a missing stage as completed.
 */
export function preflightSharedStage(input: {
  stage: SharedWritingStageName;
  stageInput: SharedWritingStageInput;
}): SharedWritingStageResult | null {
  const code = gateSharedStageInput(input.stageInput);
  if (!code) return null;
  return {
    stage: input.stage,
    status: 'blocked',
    diagnostics: [code],
    requirementResult: emptyRequirementResult(),
  };
}

export function completedStageResult<T>(input: {
  stage: SharedWritingStageName;
  stageInput: SharedWritingStageInput;
  artifact: T;
  diagnostics?: string[];
}): SharedWritingStageResult<T> {
  return {
    stage: input.stage,
    status: 'completed',
    artifact: input.artifact,
    diagnostics: input.diagnostics || [],
    requirementResult: evaluateWritingRequirements({
      requirements: input.stageInput.requirements,
      satisfiedIds: [],
    }),
  };
}

import { v4 } from '../uuidBridge';
import { assertValidWritingSourceBundle } from './contracts/writingSourceValidation';
import type {
  FrozenModelConfig,
  WritingInstruction,
  WritingPolicySnapshot,
  WritingRequest,
  WritingScenario,
  WritingSourceBundle,
} from './contracts/writingSource';

export interface LegacyRestartInput {
  legacyTaskId: string;
  projectId: number;
  chapterId: number;
  scenario: WritingScenario;
  instruction: WritingInstruction;
  sourceBundle: WritingSourceBundle;
  model: FrozenModelConfig;
  policy: WritingPolicySnapshot;
}

/**
 * Execution Compatibility is deliberately NO: this creates a new request
 * from user data and never accepts a checkpoint, frozen context, stage result,
 * review artifact, or resume token from the legacy task.
 */
export function restartLegacyWritingTask(
  input: LegacyRestartInput,
): WritingRequest {
  assertValidWritingSourceBundle(input.scenario, input.sourceBundle);
  return {
    writingRunId: `wr_${v4()}`,
    generationTraceId: `gt_${v4()}`,
    projectId: input.projectId,
    chapterId: input.chapterId,
    scenario: input.scenario,
    instruction: { ...input.instruction },
    sourceBundle: input.sourceBundle,
    model: { ...input.model },
    policy: { ...input.policy, values: { ...input.policy.values } },
    legacyRestart: {
      restartedFromLegacyTaskId: input.legacyTaskId,
    },
  };
}

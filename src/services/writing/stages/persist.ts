import type {
  SharedWritingArtifact,
  SharedWritingStageInput,
  SharedWritingStageResult,
} from '../contracts/writingStage';
import { evaluateWritingRequirements } from '../contracts/writingRequirement';
import { preflightSharedStage } from './sharedStage';
import {
  resolveStageSkipOrNull,
  skippedStageResult,
} from './writerCore';

function readBody(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>;
    if (typeof row.body === 'string') return row.body;
    if (typeof row.content === 'string') return row.content;
  }
  return '';
}

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
  const body =
    readBody(input.artifacts.finalValidate) ||
    readBody(input.artifacts.proof) ||
    readBody(input.artifacts.revision) ||
    readBody(input.artifacts.draft);
  if (!body.trim()) {
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
    body,
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

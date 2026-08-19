import type {
  SharedWritingArtifact,
  SharedWritingStageInput,
  SharedWritingStageResult,
} from '../contracts/writingStage';
import { evaluateWritingRequirements } from '../contracts/writingRequirement';
import { preflightSharedStage } from './sharedStage';
import { resolveStageSkipOrNull, skippedStageResult } from './writerCore';
import { checkSemanticRequirementApplication } from './semanticApply';
import {
  finalCandidateModeForPolicy,
  resolveFinalWritingCandidate,
} from './finalCandidate';

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

export async function runFinalValidateStage(
  input: SharedWritingStageInput,
): Promise<SharedWritingStageResult> {
  const blocked = preflightSharedStage({
    stage: 'finalValidate',
    stageInput: input,
  });
  if (blocked) return blocked;
  const skip = resolveStageSkipOrNull('finalValidate', input);
  if (skip.skip) {
    return skippedStageResult(
      'finalValidate',
      input,
      skip.skipReason,
      skip.policyRuleId,
    );
  }

  // ONE Final Candidate — single source of truth. No proof dependency in the
  // compact contract; legacy resume may include proof via candidate mode.
  const candidate = resolveFinalWritingCandidate(input.artifacts, {
    mode: finalCandidateModeForPolicy(input.stagePolicy),
  });
  const finalBody = candidate.body;
  if (!finalBody.trim()) {
    return {
      stage: 'finalValidate',
      status: 'failed',
      diagnostics: ['FINAL_BODY_MISSING'],
      requirementResult: evaluateWritingRequirements({
        requirements: input.requirements,
        satisfiedIds: [],
      }),
    };
  }

  const artifact: SharedWritingArtifact = {
    stage: 'finalValidate',
    sourceStage: candidate.sourceStage,
    body: finalBody,
    structured: candidate.structured,
    appliedRequirementIds: candidate.appliedRequirementIds,
    validNoOpRequirementIds: candidate.validNoOpRequirementIds,
    validNoOpReasons: candidate.validNoOpReasons,
  };

  if (input.stagePolicy.semanticApplyRequired) {
    const semanticInput =
      typeof input.semanticApply === 'function'
        ? await input.semanticApply()
        : input.semanticApply || {
            beforeRevisionBody:
              (readBody(input.artifacts.revision) ||
                input.frozenContext.instruction.currentContent ||
                ''),
            finalBody,
            appliedRequirementIds: artifact.appliedRequirementIds || [],
            validNoOpRequirementIds: artifact.validNoOpRequirementIds,
            validNoOpReasons: artifact.validNoOpReasons,
          };
    const semantic = checkSemanticRequirementApplication(semanticInput);
    if (!semantic.ok) {
      return {
        stage: 'finalValidate',
        status: 'failed',
        artifact,
        diagnostics: [semantic.code || 'SEMANTIC_APPLY_FAILED'],
        requirementResult: evaluateWritingRequirements({
          requirements: input.requirements,
          appliedIds: artifact.appliedRequirementIds,
        }),
      };
    }
  }

  await input.persistAdapter?.persistStageArtifact('finalValidate', artifact);
  return {
    stage: 'finalValidate',
    status: 'completed',
    artifact,
    diagnostics: [],
    requirementResult: evaluateWritingRequirements({
      requirements: input.requirements,
      satisfiedIds: artifact.appliedRequirementIds || [],
    }),
  };
}
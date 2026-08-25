import type {
  WritingCredentialRef,
  WritingRequest,
} from './writingSource';
import type { WritingRequirements } from './writingRequirement';
import { compileKernelStageReasoning } from './stageReasoning';
import {
  isOneShotValues,
  ONE_SHOT_EXECUTION_PROFILE_POLICY,
} from './executionProfile';
import {
  isGenerationQualityProfile,
  mapGenerationQualityProfile,
} from './generationQualityProfile';

export type SharedWritingStageName =
  | 'draft'
  | 'qa'
  | 'review'
  | 'audit'
  | 'factCheck'
  | 'revision'
  | 'proof'
  | 'finalValidate'
  | 'persist';

/** Provider-neutral model snapshot shared by every post-Freeze stage. */
export interface FrozenStageModelConfig {
  configId: number | null;
  name: string;
  providerType: string;
  url: string;
  modelName: string;
  contextWindow: number;
  maxOutputTokens: number;
  allowInsecureLanHttp?: boolean;
  thinking?: { type: 'enabled' | 'disabled' };
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  credentialRef?: WritingCredentialRef | null;
}

export type WritingOutputContract = 'prose' | 'json_envelope';

export interface SharedStageSkipRule {
  skipReason: string;
  policyRuleId: string;
}

export interface WritingStagePolicy {
  version: 1;
  reviewMode: string;
  strictness: string;
  semanticApplyRequired: boolean;
  stageOrder: SharedWritingStageName[];
  outputContract: WritingOutputContract;
  skipRules: Partial<Record<SharedWritingStageName, SharedStageSkipRule>>;
  values: Record<string, unknown>;
  requirementsFingerprint: string;
}

const DEFAULT_STAGE_ORDER: SharedWritingStageName[] = [
  'draft',
  'review',
  'audit',
  'factCheck',
  'revision',
  'proof',
  'finalValidate',
  'persist',
];

/**
 * One-Shot (极速) profile skips every paid AI audit/revision stage. These
 * formal skip rules express the Execution Profile inside the ONE frozen
 * stage policy — never a second writer, compiler, or context builder.
 */
function oneShotSkipRules(): WritingStagePolicy['skipRules'] {
  return {
    qa: {
      skipReason: 'One-Shot profile executes exactly one paid LLM call (the draft)',
      policyRuleId: 'profile.one_shot.skip_qa',
    },
    review: {
      skipReason: 'One-Shot profile skips AI review',
      policyRuleId: 'profile.one_shot.skip_review',
    },
    audit: {
      skipReason: 'One-Shot profile skips AI audit',
      policyRuleId: 'profile.one_shot.skip_audit',
    },
    factCheck: {
      skipReason: 'One-Shot profile skips AI fact-check',
      policyRuleId: 'profile.one_shot.skip_factCheck',
    },
    revision: {
      skipReason: 'One-Shot profile skips AI revision',
      policyRuleId: 'profile.one_shot.skip_revision',
    },
    proof: {
      skipReason: 'One-Shot profile skips AI proof / final reviser',
      policyRuleId: 'profile.one_shot.skip_proof',
    },
  };
}

function continuationStylePolicy(
  reviewMode: string,
  values: Record<string, unknown>,
): boolean {
  return (
    reviewMode === 'continuation-v5' ||
    values.workflowVersion === 5 ||
    values.outputContract === 'json_envelope'
  );
}

/** One policy compiler for both source adapters; it never selects a writer. */
export function buildWritingStagePolicy(
  request: WritingRequest,
  requirements: WritingRequirements,
): WritingStagePolicy {
  const values = { ...request.policy.values };
  const continuation = continuationStylePolicy(
    request.policy.reviewMode,
    values,
  );
  // Explicit GenerationQualityProfile is a Freeze-time mapping onto the ONE
  // Kernel contracts. When the profile key is present, its mapped reasoning
  // effort (fast→low / standard→high / quality→max) governs every paid LLM
  // stage, so a stale per-stage reasoning snapshot from the retired 4-tier
  // UI can never silently override the 3-level profile. Requests without the
  // key compile from the frozen legacy fields and stay byte-identical, so
  // historical freeze fingerprints and Resume semantics keep validating.
  const explicitQuality = isGenerationQualityProfile(values.qualityProfile)
    ? mapGenerationQualityProfile(values.qualityProfile)
    : null;
  values.stageReasoning = compileKernelStageReasoning({
    scenario: continuation ? 'continuation' : 'outline',
    modelName: request.model.modelName,
    requestedEffort: explicitQuality?.reasoningEffort ?? request.model.reasoningEffort,
    continuationThinking: request.model.thinking,
    outlineStageReasoning: explicitQuality
      ? undefined
      : (values.outlineStageReasoning as
          | Record<
              string,
              {
                thinking?: 'enabled' | 'disabled' | { type: 'enabled' | 'disabled' };
                effort?: 'low' | 'medium' | 'high' | 'max' | null;
                effectiveTier?: 'low' | 'medium' | 'high' | 'max' | null;
              }
            >
          | undefined),
  });
  const skipRules: WritingStagePolicy['skipRules'] = continuation
    ? {
        factCheck: {
          skipReason: 'Canon / boundary / seam facts are audited by the shared Audit stage',
          policyRuleId: 'policy.continuation.audit_covers_factcheck',
        },
      }
    : {
        audit: {
          skipReason: 'Outline review plus fact-check already cover consistency',
          policyRuleId: 'policy.outline.review_covers_audit',
        },
      };
  // Explicit GenerationQualityProfile is a Freeze-time mapping onto the
  // existing execution profile. Requests without the key stay byte-identical
  // so historical freeze fingerprints and Resume semantics keep validating.
  if (isGenerationQualityProfile(values.qualityProfile)) {
    const mapped = mapGenerationQualityProfile(values.qualityProfile);
    values.qualityProfile = values.qualityProfile;
    if (mapped.executionProfile === 'one_shot') {
      values.executionProfile = 'one_shot';
    }
  }
  // The Execution Profile projects on top of the scenario rules and is
  // frozen into the same stagePolicy (values + skipRules). Standard tasks
  // stay byte-identical so historical freeze fingerprints keep validating.
  if (isOneShotValues(values)) {
    values.executionProfile = 'one_shot';
    values.executionProfilePolicy = { ...ONE_SHOT_EXECUTION_PROFILE_POLICY };
    Object.assign(skipRules, oneShotSkipRules());
  }
  return {
    version: 1,
    reviewMode: request.policy.reviewMode,
    strictness: request.policy.strictness,
    semanticApplyRequired: values.semanticApplyRequired !== false,
    stageOrder: [...DEFAULT_STAGE_ORDER],
    outputContract: continuation ? 'json_envelope' : 'prose',
    skipRules,
    values,
    requirementsFingerprint: requirements.fingerprint,
  };
}

export function resolveSharedStageSkip(
  policy: WritingStagePolicy,
  stage: SharedWritingStageName,
): { skip: false } | { skip: true; skipReason: string; policyRuleId: string } {
  const rule = policy.skipRules?.[stage];
  if (!rule) return { skip: false };
  return {
    skip: true,
    skipReason: rule.skipReason,
    policyRuleId: rule.policyRuleId,
  };
}

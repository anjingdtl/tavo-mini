import type { WritingRequest } from './writingSource';
import type { WritingRequirements } from './writingRequirement';

export type SharedWritingStageName =
  | 'draft'
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

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

export interface WritingStagePolicy {
  version: 1;
  reviewMode: string;
  strictness: string;
  semanticApplyRequired: boolean;
  stageOrder: SharedWritingStageName[];
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

/** One policy compiler for both source adapters; it never selects a writer. */
export function buildWritingStagePolicy(
  request: WritingRequest,
  requirements: WritingRequirements,
): WritingStagePolicy {
  const values = { ...request.policy.values };
  return {
    version: 1,
    reviewMode: request.policy.reviewMode,
    strictness: request.policy.strictness,
    semanticApplyRequired: values.semanticApplyRequired !== false,
    stageOrder: [...DEFAULT_STAGE_ORDER],
    values,
    requirementsFingerprint: requirements.fingerprint,
  };
}

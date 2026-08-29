/**
 * Auditable, normalized warm-start evidence for the writing Governor.
 *
 * These are ratios, never business-token caps.  The values were derived from
 * the project's real C1/C2 successful Draft receipts:
 *
 * - test-logs/phase3-c-c2-android/c2-corrected-matrix-safe-projection.json
 * - docs/optimization/phase3-c-progress.md (C2 500/1000/3000 Quality table)
 *
 * Only complete `finishReason=stop` samples are used as capacity evidence.
 * The current C3 correction intentionally does not read test logs at runtime;
 * this small versioned registry is the reviewed runtime projection of that
 * evidence.  Provider/model matching is explicit capability/configuration
 * data.  No model family is inferred from a model-name substring.
 */

export const WRITING_GOVERNOR_BOOTSTRAP_PRIOR_VERSION =
  'writing-governor-bootstrap-v1' as const;

export type BootstrapPriorMatch =
  | 'exact_provider_model'
  | 'provider_model_family'
  | 'generic_reasoning_model';

export interface WritingGovernorBootstrapPrior {
  version: typeof WRITING_GOVERNOR_BOOTSTRAP_PRIOR_VERSION;
  source: string;
  match: BootstrapPriorMatch;
  providerAdapterId: string | null;
  modelName: string | null;
  stage: string;
  qualityProfile: string;
  /** Safe high-water ratio: reasoning tokens / current visible demand. */
  reasoningDemandRatioP95: number;
  /** Safe high-water ratio: reasoning tokens / current actual prompt tokens. */
  reasoningPromptRatioP95: number;
}

type PriorSpec = Omit<
  WritingGovernorBootstrapPrior,
  'version' | 'source' | 'match'
>;

const EVIDENCE_SOURCE =
  'C2-real-stop-receipts:c2-corrected-matrix-safe-projection+phase3-c-progress';

const EXACT_PRIORS: readonly PriorSpec[] = [
  // The conservative ratios are normalized high-water projections of the
  // successful GLM-5.3-Flash Draft receipts, with the larger historical
  // reasoning cases retained instead of allowing a fresh profile to start
  // from the failed 2,899-token envelope.
  {
    providerAdapterId: 'open.bigmodel.cn-v4',
    modelName: 'GLM-5.3-Flash',
    stage: 'draft',
    qualityProfile: 'fast',
    reasoningDemandRatioP95: 3.6,
    reasoningPromptRatioP95: 0.5,
  },
  {
    providerAdapterId: 'open.bigmodel.cn-v4',
    modelName: 'GLM-5.3-Flash',
    stage: 'draft',
    qualityProfile: 'standard',
    reasoningDemandRatioP95: 2.4,
    reasoningPromptRatioP95: 0.6,
  },
  {
    providerAdapterId: 'open.bigmodel.cn-v4',
    modelName: 'GLM-5.3-Flash',
    stage: 'draft',
    qualityProfile: 'quality',
    reasoningDemandRatioP95: 5.25,
    reasoningPromptRatioP95: 0.7,
  },
] as const;

const PROVIDER_FAMILY_PRIORS: readonly PriorSpec[] = [
  {
    providerAdapterId: 'open.bigmodel.cn-v4',
    modelName: null,
    stage: 'draft',
    qualityProfile: 'fast',
    reasoningDemandRatioP95: 4.0,
    reasoningPromptRatioP95: 0.55,
  },
  {
    providerAdapterId: 'open.bigmodel.cn-v4',
    modelName: null,
    stage: 'draft',
    qualityProfile: 'standard',
    reasoningDemandRatioP95: 3.2,
    reasoningPromptRatioP95: 0.65,
  },
  {
    providerAdapterId: 'open.bigmodel.cn-v4',
    modelName: null,
    stage: 'draft',
    qualityProfile: 'quality',
    reasoningDemandRatioP95: 5.5,
    reasoningPromptRatioP95: 0.75,
  },
] as const;

const GENERIC_PRIORS: readonly PriorSpec[] = [
  {
    providerAdapterId: null,
    modelName: null,
    stage: 'draft',
    qualityProfile: 'fast',
    reasoningDemandRatioP95: 2.0,
    reasoningPromptRatioP95: 0.35,
  },
  {
    providerAdapterId: null,
    modelName: null,
    stage: 'draft',
    qualityProfile: 'standard',
    // Unknown capabilities must remain bounded by the configured output
    // capability; the exact provider/model prior above is what carries the
    // project's high-reasoning GLM evidence.
    reasoningDemandRatioP95: 1.5,
    reasoningPromptRatioP95: 0.2,
  },
  {
    providerAdapterId: null,
    modelName: null,
    stage: 'draft',
    qualityProfile: 'quality',
    reasoningDemandRatioP95: 3.5,
    reasoningPromptRatioP95: 0.6,
  },
  // C4/C5 keep their own production opt-in, but their shadow still benefits
  // from a reasoning-heavy generic prior for observability and later rollout.
  {
    providerAdapterId: null,
    modelName: null,
    stage: 'qa',
    qualityProfile: 'standard',
    reasoningDemandRatioP95: 3.5,
    reasoningPromptRatioP95: 0.55,
  },
  {
    providerAdapterId: null,
    modelName: null,
    stage: 'revision',
    qualityProfile: 'standard',
    reasoningDemandRatioP95: 3.0,
    reasoningPromptRatioP95: 0.5,
  },
] as const;

function normalizedQuality(value: unknown): string {
  const candidate = String(value ?? '').trim().toLowerCase();
  return candidate === 'fast' || candidate === 'quality'
    ? candidate
    : 'standard';
}

function buildPrior(
  spec: PriorSpec,
  match: BootstrapPriorMatch,
): WritingGovernorBootstrapPrior {
  return {
    version: WRITING_GOVERNOR_BOOTSTRAP_PRIOR_VERSION,
    source: EVIDENCE_SOURCE,
    match,
    ...spec,
  };
}

/** Resolve exact → explicit adapter family → generic prior. */
export function resolveWritingGovernorBootstrapPrior(input: {
  providerAdapterId?: string | null;
  modelName?: string | null;
  stage: string;
  qualityProfile?: string | null;
}): WritingGovernorBootstrapPrior {
  const providerAdapterId = String(input.providerAdapterId ?? '').trim();
  const modelName = String(input.modelName ?? '').trim();
  const qualityProfile = normalizedQuality(input.qualityProfile);
  const exact = EXACT_PRIORS.find(
    prior =>
      prior.providerAdapterId === providerAdapterId &&
      prior.modelName === modelName &&
      prior.stage === input.stage &&
      prior.qualityProfile === qualityProfile,
  );
  if (exact) return buildPrior(exact, 'exact_provider_model');

  const family = PROVIDER_FAMILY_PRIORS.find(
    prior =>
      prior.providerAdapterId === providerAdapterId &&
      prior.stage === input.stage &&
      prior.qualityProfile === qualityProfile,
  );
  if (family) return buildPrior(family, 'provider_model_family');

  const generic =
    GENERIC_PRIORS.find(
      prior =>
        prior.stage === input.stage &&
        prior.qualityProfile === qualityProfile,
    ) || GENERIC_PRIORS.find(prior => prior.stage === 'draft');
  return buildPrior(generic!, 'generic_reasoning_model');
}

/**
 * Phase III-C production Governor.
 *
 * The Governor is still a deterministic calculation at the final compiled
 * message boundary. It does not create an LLM request. C3 changes only the
 * Draft, QA, and Revision each have independent profile/policy gates. The
 * Governor never creates a request or changes the existing stage topology.
 */
import { sha256Hex } from '../../continuation/hashUtils';
import { estimateMessagesTokens, estimateTokens } from '../../../utils/tokenEstimator';
import { estimateTargetChapterTokens } from '../scenario/continuationStageCapacity';
import type { ChatMessage } from '../../llm/types';
import {
  resolveWritingGovernorBootstrapPrior,
  type BootstrapPriorMatch,
} from './writingGovernorBootstrapPrior';

/** Bump this whenever cold start, readiness, or learning semantics change. */
export const WRITING_GOVERNOR_VERSION =
  'writing-governor-production-v3' as const;
export const WRITING_GOVERNOR_POLICY_VERSION = WRITING_GOVERNOR_VERSION;
export const WRITING_GOVERNOR_PROMPT_COMPILER_VERSION =
  'shared-prompt-compiler-v1' as const;
export const WRITING_GOVERNOR_REASONING_POLICY_VERSION =
  'kernel-reasoning-policy-v2' as const;
export const WRITING_GOVERNOR_REASONING_SEED_VERSION =
  'safe-warm-start-prior-v1' as const;
/** QA has a separate profile identity so old C3 QA failures cannot authorize it. */
export const WRITING_GOVERNOR_QA_POLICY_VERSION =
  'compact-qa-governor-v1' as const;
/** Revision has a separate contract/prior and cannot inherit QA evidence. */
export const WRITING_GOVERNOR_REVISION_POLICY_VERSION =
  'revision-governor-v1' as const;

export const WRITING_GOVERNOR_POLICY = {
  /** Policy parameters are versioned above instead of hidden business caps. */
  minCompleteStopSamples: 3,
  minReasoningExactSamples: 3,
  minCounterfactualSafeSamples: 3,
  minHealthySuccessStreak: 3,
  recoverySuccessSamplesPerTrip: 3,
  counterfactualMaxUtilization: 0.9,
  localProfilePseudoCount: 3,
  localProfileMaxWeight: 0.85,
  localSafetyFloorRatio: 0.82,
  trippedRecoveryRatio: 1.25,
  recoveryScaleFloor: 1.25,
  recoveryScaleRise: 1.35,
  unsafeScaleRise: 1.12,
  slowTighteningDecay: 0.97,
  highUtilizationRise: 1.02,
  minRecommendedScale: 0.75,
  maxRecommendedScale: 2.5,
  lowUtilizationRatio: 0.45,
  highUtilizationRatio: 0.9,
  contextSafetyReserveRatio: 0.02,
  minOutputSafetyReserve: 32,
  outputSafetyReserveRatio: 0.08,
  reasoningEwmaAlpha: 0.2,
  reasoningHighWaterDecay: 0.98,
  maxReasoningDemandRatio: 8,
  maxReasoningPromptRatio: 1.5,
} as const;

export type WritingGovernorProductionState =
  | 'BOOTSTRAP_SAFE'
  | 'PROBATION'
  | 'ACTIVE'
  | 'TRIPPED';

export type GovernorReasoningEffort = 'low' | 'medium' | 'high' | 'max';

export interface WritingGovernorProfile {
  version: 2;
  profileKey: string;
  /** All learnable results, including censored length signals. */
  sampleCount: number;
  knownResultCount: number;
  /** Consecutive low-utilization complete-stop streak. */
  lowUtilizationCount: number;
  /** Censored lower-bound signals; never exact reasoning samples. */
  lengthSignalCount: number;
  recommendedScale: number;
  /** Complete-stop-only aggregate. */
  averageCompletionRatio: number | null;
  averageLatencyMs: number | null;
  /** Exact complete-stop reasoning feedback only. */
  reasoningSampleCount: number;
  reasoningRatioEwma: number | null;
  reasoningRatioHighWater: number | null;
  reasoningPromptRatioEwma: number | null;
  reasoningPromptRatioHighWater: number | null;
  /** Provider finish reason, optionally carrying a bounded CF safety debt. */
  lastFinishReason: string | null;
  updatedAt: number;
  /** Derived semantic counters/status; not extra database columns. */
  completeStopCount: number;
  reasoningExactSampleCount: number;
  counterfactualSafeCount: number;
  counterfactualUnsafeCount: number;
  productionState: WritingGovernorProductionState;
  productionReady: boolean;
}

export interface WritingGovernorProfileStore {
  profiles: Record<string, WritingGovernorProfile>;
}

export type WritingGovernorProfilePersistenceSink = (
  profile: WritingGovernorProfile,
) => void | Promise<void>;

export interface ResolveWritingGovernorShadowInput {
  stage: string;
  messages: ChatMessage[];
  /** The value the mature Writer would send before the C3 takeover. */
  legacyWireMax: number;
  contextWindow: number;
  completionCapability: number;
  providerWireCeiling?: number | null;
  providerAdapterId?: string | null;
  modelName?: string | null;
  targetChars?: number | null;
  outputContract: 'prose' | 'json_envelope';
  qualityProfile?: 'fast' | 'standard' | 'quality' | string | null;
  executionProfile?: 'standard' | 'one_shot' | string | null;
  thinking?: { type: 'enabled' | 'disabled' };
  reasoningEffort?: GovernorReasoningEffort | null;
  promptCompilerVersion?: string;
  reasoningPolicyVersion?: string;
}

export interface WritingGovernorShadow {
  version: typeof WRITING_GOVERNOR_VERSION;
  mode: 'shadow';
  stage: string;
  profileKey: string;
  policyVersion: typeof WRITING_GOVERNOR_POLICY_VERSION;
  coldStart: boolean;
  learned: boolean;
  hydrated: boolean;
  productionState: WritingGovernorProductionState;
  productionReady: boolean;
  /** True only when this exact shadow profile is ready for wire takeover. */
  productionEnabled: boolean;
  profileSampleCount: number;
  completeStopCount: number;
  reasoningExactSampleCount: number;
  counterfactualSafeCount: number;
  counterfactualUnsafeCount: number;
  providerAdapterId: string | null;
  modelName: string;
  qualityProfile: string | null;
  executionProfile: string | null;
  outputContract: 'prose' | 'json_envelope';
  thinkingEnabled: boolean;
  reasoningEffort: GovernorReasoningEffort | null;
  reasoningSeedVersion: typeof WRITING_GOVERNOR_REASONING_SEED_VERSION;
  bootstrapPriorVersion: string;
  bootstrapPriorSource: string;
  bootstrapPriorMatch: BootstrapPriorMatch;
  bootstrapReasoningDemandRatio: number;
  bootstrapReasoningPromptRatio: number;
  bootstrapWeight: number;
  localProfileWeight: number;
  contextCapability: number;
  completionCapability: number;
  providerWireCeiling: number | null;
  actualPromptTokens: number;
  targetChars: number;
  visibleDemand: number;
  visibleOutputFloor: number;
  demandFloor: number;
  reasoningEnvelope: number;
  protocolReserve: number;
  /** Context-only reserve; it is never part of output demand. */
  contextSafetyReserve: number;
  /** Output-only reserve; it is demand-relative, never context-relative. */
  outputSafetyReserve: number;
  /** @deprecated Compatibility alias for old receipts. */
  safetyReserve: number;
  recommendedSoftBudget: number;
  hardCeiling: number;
  recommendedWireMax: number;
  legacyWireMax: number;
  pressure: number;
  preflightBlocked: boolean;
  recommendationMeetsDemandFloor: boolean;
  actualCompletionUsage: number | null;
  visibleOutput: number | null;
  reasoningUsage: number | null;
  finishReason: string | null;
  latencyMs: number | null;
  /** Populated only when an observed complete stop is evaluated. */
  counterfactualUtilization: number | null;
  counterfactualSafe: boolean | null;
}

export interface WritingGovernorWireDecision {
  enabled: boolean;
  blocked: boolean;
  wireMax: number | null;
  reason:
    | 'demand_exceeds_hard_ceiling'
    | 'recommendation_below_demand_floor'
    | null;
}

export interface WritingGovernorObservation {
  actualCompletionUsage: number | null;
  visibleOutput: number | null;
  reasoningUsage: number | null;
  finishReason: string | null;
  latencyMs: number | null;
  businessResultValid: boolean;
  failureClass?: string | null;
}

function nonNegative(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function positive(value: unknown, fallback = 1): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeEffort(value: unknown): GovernorReasoningEffort {
  if (value === 'low') return 'low';
  if (value === 'medium') return 'medium';
  if (value === 'max') return 'max';
  return 'high';
}

function reasoningRatio(effort: GovernorReasoningEffort): number {
  // A small policy seed remains a fallback below the evidence-based prior;
  // it is not an absolute output cap.
  return {
    low: 0.2,
    medium: 0.28,
    high: 0.38,
    max: 0.5,
  }[effort];
}

function effortMultiplier(effort: GovernorReasoningEffort): number {
  return {
    low: 0.9,
    medium: 0.95,
    high: 1,
    max: 1.08,
  }[effort];
}

function isStructuredReportStage(stage: string): boolean {
  return (
    stage === 'qa' ||
    stage === 'review' ||
    stage === 'audit' ||
    stage === 'factCheck'
  );
}

function profileKeyFor(input: ResolveWritingGovernorShadowInput): string {
  return sha256Hex(
    JSON.stringify({
      policyVersion: WRITING_GOVERNOR_POLICY_VERSION,
      providerAdapterId: String(input.providerAdapterId ?? ''),
      modelName: String(input.modelName ?? ''),
      stage: input.stage,
      qualityProfile: input.qualityProfile ?? null,
      executionProfile: input.executionProfile ?? null,
      outputContract: input.outputContract,
      promptCompilerVersion:
        input.promptCompilerVersion || WRITING_GOVERNOR_PROMPT_COMPILER_VERSION,
      reasoningPolicyVersion:
        input.reasoningPolicyVersion || WRITING_GOVERNOR_REASONING_POLICY_VERSION,
      reasoningSeedVersion: WRITING_GOVERNOR_REASONING_SEED_VERSION,
      ...(input.stage === 'qa'
        ? { qaPolicyVersion: WRITING_GOVERNOR_QA_POLICY_VERSION }
        : input.stage === 'revision'
        ? { revisionPolicyVersion: WRITING_GOVERNOR_REVISION_POLICY_VERSION }
        : {}),
    }),
  );
}

function isQaSafeWarmStartCandidate(input: {
  stage: string;
  outputContract: 'prose' | 'json_envelope';
  thinkingEnabled: boolean;
  bootstrapPriorMatch: BootstrapPriorMatch;
  productionState: WritingGovernorProductionState;
  counterfactualUnsafeCount: number;
}): boolean {
  return (
    input.stage === 'qa' &&
    input.outputContract === 'json_envelope' &&
    input.thinkingEnabled &&
    input.bootstrapPriorMatch === 'exact_provider_model' &&
    input.productionState !== 'TRIPPED' &&
    input.counterfactualUnsafeCount === 0
  );
}

function isRevisionSafeWarmStartCandidate(input: {
  stage: string;
  outputContract: 'prose' | 'json_envelope';
  thinkingEnabled: boolean;
  bootstrapPriorMatch: BootstrapPriorMatch;
  productionState: WritingGovernorProductionState;
  counterfactualUnsafeCount: number;
}): boolean {
  return (
    input.stage === 'revision' &&
    input.outputContract === 'json_envelope' &&
    input.thinkingEnabled &&
    input.bootstrapPriorMatch === 'exact_provider_model' &&
    input.productionState !== 'TRIPPED' &&
    input.counterfactualUnsafeCount === 0
  );
}

function isStageSafeWarmStartCandidate(input: {
  stage: string;
  outputContract: 'prose' | 'json_envelope';
  thinkingEnabled: boolean;
  bootstrapPriorMatch: BootstrapPriorMatch;
  productionState: WritingGovernorProductionState;
  counterfactualUnsafeCount: number;
}): boolean {
  return (
    isQaSafeWarmStartCandidate(input) ||
    isRevisionSafeWarmStartCandidate(input)
  );
}

function boundedRatio(value: unknown, maximum: number): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? clamp(parsed, 0, maximum)
    : null;
}

const COUNTERFACTUAL_MARKER = 'cf-unsafe:';

function parseCounterfactualDebt(value: unknown): {
  debt: number;
  finishReason: string | null;
} {
  const raw = String(value ?? '');
  if (!raw.startsWith(COUNTERFACTUAL_MARKER)) {
    return { debt: 0, finishReason: raw || null };
  }
  const match = raw.match(/^cf-unsafe:(\d+):(.*)$/);
  if (!match) return { debt: 1, finishReason: null };
  return {
    debt: clamp(nonNegative(match[1]), 0, 999),
    finishReason: match[2] || null,
  };
}

/** Keep the safety latch in one bounded scalar already owned by Schema 60. */
function encodeCounterfactualDebt(
  finishReason: string | null,
  debt: number,
): string | null {
  if (debt <= 0) return finishReason || null;
  return `${COUNTERFACTUAL_MARKER}${clamp(Math.floor(debt), 1, 999)}:${
    finishReason || ''
  }`;
}

function emptyProfile(profileKey: string): WritingGovernorProfile {
  return {
    version: 2,
    profileKey,
    sampleCount: 0,
    knownResultCount: 0,
    lowUtilizationCount: 0,
    lengthSignalCount: 0,
    recommendedScale: 1,
    averageCompletionRatio: null,
    averageLatencyMs: null,
    reasoningSampleCount: 0,
    reasoningRatioEwma: null,
    reasoningRatioHighWater: null,
    reasoningPromptRatioEwma: null,
    reasoningPromptRatioHighWater: null,
    lastFinishReason: null,
    updatedAt: 0,
    completeStopCount: 0,
    reasoningExactSampleCount: 0,
    counterfactualSafeCount: 0,
    counterfactualUnsafeCount: 0,
    productionState: 'BOOTSTRAP_SAFE',
    productionReady: false,
  };
}

function deriveProfileState(
  profile: Omit<
    WritingGovernorProfile,
    | 'completeStopCount'
    | 'reasoningExactSampleCount'
    | 'counterfactualSafeCount'
    | 'counterfactualUnsafeCount'
    | 'productionState'
    | 'productionReady'
  >,
): Pick<
  WritingGovernorProfile,
  | 'completeStopCount'
  | 'reasoningExactSampleCount'
  | 'counterfactualSafeCount'
  | 'counterfactualUnsafeCount'
  | 'productionState'
  | 'productionReady'
> {
  const completeStopCount = Math.max(
    0,
    profile.knownResultCount - profile.lengthSignalCount,
  );
  const reasoningExactSampleCount = Math.min(
    completeStopCount,
    profile.reasoningSampleCount,
  );
  const counterfactualUnsafeCount = parseCounterfactualDebt(
    profile.lastFinishReason,
  ).debt;
  const counterfactualSafeCount = Math.max(
    0,
    completeStopCount - counterfactualUnsafeCount,
  );
  const lastFinishReason = parseCounterfactualDebt(
    profile.lastFinishReason,
  ).finishReason;
  const hasEnoughRecoveryEvidence =
    completeStopCount >=
    WRITING_GOVERNOR_POLICY.minCompleteStopSamples +
      profile.lengthSignalCount *
        WRITING_GOVERNOR_POLICY.recoverySuccessSamplesPerTrip;
  const productionReady =
    lastFinishReason !== 'length' &&
    counterfactualUnsafeCount === 0 &&
    completeStopCount >= WRITING_GOVERNOR_POLICY.minCompleteStopSamples &&
    reasoningExactSampleCount >=
      WRITING_GOVERNOR_POLICY.minReasoningExactSamples &&
    counterfactualSafeCount >=
      WRITING_GOVERNOR_POLICY.minCounterfactualSafeSamples &&
    hasEnoughRecoveryEvidence;
  const productionState: WritingGovernorProductionState =
    lastFinishReason === 'length'
      ? 'TRIPPED'
      : productionReady
      ? 'ACTIVE'
      : completeStopCount === 0
      ? 'BOOTSTRAP_SAFE'
      : 'PROBATION';
  return {
    completeStopCount,
    reasoningExactSampleCount,
    counterfactualSafeCount,
    counterfactualUnsafeCount,
    productionState,
    productionReady,
  };
}

function normalizeProfile(
  profileKey: string,
  value: Partial<WritingGovernorProfile> | null | undefined,
): WritingGovernorProfile | null {
  // v1 profiles are deliberately rejected even when their DB policy column
  // was copied incorrectly. A changed policy must start from safe bootstrap.
  if (!value || value.version !== 2) return null;
  const base = emptyProfile(profileKey);
  const normalized = {
    ...base,
    ...value,
    version: 2 as const,
    profileKey,
    sampleCount: nonNegative(value.sampleCount),
    knownResultCount: nonNegative(value.knownResultCount),
    lowUtilizationCount: nonNegative(value.lowUtilizationCount),
    lengthSignalCount: nonNegative(value.lengthSignalCount),
    recommendedScale: clamp(
      Number.isFinite(Number(value.recommendedScale))
        ? Number(value.recommendedScale)
        : 1,
      WRITING_GOVERNOR_POLICY.minRecommendedScale,
      WRITING_GOVERNOR_POLICY.maxRecommendedScale,
    ),
    averageCompletionRatio: boundedRatio(value.averageCompletionRatio, 4),
    averageLatencyMs:
      value.averageLatencyMs == null
        ? null
        : Math.max(0, Number(value.averageLatencyMs) || 0),
    reasoningSampleCount: nonNegative(value.reasoningSampleCount),
    reasoningRatioEwma: boundedRatio(
      value.reasoningRatioEwma,
      WRITING_GOVERNOR_POLICY.maxReasoningDemandRatio,
    ),
    reasoningRatioHighWater: boundedRatio(
      value.reasoningRatioHighWater,
      WRITING_GOVERNOR_POLICY.maxReasoningDemandRatio,
    ),
    reasoningPromptRatioEwma: boundedRatio(
      value.reasoningPromptRatioEwma,
      WRITING_GOVERNOR_POLICY.maxReasoningPromptRatio,
    ),
    reasoningPromptRatioHighWater: boundedRatio(
      value.reasoningPromptRatioHighWater,
      WRITING_GOVERNOR_POLICY.maxReasoningPromptRatio,
    ),
    lastFinishReason:
      value.lastFinishReason == null ? null : String(value.lastFinishReason),
    updatedAt: nonNegative(value.updatedAt),
  };
  return {
    ...normalized,
    ...deriveProfileState(normalized),
  };
}

function cloneProfile(profile: WritingGovernorProfile): WritingGovernorProfile {
  return { ...profile };
}

export function createWritingGovernorProfileStore(
  profiles?: Record<string, WritingGovernorProfile>,
): WritingGovernorProfileStore {
  return {
    profiles: Object.fromEntries(
      Object.entries(profiles || {})
        .map(([key, value]) => [key, normalizeProfile(key, value)] as const)
        .filter((entry): entry is readonly [string, WritingGovernorProfile] =>
          Boolean(entry[1]),
        )
        .map(([key, value]) => [key, cloneProfile(value)]),
    ),
  };
}

export function readWritingGovernorProfile(
  store: WritingGovernorProfileStore,
  profileKey: string,
): WritingGovernorProfile | null {
  const profile = normalizeProfile(profileKey, store.profiles[profileKey]);
  return profile ? cloneProfile(profile) : null;
}

export function resetWritingGovernorProfileStore(
  store?: WritingGovernorProfileStore,
): void {
  const target = store || runtimeProfileStore;
  target.profiles = {};
  if (!store || store === runtimeProfileStore) {
    runtimeProfileStoreHydrated = false;
  }
}

function resolvedProfile(
  store: WritingGovernorProfileStore,
  profileKey: string,
): WritingGovernorProfile | null {
  return normalizeProfile(profileKey, store.profiles[profileKey]);
}

function profileStatus(
  profile: WritingGovernorProfile | null,
): Pick<
  WritingGovernorProfile,
  | 'completeStopCount'
  | 'reasoningExactSampleCount'
  | 'counterfactualSafeCount'
  | 'counterfactualUnsafeCount'
  | 'productionState'
  | 'productionReady'
> {
  if (profile) return deriveProfileState(profile);
  return {
    completeStopCount: 0,
    reasoningExactSampleCount: 0,
    counterfactualSafeCount: 0,
    counterfactualUnsafeCount: 0,
    productionState: 'BOOTSTRAP_SAFE',
    productionReady: false,
  };
}

export interface WritingGovernorProductionStatus {
  hydrated: boolean;
  productionEnabled: boolean;
  state: WritingGovernorProductionState;
  productionReady: boolean;
  profileSampleCount: number;
  completeStopCount: number;
  reasoningExactSampleCount: number;
  counterfactualSafeCount: number;
  counterfactualUnsafeCount: number;
}

export function getWritingGovernorProfileState(
  profile: WritingGovernorProfile | null | undefined,
): WritingGovernorProductionState {
  return profileStatus(profile || null).productionState;
}

/** Readiness is deliberately distinct from hydration and bootstrap enablement. */
export function isWritingGovernorProductionReady(
  store: WritingGovernorProfileStore = runtimeProfileStore,
  profileKey?: string,
): boolean {
  if (profileKey) {
    return profileStatus(resolvedProfile(store, profileKey)).productionReady;
  }
  return getWritingGovernorProductionStatus(store).productionReady;
}

export function getWritingGovernorProductionStatus(
  store: WritingGovernorProfileStore = runtimeProfileStore,
  profileKey?: string,
): WritingGovernorProductionStatus {
  let profile: WritingGovernorProfile | null = null;
  if (profileKey) {
    profile = resolvedProfile(store, profileKey);
  } else {
    profile =
      Object.values(store.profiles)
        .map(value => normalizeProfile(value.profileKey, value))
        .filter((value): value is WritingGovernorProfile => Boolean(value))
        .sort((left, right) => right.updatedAt - left.updatedAt)[0] || null;
  }
  const status = profileStatus(profile);
  return {
    hydrated: runtimeProfileStoreHydrated,
    // Hydration makes the durable aggregate usable, but only the selected
    // profile's evidence may authorize production wire takeover.
    productionEnabled:
      runtimeProfileStoreHydrated && status.productionReady,
    state: status.productionState,
    productionReady: status.productionReady,
    profileSampleCount: profile?.sampleCount ?? 0,
    completeStopCount: status.completeStopCount,
    reasoningExactSampleCount: status.reasoningExactSampleCount,
    counterfactualSafeCount: status.counterfactualSafeCount,
    counterfactualUnsafeCount: status.counterfactualUnsafeCount,
  };
}

/**
 * C3 opts a ready Draft profile into production; C4 additionally permits an
 * exact provider/model QA safe warm start (or a QA-ready profile). Revision
 * remains shadow-only until the separate C5 policy.
 */
export function shouldEnableWritingGovernorProduction(
  stage: string,
  shadow?: Pick<
    WritingGovernorShadow,
    | 'productionEnabled'
    | 'productionReady'
    | 'stage'
    | 'outputContract'
    | 'thinkingEnabled'
    | 'bootstrapPriorMatch'
    | 'productionState'
    | 'counterfactualUnsafeCount'
  >,
): boolean {
  if (!shadow) return false;
  if (shadow.stage !== stage) return false;
  if (stage === 'draft') {
    return shadow.productionEnabled && shadow.productionReady;
  }
  // C4 QA may use only its exact provider/model safe warm-start prior or its
  // own ready profile. Generic/provider-family priors remain legacy-wire
  // shadow mode until QA evidence proves them safe.
  if (stage === 'qa') {
    return (
      shadow.productionEnabled &&
      (shadow.productionReady || isQaSafeWarmStartCandidate(shadow))
    );
  }
  if (stage === 'revision') {
    return (
      shadow.productionEnabled &&
      (shadow.productionReady || isRevisionSafeWarmStartCandidate(shadow))
    );
  }
  return false;
}

export function resolveWritingGovernorShadow(
  input: ResolveWritingGovernorShadowInput,
  store: WritingGovernorProfileStore = runtimeProfileStore,
): WritingGovernorShadow {
  const contextCapability = positive(input.contextWindow);
  const completionCapability = nonNegative(input.completionCapability);
  const providerWireCeiling =
    input.providerWireCeiling == null
      ? null
      : nonNegative(input.providerWireCeiling);
  const actualPromptTokens = estimateMessagesTokens(input.messages);
  const targetChars = positive(input.targetChars);
  const effort = normalizeEffort(input.reasoningEffort);
  const structured =
    input.outputContract === 'json_envelope' &&
    isStructuredReportStage(input.stage);
  const chapterDemand = estimateTargetChapterTokens(targetChars);
  const visibleDemand = structured
    ? Math.max(
        estimateTokens(
          '{"schemaVersion":1,"content":"","verdict":"pass","findings":[]}',
        ),
        Math.ceil(chapterDemand * 0.35),
      )
    : chapterDemand;
  const visibleOutputFloor = Math.max(
    1,
    Math.ceil(visibleDemand * (structured ? 0.5 : 0.72)),
  );
  const profileKey = profileKeyFor(input);
  const profile = resolvedProfile(store, profileKey);
  const status = profileStatus(profile);
  const completeStopCount = status.completeStopCount;
  const learned =
    completeStopCount >= WRITING_GOVERNOR_POLICY.minCompleteStopSamples;
  const contextSafetyReserve = Math.max(
    1,
    Math.ceil(
      contextCapability * WRITING_GOVERNOR_POLICY.contextSafetyReserveRatio,
    ),
  );
  const pressure = clamp(
    (actualPromptTokens + visibleOutputFloor) /
      Math.max(1, actualPromptTokens + visibleDemand),
    0,
    1,
  );
  const protocolTemplate = structured
    ? '{"schemaVersion":1,"content":"","verdict":"needs_revision","findings":[]}'
    : '完整正文，自然结尾。';
  const protocolReserve = Math.max(
    1,
    Math.ceil(
      estimateTokens(protocolTemplate) *
        (input.outputContract === 'json_envelope' ? 1.5 : 1),
    ),
  );
  const currentInputDemandRatio =
    actualPromptTokens / Math.max(1, visibleDemand);
  const seedEnvelope = Math.max(
    1,
    Math.ceil(
      visibleDemand *
        reasoningRatio(effort) *
        clamp(1 + Math.log1p(currentInputDemandRatio) * 0.15, 1, 1.35) *
        (1 + pressure * 0.25),
    ),
  );
  const prior = resolveWritingGovernorBootstrapPrior({
    providerAdapterId: input.providerAdapterId,
    modelName: input.modelName,
    stage: input.stage,
    qualityProfile: input.qualityProfile,
  });
  const effortFactor = effortMultiplier(effort);
  const bootstrapDemandEstimate = Math.ceil(
    visibleDemand * prior.reasoningDemandRatioP95 * effortFactor,
  );
  const bootstrapPromptEstimate = Math.ceil(
    actualPromptTokens * prior.reasoningPromptRatioP95 * effortFactor,
  );
  const bootstrapReasoningEnvelope = Math.max(
    1,
    seedEnvelope,
    bootstrapDemandEstimate,
    bootstrapPromptEstimate,
  );

  const historicalDemandRatio = Math.max(
    profile?.reasoningRatioEwma ?? 0,
    (profile?.reasoningRatioHighWater ?? 0) * 0.9,
  );
  const historicalPromptRatio = Math.max(
    profile?.reasoningPromptRatioEwma ?? 0,
    (profile?.reasoningPromptRatioHighWater ?? 0) * 0.9,
  );
  const historicalDemandEstimate =
    historicalDemandRatio > 0
      ? Math.ceil(visibleDemand * historicalDemandRatio)
      : 0;
  const historicalPromptEstimate =
    historicalPromptRatio > 0
      ? Math.ceil(actualPromptTokens * historicalPromptRatio)
      : 0;
  const historicalEstimate = Math.max(
    historicalDemandEstimate,
    historicalPromptEstimate,
  );
  const localProfileWeight = profile
    ? clamp(
        completeStopCount /
          (completeStopCount + WRITING_GOVERNOR_POLICY.localProfilePseudoCount),
        0,
        WRITING_GOVERNOR_POLICY.localProfileMaxWeight,
      )
    : 0;
  const bootstrapWeight = 1 - localProfileWeight;
  const blendedReasoningEnvelope =
    historicalEstimate > 0
      ? Math.ceil(
          bootstrapReasoningEnvelope * bootstrapWeight +
            historicalEstimate * localProfileWeight,
        )
      : bootstrapReasoningEnvelope;
  const localSafetyFloor = Math.ceil(
    bootstrapReasoningEnvelope * WRITING_GOVERNOR_POLICY.localSafetyFloorRatio,
  );
  let reasoningEnvelope = Math.max(
    1,
    blendedReasoningEnvelope,
    // Local evidence may tighten only within the versioned Bootstrap safety
    // floor. This prevents a short low-utilization run from recreating a cold
    // failure zone.
    localSafetyFloor,
  );
  if (status.productionState === 'TRIPPED') {
    // Fast Recovery: a length signal immediately restores a wider envelope;
    // no retry is initiated here.
    reasoningEnvelope = Math.max(
      reasoningEnvelope,
      Math.ceil(
        Math.max(bootstrapReasoningEnvelope, blendedReasoningEnvelope) *
          WRITING_GOVERNOR_POLICY.trippedRecoveryRatio,
      ),
    );
  }
  const knownFluctuationReserve =
    profile?.reasoningRatioHighWater != null &&
    profile.reasoningRatioEwma != null
      ? Math.ceil(
          visibleDemand *
            clamp(
              Math.max(
                0,
                profile.reasoningRatioHighWater - profile.reasoningRatioEwma,
              ) * 0.1,
              0,
              0.5,
            ),
        )
      : 0;
  const outputSafetyReserve = Math.max(
    WRITING_GOVERNOR_POLICY.minOutputSafetyReserve,
    Math.ceil(
      Math.max(
        visibleDemand * WRITING_GOVERNOR_POLICY.outputSafetyReserveRatio,
        reasoningEnvelope * WRITING_GOVERNOR_POLICY.outputSafetyReserveRatio,
        protocolReserve * 1.5,
      ) + knownFluctuationReserve,
    ),
  );
  const demandFloor = visibleOutputFloor + reasoningEnvelope + protocolReserve;
  const baseSoftBudget =
    visibleDemand + reasoningEnvelope + protocolReserve + outputSafetyReserve;
  const learnedScale = profile
    ? clamp(
        profile.recommendedScale,
        WRITING_GOVERNOR_POLICY.minRecommendedScale,
        WRITING_GOVERNOR_POLICY.maxRecommendedScale,
      )
    : 1;
  const recommendedSoftBudget = Math.max(
    demandFloor,
    Math.ceil(baseSoftBudget * learnedScale),
  );
  const availableCompletion = Math.max(
    0,
    contextCapability - actualPromptTokens - contextSafetyReserve,
  );
  const hardCeiling = Math.max(
    0,
    Math.min(
      completionCapability,
      providerWireCeiling == null ? completionCapability : providerWireCeiling,
      availableCompletion,
    ),
  );
  const recommendedWireMax = Math.max(
    0,
    Math.min(recommendedSoftBudget, hardCeiling),
  );
  const stageSafeWarmStart = isStageSafeWarmStartCandidate({
    stage: input.stage,
    outputContract: input.outputContract,
    thinkingEnabled: input.thinking?.type !== 'disabled',
    bootstrapPriorMatch: prior.match,
    productionState: status.productionState,
    counterfactualUnsafeCount: status.counterfactualUnsafeCount,
  });
  return {
    version: WRITING_GOVERNOR_VERSION,
    mode: 'shadow',
    stage: input.stage,
    profileKey,
    policyVersion: WRITING_GOVERNOR_POLICY_VERSION,
    coldStart: profile == null && status.productionState !== 'TRIPPED',
    learned,
    hydrated: runtimeProfileStoreHydrated,
    productionState: status.productionState,
    productionReady: status.productionReady,
    productionEnabled:
      runtimeProfileStoreHydrated &&
      (status.productionReady || stageSafeWarmStart),
    profileSampleCount: profile?.sampleCount ?? 0,
    completeStopCount,
    reasoningExactSampleCount: status.reasoningExactSampleCount,
    counterfactualSafeCount: status.counterfactualSafeCount,
    counterfactualUnsafeCount: status.counterfactualUnsafeCount,
    providerAdapterId: input.providerAdapterId
      ? String(input.providerAdapterId)
      : null,
    modelName: String(input.modelName ?? ''),
    qualityProfile:
      input.qualityProfile == null ? null : String(input.qualityProfile),
    executionProfile:
      input.executionProfile == null ? null : String(input.executionProfile),
    outputContract: input.outputContract,
    thinkingEnabled: input.thinking?.type !== 'disabled',
    reasoningEffort: input.reasoningEffort ? effort : null,
    reasoningSeedVersion: WRITING_GOVERNOR_REASONING_SEED_VERSION,
    bootstrapPriorVersion: prior.version,
    bootstrapPriorSource: prior.source,
    bootstrapPriorMatch: prior.match,
    bootstrapReasoningDemandRatio: prior.reasoningDemandRatioP95,
    bootstrapReasoningPromptRatio: prior.reasoningPromptRatioP95,
    bootstrapWeight,
    localProfileWeight,
    contextCapability,
    completionCapability,
    providerWireCeiling,
    actualPromptTokens,
    targetChars,
    visibleDemand,
    visibleOutputFloor,
    demandFloor,
    reasoningEnvelope,
    protocolReserve,
    contextSafetyReserve,
    outputSafetyReserve,
    safetyReserve: outputSafetyReserve,
    recommendedSoftBudget,
    hardCeiling,
    recommendedWireMax,
    legacyWireMax: nonNegative(input.legacyWireMax),
    pressure,
    preflightBlocked: hardCeiling < demandFloor,
    recommendationMeetsDemandFloor: recommendedWireMax >= demandFloor,
    actualCompletionUsage: null,
    visibleOutput: null,
    reasoningUsage: null,
    finishReason: null,
    latencyMs: null,
    counterfactualUtilization: null,
    counterfactualSafe: null,
  };
}

function normalizedFailureClass(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function isNonLearnableFailure(failureClass: string): boolean {
  return (
    failureClass === 'outcome_unknown' ||
    failureClass === 'safe_retry' ||
    failureClass === 'rate_limit' ||
    failureClass === 'network_error' ||
    failureClass === 'provider_error' ||
    failureClass === 'fatal' ||
    failureClass === 'cancelled' ||
    failureClass.includes('network') ||
    failureClass.includes('5xx') ||
    failureClass.includes('server_error')
  );
}

function finishReasonOf(observation: WritingGovernorObservation): string {
  return String(observation.finishReason || '').trim().toLowerCase();
}

function isKnownResult(observation: WritingGovernorObservation): boolean {
  if (isNonLearnableFailure(normalizedFailureClass(observation.failureClass))) {
    return false;
  }
  const finishReason = finishReasonOf(observation);
  // A length result is a usable lower bound even when a provider omits usage;
  // it is never an exact reasoning sample.
  if (finishReason === 'length') return true;
  const completion = observation.actualCompletionUsage;
  if (completion == null || !Number.isFinite(completion) || completion < 0) {
    return false;
  }
  return finishReason === 'stop' && observation.businessResultValid === true;
}

function completeStopObservation(
  observation: WritingGovernorObservation,
): boolean {
  return (
    finishReasonOf(observation) === 'stop' &&
    observation.businessResultValid === true &&
    observation.actualCompletionUsage != null &&
    Number.isFinite(observation.actualCompletionUsage) &&
    Number(observation.actualCompletionUsage) >= 0
  );
}

export function observeWritingGovernorResult(
  store: WritingGovernorProfileStore,
  shadow: WritingGovernorShadow,
  observation: WritingGovernorObservation,
): void {
  if (!isKnownResult(observation)) return;
  const existing = resolvedProfile(store, shadow.profileKey);
  const previous: WritingGovernorProfile =
    existing || emptyProfile(shadow.profileKey);
  const finishReason = finishReasonOf(observation);
  const isLength = finishReason === 'length';
  const isCompleteStop = completeStopObservation(observation);
  const completion =
    observation.actualCompletionUsage == null
      ? null
      : Math.max(0, Number(observation.actualCompletionUsage));
  const ratio =
    completion == null
      ? null
      : clamp(
          completion / Math.max(1, shadow.recommendedSoftBudget),
          0,
          4,
        );
  const recommendation = Math.max(
    1,
    shadow.recommendedWireMax || shadow.recommendedSoftBudget,
  );
  const counterfactualUtilization =
    isCompleteStop && completion != null ? completion / recommendation : null;
  const counterfactualSafe =
    counterfactualUtilization != null &&
    counterfactualUtilization <
      WRITING_GOVERNOR_POLICY.counterfactualMaxUtilization;
  const previousDebt = parseCounterfactualDebt(
    previous.lastFinishReason,
  ).debt;
  const counterfactualDebt = isCompleteStop
    ? counterfactualSafe
      ? Math.max(0, previousDebt - 1)
      : previousDebt + 1
    : previousDebt;
  const sampleCount = previous.sampleCount + 1;
  const knownResultCount = previous.knownResultCount + 1;
  const lengthSignalCount = previous.lengthSignalCount + (isLength ? 1 : 0);
  const completeStopCount = knownResultCount - lengthSignalCount;
  const lowUtilization =
    isCompleteStop &&
    ratio != null &&
    ratio < WRITING_GOVERNOR_POLICY.lowUtilizationRatio;
  // Reuse the existing scalar as a consecutive healthy streak. It is reset by
  // a high-pressure result or a censored length signal, so one lucky sample
  // cannot authorize tightening.
  const lowUtilizationCount = lowUtilization
    ? previous.lowUtilizationCount + 1
    : 0;
  const highUtilization =
    isCompleteStop &&
    ratio != null &&
    ratio > WRITING_GOVERNOR_POLICY.highUtilizationRatio;
  let recommendedScale = previous.recommendedScale;
  if (isLength) {
    // Fast rise is immediate and independent of the old minimum-sample gate.
    recommendedScale = clamp(
      Math.max(
        WRITING_GOVERNOR_POLICY.recoveryScaleFloor,
        previous.recommendedScale * WRITING_GOVERNOR_POLICY.recoveryScaleRise,
      ),
      WRITING_GOVERNOR_POLICY.minRecommendedScale,
      WRITING_GOVERNOR_POLICY.maxRecommendedScale,
    );
  } else if (isCompleteStop && !counterfactualSafe) {
    recommendedScale = clamp(
      Math.max(
        WRITING_GOVERNOR_POLICY.recoveryScaleFloor,
        previous.recommendedScale * WRITING_GOVERNOR_POLICY.unsafeScaleRise,
      ),
      WRITING_GOVERNOR_POLICY.minRecommendedScale,
      WRITING_GOVERNOR_POLICY.maxRecommendedScale,
    );
  } else if (
    isCompleteStop &&
    lowUtilizationCount >= WRITING_GOVERNOR_POLICY.minHealthySuccessStreak &&
    completeStopCount >= WRITING_GOVERNOR_POLICY.minCompleteStopSamples &&
    counterfactualDebt === 0
  ) {
    recommendedScale = clamp(
      previous.recommendedScale * WRITING_GOVERNOR_POLICY.slowTighteningDecay,
      WRITING_GOVERNOR_POLICY.minRecommendedScale,
      WRITING_GOVERNOR_POLICY.maxRecommendedScale,
    );
  } else if (highUtilization) {
    recommendedScale = clamp(
      Math.max(
        previous.recommendedScale,
        previous.recommendedScale * WRITING_GOVERNOR_POLICY.highUtilizationRise,
      ),
      WRITING_GOVERNOR_POLICY.minRecommendedScale,
      WRITING_GOVERNOR_POLICY.maxRecommendedScale,
    );
  }

  const previousCompleteCount = previous.completeStopCount;
  const averageCompletionRatio =
    !isCompleteStop || ratio == null
      ? previous.averageCompletionRatio
      : previous.averageCompletionRatio == null
      ? ratio
      : (previous.averageCompletionRatio * previousCompleteCount + ratio) /
        Math.max(1, completeStopCount);
  const latency =
    observation.latencyMs == null || !Number.isFinite(observation.latencyMs)
      ? null
      : Math.max(0, Number(observation.latencyMs));
  const averageLatencyMs =
    latency == null
      ? previous.averageLatencyMs
      : previous.averageLatencyMs == null
      ? latency
      : (previous.averageLatencyMs * previous.sampleCount + latency) /
        sampleCount;

  const rawReasoning = boundedRatio(
    observation.reasoningUsage,
    completion == null
      ? WRITING_GOVERNOR_POLICY.maxReasoningDemandRatio
      : completion,
  );
  // Only a complete stop can teach exact reasoning behavior. A length sample
  // is explicitly censored: reasoning≈wire is not the model's true demand.
  const hasReasoningSample = isCompleteStop && rawReasoning != null;
  const reasoningRatioSample = hasReasoningSample
    ? clamp(
        rawReasoning! / Math.max(1, shadow.visibleDemand),
        0,
        WRITING_GOVERNOR_POLICY.maxReasoningDemandRatio,
      )
    : null;
  const reasoningPromptRatioSample = hasReasoningSample
    ? clamp(
        rawReasoning! / Math.max(1, shadow.actualPromptTokens),
        0,
        WRITING_GOVERNOR_POLICY.maxReasoningPromptRatio,
      )
    : null;
  const reasoningSampleCount =
    previous.reasoningSampleCount + (hasReasoningSample ? 1 : 0);
  const reasoningRatioEwma =
    reasoningRatioSample == null
      ? previous.reasoningRatioEwma
      : previous.reasoningRatioEwma == null
      ? reasoningRatioSample
      : previous.reasoningRatioEwma *
          (1 - WRITING_GOVERNOR_POLICY.reasoningEwmaAlpha) +
        reasoningRatioSample * WRITING_GOVERNOR_POLICY.reasoningEwmaAlpha;
  const reasoningRatioHighWater =
    reasoningRatioSample == null
      ? previous.reasoningRatioHighWater
      : Math.max(
          (previous.reasoningRatioHighWater ?? 0) *
            WRITING_GOVERNOR_POLICY.reasoningHighWaterDecay,
          reasoningRatioSample,
        );
  const reasoningPromptRatioEwma =
    reasoningPromptRatioSample == null
      ? previous.reasoningPromptRatioEwma
      : previous.reasoningPromptRatioEwma == null
      ? reasoningPromptRatioSample
      : previous.reasoningPromptRatioEwma *
          (1 - WRITING_GOVERNOR_POLICY.reasoningEwmaAlpha) +
        reasoningPromptRatioSample * WRITING_GOVERNOR_POLICY.reasoningEwmaAlpha;
  const reasoningPromptRatioHighWater =
    reasoningPromptRatioSample == null
      ? previous.reasoningPromptRatioHighWater
      : Math.max(
          (previous.reasoningPromptRatioHighWater ?? 0) *
            WRITING_GOVERNOR_POLICY.reasoningHighWaterDecay,
          reasoningPromptRatioSample,
        );
  const rawLastFinishReason = encodeCounterfactualDebt(
    finishReason,
    counterfactualDebt,
  );
  const nextCore = {
    version: 2 as const,
    profileKey: shadow.profileKey,
    sampleCount,
    knownResultCount,
    lowUtilizationCount,
    lengthSignalCount,
    recommendedScale,
    averageCompletionRatio,
    averageLatencyMs,
    reasoningSampleCount,
    reasoningRatioEwma:
      reasoningRatioEwma == null
        ? null
        : clamp(
            reasoningRatioEwma,
            0,
            WRITING_GOVERNOR_POLICY.maxReasoningDemandRatio,
          ),
    reasoningRatioHighWater:
      reasoningRatioHighWater == null
        ? null
        : clamp(
            reasoningRatioHighWater,
            0,
            WRITING_GOVERNOR_POLICY.maxReasoningDemandRatio,
          ),
    reasoningPromptRatioEwma:
      reasoningPromptRatioEwma == null
        ? null
        : clamp(
            reasoningPromptRatioEwma,
            0,
            WRITING_GOVERNOR_POLICY.maxReasoningPromptRatio,
          ),
    reasoningPromptRatioHighWater:
      reasoningPromptRatioHighWater == null
        ? null
        : clamp(
            reasoningPromptRatioHighWater,
            0,
            WRITING_GOVERNOR_POLICY.maxReasoningPromptRatio,
          ),
    lastFinishReason: rawLastFinishReason,
    updatedAt: Date.now(),
  };
  store.profiles[shadow.profileKey] = {
    ...nextCore,
    ...deriveProfileState(nextCore),
  };
  if (store === runtimeProfileStore) {
    notifyWritingGovernorProfilePersistence(store.profiles[shadow.profileKey]);
  }
}

export function completeWritingGovernorShadow(
  shadow: WritingGovernorShadow,
  observation: WritingGovernorObservation,
  store: WritingGovernorProfileStore = runtimeProfileStore,
): WritingGovernorShadow {
  const recommendation = Math.max(
    1,
    shadow.recommendedWireMax || shadow.recommendedSoftBudget,
  );
  const isCompleteStop = completeStopObservation(observation);
  const usage =
    observation.actualCompletionUsage == null
      ? null
      : nonNegative(observation.actualCompletionUsage);
  const counterfactualUtilization =
    isCompleteStop && usage != null ? usage / recommendation : null;
  const counterfactualSafe =
    counterfactualUtilization != null
      ? counterfactualUtilization <
        WRITING_GOVERNOR_POLICY.counterfactualMaxUtilization
      : null;
  observeWritingGovernorResult(store, shadow, observation);
  const learnedProfile = resolvedProfile(store, shadow.profileKey);
  const status = profileStatus(learnedProfile);
  const stageSafeWarmStart = isStageSafeWarmStartCandidate({
    stage: shadow.stage,
    outputContract: shadow.outputContract,
    thinkingEnabled: shadow.thinkingEnabled,
    bootstrapPriorMatch: shadow.bootstrapPriorMatch,
    productionState: status.productionState,
    counterfactualUnsafeCount: status.counterfactualUnsafeCount,
  });
  return {
    ...shadow,
    coldStart:
      learnedProfile == null && status.productionState !== 'TRIPPED',
    learned:
      status.completeStopCount >=
      WRITING_GOVERNOR_POLICY.minCompleteStopSamples,
    profileSampleCount: learnedProfile?.sampleCount ?? 0,
    completeStopCount: status.completeStopCount,
    reasoningExactSampleCount: status.reasoningExactSampleCount,
    counterfactualSafeCount: status.counterfactualSafeCount,
    counterfactualUnsafeCount: status.counterfactualUnsafeCount,
    productionState: status.productionState,
    productionReady: status.productionReady,
    productionEnabled:
      runtimeProfileStoreHydrated &&
      (status.productionReady || stageSafeWarmStart),
    actualCompletionUsage: usage,
    visibleOutput:
      observation.visibleOutput == null
        ? null
        : nonNegative(observation.visibleOutput),
    reasoningUsage:
      observation.reasoningUsage == null
        ? null
        : nonNegative(observation.reasoningUsage),
    finishReason: observation.finishReason
      ? String(observation.finishReason)
      : null,
    latencyMs:
      observation.latencyMs == null || !Number.isFinite(observation.latencyMs)
        ? null
        : Math.max(0, Number(observation.latencyMs)),
    counterfactualUtilization,
    counterfactualSafe,
  };
}

/**
 * Resolve the production wire value for an explicitly opted-in stage. Every
 * state has already selected a safe envelope; this function only enforces the
 * hard capability and Demand Floor boundaries.
 */
export function decideWritingGovernorWire(
  shadow: WritingGovernorShadow,
  enabled: boolean,
): WritingGovernorWireDecision {
  const stageSafeWarmStart = isStageSafeWarmStartCandidate(shadow);
  if (
    !enabled ||
    !shadow.productionEnabled ||
    (!shadow.productionReady && !stageSafeWarmStart)
  ) {
    return { enabled: false, blocked: false, wireMax: null, reason: null };
  }
  if (shadow.preflightBlocked || shadow.hardCeiling < shadow.demandFloor) {
    return {
      enabled: true,
      blocked: true,
      wireMax: null,
      reason: 'demand_exceeds_hard_ceiling',
    };
  }
  if (shadow.recommendedWireMax < shadow.demandFloor) {
    return {
      enabled: true,
      blocked: true,
      wireMax: null,
      reason: 'recommendation_below_demand_floor',
    };
  }
  return {
    enabled: true,
    blocked: false,
    wireMax: Math.min(shadow.recommendedSoftBudget, shadow.hardCeiling),
    reason: null,
  };
}

/** Safe persistence projection: aggregates only, never messages or content. */
export function serializeWritingGovernorProfiles(
  store: WritingGovernorProfileStore,
): string {
  const profiles = Object.fromEntries(
    Object.entries(store.profiles)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, cloneProfile(value)]),
  );
  return JSON.stringify({ version: 2, profiles });
}

export function parseWritingGovernorProfiles(
  serialized: string | null | undefined,
): WritingGovernorProfileStore {
  if (!serialized) return createWritingGovernorProfileStore();
  try {
    const parsed = JSON.parse(serialized) as {
      version?: unknown;
      profiles?: Record<string, WritingGovernorProfile>;
    };
    if (
      parsed.version !== 2 ||
      !parsed.profiles ||
      typeof parsed.profiles !== 'object'
    ) {
      return createWritingGovernorProfileStore();
    }
    const safe: Record<string, WritingGovernorProfile> = {};
    for (const [key, value] of Object.entries(parsed.profiles)) {
      const normalized = normalizeProfile(key, value);
      if (normalized) safe[key] = normalized;
    }
    return createWritingGovernorProfileStore(safe);
  } catch {
    return createWritingGovernorProfileStore();
  }
}

const runtimeProfileStore = createWritingGovernorProfileStore();
let runtimeProfileStoreHydrated = false;
let runtimeProfilePersistenceSink: WritingGovernorProfilePersistenceSink | null =
  null;

function notifyWritingGovernorProfilePersistence(
  profile: WritingGovernorProfile,
): void {
  if (!runtimeProfilePersistenceSink) return;
  try {
    const pending = runtimeProfilePersistenceSink(cloneProfile(profile));
    if (pending && typeof (pending as Promise<void>).then === 'function') {
      void Promise.resolve(pending).catch(error => {
        console.warn('[writing-governor] durable aggregate write failed', error);
      });
    }
  } catch (error) {
    console.warn('[writing-governor] durable aggregate write failed', error);
  }
}

export function setWritingGovernorProfilePersistenceSink(
  sink: WritingGovernorProfilePersistenceSink | null,
): void {
  runtimeProfilePersistenceSink = sink;
}

export function markWritingGovernorProfileStoreHydrated(
  hydrated: boolean,
): void {
  runtimeProfileStoreHydrated = hydrated;
}

export function isWritingGovernorProfileStoreHydrated(): boolean {
  return runtimeProfileStoreHydrated;
}

export function getWritingGovernorProfileStore(): WritingGovernorProfileStore {
  return runtimeProfileStore;
}

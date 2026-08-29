/**
 * Phase III-C v2 adaptive Governor.
 *
 * C2 is deliberately shadow-only: this module measures the final compiled
 * messages and calculates a recommendation, but it never selects or sends a
 * request. The current legacy wire value remains authoritative until a later
 * phase explicitly enables one stage at a time.
 */
import { sha256Hex } from '../../continuation/hashUtils';
import { estimateMessagesTokens, estimateTokens } from '../../../utils/tokenEstimator';
import { estimateTargetChapterTokens } from '../scenario/continuationStageCapacity';
import type { ChatMessage } from '../../llm/types';

export const WRITING_GOVERNOR_VERSION = 'writing-governor-shadow-v2' as const;
export const WRITING_GOVERNOR_PROMPT_COMPILER_VERSION =
  'shared-prompt-compiler-v1' as const;
export const WRITING_GOVERNOR_REASONING_POLICY_VERSION =
  'kernel-reasoning-policy-v2' as const;
export const WRITING_GOVERNOR_REASONING_SEED_VERSION =
  'cold-start-reasoning-seed-v2' as const;

const MIN_PROFILE_SAMPLES = 3;
const MIN_RECOMMENDED_SCALE = 0.75;
const MAX_RECOMMENDED_SCALE = 1.25;
const LOW_UTILIZATION_RATIO = 0.45;
const HIGH_UTILIZATION_RATIO = 0.9;
const CONTEXT_SAFETY_RESERVE_RATIO = 0.02;
const MIN_OUTPUT_SAFETY_RESERVE = 32;
const OUTPUT_SAFETY_RESERVE_RATIO = 0.08;
const REASONING_EWMA_ALPHA = 0.2;
const REASONING_HIGH_WATER_DECAY = 0.98;
const MAX_REASONING_DEMAND_RATIO = 8;
const MAX_REASONING_PROMPT_RATIO = 1.5;
const REASONING_HISTORY_MIN_WEIGHT = 0.7;
const REASONING_HISTORY_MAX_WEIGHT = 0.9;

type GovernorReasoningEffort = 'low' | 'medium' | 'high' | 'max';

export interface WritingGovernorProfile {
  version: 1;
  profileKey: string;
  sampleCount: number;
  knownResultCount: number;
  lowUtilizationCount: number;
  lengthSignalCount: number;
  recommendedScale: number;
  averageCompletionRatio: number | null;
  averageLatencyMs: number | null;
  /** Bounded real reasoning/visible-demand feedback. */
  reasoningSampleCount: number;
  reasoningRatioEwma: number | null;
  reasoningRatioHighWater: number | null;
  /** Bounded real reasoning/input feedback for long-context adaptation. */
  reasoningPromptRatioEwma: number | null;
  reasoningPromptRatioHighWater: number | null;
  lastFinishReason: string | null;
  updatedAt: number;
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
  /** The value the mature Writer would send before C3+ enables the Governor. */
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
  coldStart: boolean;
  learned: boolean;
  profileSampleCount: number;
  providerAdapterId: string | null;
  modelName: string;
  qualityProfile: string | null;
  executionProfile: string | null;
  outputContract: 'prose' | 'json_envelope';
  thinkingEnabled: boolean;
  reasoningEffort: GovernorReasoningEffort | null;
  reasoningSeedVersion: typeof WRITING_GOVERNOR_REASONING_SEED_VERSION;
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
  /** @deprecated Kept as a read-only compatibility alias for old receipts. */
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
}

export interface WritingGovernorWireDecision {
  enabled: boolean;
  blocked: boolean;
  wireMax: number | null;
  reason: 'demand_exceeds_hard_ceiling' | 'recommendation_below_demand_floor' | null;
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
  // Versioned cold-start seeds only. Once real reasoning usage exists, the
  // bounded profile feedback below becomes the primary signal.
  return {
    low: 0.2,
    medium: 0.28,
    high: 0.38,
    max: 0.5,
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
    }),
  );
}

function boundedRatio(
  value: unknown,
  maximum: number,
): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? clamp(parsed, 0, maximum)
    : null;
}

function emptyProfile(profileKey: string): WritingGovernorProfile {
  return {
    version: 1,
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
  };
}

function normalizeProfile(
  profileKey: string,
  value: Partial<WritingGovernorProfile> | null | undefined,
): WritingGovernorProfile | null {
  if (!value || value.version !== 1) return null;
  const base = emptyProfile(profileKey);
  return {
    ...base,
    ...value,
    profileKey,
    sampleCount: nonNegative(value.sampleCount),
    knownResultCount: nonNegative(value.knownResultCount),
    lowUtilizationCount: nonNegative(value.lowUtilizationCount),
    lengthSignalCount: nonNegative(value.lengthSignalCount),
    recommendedScale: clamp(
      Number.isFinite(Number(value.recommendedScale))
        ? Number(value.recommendedScale)
        : 1,
      MIN_RECOMMENDED_SCALE,
      MAX_RECOMMENDED_SCALE,
    ),
    averageCompletionRatio: boundedRatio(value.averageCompletionRatio, 4),
    averageLatencyMs:
      value.averageLatencyMs == null
        ? null
        : Math.max(0, Number(value.averageLatencyMs) || 0),
    reasoningSampleCount: nonNegative(value.reasoningSampleCount),
    reasoningRatioEwma: boundedRatio(
      value.reasoningRatioEwma,
      MAX_REASONING_DEMAND_RATIO,
    ),
    reasoningRatioHighWater: boundedRatio(
      value.reasoningRatioHighWater,
      MAX_REASONING_DEMAND_RATIO,
    ),
    reasoningPromptRatioEwma: boundedRatio(
      value.reasoningPromptRatioEwma,
      MAX_REASONING_PROMPT_RATIO,
    ),
    reasoningPromptRatioHighWater: boundedRatio(
      value.reasoningPromptRatioHighWater,
      MAX_REASONING_PROMPT_RATIO,
    ),
    lastFinishReason:
      value.lastFinishReason == null ? null : String(value.lastFinishReason),
    updatedAt: nonNegative(value.updatedAt),
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
  // Structured reports scale with the measured task demand, but retain their
  // own compact envelope. This is a demand signal, not a transport ceiling.
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
  const learned = Boolean(profile && profile.sampleCount >= MIN_PROFILE_SAMPLES);
  const contextSafetyReserve = Math.max(
    1,
    Math.ceil(contextCapability * CONTEXT_SAFETY_RESERVE_RATIO),
  );
  // Demand pressure is input-vs-target shape, not context-window capacity.
  // The context-only reserve must enter only availableCompletion. In
  // particular, a 1M context window must not manufacture a 20K output budget.
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
  const coldStartEstimate = Math.max(
    1,
    Math.ceil(
      visibleDemand *
        reasoningRatio(effort) *
        // Input/target shape is a bounded cold-start adjustment only. It is
        // deliberately sublinear so long prompts do not dominate demand.
        clamp(1 + Math.log1p(currentInputDemandRatio) * 0.15, 1, 1.35) *
        (1 + pressure * 0.25),
    ),
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
  const historyWeight = profile?.reasoningSampleCount
    ? clamp(
        REASONING_HISTORY_MIN_WEIGHT +
          Math.min(profile.reasoningSampleCount, 4) * 0.04,
        REASONING_HISTORY_MIN_WEIGHT,
        REASONING_HISTORY_MAX_WEIGHT,
      )
    : 0;
  // For a cold profile this is the seed. After a known sample, real behavior
  // wins while the current target and actual prompt are re-applied on every
  // request through the two normalized historical estimates above.
  const reasoningEnvelope = Math.max(
    1,
    Math.ceil(
      historicalEstimate > 0
        ? Math.max(
            coldStartEstimate,
            coldStartEstimate * (1 - historyWeight) +
              historicalEstimate * historyWeight,
          )
        : coldStartEstimate,
    ),
  );
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
    MIN_OUTPUT_SAFETY_RESERVE,
    Math.ceil(
      Math.max(
        visibleDemand * OUTPUT_SAFETY_RESERVE_RATIO,
        reasoningEnvelope * OUTPUT_SAFETY_RESERVE_RATIO,
        protocolReserve * 1.5,
      ) + knownFluctuationReserve,
    ),
  );
  const demandFloor =
    visibleOutputFloor + reasoningEnvelope + protocolReserve;
  const baseSoftBudget =
    visibleDemand + reasoningEnvelope + protocolReserve + outputSafetyReserve;
  const learnedScale = learned
    ? clamp(profile!.recommendedScale, MIN_RECOMMENDED_SCALE, MAX_RECOMMENDED_SCALE)
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
  return {
    version: WRITING_GOVERNOR_VERSION,
    mode: 'shadow',
    stage: input.stage,
    profileKey,
    coldStart: !learned,
    learned,
    profileSampleCount: profile?.sampleCount ?? 0,
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
    // Preserve the old receipt field as an output-only alias. New logic must
    // use the explicitly named fields above; this alias is never context-wide.
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
  };
}

function isKnownResult(
  observation: WritingGovernorObservation,
): boolean {
  const completion = observation.actualCompletionUsage;
  if (completion == null || !Number.isFinite(completion) || completion < 0) {
    return false;
  }
  const failureClass = String(observation.failureClass || '');
  const normalizedFailure = failureClass.toLowerCase();
  if (
    normalizedFailure === 'outcome_unknown' ||
    normalizedFailure === 'safe_retry' ||
    normalizedFailure === 'rate_limit' ||
    normalizedFailure === 'network_error' ||
    normalizedFailure === 'provider_error' ||
    normalizedFailure === 'fatal' ||
    normalizedFailure === 'cancelled' ||
    normalizedFailure.includes('network') ||
    normalizedFailure.includes('5xx') ||
    normalizedFailure.includes('server_error')
  ) {
    return false;
  }
  const finishReason = String(observation.finishReason || '').toLowerCase();
  if (finishReason === 'length') return true;
  return finishReason === 'stop' && observation.businessResultValid === true;
}

export function observeWritingGovernorResult(
  store: WritingGovernorProfileStore,
  shadow: WritingGovernorShadow,
  observation: WritingGovernorObservation,
): void {
  if (!isKnownResult(observation)) return;
  const existing = resolvedProfile(store, shadow.profileKey);
  const previous: WritingGovernorProfile = existing || emptyProfile(shadow.profileKey);
  const completion = Math.max(0, Number(observation.actualCompletionUsage));
  const ratio = clamp(
    completion / Math.max(1, shadow.recommendedSoftBudget),
    0,
    4,
  );
  const isLength = String(observation.finishReason || '').toLowerCase() === 'length';
  const isLow = !isLength && ratio < LOW_UTILIZATION_RATIO;
  const isHigh = !isLength && ratio > HIGH_UTILIZATION_RATIO;
  const sampleCount = previous.sampleCount + 1;
  let recommendedScale = previous.recommendedScale;
  if (sampleCount >= MIN_PROFILE_SAMPLES) {
    if (isLength) {
      // A known length stop is evidence that the next new request needs more
      // room; this is intentionally bounded and does not retry this request.
      recommendedScale = Math.min(MAX_RECOMMENDED_SCALE, recommendedScale * 1.1);
    } else if (isLow) {
      // Slow decay: one healthy low-utilization result cannot collapse a
      // profile, and each update remains bounded by the versioned policy.
      recommendedScale = Math.max(MIN_RECOMMENDED_SCALE, recommendedScale * 0.95);
    } else if (isHigh) {
      recommendedScale = Math.min(MAX_RECOMMENDED_SCALE, recommendedScale * 1.03);
    }
  }
  const averageCompletionRatio =
    previous.averageCompletionRatio == null
      ? ratio
      : (previous.averageCompletionRatio * previous.sampleCount + ratio) /
        sampleCount;
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

  const reasoning = boundedRatio(
    observation.reasoningUsage,
    completion > 0 ? completion : MAX_REASONING_DEMAND_RATIO,
  );
  const hasReasoningSample = reasoning != null;
  const reasoningRatioSample = hasReasoningSample
    ? clamp(
        reasoning / Math.max(1, shadow.visibleDemand),
        0,
        MAX_REASONING_DEMAND_RATIO,
      )
    : null;
  const reasoningPromptRatioSample = hasReasoningSample
    ? clamp(
        reasoning / Math.max(1, shadow.actualPromptTokens),
        0,
        MAX_REASONING_PROMPT_RATIO,
      )
    : null;
  const reasoningSampleCount =
    previous.reasoningSampleCount + (hasReasoningSample ? 1 : 0);
  const reasoningRatioEwma =
    reasoningRatioSample == null
      ? previous.reasoningRatioEwma
      : previous.reasoningRatioEwma == null
      ? reasoningRatioSample
      : previous.reasoningRatioEwma * (1 - REASONING_EWMA_ALPHA) +
        reasoningRatioSample * REASONING_EWMA_ALPHA;
  const reasoningRatioHighWater =
    reasoningRatioSample == null
      ? previous.reasoningRatioHighWater
      : Math.max(
          (previous.reasoningRatioHighWater ?? 0) * REASONING_HIGH_WATER_DECAY,
          reasoningRatioSample,
        );
  const reasoningPromptRatioEwma =
    reasoningPromptRatioSample == null
      ? previous.reasoningPromptRatioEwma
      : previous.reasoningPromptRatioEwma == null
      ? reasoningPromptRatioSample
      : previous.reasoningPromptRatioEwma * (1 - REASONING_EWMA_ALPHA) +
        reasoningPromptRatioSample * REASONING_EWMA_ALPHA;
  const reasoningPromptRatioHighWater =
    reasoningPromptRatioSample == null
      ? previous.reasoningPromptRatioHighWater
      : Math.max(
          (previous.reasoningPromptRatioHighWater ?? 0) *
            REASONING_HIGH_WATER_DECAY,
          reasoningPromptRatioSample,
        );
  store.profiles[shadow.profileKey] = {
    version: 1,
    profileKey: shadow.profileKey,
    sampleCount,
    knownResultCount: previous.knownResultCount + 1,
    lowUtilizationCount: previous.lowUtilizationCount + (isLow ? 1 : 0),
    lengthSignalCount: previous.lengthSignalCount + (isLength ? 1 : 0),
    recommendedScale,
    averageCompletionRatio,
    averageLatencyMs,
    reasoningSampleCount,
    reasoningRatioEwma:
      reasoningRatioEwma == null
        ? null
        : clamp(reasoningRatioEwma, 0, MAX_REASONING_DEMAND_RATIO),
    reasoningRatioHighWater:
      reasoningRatioHighWater == null
        ? null
        : clamp(reasoningRatioHighWater, 0, MAX_REASONING_DEMAND_RATIO),
    reasoningPromptRatioEwma:
      reasoningPromptRatioEwma == null
        ? null
        : clamp(reasoningPromptRatioEwma, 0, MAX_REASONING_PROMPT_RATIO),
    reasoningPromptRatioHighWater:
      reasoningPromptRatioHighWater == null
        ? null
        : clamp(reasoningPromptRatioHighWater, 0, MAX_REASONING_PROMPT_RATIO),
    lastFinishReason: observation.finishReason
      ? String(observation.finishReason)
      : null,
    updatedAt: Date.now(),
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
  observeWritingGovernorResult(store, shadow, observation);
  const learnedProfile = resolvedProfile(store, shadow.profileKey);
  const learned = Boolean(
    learnedProfile && learnedProfile.sampleCount >= MIN_PROFILE_SAMPLES,
  );
  return {
    ...shadow,
    coldStart: !learned,
    learned,
    profileSampleCount: learnedProfile?.sampleCount ?? 0,
    actualCompletionUsage:
      observation.actualCompletionUsage == null
        ? null
        : nonNegative(observation.actualCompletionUsage),
    visibleOutput:
      observation.visibleOutput == null ? null : nonNegative(observation.visibleOutput),
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
  };
}

/**
 * Resolve the production wire value for a stage that has explicitly opted in.
 * The shadow has already separated demand from capability, so this function
 * never raises a hard ceiling or silently lowers the Demand Floor.
 */
export function decideWritingGovernorWire(
  shadow: WritingGovernorShadow,
  enabled: boolean,
): WritingGovernorWireDecision {
  if (!enabled) {
    return {
      enabled: false,
      blocked: false,
      wireMax: null,
      reason: null,
    };
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
  return JSON.stringify({ version: 1, profiles });
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
    if (parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== 'object') {
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

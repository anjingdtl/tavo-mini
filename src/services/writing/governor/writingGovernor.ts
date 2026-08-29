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

export const WRITING_GOVERNOR_VERSION = 'writing-governor-shadow-v1' as const;
export const WRITING_GOVERNOR_PROMPT_COMPILER_VERSION =
  'shared-prompt-compiler-v1' as const;
export const WRITING_GOVERNOR_REASONING_POLICY_VERSION =
  'kernel-reasoning-policy-v1' as const;

const MIN_PROFILE_SAMPLES = 3;
const MIN_RECOMMENDED_SCALE = 0.75;
const MAX_RECOMMENDED_SCALE = 1.25;
const LOW_UTILIZATION_RATIO = 0.45;
const HIGH_UTILIZATION_RATIO = 0.9;
const SAFETY_RESERVE_RATIO = 0.02;

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
  lastFinishReason: string | null;
  updatedAt: number;
}

export interface WritingGovernorProfileStore {
  profiles: Record<string, WritingGovernorProfile>;
}

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
  // These are versioned policy ratios, never absolute token ceilings. The
  // envelope still scales with the measured visible demand and pressure.
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
    }),
  );
}

function cloneProfile(profile: WritingGovernorProfile): WritingGovernorProfile {
  return { ...profile };
}

export function createWritingGovernorProfileStore(
  profiles?: Record<string, WritingGovernorProfile>,
): WritingGovernorProfileStore {
  return {
    profiles: Object.fromEntries(
      Object.entries(profiles || {}).map(([key, value]) => [
        key,
        cloneProfile(value),
      ]),
    ),
  };
}

export function readWritingGovernorProfile(
  store: WritingGovernorProfileStore,
  profileKey: string,
): WritingGovernorProfile | null {
  const profile = store.profiles[profileKey];
  return profile ? cloneProfile(profile) : null;
}

export function resetWritingGovernorProfileStore(
  store?: WritingGovernorProfileStore,
): void {
  const target = store || runtimeProfileStore;
  target.profiles = {};
}

function resolvedProfile(
  store: WritingGovernorProfileStore,
  profileKey: string,
): WritingGovernorProfile | null {
  const profile = store.profiles[profileKey];
  if (!profile || profile.version !== 1) return null;
  return profile;
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
  const safetyReserve = Math.max(
    1,
    Math.ceil(contextCapability * SAFETY_RESERVE_RATIO),
  );
  const pressure = clamp(
    (actualPromptTokens + visibleOutputFloor + safetyReserve) /
      Math.max(1, contextCapability),
    0,
    1,
  );
  const reasoningEnvelope = Math.max(
    1,
    Math.ceil(
      visibleDemand * reasoningRatio(effort) * (1 + pressure * 0.25),
    ),
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
  const demandFloor =
    visibleOutputFloor + reasoningEnvelope + protocolReserve;
  const baseSoftBudget =
    visibleDemand + reasoningEnvelope + protocolReserve + safetyReserve;
  const profileKey = profileKeyFor(input);
  const profile = resolvedProfile(store, profileKey);
  const learned = Boolean(profile && profile.sampleCount >= MIN_PROFILE_SAMPLES);
  const learnedScale = learned
    ? clamp(profile!.recommendedScale, MIN_RECOMMENDED_SCALE, MAX_RECOMMENDED_SCALE)
    : 1;
  const recommendedSoftBudget = Math.max(
    demandFloor,
    Math.ceil(baseSoftBudget * learnedScale),
  );
  const availableCompletion = Math.max(
    0,
    contextCapability - actualPromptTokens - safetyReserve,
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
    safetyReserve,
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
  if (
    failureClass === 'outcome_unknown' ||
    failureClass === 'safe_retry' ||
    failureClass === 'rate_limit' ||
    failureClass === 'network_error' ||
    failureClass === 'provider_error' ||
    failureClass === 'fatal' ||
    failureClass === 'cancelled'
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
  const previous: WritingGovernorProfile = existing || {
    version: 1,
    profileKey: shadow.profileKey,
    sampleCount: 0,
    knownResultCount: 0,
    lowUtilizationCount: 0,
    lengthSignalCount: 0,
    recommendedScale: 1,
    averageCompletionRatio: null,
    averageLatencyMs: null,
    lastFinishReason: null,
    updatedAt: 0,
  };
  const completion = Math.max(0, Number(observation.actualCompletionUsage));
  const ratio = completion / Math.max(1, shadow.recommendedSoftBudget);
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
    lastFinishReason: observation.finishReason
      ? String(observation.finishReason)
      : null,
    updatedAt: Date.now(),
  };
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
      if (
        value &&
        value.version === 1 &&
        value.profileKey === key &&
        Number.isFinite(value.sampleCount) &&
        Number.isFinite(value.knownResultCount)
      ) {
        safe[key] = cloneProfile(value);
      }
    }
    return createWritingGovernorProfileStore(safe);
  } catch {
    return createWritingGovernorProfileStore();
  }
}

const runtimeProfileStore = createWritingGovernorProfileStore();

export function getWritingGovernorProfileStore(): WritingGovernorProfileStore {
  return runtimeProfileStore;
}

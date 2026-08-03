import { sha256Hex } from './continuation/hashUtils';

/** The four physical LLM stages owned by Continuation workflow V4. */
export type ContinuationV4Stage = 'writer' | 'checker' | 'control' | 'repair';

export type ContinuationContextCategory =
  | 'canon'
  | 'primaryAnchor'
  | 'storyMemory'
  | 'recentBridge'
  | 'originalStyle'
  | 'episodic'
  | 'supplements';

export interface RatioCurve {
  min: number;
  max: number;
}

export interface StageRatioRule {
  /** Maximum share of the model's declared context window available to output. */
  maxOutputRatio: number;
}

export interface ContextAutomationPolicyV2 {
  schemaVersion: 2;
  allocatorVersion: string;
  profile: 'balanced';
  utilization: {
    effectiveWindowRatio: number;
    safetyReserveRatio: number;
    promptReserveRatio: number;
  };
  continuation: {
    writer: StageRatioRule;
    checker: StageRatioRule;
    control: StageRatioRule;
    repair: StageRatioRule;
    hanDemand: {
      estimatedTokensPerHan: number;
      minimumCompletionCoverageRatio: number;
    };
    checkerReportDensity: RatioCurve;
    controlReportDensity: RatioCurve;
    contextCategoryCurves: Record<ContinuationContextCategory, RatioCurve>;
  };
  /**
   * The legacy outline allocator remains readable and testable. These fields
   * are its ratio contract; its historical floors are intentionally kept in
   * the outline compatibility implementation, never consumed by V4.
   */
  outlineCompatibility: {
    inputRatio: number;
    outputRatio: number;
    slidingWindowRatio: number;
    resourceBudgetRatio: number;
    storyStateBudgetRatio: number;
    episodicMemoryBudgetRatio: number;
    draftRatio: number;
    reviewRatio: number;
    factCheckRatio: number;
    proofRatio: number;
    resourceCharacterRatio: number;
    resourceNoteRatio: number;
    resourceWorldbookRatio: number;
  };
}

/**
 * One versioned preset is the only source of Continuation ratio policy.
 * Values are ratios or demand multipliers, not per-stage token ceilings.
 */
export const DEFAULT_CONTEXT_AUTOMATION_POLICY_V2: ContextAutomationPolicyV2 = {
  schemaVersion: 2,
  allocatorVersion: 'context-automation-v2',
  profile: 'balanced',
  utilization: {
    effectiveWindowRatio: 0.8,
    safetyReserveRatio: 0.0625,
    promptReserveRatio: 0.04,
  },
  continuation: {
    writer: { maxOutputRatio: 0.2 },
    checker: { maxOutputRatio: 0.2 },
    control: { maxOutputRatio: 0.2 },
    repair: { maxOutputRatio: 0.2 },
    hanDemand: {
      estimatedTokensPerHan: 3,
      minimumCompletionCoverageRatio: 0.72,
    },
    checkerReportDensity: { min: 0.08, max: 0.2 },
    controlReportDensity: { min: 0.05, max: 0.12 },
    contextCategoryCurves: {
      canon: { min: 0.3, max: 0.45 },
      primaryAnchor: { min: 0.25, max: 0.35 },
      storyMemory: { min: 0.15, max: 0.25 },
      recentBridge: { min: 0.1, max: 0.18 },
      originalStyle: { min: 0.1, max: 0.15 },
      episodic: { min: 0.07, max: 0.1 },
      supplements: { min: 0.03, max: 0.05 },
    },
  },
  outlineCompatibility: {
    inputRatio: 0.8,
    outputRatio: 0.2,
    slidingWindowRatio: 0.45,
    resourceBudgetRatio: 0.2,
    storyStateBudgetRatio: 0.25,
    episodicMemoryBudgetRatio: 0.1,
    draftRatio: 0.5,
    reviewRatio: 0.15,
    factCheckRatio: 0.15,
    proofRatio: 0.2,
    resourceCharacterRatio: 0.35,
    resourceNoteRatio: 0.2,
    resourceWorldbookRatio: 0.45,
  },
};

const STAGES: ContinuationV4Stage[] = [
  'writer',
  'checker',
  'control',
  'repair',
];

const CATEGORIES: ContinuationContextCategory[] = [
  'canon',
  'primaryAnchor',
  'storyMemory',
  'recentBridge',
  'originalStyle',
  'episodic',
  'supplements',
];

function isFiniteRatio(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isValidCurve(value: unknown): value is RatioCurve {
  if (!value || typeof value !== 'object') return false;
  const curve = value as Partial<RatioCurve>;
  return (
    isFiniteRatio(curve.min) &&
    isFiniteRatio(curve.max) &&
    curve.min <= curve.max
  );
}

/** Validate persisted policy JSON before any V4 code consumes it. */
export function isContextAutomationPolicyV2(
  value: unknown,
): value is ContextAutomationPolicyV2 {
  if (!value || typeof value !== 'object') return false;
  const policy = value as Partial<ContextAutomationPolicyV2>;
  if (
    policy.schemaVersion !== 2 ||
    typeof policy.allocatorVersion !== 'string' ||
    policy.allocatorVersion.length === 0 ||
    policy.profile !== 'balanced' ||
    !policy.utilization ||
    !policy.continuation ||
    !policy.outlineCompatibility
  ) {
    return false;
  }

  const utilization = policy.utilization;
  if (
    !isFiniteRatio(utilization.effectiveWindowRatio) ||
    utilization.effectiveWindowRatio <= 0 ||
    !isFiniteRatio(utilization.safetyReserveRatio) ||
    !isFiniteRatio(utilization.promptReserveRatio)
  ) {
    return false;
  }

  const continuation = policy.continuation;
  for (const stage of STAGES) {
    const rule = continuation[stage];
    if (
      !rule ||
      !isFiniteRatio(rule.maxOutputRatio) ||
      rule.maxOutputRatio <= 0
    ) {
      return false;
    }
  }
  if (
    !continuation.hanDemand ||
    typeof continuation.hanDemand.estimatedTokensPerHan !== 'number' ||
    !Number.isFinite(continuation.hanDemand.estimatedTokensPerHan) ||
    continuation.hanDemand.estimatedTokensPerHan <= 0 ||
    !isFiniteRatio(continuation.hanDemand.minimumCompletionCoverageRatio) ||
    !isValidCurve(continuation.checkerReportDensity) ||
    !isValidCurve(continuation.controlReportDensity) ||
    !continuation.contextCategoryCurves
  ) {
    return false;
  }
  for (const category of CATEGORIES) {
    if (!isValidCurve(continuation.contextCategoryCurves[category])) {
      return false;
    }
  }

  const outline = policy.outlineCompatibility;
  const outlineRatios = [
    outline.inputRatio,
    outline.outputRatio,
    outline.slidingWindowRatio,
    outline.resourceBudgetRatio,
    outline.storyStateBudgetRatio,
    outline.episodicMemoryBudgetRatio,
    outline.draftRatio,
    outline.reviewRatio,
    outline.factCheckRatio,
    outline.proofRatio,
    outline.resourceCharacterRatio,
    outline.resourceNoteRatio,
    outline.resourceWorldbookRatio,
  ];
  return outlineRatios.every(isFiniteRatio);
}

/** Return a detached copy so callers cannot mutate the process-wide preset. */
export function cloneDefaultContextAutomationPolicy(): ContextAutomationPolicyV2 {
  return JSON.parse(
    JSON.stringify(DEFAULT_CONTEXT_AUTOMATION_POLICY_V2),
  ) as ContextAutomationPolicyV2;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableSerialize(object[key])}`)
    .join(',')}}`;
}

export function serializeContextAutomationPolicy(
  policy: ContextAutomationPolicyV2,
): string {
  return stableSerialize(policy);
}

export function hashContextAutomationPolicy(
  policy: ContextAutomationPolicyV2,
): string {
  return sha256Hex(serializeContextAutomationPolicy(policy));
}

export interface ContinuationPolicyPreview {
  schemaVersion: 2;
  allocatorVersion: string;
  policyHash: string;
  effectiveWindowRatio: number;
  safetyReserveRatio: number;
  promptReserveRatio: number;
  stageMaxOutputRatios: Record<ContinuationV4Stage, number>;
  checkerReportDensity: RatioCurve;
  controlReportDensity: RatioCurve;
}

export function buildContinuationPolicyPreview(
  policy: ContextAutomationPolicyV2,
): ContinuationPolicyPreview {
  return {
    schemaVersion: policy.schemaVersion,
    allocatorVersion: policy.allocatorVersion,
    policyHash: hashContextAutomationPolicy(policy),
    effectiveWindowRatio: policy.utilization.effectiveWindowRatio,
    safetyReserveRatio: policy.utilization.safetyReserveRatio,
    promptReserveRatio: policy.utilization.promptReserveRatio,
    stageMaxOutputRatios: {
      writer: policy.continuation.writer.maxOutputRatio,
      checker: policy.continuation.checker.maxOutputRatio,
      control: policy.continuation.control.maxOutputRatio,
      repair: policy.continuation.repair.maxOutputRatio,
    },
    checkerReportDensity: { ...policy.continuation.checkerReportDensity },
    controlReportDensity: { ...policy.continuation.controlReportDensity },
  };
}

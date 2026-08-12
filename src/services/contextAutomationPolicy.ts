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

// ---------------------------------------------------------------------------
// Outline Pipeline Budget V3
// ---------------------------------------------------------------------------

export type OutlinePipelineStageV3 =
  | 'draft'
  | 'review'
  | 'factCheck'
  | 'brief'
  | 'proof';
export type OutlineReasoningTierV3 = 'low' | 'high' | 'max';

export interface StageBudgetPolicyV3 {
  /** Minimum visible completion reservation, independent of hidden Thinking. */
  visibleOutputFloor: number;
  /** Optional ratio used by preview/auto allocation when no stage override exists. */
  visibleOutputRatio?: number;
  /** Hidden-reasoning reservation for each product tier. */
  reasoningHeadroom: Record<OutlineReasoningTierV3, number>;
  /** Per-stage safety reserve; never borrowed by another stage. */
  safetyMarginRatio: number;
  maxOutputCap?: number;
}

export interface OutlinePipelineBudgetPolicyV3 {
  schemaVersion: 3;
  allocatorVersion: 'outline-pipeline-budget-v3';
  stages: Record<OutlinePipelineStageV3, StageBudgetPolicyV3>;
}

export const DEFAULT_OUTLINE_PIPELINE_BUDGET_POLICY_V3: OutlinePipelineBudgetPolicyV3 =
  {
    schemaVersion: 3,
    allocatorVersion: 'outline-pipeline-budget-v3',
    stages: {
      draft: {
        visibleOutputFloor: 4000,
        visibleOutputRatio: 0.2,
        reasoningHeadroom: { low: 1024, high: 1536, max: 2048 },
        safetyMarginRatio: 0.0625,
      },
      review: {
        visibleOutputFloor: 1500,
        reasoningHeadroom: { low: 1024, high: 1536, max: 1536 },
        safetyMarginRatio: 0.0625,
      },
      factCheck: {
        visibleOutputFloor: 1500,
        reasoningHeadroom: { low: 1024, high: 1536, max: 1536 },
        safetyMarginRatio: 0.0625,
      },
      brief: {
        visibleOutputFloor: 1200,
        reasoningHeadroom: { low: 1200, high: 1200, max: 1200 },
        safetyMarginRatio: 0.0625,
      },
      proof: {
        visibleOutputFloor: 5000,
        visibleOutputRatio: 0.2,
        reasoningHeadroom: { low: 1024, high: 1536, max: 2048 },
        safetyMarginRatio: 0.0625,
      },
    },
  };

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function isOutlinePipelineBudgetPolicyV3(
  value: unknown,
): value is OutlinePipelineBudgetPolicyV3 {
  if (!value || typeof value !== 'object') return false;
  const policy = value as Partial<OutlinePipelineBudgetPolicyV3>;
  if (
    policy.schemaVersion !== 3 ||
    policy.allocatorVersion !== 'outline-pipeline-budget-v3' ||
    !policy.stages
  ) {
    return false;
  }
  for (const stage of [
    'draft',
    'review',
    'factCheck',
    'brief',
    'proof',
  ] as const) {
    const item = policy.stages[stage];
    if (!item || !isFinitePositive(item.visibleOutputFloor)) return false;
    if (
      !item.reasoningHeadroom ||
      !isFinitePositive(item.reasoningHeadroom.low) ||
      !isFinitePositive(item.reasoningHeadroom.high) ||
      !isFinitePositive(item.reasoningHeadroom.max) ||
      !isFiniteRatio(item.safetyMarginRatio)
    ) {
      return false;
    }
  }
  return true;
}

export function cloneDefaultOutlinePipelineBudgetPolicyV3(): OutlinePipelineBudgetPolicyV3 {
  return JSON.parse(
    JSON.stringify(DEFAULT_OUTLINE_PIPELINE_BUDGET_POLICY_V3),
  ) as OutlinePipelineBudgetPolicyV3;
}

// ---------------------------------------------------------------------------
// Context Budget V3 — Hierarchical Elastic Board/Item Policy
// (docs/optimization/Tavo-Mini-Context-Budget-V3-Hierarchical-Elastic-Optimization-Plan.md)
//
// V3 supersedes the V2 outline-compatibility fixed ratios with a three-level
// elastic system:
//
//   Model window
//     → Soft / Burst / Hard envelope (water levels)
//       → Board Soft Targets × Elastic Ceilings
//         → Resource Item Demands
//
// Soft Target ≠ Hard Cap. Boards whose actual demand is below their soft
// target release the unused budget into a Global Elastic Pool; boards with
// unmet demand borrow from that pool by priority × relevance. Resources never
// share the V2 fixed 35/20/45 split — every activated candidate competes by
// actual demand / activation / explicit selection.
//
// Versioning: V3 is independent of `context_budget_version`'s numerical
// sequence. Historical protocol rows remain readable; new V3 tasks freeze
// `context_budget_version = 6` together with the policy snapshot so legacy
// resumes never auto-upgrade.
// ---------------------------------------------------------------------------

export type ContextBudgetBoardKey =
  | 'storyState'
  | 'resources'
  | 'slidingWindow'
  | 'episodic';

export interface ContextBudgetBoardPolicy {
  /** Share of the elastic pool targeted when demand is healthy. */
  softRatio: number;
  /** Maximum share this board may grow to via cross-board borrowing. */
  elasticCeilingRatio: number;
  /** Higher priority boards borrow reclaimed budget first. */
  priority: number;
}

export type ResourceActivationReason =
  | 'primary_secondary_hit'
  | 'constant'
  | 'primary_hit'
  | 'recursive_hit'
  | 'project_fallback'
  | 'explicit';

export interface ContextAutomationPolicyV3 {
  schemaVersion: 3;
  allocatorVersion: 'context-automation-v3';
  profile: 'balanced';
  waterLevels: {
    /** Soft input water level (default 0.80 of post-reserve envelope). */
    softRatio: number;
    /** Burst input water level (default 0.95). */
    burstRatio: number;
  };
  boards: Record<ContextBudgetBoardKey, ContextBudgetBoardPolicy>;
  /** Global reserve kept inside the elastic pool to absorb estimation drift. */
  globalReserveRatio: number;
  resourceItems: {
    /** Multiplier applied to priority×relevance score for explicit picks. */
    explicitSelectionBoost: number;
    /**
     * Demands whose unmet target is at most this many tokens are full-fit
     * before larger demands get any surplus (Plan §7).
     */
    smallDemandFullFitBias: number;
    /**
     * Activation source → relevance mapping (Plan §6.4). Higher relevance wins
     * at parity on priority and explicit selection.
     */
    activationWeights: Record<ResourceActivationReason, number>;
  };
}

export const DEFAULT_CONTEXT_AUTOMATION_POLICY_V3: ContextAutomationPolicyV3 = {
  schemaVersion: 3,
  allocatorVersion: 'context-automation-v3',
  profile: 'balanced',
  waterLevels: {
    softRatio: 0.8,
    burstRatio: 0.95,
  },
  boards: {
    storyState: {
      softRatio: 0.2,
      elasticCeilingRatio: 0.3,
      priority: 8,
    },
    resources: {
      softRatio: 0.3,
      elasticCeilingRatio: 0.5,
      priority: 9,
    },
    slidingWindow: {
      softRatio: 0.25,
      elasticCeilingRatio: 0.4,
      priority: 8,
    },
    episodic: {
      softRatio: 0.15,
      elasticCeilingRatio: 0.3,
      priority: 6,
    },
  },
  globalReserveRatio: 0.1,
  resourceItems: {
    explicitSelectionBoost: 1.8,
    smallDemandFullFitBias: 4000,
    activationWeights: {
      primary_secondary_hit: 1.0,
      constant: 0.95,
      primary_hit: 0.9,
      recursive_hit: 0.75,
      project_fallback: 0.45,
      explicit: 1.0,
    },
  },
};

function isBoardPolicy(value: unknown): value is ContextBudgetBoardPolicy {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<ContextBudgetBoardPolicy>;
  return (
    isFiniteRatio(v.softRatio) &&
    isFiniteRatio(v.elasticCeilingRatio) &&
    v.softRatio <= v.elasticCeilingRatio &&
    typeof v.priority === 'number' &&
    Number.isFinite(v.priority) &&
    v.priority >= 0
  );
}

export function isContextAutomationPolicyV3(
  value: unknown,
): value is ContextAutomationPolicyV3 {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<ContextAutomationPolicyV3>;
  if (
    p.schemaVersion !== 3 ||
    p.allocatorVersion !== 'context-automation-v3' ||
    p.profile !== 'balanced' ||
    !p.waterLevels ||
    !p.boards ||
    !p.resourceItems
  ) {
    return false;
  }
  const wl = p.waterLevels;
  if (
    !isFiniteRatio(wl.softRatio) ||
    !isFiniteRatio(wl.burstRatio) ||
    wl.softRatio <= 0 ||
    wl.burstRatio <= wl.softRatio ||
    wl.burstRatio > 1
  ) {
    return false;
  }
  const boards = p.boards;
  if (
    !isBoardPolicy(boards.storyState) ||
    !isBoardPolicy(boards.resources) ||
    !isBoardPolicy(boards.slidingWindow) ||
    !isBoardPolicy(boards.episodic)
  ) {
    return false;
  }
  const softSum =
    boards.storyState.softRatio +
    boards.resources.softRatio +
    boards.slidingWindow.softRatio +
    boards.episodic.softRatio +
    (typeof p.globalReserveRatio === 'number'
      ? p.globalReserveRatio
      : Number.NaN);
  if (!Number.isFinite(softSum) || softSum > 1 + 1e-9) return false;
  const ri = p.resourceItems;
  if (
    !ri ||
    typeof ri.explicitSelectionBoost !== 'number' ||
    !(ri.explicitSelectionBoost > 0) ||
    typeof ri.smallDemandFullFitBias !== 'number' ||
    !(ri.smallDemandFullFitBias >= 0) ||
    !ri.activationWeights
  ) {
    return false;
  }
  const requiredActivations: ResourceActivationReason[] = [
    'primary_secondary_hit',
    'constant',
    'primary_hit',
    'recursive_hit',
    'project_fallback',
    'explicit',
  ];
  for (const key of requiredActivations) {
    if (!isFiniteRatio(ri.activationWeights[key])) return false;
  }
  return true;
}

export function cloneDefaultContextAutomationPolicyV3(): ContextAutomationPolicyV3 {
  return JSON.parse(
    JSON.stringify(DEFAULT_CONTEXT_AUTOMATION_POLICY_V3),
  ) as ContextAutomationPolicyV3;
}

export function hashContextAutomationPolicyV3(
  policy: ContextAutomationPolicyV3,
): string {
  return sha256Hex(stableSerialize(policy));
}

export function serializeContextAutomationPolicyV3(
  policy: ContextAutomationPolicyV3,
): string {
  return JSON.stringify(policy);
}

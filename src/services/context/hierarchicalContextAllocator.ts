/**
 * Hierarchical (Board + Item) Elastic Context Budget Allocator — V3.
 *
 * Plan: `docs/optimization/Tavo-Mini-Context-Budget-V3-Hierarchical-Elastic-Optimization-Plan.md`
 *
 * Two-level allocation:
 *   1. Board level: storyState / resources / slidingWindow / episodic each get
 *      a Soft Target share of the elastic pool. Boards whose actual demand is
 *      below their soft target release the unused budget into a Global Elastic
 *      Pool; boards with unmet demand borrow from that pool by
 *      priority × relevance up to their Elastic Ceiling.
 *   2. Item level (Resources only): each activated resource candidate competes
 *      for the Resources board grant by priority × relevance × explicitBoost.
 *      Small demands full-fit first; no candidate is pre-clipped.
 *
 * Reuses `allocateDemandsWithinCapacity` (the shared core) at both levels so
 * there is exactly one deterministic, property-tested algorithm.
 *
 * Invariants:
 *   board.allocatedTokens <= board.elasticMaxTokens
 *   sum(board.allocated) + mandatoryTokens <= envelope.hardInputLimit
 *   itemAllocation <= itemActualTokens
 *   sum(itemAllocation) <= resourcesBoardGrant
 *   identical input → byte-identical output (no Date.now, no Map insertion
 *   order leakage, deterministic tie-break by id)
 */

import {
  allocateDemandsWithinCapacity,
  type DemandRequirement,
} from '../pipeline/elasticBudgetAllocator';
import {
  DEFAULT_CONTEXT_AUTOMATION_POLICY_V3,
  type ContextAutomationPolicyV3,
  type ContextBudgetBoardKey,
  type ResourceActivationReason,
} from '../contextAutomationPolicy';
import { deriveDefaultSafetyMargin } from '../pipeline/budgetAllocator';

export interface HierarchicalBudgetEnvelope {
  contextWindow: number;
  reservedOutputTokens: number;
  safetyMargin: number;
  /** Hard input cap (W − O − S). */
  hardInputLimit: number;
  /** Soft input water level (80% of hard). */
  softInputLimit: number;
  /** Burst input water level (95% of hard). */
  burstInputLimit: number;
  /** Real tokens already consumed by mandatory (preset + outline + protocol). */
  mandatoryTokens: number;
  /** Elastic pool = soft line minus mandatory. */
  softElasticPool: number;
  /** Burst pool = burst line minus max(soft, mandatory). */
  burstElasticPool: number;
}

export interface BoardDemandInput {
  /** Sum of actual activated content tokens this board wants to inject. */
  actualDemandTokens: number;
  /** Optional floor; defaults to 30% of soft target. */
  minTokens?: number;
  /** Optional relevance override in [0,1]; defaults to per-board preset. */
  relevance?: number;
}

export interface ResourceItemDemand {
  id: string;
  sourceKind: 'character' | 'note' | 'worldbook';
  /** Real content size; allocator never grants more than this. */
  actualTokens: number;
  /** User explicitly picked this resource (Plan §7 selectionBoost). */
  explicitSelected: boolean;
  /** Whether activation logic turned this candidate on. */
  activated: boolean;
  activationReason?: ResourceActivationReason;
  priority?: number;
  relevance?: number;
  requirement?: DemandRequirement;
  /** Stable input order; deterministic tie-break only. */
  sourceOrder: number;
  /** Optional legacy max_tokens; manual mode respects it, V3 ignores it. */
  legacyMaxTokens?: number;
}

export interface HierarchicalBudgetInput {
  contextWindow: number;
  reservedOutputTokens: number;
  /** Real mandatory tokens (preset + outline + protocol). */
  mandatoryTokens: number;
  /** Optional safety margin; auto-derived from window when omitted. */
  safetyMargin?: number;
  policy?: ContextAutomationPolicyV3;
  /**
   * V7-only detail preference. It changes the Resources board's elastic
   * ceiling inside the shared allocator; the envelope hard limit remains the
   * final authority. Undefined preserves the V6/default behavior.
   */
  resourceDetailIntensity?: 'save' | 'balanced' | 'rich';
  boards: {
    storyState: BoardDemandInput;
    resources: BoardDemandInput;
    slidingWindow: BoardDemandInput;
    episodic: BoardDemandInput;
  };
  /** When provided, Resources board grant is split across these candidates. */
  resourceItems?: ResourceItemDemand[];
}

export interface BoardAllocationTrace {
  key: ContextBudgetBoardKey;
  /** Real demand forwarded by the board's collector. */
  actualDemandTokens: number;
  /** Policy soft target for this board. */
  softTargetTokens: number;
  /** Elastic ceiling; allocation never exceeds this. */
  elasticMaxTokens: number;
  /** Tokens granted after reclaim / borrow. */
  allocatedTokens: number;
  /** Tokens reclaimed from this board when its demand was below soft target. */
  reclaimedTokens: number;
  /** Tokens this board pulled from the Global Elastic Pool / burst band. */
  borrowedTokens: number;
  priority: number;
  relevance: number;
  requirement: DemandRequirement;
  reason: string;
}

export interface HierarchicalBudgetResult {
  envelope: HierarchicalBudgetEnvelope;
  boardAllocations: Record<ContextBudgetBoardKey, BoardAllocationTrace>;
  /** Item-level allocation map (id → tokens) when resourceItems were provided. */
  resourceItemAllocations?: ReadonlyMap<string, number>;
  /** Per-item trace for Preview diagnostics. */
  resourceItemTraces?: Array<{
    id: string;
    demandTokens: number;
    softTargetTokens: number;
    allocatedTokens: number;
    reason: string;
  }>;
  /** Total tokens scheduled across all boards + mandatory. */
  totalEstimatedInputTokens: number;
  riskLevel: 'normal' | 'elevated' | 'high';
}

const BOARD_DEFAULT_RELEVANCE: Record<ContextBudgetBoardKey, number> = {
  storyState: 0.85,
  resources: 0.85,
  slidingWindow: 0.7,
  episodic: 0.7,
};

const BOARD_DEFAULT_REQUIREMENT: Record<ContextBudgetBoardKey, DemandRequirement> = {
  storyState: 'preferred',
  resources: 'preferred',
  slidingWindow: 'optional',
  episodic: 'optional',
};

function floorPositive(n: number): number {
  return Math.max(0, Math.floor(Number(n) || 0));
}

/**
 * Build the Soft / Burst / Hard envelope from the model window + mandatory.
 * Pure; deterministic; never throws on legal inputs.
 */
export function deriveHierarchicalEnvelope(params: {
  contextWindow: number;
  reservedOutputTokens: number;
  mandatoryTokens: number;
  safetyMargin?: number;
  policy?: Pick<ContextAutomationPolicyV3, 'waterLevels'>;
}): HierarchicalBudgetEnvelope {
  const contextWindow = floorPositive(params.contextWindow);
  const reservedOutputTokens = floorPositive(params.reservedOutputTokens);
  const mandatoryTokens = floorPositive(params.mandatoryTokens);
  const safetyMargin =
    params.safetyMargin != null && Number.isFinite(params.safetyMargin)
      ? floorPositive(params.safetyMargin)
      : deriveDefaultSafetyMargin(contextWindow);
  const softRatio = params.policy?.waterLevels.softRatio ?? 0.8;
  const burstRatio = params.policy?.waterLevels.burstRatio ?? 0.95;
  const hardInputLimit = Math.max(
    0,
    contextWindow - reservedOutputTokens - safetyMargin,
  );
  const softInputLimit = Math.floor(hardInputLimit * softRatio);
  const burstInputLimit = Math.floor(hardInputLimit * burstRatio);
  const softElasticPool = Math.max(0, softInputLimit - mandatoryTokens);
  const burstElasticPool = Math.max(
    0,
    burstInputLimit - Math.max(softInputLimit, mandatoryTokens),
  );
  return {
    contextWindow,
    reservedOutputTokens,
    safetyMargin,
    hardInputLimit,
    softInputLimit,
    burstInputLimit,
    mandatoryTokens,
    softElasticPool,
    burstElasticPool,
  };
}

interface BoardRuntime {
  key: ContextBudgetBoardKey;
  policy: ContextAutomationPolicyV3['boards'][ContextBudgetBoardKey];
  input: BoardDemandInput;
  actualDemand: number;
  softTarget: number;
  elasticMax: number;
  min: number;
  relevance: number;
  requirement: DemandRequirement;
  priority: number;
}

/**
 * Phase 1 — distribute the elastic pool across boards. Soft targets yield;
 * surplus is reclaimed and re-distributed by priority × relevance. Boards
 * with remaining demand may then borrow into the burst band.
 *
 * Single call to the shared core with capacity = soft elastic pool + 75% of
 * the burst pool (mirrors the V2 elastic allocator's BURST_AUTO_USE_RATIO).
 * For each board:
 *   target = min(softTarget, actualDemand)   (Soft Target ≠ Hard Cap)
 *   max    = min(elasticMax, actualDemand)   (content is the natural ceiling)
 *
 * After the call:
 *   borrowed = max(0, allocated − min(softTarget, actualDemand))
 *   reclaimed = max(0, softTarget − actualDemand) when actual < softTarget
 *
 * Pure / deterministic.
 */
function allocateAcrossBoards(
  envelope: HierarchicalBudgetEnvelope,
  policy: ContextAutomationPolicyV3,
  boards: HierarchicalBudgetInput['boards'],
  resourceDetailIntensity?: HierarchicalBudgetInput['resourceDetailIntensity'],
): {
  allocations: Record<ContextBudgetBoardKey, number>;
  traces: Record<ContextBudgetBoardKey, BoardAllocationTrace>;
} {
  const keys: ContextBudgetBoardKey[] = [
    'storyState',
    'resources',
    'slidingWindow',
    'episodic',
  ];
  const runtimes: Record<ContextBudgetBoardKey, BoardRuntime> = {} as Record<
    ContextBudgetBoardKey,
    BoardRuntime
  >;
  for (const key of keys) {
    const boardPolicy = policy.boards[key];
    const input = boards[key];
    const actualDemand = floorPositive(input.actualDemandTokens);
    const softTarget = Math.floor(
      envelope.softElasticPool * boardPolicy.softRatio,
    );
    const intensityRatio =
      key === 'resources' && resourceDetailIntensity === 'save'
        ? 0.55
        : key === 'resources' && resourceDetailIntensity === 'rich'
          ? 1.15
          : 1;
    const elasticCeilingRatio = Math.min(
      1,
      boardPolicy.elasticCeilingRatio * intensityRatio,
    );
    const elasticMax = Math.floor(
      envelope.softElasticPool * elasticCeilingRatio,
    );
    const defaultMin = Math.floor(softTarget * 0.3);
    const min = Math.min(
      elasticMax,
      floorPositive(input.minTokens ?? defaultMin),
    );
    const relevance =
      typeof input.relevance === 'number' &&
      Number.isFinite(input.relevance) &&
      input.relevance >= 0 &&
      input.relevance <= 1
        ? input.relevance
        : BOARD_DEFAULT_RELEVANCE[key];
    const requirement = BOARD_DEFAULT_REQUIREMENT[key];
    runtimes[key] = {
      key,
      policy: boardPolicy,
      input,
      actualDemand,
      softTarget,
      elasticMax,
      min,
      relevance,
      requirement,
      priority: boardPolicy.priority,
    };
  }

  // Effective elastic capacity = soft pool + 75% of burst pool. The residual
  // 25% cushions wrapping/estimation drift so the final request never crosses
  // the hard line.
  const effectiveCapacity =
    envelope.softElasticPool +
    Math.floor(envelope.burstElasticPool * 0.75);

  const result = allocateDemandsWithinCapacity({
    capacity: effectiveCapacity,
    demands: keys.map(k => {
      const r = runtimes[k];
      const target = Math.min(r.softTarget, r.actualDemand);
      const max = Math.min(r.elasticMax, r.actualDemand);
      return {
        id: k,
        availableTokens: r.actualDemand,
        minTokens: Math.min(r.min, max),
        targetTokens: Math.min(target, max),
        maxTokens: max,
        priority: r.priority,
        relevance: r.relevance,
        requirement: r.requirement,
      };
    }),
    smallDemandFullFitBias: 0,
  });

  const traces = {} as Record<ContextBudgetBoardKey, BoardAllocationTrace>;
  for (const key of keys) {
    const r = runtimes[key];
    const allocated = Math.max(0, Math.floor(result.allocations.get(key) ?? 0));
    if (!Number.isFinite(allocated)) {
      throw new Error(
        `allocateAcrossBoards: non-finite allocation for board ${key}`,
      );
    }
    const targetEffective = Math.min(r.softTarget, r.actualDemand);
    const borrowed = Math.max(0, allocated - targetEffective);
    // Reclaim = budget the board released because its actual demand was
    // below its soft target (Plan §5 rule 3).
    const reclaimed =
      r.actualDemand < r.softTarget
        ? Math.max(0, r.softTarget - r.actualDemand)
        : 0;
    const reason = describeBoardReason(r, allocated, reclaimed, borrowed);
    traces[key] = {
      key,
      actualDemandTokens: r.actualDemand,
      softTargetTokens: r.softTarget,
      elasticMaxTokens: r.elasticMax,
      allocatedTokens: allocated,
      reclaimedTokens: reclaimed,
      borrowedTokens: borrowed,
      priority: r.priority,
      relevance: r.relevance,
      requirement: r.requirement,
      reason,
    };
  }

  return {
    allocations: {
      storyState: traces.storyState.allocatedTokens,
      resources: traces.resources.allocatedTokens,
      slidingWindow: traces.slidingWindow.allocatedTokens,
      episodic: traces.episodic.allocatedTokens,
    },
    traces,
  };
}

function describeBoardReason(
  r: BoardRuntime,
  allocated: number,
  reclaimed: number,
  borrowed: number,
): string {
  if (r.actualDemand === 0) return 'not_activated';
  if (allocated >= r.actualDemand) return 'full_fit';
  if (borrowed > 0) return 'global_borrow';
  if (reclaimed > 0) return 'soft_target';
  if (allocated >= r.softTarget) return 'soft_target';
  if (allocated > 0) return 'item_competition';
  return 'hard_limit';
}

/**
 * Phase 2 — split the Resources board grant across activated candidates.
 * Uses the shared core with explicit selection boost; small demands full-fit
 * first so the count of complete resources is maximized.
 */
function allocateResourceItems(
  resourcesGrant: number,
  items: ResourceItemDemand[],
  policy: ContextAutomationPolicyV3,
): {
  allocations: ReadonlyMap<string, number>;
  traces: Array<{
    id: string;
    demandTokens: number;
    softTargetTokens: number;
    allocatedTokens: number;
    reason: string;
  }>;
} {
  if (items.length === 0) {
    return { allocations: new Map(), traces: [] };
  }
  const weights = policy.resourceItems.activationWeights;
  const demands = items
    .filter(item => item.activated && item.actualTokens > 0)
    .map(item => {
      const activation: ResourceActivationReason =
        item.activationReason ??
        (item.explicitSelected
          ? 'explicit'
          : item.sourceKind === 'worldbook'
            ? 'project_fallback'
            : 'primary_hit');
      const relevance =
        typeof item.relevance === 'number' &&
        Number.isFinite(item.relevance) &&
        item.relevance >= 0 &&
        item.relevance <= 1
          ? item.relevance
          : weights[activation];
      const boost = item.explicitSelected
        ? policy.resourceItems.explicitSelectionBoost
        : 1;
      const requirement: DemandRequirement = item.explicitSelected
        ? 'preferred'
        : (item.requirement ?? 'optional');
      const priority = item.priority ?? 5;
      return {
        id: item.id,
        availableTokens: Math.max(0, Math.floor(item.actualTokens)),
        minTokens: 0,
        targetTokens: Math.max(0, Math.floor(item.actualTokens)),
        maxTokens: Math.max(0, Math.floor(item.actualTokens)),
        priority,
        relevance,
        requirement,
        selectionBoost: boost,
        _sourceOrder: item.sourceOrder,
        _explicit: item.explicitSelected,
      };
    })
    .sort((a, b) => {
      // Deterministic pre-sort: explicit first, then source order; the
      // allocator's tie-break handles the rest. This keeps map iteration
      // order from leaking into allocation results.
      if (a._explicit !== b._explicit) return a._explicit ? -1 : 1;
      return a._sourceOrder - b._sourceOrder;
    })
    .map(({ _sourceOrder, _explicit, ...rest }) => rest);

  const result = allocateDemandsWithinCapacity({
    capacity: Math.max(0, Math.floor(resourcesGrant)),
    demands,
    smallDemandFullFitBias: policy.resourceItems.smallDemandFullFitBias,
  });

  return {
    allocations: result.allocations,
    traces: result.traces.map(t => ({
      id: t.id,
      demandTokens: t.demandTokens,
      softTargetTokens: t.softTargetTokens,
      allocatedTokens: t.allocatedTokens,
      reason: t.reason,
    })),
  };
}

export function allocateHierarchicalContextBudget(
  input: HierarchicalBudgetInput,
): HierarchicalBudgetResult {
  if (!Number.isFinite(input.contextWindow) || input.contextWindow <= 0) {
    throw new Error(
      `allocateHierarchicalContextBudget: contextWindow must be positive finite, got ${input.contextWindow}`,
    );
  }
  if (
    !Number.isFinite(input.reservedOutputTokens) ||
    input.reservedOutputTokens < 0
  ) {
    throw new Error(
      `allocateHierarchicalContextBudget: reservedOutputTokens must be finite non-negative`,
    );
  }
  const policy = input.policy ?? DEFAULT_CONTEXT_AUTOMATION_POLICY_V3;
  const envelope = deriveHierarchicalEnvelope({
    contextWindow: input.contextWindow,
    reservedOutputTokens: input.reservedOutputTokens,
    mandatoryTokens: input.mandatoryTokens,
    safetyMargin: input.safetyMargin,
    policy,
  });

  const board = allocateAcrossBoards(
    envelope,
    policy,
    input.boards,
    input.resourceDetailIntensity,
  );
  let resourceItemAllocations: ReadonlyMap<string, number> | undefined;
  let resourceItemTraces:
    | HierarchicalBudgetResult['resourceItemTraces']
    | undefined;
  if (input.resourceItems && input.resourceItems.length > 0) {
    const item = allocateResourceItems(
      board.allocations.resources,
      input.resourceItems,
      policy,
    );
    resourceItemAllocations = item.allocations;
    resourceItemTraces = item.traces;
  }

  const totalBoard = Object.values(board.allocations).reduce(
    (sum, n) => sum + n,
    0,
  );
  const totalEstimatedInputTokens = totalBoard + envelope.mandatoryTokens;
  const riskLevel: HierarchicalBudgetResult['riskLevel'] =
    totalEstimatedInputTokens <= envelope.softInputLimit
      ? 'normal'
      : totalEstimatedInputTokens <= envelope.burstInputLimit
        ? 'elevated'
        : 'high';

  return {
    envelope,
    boardAllocations: board.traces,
    resourceItemAllocations,
    resourceItemTraces,
    totalEstimatedInputTokens,
    riskLevel,
  };
}

/**
 * Convenience: derive the Resources board grant for a given input without
 * running item allocation. Used by `contextBuilder` to wire the grant into
 * the candidate collector's final clipping pass.
 */
export function computeResourcesBoardGrant(
  input: Omit<HierarchicalBudgetInput, 'resourceItems'>,
): {
  grant: number;
  trace: BoardAllocationTrace;
  envelope: HierarchicalBudgetEnvelope;
  boardTraces: Record<ContextBudgetBoardKey, BoardAllocationTrace>;
} {
  const result = allocateHierarchicalContextBudget(input);
  return {
    grant: result.boardAllocations.resources.allocatedTokens,
    trace: result.boardAllocations.resources,
    envelope: result.envelope,
    boardTraces: result.boardAllocations,
  };
}

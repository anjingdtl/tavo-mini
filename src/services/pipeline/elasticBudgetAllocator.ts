/**
 * Elastic stage context budget allocator (Phase 1 pure core).
 *
 * Water levels (C = contextWindow - reservedOutputTokens - safetyMargin):
 *   SoftInputLimit  = floor(C × 0.80)
 *   BurstInputLimit = floor(C × 0.95)
 *   HardInputLimit  = C
 *
 * Algorithm order (must not oversubscribe, deterministic):
 *   1. protect mandatory (full allocation, never shrunk)
 *   2. minimum allocation inside the 80% soft pool
 *   3. priority × relevance allocation toward target
 *   4. reclaim empty / content-short modules
 *   5. redistribute inside the soft pool
 *   6. high-value mandatory/preferred may borrow the burst pool
 *   7. auto-use at most 75% of the burst pool
 *   8. (caller) rebuild messages and re-estimate
 *   9. (caller) above 95% shrink optional only
 *  10. mandatory above the hard limit → Blocked
 *
 * Invariants (property-tested):
 *   allocated >= 0
 *   allocated <= availableTokens
 *   allocated <= maxTokens
 *   sum(final allocations) <= hard capacity
 *   same input → same output (deterministic)
 *   mandatory never enters optional shrink
 */
import { deriveDefaultSafetyMargin } from './budgetAllocator';

export type ElasticDemandRequirement = 'mandatory' | 'preferred' | 'optional';

export interface ElasticContextDemand {
  id: string;
  /** How many tokens this module actually holds right now (0 = empty). */
  availableTokens: number;
  /** Bare minimum the stage wants for this module. */
  minTokens: number;
  /** Ideal allocation for this module. */
  targetTokens: number;
  /** Hard cap for this module (content may be clipped to this). */
  maxTokens: number;
  /** Stage-priority weight. */
  priority: number;
  /** Retrieval relevance in [0, 1]. */
  relevance: number;
  requirement: ElasticDemandRequirement;
  /** Whether the allocation may be reclaimed when budget is short. */
  reclaimable: boolean;
  /** Higher = shrunk later (kept longer) during final-window shrink. */
  shrinkPriority: number;
  /** Higher = borrows burst earlier when the soft pool is exhausted. */
  burstPriority: number;
}

export interface ElasticBudgetModuleTrace {
  id: string;
  availableTokens: number;
  minTokens: number;
  targetTokens: number;
  maxTokens: number;
  initialSoftAllocation: number;
  reclaimedTokens: number;
  redistributedTokens: number;
  burstBorrowedTokens: number;
  finalAllocatedTokens: number;
  priority: number;
  relevance: number;
  requirement: string;
  reason: string;
  /** V5 Writer Style display fields; absent on ordinary modules. */
  mode?: 'FULL' | 'EVALUATION' | 'HARD' | 'MINIMAL';
  protected?: boolean;
  allocated?: 'full' | 'partial';
  clipped?: boolean;
}

export interface ElasticBudgetTrace {
  contextWindow: number;
  reservedOutputTokens: number;
  safetyMargin: number;

  hardInputLimit: number;
  softInputLimit: number;
  burstInputLimit: number;

  mandatoryTokens: number;
  softPoolTotal: number;
  softPoolUsed: number;
  burstPoolTotal: number;
  burstPoolUsed: number;

  finalEstimatedInputTokens: number;
  utilizationRatio: number;
  riskLevel: 'normal' | 'elevated' | 'high';

  modules: ElasticBudgetModuleTrace[];
}

export type ElasticBudgetBlockReason = 'mandatory_overflow' | 'invalid_capacity';

export type ElasticStageBudgetResult =
  | {
      ok: true;
      allocations: ReadonlyMap<string, number>;
      trace: ElasticBudgetTrace;
    }
  | {
      ok: false;
      reason: ElasticBudgetBlockReason;
      allocations: ReadonlyMap<string, number>;
      trace: ElasticBudgetTrace;
    };

export interface AllocateElasticStageContextBudgetInput {
  contextWindow: number;
  reservedOutputTokens: number;
  safetyMargin?: number;
  demands: ElasticContextDemand[];
  /**
   * Minimum relevance for a preferred module to be allowed into the burst
   * pool (ordinary optional modules never borrow burst while the soft pool
   * has room). Default 0.7.
   */
  burstRelevanceThreshold?: number;
}

const SOFT_RATIO = 0.8;
const BURST_RATIO = 0.95;
/** Auto-use at most 75% of the burst pool; the rest covers wrapping error. */
const BURST_AUTO_USE_RATIO = 0.75;
const DEFAULT_BURST_RELEVANCE_THRESHOLD = 0.7;

function clampTo(n: number): number {
  return Math.max(0, Math.floor(Number(n) || 0));
}

/** Deterministic tie-break: lexicographic id. */
function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function requirementRank(r: ElasticDemandRequirement): number {
  // lower = allocated first (mandatory 0, preferred 1, optional 2)
  return r === 'mandatory' ? 0 : r === 'preferred' ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Shared capacity-demand allocation core (Context Budget V3 §8).
//
// Pure single-capacity allocator. Both the top-level water-level envelope
// (`allocateElasticStageContextBudget`) and the V3 hierarchical board/item
// allocators delegate the "distribute N tokens across M competing demands"
// sub-problem here so there is one deterministic, property-tested algorithm.
//
// Algorithm (deterministic, never oversubscribes):
//   1. mandatory floor: every mandatory demand gets min(available, max) first
//   2. min floor for non-mandatory demands in priority × relevance order
//   3. small-demand full-fit bias: demands whose remaining target <= bias
//      threshold are filled to target before larger demands get any surplus
//   4. target water-filling: residual capacity is distributed by
//      priority × relevance × unmet-target, deterministic +1 remainder
//   5. explicit-selection boost applied as a multiplier on the score so
//      user-picked items outrank auto-activated ones at parity
//
// Invariants (property-tested in __tests__/contextBudgetV3.spec.test.ts):
//   allocated >= 0
//   allocated <= availableTokens
//   allocated <= maxTokens
//   sum(allocations) <= capacity
//   mandatory allocations always granted first
//   identical input → byte-identical output
// ---------------------------------------------------------------------------

export type DemandRequirement = 'mandatory' | 'preferred' | 'optional';

export interface DemandAllocationItem {
  id: string;
  /** Real content size; allocator must never grant more than this. */
  availableTokens: number;
  /** Bare minimum the demand wants; satisfied before any target filling. */
  minTokens: number;
  /** Ideal allocation; allocator waters up to this when capacity allows. */
  targetTokens: number;
  /** Hard cap (usually equals availableTokens for items). */
  maxTokens: number;
  /** Stage/board priority weight (higher = more important). */
  priority: number;
  /** Retrieval/activation relevance in [0, 1]. */
  relevance: number;
  requirement: DemandRequirement;
  /**
   * Optional multiplier applied to the priority×relevance score. Used for
   * explicit user selection (Plan §7 selectionBoost 1.5~2.0). Default 1.
   */
  selectionBoost?: number;
}

export interface DemandAllocationInput {
  /** Total tokens available for this allocation round (single pool). */
  capacity: number;
  demands: DemandAllocationItem[];
  /**
   * Demands whose `targetTokens - currentAllocation <= smallDemandFullFitBias`
   * are filled to target before larger demands get any surplus. Default 4000.
   */
  smallDemandFullFitBias?: number;
}

export interface DemandAllocationTrace {
  id: string;
  allocatedTokens: number;
  demandTokens: number;
  softTargetTokens: number;
  reason: string;
}

export interface DemandAllocationResult {
  allocations: ReadonlyMap<string, number>;
  totalAllocated: number;
  traces: DemandAllocationTrace[];
}

const DEFAULT_SMALL_DEMAND_FULL_FIT_BIAS = 4000;

function demandRequirementRank(r: DemandRequirement): number {
  return r === 'mandatory' ? 0 : r === 'preferred' ? 1 : 2;
}

function sanitizeDemand(item: DemandAllocationItem): DemandAllocationItem {
  const availableTokens = Math.max(0, Math.floor(Number(item.availableTokens) || 0));
  const maxTokens = Math.max(0, Math.floor(Number(item.maxTokens) || 0));
  const cappedMax = Math.min(maxTokens, availableTokens);
  const minTokens = Math.min(Math.max(0, Math.floor(Number(item.minTokens) || 0)), cappedMax);
  const targetTokens = Math.min(
    Math.max(Math.floor(Number(item.targetTokens) || 0), minTokens),
    cappedMax,
  );
  const priority = Math.max(0, Number(item.priority) || 0);
  const relevance = Math.min(1, Math.max(0, Number(item.relevance) || 0));
  const rawBoost = Number(item.selectionBoost);
  const selectionBoost =
    Number.isFinite(rawBoost) && rawBoost > 0 ? rawBoost : 1;
  if (
    !Number.isFinite(item.availableTokens) ||
    !Number.isFinite(item.maxTokens) ||
    !Number.isFinite(item.minTokens) ||
    !Number.isFinite(item.targetTokens) ||
    !Number.isFinite(item.priority) ||
    !Number.isFinite(item.relevance)
  ) {
    throw new Error(
      `allocateDemandsWithinCapacity: demand ${item.id} has non-finite fields`,
    );
  }
  return {
    id: item.id,
    availableTokens,
    minTokens,
    targetTokens,
    maxTokens: cappedMax,
    priority,
    relevance,
    requirement: item.requirement,
    selectionBoost,
  };
}

export function allocateDemandsWithinCapacity(
  input: DemandAllocationInput,
): DemandAllocationResult {
  if (!Number.isFinite(input.capacity) || input.capacity < 0) {
    throw new Error(
      `allocateDemandsWithinCapacity: capacity must be finite non-negative, got ${input.capacity}`,
    );
  }
  const capacity = Math.floor(input.capacity);
  const smallBias = Number.isFinite(input.smallDemandFullFitBias)
    ? Math.max(0, Math.floor(input.smallDemandFullFitBias as number))
    : DEFAULT_SMALL_DEMAND_FULL_FIT_BIAS;
  const demands = input.demands.map(sanitizeDemand);

  const allocations = new Map<string, number>();
  const reasons = new Map<string, string>();
  for (const d of demands) allocations.set(d.id, 0);

  const capOf = (d: DemandAllocationItem) =>
    Math.min(d.availableTokens, d.maxTokens);
  const targetOf = (d: DemandAllocationItem) =>
    Math.min(d.targetTokens, capOf(d));
  const scoreOf = (d: DemandAllocationItem) => {
    const boost =
      typeof d.selectionBoost === 'number' &&
      Number.isFinite(d.selectionBoost) &&
      d.selectionBoost > 0
        ? d.selectionBoost
        : 1;
    return (
      d.priority *
      d.relevance *
      boost *
      Math.log1p(Math.max(0, targetOf(d) - (allocations.get(d.id) ?? 0)))
    );
  };
  const tieBreak = (a: DemandAllocationItem, b: DemandAllocationItem) =>
    // Lower rank = mandatory (0) / preferred (1) / optional (2). Sort mandatory
    // & preferred first: a "less optional" demand should win the tie-break, so
    // subtract a's rank from b's rank (negative ⇒ a first).
    demandRequirementRank(a.requirement) - demandRequirementRank(b.requirement) ||
    scoreOf(b) - scoreOf(a) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  let remaining = capacity;

  // 1. mandatory floor.
  for (const d of demands
    .filter(d => d.requirement === 'mandatory')
    .sort(tieBreak)) {
    if (remaining <= 0) break;
    const want = Math.min(capOf(d), Math.max(d.minTokens, targetOf(d)));
    const grant = Math.min(want, remaining);
    if (grant <= 0) continue;
    allocations.set(d.id, grant);
    reasons.set(d.id, 'mandatory');
    remaining -= grant;
  }

  // 2. min floor for non-mandatory demands (priority × relevance order).
  const nonMandatory = demands.filter(d => d.requirement !== 'mandatory');
  for (const d of [...nonMandatory].sort(tieBreak)) {
    if (remaining <= 0) break;
    const current = allocations.get(d.id) ?? 0;
    const want = Math.min(d.minTokens, capOf(d));
    const grant = Math.min(Math.max(0, want - current), remaining);
    if (grant <= 0) continue;
    allocations.set(d.id, current + grant);
    reasons.set(d.id, 'min');
    remaining -= grant;
  }

  // 3. small-demand full-fit bias: complete any demand whose remaining target
  //    fits inside the small-bias threshold, so a 700-token item gets fully
  //    funded before a 12000-token item collects any surplus.
  for (const d of [...nonMandatory].sort(tieBreak)) {
    if (remaining <= 0) break;
    const current = allocations.get(d.id) ?? 0;
    const target = targetOf(d);
    const unmet = target - current;
    if (unmet <= 0 || unmet > smallBias) continue;
    const grant = Math.min(unmet, remaining);
    allocations.set(d.id, current + grant);
    reasons.set(d.id, 'small_full_fit');
    remaining -= grant;
  }

  // 4. target water-filling by priority × relevance × selection boost.
  while (remaining > 0) {
    const hungry = nonMandatory
      .filter(d => (allocations.get(d.id) ?? 0) < targetOf(d))
      .sort(tieBreak);
    if (hungry.length === 0) break;
    const per = Math.floor(remaining / hungry.length);
    if (per <= 0) {
      // Deterministic +1 remainder distribution in sorted order.
      for (const d of hungry) {
        if (remaining <= 0) break;
        const current = allocations.get(d.id) ?? 0;
        if (current < targetOf(d)) {
          allocations.set(d.id, current + 1);
          reasons.set(d.id, 'redistributed');
          remaining -= 1;
        }
      }
      break;
    }
    let any = false;
    for (const d of hungry) {
      const current = allocations.get(d.id) ?? 0;
      const unmet = targetOf(d) - current;
      if (unmet <= 0) continue;
      const grant = Math.min(unmet, per);
      if (grant <= 0) continue;
      allocations.set(d.id, current + grant);
      reasons.set(d.id, reasons.get(d.id) === 'min' ? 'redistributed' : reasons.get(d.id) ?? 'redistributed');
      remaining -= grant;
      any = true;
    }
    if (!any) break;
  }

  // 5. (Optional) burst beyond target — only when caller passes maxTokens >
  //    targetTokens. For items, maxTokens === targetTokens === availableTokens,
  //    so this branch is a no-op and the allocator never over-fills content.
  while (remaining > 0) {
    const hungry = nonMandatory
      .filter(d => (allocations.get(d.id) ?? 0) < capOf(d))
      .sort(tieBreak);
    if (hungry.length === 0) break;
    const per = Math.floor(remaining / hungry.length);
    if (per <= 0) {
      for (const d of hungry) {
        if (remaining <= 0) break;
        const current = allocations.get(d.id) ?? 0;
        if (current < capOf(d)) {
          allocations.set(d.id, current + 1);
          reasons.set(d.id, 'burst');
          remaining -= 1;
        }
      }
      break;
    }
    let any = false;
    for (const d of hungry) {
      const current = allocations.get(d.id) ?? 0;
      const unmet = capOf(d) - current;
      if (unmet <= 0) continue;
      const grant = Math.min(unmet, per);
      if (grant <= 0) continue;
      allocations.set(d.id, current + grant);
      reasons.set(d.id, 'burst');
      remaining -= grant;
      any = true;
    }
    if (!any) break;
  }

  let totalAllocated = 0;
  const traces: DemandAllocationTrace[] = demands.map(d => {
    const allocated = allocations.get(d.id) ?? 0;
    totalAllocated += allocated;
    return {
      id: d.id,
      allocatedTokens: allocated,
      demandTokens: d.availableTokens,
      softTargetTokens: d.targetTokens,
      reason: reasons.get(d.id) ?? 'not_activated',
    };
  });

  return { allocations, totalAllocated, traces };
}

export function allocateElasticStageContextBudget(
  input: AllocateElasticStageContextBudgetInput,
): ElasticStageBudgetResult {
  const contextWindow = clampTo(input.contextWindow);
  const reservedOutputTokens = clampTo(input.reservedOutputTokens);
  const safetyMargin =
    input.safetyMargin != null
      ? clampTo(input.safetyMargin)
      : deriveDefaultSafetyMargin(contextWindow);
  const burstRelevanceThreshold =
    input.burstRelevanceThreshold != null
      ? Number(input.burstRelevanceThreshold)
      : DEFAULT_BURST_RELEVANCE_THRESHOLD;

  // Normalize demands (defensive: min <= target <= max, available >= 0).
  const demands: ElasticContextDemand[] = input.demands.map(d => {
    const maxTokens = clampTo(d.maxTokens);
    const minTokens = Math.min(clampTo(d.minTokens), maxTokens);
    const targetTokens = Math.min(
      Math.max(clampTo(d.targetTokens), minTokens),
      maxTokens,
    );
    return {
      ...d,
      availableTokens: clampTo(d.availableTokens),
      minTokens,
      targetTokens,
      maxTokens,
      priority: Math.max(0, Number(d.priority) || 0),
      relevance: Math.min(
        1,
        Math.max(0, Number(d.relevance) || 0),
      ),
    };
  });

  const hardInputLimit = Math.max(0, contextWindow - reservedOutputTokens - safetyMargin);
  const softInputLimit = Math.floor(hardInputLimit * SOFT_RATIO);
  const burstInputLimit = Math.floor(hardInputLimit * BURST_RATIO);

  const moduleTraces = new Map<string, ElasticBudgetModuleTrace>();
  const allocations = new Map<string, number>();
  const alloc = (id: string): number => allocations.get(id) || 0;

  const emptyTrace = (d: ElasticContextDemand): ElasticBudgetModuleTrace => ({
    id: d.id,
    availableTokens: d.availableTokens,
    minTokens: d.minTokens,
    targetTokens: d.targetTokens,
    maxTokens: d.maxTokens,
    initialSoftAllocation: 0,
    reclaimedTokens: 0,
    redistributedTokens: 0,
    burstBorrowedTokens: 0,
    finalAllocatedTokens: 0,
    priority: d.priority,
    relevance: d.relevance,
    requirement: d.requirement,
    reason: '',
  });

  for (const d of demands) {
    moduleTraces.set(d.id, emptyTrace(d));
    allocations.set(d.id, 0);
  }

  // --- 1. protect mandatory (full content, never shrunk) -------------------
  let mandatoryTokens = 0;
  for (const d of demands) {
    if (d.requirement !== 'mandatory') continue;
    const granted = Math.min(d.availableTokens, d.maxTokens);
    allocations.set(d.id, granted);
    mandatoryTokens += granted;
    const t = moduleTraces.get(d.id)!;
    t.initialSoftAllocation = granted;
    t.finalAllocatedTokens = granted;
    t.reason = 'mandatory';
  }

  const buildTrace = (): ElasticBudgetTrace => {
    // mandatoryTokens is tracked as a named constant (mandatory allocations
    // are also stored in module traces); the pools only account for the
    // non-mandatory allocations so nothing is double-counted.
    let burstPoolUsed = 0;
    let finalEstimatedInputTokens = 0;
    for (const t of moduleTraces.values()) {
      finalEstimatedInputTokens += t.finalAllocatedTokens;
      burstPoolUsed += t.burstBorrowedTokens;
    }
    const nonMandatoryTokens =
      finalEstimatedInputTokens - mandatoryTokens;
    const softPoolUsed = Math.max(0, nonMandatoryTokens - burstPoolUsed);
    const utilizationRatio =
      hardInputLimit > 0 ? finalEstimatedInputTokens / hardInputLimit : 0;
    // Integer water-level comparison (no float boundary ambiguity):
    //  ≤80% normal, ≤95% elevated, above 95% high. Mandatory content that
    // already exceeds the soft line leaves no shrink room → high regardless.
    const riskLevel: ElasticBudgetTrace['riskLevel'] =
      mandatoryTokens > softInputLimit
        ? 'high'
        : finalEstimatedInputTokens <= softInputLimit
          ? 'normal'
          : finalEstimatedInputTokens <= burstInputLimit
            ? 'elevated'
            : 'high';
    return {
      contextWindow,
      reservedOutputTokens,
      safetyMargin,
      hardInputLimit,
      softInputLimit,
      burstInputLimit,
      mandatoryTokens,
      softPoolTotal: Math.max(0, softInputLimit - mandatoryTokens),
      softPoolUsed,
      burstPoolTotal: Math.max(0, hardInputLimit - Math.max(softInputLimit, mandatoryTokens)),
      burstPoolUsed,
      finalEstimatedInputTokens,
      utilizationRatio,
      riskLevel,
      modules: demands.map(d => moduleTraces.get(d.id)!),
    };
  };

  // --- capacity guard -------------------------------------------------------
  if (hardInputLimit <= 0) {
    return {
      ok: false,
      reason: 'invalid_capacity',
      allocations,
      trace: buildTrace(),
    };
  }
  if (mandatoryTokens > hardInputLimit) {
    return {
      ok: false,
      reason: 'mandatory_overflow',
      allocations,
      trace: buildTrace(),
    };
  }

  const softPoolTotal = Math.max(0, softInputLimit - mandatoryTokens);
  const burstPoolTotal = Math.max(
    0,
    hardInputLimit - Math.max(softInputLimit, mandatoryTokens),
  );
  const burstAutoCap = Math.floor(burstPoolTotal * BURST_AUTO_USE_RATIO);
  const nonMandatory = demands.filter(d => d.requirement !== 'mandatory');
  const score = (d: ElasticContextDemand): number =>
    d.priority * d.relevance * Math.log1p(Math.max(0, d.targetTokens - alloc(d.id)));

  // --- 2. minimum allocation in the soft pool ------------------------------
  let softRemaining = softPoolTotal;
  const minOrder = nonMandatory
    .filter(d => d.availableTokens > 0 && d.minTokens > 0)
    .sort(
      (a, b) =>
        requirementRank(a.requirement) - requirementRank(b.requirement) ||
        score(b) - score(a) ||
        compareId(a.id, b.id),
    );
  for (const d of minOrder) {
    if (softRemaining <= 0) break;
    const need = Math.min(d.availableTokens, d.minTokens, d.maxTokens);
    const granted = Math.min(need, softRemaining);
    if (granted <= 0) continue;
    allocations.set(d.id, alloc(d.id) + granted);
    softRemaining -= granted;
    const t = moduleTraces.get(d.id)!;
    t.initialSoftAllocation += granted;
    t.finalAllocatedTokens += granted;
    t.reason = 'min';
  }

  // --- 3+5. target allocation / redistribution inside the soft pool --------
  const capTarget = (d: ElasticContextDemand): number =>
    Math.min(d.availableTokens, d.targetTokens, d.maxTokens);
  const targetOrder = nonMandatory
    .filter(d => d.availableTokens > 0)
    .sort((a, b) => score(b) - score(a) || compareId(a.id, b.id));

  while (softRemaining > 0) {
    const hungry = targetOrder.filter(d => alloc(d.id) < capTarget(d));
    if (hungry.length === 0) break;
    const per = Math.floor(softRemaining / hungry.length);
    if (per <= 0) {
      // Deterministic remainder: +1 in sorted order until budget runs out.
      for (const d of hungry) {
        if (softRemaining <= 0) break;
        if (alloc(d.id) < capTarget(d)) {
          allocations.set(d.id, alloc(d.id) + 1);
          softRemaining -= 1;
          const t = moduleTraces.get(d.id)!;
          t.redistributedTokens += 1;
          t.finalAllocatedTokens += 1;
          t.reason = 'redistributed';
        }
      }
      break;
    }
    let any = false;
    for (const d of hungry) {
      const need = capTarget(d) - alloc(d.id);
      if (need <= 0) continue;
      const granted = Math.min(need, per);
      if (granted <= 0) continue;
      allocations.set(d.id, alloc(d.id) + granted);
      softRemaining -= granted;
      const t = moduleTraces.get(d.id)!;
      t.redistributedTokens += granted;
      t.finalAllocatedTokens += granted;
      t.reason = 'redistributed';
      any = true;
    }
    if (!any) break;
  }

  // --- 4. reclaim (defensive) ----------------------------------------------
  // Allocation never exceeds availableTokens (every grant clamps), so the
  // only reclaimable delta is a caller-supplied availableTokens that shrank
  // between demand build and allocation — impossible inside one pure call.
  // Keep the trace field for callers that re-derive demand after rebuilding.
  for (const d of demands) {
    if (alloc(d.id) > d.availableTokens) {
      const over = alloc(d.id) - d.availableTokens;
      allocations.set(d.id, alloc(d.id) - over);
      const t = moduleTraces.get(d.id)!;
      t.reclaimedTokens += over;
      t.finalAllocatedTokens = Math.max(0, t.finalAllocatedTokens - over);
      t.reason = 'reclaimed';
    }
  }

  // --- 6+7. burst borrowing (auto cap 75%) ---------------------------------
  // Normal case: only high-relevance preferred (+ mandatory, already full)
  // may enter the elastic band. When mandatory already exceeds the soft
  // limit, optional modules compete inside the elastic band (doc §18.2) —
  // they still cannot pass the burst (95%) line.
  const mandatoryExceedsSoft = mandatoryTokens > softInputLimit;
  const burstCandidates = nonMandatory
    .filter(
      d =>
        d.availableTokens > 0 &&
        alloc(d.id) < Math.min(d.availableTokens, d.maxTokens) &&
        (d.requirement === 'preferred'
          ? d.relevance >= burstRelevanceThreshold
          : d.requirement === 'mandatory' || mandatoryExceedsSoft),
    )
    .sort(
      (a, b) =>
        b.burstPriority - a.burstPriority ||
        score(b) - score(a) ||
        compareId(a.id, b.id),
    );
  // Effective burst budget: 75% of the burst pool, additionally capped so
  // the final request never passes the 95% line even when mandatory already
  // exceeds the soft limit (95%~100% is reserved for mandatory/wrapping
  // error only).
  const softAllocatedSoFar = nonMandatory.reduce(
    (s, d) => s + alloc(d.id),
    0,
  );
  const burstRemainingCap = Math.max(
    0,
    burstInputLimit - mandatoryTokens - softAllocatedSoFar,
  );
  let burstRemaining = Math.min(burstAutoCap, burstRemainingCap);
  const capMax = (d: ElasticContextDemand): number =>
    Math.min(d.availableTokens, d.maxTokens);
  while (burstRemaining > 0) {
    const hungry = burstCandidates.filter(d => alloc(d.id) < capMax(d));
    if (hungry.length === 0) break;
    const per = Math.floor(burstRemaining / hungry.length);
    if (per <= 0) {
      for (const d of hungry) {
        if (burstRemaining <= 0) break;
        if (alloc(d.id) < capMax(d)) {
          allocations.set(d.id, alloc(d.id) + 1);
          burstRemaining -= 1;
          const t = moduleTraces.get(d.id)!;
          t.burstBorrowedTokens += 1;
          t.finalAllocatedTokens += 1;
          t.reason = 'burst';
        }
      }
      break;
    }
    let any = false;
    for (const d of hungry) {
      const need = capMax(d) - alloc(d.id);
      if (need <= 0) continue;
      const granted = Math.min(need, per);
      if (granted <= 0) continue;
      allocations.set(d.id, alloc(d.id) + granted);
      burstRemaining -= granted;
      const t = moduleTraces.get(d.id)!;
      t.burstBorrowedTokens += granted;
      t.finalAllocatedTokens += granted;
      t.reason = 'burst';
      any = true;
    }
    if (!any) break;
  }

  return {
    ok: true,
    allocations,
    trace: buildTrace(),
  };
}

import {
  allocateDemandsWithinCapacity,
  allocateElasticStageContextBudget,
  type ElasticContextDemand,
} from '../../pipeline/elasticBudgetAllocator';
import {
  allocateHierarchicalContextBudget,
  type HierarchicalBudgetInput,
} from '../hierarchicalContextAllocator';
import type {
  GenerationBudgetItem,
  GenerationBudgetDemand,
  GenerationContextPlan,
  GenerationBudgetAllocation,
} from './generationContracts';

function finiteFloor(value: number | undefined, fallback = 0): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? Number(value) : fallback));
}

function waterLevel(
  reason: string,
  allocated: number,
  demand: number,
  hardInputLimit: number,
): GenerationBudgetItem['waterLevel'] {
  if (reason === 'mandatory') return 'mandatory';
  if (allocated <= 0) return 'none';
  if (hardInputLimit > 0 && allocated >= hardInputLimit) return 'hard';
  if (reason === 'burst' || reason === 'global_borrow') return 'burst';
  return 'soft';
}

function buildItems(
  plan: GenerationContextPlan,
  allocations: ReadonlyMap<string, number>,
  reasons: ReadonlyMap<string, string>,
  hardInputLimit: number,
): GenerationBudgetItem[] {
  return plan.demands.map(demand => {
    const aliases = [
      demand.candidateId,
      demand.candidateId === 'outline:project' ? 'outline' : '',
      demand.candidateId.startsWith('story_memory:') ? 'storyState' : '',
      demand.candidateId.startsWith('chapter:current:') ? 'instruction' : '',
      demand.candidateId.startsWith('episodic_memory:') ? 'episodic' : '',
    ].filter(Boolean);
    const allocationId = aliases.find(id => allocations.has(id));
    const allocatedTokens = finiteFloor(
      allocationId ? allocations.get(allocationId) : undefined,
    );
    const allocationReason =
      (allocationId && reasons.get(allocationId)) || 'not_activated';
    const budgetClipped = allocatedTokens < demand.demandTokens;
    return {
      candidateId: demand.candidateId,
      demandTokens: finiteFloor(demand.demandTokens),
      requestedTokens: finiteFloor(demand.demandTokens),
      minTokens: finiteFloor(demand.minTokens),
      targetTokens: finiteFloor(demand.targetTokens),
      maxTokens: finiteFloor(demand.maxTokens),
      allocatedTokens,
      allocationReason,
      waterLevel: waterLevel(
        allocationReason,
        allocatedTokens,
        demand.demandTokens,
        hardInputLimit,
      ),
      budgetClipped,
      clippedByBudget: budgetClipped,
    };
  });
}

function mergeContractDemands(
  plan: GenerationContextPlan,
  override: GenerationBudgetDemand[] | undefined,
): GenerationContextPlan {
  if (!override) return plan;
  const byId = new Map(plan.demands.map(demand => [demand.candidateId, demand]));
  for (const demand of override) byId.set(demand.candidateId, demand);
  return { ...plan, demands: [...byId.values()] };
}

/**
 * The only generation-facing budget entrypoint. Existing elastic and
 * hierarchical mathematics remain in their established pure allocators; this
 * adapter translates their outputs into one Candidate/Budget contract.
 */
export function allocateGenerationContextBudget(input: {
  plan: GenerationContextPlan;
  /** Optional stage-level demands for legacy/elastic compatibility paths. */
  demands?: GenerationBudgetDemand[];
  contextWindow: number;
  reservedOutputTokens: number;
  safetyMargin?: number;
  mode: 'legacy' | 'elastic' | 'hierarchical';
  hierarchicalInput?: HierarchicalBudgetInput;
  /** Existing fixed-ratio callers can publish their unchanged grants. */
  legacyAllocations?: ReadonlyMap<string, number>;
  legacyReasons?: ReadonlyMap<string, string>;
}): GenerationBudgetAllocation {
  const allocationPlan: GenerationContextPlan = input.demands
    ? { ...input.plan, demands: input.demands }
    : input.plan;
  const contractPlan = mergeContractDemands(input.plan, input.demands);
  const contextWindow = finiteFloor(input.contextWindow);
  const reservedOutputTokens = finiteFloor(input.reservedOutputTokens);
  const safetyMargin = finiteFloor(input.safetyMargin);
  const hardInputLimit = Math.max(0, contextWindow - reservedOutputTokens - safetyMargin);
  const softInputLimit = Math.floor(hardInputLimit * 0.8);
  const burstInputLimit = Math.floor(hardInputLimit * 0.95);

  if (input.mode === 'hierarchical') {
    if (!input.hierarchicalInput) {
      throw new Error('GENERATION_BUDGET_HIERARCHICAL_INPUT_REQUIRED');
    }
    const result = allocateHierarchicalContextBudget(input.hierarchicalInput);
    const allocations = new Map<string, number>();
    const reasons = new Map<string, string>();
    for (const item of result.resourceItemTraces || []) {
      allocations.set(item.id, item.allocatedTokens);
      reasons.set(item.id, item.reason);
    }
    for (const board of Object.values(result.boardAllocations)) {
      allocations.set(board.key, board.allocatedTokens);
      reasons.set(board.key, board.reason);
    }
    const items = buildItems(contractPlan, allocations, reasons, result.envelope.hardInputLimit);
    return {
      version: 1,
      mode: input.mode,
      ok: true,
      hardInputLimit: result.envelope.hardInputLimit,
      softInputLimit: result.envelope.softInputLimit,
      burstInputLimit: result.envelope.burstInputLimit,
      items,
      totalAllocatedTokens: items.reduce((sum, item) => sum + item.allocatedTokens, 0),
      trace: result,
    };
  }

  const demands: ElasticContextDemand[] = allocationPlan.demands.map(demand => ({
    id: demand.candidateId,
    availableTokens: demand.demandTokens,
    minTokens: demand.minTokens,
    targetTokens: demand.targetTokens,
    maxTokens: demand.maxTokens,
    priority: demand.priority,
    relevance: demand.relevance,
    requirement: demand.requirement,
    reclaimable: demand.requirement !== 'mandatory',
    shrinkPriority: demand.priority,
    burstPriority: demand.priority,
  }));

  let allocations: ReadonlyMap<string, number>;
  let reasons: ReadonlyMap<string, string>;
  let trace: unknown;
  let ok = true;
  let blockReason: string | undefined;
  if (input.legacyAllocations) {
    allocations = input.legacyAllocations;
    reasons = input.legacyReasons || new Map();
    trace = { kind: 'legacy_fixed_budget', allocations: [...allocations.entries()] };
  } else if (input.mode === 'elastic') {
    const result = allocateElasticStageContextBudget({
      contextWindow,
      reservedOutputTokens,
      safetyMargin,
      demands,
    });
    allocations = result.allocations;
    ok = result.ok;
    blockReason = result.ok ? undefined : result.reason;
    reasons = new Map(
      result.trace.modules.map(module => [module.id, module.reason]),
    );
    trace = result.trace;
  } else {
    const result = allocateDemandsWithinCapacity({
      capacity: hardInputLimit,
      demands: demands.map(demand => ({
        id: demand.id,
        availableTokens: demand.availableTokens,
        minTokens: demand.minTokens,
        targetTokens: demand.targetTokens,
        maxTokens: demand.maxTokens,
        priority: demand.priority,
        relevance: demand.relevance,
        requirement: demand.requirement,
        selectionBoost: 1,
      })),
    });
    allocations = result.allocations;
    reasons = new Map(result.traces.map(item => [item.id, item.reason]));
    trace = result;
  }

  const items = buildItems(contractPlan, allocations, reasons, hardInputLimit);
  return {
    version: 1,
    mode: input.mode,
    ok,
    blockReason,
    hardInputLimit,
    softInputLimit,
    burstInputLimit,
    items,
    totalAllocatedTokens: items.reduce((sum, item) => sum + item.allocatedTokens, 0),
    trace,
  };
}

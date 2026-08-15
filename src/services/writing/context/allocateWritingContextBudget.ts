import { sha256Hex } from '../../continuation/hashUtils';
import type {
  FrozenModelConfig,
  WritingSourceRequirement,
} from '../contracts/writingSource';
import type {
  WritingBudgetAllocation,
  WritingBudgetAllocationItem,
  WritingContextPlan,
} from '../contracts/frozenWritingContext';

function requirementOrder(requirement: WritingSourceRequirement): number {
  return requirement === 'mandatory' ? 0 : requirement === 'preferred' ? 1 : 2;
}

/** The sole generic budget decision source for the new Kernel. */
export function allocateWritingContextBudget(input: {
  plan: WritingContextPlan;
  model: FrozenModelConfig;
}): WritingBudgetAllocation {
  const inputTokenLimit = Math.max(
    0,
    Math.floor(input.model.contextWindow - input.model.maxOutputTokens - 256),
  );
  let remaining = inputTokenLimit;
  const items: WritingBudgetAllocationItem[] = [];
  const planned = [...input.plan.items]
    .filter(item => item.selected)
    .sort(
      (left, right) =>
        requirementOrder(left.requirement) - requirementOrder(right.requirement) ||
        right.priority - left.priority ||
        left.candidateId.localeCompare(right.candidateId),
    );
  for (const item of planned) {
    const allocatedTokens = Math.min(remaining, item.demandTokens);
    remaining = Math.max(0, remaining - allocatedTokens);
    items.push({
      candidateId: item.candidateId,
      demandTokens: item.demandTokens,
      allocatedTokens,
      clipped: allocatedTokens < item.demandTokens,
      allocationReason:
        allocatedTokens < item.demandTokens
          ? item.requirement === 'mandatory'
            ? 'mandatory_budget_clipped_and_traced'
            : 'soft_budget_clipped'
          : 'full_demand_allocated',
    });
  }
  const totalAllocatedTokens = items.reduce(
    (total, item) => total + item.allocatedTokens,
    0,
  );
  return {
    version: 1,
    inputTokenLimit,
    reservedOutputTokens: Math.max(0, input.model.maxOutputTokens),
    totalAllocatedTokens,
    items,
    fingerprint: sha256Hex(JSON.stringify({ inputTokenLimit, items })),
  };
}

import type { WritingRequest } from '../contracts/writingSource';
import type { FrozenWritingContext } from '../contracts/frozenWritingContext';
import { collectWritingMaterials } from './collectWritingMaterials';
import { normalizeWritingMaterials } from './normalizeWritingMaterials';
import { buildWritingContextPlan } from './buildWritingContextPlan';
import { allocateWritingContextBudget } from './allocateWritingContextBudget';
import { renderWritingContext } from './renderWritingContext';
import { freezeWritingContext } from './freezeWritingContext';
import { buildWritingRequirements } from '../contracts/writingRequirement';
import { buildWritingStagePolicy } from '../contracts/writingPolicy';

/** Thin orchestration only: each context responsibility lives in one stage. */
export function buildFrozenWritingContext(
  request: WritingRequest,
): FrozenWritingContext {
  const collected = collectWritingMaterials(request);
  const normalized = normalizeWritingMaterials(collected);
  const plan = buildWritingContextPlan(normalized);
  const allocation = allocateWritingContextBudget({
    plan,
    model: request.model,
  });
  const rendered = renderWritingContext({
    candidates: normalized.candidates,
    allocation,
  });
  const requirements = buildWritingRequirements(request);
  const stagePolicy = buildWritingStagePolicy(request, requirements);
  return freezeWritingContext({
    request,
    candidates: normalized.candidates,
    plan,
    allocation,
    rendered,
    requirements,
    stagePolicy,
  });
}

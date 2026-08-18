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
import { recordPendingContextBuildTimings } from '../observability/writingObservabilityCollector';

/** Thin orchestration only: each context responsibility lives in one stage. */
export function buildFrozenWritingContext(
  request: WritingRequest,
): FrozenWritingContext {
  const startedAt = Date.now();
  let mark = startedAt;
  const collected = collectWritingMaterials(request);
  const collectMs = Date.now() - mark;
  mark = Date.now();
  const normalized = normalizeWritingMaterials(collected);
  const normalizeMs = Date.now() - mark;
  mark = Date.now();
  const plan = buildWritingContextPlan(normalized);
  const planMs = Date.now() - mark;
  mark = Date.now();
  const allocation = allocateWritingContextBudget({
    plan,
    model: request.model,
  });
  const allocateMs = Date.now() - mark;
  mark = Date.now();
  const rendered = renderWritingContext({
    candidates: normalized.candidates,
    allocation,
  });
  const renderMs = Date.now() - mark;
  const requirements = buildWritingRequirements(request);
  const stagePolicy = buildWritingStagePolicy(request, requirements);
  mark = Date.now();
  const frozen = freezeWritingContext({
    request,
    candidates: normalized.candidates,
    plan,
    allocation,
    rendered,
    requirements,
    stagePolicy,
  });
  const freezeMs = Date.now() - mark;
  recordPendingContextBuildTimings(request.generationTraceId, {
    contextBuildMs: Date.now() - startedAt,
    freezeMs,
    collectMs,
    normalizeMs,
    planMs,
    allocateMs,
    renderMs,
  });
  return frozen;
}

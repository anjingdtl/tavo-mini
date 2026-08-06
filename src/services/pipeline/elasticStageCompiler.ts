/**
 * Unified elastic stage request compiler (Phase 2).
 *
 * One compiler for Review / Fact Check / Proof / Repair / Draft-adjacent
 * stages. Callers hand in mandatory modules (never clipped) and elastic
 * modules (participate in the 80% soft pool / 95% burst band), plus a
 * messages builder that re-assembles ChatMessage[] from the final clipped
 * texts.
 *
 * Guarantees (mirror the allocator invariants):
 *   - ReadyStageRequest gate is preserved (model callers still use
 *     requireReadyStageRequest)
 *   - full outline / body / protocol / repair instructions are never clipped
 *   - final window overshoot shrinks optional modules only, rebuilding
 *     messages between passes
 *   - never drops an entire system/user message (rebuild is content-level)
 *   - Blocked ⇒ LLM call count is 0
 */
import type { ChatMessage } from '../llm';
import {
  allocateElasticStageContextBudget,
  type ElasticBudgetTrace,
  type ElasticContextDemand,
  type ElasticDemandRequirement,
} from './elasticBudgetAllocator';
import { deriveDefaultSafetyMargin } from './budgetAllocator';
import { estimateStageInputTokens } from '../pipelineMessages';
import { estimateTokens, clipTextToTokenBudget } from '../../utils/tokenEstimator';
import { pipelineError } from './errors';
import type {
  ContextAllocationTrace,
  StageCompileResult,
} from './compileStageRequest';
import type { PipelineError } from './types';

export interface ElasticStageModule {
  id: string;
  text: string;
  requirement: ElasticDemandRequirement;
  priority: number;
  relevance: number;
  minTokens?: number;
  targetTokens?: number;
  maxTokens?: number;
  reclaimable?: boolean;
  shrinkPriority?: number;
  burstPriority?: number;
}

export interface CompileWithElasticBudgetInput {
  stage: StageCompileResult['stage'];
  contextWindow: number;
  reservedOutputTokens: number;
  safetyMargin?: number;
  mandatoryModules: ElasticStageModule[];
  elasticModules: ElasticStageModule[];
  /** Rebuild messages from the final clipped module texts. */
  buildMessages: (clipped: ReadonlyMap<string, string>) => ChatMessage[];
}

const DEFAULT_MIN_RATIO = 0.1;
const MAX_SHRINK_PASSES = 3;

function classifyBlocking(
  stage: CompileWithElasticBudgetInput['stage'],
  message: string,
): PipelineError {
  const stageName =
    stage === 'review_repair'
      ? 'review'
      : stage === 'factCheck_repair'
        ? 'factCheck'
        : stage === 'draft_retry'
          ? 'draft'
          : (stage as string);
  return pipelineError('CONTEXT_WINDOW_EXCEEDED', message, {
    stage: stageName as any,
    userAction: 'none',
  });
}

export function compileStageRequestWithElasticBudget(
  input: CompileWithElasticBudgetInput,
): StageCompileResult {
  const contextWindow = Math.max(0, Number(input.contextWindow) || 0);
  const reservedOutputTokens = Math.max(
    0,
    Number(input.reservedOutputTokens) || 0,
  );
  const safetyMargin =
    input.safetyMargin != null
      ? Math.max(0, Number(input.safetyMargin) || 0)
      : deriveDefaultSafetyMargin(contextWindow);

  const toDemand = (m: ElasticStageModule): ElasticContextDemand => {
    const availableTokens = Math.max(0, estimateTokens(m.text));
    const maxTokens = Math.max(0, m.maxTokens ?? availableTokens);
    return {
      id: m.id,
      availableTokens,
      minTokens: Math.min(Math.max(0, m.minTokens ?? Math.floor(maxTokens * DEFAULT_MIN_RATIO)), maxTokens),
      targetTokens: Math.min(Math.max(0, m.targetTokens ?? availableTokens), maxTokens),
      maxTokens,
      priority: Math.max(0, m.priority),
      relevance: Math.min(1, Math.max(0, m.relevance)),
      requirement: m.requirement,
      reclaimable: m.reclaimable ?? m.requirement !== 'mandatory',
      shrinkPriority: m.shrinkPriority ?? 0,
      burstPriority: m.burstPriority ?? 0,
    };
  };

  const demands = [
    ...input.mandatoryModules.map(toDemand),
    ...input.elasticModules.map(toDemand),
  ];

  const result = allocateElasticStageContextBudget({
    contextWindow,
    reservedOutputTokens,
    safetyMargin,
    demands,
  });

  const trace = result.trace;

  // --- Blocked paths (LLM call count stays 0) ------------------------------
  if (!result.ok) {
    const message =
      result.reason === 'mandatory_overflow'
        ? '完整大纲与阶段必需正文无法放入模型窗口（弹性预算硬上限）'
        : '模型上下文容量无效，无法编译阶段请求';
    return {
      ready: false,
      stage: input.stage,
      error: classifyBlocking(input.stage, message),
      diagnostics: {
        contextWindow,
        reservedOutputTokens,
        safetyMargin,
        estimatedInputTokens: trace.finalEstimatedInputTokens,
        fullOutlineTokens: trace.mandatoryTokens,
        mandatoryBodyTokens: 0,
        fixedMessagesTokens: 0,
        remainingForOptional: trace.softPoolTotal,
        blockingReason: 'outline_or_body',
      },
      allocations: traceToAllocations(trace),
      elasticBudgetTrace: trace,
      estimatedInputTokens: trace.finalEstimatedInputTokens,
    };
  }

  // --- Build messages from final allocations -------------------------------
  const clipped = new Map<string, string>();
  for (const m of [...input.mandatoryModules, ...input.elasticModules]) {
    const allocated = result.allocations.get(m.id) || 0;
    if (m.requirement === 'mandatory') {
      // Mandatory text is verbatim — never clipped.
      clipped.set(m.id, m.text);
    } else if (allocated <= 0 || !m.text) {
      clipped.set(m.id, '');
    } else {
      clipped.set(m.id, clipTextToTokenBudget(m.text, allocated));
    }
  }

  let messages = input.buildMessages(clipped);
  let estimatedInputTokens = estimateStageInputTokens(messages);

  // --- Final window shrink: optional-only, rebuild between passes ----------
  // The allocator keeps allocations ≤95%; only wrapping overhead can push
  // past the hard limit. Reclaim from optional modules by shrinkPriority
  // (lowest first), then rebuild messages.
  const hardInputLimit = trace.hardInputLimit;
  const optionalDemands = demands.filter(
    d => d.requirement !== 'mandatory' && d.availableTokens > 0,
  );
  for (let pass = 0; pass < MAX_SHRINK_PASSES; pass += 1) {
    if (estimatedInputTokens <= hardInputLimit) break;
    const overshoot = estimatedInputTokens - hardInputLimit;
    const changed = shrinkOptionalDemands(
      result.allocations,
      optionalDemands,
      overshoot + 32,
    );
    if (!changed) break;
    for (const m of [...input.mandatoryModules, ...input.elasticModules]) {
      const allocated = result.allocations.get(m.id) || 0;
      clipped.set(
        m.id,
        m.requirement === 'mandatory' || allocated <= 0 || !m.text
          ? m.requirement === 'mandatory'
            ? m.text
            : ''
          : clipTextToTokenBudget(m.text, allocated),
      );
    }
    messages = input.buildMessages(clipped);
    estimatedInputTokens = estimateStageInputTokens(messages);
  }

  if (estimatedInputTokens > hardInputLimit) {
    return {
      ready: false,
      stage: input.stage,
      error: classifyBlocking(input.stage, '阶段请求超出模型上下文窗口（弹性预算最终窗口检查）'),
      diagnostics: {
        contextWindow,
        reservedOutputTokens,
        safetyMargin,
        estimatedInputTokens,
        fullOutlineTokens: trace.mandatoryTokens,
        mandatoryBodyTokens: 0,
        fixedMessagesTokens: 0,
        remainingForOptional: trace.softPoolTotal,
        blockingReason: 'final_window',
      },
      allocations: traceToAllocations(trace),
      elasticBudgetTrace: trace,
      messages,
      estimatedInputTokens,
    };
  }

  return {
    ready: true,
    stage: input.stage,
    messages,
    estimatedInputTokens,
    reservedOutputTokens,
    safetyMargin,
    contextWindow,
    allocations: traceToAllocations(trace),
    elasticBudgetTrace: trace,
  };
}

function traceToAllocations(trace: ElasticBudgetTrace): ContextAllocationTrace[] {
  return trace.modules.map(m => ({
    id: m.id,
    requested: m.availableTokens,
    allocated: m.finalAllocatedTokens,
    truncated: m.finalAllocatedTokens < m.availableTokens,
  }));
}

/** Reclaim optional allocations (mutates the map) until `reductionTokens` recovered. */
function shrinkOptionalDemands(
  allocations: ReadonlyMap<string, number>,
  optionalDemands: ElasticContextDemand[],
  reductionTokens: number,
): boolean {
  const mutable = allocations as Map<string, number>;
  let remaining = Math.ceil(reductionTokens);
  let changed = false;
  // Lowest shrinkPriority first (kept longest); tie-break by id for determinism.
  const order = [...optionalDemands].sort(
    (a, b) =>
      (a.shrinkPriority ?? 0) - (b.shrinkPriority ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const d of order) {
    if (remaining <= 0) break;
    const current = mutable.get(d.id) || 0;
    if (current <= 0) continue;
    const reclaim = Math.min(current, remaining);
    mutable.set(d.id, current - reclaim);
    remaining -= reclaim;
    changed = true;
  }
  return changed;
}

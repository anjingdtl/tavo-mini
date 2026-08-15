/**
 * Generation Trace runtime helpers (Stability Plan Phase 1 — Trace First).
 *
 * Phase 1 deliberately does NOT change generation semantics: it only mints a
 * stable generationTraceId per generation, persists it inside the frozen
 * pipeline task context envelope, and provides a pure summary derivation
 * used by tests / replay / future debug exports.
 */
import type { PipelineStageAttemptRow } from '../../data/repositories/pipelineStageAttemptRepository';
import type { ParsedPipelineTaskContext } from '../pipelineTaskContext';
import type {
  GenerationDiagnostic,
  GenerationOverallStatus,
  GenerationTraceBudgetSummary,
  GenerationTraceBudgetSummaryV2,
  GenerationTraceCandidateFailureReason,
  GenerationTraceCandidateV2,
  GenerationTraceModuleV2,
  GenerationTraceSummary,
  GenerationTraceSummaryV2,
} from '../../types/generationTrace';
import type { FrozenGenerationContextContractV2 } from '../context/generation/generationContracts';

const TRACE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomTraceSegment(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += TRACE_ID_ALPHABET[Math.floor(Math.random() * TRACE_ID_ALPHABET.length)];
  }
  return out;
}

/**
 * Stable-format generation trace id: `gt-<base36 ms>-<random>`.
 * Unique per generation attempt; persisted in the frozen envelope so resume
 * keeps the identity instead of minting a second one.
 */
export function createGenerationTraceId(now: number = Date.now()): string {
  return `gt-${now.toString(36)}-${randomTraceSegment(8)}`;
}

export function isValidGenerationTraceId(id: unknown): id is string {
  return typeof id === 'string' && /^gt-[a-z0-9]+-[a-z0-9]{8}$/.test(id);
}

/** Plan §9 — overall status from the diagnostic set (pure). */
export function deriveOverallStatus(
  diagnostics: GenerationDiagnostic[],
): GenerationOverallStatus {
  let hasDegradation = false;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'blocking') return 'BLOCKED';
    if (diagnostic.severity === 'error' || diagnostic.severity === 'warning') {
      hasDegradation = true;
    }
  }
  return hasDegradation ? 'DEGRADED' : 'OK';
}

interface DraftAttemptBudgetTrace {
  hardInputLimit?: unknown;
  softInputLimit?: unknown;
  burstInputLimit?: unknown;
  finalEstimatedInputTokens?: unknown;
}

function extractBudgetFromAllocationTrace(
  allocationTraceJson: string | null | undefined,
): Partial<GenerationTraceBudgetSummary> {
  if (!allocationTraceJson) return {};
  try {
    const raw = JSON.parse(allocationTraceJson) as DraftAttemptBudgetTrace;
    const toNumber = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;
    return {
      hardInputLimit: toNumber(raw.hardInputLimit),
      softInputLimit: toNumber(raw.softInputLimit),
      burstInputLimit: toNumber(raw.burstInputLimit),
      finalEstimatedInputTokens: toNumber(raw.finalEstimatedInputTokens),
    };
  } catch {
    return {};
  }
}

function finiteOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function countFrozenCandidates(
  parsed: ParsedPipelineTaskContext | null,
): { candidateCount: number; selectedCount: null } | null {
  const pool = parsed?.frozenAuditCandidates;
  if (!pool) return null;
  // The audit pool freezes every candidate WITHOUT a selection flag
  // (selection happens later, inside audit re-scoring). selectedCount stays
  // null until the candidate contract carries explicit selection state
  // (Stability Plan §3 FrozenContextCandidate).
  return {
    candidateCount:
      pool.episodicCandidates.length +
      pool.characterCandidates.length +
      pool.worldbookCandidates.length,
    selectedCount: null,
  };
}

export interface BuildGenerationTraceSummaryInput {
  pipelineTaskId: string;
  parsed: ParsedPipelineTaskContext | null;
  attempts: PipelineStageAttemptRow[];
  diagnostics?: GenerationDiagnostic[];
}

function nonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function buildDecisionTraceV2(input: {
  pipelineTaskId: string;
  parsed: ParsedPipelineTaskContext;
  attempts: PipelineStageAttemptRow[];
  diagnostics: GenerationDiagnostic[];
  contract: FrozenGenerationContextContractV2;
  budget: GenerationTraceBudgetSummary;
  writingMode: string | null;
  outlineWorkflowVersion: number | null;
  contextBudgetVersion: number | null;
  modelId: string | null;
  contextWindow: number | null;
  reservedOutputTokens: number | null;
  safetyMargin: number | null;
}): GenerationTraceSummaryV2 {
  const budgetById = new Map(
    input.contract.budget.map(item => [item.candidateId, item]),
  );
  const renderedById = new Map(
    input.contract.rendered.map(item => [item.candidateId, item]),
  );
  const candidates: GenerationTraceCandidateV2[] = input.contract.candidates.map(
    candidate => {
      const budget = budgetById.get(candidate.candidateId);
      const rendered = renderedById.get(candidate.candidateId);
      const allocatedTokens = nonNegative(budget?.allocatedTokens);
      const actualTokens = nonNegative(rendered?.actualTokens);
      const included = Boolean(rendered?.included);
      const clipped = Boolean(
        budget?.budgetClipped || budget?.clippedByBudget || rendered?.clipped,
      );
      let failureReason: GenerationTraceCandidateFailureReason | null = null;
      let reason = candidate.selectedReason || 'selected';
      if (!candidate.selected) {
        failureReason =
          candidate.rejectedReason === 'not_activated'
            ? 'not_activated'
            : 'not_selected';
        reason = candidate.rejectedReason || failureReason;
      } else if (!budget) {
        failureReason = 'snapshot_missing';
        reason = failureReason;
      } else if (allocatedTokens <= 0) {
        failureReason = 'budget_zero';
        reason = budget.allocationReason || failureReason;
      } else if (!rendered) {
        failureReason = 'snapshot_missing';
        reason = failureReason;
      } else if (!included || actualTokens <= 0) {
        failureReason = 'render_zero';
        reason = rendered.clippingReason || failureReason;
      } else {
        reason = 'included';
      }
      return {
        candidateId: candidate.candidateId,
        sourceType: candidate.sourceType,
        selected: candidate.selected,
        reason,
        failureReason,
        demandTokens: nonNegative(candidate.demandTokens),
        allocatedTokens,
        actualTokens,
        included,
        clipped,
        clippingReason: rendered?.clippingReason ?? null,
        allocationReason: budget?.allocationReason ?? null,
      };
    },
  );
  const candidateSummary = {
    total: candidates.length,
    selected: candidates.filter(candidate => candidate.selected).length,
    rejected: candidates.filter(candidate => !candidate.selected).length,
    included: candidates.filter(candidate => candidate.included).length,
    clipped: candidates.filter(candidate => candidate.clipped).length,
  };
  const moduleMap = new Map<string, GenerationTraceModuleV2>();
  for (const candidate of candidates) {
    const current = moduleMap.get(candidate.sourceType) || {
      module: candidate.sourceType,
      sourceType: candidate.sourceType,
      candidateCount: 0,
      selectedCount: 0,
      demandTokens: 0,
      allocatedTokens: 0,
      actualTokens: 0,
      includedCount: 0,
      clippedCount: 0,
    };
    current.candidateCount += 1;
    current.selectedCount += candidate.selected ? 1 : 0;
    current.demandTokens += candidate.demandTokens;
    current.allocatedTokens += candidate.allocatedTokens;
    current.actualTokens += candidate.actualTokens;
    current.includedCount += candidate.included ? 1 : 0;
    current.clippedCount += candidate.clipped ? 1 : 0;
    moduleMap.set(candidate.sourceType, current);
  }
  const budgetSummary: GenerationTraceBudgetSummaryV2 = {
    ...input.budget,
    totalDemandTokens: input.contract.budget.reduce(
      (sum, item) => sum + nonNegative(item.demandTokens),
      0,
    ),
    totalAllocatedTokens: input.contract.budget.reduce(
      (sum, item) => sum + nonNegative(item.allocatedTokens),
      0,
    ),
    totalActualTokens: input.contract.rendered.reduce(
      (sum, item) => sum + nonNegative(item.actualTokens),
      0,
    ),
    budgetClippedCount: input.contract.budget.filter(
      item => item.budgetClipped || item.clippedByBudget,
    ).length,
  };
  return {
    version: 2,
    generationTraceId: input.parsed.trace?.generationTraceId ?? null,
    pipelineTaskId: input.pipelineTaskId,
    identity: {
      projectId: finiteOrNull(input.parsed.draftContext.projectId),
      chapterId: finiteOrNull(input.parsed.draftContext.chapterId),
      writingMode: input.writingMode,
      outlineWorkflowVersion: input.outlineWorkflowVersion,
      contextBudgetVersion: input.contextBudgetVersion,
    },
    projectId: finiteOrNull(input.parsed.draftContext.projectId),
    chapterId: finiteOrNull(input.parsed.draftContext.chapterId),
    writingMode: input.writingMode,
    outlineWorkflowVersion: input.outlineWorkflowVersion,
    contextBudgetVersion: input.contextBudgetVersion,
    modelId: input.modelId,
    contextWindow: input.contextWindow,
    reservedOutputTokens: input.reservedOutputTokens,
    safetyMargin: input.safetyMargin,
    settings: {
      modelId: input.modelId,
      contextWindow: input.contextWindow,
      reservedOutputTokens: input.reservedOutputTokens,
      safetyMargin: input.safetyMargin,
    },
    candidateCount: candidateSummary.total,
    selectedCount: candidateSummary.selected,
    candidateSummary,
    budget: budgetSummary,
    budgetSummary,
    candidates,
    modules: [...moduleMap.values()],
    diagnostics: input.diagnostics,
    stageTimings: (input.parsed.draftContext.stageTimings || []).map(timing => ({
      stage: timing.stage,
      durationMs: timing.durationMs,
      ...(timing.note ? { note: timing.note } : {}),
    })),
    attemptCount: input.attempts.length,
    overallStatus: deriveOverallStatus(input.diagnostics),
  };
}

/**
 * Plan §6 — derive the minimal generation trace summary purely from
 * persisted state (envelope + attempt rows). Unknown fields stay null:
 * the summary never guesses.
 */
export function buildGenerationTraceSummary(
  input: BuildGenerationTraceSummaryInput,
): GenerationTraceSummary {
  const { parsed } = input;
  const execution = parsed?.execution ?? null;
  const frozenRequest = parsed?.frozenDraftRequest ?? null;
  const draftAttempt =
    input.attempts.find(a => a.stage === 'draft' && a.status === 'succeeded') ??
    input.attempts.find(a => a.stage === 'draft') ??
    null;
  const budgetFromTrace = extractBudgetFromAllocationTrace(
    draftAttempt?.allocationTraceJson,
  );
  const counts = countFrozenCandidates(parsed ?? null);
  const diagnostics = input.diagnostics ?? [];

  const writingMode = execution
    ? `outline:owv${execution.outlineWorkflowVersion ?? 1}/cbv${
        execution.contextBudgetVersion ?? 1
      }`
    : null;
  const outlineWorkflowVersion = finiteOrNull(execution?.outlineWorkflowVersion);
  const contextBudgetVersion = finiteOrNull(execution?.contextBudgetVersion);
  const modelId = execution?.model?.modelName ?? null;
  const contextWindow = finiteOrNull(
    frozenRequest?.contextWindow ?? execution?.model?.contextWindow,
  );
  const reservedOutputTokens = finiteOrNull(
    frozenRequest?.reservedOutputTokens ?? execution?.draftMaxTokens,
  );
  const safetyMargin = finiteOrNull(frozenRequest?.safetyMargin);
  const budget: GenerationTraceBudgetSummary = {
    hardInputLimit: budgetFromTrace.hardInputLimit ?? null,
    softInputLimit: budgetFromTrace.softInputLimit ?? null,
    burstInputLimit: budgetFromTrace.burstInputLimit ?? null,
    finalEstimatedInputTokens:
      budgetFromTrace.finalEstimatedInputTokens ??
      finiteOrNull(frozenRequest?.estimatedInputTokens),
  };
  if (parsed?.draftContext.generationContract) {
    return buildDecisionTraceV2({
      pipelineTaskId: input.pipelineTaskId,
      parsed,
      attempts: input.attempts,
      diagnostics,
      contract: parsed.draftContext.generationContract,
      budget,
      writingMode,
      outlineWorkflowVersion,
      contextBudgetVersion,
      modelId,
      contextWindow,
      reservedOutputTokens,
      safetyMargin,
    });
  }

  return {
    version: 1,
    generationTraceId: parsed?.trace?.generationTraceId ?? null,
    pipelineTaskId: input.pipelineTaskId,
    projectId: finiteOrNull(parsed?.draftContext?.projectId),
    chapterId: finiteOrNull(parsed?.draftContext?.chapterId),
    writingMode,
    outlineWorkflowVersion,
    contextBudgetVersion,
    modelId,
    contextWindow,
    reservedOutputTokens,
    safetyMargin,
    candidateCount: counts?.candidateCount ?? null,
    selectedCount: counts?.selectedCount ?? null,
    budget,
    attemptCount: input.attempts.length,
    overallStatus: deriveOverallStatus(diagnostics),
    diagnostics,
  };
}

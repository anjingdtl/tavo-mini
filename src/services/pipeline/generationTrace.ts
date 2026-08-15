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
  GenerationTraceSummaryV1,
} from '../../types/generationTrace';

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

/**
 * Plan §6 — derive the minimal generation trace summary purely from
 * persisted state (envelope + attempt rows). Unknown fields stay null:
 * the summary never guesses.
 */
export function buildGenerationTraceSummary(
  input: BuildGenerationTraceSummaryInput,
): GenerationTraceSummaryV1 {
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

  return {
    version: 1,
    generationTraceId: parsed?.trace?.generationTraceId ?? null,
    pipelineTaskId: input.pipelineTaskId,
    projectId: finiteOrNull(parsed?.draftContext?.projectId),
    chapterId: finiteOrNull(parsed?.draftContext?.chapterId),
    writingMode: execution
      ? `outline:owv${execution.outlineWorkflowVersion ?? 1}/cbv${
          execution.contextBudgetVersion ?? 1
        }`
      : null,
    outlineWorkflowVersion: finiteOrNull(execution?.outlineWorkflowVersion),
    contextBudgetVersion: finiteOrNull(execution?.contextBudgetVersion),
    modelId: execution?.model?.modelName ?? null,
    contextWindow: finiteOrNull(
      frozenRequest?.contextWindow ?? execution?.model?.contextWindow,
    ),
    reservedOutputTokens: finiteOrNull(
      frozenRequest?.reservedOutputTokens ?? execution?.draftMaxTokens,
    ),
    safetyMargin: finiteOrNull(frozenRequest?.safetyMargin),
    candidateCount: counts?.candidateCount ?? null,
    selectedCount: counts?.selectedCount ?? null,
    budget: {
      hardInputLimit: budgetFromTrace.hardInputLimit ?? null,
      softInputLimit: budgetFromTrace.softInputLimit ?? null,
      burstInputLimit: budgetFromTrace.burstInputLimit ?? null,
      finalEstimatedInputTokens:
        budgetFromTrace.finalEstimatedInputTokens ??
        finiteOrNull(frozenRequest?.estimatedInputTokens),
    },
    attemptCount: input.attempts.length,
    overallStatus: deriveOverallStatus(diagnostics),
    diagnostics,
  };
}

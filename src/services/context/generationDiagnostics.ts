/**
 * Generation diagnostic collector (Stability Plan §9 — Phase 5).
 *
 * Silent degradations that change generation semantics (resources lost,
 * demand probe failures, note retrieval failures, …) must leave structured
 * state. The collector is a tiny in-memory sink: builders keep their
 * existing fallback BEHAVIOR (degraded, not blocked) but every semantic
 * fallback now records a GenerationDiagnostic that is frozen into the
 * pipeline context snapshot and surfaced by the trace summary.
 */
import type {
  GenerationDiagnostic,
  GenerationOverallStatus,
} from '../../types/generationTrace';
import { deriveOverallStatus } from '../pipeline/generationTrace';

export interface GenerationDiagnosticCollector {
  push(diagnostic: GenerationDiagnostic): void;
  list(): GenerationDiagnostic[];
  overall(): GenerationOverallStatus;
}

export function createGenerationDiagnosticCollector(): GenerationDiagnosticCollector {
  const diagnostics: GenerationDiagnostic[] = [];
  return {
    push(diagnostic) {
      diagnostics.push(diagnostic);
    },
    list() {
      return [...diagnostics];
    },
    overall() {
      return deriveOverallStatus(diagnostics);
    },
  };
}

/** Guard for optional diagnostic callbacks threaded into helpers. */
export type DiagnosticSink = ((diagnostic: GenerationDiagnostic) => void) | undefined;

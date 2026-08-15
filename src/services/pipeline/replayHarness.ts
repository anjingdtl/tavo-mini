/**
 * Generation Replay Harness (Stability Plan §7 / Phase 6).
 *
 * Given a persisted pipeline task context (the frozen envelope), the harness
 * replays every DETERMINISTIC derivation and proves stability:
 *
 *   - envelope parse (byte hash + semantic fingerprint verification)
 *   - FrozenGenerationContext derivation (identity / digests / settings)
 *   - generationFingerprint recomputation — must equal the stored value
 *   - frozenDraftRequest fingerprint recomputation from messages — must
 *     equal the value frozen at task start
 *
 * The LLM is never required: replay works purely from persisted state, so a
 * production trace exported from a device reproduces deterministically in
 * CI. Phase 6 gate: the same fixture replayed 10 times yields identical
 * fingerprints every time.
 */
import {
  parsePersistedPipelineTaskContext,
  computeFrozenDraftRequestFingerprint,
} from '../pipelineTaskContext';
import {
  deriveFrozenGenerationContext,
  computeGenerationFingerprint,
  buildGenerationFingerprintInput,
} from './frozenGenerationContext';
import type { GenerationDiagnostic } from '../../types/generationTrace';

export interface ReplayHarnessInput {
  pipelineContextJson: string;
  pipelineContextVersion?: number | null;
  pipelineContextHash?: string | null;
  /** Ownership pins (project/chapter) for strict parse, when known. */
  expectedProjectId?: number;
  expectedChapterId?: number;
}

export interface ReplayCheckResult {
  name: string;
  passed: boolean;
  expected?: string;
  actual?: string;
}

export interface ReplayResult {
  ok: boolean;
  /** Parse succeeded and all checks below ran. */
  parsed: boolean;
  checks: ReplayCheckResult[];
  generationTraceId: string | null;
  generationFingerprint: string | null;
  diagnostics: GenerationDiagnostic[];
  poolCaptureWarnings: string[];
}

/**
 * Replay a frozen generation envelope once, verifying every deterministic
 * invariant. Throws nothing — failures come back as failed checks so callers
 * (tests, debug tooling) can report precisely what drifted.
 */
export function replayFrozenGeneration(
  input: ReplayHarnessInput,
): ReplayResult {
  const checks: ReplayCheckResult[] = [];
  let generationTraceId: string | null = null;
  let generationFingerprint: string | null = null;
  let diagnostics: GenerationDiagnostic[] = [];
  let poolCaptureWarnings: string[] = [];

  let parsed;
  try {
    parsed = parsePersistedPipelineTaskContext(
      {
        pipelineContextJson: input.pipelineContextJson,
        pipelineContextVersion: input.pipelineContextVersion,
        pipelineContextHash: input.pipelineContextHash,
      },
      {
        expectedProjectId: input.expectedProjectId,
        expectedChapterId: input.expectedChapterId,
      },
    );
  } catch (error) {
    const err = error as Error & { code?: string };
    // The semantic fingerprint check itself runs inside parse (fail-closed);
    // classify it so replay reports drift with its real name.
    const isFingerprintMismatch = err.code === 'SNAPSHOT_FINGERPRINT_MISMATCH';
    return {
      ok: false,
      parsed: false,
      checks: [
        {
          name: isFingerprintMismatch
            ? 'generation_fingerprint_matches_stored'
            : 'envelope_parse',
          passed: false,
          actual: err.message,
        },
      ],
      generationTraceId: null,
      generationFingerprint: null,
      diagnostics: [],
      poolCaptureWarnings: [],
    };
  }

  checks.push({ name: 'envelope_parse', passed: true });
  generationTraceId = parsed.trace?.generationTraceId ?? null;
  diagnostics = parsed.draftContext.stabilityDiagnostics ?? [];
  poolCaptureWarnings = parsed.frozenAuditCandidates?.captureWarnings ?? [];

  const view = deriveFrozenGenerationContext({
    pipelineTaskId: 'replay',
    parsed,
  });

  if (view) {
    generationFingerprint = view.computedGenerationFingerprint;
    checks.push({
      name: 'generation_fingerprint_matches_stored',
      passed:
        view.storedGenerationFingerprint == null ||
        view.storedGenerationFingerprint === view.computedGenerationFingerprint,
      expected: view.storedGenerationFingerprint ?? undefined,
      actual: view.computedGenerationFingerprint,
    });
  }

  if (parsed.frozenDraftRequest) {
    const recomputed = computeFrozenDraftRequestFingerprint(
      parsed.frozenDraftRequest.messages,
      {
        estimatedInputTokens: parsed.frozenDraftRequest.estimatedInputTokens,
        reservedOutputTokens: parsed.frozenDraftRequest.reservedOutputTokens,
        safetyMargin: parsed.frozenDraftRequest.safetyMargin,
        contextWindow: parsed.frozenDraftRequest.contextWindow,
      },
    );
    checks.push({
      name: 'frozen_draft_request_fingerprint_replay',
      passed: recomputed === parsed.frozenDraftRequest.requestFingerprint,
      expected: parsed.frozenDraftRequest.requestFingerprint,
      actual: recomputed,
    });
  }

  return {
    ok: checks.every(check => check.passed),
    parsed: true,
    checks,
    generationTraceId,
    generationFingerprint,
    diagnostics,
    poolCaptureWarnings,
  };
}

export interface ReplayDeterminismResult {
  iterations: number;
  allIdentical: boolean;
  fingerprints: string[];
}

/**
 * Phase 6 gate: replay the same fixture N times — every iteration must
 * produce the identical semantic fingerprint (same input → same output).
 */
export function replayDeterminism(
  input: ReplayHarnessInput,
  iterations = 10,
): ReplayDeterminismResult {
  const fingerprints: string[] = [];
  for (let i = 0; i < iterations; i++) {
    const parsed = parsePersistedPipelineTaskContext(input);
    const view = deriveFrozenGenerationContext({
      pipelineTaskId: 'replay',
      parsed,
    });
    if (!view) {
      return { iterations: i + 1, allIdentical: false, fingerprints };
    }
    fingerprints.push(view.computedGenerationFingerprint);
  }
  const allIdentical = fingerprints.every(fp => fp === fingerprints[0]);
  return { iterations, allIdentical, fingerprints };
}

/**
 * Cross-derivation consistency used by golden journeys: rebuilding the
 * fingerprint input from the PARSED envelope must reproduce the exact
 * fingerprint the serializer embedded at freeze time.
 */
export function replayFingerprintFromParsed(parsedInput: {
  draftContext: Parameters<typeof buildGenerationFingerprintInput>[0];
  execution: Parameters<typeof buildGenerationFingerprintInput>[1];
  frozenDraftRequest: Parameters<typeof buildGenerationFingerprintInput>[2];
  expectedFingerprint: string;
}): boolean {
  return (
    computeGenerationFingerprint(
      buildGenerationFingerprintInput(
        parsedInput.draftContext,
        parsedInput.execution,
        parsedInput.frozenDraftRequest,
      ),
    ) === parsedInput.expectedFingerprint
  );
}

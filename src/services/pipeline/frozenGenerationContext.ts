/**
 * FrozenGenerationContext V1 (Stability Plan §3 / §12 / Phase 2).
 *
 * A versioned, derivable projection of the persisted pipeline task context
 * envelope. It does NOT replace the envelope — it is the single explained
 * VIEW over it (identity / sources / settings / rendered digests), plus the
 * deterministic `generationFingerprint` that answers §12:
 *
 *   same chapter identity + same sources + same settings + same rendered
 *   context  →  same fingerprint. Any semantic drift changes it.
 *
 * The fingerprint deliberately EXCLUDES volatile metadata (createdAt, trace
 * id, post-draft audit context, draftCompletedAt) so that:
 *   - re-serialization after draft completion reproduces it byte-identically;
 *   - resume / replay can prove "same inputs" without false mismatches.
 */
import type { ParsedPipelineTaskContext } from '../pipelineTaskContext';
import type { PipelineContextSnapshot } from '../../types/pipelineContext';
import type { PipelineExecutionSnapshot } from '../../types/pipelineExecution';
import type { FrozenDraftRequest } from '../../types/pipelineFrozen';
import { sha256Hex } from '../continuation/hashUtils';

export const FROZEN_GENERATION_CONTEXT_VERSION = 1 as const;

function hashText(text: string | null | undefined): string {
  return sha256Hex(String(text ?? ''));
}

function hashJson(value: unknown): string {
  return sha256Hex(JSON.stringify(value ?? null));
}

/** Semantic sections of the rendered context, hashed individually. */
export interface FrozenRenderedSectionDigest {
  presetText: string;
  storyMemoryText: string;
  characterText: string;
  noteText: string;
  worldbookText: string;
  episodicMemoryText: string;
  recentBridgeText: string;
  currentInstructionText: string;
  retrievalUserPrompt: string;
  outlineText: string;
  immediatePreviousChapterText: string | null;
}

/** Canonical fingerprint input — semantic content ONLY (see header). */
export interface GenerationFingerprintInputV1 {
  v: 1;
  identity: {
    projectId: number | null;
    chapterId: number | null;
    chapterUpdatedAt: string;
    outlineWorkflowVersion: number;
    contextBudgetVersion: number;
    pipelineMode: string;
  };
  sources: {
    outlineFingerprint: string;
    sections: FrozenRenderedSectionDigest;
    writerStyle: string | null;
  };
  settings: {
    modelId: string;
    contextWindow: number;
    draftMaxTokens: number;
    reviewMaxTokens: number;
    factCheckMaxTokens: number;
    proofMaxTokens: number;
    draftPresetId: number | null;
    reviewPresetId: number | null;
    factCheckPresetId: number | null;
    proofPresetId: number | null;
  };
  policy: {
    contextAutomationPolicyHash: string | null;
  };
  request: {
    requestFingerprint: string;
    estimatedInputTokens: number;
    reservedOutputTokens: number;
    safetyMargin: number;
    contextWindow: number;
  } | null;
}

/**
 * Build the canonical fingerprint input from typed envelope values.
 * Used by BOTH serialize (embed) and parse (verify) so the two sides can
 * never disagree about what the fingerprint covers.
 */
export function buildGenerationFingerprintInput(
  draftContext: PipelineContextSnapshot,
  execution: PipelineExecutionSnapshot,
  frozenDraftRequest: FrozenDraftRequest | null | undefined,
): GenerationFingerprintInputV1 {
  return {
    v: 1,
    identity: {
      projectId:
        draftContext.projectId != null && Number.isFinite(draftContext.projectId)
          ? draftContext.projectId
          : null,
      chapterId:
        draftContext.chapterId != null && Number.isFinite(draftContext.chapterId)
          ? draftContext.chapterId
          : null,
      chapterUpdatedAt: String(draftContext.chapterUpdatedAt ?? ''),
      outlineWorkflowVersion: Number(execution.outlineWorkflowVersion ?? 1),
      contextBudgetVersion: Number(execution.contextBudgetVersion ?? 1),
      pipelineMode: String(execution.pipelineMode ?? ''),
    },
    sources: {
      outlineFingerprint: String(draftContext.outlineFingerprint ?? ''),
      sections: {
        presetText: hashText(draftContext.presetText),
        storyMemoryText: hashText(draftContext.storyMemoryText),
        characterText: hashText(draftContext.characterText),
        noteText: hashText(draftContext.noteText),
        worldbookText: hashText(draftContext.worldbookText),
        episodicMemoryText: hashText(draftContext.episodicMemoryText),
        recentBridgeText: hashText(draftContext.recentBridgeText),
        currentInstructionText: hashText(draftContext.currentInstructionText),
        retrievalUserPrompt: hashText(draftContext.retrievalUserPrompt),
        outlineText: hashText(draftContext.outlineText),
        immediatePreviousChapterText:
          draftContext.immediatePreviousChapterText != null
            ? hashText(draftContext.immediatePreviousChapterText)
            : null,
      },
      writerStyle: execution.writerStyle
        ? hashJson(execution.writerStyle)
        : null,
    },
    settings: {
      modelId: String(execution.model?.modelName ?? ''),
      contextWindow: Number(execution.model?.contextWindow ?? 0),
      draftMaxTokens: Number(execution.draftMaxTokens ?? 0),
      reviewMaxTokens: Number(execution.reviewMaxTokens ?? 0),
      factCheckMaxTokens: Number(execution.factCheckMaxTokens ?? 0),
      proofMaxTokens: Number(execution.proofMaxTokens ?? 0),
      draftPresetId:
        execution.draftPresetId != null ? Number(execution.draftPresetId) : null,
      reviewPresetId:
        execution.reviewPresetId != null
          ? Number(execution.reviewPresetId)
          : null,
      factCheckPresetId:
        execution.factCheckPresetId != null
          ? Number(execution.factCheckPresetId)
          : null,
      proofPresetId:
        execution.proofPresetId != null
          ? Number(execution.proofPresetId)
          : null,
    },
    policy: {
      contextAutomationPolicyHash: execution.contextAutomationPolicyHash
        ? String(execution.contextAutomationPolicyHash)
        : null,
    },
    request: frozenDraftRequest
      ? {
          requestFingerprint: String(frozenDraftRequest.requestFingerprint ?? ''),
          estimatedInputTokens: Number(frozenDraftRequest.estimatedInputTokens ?? 0),
          reservedOutputTokens: Number(frozenDraftRequest.reservedOutputTokens ?? 0),
          safetyMargin: Number(frozenDraftRequest.safetyMargin ?? 0),
          contextWindow: Number(frozenDraftRequest.contextWindow ?? 0),
        }
      : null,
  };
}

/** Deterministic fingerprint over the canonical input (full sha256 hex). */
export function computeGenerationFingerprint(
  input: GenerationFingerprintInputV1,
): string {
  return sha256Hex(JSON.stringify(input));
}

/** Plan §3 — explained frozen generation view derived from the envelope. */
export interface FrozenGenerationContextV1 {
  version: typeof FROZEN_GENERATION_CONTEXT_VERSION;
  pipelineTaskId: string;
  generationTraceId: string | null;
  identity: GenerationFingerprintInputV1['identity'];
  sourceSnapshot: {
    outlineFingerprint: string;
    sectionDigests: FrozenRenderedSectionDigest;
    writerStyleFingerprint: string | null;
  };
  resolvedSettings: GenerationFingerprintInputV1['settings'];
  policy: GenerationFingerprintInputV1['policy'];
  request: GenerationFingerprintInputV1['request'];
  /** Stored fingerprint from the envelope, when present (Phase 2+ tasks). */
  storedGenerationFingerprint: string | null;
  /** Recomputed fingerprint over the parsed (typed) envelope content. */
  computedGenerationFingerprint: string;
}

/**
 * Derive the FrozenGenerationContext view from a parsed envelope.
 * Returns null for V1 bare snapshots (no execution snapshot — nothing
 * semantic was frozen in the modern sense).
 */
export function deriveFrozenGenerationContext(params: {
  pipelineTaskId: string;
  parsed: ParsedPipelineTaskContext | null;
}): FrozenGenerationContextV1 | null {
  const { parsed } = params;
  if (!parsed?.draftContext || !parsed.execution) return null;
  const input = buildGenerationFingerprintInput(
    parsed.draftContext,
    parsed.execution,
    parsed.frozenDraftRequest,
  );
  return {
    version: FROZEN_GENERATION_CONTEXT_VERSION,
    pipelineTaskId: params.pipelineTaskId,
    generationTraceId: parsed.trace?.generationTraceId ?? null,
    identity: input.identity,
    sourceSnapshot: {
      outlineFingerprint: input.sources.outlineFingerprint,
      sectionDigests: input.sources.sections,
      writerStyleFingerprint: input.sources.writerStyle,
    },
    resolvedSettings: input.settings,
    policy: input.policy,
    request: input.request,
    storedGenerationFingerprint: parsed.generationFingerprint ?? null,
    computedGenerationFingerprint: computeGenerationFingerprint(input),
  };
}

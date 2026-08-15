/**
 * Continuation → Generation Trace observability adapter (Phase II).
 *
 * This module is deliberately pure. It decorates the existing continuation
 * context trace and never changes the V4/V5 execution protocol, prompt
 * compiler, budget math, or adoption rules. The legacy trace fields stay at
 * the top level so existing result screens and historical runs remain
 * readable; the nested V2 envelope is the unified identity/evidence surface.
 */
import { v4 } from '../../uuidBridge';
import { sha256Hex } from '../hashUtils';
import type {
  ContinuationContextSnapshot,
  ContinuationContextSnapshotV3,
  ContinuationContextSnapshotV5,
  ContinuationContextTrace,
  ContinuationGenerationTraceEvent,
  ContinuationGenerationTraceEventName,
  ContinuationGenerationTraceV2,
  ContinuationRunState,
  ContinuationStageName,
} from './types';

type ContinuationTraceSnapshot =
  | ContinuationContextSnapshot
  | ContinuationContextSnapshotV3
  | ContinuationContextSnapshotV5;

export interface CreateContinuationGenerationTraceInput {
  snapshot: ContinuationTraceSnapshot;
  trace: ContinuationContextTrace;
  runId: string;
  generationTraceId?: string;
  batchTraceId?: string | null;
  chapterOrdinal?: number | null;
  chapterCount?: number | null;
  state: ContinuationRunState;
  stage?: ContinuationStageName | null;
}

export interface AppendContinuationGenerationTraceEventInput {
  event: ContinuationGenerationTraceEventName;
  state: ContinuationRunState;
  stage?: ContinuationStageName | null;
  at?: string;
  reason?: string | null;
  eligibility?: Partial<ContinuationGenerationTraceV2['eligibility']>;
  adoption?: Partial<ContinuationGenerationTraceV2['adoption']>;
  finalization?: Partial<ContinuationGenerationTraceV2['finalization']>;
}

export interface EnsureContinuationGenerationTraceOptions {
  runId: string;
  state: ContinuationRunState;
  stage?: ContinuationStageName | null;
}

function newGenerationTraceId(): string {
  return `gt_${v4().replace(/-/g, '')}`;
}

/** Stable fallback for pre-Phase-II rows. It is deterministic across cold
 * starts and therefore does not create a second identity on resume. */
function historicalGenerationTraceId(runId: string): string {
  return `gt_${sha256Hex(runId).slice(0, 32)}`;
}

export function createContinuationBatchTraceId(batchId: string): string {
  return `bt_${sha256Hex(batchId).slice(0, 32)}`;
}

function instructionFor(snapshot: ContinuationTraceSnapshot): string {
  return String(snapshot.bundles.userInstruction ?? '');
}

function stageConfigIds(
  snapshot: ContinuationTraceSnapshot,
): Record<string, number | null> {
  const resolved = snapshot.settingsSnapshot.resolvedModelConfigIds as Record<
    string,
    number | null | undefined
  >;
  const out: Record<string, number | null> = {};
  for (const [stage, configId] of Object.entries(resolved)) {
    out[stage] = configId == null ? null : Number(configId);
  }
  return out;
}

function stageModelNames(
  snapshot: ContinuationTraceSnapshot,
): Record<string, string | null> {
  const configs = (snapshot.settingsSnapshot.frozenModelConfigs ?? {}) as Record<
    string,
    { modelName?: string } | null | undefined
  >;
  const out: Record<string, string | null> = {};
  for (const stage of Object.keys(stageConfigIds(snapshot))) {
    out[stage] = configs[stage]?.modelName ?? null;
  }
  return out;
}

function chapterFingerprint(input: {
  snapshot: ContinuationTraceSnapshot;
  instructionHash: string;
  batchTraceId: string | null;
  chapterOrdinal: number | null;
}): string {
  // Only current-chapter frozen facts participate. In particular, no batch
  // planner envelope or sibling item is accepted here, which keeps future
  // source/plan material out of every child trace.
  return sha256Hex(
    [
      input.batchTraceId ?? '',
      input.chapterOrdinal ?? '',
      input.snapshot.projectId,
      input.snapshot.targetChapterId,
      input.snapshot.targetPosition,
      input.snapshot.source.sourceId,
      input.snapshot.source.sourceVersion,
      input.snapshot.source.normalizedSha256,
      input.snapshot.source.boundary?.chapterId ?? null,
      input.snapshot.source.boundary?.chapterPosition ?? null,
      input.snapshot.source.boundary?.charOffsetExclusive ?? null,
      input.snapshot.canon.snapshotId,
      input.snapshot.canon.revision,
      input.snapshot.storyMemory.stateFingerprint,
      input.snapshot.inputRevisionHash,
      input.instructionHash,
    ].join('\u001f'),
  ).slice(0, 32);
}

function buildGenerationTrace(
  input: CreateContinuationGenerationTraceInput,
): ContinuationGenerationTraceV2 {
  const snapshot = input.snapshot;
  const legacyTrace = input.trace;
  const batchTraceId = input.batchTraceId ?? null;
  const chapterOrdinal = input.chapterOrdinal ?? null;
  const chapterCount = input.chapterCount ?? null;
  const instruction = instructionFor(snapshot);
  const instructionHash = sha256Hex(instruction);
  const anchor = snapshot.primaryAnchor;
  const anchorKind =
    legacyTrace.primaryAnchorKind ?? anchor?.kind ?? 'legacy';
  const anchorChapterId =
    legacyTrace.primaryAnchorChapterId ?? anchor?.chapterId ?? null;
  const anchorPosition =
    legacyTrace.primaryAnchorPosition ?? anchor?.position ?? null;
  const contextBudget = snapshot.contextBudget;
  const boundary = snapshot.source.boundary;

  return {
    schemaVersion: 2,
    generationTraceId:
      input.generationTraceId ??
      snapshot.generationTraceId ??
      (input.runId ? historicalGenerationTraceId(input.runId) : newGenerationTraceId()),
    batchTraceId,
    lineage: {
      batchTraceId,
      chapterOrdinal,
      chapterCount,
      chapterFingerprint: chapterFingerprint({
        snapshot,
        instructionHash,
        batchTraceId,
        chapterOrdinal,
      }),
    },
    sourceSnapshot: {
      sourceId: snapshot.source.sourceId,
      sourceVersion: snapshot.source.sourceVersion,
      normalizedSha256: snapshot.source.normalizedSha256,
      parserVersion: snapshot.source.parserVersion,
      normalizationVersion: snapshot.source.normalizationVersion,
      boundaryChapterId: boundary?.chapterId ?? null,
      boundaryPosition:
        boundary?.chapterPosition == null
          ? null
          : Number(boundary.chapterPosition),
      boundaryCharOffsetExclusive:
        boundary?.charOffsetExclusive == null
          ? null
          : Number(boundary.charOffsetExclusive),
    },
    canon: {
      snapshotId: snapshot.canon.snapshotId,
      revision: snapshot.canon.revision,
    },
    tail: {
      kind: anchorKind,
      chapterId: anchorChapterId,
      position: anchorPosition,
      storyMemoryThroughPosition: snapshot.storyMemory.throughPosition,
      storyMemoryFingerprint: snapshot.storyMemory.stateFingerprint,
    },
    currentInstruction: {
      sha256: instructionHash,
      charCount: instruction.length,
    },
    budget: {
      modelContextLimit:
        contextBudget?.modelContextLimit ?? legacyTrace.modelContextLimit ?? null,
      inputBudget: contextBudget?.inputBudget ?? legacyTrace.inputBudget ?? null,
      effectiveInputBudget:
        legacyTrace.effectiveInputBudget ?? contextBudget?.inputBudget ?? null,
      reservedOutputTokens:
        contextBudget?.reservedOutputTokens ?? legacyTrace.reservedOutputTokens,
      requestedMaxTokens: legacyTrace.requestedMaxTokens ?? null,
      effectiveWindow: legacyTrace.effectiveWindow ?? null,
      pressure: legacyTrace.pressure ?? null,
    },
    llmRequestIdentity: {
      stageConfigIds: stageConfigIds(snapshot),
      stageModelNames: stageModelNames(snapshot),
      secretsExcluded: true,
    },
    eligibility: {
      status: 'unknown',
      rejectionCode: null,
    },
    adoption: {
      status: 'not_attempted',
      adoptedRevisionHash: null,
    },
    finalization: {
      status: 'not_started',
      finalizedRevisionHash: null,
      completionReason: null,
    },
    stateGate: {
      currentState: 'queued',
      lastEvent: 'queued',
    },
    events: [],
  };
}

export function appendContinuationGenerationTraceEvent(
  trace: ContinuationContextTrace,
  input: AppendContinuationGenerationTraceEventInput,
): ContinuationContextTrace {
  if (!trace.generationTrace) {
    throw new Error('Continuation unified trace is not initialized');
  }
  const current = trace.generationTrace;
  const event: ContinuationGenerationTraceEvent = {
    sequence: current.events.length + 1,
    event: input.event,
    state: input.state,
    stage: input.stage ?? null,
    at: input.at ?? new Date().toISOString(),
    reason: input.reason ?? null,
  };
  return {
    ...trace,
    generationTraceId: current.generationTraceId,
    batchTraceId: current.batchTraceId,
    generationTrace: {
      ...current,
      eligibility: {
        ...current.eligibility,
        ...(input.eligibility ?? {}),
      },
      adoption: {
        ...current.adoption,
        ...(input.adoption ?? {}),
      },
      finalization: {
        ...current.finalization,
        ...(input.finalization ?? {}),
      },
      stateGate: {
        currentState: input.state,
        lastEvent: input.event,
      },
      events: [...current.events, event],
    },
  };
}

export function createContinuationGenerationTrace(
  input: CreateContinuationGenerationTraceInput,
): ContinuationContextTrace {
  const generationTrace = buildGenerationTrace(input);
  const initialized: ContinuationContextTrace = {
    ...input.trace,
    generationTraceId: generationTrace.generationTraceId,
    batchTraceId: generationTrace.batchTraceId,
    generationTrace,
  };
  const queued = appendContinuationGenerationTraceEvent(initialized, {
    event: 'queued',
    state: 'queued',
    stage: null,
  });
  if (input.state === 'queued') return queued;
  return appendContinuationGenerationTraceEvent(queued, {
    event: 'running',
    state: input.state,
    stage: input.stage ?? null,
  });
}

/** Upgrade a historical/partially persisted trace in memory and preserve its
 * identity on every future resume. */
export function ensureContinuationGenerationTrace(
  trace: ContinuationContextTrace,
  snapshot: ContinuationTraceSnapshot,
  options: EnsureContinuationGenerationTraceOptions,
): ContinuationContextTrace {
  if (trace.generationTrace) {
    return {
      ...trace,
      generationTraceId:
        trace.generationTrace.generationTraceId ?? trace.generationTraceId,
      batchTraceId:
        trace.generationTrace.batchTraceId ?? trace.batchTraceId ?? null,
    };
  }
  return createContinuationGenerationTrace({
    snapshot,
    trace,
    runId: options.runId,
    generationTraceId:
      trace.generationTraceId ?? historicalGenerationTraceId(options.runId),
    batchTraceId: trace.batchTraceId ?? null,
    state: options.state,
    stage: options.stage,
  });
}

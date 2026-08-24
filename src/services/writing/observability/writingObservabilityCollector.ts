/**
 * In-flight chapter observability collector.
 *
 * Keyed by generationTraceId because WritingKernelTrace objects are replaced
 * by spreads on every stage event. Observation only — never changes stage
 * policy, budget, or writer behavior.
 */
import { resolveExecutionProfileFromValues } from '../contracts/executionProfile';
import type {
  FrozenWritingContext,
  WritingKernelTrace,
} from '../contracts/frozenWritingContext';
import type { SharedWritingStageName } from '../contracts/writingPolicy';
import type { WritingStageArtifacts } from '../contracts/writingStage';
import type { WritingRequestReceipt } from '../contracts/writingRequestReceipt';
import {
  emptyWritingChapterObservability,
  measureDuplicateContext,
  measureFrozenContextTokens,
  measureStageContextProjection,
  summarizeWritingLlmCalls,
  type WritingChapterObservability,
  type WritingContextBuildTimings,
  type WritingLlmCallRecord,
  type WritingPostWritingSnapshot,
  type WritingStageTimingRecord,
} from './writingChapterObservability';

const MAX_COLLECTORS = 64;

interface PendingStageTiming {
  stage: string;
  queuedAt: number;
  startedAt: number;
  persistMs: number;
}

interface CollectorState {
  generationTraceId: string;
  startedAt: number;
  persistCompletedAt: number | null;
  contextTimings: WritingContextBuildTimings;
  frozenContext: FrozenWritingContext | null;
  calls: WritingLlmCallRecord[];
  receipts: WritingRequestReceipt[];
  stages: Map<string, WritingStageTimingRecord>;
  pending: Map<string, PendingStageTiming>;
  lastStageEndedAt: number | null;
  postWriting: WritingPostWritingSnapshot;
}

const collectors = new Map<string, CollectorState>();
const pendingContextTimings = new Map<string, WritingContextBuildTimings>();

export function recordPendingContextBuildTimings(
  generationTraceId: string,
  timings: WritingContextBuildTimings,
): void {
  if (!generationTraceId) return;
  pendingContextTimings.set(generationTraceId, timings);
}

export function takePendingContextBuildTimings(
  generationTraceId: string,
): WritingContextBuildTimings | undefined {
  const timings = pendingContextTimings.get(generationTraceId);
  if (timings) pendingContextTimings.delete(generationTraceId);
  return timings;
}

export function bindWritingObservabilityCollector(
  trace: WritingKernelTrace,
  frozenContext?: FrozenWritingContext | null,
): void {
  if (!trace.generationTraceId) return;
  evictIfNeeded();
  const existing = collectors.get(trace.generationTraceId);
  const contextTimings =
    existing?.contextTimings ||
    takePendingContextBuildTimings(trace.generationTraceId) ||
    emptyContextTimings();
  if (existing) {
    if (frozenContext) existing.frozenContext = frozenContext;
    existing.contextTimings = contextTimings;
    if (!existing.receipts) existing.receipts = [];
    return;
  }
  collectors.set(trace.generationTraceId, {
    generationTraceId: trace.generationTraceId,
    startedAt: Date.now() - contextTimings.contextBuildMs,
    persistCompletedAt: null,
    contextTimings,
    frozenContext: frozenContext ?? null,
    calls: [],
    receipts: [],
    stages: new Map(),
    pending: new Map(),
    lastStageEndedAt: null,
    postWriting: emptyPostWriting(),
  });
}

export function getWritingObservabilityCollector(
  generationTraceId: string | null | undefined,
): CollectorState | null {
  if (!generationTraceId) return null;
  return collectors.get(generationTraceId) ?? null;
}

export function recordWritingRequestReceipt(
  trace: WritingKernelTrace | null | undefined,
  receipt: WritingRequestReceipt,
): void {
  if (!trace) return;
  trace.requestReceipts = [...(trace.requestReceipts || []), receipt];
  const collector = getWritingObservabilityCollector(trace.generationTraceId);
  if (collector) {
    collector.receipts = collector.receipts || [];
    collector.receipts.push(receipt);
  }
}

export function recordWritingLlmCall(
  generationTraceId: string | null | undefined,
  call: WritingLlmCallRecord,
): void {
  const collector = getWritingObservabilityCollector(generationTraceId);
  if (!collector) return;
  collector.calls.push(call);
  const stage = collector.stages.get(call.stage);
  if (stage) {
    if (call.kind === 'logical_stage') stage.logicalStageCallCount += 1;
    if (call.kind === 'formatter') stage.formatterCallCount += 1;
    if (call.kind === 'post_writing_auxiliary') {
      collector.postWriting.postWritingAuxiliaryCallCount += 1;
      collector.postWriting.postWritingAuxiliaryInputTokens += call.inputTokens;
      collector.postWriting.postWritingAuxiliaryOutputTokens += call.outputTokens;
    }
    stage.physicalRequestCount += call.physicalRequestCount;
    stage.protocolFallbackCount += call.protocolFallbackCount;
    stage.inputTokens += call.inputTokens;
    stage.outputTokens += call.outputTokens;
  }
}

export function beginWritingStageTiming(
  generationTraceId: string | null | undefined,
  stage: string,
): void {
  const collector = getWritingObservabilityCollector(generationTraceId);
  if (!collector) return;
  const now = Date.now();
  collector.pending.set(stage, {
    stage,
    queuedAt: collector.lastStageEndedAt ?? now,
    startedAt: now,
    persistMs: 0,
  });
}

export function addWritingStagePersistMs(
  generationTraceId: string | null | undefined,
  stage: string,
  persistMs: number,
): void {
  const collector = getWritingObservabilityCollector(generationTraceId);
  if (!collector) return;
  const pending = collector.pending.get(stage);
  if (pending) pending.persistMs += Math.max(0, persistMs);
}

export function endWritingStageTiming(input: {
  generationTraceId: string | null | undefined;
  stage: string;
  status: WritingStageTimingRecord['status'];
  skipReason?: string;
  policyRuleId?: string;
  frozenContext?: FrozenWritingContext;
  artifacts?: WritingStageArtifacts;
}): void {
  const collector = getWritingObservabilityCollector(input.generationTraceId);
  if (!collector) return;
  const now = Date.now();
  const pending = collector.pending.get(input.stage);
  collector.pending.delete(input.stage);
  const frozen = input.frozenContext || collector.frozenContext;
  const projection =
    frozen && isPaidStage(input.stage) && input.status !== 'skipped'
      ? measureStageContextProjection({
          stage: input.stage as SharedWritingStageName,
          frozenContext: frozen,
          artifacts: input.artifacts,
        })
      : null;
  const executionMs = pending ? Math.max(0, now - pending.startedAt) : 0;
  const queuedMs = pending ? Math.max(0, pending.startedAt - pending.queuedAt) : 0;
  collector.stages.set(input.stage, {
    stage: input.stage,
    status: input.status,
    ...(input.skipReason ? { skipReason: input.skipReason } : {}),
    ...(input.policyRuleId ? { policyRuleId: input.policyRuleId } : {}),
    stageQueuedMs: queuedMs,
    stageExecutionMs: executionMs,
    stageDependencyWaitMs: 0,
    stagePersistMs: pending?.persistMs ?? 0,
    projectedTokens: projection?.projectedTokens ?? 0,
    frozenContextTokens: projection?.frozenContextTokens ?? 0,
    artifactTokens: projection?.artifactTokens ?? 0,
    logicalStageCallCount: 0,
    formatterCallCount: 0,
    physicalRequestCount: 0,
    protocolFallbackCount: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
  const existingCalls = collector.calls.filter(call => call.stage === input.stage);
  const stage = collector.stages.get(input.stage);
  if (stage) {
    for (const call of existingCalls) {
      if (call.kind === 'logical_stage') stage.logicalStageCallCount += 1;
      if (call.kind === 'formatter') stage.formatterCallCount += 1;
      stage.physicalRequestCount += call.physicalRequestCount;
      stage.protocolFallbackCount += call.protocolFallbackCount;
      stage.inputTokens += call.inputTokens;
      stage.outputTokens += call.outputTokens;
    }
  }
  collector.lastStageEndedAt = now;
  if (input.stage === 'persist' && input.status === 'completed') {
    collector.persistCompletedAt = now;
  }
}

export function recordPostWritingObservability(input: {
  generationTraceId?: string | null;
  kind: 'story_memory' | 'state_extraction';
  durationMs: number;
  blockingMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  physicalRequestCount?: number;
}): void {
  const collector = getWritingObservabilityCollector(input.generationTraceId);
  if (!collector) return;
  if (input.kind === 'story_memory') {
    collector.postWriting.storyMemoryUpdateMs += Math.max(0, input.durationMs);
  } else {
    collector.postWriting.stateExtractionMs += Math.max(0, input.durationMs);
  }
  collector.postWriting.postWritingBlockingMs += Math.max(0, input.blockingMs ?? 0);
  recordWritingLlmCall(input.generationTraceId, {
    kind: 'post_writing_auxiliary',
    stage: input.kind,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    physicalRequestCount: input.physicalRequestCount ?? (input.inputTokens || input.outputTokens ? 1 : 0),
    protocolFallbackCount: 0,
    promptCacheHitTokens: null,
    promptCacheMissTokens: null,
    durationMs: input.durationMs,
  });
}

export function finalizeWritingKernelObservability(
  trace: WritingKernelTrace,
  frozenContext?: FrozenWritingContext | null,
): WritingKernelTrace {
  const collector = collectors.get(trace.generationTraceId);
  if (!collector) {
    const pending = takePendingContextBuildTimings(trace.generationTraceId);
    if (!pending && !frozenContext) return trace;
    if (pending || frozenContext) {
      bindWritingObservabilityCollector(trace, frozenContext);
      return finalizeWritingKernelObservability(trace, frozenContext);
    }
    return trace;
  }
  if (frozenContext) collector.frozenContext = frozenContext;
  const snapshot = snapshotCollector(collector, trace);
  collectors.delete(trace.generationTraceId);
  return {
    ...trace,
    observability: snapshot,
    requestReceipts:
      collector.receipts.length > 0
        ? [...collector.receipts]
        : trace.requestReceipts,
  };
}

export function snapshotWritingObservability(
  trace: WritingKernelTrace,
): WritingChapterObservability | undefined {
  const collector = collectors.get(trace.generationTraceId);
  if (!collector) return trace.observability;
  return snapshotCollector(collector, trace);
}

export function resetWritingObservabilityForTests(): void {
  collectors.clear();
  pendingContextTimings.clear();
}

function snapshotCollector(
  collector: CollectorState,
  trace: WritingKernelTrace,
): WritingChapterObservability {
  const frozen = collector.frozenContext;
  const llm = summarizeWritingLlmCalls(collector.calls);
  const tokens = frozen
    ? measureFrozenContextTokens(frozen)
    : {
        candidateTokens: 0,
        allocatedTokens: 0,
        renderedTokens: 0,
        frozenContextTokens: 0,
      };
  const duplicate = frozen
    ? measureDuplicateContext({
        frozenContext: frozen,
        projections: [...collector.stages.values()]
          .filter(
            stage => stage.status !== 'skipped' && isPaidStage(stage.stage),
          )
          .map(stage =>
            measureStageContextProjection({
              stage: stage.stage as SharedWritingStageName,
              frozenContext: frozen,
            }),
          ),
      })
    : {
        frozenContextTokens: 0,
        stageProjectedContextTokens: 0,
        artifactTokens: 0,
        duplicateContextTokens: 0,
        duplicateContextRatio: 0,
      };
  const endedAt = collector.persistCompletedAt ?? collector.lastStageEndedAt ?? Date.now();
  const base = emptyWritingChapterObservability({
    generationTraceId: collector.generationTraceId,
    freezeFingerprint: frozen?.freezeFingerprint || trace.freezeFingerprint,
    scenario: trace.scenario,
    executionProfile: resolveExecutionProfileFromValues(
      frozen?.stagePolicy.values,
    ),
  });
  return {
    ...base,
    chapterE2EMs: Math.max(0, endedAt - collector.startedAt),
    context: {
      ...collector.contextTimings,
      ...tokens,
      ...duplicate,
    },
    stages: [...collector.stages.values()],
    llm,
    postWriting: { ...collector.postWriting },
  };
}

function emptyContextTimings(): WritingContextBuildTimings {
  return {
    contextBuildMs: 0,
    freezeMs: 0,
    collectMs: 0,
    normalizeMs: 0,
    planMs: 0,
    allocateMs: 0,
    renderMs: 0,
  };
}

function emptyPostWriting(): WritingPostWritingSnapshot {
  return {
    storyMemoryUpdateMs: 0,
    stateExtractionMs: 0,
    postWritingBlockingMs: 0,
    postWritingAuxiliaryCallCount: 0,
    postWritingAuxiliaryInputTokens: 0,
    postWritingAuxiliaryOutputTokens: 0,
  };
}

function isPaidStage(stage: string): stage is SharedWritingStageName {
  return (
    stage === 'draft' ||
    stage === 'review' ||
    stage === 'audit' ||
    stage === 'factCheck' ||
    stage === 'revision' ||
    stage === 'proof'
  );
}

function evictIfNeeded(): void {
  if (collectors.size < MAX_COLLECTORS) return;
  const first = collectors.keys().next().value;
  if (first) collectors.delete(first);
}

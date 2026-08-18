/**
 * Phase 0 chapter observability contract.
 *
 * Observation only. This module never selects a Writer, Prompt Compiler,
 * Context Budget, or Memory system. Call kinds stay distinct — they must
 * never be collapsed into a single "API calls" number.
 */
import { estimateMessagesTokens, estimateTokens } from '../../../utils/tokenEstimator';
import { resolveExecutionProfileFromValues } from '../contracts/executionProfile';
import type { FrozenWritingContext } from '../contracts/frozenWritingContext';
import type { SharedWritingStageName } from '../contracts/writingPolicy';
import { resolveSharedStageSkip } from '../contracts/writingPolicy';
import type { WritingRequest } from '../contracts/writingSource';
import type {
  SharedWritingArtifact,
  WritingStageArtifacts,
} from '../contracts/writingStage';
import { compileSharedWritingPrompt } from '../prompt/sharedPromptCompiler';
import {
  instructionBlock,
  previousArtifactBlock,
} from '../prompt/requirementProjection';

export const WRITING_CHAPTER_OBSERVABILITY_VERSION = 1 as const;

export type WritingLlmCallKind =
  | 'logical_stage'
  | 'formatter'
  | 'protocol_fallback'
  | 'post_writing_auxiliary';

export type WritingObservabilitySampleKind =
  | 'outline_standard'
  | 'continuation_standard'
  | 'one_shot'
  | 'batch';

export interface WritingLlmCallRecord {
  kind: Exclude<WritingLlmCallKind, 'protocol_fallback'>;
  stage: string;
  inputTokens: number;
  outputTokens: number;
  physicalRequestCount: number;
  protocolFallbackCount: number;
  promptCacheHitTokens: number | null;
  promptCacheMissTokens: number | null;
  durationMs: number;
}

export interface WritingStageTimingRecord {
  stage: string;
  status: 'completed' | 'skipped' | 'failed' | 'blocked';
  skipReason?: string;
  policyRuleId?: string;
  stageQueuedMs: number;
  stageExecutionMs: number;
  stageDependencyWaitMs: number;
  stagePersistMs: number;
  projectedTokens: number;
  frozenContextTokens: number;
  artifactTokens: number;
  logicalStageCallCount: number;
  formatterCallCount: number;
  physicalRequestCount: number;
  protocolFallbackCount: number;
  inputTokens: number;
  outputTokens: number;
}

export interface WritingContextBuildTimings {
  contextBuildMs: number;
  freezeMs: number;
  collectMs: number;
  normalizeMs: number;
  planMs: number;
  allocateMs: number;
  renderMs: number;
}

export interface WritingContextTokenSnapshot {
  candidateTokens: number;
  allocatedTokens: number;
  renderedTokens: number;
  frozenContextTokens: number;
  stageProjectedContextTokens: number;
  artifactTokens: number;
  duplicateContextTokens: number;
  duplicateContextRatio: number;
}

export interface WritingPostWritingSnapshot {
  storyMemoryUpdateMs: number;
  stateExtractionMs: number;
  postWritingBlockingMs: number;
  postWritingAuxiliaryCallCount: number;
  postWritingAuxiliaryInputTokens: number;
  postWritingAuxiliaryOutputTokens: number;
}

export interface WritingLlmSnapshot {
  logicalStageCallCount: number;
  formatterCallCount: number;
  physicalRequestCount: number;
  protocolFallbackCount: number;
  /** logical + formatter. Never includes PostWriting auxiliary. */
  chapterWritingPaidCallCount: number;
  postWritingAuxiliaryCallCount: number;
  inputTokens: number;
  outputTokens: number;
  promptCacheHitTokens: number | null;
  promptCacheMissTokens: number | null;
  calls: WritingLlmCallRecord[];
}

export interface WritingChapterObservability {
  version: 1;
  generationTraceId: string;
  freezeFingerprint: string;
  scenario: WritingRequest['scenario'];
  executionProfile: string;
  sampleKind?: WritingObservabilitySampleKind;
  chapterE2EMs: number;
  context: WritingContextBuildTimings & WritingContextTokenSnapshot;
  stages: WritingStageTimingRecord[];
  llm: WritingLlmSnapshot;
  postWriting: WritingPostWritingSnapshot;
}

export interface WritingStageContextProjection {
  stage: SharedWritingStageName;
  projectedTokens: number;
  frozenContextTokens: number;
  artifactTokens: number;
  instructionTokens: number;
  carriesFullFrozenContext: boolean;
  previousArtifactKeys: string[];
}

const PAID_WRITER_STAGES: SharedWritingStageName[] = [
  'draft',
  'review',
  'audit',
  'factCheck',
  'revision',
  'proof',
];

const EMPTY_CONTEXT_TIMINGS: WritingContextBuildTimings = {
  contextBuildMs: 0,
  freezeMs: 0,
  collectMs: 0,
  normalizeMs: 0,
  planMs: 0,
  allocateMs: 0,
  renderMs: 0,
};

const EMPTY_POST_WRITING: WritingPostWritingSnapshot = {
  storyMemoryUpdateMs: 0,
  stateExtractionMs: 0,
  postWritingBlockingMs: 0,
  postWritingAuxiliaryCallCount: 0,
  postWritingAuxiliaryInputTokens: 0,
  postWritingAuxiliaryOutputTokens: 0,
};

export function emptyWritingContextTokenSnapshot(): WritingContextTokenSnapshot {
  return {
    candidateTokens: 0,
    allocatedTokens: 0,
    renderedTokens: 0,
    frozenContextTokens: 0,
    stageProjectedContextTokens: 0,
    artifactTokens: 0,
    duplicateContextTokens: 0,
    duplicateContextRatio: 0,
  };
}

export function emptyWritingLlmSnapshot(): WritingLlmSnapshot {
  return {
    logicalStageCallCount: 0,
    formatterCallCount: 0,
    physicalRequestCount: 0,
    protocolFallbackCount: 0,
    chapterWritingPaidCallCount: 0,
    postWritingAuxiliaryCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    promptCacheHitTokens: null,
    promptCacheMissTokens: null,
    calls: [],
  };
}

export function emptyWritingChapterObservability(input: {
  generationTraceId: string;
  freezeFingerprint?: string;
  scenario?: WritingRequest['scenario'];
  executionProfile?: string;
}): WritingChapterObservability {
  return {
    version: 1,
    generationTraceId: input.generationTraceId,
    freezeFingerprint: input.freezeFingerprint || '',
    scenario: input.scenario || 'outline',
    executionProfile: input.executionProfile || 'standard',
    chapterE2EMs: 0,
    context: {
      ...EMPTY_CONTEXT_TIMINGS,
      ...emptyWritingContextTokenSnapshot(),
    },
    stages: [],
    llm: emptyWritingLlmSnapshot(),
    postWriting: { ...EMPTY_POST_WRITING },
  };
}

/**
 * Classify a writer-layer invocation. Protocol fallback is a physical
 * property of that invocation, never its own logical stage call.
 */
export function classifyWritingLlmCall(input: {
  isFormatter?: boolean;
  isPostWriting?: boolean;
}): Exclude<WritingLlmCallKind, 'protocol_fallback'> {
  if (input.isPostWriting) return 'post_writing_auxiliary';
  if (input.isFormatter) return 'formatter';
  return 'logical_stage';
}

export function summarizeWritingLlmCalls(
  calls: WritingLlmCallRecord[],
): WritingLlmSnapshot {
  let logicalStageCallCount = 0;
  let formatterCallCount = 0;
  let physicalRequestCount = 0;
  let protocolFallbackCount = 0;
  let postWritingAuxiliaryCallCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let promptCacheHitTokens: number | null = null;
  let promptCacheMissTokens: number | null = null;
  for (const call of calls) {
    if (call.kind === 'logical_stage') logicalStageCallCount += 1;
    else if (call.kind === 'formatter') formatterCallCount += 1;
    else postWritingAuxiliaryCallCount += 1;
    physicalRequestCount += Math.max(0, call.physicalRequestCount);
    protocolFallbackCount += Math.max(0, call.protocolFallbackCount);
    inputTokens += Math.max(0, call.inputTokens);
    outputTokens += Math.max(0, call.outputTokens);
    if (call.promptCacheHitTokens != null) {
      promptCacheHitTokens = (promptCacheHitTokens ?? 0) + call.promptCacheHitTokens;
    }
    if (call.promptCacheMissTokens != null) {
      promptCacheMissTokens =
        (promptCacheMissTokens ?? 0) + call.promptCacheMissTokens;
    }
  }
  return {
    logicalStageCallCount,
    formatterCallCount,
    physicalRequestCount,
    protocolFallbackCount,
    chapterWritingPaidCallCount: logicalStageCallCount + formatterCallCount,
    postWritingAuxiliaryCallCount,
    inputTokens,
    outputTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    calls: [...calls],
  };
}

export function measureStageContextProjection(input: {
  stage: SharedWritingStageName;
  frozenContext: FrozenWritingContext;
  artifacts?: WritingStageArtifacts;
}): WritingStageContextProjection {
  const artifacts = input.artifacts || {};
  const compiled = compileSharedWritingPrompt({
    stage: input.stage,
    frozenContext: input.frozenContext,
    artifacts,
    requirements: input.frozenContext.requirements,
    stagePolicy: input.frozenContext.stagePolicy,
  });
  const frozenText = input.frozenContext.rendered?.text || '';
  const previous = previousArtifactBlock(artifacts);
  const previousArtifactKeys = (
    ['draft', 'review', 'audit', 'factCheck', 'revision'] as const
  ).filter(key => Boolean(readArtifactBody(artifacts[key])));
  const carriesFullFrozenContext =
    frozenText.length > 0 &&
    compiled.messages.some(message => message.content.includes(frozenText));
  return {
    stage: input.stage,
    projectedTokens: estimateMessagesTokens(compiled.messages),
    frozenContextTokens: estimateTokens(frozenText),
    artifactTokens: estimateTokens(previous),
    instructionTokens: estimateTokens(instructionBlock(input.frozenContext)),
    carriesFullFrozenContext,
    previousArtifactKeys: [...previousArtifactKeys],
  };
}

export function measureDuplicateContext(input: {
  frozenContext: FrozenWritingContext;
  projections: WritingStageContextProjection[];
}): Pick<
  WritingContextTokenSnapshot,
  | 'frozenContextTokens'
  | 'stageProjectedContextTokens'
  | 'artifactTokens'
  | 'duplicateContextTokens'
  | 'duplicateContextRatio'
> {
  const frozenText = input.frozenContext.rendered?.text || '';
  const frozenContextTokens = estimateTokens(frozenText);
  const instructionTokens = estimateTokens(instructionBlock(input.frozenContext));
  const appearances: Record<string, { tokens: number; count: number }> = {
    frozen: { tokens: frozenContextTokens, count: 0 },
    instruction: { tokens: instructionTokens, count: 0 },
  };
  let stageProjectedContextTokens = 0;
  let artifactTokens = 0;
  for (const projection of input.projections) {
    stageProjectedContextTokens += projection.projectedTokens;
    artifactTokens += projection.artifactTokens;
    if (projection.carriesFullFrozenContext) appearances.frozen.count += 1;
    if (projection.instructionTokens > 0) appearances.instruction.count += 1;
    for (const key of projection.previousArtifactKeys) {
      const slot = appearances[key] || { tokens: 0, count: 0 };
      if (slot.tokens <= 0) {
        slot.tokens = Math.max(
          1,
          Math.floor(
            projection.artifactTokens / Math.max(1, projection.previousArtifactKeys.length),
          ),
        );
      }
      slot.count += 1;
      appearances[key] = slot;
    }
  }
  let duplicateContextTokens = 0;
  for (const slice of Object.values(appearances)) {
    duplicateContextTokens += slice.tokens * Math.max(0, slice.count - 1);
  }
  const duplicateContextRatio =
    stageProjectedContextTokens > 0
      ? Number((duplicateContextTokens / stageProjectedContextTokens).toFixed(4))
      : 0;
  return {
    frozenContextTokens,
    stageProjectedContextTokens,
    artifactTokens,
    duplicateContextTokens,
    duplicateContextRatio,
  };
}

export function measureFrozenContextTokens(
  frozenContext: FrozenWritingContext,
): Pick<
  WritingContextTokenSnapshot,
  'candidateTokens' | 'allocatedTokens' | 'renderedTokens' | 'frozenContextTokens'
> {
  const candidateTokens = frozenContext.materials.reduce(
    (total, item) => total + Math.max(0, item.demandTokens),
    0,
  );
  const allocatedTokens = frozenContext.allocation.totalAllocatedTokens;
  const renderedTokens = frozenContext.rendered.estimatedInputTokens;
  return {
    candidateTokens,
    allocatedTokens,
    renderedTokens,
    frozenContextTokens: renderedTokens,
  };
}

export function listPaidStagesForPolicy(
  frozenContext: FrozenWritingContext,
): {
  executed: SharedWritingStageName[];
  skipped: Array<{
    stage: SharedWritingStageName;
    skipReason: string;
    policyRuleId: string;
  }>;
} {
  const executed: SharedWritingStageName[] = [];
  const skipped: Array<{
    stage: SharedWritingStageName;
    skipReason: string;
    policyRuleId: string;
  }> = [];
  for (const stage of frozenContext.stagePolicy.stageOrder.length
    ? frozenContext.stagePolicy.stageOrder
    : [...PAID_WRITER_STAGES, 'finalValidate' as const, 'persist' as const]) {
    if (!PAID_WRITER_STAGES.includes(stage)) continue;
    const skip = resolveSharedStageSkip(frozenContext.stagePolicy, stage);
    if (skip.skip) {
      skipped.push({
        stage,
        skipReason: skip.skipReason,
        policyRuleId: skip.policyRuleId,
      });
    } else {
      executed.push(stage);
    }
  }
  return { executed, skipped };
}

/**
 * Deterministic structural baseline: Freeze + compile every paid stage
 * the frozen policy would actually dispatch. Does not call the LLM.
 */
export function measureStructuralChapterObservability(input: {
  frozenContext: FrozenWritingContext;
  contextTimings?: Partial<WritingContextBuildTimings>;
  artifacts?: WritingStageArtifacts;
  sampleKind?: WritingObservabilitySampleKind;
  expectedLogicalCalls?: boolean;
}): WritingChapterObservability {
  const { executed, skipped } = listPaidStagesForPolicy(input.frozenContext);
  const artifacts: WritingStageArtifacts = { ...(input.artifacts || {}) };
  const projections: WritingStageContextProjection[] = [];
  const stages: WritingStageTimingRecord[] = [];
  for (const stage of executed) {
    const projection = measureStageContextProjection({
      stage,
      frozenContext: input.frozenContext,
      artifacts,
    });
    projections.push(projection);
    stages.push({
      stage,
      status: 'completed',
      stageQueuedMs: 0,
      stageExecutionMs: 0,
      stageDependencyWaitMs: 0,
      stagePersistMs: 0,
      projectedTokens: projection.projectedTokens,
      frozenContextTokens: projection.frozenContextTokens,
      artifactTokens: projection.artifactTokens,
      logicalStageCallCount: input.expectedLogicalCalls === false ? 0 : 1,
      formatterCallCount: 0,
      physicalRequestCount: input.expectedLogicalCalls === false ? 0 : 1,
      protocolFallbackCount: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  }
  for (const skip of skipped) {
    stages.push({
      stage: skip.stage,
      status: 'skipped',
      skipReason: skip.skipReason,
      policyRuleId: skip.policyRuleId,
      stageQueuedMs: 0,
      stageExecutionMs: 0,
      stageDependencyWaitMs: 0,
      stagePersistMs: 0,
      projectedTokens: 0,
      frozenContextTokens: 0,
      artifactTokens: 0,
      logicalStageCallCount: 0,
      formatterCallCount: 0,
      physicalRequestCount: 0,
      protocolFallbackCount: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  }
  const tokens = measureFrozenContextTokens(input.frozenContext);
  const duplicate = measureDuplicateContext({
    frozenContext: input.frozenContext,
    projections,
  });
  const expectedCalls = input.expectedLogicalCalls === false ? 0 : executed.length;
  return {
    version: 1,
    generationTraceId: input.frozenContext.generationTraceId,
    freezeFingerprint: input.frozenContext.freezeFingerprint,
    scenario: inferScenario(input.frozenContext),
    executionProfile: resolveExecutionProfileFromValues(
      input.frozenContext.stagePolicy.values,
    ),
    ...(input.sampleKind ? { sampleKind: input.sampleKind } : {}),
    chapterE2EMs: 0,
    context: {
      ...EMPTY_CONTEXT_TIMINGS,
      ...input.contextTimings,
      ...tokens,
      ...duplicate,
    },
    stages,
    llm: {
      ...emptyWritingLlmSnapshot(),
      logicalStageCallCount: expectedCalls,
      physicalRequestCount: expectedCalls,
      chapterWritingPaidCallCount: expectedCalls,
    },
    postWriting: { ...EMPTY_POST_WRITING },
  };
}

export function percentileMs(values: number[], percentile: 50 | 95): number | null {
  const cleaned = values
    .map(value => Number(value))
    .filter(value => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (cleaned.length === 0) return null;
  if (cleaned.length === 1) return cleaned[0];
  const rank = (percentile / 100) * (cleaned.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return cleaned[low];
  const weight = rank - low;
  return Math.round(cleaned[low] * (1 - weight) + cleaned[high] * weight);
}

export function parseWritingChapterObservability(
  raw: unknown,
): WritingChapterObservability | undefined {
  if (raw == null) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  if (Number(row.version) !== 1) return undefined;
  if (typeof row.generationTraceId !== 'string' || !row.generationTraceId.trim()) {
    return undefined;
  }
  const llmRaw = asRecord(row.llm);
  const contextRaw = asRecord(row.context);
  const postRaw = asRecord(row.postWriting);
  const calls = Array.isArray(llmRaw?.calls)
    ? llmRaw!.calls
        .map(parseCallRecord)
        .filter((item): item is WritingLlmCallRecord => item != null)
    : [];
  const llm = summarizeWritingLlmCalls(calls);
  if (llmRaw) {
    llm.logicalStageCallCount = numberOr(llmRaw.logicalStageCallCount, llm.logicalStageCallCount);
    llm.formatterCallCount = numberOr(llmRaw.formatterCallCount, llm.formatterCallCount);
    llm.physicalRequestCount = numberOr(llmRaw.physicalRequestCount, llm.physicalRequestCount);
    llm.protocolFallbackCount = numberOr(
      llmRaw.protocolFallbackCount,
      llm.protocolFallbackCount,
    );
    llm.chapterWritingPaidCallCount = numberOr(
      llmRaw.chapterWritingPaidCallCount,
      llm.logicalStageCallCount + llm.formatterCallCount,
    );
    llm.postWritingAuxiliaryCallCount = numberOr(
      llmRaw.postWritingAuxiliaryCallCount,
      llm.postWritingAuxiliaryCallCount,
    );
    llm.inputTokens = numberOr(llmRaw.inputTokens, llm.inputTokens);
    llm.outputTokens = numberOr(llmRaw.outputTokens, llm.outputTokens);
    llm.promptCacheHitTokens = nullableNumber(llmRaw.promptCacheHitTokens);
    llm.promptCacheMissTokens = nullableNumber(llmRaw.promptCacheMissTokens);
  }
  return {
    version: 1,
    generationTraceId: row.generationTraceId,
    freezeFingerprint: String(row.freezeFingerprint || ''),
    scenario: row.scenario === 'continuation' ? 'continuation' : 'outline',
    executionProfile: String(row.executionProfile || 'standard'),
    ...(typeof row.sampleKind === 'string'
      ? { sampleKind: row.sampleKind as WritingObservabilitySampleKind }
      : {}),
    chapterE2EMs: numberOr(row.chapterE2EMs, 0),
    context: {
      contextBuildMs: numberOr(contextRaw?.contextBuildMs, 0),
      freezeMs: numberOr(contextRaw?.freezeMs, 0),
      collectMs: numberOr(contextRaw?.collectMs, 0),
      normalizeMs: numberOr(contextRaw?.normalizeMs, 0),
      planMs: numberOr(contextRaw?.planMs, 0),
      allocateMs: numberOr(contextRaw?.allocateMs, 0),
      renderMs: numberOr(contextRaw?.renderMs, 0),
      candidateTokens: numberOr(contextRaw?.candidateTokens, 0),
      allocatedTokens: numberOr(contextRaw?.allocatedTokens, 0),
      renderedTokens: numberOr(contextRaw?.renderedTokens, 0),
      frozenContextTokens: numberOr(contextRaw?.frozenContextTokens, 0),
      stageProjectedContextTokens: numberOr(
        contextRaw?.stageProjectedContextTokens,
        0,
      ),
      artifactTokens: numberOr(contextRaw?.artifactTokens, 0),
      duplicateContextTokens: numberOr(contextRaw?.duplicateContextTokens, 0),
      duplicateContextRatio: numberOr(contextRaw?.duplicateContextRatio, 0),
    },
    stages: Array.isArray(row.stages)
      ? row.stages
          .map(parseStageRecord)
          .filter((item): item is WritingStageTimingRecord => item != null)
      : [],
    llm,
    postWriting: {
      storyMemoryUpdateMs: numberOr(postRaw?.storyMemoryUpdateMs, 0),
      stateExtractionMs: numberOr(postRaw?.stateExtractionMs, 0),
      postWritingBlockingMs: numberOr(postRaw?.postWritingBlockingMs, 0),
      postWritingAuxiliaryCallCount: numberOr(
        postRaw?.postWritingAuxiliaryCallCount,
        0,
      ),
      postWritingAuxiliaryInputTokens: numberOr(
        postRaw?.postWritingAuxiliaryInputTokens,
        0,
      ),
      postWritingAuxiliaryOutputTokens: numberOr(
        postRaw?.postWritingAuxiliaryOutputTokens,
        0,
      ),
    },
  };
}

export function mergeWritingChapterObservability(
  existing: WritingChapterObservability | undefined,
  incoming: WritingChapterObservability | undefined,
): WritingChapterObservability | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const calls = [...existing.llm.calls];
  const seen = new Set(calls.map(callKey));
  for (const call of incoming.llm.calls) {
    const key = callKey(call);
    if (!seen.has(key)) {
      seen.add(key);
      calls.push(call);
    }
  }
  const stages = new Map(existing.stages.map(stage => [stage.stage, stage]));
  for (const stage of incoming.stages) {
    stages.set(stage.stage, stage);
  }
  return {
    ...existing,
    ...incoming,
    chapterE2EMs: Math.max(existing.chapterE2EMs, incoming.chapterE2EMs),
    context: {
      ...existing.context,
      ...incoming.context,
    },
    stages: [...stages.values()],
    llm: summarizeWritingLlmCalls(calls),
    postWriting: {
      storyMemoryUpdateMs: Math.max(
        existing.postWriting.storyMemoryUpdateMs,
        incoming.postWriting.storyMemoryUpdateMs,
      ),
      stateExtractionMs: Math.max(
        existing.postWriting.stateExtractionMs,
        incoming.postWriting.stateExtractionMs,
      ),
      postWritingBlockingMs: Math.max(
        existing.postWriting.postWritingBlockingMs,
        incoming.postWriting.postWritingBlockingMs,
      ),
      postWritingAuxiliaryCallCount:
        existing.postWriting.postWritingAuxiliaryCallCount +
        incoming.postWriting.postWritingAuxiliaryCallCount,
      postWritingAuxiliaryInputTokens:
        existing.postWriting.postWritingAuxiliaryInputTokens +
        incoming.postWriting.postWritingAuxiliaryInputTokens,
      postWritingAuxiliaryOutputTokens:
        existing.postWriting.postWritingAuxiliaryOutputTokens +
        incoming.postWriting.postWritingAuxiliaryOutputTokens,
    },
  };
}

function inferScenario(
  frozenContext: FrozenWritingContext,
): WritingRequest['scenario'] {
  const kinds = [
    ...frozenContext.sourceBundle.mandatory,
    ...frozenContext.sourceBundle.preferred,
    ...frozenContext.sourceBundle.optional,
  ].map(source => source.kind);
  if (
    kinds.includes('canon') ||
    kinds.includes('source_boundary') ||
    kinds.includes('seam')
  ) {
    return 'continuation';
  }
  return 'outline';
}

function readArtifactBody(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    const row = value as SharedWritingArtifact;
    if (typeof row.body === 'string' && row.body.trim()) return row.body.trim();
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCallRecord(raw: unknown): WritingLlmCallRecord | null {
  const row = asRecord(raw);
  if (!row) return null;
  if (
    row.kind !== 'logical_stage' &&
    row.kind !== 'formatter' &&
    row.kind !== 'post_writing_auxiliary'
  ) {
    return null;
  }
  return {
    kind: row.kind,
    stage: String(row.stage || ''),
    inputTokens: numberOr(row.inputTokens, 0),
    outputTokens: numberOr(row.outputTokens, 0),
    physicalRequestCount: numberOr(row.physicalRequestCount, 0),
    protocolFallbackCount: numberOr(row.protocolFallbackCount, 0),
    promptCacheHitTokens: nullableNumber(row.promptCacheHitTokens),
    promptCacheMissTokens: nullableNumber(row.promptCacheMissTokens),
    durationMs: numberOr(row.durationMs, 0),
  };
}

function parseStageRecord(raw: unknown): WritingStageTimingRecord | null {
  const row = asRecord(raw);
  if (!row || typeof row.stage !== 'string') return null;
  const status =
    row.status === 'skipped' ||
    row.status === 'failed' ||
    row.status === 'blocked'
      ? row.status
      : 'completed';
  return {
    stage: row.stage,
    status,
    ...(typeof row.skipReason === 'string' ? { skipReason: row.skipReason } : {}),
    ...(typeof row.policyRuleId === 'string'
      ? { policyRuleId: row.policyRuleId }
      : {}),
    stageQueuedMs: numberOr(row.stageQueuedMs, 0),
    stageExecutionMs: numberOr(row.stageExecutionMs, 0),
    stageDependencyWaitMs: numberOr(row.stageDependencyWaitMs, 0),
    stagePersistMs: numberOr(row.stagePersistMs, 0),
    projectedTokens: numberOr(row.projectedTokens, 0),
    frozenContextTokens: numberOr(row.frozenContextTokens, 0),
    artifactTokens: numberOr(row.artifactTokens, 0),
    logicalStageCallCount: numberOr(row.logicalStageCallCount, 0),
    formatterCallCount: numberOr(row.formatterCallCount, 0),
    physicalRequestCount: numberOr(row.physicalRequestCount, 0),
    protocolFallbackCount: numberOr(row.protocolFallbackCount, 0),
    inputTokens: numberOr(row.inputTokens, 0),
    outputTokens: numberOr(row.outputTokens, 0),
  };
}

function callKey(call: WritingLlmCallRecord): string {
  return [
    call.kind,
    call.stage,
    call.inputTokens,
    call.outputTokens,
    call.physicalRequestCount,
    call.protocolFallbackCount,
    call.durationMs,
  ].join(':');
}

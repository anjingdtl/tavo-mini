/**
 * Unified pipeline stage request compiler.
 *
 * All stages obtain messages through this module. Model callers must only
 * accept ReadyStageRequest (ready: true) — never ignore fits.
 */
import {
  buildReviewMessages,
  buildFactCheckMessages,
  buildProofMessages,
  buildReviewRepairMessages,
  buildFactCheckRepairMessages,
  estimateStageInputTokens,
} from '../pipelineMessages';
import {
  compileDraftPipelineRequest,
  type CompileDraftPipelineRequestResult,
} from '../draftPipelineCompiler';
import {
  allocateStageContextBudget,
  deriveDefaultSafetyMargin,
} from './budgetAllocator';
import type { ChatMessage, LLMRequestConfig } from '../llm';
import type { Chapter, Preset } from '../../types/novel';
import type {
  FactCheckContext,
  PipelineContextSnapshot,
  ProofConstraints,
  ReviewContext,
} from '../../types/pipelineContext';
import type { FrozenDraftRequest } from '../../types/pipelineFrozen';
import type { PipelineStageName } from '../../types/pipeline';
import type { PipelineError } from './types';
import { pipelineError } from './errors';
import { estimateTokens, clipTextToTokenBudget } from '../../utils/tokenEstimator';
import {
  computeFrozenDraftRequestFingerprint,
} from '../pipelineTaskContext';
import {
  checkRequestFitsContextWindow,
} from '../outlineContextBuilder';

export interface ContextAllocationTrace {
  id: string;
  requested: number;
  allocated: number;
  truncated: boolean;
}

export interface ContextBudgetDiagnostics {
  contextWindow: number;
  reservedOutputTokens: number;
  safetyMargin: number;
  estimatedInputTokens: number;
  fullOutlineTokens: number;
  mandatoryBodyTokens: number;
  fixedMessagesTokens: number;
  remainingForOptional: number;
  blockingReason: 'outline_or_body' | 'fixed_overflow' | 'final_window' | null;
}

/** Discriminated compile result — model calls require ready: true. */
export type StageCompileResult =
  | {
      ready: true;
      stage: PipelineStageName | 'draft_retry' | 'review_repair' | 'factCheck_repair';
      messages: ChatMessage[];
      estimatedInputTokens: number;
      reservedOutputTokens: number;
      safetyMargin: number;
      contextWindow: number;
      allocations: ContextAllocationTrace[];
      draftCompile?: CompileDraftPipelineRequestResult;
      frozenDraftRequest?: FrozenDraftRequest;
    }
  | {
      ready: false;
      stage: PipelineStageName | 'draft_retry' | 'review_repair' | 'factCheck_repair';
      error: PipelineError;
      diagnostics: ContextBudgetDiagnostics;
      allocations: ContextAllocationTrace[];
      messages?: ChatMessage[];
      estimatedInputTokens?: number;
      draftCompile?: CompileDraftPipelineRequestResult;
    };

/** Only Ready compile results may be passed to callLLMResult. */
export type ReadyStageRequest = Extract<StageCompileResult, { ready: true }>;

/** @deprecated Prefer StageCompileResult; kept for gradual migration. */
export type CompiledStageRequest = {
  stage: StageCompileResult['stage'];
  messages: ChatMessage[];
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  safetyMargin: number;
  contextWindow: number;
  fits: boolean;
  blockingError?: PipelineError;
  allocations: ContextAllocationTrace[];
  draftCompile?: CompileDraftPipelineRequestResult;
  ready: boolean;
};

function asLegacy(result: StageCompileResult): CompiledStageRequest {
  if (result.ready) {
    return {
      stage: result.stage,
      messages: result.messages,
      estimatedInputTokens: result.estimatedInputTokens,
      reservedOutputTokens: result.reservedOutputTokens,
      safetyMargin: result.safetyMargin,
      contextWindow: result.contextWindow,
      fits: true,
      allocations: result.allocations,
      draftCompile: result.draftCompile,
      ready: true,
    };
  }
  return {
    stage: result.stage,
    messages: result.messages || [],
    estimatedInputTokens: result.estimatedInputTokens || 0,
    reservedOutputTokens: result.diagnostics.reservedOutputTokens,
    safetyMargin: result.diagnostics.safetyMargin,
    contextWindow: result.diagnostics.contextWindow,
    fits: false,
    blockingError: result.error,
    allocations: result.allocations,
    draftCompile: result.draftCompile,
    ready: false,
  };
}

function classifyBlockingError(params: {
  stage: StageCompileResult['stage'];
  outlineTokens: number;
  fixedMessagesTokens: number;
  mandatoryBodyTokens: number;
  reservedOutputTokens: number;
  safetyMargin: number;
  contextWindow: number;
  budgetBlocking: 'outline_or_body' | 'fixed_overflow' | null;
  message: string;
}): PipelineError {
  const stageName =
    params.stage === 'review_repair'
      ? 'review'
      : params.stage === 'factCheck_repair'
        ? 'factCheck'
        : params.stage === 'draft_retry'
          ? 'draft'
          : (params.stage as any);

  // OUTLINE_TOO_LARGE only when the full outline alone (with fixed scaffold +
  // output + safety, zero body) cannot fit. No Chinese regex classification.
  const outlineAloneExceeds =
    params.outlineTokens > 0 &&
    params.fixedMessagesTokens +
      params.outlineTokens +
      params.reservedOutputTokens +
      params.safetyMargin >
      params.contextWindow;

  if (outlineAloneExceeds) {
    return pipelineError('OUTLINE_TOO_LARGE', params.message, {
      stage: stageName,
      userAction: 'open_outline',
    });
  }
  return pipelineError('CONTEXT_WINDOW_EXCEEDED', params.message, {
    stage: stageName,
    userAction: 'none',
  });
}

export async function compileDraftStageRequest(params: {
  chapter: Chapter;
  requestConfig?: LLMRequestConfig;
  draftPreset?: Preset | null;
  draftMaxTokens?: number;
  preview?: boolean;
}): Promise<StageCompileResult> {
  const compiled = await compileDraftPipelineRequest(params);
  const safetyMargin =
    compiled.safetyMargin || deriveDefaultSafetyMargin(compiled.contextWindow);
  const allocations: ContextAllocationTrace[] = [];
  if (compiled.allocations) {
    for (const [id, tokens] of Object.entries(compiled.allocations)) {
      allocations.push({
        id,
        requested: tokens,
        allocated: tokens,
        truncated: false,
      });
    }
  }

  const outlineTokens = compiled.pipelineContext.outlineEstimatedTokens || 0;
  if (!compiled.fits) {
    const reason = compiled.blockingReason || '请求超出模型上下文窗口';
    const error = classifyBlockingError({
      stage: 'draft',
      outlineTokens,
      fixedMessagesTokens: Math.max(
        0,
        compiled.estimatedInputTokens - outlineTokens,
      ),
      mandatoryBodyTokens: 0,
      reservedOutputTokens: compiled.reservedOutputTokens,
      safetyMargin,
      contextWindow: compiled.contextWindow,
      budgetBlocking: outlineTokens > 0 ? 'outline_or_body' : null,
      message: reason,
    });
    return {
      ready: false,
      stage: 'draft',
      error,
      diagnostics: {
        contextWindow: compiled.contextWindow,
        reservedOutputTokens: compiled.reservedOutputTokens,
        safetyMargin,
        estimatedInputTokens: compiled.estimatedInputTokens,
        fullOutlineTokens: outlineTokens,
        mandatoryBodyTokens: 0,
        fixedMessagesTokens: Math.max(
          0,
          compiled.estimatedInputTokens - outlineTokens,
        ),
        remainingForOptional: 0,
        blockingReason: 'final_window',
      },
      allocations,
      messages: compiled.messages,
      estimatedInputTokens: compiled.estimatedInputTokens,
      draftCompile: compiled,
    };
  }

  const frozenDraftRequest: FrozenDraftRequest = {
    messages: compiled.messages,
    estimatedInputTokens: compiled.estimatedInputTokens,
    reservedOutputTokens: compiled.reservedOutputTokens,
    safetyMargin,
    contextWindow: compiled.contextWindow,
    allocations,
    requestFingerprint: computeFrozenDraftRequestFingerprint(compiled.messages, {
      estimatedInputTokens: compiled.estimatedInputTokens,
      reservedOutputTokens: compiled.reservedOutputTokens,
      safetyMargin,
      contextWindow: compiled.contextWindow,
    }),
    chapterTitle: compiled.chapterTitle,
    prevEnding: compiled.prevEnding,
    userPrompt: compiled.userPrompt,
  };

  return {
    ready: true,
    stage: 'draft',
    messages: compiled.messages,
    estimatedInputTokens: compiled.estimatedInputTokens,
    reservedOutputTokens: compiled.reservedOutputTokens,
    safetyMargin,
    contextWindow: compiled.contextWindow,
    allocations,
    draftCompile: compiled,
    frozenDraftRequest,
  };
}

/**
 * Build a Ready/Blocked request from an already-frozen Draft request.
 * Pure: does not read SQLite / store / settings.
 */
export function compileDraftFromFrozenRequest(params: {
  frozen: FrozenDraftRequest;
  /** When set, append as an extra user message (retry instruction). */
  retryInstruction?: string;
}): StageCompileResult {
  const frozen = params.frozen;
  let messages = frozen.messages;
  if (params.retryInstruction) {
    messages = [
      ...frozen.messages,
      { role: 'user', content: params.retryInstruction },
    ];
  }
  const estimatedInputTokens = estimateStageInputTokens(messages);
  const safetyMargin =
    frozen.safetyMargin || deriveDefaultSafetyMargin(frozen.contextWindow);
  const blocking = checkRequestFitsContextWindow({
    estimatedInputTokens,
    reservedOutputTokens: frozen.reservedOutputTokens,
    contextWindow: frozen.contextWindow,
    stageLabel: params.retryInstruction ? '初稿重试' : '初稿',
  });
  if (blocking) {
    return {
      ready: false,
      stage: params.retryInstruction ? 'draft_retry' : 'draft',
      error: pipelineError('CONTEXT_WINDOW_EXCEEDED', blocking, {
        stage: 'draft',
        userAction: 'none',
      }),
      diagnostics: {
        contextWindow: frozen.contextWindow,
        reservedOutputTokens: frozen.reservedOutputTokens,
        safetyMargin,
        estimatedInputTokens,
        fullOutlineTokens: 0,
        mandatoryBodyTokens: 0,
        fixedMessagesTokens: estimatedInputTokens,
        remainingForOptional: 0,
        blockingReason: 'final_window',
      },
      allocations: frozen.allocations,
      messages,
      estimatedInputTokens,
    };
  }
  return {
    ready: true,
    stage: params.retryInstruction ? 'draft_retry' : 'draft',
    messages,
    estimatedInputTokens,
    reservedOutputTokens: frozen.reservedOutputTokens,
    safetyMargin,
    contextWindow: frozen.contextWindow,
    allocations: frozen.allocations,
    frozenDraftRequest: frozen,
  };
}

const REVIEW_OPTIONAL_WEIGHTS: Record<string, number> = {
  preset: 12,
  character: 14,
  note: 10,
  worldbook: 14,
  storyMemory: 12,
  episodic: 12,
  recentBridge: 16,
  currentInstruction: 5,
  userPrompt: 5,
};

const FACTCHECK_OPTIONAL_WEIGHTS: Record<string, number> = {
  preset: 10,
  currentInstruction: 6,
  userPrompt: 5,
  recentBridge: 16,
  storyMemory: 14,
  episodic: 16,
  worldbook: 14,
  character: 12,
  note: 7,
};

const PROOF_OPTIONAL_WEIGHTS: Record<string, number> = {
  preset: 10,
  currentInstruction: 6,
  userPrompt: 5,
  character: 12,
  worldRules: 14,
  storyState: 14,
  episodic: 12,
  note: 8,
  recentBridge: 14,
  reviewReport: 12,
  factCheckReport: 13,
};

function clipByAllocation(
  text: string,
  allocation: number,
): string {
  if (!text || allocation <= 0) return '';
  return clipTextToTokenBudget(text, allocation);
}

function allocMap(
  allocations: Array<{ id: string; allocated: number }>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of allocations) m.set(a.id, a.allocated);
  return m;
}

export function compileReviewStageRequest(params: {
  draftText: string;
  context: ReviewContext;
  maxTokens: number;
  contextWindow: number;
  repairReason?: string;
}): StageCompileResult {
  const stage = params.repairReason ? 'review_repair' : 'review';
  const outlineText = params.context.outlineText
    ? String(params.context.outlineText)
    : '';
  const outlineTokens = estimateTokens(outlineText);
  const bodyTokens = estimateTokens(params.draftText);

  // Fixed scaffold ≈ system prompt without optional partitions.
  const scaffold = params.repairReason
    ? buildReviewRepairMessages(params.draftText, emptyReviewContext(), params.repairReason)
    : buildReviewMessages(params.draftText, emptyReviewContext());
  // Partition labels / role overhead not present in empty scaffold alone.
  const PARTITION_OVERHEAD = 128;
  const fixedMessagesTokens =
    Math.max(0, estimateStageInputTokens(scaffold) - bodyTokens) +
    PARTITION_OVERHEAD;

  const optionalSections = [
    { id: 'preset', tokens: estimateTokens(params.context.presetText), weight: REVIEW_OPTIONAL_WEIGHTS.preset },
    { id: 'character', tokens: estimateTokens(params.context.characterText), weight: REVIEW_OPTIONAL_WEIGHTS.character },
    { id: 'note', tokens: estimateTokens(params.context.noteText), weight: REVIEW_OPTIONAL_WEIGHTS.note },
    { id: 'worldbook', tokens: estimateTokens(params.context.worldbookText), weight: REVIEW_OPTIONAL_WEIGHTS.worldbook },
    { id: 'storyMemory', tokens: estimateTokens(params.context.storyMemoryText), weight: REVIEW_OPTIONAL_WEIGHTS.storyMemory },
    { id: 'episodic', tokens: estimateTokens(params.context.episodicMemoryText), weight: REVIEW_OPTIONAL_WEIGHTS.episodic },
    { id: 'recentBridge', tokens: estimateTokens(params.context.recentBridgeText), weight: REVIEW_OPTIONAL_WEIGHTS.recentBridge },
    { id: 'currentInstruction', tokens: estimateTokens(params.context.currentInstructionText), weight: REVIEW_OPTIONAL_WEIGHTS.currentInstruction },
    { id: 'userPrompt', tokens: estimateTokens(params.context.retrievalUserPrompt), weight: REVIEW_OPTIONAL_WEIGHTS.userPrompt },
  ];

  const safetyMargin = deriveDefaultSafetyMargin(params.contextWindow);
  const budget = allocateStageContextBudget({
    contextWindow: params.contextWindow,
    reservedOutputTokens: params.maxTokens,
    safetyMargin,
    fixedMessagesTokens,
    fullOutlineTokens: outlineTokens,
    mandatoryBodyTokens: bodyTokens,
    optionalSections,
  });

  const am = allocMap(budget.optionalAllocations);
  const clipped: ReviewContext = {
    presetText: clipByAllocation(params.context.presetText, am.get('preset') || 0),
    characterText: clipByAllocation(params.context.characterText, am.get('character') || 0),
    noteText: clipByAllocation(params.context.noteText, am.get('note') || 0),
    worldbookText: clipByAllocation(params.context.worldbookText, am.get('worldbook') || 0),
    storyMemoryText: clipByAllocation(params.context.storyMemoryText, am.get('storyMemory') || 0),
    episodicMemoryText: clipByAllocation(params.context.episodicMemoryText, am.get('episodic') || 0),
    recentBridgeText: clipByAllocation(params.context.recentBridgeText, am.get('recentBridge') || 0),
    currentInstructionText: clipByAllocation(params.context.currentInstructionText, am.get('currentInstruction') || 0),
    retrievalUserPrompt: clipByAllocation(params.context.retrievalUserPrompt, am.get('userPrompt') || 0),
    outlineText,
  };

  const messages = params.repairReason
    ? buildReviewRepairMessages(params.draftText, clipped, params.repairReason)
    : buildReviewMessages(params.draftText, clipped);

  return finalizeCompiled({
    stage,
    messages,
    maxTokens: params.maxTokens,
    contextWindow: params.contextWindow,
    outlineTokens,
    bodyTokens,
    fixedMessagesTokens,
    budget,
    allocations: [
      { id: 'outline', requested: outlineTokens, allocated: outlineTokens, truncated: false },
      { id: 'mandatory_body', requested: bodyTokens, allocated: bodyTokens, truncated: false },
      ...budget.optionalAllocations,
    ],
  });
}

export function compileFactCheckStageRequest(params: {
  draftText: string;
  context: FactCheckContext;
  maxTokens: number;
  contextWindow: number;
  repairReason?: string;
}): StageCompileResult {
  const stage = params.repairReason ? 'factCheck_repair' : 'factCheck';
  const outlineText = params.context.outlineText
    ? String(params.context.outlineText)
    : '';
  const outlineTokens = estimateTokens(outlineText);
  const bodyTokens = estimateTokens(params.draftText);

  const scaffold = params.repairReason
    ? buildFactCheckRepairMessages(params.draftText, emptyFactCheckContext(), params.repairReason)
    : buildFactCheckMessages(params.draftText, emptyFactCheckContext());
  const PARTITION_OVERHEAD = 128;
  const fixedMessagesTokens =
    Math.max(0, estimateStageInputTokens(scaffold) - bodyTokens) +
    PARTITION_OVERHEAD;

  const optionalSections = [
    { id: 'preset', tokens: estimateTokens(params.context.presetText), weight: FACTCHECK_OPTIONAL_WEIGHTS.preset },
    { id: 'currentInstruction', tokens: estimateTokens(params.context.currentInstructionText), weight: FACTCHECK_OPTIONAL_WEIGHTS.currentInstruction },
    { id: 'userPrompt', tokens: estimateTokens(params.context.retrievalUserPrompt), weight: FACTCHECK_OPTIONAL_WEIGHTS.userPrompt },
    { id: 'recentBridge', tokens: estimateTokens(params.context.recentBridgeText), weight: FACTCHECK_OPTIONAL_WEIGHTS.recentBridge },
    { id: 'storyMemory', tokens: estimateTokens(params.context.storyMemoryText), weight: FACTCHECK_OPTIONAL_WEIGHTS.storyMemory },
    { id: 'episodic', tokens: estimateTokens(params.context.episodicMemoryText), weight: FACTCHECK_OPTIONAL_WEIGHTS.episodic },
    { id: 'worldbook', tokens: estimateTokens(params.context.worldbookText), weight: FACTCHECK_OPTIONAL_WEIGHTS.worldbook },
    { id: 'character', tokens: estimateTokens(params.context.characterText), weight: FACTCHECK_OPTIONAL_WEIGHTS.character },
    { id: 'note', tokens: estimateTokens(params.context.noteText), weight: FACTCHECK_OPTIONAL_WEIGHTS.note },
  ];

  const safetyMargin = deriveDefaultSafetyMargin(params.contextWindow);
  const budget = allocateStageContextBudget({
    contextWindow: params.contextWindow,
    reservedOutputTokens: params.maxTokens,
    safetyMargin,
    fixedMessagesTokens,
    fullOutlineTokens: outlineTokens,
    mandatoryBodyTokens: bodyTokens,
    optionalSections,
  });

  const am = allocMap(budget.optionalAllocations);
  const clipped: FactCheckContext = {
    presetText: clipByAllocation(params.context.presetText, am.get('preset') || 0),
    currentInstructionText: clipByAllocation(params.context.currentInstructionText, am.get('currentInstruction') || 0),
    retrievalUserPrompt: clipByAllocation(params.context.retrievalUserPrompt, am.get('userPrompt') || 0),
    recentBridgeText: clipByAllocation(params.context.recentBridgeText, am.get('recentBridge') || 0),
    storyMemoryText: clipByAllocation(params.context.storyMemoryText, am.get('storyMemory') || 0),
    episodicMemoryText: clipByAllocation(params.context.episodicMemoryText, am.get('episodic') || 0),
    worldbookText: clipByAllocation(params.context.worldbookText, am.get('worldbook') || 0),
    characterText: clipByAllocation(params.context.characterText, am.get('character') || 0),
    noteText: clipByAllocation(params.context.noteText, am.get('note') || 0),
    outlineText,
  };

  const messages = params.repairReason
    ? buildFactCheckRepairMessages(params.draftText, clipped, params.repairReason)
    : buildFactCheckMessages(params.draftText, clipped);

  return finalizeCompiled({
    stage,
    messages,
    maxTokens: params.maxTokens,
    contextWindow: params.contextWindow,
    outlineTokens,
    bodyTokens,
    fixedMessagesTokens,
    budget,
    allocations: [
      { id: 'outline', requested: outlineTokens, allocated: outlineTokens, truncated: false },
      { id: 'mandatory_body', requested: bodyTokens, allocated: bodyTokens, truncated: false },
      ...budget.optionalAllocations,
    ],
  });
}

export function compileProofStageRequest(params: {
  draftText: string;
  reviewText: string;
  factCheckText: string;
  constraints: ProofConstraints;
  maxTokens: number;
  contextWindow: number;
}): StageCompileResult {
  const stage = 'proof';
  const outlineText = params.constraints.outlineText
    ? String(params.constraints.outlineText)
    : '';
  const outlineTokens = estimateTokens(outlineText);
  const bodyTokens = estimateTokens(
    [params.draftText, params.reviewText, params.factCheckText].join('\n'),
  );

  const scaffold = buildProofMessages(
    params.draftText,
    params.reviewText,
    params.factCheckText,
    emptyProofConstraints(),
  );
  const PARTITION_OVERHEAD = 128;
  const fixedMessagesTokens =
    Math.max(0, estimateStageInputTokens(scaffold) - bodyTokens) +
    PARTITION_OVERHEAD;

  const optionalSections = [
    { id: 'preset', tokens: estimateTokens(params.constraints.presetText), weight: PROOF_OPTIONAL_WEIGHTS.preset },
    { id: 'currentInstruction', tokens: estimateTokens(params.constraints.currentInstructionText), weight: PROOF_OPTIONAL_WEIGHTS.currentInstruction },
    { id: 'userPrompt', tokens: estimateTokens(params.constraints.retrievalUserPrompt), weight: PROOF_OPTIONAL_WEIGHTS.userPrompt },
    { id: 'character', tokens: estimateTokens(params.constraints.relevantCharacterConstraints), weight: PROOF_OPTIONAL_WEIGHTS.character },
    { id: 'worldRules', tokens: estimateTokens(params.constraints.relevantWorldRules), weight: PROOF_OPTIONAL_WEIGHTS.worldRules },
    { id: 'storyState', tokens: estimateTokens(params.constraints.currentStoryState), weight: PROOF_OPTIONAL_WEIGHTS.storyState },
    { id: 'episodic', tokens: estimateTokens(params.constraints.episodicMemoryText), weight: PROOF_OPTIONAL_WEIGHTS.episodic },
    { id: 'note', tokens: estimateTokens(params.constraints.noteText), weight: PROOF_OPTIONAL_WEIGHTS.note },
    { id: 'recentBridge', tokens: estimateTokens(params.constraints.recentBridgeText), weight: PROOF_OPTIONAL_WEIGHTS.recentBridge },
  ];

  const safetyMargin = deriveDefaultSafetyMargin(params.contextWindow);
  const budget = allocateStageContextBudget({
    contextWindow: params.contextWindow,
    reservedOutputTokens: params.maxTokens,
    safetyMargin,
    fixedMessagesTokens,
    fullOutlineTokens: outlineTokens,
    mandatoryBodyTokens: bodyTokens,
    optionalSections,
  });

  const am = allocMap(budget.optionalAllocations);
  const clipped: ProofConstraints = {
    presetText: clipByAllocation(params.constraints.presetText, am.get('preset') || 0),
    currentInstructionText: clipByAllocation(params.constraints.currentInstructionText, am.get('currentInstruction') || 0),
    retrievalUserPrompt: clipByAllocation(params.constraints.retrievalUserPrompt, am.get('userPrompt') || 0),
    relevantCharacterConstraints: clipByAllocation(params.constraints.relevantCharacterConstraints, am.get('character') || 0),
    relevantWorldRules: clipByAllocation(params.constraints.relevantWorldRules, am.get('worldRules') || 0),
    currentStoryState: clipByAllocation(params.constraints.currentStoryState, am.get('storyState') || 0),
    episodicMemoryText: clipByAllocation(params.constraints.episodicMemoryText, am.get('episodic') || 0),
    noteText: clipByAllocation(params.constraints.noteText, am.get('note') || 0),
    recentBridgeText: clipByAllocation(params.constraints.recentBridgeText, am.get('recentBridge') || 0),
    outlineText,
  };

  const messages = buildProofMessages(
    params.draftText,
    params.reviewText,
    params.factCheckText,
    clipped,
  );

  return finalizeCompiled({
    stage,
    messages,
    maxTokens: params.maxTokens,
    contextWindow: params.contextWindow,
    outlineTokens,
    bodyTokens,
    fixedMessagesTokens,
    budget,
    allocations: [
      { id: 'outline', requested: outlineTokens, allocated: outlineTokens, truncated: false },
      { id: 'mandatory_body', requested: bodyTokens, allocated: bodyTokens, truncated: false },
      ...budget.optionalAllocations,
    ],
  });
}

/**
 * Facade used by reconcile / preview for any non-draft stage.
 */
export function compilePipelineStageRequest(params: {
  stage: PipelineStageName;
  draftText?: string;
  reviewText?: string;
  factCheckText?: string;
  reviewContext?: ReviewContext;
  factCheckContext?: FactCheckContext;
  proofConstraints?: ProofConstraints;
  maxTokens: number;
  contextWindow: number;
  repairReason?: string;
}): StageCompileResult {
  if (params.stage === 'review') {
    return compileReviewStageRequest({
      draftText: params.draftText || '',
      context: params.reviewContext || emptyReviewContext(),
      maxTokens: params.maxTokens,
      contextWindow: params.contextWindow,
      repairReason: params.repairReason,
    });
  }
  if (params.stage === 'factCheck') {
    return compileFactCheckStageRequest({
      draftText: params.draftText || '',
      context: params.factCheckContext || emptyFactCheckContext(),
      maxTokens: params.maxTokens,
      contextWindow: params.contextWindow,
      repairReason: params.repairReason,
    });
  }
  if (params.stage === 'proof') {
    return compileProofStageRequest({
      draftText: params.draftText || '',
      reviewText: params.reviewText || '',
      factCheckText: params.factCheckText || '',
      constraints: params.proofConstraints || emptyProofConstraints(),
      maxTokens: params.maxTokens,
      contextWindow: params.contextWindow,
    });
  }
  throw new Error('compilePipelineStageRequest: use compileDraftStageRequest for draft');
}

function finalizeCompiled(params: {
  stage: StageCompileResult['stage'];
  messages: ChatMessage[];
  maxTokens: number;
  contextWindow: number;
  outlineTokens: number;
  bodyTokens: number;
  fixedMessagesTokens: number;
  budget: ReturnType<typeof allocateStageContextBudget>;
  allocations: ContextAllocationTrace[];
}): StageCompileResult {
  let messages = params.messages;
  let estimatedInputTokens = estimateStageInputTokens(messages);
  const safetyMargin = params.budget.safetyMargin;
  const limit =
    params.contextWindow - params.maxTokens - safetyMargin;

  // If final assembly slightly overshoots (label overhead), trim optional user
  // content once rather than calling the model over window.
  if (
    params.budget.fitsMandatory &&
    limit > 0 &&
    estimatedInputTokens > limit
  ) {
    const overshoot = estimatedInputTokens - limit;
    messages = messages.map(m => {
      if (m.role !== 'user' && m.role !== 'system') return m;
      // Prefer trimming the larger user payload (context partitions).
      const target = Math.max(
        0,
        estimateTokens(m.content) - overshoot - 32,
      );
      if (target <= 0 || estimateTokens(m.content) < 200) return m;
      return {
        ...m,
        content: clipTextToTokenBudget(m.content, target),
      };
    });
    estimatedInputTokens = estimateStageInputTokens(messages);
  }

  const finalFits =
    estimatedInputTokens + params.maxTokens + safetyMargin <=
    params.contextWindow;
  const fits = finalFits && params.budget.fitsMandatory;

  if (!fits) {
    const message = !params.budget.fitsMandatory
      ? params.budget.blockingReason === 'fixed_overflow'
        ? '固定 Prompt 与输出预留无法放入模型窗口'
        : '完整大纲与阶段必需正文无法放入模型窗口'
      : '阶段请求超出模型上下文窗口';
    return {
      ready: false,
      stage: params.stage,
      error: classifyBlockingError({
        stage: params.stage,
        outlineTokens: params.outlineTokens,
        fixedMessagesTokens: params.fixedMessagesTokens,
        mandatoryBodyTokens: params.bodyTokens,
        reservedOutputTokens: params.maxTokens,
        safetyMargin,
        contextWindow: params.contextWindow,
        budgetBlocking: params.budget.blockingReason,
        message,
      }),
      diagnostics: {
        contextWindow: params.contextWindow,
        reservedOutputTokens: params.maxTokens,
        safetyMargin,
        estimatedInputTokens,
        fullOutlineTokens: params.outlineTokens,
        mandatoryBodyTokens: params.bodyTokens,
        fixedMessagesTokens: params.fixedMessagesTokens,
        remainingForOptional: params.budget.remainingForOptional,
        blockingReason: params.budget.fitsMandatory
          ? 'final_window'
          : params.budget.blockingReason,
      },
      allocations: params.allocations,
      messages,
      estimatedInputTokens,
    };
  }

  return {
    ready: true,
    stage: params.stage,
    messages,
    estimatedInputTokens,
    reservedOutputTokens: params.maxTokens,
    safetyMargin,
    contextWindow: params.contextWindow,
    allocations: params.allocations,
  };
}

function emptyReviewContext(): ReviewContext {
  return {
    presetText: '',
    characterText: '',
    noteText: '',
    worldbookText: '',
    storyMemoryText: '',
    episodicMemoryText: '',
    recentBridgeText: '',
    currentInstructionText: '',
    retrievalUserPrompt: '',
    outlineText: '',
  };
}

function emptyFactCheckContext(): FactCheckContext {
  return {
    presetText: '',
    currentInstructionText: '',
    retrievalUserPrompt: '',
    recentBridgeText: '',
    storyMemoryText: '',
    episodicMemoryText: '',
    worldbookText: '',
    characterText: '',
    noteText: '',
    outlineText: '',
  };
}

function emptyProofConstraints(): ProofConstraints {
  return {
    presetText: '',
    currentInstructionText: '',
    retrievalUserPrompt: '',
    relevantCharacterConstraints: '',
    relevantWorldRules: '',
    currentStoryState: '',
    episodicMemoryText: '',
    noteText: '',
    recentBridgeText: '',
    outlineText: '',
  };
}

/** Assert helper for model callers. */
export function requireReadyStageRequest(
  compiled: StageCompileResult,
): ReadyStageRequest {
  if (!compiled.ready) {
    const err = new Error(compiled.error.message) as Error & {
      code?: string;
      pipelineError?: PipelineError;
    };
    err.code = compiled.error.code;
    err.pipelineError = compiled.error;
    throw err;
  }
  return compiled;
}

// Re-export for callers that freeze draft context.
export type { PipelineContextSnapshot };
export { asLegacy };

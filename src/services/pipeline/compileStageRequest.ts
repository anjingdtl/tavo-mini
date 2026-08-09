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
  buildReviewV2Messages,
  buildFactCheckV2Messages,
  buildReviewV2RepairMessages,
  buildFactCheckV2RepairMessages,
  buildFinalReviserMessages,
  buildFinalReviserV3Messages,
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
import {
  compileStageRequestWithElasticBudget,
  type ElasticStageModule,
} from './elasticStageCompiler';
import type { ElasticBudgetTrace } from './elasticBudgetAllocator';
import type { ChatMessage, LLMRequestConfig } from '../llm';
import type { Chapter, Preset } from '../../types/novel';
import type {
  FactCheckContext,
  PipelineContextSnapshot,
  ProofConstraints,
  FinalContinuityCapsule,
  ReviewContext,
} from '../../types/pipelineContext';
import type { FrozenDraftRequest } from '../../types/pipelineFrozen';
import type { PipelineStageName } from '../../types/pipeline';
import type { PipelineError } from './types';
import { pipelineError } from './errors';
import {
  estimateTokens,
  clipTextToTokenBudget,
} from '../../utils/tokenEstimator';
import { computeFrozenDraftRequestFingerprint } from '../pipelineTaskContext';
import { checkRequestFitsContextWindow } from '../outlineContextBuilder';

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
      stage:
        | PipelineStageName
        | 'draft_retry'
        | 'review_repair'
        | 'factCheck_repair';
      messages: ChatMessage[];
      estimatedInputTokens: number;
      reservedOutputTokens: number;
      safetyMargin: number;
      contextWindow: number;
      allocations: ContextAllocationTrace[];
      draftCompile?: CompileDraftPipelineRequestResult;
      frozenDraftRequest?: FrozenDraftRequest;
      /** Phase 2+ elastic budget trace when elasticBudget is enabled. */
      elasticBudgetTrace?: ElasticBudgetTrace;
    }
  | {
      ready: false;
      stage:
        | PipelineStageName
        | 'draft_retry'
        | 'review_repair'
        | 'factCheck_repair';
      error: PipelineError;
      diagnostics: ContextBudgetDiagnostics;
      allocations: ContextAllocationTrace[];
      messages?: ChatMessage[];
      estimatedInputTokens?: number;
      draftCompile?: CompileDraftPipelineRequestResult;
      /** Phase 2+ elastic budget trace when elasticBudget is enabled. */
      elasticBudgetTrace?: ElasticBudgetTrace;
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
  storyMemoryMode?: 'generation' | 'preview';
  elasticBudget?: boolean;
}): Promise<StageCompileResult> {
  const compiled = await compileDraftPipelineRequest({
    ...params,
    elasticBudget: params.elasticBudget,
  });
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
    requestFingerprint: computeFrozenDraftRequestFingerprint(
      compiled.messages,
      {
        estimatedInputTokens: compiled.estimatedInputTokens,
        reservedOutputTokens: compiled.reservedOutputTokens,
        safetyMargin,
        contextWindow: compiled.contextWindow,
      },
    ),
    chapterTitle: compiled.chapterTitle,
    prevEnding: compiled.prevEnding,
    userPrompt: compiled.userPrompt,
    elasticBudgetTrace: compiled.elasticBudgetTrace,
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
    elasticBudgetTrace: compiled.elasticBudgetTrace,
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

function clipByAllocation(text: string, allocation: number): string {
  if (!text || allocation <= 0) return '';
  return clipTextToTokenBudget(text, allocation);
}

/**
 * Mandatory allocation ids — these are NEVER reduced by the final-window
 * shrink loop. Only optional sections (preset/character/worldbook/note/
 * storyMemory/episodic/recentBridge/currentInstruction/userPrompt/
 * worldRules/storyState/reviewReport/factCheckReport) may be shortened.
 */
const MANDATORY_ALLOCATION_IDS = new Set(['outline', 'mandatory_body']);

/**
 * Reduce ONLY optional allocations to recover at least `reductionTokens`.
 * Heuristic: reclaim from the largest-reclaimable optional section first,
 * ties broken by lower business weight already encoded in the id ordering
 * (heaviest reclaimable wins). Mutates `allocations` in place. Returns
 * true when any allocation actually changed (false when nothing left to
 * reclaim — caller should then declare Blocked).
 *
 * Invariants preserved:
 *   - allocated >= 0
 *   - allocated <= requested
 *   - mandatory ids (outline / mandatory_body) are never touched
 *   - sum(allocated) stays conserved/monotone-non-increasing
 */
export function shrinkOptionalAllocations(
  allocations: ContextAllocationTrace[],
  reductionTokens: number,
): boolean {
  if (reductionTokens <= 0) return false;
  let remaining = Math.ceil(reductionTokens);
  let changed = false;
  // Sort a WORKING INDEX of optional sections by reclaimable tokens
  // descending so the shrink loop recovers from the biggest offenders
  // first. We iterate over indices so we can mutate `allocations` in place.
  const optionalIndices = allocations
    .map((a, idx) => ({ idx, reclaimable: Math.max(0, a.allocated) }))
    .filter(e => !MANDATORY_ALLOCATION_IDS.has(allocations[e.idx].id))
    .sort((a, b) => b.reclaimable - a.reclaimable);

  for (const { idx } of optionalIndices) {
    if (remaining <= 0) break;
    const entry = allocations[idx];
    const reclaim = Math.min(entry.allocated, remaining);
    if (reclaim <= 0) continue;
    entry.allocated = Math.max(0, entry.allocated - reclaim);
    entry.truncated = entry.allocated < entry.requested || entry.truncated;
    remaining -= reclaim;
    changed = true;
  }
  return changed;
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
  elasticBudget?: boolean;
}): StageCompileResult {
  if (params.elasticBudget) {
    return compileReviewWithElasticBudget(params);
  }
  const stage = params.repairReason ? 'review_repair' : 'review';
  const outlineText = params.context.outlineText
    ? String(params.context.outlineText)
    : '';
  const outlineTokens = estimateTokens(outlineText);
  const bodyTokens = estimateTokens(params.draftText);

  // Fixed scaffold ≈ system prompt without optional partitions.
  const scaffold = params.repairReason
    ? buildReviewRepairMessages(
        params.draftText,
        emptyReviewContext(),
        params.repairReason,
      )
    : buildReviewMessages(params.draftText, emptyReviewContext());
  // Partition labels / role overhead not present in empty scaffold alone.
  const PARTITION_OVERHEAD = 128;
  const fixedMessagesTokens =
    Math.max(0, estimateStageInputTokens(scaffold) - bodyTokens) +
    PARTITION_OVERHEAD;

  const optionalSections = [
    {
      id: 'preset',
      tokens: estimateTokens(params.context.presetText),
      weight: REVIEW_OPTIONAL_WEIGHTS.preset,
    },
    {
      id: 'character',
      tokens: estimateTokens(params.context.characterText),
      weight: REVIEW_OPTIONAL_WEIGHTS.character,
    },
    {
      id: 'note',
      tokens: estimateTokens(params.context.noteText),
      weight: REVIEW_OPTIONAL_WEIGHTS.note,
    },
    {
      id: 'worldbook',
      tokens: estimateTokens(params.context.worldbookText),
      weight: REVIEW_OPTIONAL_WEIGHTS.worldbook,
    },
    {
      id: 'storyMemory',
      tokens: estimateTokens(params.context.storyMemoryText),
      weight: REVIEW_OPTIONAL_WEIGHTS.storyMemory,
    },
    {
      id: 'episodic',
      tokens: estimateTokens(params.context.episodicMemoryText),
      weight: REVIEW_OPTIONAL_WEIGHTS.episodic,
    },
    {
      id: 'recentBridge',
      tokens: estimateTokens(params.context.recentBridgeText),
      weight: REVIEW_OPTIONAL_WEIGHTS.recentBridge,
    },
    {
      id: 'currentInstruction',
      tokens: estimateTokens(params.context.currentInstructionText),
      weight: REVIEW_OPTIONAL_WEIGHTS.currentInstruction,
    },
    {
      id: 'userPrompt',
      tokens: estimateTokens(params.context.retrievalUserPrompt),
      weight: REVIEW_OPTIONAL_WEIGHTS.userPrompt,
    },
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
    presetText: clipByAllocation(
      params.context.presetText,
      am.get('preset') || 0,
    ),
    characterText: clipByAllocation(
      params.context.characterText,
      am.get('character') || 0,
    ),
    noteText: clipByAllocation(params.context.noteText, am.get('note') || 0),
    worldbookText: clipByAllocation(
      params.context.worldbookText,
      am.get('worldbook') || 0,
    ),
    storyMemoryText: clipByAllocation(
      params.context.storyMemoryText,
      am.get('storyMemory') || 0,
    ),
    episodicMemoryText: clipByAllocation(
      params.context.episodicMemoryText,
      am.get('episodic') || 0,
    ),
    recentBridgeText: clipByAllocation(
      params.context.recentBridgeText,
      am.get('recentBridge') || 0,
    ),
    currentInstructionText: clipByAllocation(
      params.context.currentInstructionText,
      am.get('currentInstruction') || 0,
    ),
    retrievalUserPrompt: clipByAllocation(
      params.context.retrievalUserPrompt,
      am.get('userPrompt') || 0,
    ),
    outlineText,
  };

  // Rebuild closure used by finalizeCompiled's shrink loop: given an
  // updated allocation list, re-clip ONLY optional fields (outline + draft
  // body are mandatory and never clipped here) and reconstruct messages.
  const rebuild = (allocations: ContextAllocationTrace[]): ChatMessage[] => {
    const m = allocMap(allocations);
    const ctx: ReviewContext = {
      presetText: clipByAllocation(
        params.context.presetText,
        m.get('preset') || 0,
      ),
      characterText: clipByAllocation(
        params.context.characterText,
        m.get('character') || 0,
      ),
      noteText: clipByAllocation(params.context.noteText, m.get('note') || 0),
      worldbookText: clipByAllocation(
        params.context.worldbookText,
        m.get('worldbook') || 0,
      ),
      storyMemoryText: clipByAllocation(
        params.context.storyMemoryText,
        m.get('storyMemory') || 0,
      ),
      episodicMemoryText: clipByAllocation(
        params.context.episodicMemoryText,
        m.get('episodic') || 0,
      ),
      recentBridgeText: clipByAllocation(
        params.context.recentBridgeText,
        m.get('recentBridge') || 0,
      ),
      currentInstructionText: clipByAllocation(
        params.context.currentInstructionText,
        m.get('currentInstruction') || 0,
      ),
      retrievalUserPrompt: clipByAllocation(
        params.context.retrievalUserPrompt,
        m.get('userPrompt') || 0,
      ),
      outlineText,
    };
    return params.repairReason
      ? buildReviewRepairMessages(params.draftText, ctx, params.repairReason)
      : buildReviewMessages(params.draftText, ctx);
  };

  return finalizeCompiled({
    stage,
    messages: params.repairReason
      ? buildReviewRepairMessages(
          params.draftText,
          clipped,
          params.repairReason,
        )
      : buildReviewMessages(params.draftText, clipped),
    maxTokens: params.maxTokens,
    contextWindow: params.contextWindow,
    outlineTokens,
    bodyTokens,
    fixedMessagesTokens,
    budget,
    allocations: [
      {
        id: 'outline',
        requested: outlineTokens,
        allocated: outlineTokens,
        truncated: false,
      },
      {
        id: 'mandatory_body',
        requested: bodyTokens,
        allocated: bodyTokens,
        truncated: false,
      },
      ...budget.optionalAllocations,
    ],
    rebuild,
  });
}

/**
 * Elastic-budget variant of compileReviewStageRequest (Phase 2).
 * Mandatory: full outline + draft body (verbatim). Elastic modules follow
 * the doc §19 Review priority: recent bridge / story memory / key characters
 * / key world rules are preferred; episodic / notes / preset / instruction
 * blocks are optional.
 */
function compileReviewWithElasticBudget(params: {
  draftText: string;
  context: ReviewContext;
  maxTokens: number;
  contextWindow: number;
  repairReason?: string;
}): StageCompileResult {
  const stage = params.repairReason ? 'review_repair' : 'review';
  const outlineText = String(params.context.outlineText || '');
  const mandatoryModules: ElasticStageModule[] = [
    {
      id: 'outline',
      text: outlineText,
      requirement: 'mandatory',
      priority: 10,
      relevance: 1,
    },
    {
      id: 'mandatory_body',
      text: params.draftText,
      requirement: 'mandatory',
      priority: 10,
      relevance: 1,
    },
  ];
  const elasticModules: ElasticStageModule[] = [
    {
      id: 'recentBridge',
      text: params.context.recentBridgeText,
      requirement: 'preferred',
      priority: 8,
      relevance: 0.9,
    },
    {
      id: 'storyMemory',
      text: params.context.storyMemoryText,
      requirement: 'preferred',
      priority: 7,
      relevance: 0.85,
    },
    {
      id: 'character',
      text: params.context.characterText,
      requirement: 'preferred',
      priority: 6,
      relevance: 0.8,
    },
    {
      id: 'worldbook',
      text: params.context.worldbookText,
      requirement: 'preferred',
      priority: 6,
      relevance: 0.8,
    },
    {
      id: 'episodic',
      text: params.context.episodicMemoryText,
      requirement: 'optional',
      priority: 4,
      relevance: 0.6,
    },
    {
      id: 'note',
      text: params.context.noteText,
      requirement: 'optional',
      priority: 3,
      relevance: 0.5,
    },
    {
      id: 'preset',
      text: params.context.presetText,
      requirement: 'optional',
      priority: 3,
      relevance: 0.5,
    },
    {
      id: 'currentInstruction',
      text: params.context.currentInstructionText,
      requirement: 'optional',
      priority: 2,
      relevance: 0.5,
    },
    {
      id: 'userPrompt',
      text: params.context.retrievalUserPrompt,
      requirement: 'optional',
      priority: 2,
      relevance: 0.5,
    },
  ];
  return compileStageRequestWithElasticBudget({
    stage,
    contextWindow: params.contextWindow,
    reservedOutputTokens: params.maxTokens,
    mandatoryModules,
    elasticModules,
    buildMessages: clipped => {
      const ctx: ReviewContext = {
        presetText: clipped.get('preset') || '',
        characterText: clipped.get('character') || '',
        noteText: clipped.get('note') || '',
        worldbookText: clipped.get('worldbook') || '',
        storyMemoryText: clipped.get('storyMemory') || '',
        episodicMemoryText: clipped.get('episodic') || '',
        recentBridgeText: clipped.get('recentBridge') || '',
        currentInstructionText: clipped.get('currentInstruction') || '',
        retrievalUserPrompt: clipped.get('userPrompt') || '',
        outlineText,
      };
      return params.repairReason
        ? buildReviewRepairMessages(params.draftText, ctx, params.repairReason)
        : buildReviewMessages(params.draftText, ctx);
    },
  });
}

export function compileFactCheckStageRequest(params: {
  draftText: string;
  context: FactCheckContext;
  maxTokens: number;
  contextWindow: number;
  repairReason?: string;
  elasticBudget?: boolean;
}): StageCompileResult {
  if (params.elasticBudget) {
    return compileFactCheckWithElasticBudget(params);
  }
  const stage = params.repairReason ? 'factCheck_repair' : 'factCheck';
  const outlineText = params.context.outlineText
    ? String(params.context.outlineText)
    : '';
  const outlineTokens = estimateTokens(outlineText);
  const bodyTokens = estimateTokens(params.draftText);

  const scaffold = params.repairReason
    ? buildFactCheckRepairMessages(
        params.draftText,
        emptyFactCheckContext(),
        params.repairReason,
      )
    : buildFactCheckMessages(params.draftText, emptyFactCheckContext());
  const PARTITION_OVERHEAD = 128;
  const fixedMessagesTokens =
    Math.max(0, estimateStageInputTokens(scaffold) - bodyTokens) +
    PARTITION_OVERHEAD;

  const optionalSections = [
    {
      id: 'preset',
      tokens: estimateTokens(params.context.presetText),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.preset,
    },
    {
      id: 'currentInstruction',
      tokens: estimateTokens(params.context.currentInstructionText),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.currentInstruction,
    },
    {
      id: 'userPrompt',
      tokens: estimateTokens(params.context.retrievalUserPrompt),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.userPrompt,
    },
    {
      id: 'recentBridge',
      tokens: estimateTokens(params.context.recentBridgeText),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.recentBridge,
    },
    {
      id: 'storyMemory',
      tokens: estimateTokens(params.context.storyMemoryText),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.storyMemory,
    },
    {
      id: 'episodic',
      tokens: estimateTokens(params.context.episodicMemoryText),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.episodic,
    },
    {
      id: 'worldbook',
      tokens: estimateTokens(params.context.worldbookText),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.worldbook,
    },
    {
      id: 'character',
      tokens: estimateTokens(params.context.characterText),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.character,
    },
    {
      id: 'note',
      tokens: estimateTokens(params.context.noteText),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.note,
    },
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
    presetText: clipByAllocation(
      params.context.presetText,
      am.get('preset') || 0,
    ),
    currentInstructionText: clipByAllocation(
      params.context.currentInstructionText,
      am.get('currentInstruction') || 0,
    ),
    retrievalUserPrompt: clipByAllocation(
      params.context.retrievalUserPrompt,
      am.get('userPrompt') || 0,
    ),
    recentBridgeText: clipByAllocation(
      params.context.recentBridgeText,
      am.get('recentBridge') || 0,
    ),
    storyMemoryText: clipByAllocation(
      params.context.storyMemoryText,
      am.get('storyMemory') || 0,
    ),
    episodicMemoryText: clipByAllocation(
      params.context.episodicMemoryText,
      am.get('episodic') || 0,
    ),
    worldbookText: clipByAllocation(
      params.context.worldbookText,
      am.get('worldbook') || 0,
    ),
    characterText: clipByAllocation(
      params.context.characterText,
      am.get('character') || 0,
    ),
    noteText: clipByAllocation(params.context.noteText, am.get('note') || 0),
    outlineText,
  };

  // Rebuild closure for finalizeCompiled's shrink loop: only optional
  // fields are re-clipped; outline + draft body stay mandatory.
  const rebuild = (allocations: ContextAllocationTrace[]): ChatMessage[] => {
    const m = allocMap(allocations);
    const ctx: FactCheckContext = {
      presetText: clipByAllocation(
        params.context.presetText,
        m.get('preset') || 0,
      ),
      currentInstructionText: clipByAllocation(
        params.context.currentInstructionText,
        m.get('currentInstruction') || 0,
      ),
      retrievalUserPrompt: clipByAllocation(
        params.context.retrievalUserPrompt,
        m.get('userPrompt') || 0,
      ),
      recentBridgeText: clipByAllocation(
        params.context.recentBridgeText,
        m.get('recentBridge') || 0,
      ),
      storyMemoryText: clipByAllocation(
        params.context.storyMemoryText,
        m.get('storyMemory') || 0,
      ),
      episodicMemoryText: clipByAllocation(
        params.context.episodicMemoryText,
        m.get('episodic') || 0,
      ),
      worldbookText: clipByAllocation(
        params.context.worldbookText,
        m.get('worldbook') || 0,
      ),
      characterText: clipByAllocation(
        params.context.characterText,
        m.get('character') || 0,
      ),
      noteText: clipByAllocation(params.context.noteText, m.get('note') || 0),
      outlineText,
    };
    return params.repairReason
      ? buildFactCheckRepairMessages(params.draftText, ctx, params.repairReason)
      : buildFactCheckMessages(params.draftText, ctx);
  };

  return finalizeCompiled({
    stage,
    messages: params.repairReason
      ? buildFactCheckRepairMessages(
          params.draftText,
          clipped,
          params.repairReason,
        )
      : buildFactCheckMessages(params.draftText, clipped),
    maxTokens: params.maxTokens,
    contextWindow: params.contextWindow,
    outlineTokens,
    bodyTokens,
    fixedMessagesTokens,
    budget,
    allocations: [
      {
        id: 'outline',
        requested: outlineTokens,
        allocated: outlineTokens,
        truncated: false,
      },
      {
        id: 'mandatory_body',
        requested: bodyTokens,
        allocated: bodyTokens,
        truncated: false,
      },
      ...budget.optionalAllocations,
    ],
    rebuild,
  });
}

/**
 * Elastic-budget variant of compileFactCheckStageRequest (Phase 2).
 * Mandatory: full outline + draft body. Elastic: character facts / world
 * rules / story memory / recent bridge are preferred; episodic / notes /
 * preset / instruction blocks are optional.
 */
function compileFactCheckWithElasticBudget(params: {
  draftText: string;
  context: FactCheckContext;
  maxTokens: number;
  contextWindow: number;
  repairReason?: string;
}): StageCompileResult {
  const stage = params.repairReason ? 'factCheck_repair' : 'factCheck';
  const outlineText = String(params.context.outlineText || '');
  const mandatoryModules: ElasticStageModule[] = [
    {
      id: 'outline',
      text: outlineText,
      requirement: 'mandatory',
      priority: 10,
      relevance: 1,
    },
    {
      id: 'mandatory_body',
      text: params.draftText,
      requirement: 'mandatory',
      priority: 10,
      relevance: 1,
    },
  ];
  const elasticModules: ElasticStageModule[] = [
    {
      id: 'recentBridge',
      text: params.context.recentBridgeText,
      requirement: 'preferred',
      priority: 8,
      relevance: 0.9,
    },
    {
      id: 'storyMemory',
      text: params.context.storyMemoryText,
      requirement: 'preferred',
      priority: 7,
      relevance: 0.85,
    },
    {
      id: 'character',
      text: params.context.characterText,
      requirement: 'preferred',
      priority: 6,
      relevance: 0.8,
    },
    {
      id: 'worldbook',
      text: params.context.worldbookText,
      requirement: 'preferred',
      priority: 6,
      relevance: 0.8,
    },
    {
      id: 'episodic',
      text: params.context.episodicMemoryText,
      requirement: 'optional',
      priority: 4,
      relevance: 0.6,
    },
    {
      id: 'note',
      text: params.context.noteText,
      requirement: 'optional',
      priority: 3,
      relevance: 0.5,
    },
    {
      id: 'preset',
      text: params.context.presetText,
      requirement: 'optional',
      priority: 3,
      relevance: 0.5,
    },
    {
      id: 'currentInstruction',
      text: params.context.currentInstructionText,
      requirement: 'optional',
      priority: 2,
      relevance: 0.5,
    },
    {
      id: 'userPrompt',
      text: params.context.retrievalUserPrompt,
      requirement: 'optional',
      priority: 2,
      relevance: 0.5,
    },
  ];
  return compileStageRequestWithElasticBudget({
    stage,
    contextWindow: params.contextWindow,
    reservedOutputTokens: params.maxTokens,
    mandatoryModules,
    elasticModules,
    buildMessages: clipped => {
      const ctx: FactCheckContext = {
        presetText: clipped.get('preset') || '',
        currentInstructionText: clipped.get('currentInstruction') || '',
        retrievalUserPrompt: clipped.get('userPrompt') || '',
        recentBridgeText: clipped.get('recentBridge') || '',
        storyMemoryText: clipped.get('storyMemory') || '',
        episodicMemoryText: clipped.get('episodic') || '',
        worldbookText: clipped.get('worldbook') || '',
        characterText: clipped.get('character') || '',
        noteText: clipped.get('note') || '',
        outlineText,
      };
      return params.repairReason
        ? buildFactCheckRepairMessages(
            params.draftText,
            ctx,
            params.repairReason,
          )
        : buildFactCheckMessages(params.draftText, ctx);
    },
  });
}

/**
 * Review V2 (anchored) compiler — workflow version 2 only.
 *
 * Body is the SINGLE tagged-draft injection (§5.5). Optional context sections
 * are clipped by the same conservation allocator; outline stays mandatory and
 * verbatim. Pure function (0 LLM / 0 DB) so resume reconstructs the exact
 * same request from persisted draft + anchors.
 */
export function compileReviewV2StageRequest(params: {
  taggedDraft: string;
  context: ReviewContext;
  draftHash: string;
  maxTokens: number;
  contextWindow: number;
  repairReason?: string;
  elasticBudget?: boolean;
}): StageCompileResult {
  if (params.elasticBudget) {
    return compileReviewV2WithElasticBudget(params);
  }
  const stage = params.repairReason ? 'review_repair' : 'review';
  const outlineText = params.context.outlineText
    ? String(params.context.outlineText)
    : '';
  const outlineTokens = estimateTokens(outlineText);
  const bodyTokens = estimateTokens(params.taggedDraft);

  const scaffold = params.repairReason
    ? buildReviewV2RepairMessages({
        taggedDraft: params.taggedDraft,
        context: emptyReviewContext(),
        draftHash: params.draftHash,
        failureReason: params.repairReason,
      })
    : buildReviewV2Messages({
        taggedDraft: params.taggedDraft,
        context: emptyReviewContext(),
        draftHash: params.draftHash,
      });
  const PARTITION_OVERHEAD = 128;
  const fixedMessagesTokens =
    Math.max(0, estimateStageInputTokens(scaffold) - bodyTokens) +
    PARTITION_OVERHEAD;

  const optionalSections = [
    {
      id: 'preset',
      tokens: estimateTokens(params.context.presetText),
      weight: REVIEW_OPTIONAL_WEIGHTS.preset,
    },
    {
      id: 'character',
      tokens: estimateTokens(params.context.characterText),
      weight: REVIEW_OPTIONAL_WEIGHTS.character,
    },
    {
      id: 'note',
      tokens: estimateTokens(params.context.noteText),
      weight: REVIEW_OPTIONAL_WEIGHTS.note,
    },
    {
      id: 'worldbook',
      tokens: estimateTokens(params.context.worldbookText),
      weight: REVIEW_OPTIONAL_WEIGHTS.worldbook,
    },
    {
      id: 'storyMemory',
      tokens: estimateTokens(params.context.storyMemoryText),
      weight: REVIEW_OPTIONAL_WEIGHTS.storyMemory,
    },
    {
      id: 'episodic',
      tokens: estimateTokens(params.context.episodicMemoryText),
      weight: REVIEW_OPTIONAL_WEIGHTS.episodic,
    },
    {
      id: 'recentBridge',
      tokens: estimateTokens(params.context.recentBridgeText),
      weight: REVIEW_OPTIONAL_WEIGHTS.recentBridge,
    },
    {
      id: 'currentInstruction',
      tokens: estimateTokens(params.context.currentInstructionText),
      weight: REVIEW_OPTIONAL_WEIGHTS.currentInstruction,
    },
    {
      id: 'userPrompt',
      tokens: estimateTokens(params.context.retrievalUserPrompt),
      weight: REVIEW_OPTIONAL_WEIGHTS.userPrompt,
    },
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
    presetText: clipByAllocation(
      params.context.presetText,
      am.get('preset') || 0,
    ),
    characterText: clipByAllocation(
      params.context.characterText,
      am.get('character') || 0,
    ),
    noteText: clipByAllocation(params.context.noteText, am.get('note') || 0),
    worldbookText: clipByAllocation(
      params.context.worldbookText,
      am.get('worldbook') || 0,
    ),
    storyMemoryText: clipByAllocation(
      params.context.storyMemoryText,
      am.get('storyMemory') || 0,
    ),
    episodicMemoryText: clipByAllocation(
      params.context.episodicMemoryText,
      am.get('episodic') || 0,
    ),
    recentBridgeText: clipByAllocation(
      params.context.recentBridgeText,
      am.get('recentBridge') || 0,
    ),
    currentInstructionText: clipByAllocation(
      params.context.currentInstructionText,
      am.get('currentInstruction') || 0,
    ),
    retrievalUserPrompt: clipByAllocation(
      params.context.retrievalUserPrompt,
      am.get('userPrompt') || 0,
    ),
    outlineText,
  };

  const rebuild = (allocations: ContextAllocationTrace[]): ChatMessage[] => {
    const m = allocMap(allocations);
    const ctx: ReviewContext = {
      presetText: clipByAllocation(
        params.context.presetText,
        m.get('preset') || 0,
      ),
      characterText: clipByAllocation(
        params.context.characterText,
        m.get('character') || 0,
      ),
      noteText: clipByAllocation(params.context.noteText, m.get('note') || 0),
      worldbookText: clipByAllocation(
        params.context.worldbookText,
        m.get('worldbook') || 0,
      ),
      storyMemoryText: clipByAllocation(
        params.context.storyMemoryText,
        m.get('storyMemory') || 0,
      ),
      episodicMemoryText: clipByAllocation(
        params.context.episodicMemoryText,
        m.get('episodic') || 0,
      ),
      recentBridgeText: clipByAllocation(
        params.context.recentBridgeText,
        m.get('recentBridge') || 0,
      ),
      currentInstructionText: clipByAllocation(
        params.context.currentInstructionText,
        m.get('currentInstruction') || 0,
      ),
      retrievalUserPrompt: clipByAllocation(
        params.context.retrievalUserPrompt,
        m.get('userPrompt') || 0,
      ),
      outlineText,
    };
    return params.repairReason
      ? buildReviewV2RepairMessages({
          taggedDraft: params.taggedDraft,
          context: ctx,
          draftHash: params.draftHash,
          failureReason: params.repairReason,
        })
      : buildReviewV2Messages({
          taggedDraft: params.taggedDraft,
          context: ctx,
          draftHash: params.draftHash,
        });
  };

  return finalizeCompiled({
    stage,
    messages: params.repairReason
      ? buildReviewV2RepairMessages({
          taggedDraft: params.taggedDraft,
          context: clipped,
          draftHash: params.draftHash,
          failureReason: params.repairReason,
        })
      : buildReviewV2Messages({
          taggedDraft: params.taggedDraft,
          context: clipped,
          draftHash: params.draftHash,
        }),
    maxTokens: params.maxTokens,
    contextWindow: params.contextWindow,
    outlineTokens,
    bodyTokens,
    fixedMessagesTokens,
    budget,
    allocations: [
      {
        id: 'outline',
        requested: outlineTokens,
        allocated: outlineTokens,
        truncated: false,
      },
      {
        id: 'mandatory_body',
        requested: bodyTokens,
        allocated: bodyTokens,
        truncated: false,
      },
      ...budget.optionalAllocations,
    ],
    rebuild,
  });
}

/**
 * FactCheck V2 (anchored) compiler — workflow version 2 only.
 * Same shape as compileReviewV2StageRequest; body is the tagged draft.
 */
export function compileFactCheckV2StageRequest(params: {
  taggedDraft: string;
  context: FactCheckContext;
  draftHash: string;
  maxTokens: number;
  contextWindow: number;
  repairReason?: string;
  elasticBudget?: boolean;
}): StageCompileResult {
  if (params.elasticBudget) {
    return compileFactCheckV2WithElasticBudget(params);
  }
  const stage = params.repairReason ? 'factCheck_repair' : 'factCheck';
  const outlineText = params.context.outlineText
    ? String(params.context.outlineText)
    : '';
  const outlineTokens = estimateTokens(outlineText);
  const bodyTokens = estimateTokens(params.taggedDraft);

  const scaffold = params.repairReason
    ? buildFactCheckV2RepairMessages({
        taggedDraft: params.taggedDraft,
        context: emptyFactCheckContext(),
        draftHash: params.draftHash,
        failureReason: params.repairReason,
      })
    : buildFactCheckV2Messages({
        taggedDraft: params.taggedDraft,
        context: emptyFactCheckContext(),
        draftHash: params.draftHash,
      });
  const PARTITION_OVERHEAD = 128;
  const fixedMessagesTokens =
    Math.max(0, estimateStageInputTokens(scaffold) - bodyTokens) +
    PARTITION_OVERHEAD;

  const optionalSections = [
    {
      id: 'preset',
      tokens: estimateTokens(params.context.presetText),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.preset,
    },
    {
      id: 'currentInstruction',
      tokens: estimateTokens(params.context.currentInstructionText),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.currentInstruction,
    },
    {
      id: 'userPrompt',
      tokens: estimateTokens(params.context.retrievalUserPrompt),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.userPrompt,
    },
    {
      id: 'recentBridge',
      tokens: estimateTokens(params.context.recentBridgeText),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.recentBridge,
    },
    {
      id: 'storyMemory',
      tokens: estimateTokens(params.context.storyMemoryText),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.storyMemory,
    },
    {
      id: 'episodic',
      tokens: estimateTokens(params.context.episodicMemoryText),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.episodic,
    },
    {
      id: 'worldbook',
      tokens: estimateTokens(params.context.worldbookText),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.worldbook,
    },
    {
      id: 'character',
      tokens: estimateTokens(params.context.characterText),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.character,
    },
    {
      id: 'note',
      tokens: estimateTokens(params.context.noteText),
      weight: FACTCHECK_OPTIONAL_WEIGHTS.note,
    },
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
    presetText: clipByAllocation(
      params.context.presetText,
      am.get('preset') || 0,
    ),
    currentInstructionText: clipByAllocation(
      params.context.currentInstructionText,
      am.get('currentInstruction') || 0,
    ),
    retrievalUserPrompt: clipByAllocation(
      params.context.retrievalUserPrompt,
      am.get('userPrompt') || 0,
    ),
    recentBridgeText: clipByAllocation(
      params.context.recentBridgeText,
      am.get('recentBridge') || 0,
    ),
    storyMemoryText: clipByAllocation(
      params.context.storyMemoryText,
      am.get('storyMemory') || 0,
    ),
    episodicMemoryText: clipByAllocation(
      params.context.episodicMemoryText,
      am.get('episodic') || 0,
    ),
    worldbookText: clipByAllocation(
      params.context.worldbookText,
      am.get('worldbook') || 0,
    ),
    characterText: clipByAllocation(
      params.context.characterText,
      am.get('character') || 0,
    ),
    noteText: clipByAllocation(params.context.noteText, am.get('note') || 0),
    outlineText,
  };

  const rebuild = (allocations: ContextAllocationTrace[]): ChatMessage[] => {
    const m = allocMap(allocations);
    const ctx: FactCheckContext = {
      presetText: clipByAllocation(
        params.context.presetText,
        m.get('preset') || 0,
      ),
      currentInstructionText: clipByAllocation(
        params.context.currentInstructionText,
        m.get('currentInstruction') || 0,
      ),
      retrievalUserPrompt: clipByAllocation(
        params.context.retrievalUserPrompt,
        m.get('userPrompt') || 0,
      ),
      recentBridgeText: clipByAllocation(
        params.context.recentBridgeText,
        m.get('recentBridge') || 0,
      ),
      storyMemoryText: clipByAllocation(
        params.context.storyMemoryText,
        m.get('storyMemory') || 0,
      ),
      episodicMemoryText: clipByAllocation(
        params.context.episodicMemoryText,
        m.get('episodic') || 0,
      ),
      worldbookText: clipByAllocation(
        params.context.worldbookText,
        m.get('worldbook') || 0,
      ),
      characterText: clipByAllocation(
        params.context.characterText,
        m.get('character') || 0,
      ),
      noteText: clipByAllocation(params.context.noteText, m.get('note') || 0),
      outlineText,
    };
    return params.repairReason
      ? buildFactCheckV2RepairMessages({
          taggedDraft: params.taggedDraft,
          context: ctx,
          draftHash: params.draftHash,
          failureReason: params.repairReason,
        })
      : buildFactCheckV2Messages({
          taggedDraft: params.taggedDraft,
          context: ctx,
          draftHash: params.draftHash,
        });
  };

  return finalizeCompiled({
    stage,
    messages: params.repairReason
      ? buildFactCheckV2RepairMessages({
          taggedDraft: params.taggedDraft,
          context: clipped,
          draftHash: params.draftHash,
          failureReason: params.repairReason,
        })
      : buildFactCheckV2Messages({
          taggedDraft: params.taggedDraft,
          context: clipped,
          draftHash: params.draftHash,
        }),
    maxTokens: params.maxTokens,
    contextWindow: params.contextWindow,
    outlineTokens,
    bodyTokens,
    fixedMessagesTokens,
    budget,
    allocations: [
      {
        id: 'outline',
        requested: outlineTokens,
        allocated: outlineTokens,
        truncated: false,
      },
      {
        id: 'mandatory_body',
        requested: bodyTokens,
        allocated: bodyTokens,
        truncated: false,
      },
      ...budget.optionalAllocations,
    ],
    rebuild,
  });
}

/** Elastic V3 variant of the anchored Review compiler. The outline and the
 * tagged draft remain mandatory; only the frozen auxiliary context competes
 * inside the per-request 80% soft pool / burst band. */
function compileReviewV2WithElasticBudget(params: {
  taggedDraft: string;
  context: ReviewContext;
  draftHash: string;
  maxTokens: number;
  contextWindow: number;
  repairReason?: string;
}): StageCompileResult {
  const stage = params.repairReason ? 'review_repair' : 'review';
  const outlineText = String(params.context.outlineText || '');
  const mandatoryModules: ElasticStageModule[] = [
    {
      id: 'outline',
      text: outlineText,
      requirement: 'mandatory',
      priority: 10,
      relevance: 1,
    },
    {
      id: 'mandatory_body',
      text: params.taggedDraft,
      requirement: 'mandatory',
      priority: 10,
      relevance: 1,
    },
  ];
  const elasticModules: ElasticStageModule[] = [
    {
      id: 'recentBridge',
      text: params.context.recentBridgeText,
      requirement: 'preferred',
      priority: 8,
      relevance: 0.9,
    },
    {
      id: 'storyMemory',
      text: params.context.storyMemoryText,
      requirement: 'preferred',
      priority: 7,
      relevance: 0.85,
    },
    {
      id: 'character',
      text: params.context.characterText,
      requirement: 'preferred',
      priority: 6,
      relevance: 0.8,
    },
    {
      id: 'worldbook',
      text: params.context.worldbookText,
      requirement: 'preferred',
      priority: 6,
      relevance: 0.8,
    },
    {
      id: 'episodic',
      text: params.context.episodicMemoryText,
      requirement: 'optional',
      priority: 4,
      relevance: 0.6,
    },
    {
      id: 'note',
      text: params.context.noteText,
      requirement: 'optional',
      priority: 3,
      relevance: 0.5,
    },
    {
      id: 'preset',
      text: params.context.presetText,
      requirement: 'optional',
      priority: 3,
      relevance: 0.5,
    },
    {
      id: 'currentInstruction',
      text: params.context.currentInstructionText,
      requirement: 'optional',
      priority: 2,
      relevance: 0.5,
    },
    {
      id: 'userPrompt',
      text: params.context.retrievalUserPrompt,
      requirement: 'optional',
      priority: 2,
      relevance: 0.5,
    },
  ];
  return compileStageRequestWithElasticBudget({
    stage,
    contextWindow: params.contextWindow,
    reservedOutputTokens: params.maxTokens,
    mandatoryModules,
    elasticModules,
    buildMessages: clipped => {
      const context: ReviewContext = {
        presetText: clipped.get('preset') || '',
        characterText: clipped.get('character') || '',
        noteText: clipped.get('note') || '',
        worldbookText: clipped.get('worldbook') || '',
        storyMemoryText: clipped.get('storyMemory') || '',
        episodicMemoryText: clipped.get('episodic') || '',
        recentBridgeText: clipped.get('recentBridge') || '',
        currentInstructionText: clipped.get('currentInstruction') || '',
        retrievalUserPrompt: clipped.get('userPrompt') || '',
        outlineText,
      };
      return params.repairReason
        ? buildReviewV2RepairMessages({
            taggedDraft: params.taggedDraft,
            context,
            draftHash: params.draftHash,
            failureReason: params.repairReason,
          })
        : buildReviewV2Messages({
            taggedDraft: params.taggedDraft,
            context,
            draftHash: params.draftHash,
          });
    },
  });
}

/** Elastic V3 variant of the anchored FactCheck compiler. */
function compileFactCheckV2WithElasticBudget(params: {
  taggedDraft: string;
  context: FactCheckContext;
  draftHash: string;
  maxTokens: number;
  contextWindow: number;
  repairReason?: string;
}): StageCompileResult {
  const stage = params.repairReason ? 'factCheck_repair' : 'factCheck';
  const outlineText = String(params.context.outlineText || '');
  const mandatoryModules: ElasticStageModule[] = [
    {
      id: 'outline',
      text: outlineText,
      requirement: 'mandatory',
      priority: 10,
      relevance: 1,
    },
    {
      id: 'mandatory_body',
      text: params.taggedDraft,
      requirement: 'mandatory',
      priority: 10,
      relevance: 1,
    },
  ];
  const elasticModules: ElasticStageModule[] = [
    {
      id: 'recentBridge',
      text: params.context.recentBridgeText,
      requirement: 'preferred',
      priority: 8,
      relevance: 0.9,
    },
    {
      id: 'storyMemory',
      text: params.context.storyMemoryText,
      requirement: 'preferred',
      priority: 7,
      relevance: 0.85,
    },
    {
      id: 'worldbook',
      text: params.context.worldbookText,
      requirement: 'preferred',
      priority: 6,
      relevance: 0.8,
    },
    {
      id: 'character',
      text: params.context.characterText,
      requirement: 'preferred',
      priority: 6,
      relevance: 0.8,
    },
    {
      id: 'episodic',
      text: params.context.episodicMemoryText,
      requirement: 'optional',
      priority: 4,
      relevance: 0.6,
    },
    {
      id: 'note',
      text: params.context.noteText,
      requirement: 'optional',
      priority: 3,
      relevance: 0.5,
    },
    {
      id: 'preset',
      text: params.context.presetText,
      requirement: 'optional',
      priority: 3,
      relevance: 0.5,
    },
    {
      id: 'currentInstruction',
      text: params.context.currentInstructionText,
      requirement: 'optional',
      priority: 2,
      relevance: 0.5,
    },
    {
      id: 'userPrompt',
      text: params.context.retrievalUserPrompt,
      requirement: 'optional',
      priority: 2,
      relevance: 0.5,
    },
  ];
  return compileStageRequestWithElasticBudget({
    stage,
    contextWindow: params.contextWindow,
    reservedOutputTokens: params.maxTokens,
    mandatoryModules,
    elasticModules,
    buildMessages: clipped => {
      const context: FactCheckContext = {
        presetText: clipped.get('preset') || '',
        currentInstructionText: clipped.get('currentInstruction') || '',
        retrievalUserPrompt: clipped.get('userPrompt') || '',
        recentBridgeText: clipped.get('recentBridge') || '',
        storyMemoryText: clipped.get('storyMemory') || '',
        episodicMemoryText: clipped.get('episodic') || '',
        worldbookText: clipped.get('worldbook') || '',
        characterText: clipped.get('character') || '',
        noteText: clipped.get('note') || '',
        outlineText,
      };
      return params.repairReason
        ? buildFactCheckV2RepairMessages({
            taggedDraft: params.taggedDraft,
            context,
            draftHash: params.draftHash,
            failureReason: params.repairReason,
          })
        : buildFactCheckV2Messages({
            taggedDraft: params.taggedDraft,
            context,
            draftHash: params.draftHash,
          });
    },
  });
}

/**
 * Contract-declared hard constraints used only as a dedup source. The
 * contract JSON already carries `hardConstraints` (from the FactCheck
 * report); re-injecting identical lines via the module texts would
 * duplicate content for no benefit (§6.1).
 */
function extractContractHardConstraints(contractJson: string): string[] {
  if (!contractJson) return [];
  try {
    const obj = JSON.parse(contractJson) as { hardConstraints?: unknown };
    if (Array.isArray(obj?.hardConstraints)) {
      return obj.hardConstraints
        .filter((h: unknown): h is string => typeof h === 'string')
        .map(h => h.trim())
        .filter(h => h.length > 0);
    }
  } catch {
    // Non-JSON contract → nothing to dedup against.
  }
  return [];
}

/**
 * Build the hard-constraint list from the two full module texts.
 *
 * Rules (§6.1): the full module text participates in budget allocation;
 * list splitting follows explicit line breaks only (never per character);
 * empty lines are dropped; duplicates are stably removed while preserving
 * original order; lines already declared inside the revision contract are
 * not injected again.
 */
function buildHardConstraintLines(
  constraints: ProofConstraints,
  contractJson: string,
): string {
  const contractHard = new Set(extractContractHardConstraints(contractJson));
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const block of [
    constraints.relevantCharacterConstraints,
    constraints.relevantWorldRules,
  ]) {
    for (const raw of String(block ?? '').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (contractHard.has(line)) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  }
  return lines.join('\n');
}

/**
 * Final Reviser (V2 Proof) compiler — workflow version 2 only.
 *
 * Mandatory: revision contract JSON + full canonical draft (single
 * injection). Optional: slim chapter goal / user prompt / seam / preset /
 * hard constraints. Pure function (0 LLM / 0 DB) so resume deterministically
 * rebuilds the identical request from persisted draft + audits.
 */
export function compileFinalReviserStageRequest(params: {
  contractJson: string;
  workItemCount: number;
  canonicalDraft: string;
  constraints: ProofConstraints;
  maxTokens: number;
  contextWindow: number;
}): StageCompileResult {
  const stage = 'proof';
  const bodyTokens = estimateTokens(params.canonicalDraft);
  const contractTokens = estimateTokens(params.contractJson);

  const scaffold = buildFinalReviserMessages({
    contractJson: params.contractJson,
    workItemCount: params.workItemCount,
    canonicalDraft: params.canonicalDraft,
  });
  const PARTITION_OVERHEAD = 128;
  const fixedMessagesTokens =
    Math.max(
      0,
      estimateStageInputTokens(scaffold) - bodyTokens - contractTokens,
    ) + PARTITION_OVERHEAD;

  const hardList = buildHardConstraintLines(
    params.constraints,
    params.contractJson,
  );

  const optionalSections = [
    { id: 'hardConstraints', tokens: estimateTokens(hardList), weight: 4 },
    {
      id: 'recentBridge',
      tokens: estimateTokens(params.constraints.recentBridgeText),
      weight: 3,
    },
    {
      id: 'preset',
      tokens: estimateTokens(params.constraints.presetText),
      weight: 2,
    },
    {
      id: 'currentInstruction',
      tokens: estimateTokens(params.constraints.currentInstructionText),
      weight: 2,
    },
    {
      id: 'userPrompt',
      tokens: estimateTokens(params.constraints.retrievalUserPrompt),
      weight: 1,
    },
  ];

  const safetyMargin = deriveDefaultSafetyMargin(params.contextWindow);
  const budget = allocateStageContextBudget({
    contextWindow: params.contextWindow,
    reservedOutputTokens: params.maxTokens,
    safetyMargin,
    fixedMessagesTokens,
    fullOutlineTokens: 0,
    mandatoryBodyTokens: bodyTokens + contractTokens,
    optionalSections,
  });

  const am = allocMap(budget.optionalAllocations);
  const clipped = clipByAllocation(hardList, am.get('hardConstraints') || 0);
  const hardListClipped = clipped.length > 0 ? clipped.split('\n') : [];

  const messages = buildFinalReviserMessages({
    contractJson: params.contractJson,
    workItemCount: params.workItemCount,
    canonicalDraft: params.canonicalDraft,
    currentInstructionText: clipByAllocation(
      params.constraints.currentInstructionText,
      am.get('currentInstruction') || 0,
    ),
    retrievalUserPrompt: clipByAllocation(
      params.constraints.retrievalUserPrompt,
      am.get('userPrompt') || 0,
    ),
    recentBridgeText: clipByAllocation(
      params.constraints.recentBridgeText,
      am.get('recentBridge') || 0,
    ),
    presetText: clipByAllocation(
      params.constraints.presetText,
      am.get('preset') || 0,
    ),
    hardConstraints: hardListClipped,
  });

  const rebuild = (allocations: ContextAllocationTrace[]): ChatMessage[] => {
    const m = allocMap(allocations);
    const hard = clipByAllocation(hardList, m.get('hardConstraints') || 0);
    return buildFinalReviserMessages({
      contractJson: params.contractJson,
      workItemCount: params.workItemCount,
      canonicalDraft: params.canonicalDraft,
      currentInstructionText: clipByAllocation(
        params.constraints.currentInstructionText,
        m.get('currentInstruction') || 0,
      ),
      retrievalUserPrompt: clipByAllocation(
        params.constraints.retrievalUserPrompt,
        m.get('userPrompt') || 0,
      ),
      recentBridgeText: clipByAllocation(
        params.constraints.recentBridgeText,
        m.get('recentBridge') || 0,
      ),
      presetText: clipByAllocation(
        params.constraints.presetText,
        m.get('preset') || 0,
      ),
      hardConstraints: hard.length > 0 ? hard.split('\n') : [],
    });
  };

  return finalizeCompiled({
    stage,
    messages,
    maxTokens: params.maxTokens,
    contextWindow: params.contextWindow,
    outlineTokens: 0,
    bodyTokens: bodyTokens + contractTokens,
    fixedMessagesTokens,
    budget,
    allocations: [
      {
        id: 'mandatory_body',
        requested: bodyTokens,
        allocated: bodyTokens,
        truncated: false,
      },
      {
        id: 'contract',
        requested: contractTokens,
        allocated: contractTokens,
        truncated: false,
      },
      ...budget.optionalAllocations,
    ],
    rebuild,
  });
}

export function compileProofStageRequest(params: {
  draftText: string;
  reviewText: string;
  factCheckText: string;
  constraints: ProofConstraints;
  maxTokens: number;
  contextWindow: number;
  elasticBudget?: boolean;
}): StageCompileResult {
  if (params.elasticBudget) {
    return compileProofWithElasticBudget(params);
  }
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
    {
      id: 'preset',
      tokens: estimateTokens(params.constraints.presetText),
      weight: PROOF_OPTIONAL_WEIGHTS.preset,
    },
    {
      id: 'currentInstruction',
      tokens: estimateTokens(params.constraints.currentInstructionText),
      weight: PROOF_OPTIONAL_WEIGHTS.currentInstruction,
    },
    {
      id: 'userPrompt',
      tokens: estimateTokens(params.constraints.retrievalUserPrompt),
      weight: PROOF_OPTIONAL_WEIGHTS.userPrompt,
    },
    {
      id: 'character',
      tokens: estimateTokens(params.constraints.relevantCharacterConstraints),
      weight: PROOF_OPTIONAL_WEIGHTS.character,
    },
    {
      id: 'worldRules',
      tokens: estimateTokens(params.constraints.relevantWorldRules),
      weight: PROOF_OPTIONAL_WEIGHTS.worldRules,
    },
    {
      id: 'storyState',
      tokens: estimateTokens(params.constraints.currentStoryState),
      weight: PROOF_OPTIONAL_WEIGHTS.storyState,
    },
    {
      id: 'episodic',
      tokens: estimateTokens(params.constraints.episodicMemoryText),
      weight: PROOF_OPTIONAL_WEIGHTS.episodic,
    },
    {
      id: 'note',
      tokens: estimateTokens(params.constraints.noteText),
      weight: PROOF_OPTIONAL_WEIGHTS.note,
    },
    {
      id: 'recentBridge',
      tokens: estimateTokens(params.constraints.recentBridgeText),
      weight: PROOF_OPTIONAL_WEIGHTS.recentBridge,
    },
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
    presetText: clipByAllocation(
      params.constraints.presetText,
      am.get('preset') || 0,
    ),
    currentInstructionText: clipByAllocation(
      params.constraints.currentInstructionText,
      am.get('currentInstruction') || 0,
    ),
    retrievalUserPrompt: clipByAllocation(
      params.constraints.retrievalUserPrompt,
      am.get('userPrompt') || 0,
    ),
    relevantCharacterConstraints: clipByAllocation(
      params.constraints.relevantCharacterConstraints,
      am.get('character') || 0,
    ),
    relevantWorldRules: clipByAllocation(
      params.constraints.relevantWorldRules,
      am.get('worldRules') || 0,
    ),
    currentStoryState: clipByAllocation(
      params.constraints.currentStoryState,
      am.get('storyState') || 0,
    ),
    episodicMemoryText: clipByAllocation(
      params.constraints.episodicMemoryText,
      am.get('episodic') || 0,
    ),
    noteText: clipByAllocation(
      params.constraints.noteText,
      am.get('note') || 0,
    ),
    recentBridgeText: clipByAllocation(
      params.constraints.recentBridgeText,
      am.get('recentBridge') || 0,
    ),
    outlineText,
  };

  // Rebuild closure for finalizeCompiled's shrink loop: only optional
  // constraints are re-clipped; draft/review/factCheck bodies + outline
  // stay mandatory.
  const rebuild = (allocations: ContextAllocationTrace[]): ChatMessage[] => {
    const m = allocMap(allocations);
    const ctx: ProofConstraints = {
      presetText: clipByAllocation(
        params.constraints.presetText,
        m.get('preset') || 0,
      ),
      currentInstructionText: clipByAllocation(
        params.constraints.currentInstructionText,
        m.get('currentInstruction') || 0,
      ),
      retrievalUserPrompt: clipByAllocation(
        params.constraints.retrievalUserPrompt,
        m.get('userPrompt') || 0,
      ),
      relevantCharacterConstraints: clipByAllocation(
        params.constraints.relevantCharacterConstraints,
        m.get('character') || 0,
      ),
      relevantWorldRules: clipByAllocation(
        params.constraints.relevantWorldRules,
        m.get('worldRules') || 0,
      ),
      currentStoryState: clipByAllocation(
        params.constraints.currentStoryState,
        m.get('storyState') || 0,
      ),
      episodicMemoryText: clipByAllocation(
        params.constraints.episodicMemoryText,
        m.get('episodic') || 0,
      ),
      noteText: clipByAllocation(
        params.constraints.noteText,
        m.get('note') || 0,
      ),
      recentBridgeText: clipByAllocation(
        params.constraints.recentBridgeText,
        m.get('recentBridge') || 0,
      ),
      outlineText,
    };
    return buildProofMessages(
      params.draftText,
      params.reviewText,
      params.factCheckText,
      ctx,
    );
  };

  return finalizeCompiled({
    stage,
    messages: buildProofMessages(
      params.draftText,
      params.reviewText,
      params.factCheckText,
      clipped,
    ),
    maxTokens: params.maxTokens,
    contextWindow: params.contextWindow,
    outlineTokens,
    bodyTokens,
    fixedMessagesTokens,
    budget,
    allocations: [
      {
        id: 'outline',
        requested: outlineTokens,
        allocated: outlineTokens,
        truncated: false,
      },
      {
        id: 'mandatory_body',
        requested: bodyTokens,
        allocated: bodyTokens,
        truncated: false,
      },
      ...budget.optionalAllocations,
    ],
    rebuild,
  });
}

/**
 * Final Reviser V3 compiler. Mandatory input is plain Brief + canonical draft
 * + full outline; the continuity capsule is retained as far as its own floor
 * allows. The visible output floor is computed independently from reasoning
 * headroom by the caller and is never reduced to preserve a tier label.
 */
export function compileFinalReviserV3StageRequest(params: {
  writingBrief: string;
  canonicalDraft: string;
  capsule: FinalContinuityCapsule;
  maxTokens: number;
  contextWindow: number;
  modelMaxOutputTokens?: number;
  elasticBudget?: boolean;
}): StageCompileResult {
  if (params.elasticBudget) {
    return compileFinalReviserV3WithElasticBudget(params);
  }
  const draftTokens = estimateTokens(params.canonicalDraft);
  const outlineTokens = estimateTokens(params.capsule.fullOutlineText);
  const briefTokens = estimateTokens(params.writingBrief);
  const modelCap = Math.max(
    0,
    Number(params.modelMaxOutputTokens) || Number(params.maxTokens) || 0,
  );
  const visibleOutputFloor = Math.max(1024, Math.ceil(draftTokens * 1.2) + 256);
  const requestedOutput = Math.max(
    Number(params.maxTokens) || 0,
    visibleOutputFloor,
  );
  const reservedOutputTokens =
    modelCap > 0 ? Math.min(modelCap, requestedOutput) : requestedOutput;
  const messages = buildFinalReviserV3Messages({
    writingBrief: params.writingBrief,
    canonicalDraft: params.canonicalDraft,
    capsule: params.capsule,
  });
  const estimatedInputTokens = estimateStageInputTokens(messages);
  const safetyMargin = deriveDefaultSafetyMargin(params.contextWindow);
  const fits =
    params.contextWindow > 0 &&
    reservedOutputTokens >= visibleOutputFloor &&
    estimatedInputTokens + reservedOutputTokens + safetyMargin <=
      params.contextWindow;
  const allocations: ContextAllocationTrace[] = [
    {
      id: 'final_brief',
      requested: briefTokens,
      allocated: briefTokens,
      truncated: false,
    },
    {
      id: 'canonical_draft',
      requested: draftTokens,
      allocated: draftTokens,
      truncated: false,
    },
    {
      id: 'full_outline',
      requested: outlineTokens,
      allocated: outlineTokens,
      truncated: false,
    },
    {
      id: 'immediate_previous',
      requested: estimateTokens(params.capsule.immediatePreviousChapterText),
      allocated: estimateTokens(params.capsule.immediatePreviousChapterText),
      truncated: false,
    },
  ];
  if (!fits) {
    const code =
      reservedOutputTokens < visibleOutputFloor
        ? 'CONTEXT_WINDOW_EXCEEDED'
        : outlineTokens > 0 &&
          outlineTokens +
            draftTokens +
            briefTokens +
            reservedOutputTokens +
            safetyMargin >
            params.contextWindow
        ? 'OUTLINE_TOO_LARGE'
        : 'CONTEXT_WINDOW_EXCEEDED';
    return {
      ready: false,
      stage: 'proof',
      error: pipelineError(
        code,
        code === 'OUTLINE_TOO_LARGE'
          ? 'Final V3 的完整大纲、初稿、Brief 与可见正文下限无法同时适配模型窗口'
          : 'Final V3 的 mandatory 输入与可见正文下限无法适配模型窗口',
        {
          stage: 'proof',
          userAction: code === 'OUTLINE_TOO_LARGE' ? 'open_outline' : 'none',
        },
      ),
      diagnostics: {
        contextWindow: params.contextWindow,
        reservedOutputTokens,
        safetyMargin,
        estimatedInputTokens,
        fullOutlineTokens: outlineTokens,
        mandatoryBodyTokens: draftTokens + briefTokens,
        fixedMessagesTokens: Math.max(
          0,
          estimatedInputTokens - draftTokens - outlineTokens - briefTokens,
        ),
        remainingForOptional: 0,
        blockingReason: 'final_window',
      },
      allocations,
      messages,
      estimatedInputTokens,
    };
  }
  return {
    ready: true,
    stage: 'proof',
    messages,
    estimatedInputTokens,
    reservedOutputTokens,
    safetyMargin,
    contextWindow: params.contextWindow,
    allocations,
  };
}

/**
 * Final V3 elastic compiler. The Brief, full draft, full outline, current
 * chapter goal and immediate ending are mandatory; the rest of the continuity
 * capsule is independently allocated in the existing 80% soft pool / burst
 * band for this HTTP request.
 */
function compileFinalReviserV3WithElasticBudget(params: {
  writingBrief: string;
  canonicalDraft: string;
  capsule: FinalContinuityCapsule;
  maxTokens: number;
  contextWindow: number;
  modelMaxOutputTokens?: number;
}): StageCompileResult {
  const c = params.capsule;
  const draftTokens = estimateTokens(params.canonicalDraft);
  const outlineTokens = estimateTokens(c.fullOutlineText);
  const briefTokens = estimateTokens(params.writingBrief);
  const visibleOutputFloor = Math.max(1024, Math.ceil(draftTokens * 1.2) + 256);
  const modelCap = Math.max(0, Number(params.modelMaxOutputTokens) || 0);
  // The frozen stage budget may reserve space for the configured tier's
  // Thinking headroom, while the provider exposes a smaller physical output
  // ceiling.  Treat that ceiling as the request's actual reservation and
  // continue when the current chapter's visible completion floor still fits.
  // Only a genuinely too-small provider cap is fail-closed.
  const reservedOutputTokens =
    modelCap > 0 ? Math.min(params.maxTokens, modelCap) : params.maxTokens;
  const outputReservationTooSmall = reservedOutputTokens < visibleOutputFloor;
  if (outputReservationTooSmall) {
    return {
      ready: false,
      stage: 'proof',
      error: pipelineError(
        'CONTEXT_WINDOW_EXCEEDED',
        'Final V3 模型输出上限低于当前章节可见正文下限，已阻止请求',
        { stage: 'proof', userAction: 'none' },
      ),
      diagnostics: {
        contextWindow: params.contextWindow,
        reservedOutputTokens,
        safetyMargin: deriveDefaultSafetyMargin(params.contextWindow),
        estimatedInputTokens: 0,
        fullOutlineTokens: outlineTokens,
        mandatoryBodyTokens: draftTokens + briefTokens,
        fixedMessagesTokens: 0,
        remainingForOptional: 0,
        blockingReason: 'final_window',
      },
      allocations: [],
    };
  }

  const mandatoryModules: ElasticStageModule[] = [
    {
      id: 'final_brief',
      text: params.writingBrief,
      requirement: 'mandatory',
      priority: 10,
      relevance: 1,
    },
    {
      id: 'canonical_draft',
      text: params.canonicalDraft,
      requirement: 'mandatory',
      priority: 10,
      relevance: 1,
    },
    {
      id: 'full_outline',
      text: c.fullOutlineText,
      requirement: 'mandatory',
      priority: 10,
      relevance: 1,
    },
    {
      id: 'current_instruction',
      text: c.currentInstructionText,
      requirement: 'mandatory',
      priority: 9,
      relevance: 1,
    },
    {
      id: 'immediate_ending',
      text: c.immediatePreviousEnding,
      requirement: 'mandatory',
      priority: 10,
      relevance: 1,
    },
  ];
  const elasticModules: ElasticStageModule[] = [
    {
      id: 'immediate_previous',
      text: c.immediatePreviousChapterText,
      requirement: 'preferred',
      priority: 9,
      relevance: 1,
      minTokens: Math.min(2000, estimateTokens(c.immediatePreviousChapterText)),
      targetTokens: Math.min(
        12000,
        estimateTokens(c.immediatePreviousChapterText),
      ),
      maxTokens: Math.min(
        12000,
        estimateTokens(c.immediatePreviousChapterText),
      ),
      burstPriority: 9,
      shrinkPriority: 9,
    },
    {
      id: 'story_memory',
      text: c.storyMemoryText,
      requirement: 'preferred',
      priority: 8,
      relevance: 0.9,
      minTokens: Math.min(1000, estimateTokens(c.storyMemoryText)),
      targetTokens: Math.min(8000, estimateTokens(c.storyMemoryText)),
      maxTokens: Math.min(8000, estimateTokens(c.storyMemoryText)),
      burstPriority: 8,
      shrinkPriority: 8,
    },
    {
      id: 'characters',
      text: c.relevantCharacterText,
      requirement: 'preferred',
      priority: 7,
      relevance: 0.8,
      maxTokens: 6000,
      burstPriority: 6,
      shrinkPriority: 7,
    },
    {
      id: 'world_rules',
      text: c.relevantWorldRules,
      requirement: 'preferred',
      priority: 7,
      relevance: 0.8,
      maxTokens: 6000,
      burstPriority: 6,
      shrinkPriority: 6,
    },
    {
      id: 'note',
      text: c.noteText,
      requirement: 'preferred',
      priority: 6,
      relevance: 0.75,
      maxTokens: 4000,
      burstPriority: 5,
      shrinkPriority: 5,
    },
    {
      id: 'recent_bridge',
      text: c.recentBridgeText,
      requirement: 'optional',
      priority: 5,
      relevance: 0.7,
      maxTokens: 6000,
      burstPriority: 3,
      shrinkPriority: 4,
    },
    {
      id: 'episodic',
      text: c.episodicMemoryText,
      requirement: 'optional',
      priority: 4,
      relevance: 0.6,
      maxTokens: 5000,
      burstPriority: 2,
      shrinkPriority: 3,
    },
    {
      id: 'preset',
      text: c.presetText,
      requirement: 'optional',
      priority: 3,
      relevance: 0.5,
      maxTokens: 2200,
      burstPriority: 1,
      shrinkPriority: 2,
    },
    {
      id: 'user_prompt',
      text: c.retrievalUserPrompt,
      requirement: 'optional',
      priority: 2,
      relevance: 0.5,
      maxTokens: 1800,
      burstPriority: 1,
      shrinkPriority: 1,
    },
  ];
  const buildMessages = (clipped: ReadonlyMap<string, string>): ChatMessage[] =>
    buildFinalReviserV3Messages({
      writingBrief: clipped.get('final_brief') || '',
      canonicalDraft: clipped.get('canonical_draft') || '',
      capsule: {
        ...c,
        fullOutlineText: clipped.get('full_outline') || '',
        currentInstructionText: clipped.get('current_instruction') || '',
        immediatePreviousChapterText: clipped.get('immediate_previous') || '',
        immediatePreviousEnding: clipped.get('immediate_ending') || '',
        storyMemoryText: clipped.get('story_memory') || '',
        relevantCharacterText: clipped.get('characters') || '',
        relevantWorldRules: clipped.get('world_rules') || '',
        noteText: clipped.get('note') || '',
        recentBridgeText: clipped.get('recent_bridge') || '',
        episodicMemoryText: clipped.get('episodic') || '',
        presetText: clipped.get('preset') || '',
        retrievalUserPrompt: clipped.get('user_prompt') || '',
      },
    });
  return compileStageRequestWithElasticBudget({
    stage: 'proof',
    contextWindow: params.contextWindow,
    reservedOutputTokens,
    mandatoryModules,
    elasticModules,
    buildMessages,
  });
}

/**
 * Elastic-budget variant of compileProofStageRequest (Phase 2).
 * Mandatory: draft + review + factCheck bodies (verbatim). Proof does NOT
 * actively consume the burst band (doc §19): every elastic module is
 * optional with moderate relevance so only light high-relevance settings
 * may borrow under pressure.
 */
function compileProofWithElasticBudget(params: {
  draftText: string;
  reviewText: string;
  factCheckText: string;
  constraints: ProofConstraints;
  maxTokens: number;
  contextWindow: number;
}): StageCompileResult {
  const stage = 'proof';
  const outlineText = String(params.constraints.outlineText || '');
  const body = [params.draftText, params.reviewText, params.factCheckText].join(
    '\n',
  );
  const mandatoryModules: ElasticStageModule[] = [
    {
      id: 'outline',
      text: outlineText,
      requirement: 'mandatory',
      priority: 10,
      relevance: 1,
    },
    {
      id: 'mandatory_body',
      text: body,
      requirement: 'mandatory',
      priority: 10,
      relevance: 1,
    },
  ];
  const elasticModules: ElasticStageModule[] = [
    {
      id: 'character',
      text: params.constraints.relevantCharacterConstraints,
      requirement: 'optional',
      priority: 5,
      relevance: 0.7,
    },
    {
      id: 'worldRules',
      text: params.constraints.relevantWorldRules,
      requirement: 'optional',
      priority: 5,
      relevance: 0.7,
    },
    {
      id: 'storyState',
      text: params.constraints.currentStoryState,
      requirement: 'optional',
      priority: 5,
      relevance: 0.7,
    },
    {
      id: 'recentBridge',
      text: params.constraints.recentBridgeText,
      requirement: 'optional',
      priority: 4,
      relevance: 0.6,
    },
    {
      id: 'episodic',
      text: params.constraints.episodicMemoryText,
      requirement: 'optional',
      priority: 4,
      relevance: 0.6,
    },
    {
      id: 'note',
      text: params.constraints.noteText,
      requirement: 'optional',
      priority: 3,
      relevance: 0.5,
    },
    {
      id: 'preset',
      text: params.constraints.presetText,
      requirement: 'optional',
      priority: 3,
      relevance: 0.5,
    },
    {
      id: 'currentInstruction',
      text: params.constraints.currentInstructionText,
      requirement: 'optional',
      priority: 2,
      relevance: 0.5,
    },
    {
      id: 'userPrompt',
      text: params.constraints.retrievalUserPrompt,
      requirement: 'optional',
      priority: 2,
      relevance: 0.5,
    },
  ];
  return compileStageRequestWithElasticBudget({
    stage,
    contextWindow: params.contextWindow,
    reservedOutputTokens: params.maxTokens,
    mandatoryModules,
    elasticModules,
    buildMessages: clipped => {
      const ctx: ProofConstraints = {
        presetText: clipped.get('preset') || '',
        currentInstructionText: clipped.get('currentInstruction') || '',
        retrievalUserPrompt: clipped.get('userPrompt') || '',
        relevantCharacterConstraints: clipped.get('character') || '',
        relevantWorldRules: clipped.get('worldRules') || '',
        currentStoryState: clipped.get('storyState') || '',
        episodicMemoryText: clipped.get('episodic') || '',
        noteText: clipped.get('note') || '',
        recentBridgeText: clipped.get('recentBridge') || '',
        outlineText,
      };
      return buildProofMessages(
        params.draftText,
        params.reviewText,
        params.factCheckText,
        ctx,
      );
    },
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
  elasticBudget?: boolean;
}): StageCompileResult {
  if (params.stage === 'review') {
    return compileReviewStageRequest({
      draftText: params.draftText || '',
      context: params.reviewContext || emptyReviewContext(),
      maxTokens: params.maxTokens,
      contextWindow: params.contextWindow,
      repairReason: params.repairReason,
      elasticBudget: params.elasticBudget,
    });
  }
  if (params.stage === 'factCheck') {
    return compileFactCheckStageRequest({
      draftText: params.draftText || '',
      context: params.factCheckContext || emptyFactCheckContext(),
      maxTokens: params.maxTokens,
      contextWindow: params.contextWindow,
      repairReason: params.repairReason,
      elasticBudget: params.elasticBudget,
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
      elasticBudget: params.elasticBudget,
    });
  }
  throw new Error(
    'compilePipelineStageRequest: use compileDraftStageRequest for draft',
  );
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
  /**
   * Rebuild messages from an updated allocation list. Only OPTIONAL
   * sections are re-clipped inside this closure; outline and stage body
   * are mandatory and stay verbatim. Invoked by the shrink loop below.
   */
  rebuild?: (allocations: ContextAllocationTrace[]) => ChatMessage[];
}): StageCompileResult {
  // Local mutable copy of allocations so the shrink loop can mutate
  // optional entries without touching the caller's budget object.
  const allocations = params.allocations.map(a => ({ ...a }));
  const safetyMargin = params.budget.safetyMargin;
  const limit = params.contextWindow - params.maxTokens - safetyMargin;

  // If mandatory content already cannot fit, do not attempt optional
  // shrinking — classify and return Blocked immediately.
  if (!params.budget.fitsMandatory) {
    const message =
      params.budget.blockingReason === 'fixed_overflow'
        ? '固定 Prompt 与输出预留无法放入模型窗口'
        : '完整大纲与阶段必需正文无法放入模型窗口';
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
        estimatedInputTokens: estimateStageInputTokens(params.messages),
        fullOutlineTokens: params.outlineTokens,
        mandatoryBodyTokens: params.bodyTokens,
        fixedMessagesTokens: params.fixedMessagesTokens,
        remainingForOptional: params.budget.remainingForOptional,
        blockingReason: params.budget.blockingReason,
      },
      allocations,
      messages: params.messages,
      estimatedInputTokens: estimateStageInputTokens(params.messages),
    };
  }

  // Optional-only shrink loop (max 3 passes). When the assembled messages
  // slightly overshoot the window (label / role overhead), we do NOT clip
  // the assembled system/user string — that would truncate the full
  // outline, the draft body, the system protocol, and repair instructions.
  // Instead we reduce ONLY optional allocations, then rebuild messages and
  // re-estimate.
  let messages = params.messages;
  let estimatedInputTokens = estimateStageInputTokens(messages);
  const rebuild = params.rebuild;
  const MAX_SHRINK_PASSES = 3;

  for (let pass = 0; pass < MAX_SHRINK_PASSES; pass += 1) {
    if (limit <= 0) break;
    if (estimatedInputTokens <= limit) break;

    if (!rebuild) {
      // No rebuild closure (shouldn't happen for review/factCheck/proof,
      // but guard defensively) — cannot shrink without reconstruction.
      break;
    }

    const overshoot = estimatedInputTokens - limit;
    const changed = shrinkOptionalAllocations(allocations, overshoot + 32);
    if (!changed) break;

    messages = rebuild(allocations);
    estimatedInputTokens = estimateStageInputTokens(messages);
  }

  const finalFits =
    estimatedInputTokens + params.maxTokens + safetyMargin <=
    params.contextWindow;

  if (!finalFits) {
    // Mandatory fits but final assembled messages still do not — classify
    // why. OUTLINE_TOO_LARGE only when the full outline alone (plus fixed
    // scaffold + output + safety) overflows; otherwise the body/protocol
    // combination is the cause → CONTEXT_WINDOW_EXCEEDED.
    const message = '阶段请求超出模型上下文窗口';
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
        budgetBlocking: null,
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
        blockingReason: 'final_window',
      },
      allocations,
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
    allocations,
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

/**
 * Unified pipeline stage request compiler.
 *
 * All stages (and Context Preview) should obtain messages through this module
 * so prompt assembly cannot diverge across first-run / resume / preview.
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
import type { PipelineStageName } from '../../types/pipeline';
import type { PipelineError } from './types';
import { pipelineError } from './errors';

export interface ContextAllocationTrace {
  id: string;
  requested: number;
  allocated: number;
  truncated: boolean;
}

export interface CompiledStageRequest {
  stage: PipelineStageName | 'draft_retry' | 'review_repair' | 'factCheck_repair';
  messages: ChatMessage[];
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  safetyMargin: number;
  contextWindow: number;
  fits: boolean;
  blockingError?: PipelineError;
  allocations: ContextAllocationTrace[];
  /** Present for draft compile (preview parity). */
  draftCompile?: CompileDraftPipelineRequestResult;
}

export async function compileDraftStageRequest(params: {
  chapter: Chapter;
  requestConfig?: LLMRequestConfig;
  draftPreset?: Preset | null;
  draftMaxTokens?: number;
  preview?: boolean;
}): Promise<CompiledStageRequest> {
  const compiled = await compileDraftPipelineRequest(params);
  const safetyMargin = deriveDefaultSafetyMargin(compiled.contextWindow);
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
  let blockingError: PipelineError | undefined;
  if (!compiled.fits) {
    const reason = compiled.blockingReason || '';
    const isOutline =
      /大纲|outline/i.test(reason) || /大纲|outline/i.test(compiled.blockingReason || '');
    blockingError = pipelineError(
      isOutline ? 'OUTLINE_TOO_LARGE' : 'CONTEXT_WINDOW_EXCEEDED',
      reason || '请求超出模型上下文窗口',
      {
        stage: 'draft',
        userAction: isOutline ? 'open_outline' : 'none',
      },
    );
  }
  return {
    stage: 'draft',
    messages: compiled.messages,
    estimatedInputTokens: compiled.estimatedInputTokens,
    reservedOutputTokens: compiled.reservedOutputTokens,
    safetyMargin,
    contextWindow: compiled.contextWindow,
    fits: compiled.fits,
    blockingError,
    allocations,
    draftCompile: compiled,
  };
}

export function compileReviewStageRequest(params: {
  draftText: string;
  context: ReviewContext;
  maxTokens: number;
  contextWindow: number;
  repairReason?: string;
}): CompiledStageRequest {
  const messages = params.repairReason
    ? buildReviewRepairMessages(
        params.draftText,
        params.context,
        params.repairReason,
      )
    : buildReviewMessages(params.draftText, params.context);
  return finalizeNonDraftCompile({
    stage: params.repairReason ? 'review_repair' : 'review',
    messages,
    maxTokens: params.maxTokens,
    contextWindow: params.contextWindow,
    outlineText: params.context.outlineText,
    mandatoryBody: params.draftText,
  });
}

export function compileFactCheckStageRequest(params: {
  draftText: string;
  context: FactCheckContext;
  maxTokens: number;
  contextWindow: number;
  repairReason?: string;
}): CompiledStageRequest {
  const messages = params.repairReason
    ? buildFactCheckRepairMessages(
        params.draftText,
        params.context,
        params.repairReason,
      )
    : buildFactCheckMessages(params.draftText, params.context);
  return finalizeNonDraftCompile({
    stage: params.repairReason ? 'factCheck_repair' : 'factCheck',
    messages,
    maxTokens: params.maxTokens,
    contextWindow: params.contextWindow,
    outlineText: params.context.outlineText,
    mandatoryBody: params.draftText,
  });
}

export function compileProofStageRequest(params: {
  draftText: string;
  reviewText: string;
  factCheckText: string;
  constraints: ProofConstraints;
  maxTokens: number;
  contextWindow: number;
}): CompiledStageRequest {
  const messages = buildProofMessages(
    params.draftText,
    params.reviewText,
    params.factCheckText,
    params.constraints,
  );
  return finalizeNonDraftCompile({
    stage: 'proof',
    messages,
    maxTokens: params.maxTokens,
    contextWindow: params.contextWindow,
    outlineText: params.constraints.outlineText,
    mandatoryBody: [
      params.draftText,
      params.reviewText,
      params.factCheckText,
    ].join('\n'),
  });
}

/**
 * Facade used by reconcile / preview for any stage.
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
}): CompiledStageRequest {
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
  // draft must use async compileDraftStageRequest
  throw new Error('compilePipelineStageRequest: use compileDraftStageRequest for draft');
}

function estimateOutlineTokens(outlineText?: string): number {
  if (!outlineText || !outlineText.trim()) return 0;
  return estimateStageInputTokens([
    { role: 'system', content: outlineText },
  ] as ChatMessage[]);
}

function finalizeNonDraftCompile(params: {
  stage: CompiledStageRequest['stage'];
  messages: ChatMessage[];
  maxTokens: number;
  contextWindow: number;
  outlineText?: string;
  mandatoryBody: string;
}): CompiledStageRequest {
  const estimatedInputTokens = estimateStageInputTokens(params.messages);
  const safetyMargin = deriveDefaultSafetyMargin(params.contextWindow);
  const outlineTokens = estimateOutlineTokens(params.outlineText);
  const bodyTokens = estimateStageInputTokens([
    { role: 'user', content: params.mandatoryBody },
  ] as ChatMessage[]);
  const fixedApprox = Math.max(
    0,
    estimatedInputTokens - outlineTokens - bodyTokens,
  );
  const budget = allocateStageContextBudget({
    contextWindow: params.contextWindow,
    reservedOutputTokens: params.maxTokens,
    safetyMargin,
    fixedMessagesTokens: fixedApprox,
    fullOutlineTokens: outlineTokens,
    mandatoryBodyTokens: bodyTokens,
    optionalSections: [],
  });
  const fits =
    estimatedInputTokens + params.maxTokens + safetyMargin <=
    params.contextWindow;
  let blockingError: PipelineError | undefined;
  if (!fits || !budget.fitsMandatory) {
    const isOutline =
      !budget.fitsMandatory &&
      budget.blockingReason === 'outline_or_body' &&
      outlineTokens > 0;
    blockingError = pipelineError(
      isOutline ? 'OUTLINE_TOO_LARGE' : 'CONTEXT_WINDOW_EXCEEDED',
      isOutline
        ? '完整大纲与阶段必需正文无法放入模型窗口'
        : '阶段请求超出模型上下文窗口',
      {
        stage:
          params.stage === 'review_repair'
            ? 'review'
            : params.stage === 'factCheck_repair'
              ? 'factCheck'
              : params.stage === 'draft_retry'
                ? 'draft'
                : (params.stage as any),
        userAction: isOutline ? 'open_outline' : 'none',
      },
    );
  }
  return {
    stage: params.stage,
    messages: params.messages,
    estimatedInputTokens,
    reservedOutputTokens: params.maxTokens,
    safetyMargin,
    contextWindow: params.contextWindow,
    fits: fits && budget.fitsMandatory,
    blockingError,
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
    ],
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

// Re-export snapshot type for callers that freeze draft context.
export type { PipelineContextSnapshot };

/**
 * Reconstructable identity of one model-visible request.
 *
 * Stores fingerprints and metadata, never the full prompt blob. The messages
 * can be rebuilt from FrozenWritingContext + SHARED_PROMPT_COMPILER_VERSION
 * + stage + artifacts, then compared to messagesFingerprint.
 */
import { sha256Hex } from '../../continuation/hashUtils';
import type {
  ChatMessage,
  LLMOutputBudgetTrace,
  LLMProviderCapabilitySupport,
  LLMFailurePhase,
  LLMRequestMetrics,
  ReasoningEffort,
} from '../../llm/types';
import type { LLMFailureClass } from '../../llm/requestPolicy';
import {
  resolveProviderCapability,
  resolveProviderOutputBudget,
  resolveProviderReasoningEffort,
  type LLMProviderReasoningCapability,
  type ProviderCapabilityConfig,
} from '../../llm/providerCapabilities';
import { projectFrozenContextForStage } from '../context/stageContextProjection';
import { SHARED_PROMPT_COMPILER_VERSION } from '../prompt/sharedPromptCompiler';
import { resolveQualityProfileFromValues } from './generationQualityProfile';
import { resolveExecutionProfileFromValues } from './executionProfile';
import { stableWritingJson } from './writingFingerprint';
import type { WritingGovernorShadow } from '../governor/writingGovernor';
import type { FrozenWritingContext } from './frozenWritingContext';
import type { SharedWritingStageName } from './writingPolicy';
import type { WritingScenario } from './writingSource';

export type WritingRequestReceiptOutcome =
  | 'succeeded'
  | 'failed'
  | 'outcome_unknown'
  | 'cancelled'
  | 'blocked'
  | 'started';

export interface WritingRequestReceiptUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  reasoningTokens?: number | null;
  visibleOutputTokens?: number | null;
}

export interface WritingRequestReceiptTimings {
  queuedAt: number | null;
  dispatchStartedAt: number | null;
  requestSentAt: number | null;
  responseReceivedAt: number | null;
  parseCompletedAt: number | null;
  persistCompletedAt: number | null;
  queueWaitMs: number | null;
  providerElapsedMs: number | null;
  parseMs: number | null;
  persistMs: number | null;
  totalMs: number | null;
}

export interface WritingRequestReceipt {
  version: 1;
  requestId: string;
  generationTraceId: string;
  writingRunId: string;
  scenario: WritingScenario;
  stage: string;
  qualityProfile: 'fast' | 'standard' | 'quality' | null;
  executionProfile: 'standard' | 'one_shot';
  provider: string;
  providerAdapterId: string | null;
  llmConfigId: number | null;
  model: string;
  thinking: { type: 'enabled' | 'disabled' };
  reasoningEffort?: ReasoningEffort;
  /** Exact provider-specific effort value represented by this physical call. */
  reasoningEffortWire: ReasoningEffort | null;
  /** Capability state used to decide whether the effort could be sent. */
  reasoningEffortSupport: LLMProviderCapabilitySupport;
  /** Provider-reported reasoning/usage contract, never a guessed default. */
  providerReasoningCapability: LLMProviderReasoningCapability;
  /** External provider output ceiling, separate from product maxTokens. */
  providerWireMaxOutput: number | null;
  promptCompilerVersion: string;
  freezeFingerprint: string;
  truthProjectionFingerprint: string;
  stageProjectionFingerprint: string;
  messagesFingerprint: string;
  requestFingerprint: string;
  maxOutputTokens: number;
  /** Configured/frozen completion capability, separate from the wire value. */
  completionCapability: number | null;
  /** Final max_tokens value selected for the current physical request. */
  wireMaxTokens: number;
  providerCompletionLimit: number | null;
  configuredContextWindow: number | null;
  targetChars: number | null;
  /** Provider-reported prompt tokens; null means the provider did not report usage. */
  actualPromptTokens: number | null;
  responseFormat: 'json_object' | 'text';
  usage?: WritingRequestReceiptUsage;
  finishReason?: string | null;
  emptyReason?: string | null;
  failureClass: LLMFailureClass | null;
  /** Request-boundary phase, separate from retry/billing failureClass. */
  failurePhase: LLMFailurePhase | null;
  requestMayHaveExecuted: boolean | null;
  providerRequestId: string | null;
  timings: WritingRequestReceiptTimings;
  /** C2 shadow-only recommendation; never controls the current request. */
  governorShadow?: WritingGovernorShadow;
  /** Number of provider HTTP dispatches represented by this logical receipt. */
  physicalRequestCount: number;
  /** Physical dispatches caused by an adapter protocol fallback. */
  protocolFallbackCount: number;
  outcome: WritingRequestReceiptOutcome;
  resultArtifactRef?: string;
  kind: 'logical_stage' | 'formatter';
}

let receiptSeq = 0;

export type WritingRequestIdentity = {
  stage: string;
  kind: 'logical_stage' | 'formatter';
  qualityProfile: 'fast' | 'standard' | 'quality' | null;
  executionProfile: 'standard' | 'one_shot';
  provider: string;
  model: string;
  thinking: { type: 'enabled' | 'disabled' };
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  promptCompilerVersion: string;
  freezeFingerprint: string;
  truthProjectionFingerprint: string;
  stageProjectionFingerprint: string;
  messagesFingerprint: string;
  maxOutputTokens: number;
  responseFormat: 'json_object' | 'text';
};

export function fingerprintWritingMessages(messages: ChatMessage[]): string {
  return sha256Hex(
    stableWritingJson(
      messages.map(message => ({
        role: message.role,
        contentHash: sha256Hex(String(message.content || '')),
      })),
    ),
  );
}

export function buildWritingRequestReceipt(input: {
  generationTraceId: string;
  stage: SharedWritingStageName | string;
  frozenContext: FrozenWritingContext;
  compiled: {
    messages: ChatMessage[];
    maxTokens: number;
    responseFormat: 'json_object' | 'text';
  };
  thinking: { type: 'enabled' | 'disabled' };
  reasoningEffort?: ReasoningEffort;
  kind?: 'logical_stage' | 'formatter';
  scenario?: WritingScenario;
  governorShadow?: WritingGovernorShadow;
}): WritingRequestReceipt {
  receiptSeq += 1;
  const values = input.frozenContext.stagePolicy?.values;
  const messagesFingerprint = fingerprintWritingMessages(input.compiled.messages);
  const stageProjection = projectFrozenContextForStage({
    frozenContext: input.frozenContext,
    stage: (input.stage === 'qa' ||
    input.stage === 'review' ||
    input.stage === 'audit' ||
    input.stage === 'factCheck' ||
    input.stage === 'revision' ||
    input.stage === 'proof' ||
    input.stage === 'finalValidate' ||
    input.stage === 'persist'
      ? input.stage
      : 'draft') as SharedWritingStageName,
  });
  const requestId = `req_${input.generationTraceId}_${input.stage}_${Date.now()}_${receiptSeq}`;
  const targetChars = readNonNegativeNumber(
    values?.targetChapterChars ?? values?.targetChars ?? input.frozenContext.targetChars,
  );
  const completionCapability = readNonNegativeNumber(
    input.frozenContext.model?.maxOutputTokens,
  );
  const providerConfig = resolveReceiptProviderConfig(input.frozenContext);
  const providerCapability = resolveProviderCapability(providerConfig);
  const reasoningEffortWire = resolveProviderReasoningEffort({
    capability: providerCapability,
    thinking: input.thinking,
    requestedEffort: input.reasoningEffort,
  });
  const outputBoundary = resolveReceiptOutputBoundary(
    input.frozenContext,
    input.compiled.maxTokens,
  );
  const identity: WritingRequestIdentity = {
    stage: String(input.stage),
    kind: input.kind || 'logical_stage',
    qualityProfile: resolveQualityProfileFromValues(values) || null,
    executionProfile: resolveExecutionProfileFromValues(values),
    provider: input.frozenContext.model?.provider || '',
    model: input.frozenContext.model?.modelName || '',
    thinking: input.thinking,
    reasoningEffort: input.reasoningEffort,
    promptCompilerVersion: SHARED_PROMPT_COMPILER_VERSION,
    freezeFingerprint: input.frozenContext.freezeFingerprint || '',
    truthProjectionFingerprint:
      input.frozenContext.truthProjection?.fingerprint || '',
    stageProjectionFingerprint: stageProjection.fingerprint,
    messagesFingerprint,
    maxOutputTokens: input.compiled.maxTokens,
    responseFormat: input.compiled.responseFormat,
  };
  return {
    version: 1,
    requestId,
    generationTraceId: input.generationTraceId,
    writingRunId: input.frozenContext.writingRunId,
    scenario: input.scenario || 'outline',
    ...identity,
    providerAdapterId:
      outputBoundary?.adapterId ||
      providerCapability.adapterId ||
      null,
    llmConfigId: input.frozenContext.model?.configId ?? null,
    requestFingerprint: computeWritingRequestFingerprint(identity),
    reasoningEffortWire,
    reasoningEffortSupport: providerCapability.supportsReasoningEffort,
    providerReasoningCapability: {
      supportsThinking: providerCapability.supportsThinking,
      supportsReasoningEffort: providerCapability.supportsReasoningEffort,
      reasoningEffortMapping: providerCapability.reasoningEffortMapping,
      reportsReasoningTokens: providerCapability.reportsReasoningTokens,
      completionUsageSemantics: providerCapability.completionUsageSemantics,
    },
    providerWireMaxOutput: providerCapability.providerWireMaxOutput,
    completionCapability,
    wireMaxTokens: outputBoundary?.wireMaxTokens ?? input.compiled.maxTokens,
    providerCompletionLimit: outputBoundary?.providerLimit ?? null,
    configuredContextWindow: readNonNegativeNumber(
      input.frozenContext.model?.contextWindow,
    ),
    targetChars,
    actualPromptTokens: null,
    failureClass: null,
    failurePhase: null,
    requestMayHaveExecuted: false,
    providerRequestId: null,
    timings: emptyWritingRequestReceiptTimings(),
    ...(input.governorShadow
      ? { governorShadow: input.governorShadow }
      : {}),
    physicalRequestCount: 0,
    protocolFallbackCount: 0,
    outcome: 'started',
  };
}

/**
 * Exact request identity. Must be a pure function of the model-visible
 * request: never requestId, Date.now, receiptSeq, or generationTraceId.
 */
export function computeWritingRequestFingerprint(
  identity: WritingRequestIdentity,
): string {
  return sha256Hex(stableWritingJson(identity));
}

export function completeWritingRequestReceipt(
  receipt: WritingRequestReceipt,
  input: {
    outcome: WritingRequestReceiptOutcome;
    usage?: WritingRequestReceiptUsage;
    finishReason?: string | null;
    emptyReason?: string | null;
    failureClass?: LLMFailureClass | null;
    failurePhase?: LLMFailurePhase | null;
    requestMayHaveExecuted?: boolean | null;
    providerRequestId?: string | null;
    actualPromptTokens?: number | null;
    outputBudget?: LLMOutputBudgetTrace | null;
    metrics?: LLMRequestMetrics | null;
    governorShadow?: WritingGovernorShadow;
    timings?: Partial<WritingRequestReceiptTimings>;
    resultArtifactRef?: string;
    physicalRequestCount?: number;
    protocolFallbackCount?: number;
  },
): WritingRequestReceipt {
  return {
    ...receipt,
    outcome: input.outcome,
    usage: input.usage === undefined ? receipt.usage : input.usage,
    ...(input.finishReason !== undefined
      ? { finishReason: input.finishReason }
      : {}),
    ...(input.emptyReason !== undefined
      ? { emptyReason: input.emptyReason }
      : {}),
    ...(input.failureClass !== undefined
      ? { failureClass: input.failureClass }
      : {}),
    ...(input.failurePhase !== undefined
      ? { failurePhase: input.failurePhase }
      : {}),
    ...(input.requestMayHaveExecuted !== undefined
      ? { requestMayHaveExecuted: input.requestMayHaveExecuted }
      : {}),
    ...(input.providerRequestId !== undefined
      ? { providerRequestId: input.providerRequestId }
      : {}),
    ...(input.governorShadow !== undefined
      ? { governorShadow: input.governorShadow }
      : {}),
    ...(input.actualPromptTokens !== undefined
      ? { actualPromptTokens: input.actualPromptTokens }
      : {}),
    ...(input.outputBudget
      ? {
          wireMaxTokens: input.outputBudget.wireMaxTokens,
          providerCompletionLimit: input.outputBudget.providerLimit,
        }
      : {}),
    timings: mergeWritingRequestReceiptTimings(
      receipt.timings,
      input.metrics,
      input.timings,
    ),
    ...(input.resultArtifactRef !== undefined
      ? { resultArtifactRef: input.resultArtifactRef }
      : {}),
    physicalRequestCount:
      input.physicalRequestCount == null
        ? receipt.physicalRequestCount
        : Math.max(0, Number(input.physicalRequestCount) || 0),
    protocolFallbackCount:
      input.protocolFallbackCount == null
        ? receipt.protocolFallbackCount
        : Math.max(0, Number(input.protocolFallbackCount) || 0),
  };
}

function readNonNegativeNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function resolveReceiptProviderConfig(
  frozenContext: FrozenWritingContext,
): ProviderCapabilityConfig {
  return {
    provider_type: frozenContext.model.provider as 'openai_compatible',
    model_name: frozenContext.model.modelName,
    url: frozenContext.model.url || '',
    context_window: frozenContext.model.contextWindow,
    max_output_tokens: frozenContext.model.maxOutputTokens,
    provider_adapter_id: frozenContext.model.providerAdapterId,
  };
}

function resolveReceiptOutputBoundary(
  frozenContext: FrozenWritingContext,
  requestedMaxTokens: number,
): LLMOutputBudgetTrace | null {
  try {
    return resolveProviderOutputBudget({
      config: resolveReceiptProviderConfig(frozenContext),
      requestedMaxTokens,
    }).trace;
  } catch {
    // Receipt construction must remain available for a failed Ready request;
    // the provider boundary will still report the configuration failure.
    return null;
  }
}

export function emptyWritingRequestReceiptTimings(): WritingRequestReceiptTimings {
  return {
    queuedAt: null,
    dispatchStartedAt: null,
    requestSentAt: null,
    responseReceivedAt: null,
    parseCompletedAt: null,
    persistCompletedAt: null,
    queueWaitMs: null,
    providerElapsedMs: null,
    parseMs: null,
    persistMs: null,
    totalMs: null,
  };
}

function mergeWritingRequestReceiptTimings(
  current: WritingRequestReceiptTimings,
  metrics?: LLMRequestMetrics | null,
  override?: Partial<WritingRequestReceiptTimings>,
): WritingRequestReceiptTimings {
  const next: WritingRequestReceiptTimings = { ...current };
  if (metrics) {
    const mapped: Partial<WritingRequestReceiptTimings> = {
      queuedAt: metrics.queuedAt ?? null,
      dispatchStartedAt: metrics.dispatchStartedAt ?? metrics.startedAt ?? null,
      requestSentAt: metrics.requestSentAt ?? null,
      responseReceivedAt: metrics.responseReceivedAt ?? null,
      parseCompletedAt: metrics.parseCompletedAt ?? null,
      queueWaitMs: metrics.queueWaitMs ?? null,
      providerElapsedMs: metrics.providerElapsedMs ?? null,
      parseMs: metrics.parseMs ?? null,
      totalMs: metrics.totalMs ?? null,
    };
    for (const [key, value] of Object.entries(mapped)) {
      if (value !== null && value !== undefined) {
        next[key as keyof WritingRequestReceiptTimings] = value as never;
      }
    }
  }
  if (override) {
    for (const [key, value] of Object.entries(override)) {
      if (value !== undefined) {
        next[key as keyof WritingRequestReceiptTimings] = value as never;
      }
    }
  }
  return next;
}

/** Drop any accidental large payload before SQLite JSON persistence. */
export function compactWritingRequestReceipt(
  receipt: WritingRequestReceipt,
): WritingRequestReceipt {
  const compact = { ...receipt };
  for (const key of [
    'messages',
    'prompt',
    'rawPrompt',
    'rawBody',
    'requestBody',
    'responseBody',
    'body',
  ]) {
    delete (compact as Record<string, unknown>)[key];
  }
  return compact;
}

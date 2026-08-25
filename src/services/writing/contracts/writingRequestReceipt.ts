/**
 * Reconstructable identity of one model-visible request.
 *
 * Stores fingerprints and metadata, never the full prompt blob. The messages
 * can be rebuilt from FrozenWritingContext + SHARED_PROMPT_COMPILER_VERSION
 * + stage + artifacts, then compared to messagesFingerprint.
 */
import { sha256Hex } from '../../continuation/hashUtils';
import type { ChatMessage } from '../../llm/types';
import { projectFrozenContextForStage } from '../context/stageContextProjection';
import { SHARED_PROMPT_COMPILER_VERSION } from '../prompt/sharedPromptCompiler';
import { resolveQualityProfileFromValues } from './generationQualityProfile';
import { resolveExecutionProfileFromValues } from './executionProfile';
import { stableWritingJson } from './writingFingerprint';
import type { FrozenWritingContext } from './frozenWritingContext';
import type { SharedWritingStageName } from './writingPolicy';

export type WritingRequestReceiptOutcome =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'started';

export interface WritingRequestReceiptUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number | null;
}

export interface WritingRequestReceipt {
  version: 1;
  requestId: string;
  generationTraceId: string;
  stage: string;
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
  requestFingerprint: string;
  maxOutputTokens: number;
  responseFormat: 'json_object' | 'text';
  usage?: WritingRequestReceiptUsage;
  finishReason?: string | null;
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
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  kind?: 'logical_stage' | 'formatter';
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
    ...identity,
    requestFingerprint: computeWritingRequestFingerprint(identity),
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
    resultArtifactRef?: string;
  },
): WritingRequestReceipt {
  return {
    ...receipt,
    outcome: input.outcome,
    usage: input.usage,
    finishReason: input.finishReason,
    resultArtifactRef: input.resultArtifactRef,
  };
}

/** Drop any accidental large payload before SQLite JSON persistence. */
export function compactWritingRequestReceipt(
  receipt: WritingRequestReceipt,
): WritingRequestReceipt {
  const compact = { ...receipt };
  delete (compact as { messages?: unknown }).messages;
  delete (compact as { prompt?: unknown }).prompt;
  return compact;
}

/**
 * THE one Shared Writer Core. Every post-Freeze prose stage goes through here.
 */
import type { LLMRequestConfig } from '../../llm/types';
import { compileSharedWritingPrompt } from '../prompt/sharedPromptCompiler';
import { resolveWritingCredential } from './resolveFrozenCredential';
import type {
  SharedWritingArtifact,
  SharedWritingStageInput,
} from '../contracts/writingStage';
import type { SharedWritingStageName } from '../contracts/writingPolicy';
import { resolveSharedStageSkip } from '../contracts/writingPolicy';
import { allowsFormatterCallForStage } from '../contracts/executionProfile';
import { chapterTruthProjectionDriftCode } from '../contracts/chapterTruthProjection';
import { evaluateWritingRequirements } from '../contracts/writingRequirement';
import { resolveFrozenStageReasoning } from '../contracts/stageReasoning';
import { callWritingStageLLM } from './stageLlmCall';
import {
  adoptStructuredWriterText,
  compileSharedWriterFormatterPrompt,
  isAdoptableStructuredReport,
  shouldRunWriterFormatter,
} from './writerRecovery';
import {
  classifyWritingLlmCall,
  recordWritingLlmCall,
  recordWritingRequestReceipt,
} from '../observability';
import {
  buildWritingRequestReceipt,
  completeWritingRequestReceipt,
  type WritingRequestReceipt,
} from '../contracts/writingRequestReceipt';

export function emptyRequirementResult() {
  return {
    ok: false,
    satisfiedIds: [] as string[],
    missingIds: [] as string[],
    blockingIds: [] as string[],
    falseAppliedIds: [] as string[],
  };
}

export function gateSharedStageInput(input: SharedWritingStageInput): string | null {
  if (
    input.stagePolicy.requirementsFingerprint !== input.requirements.fingerprint
  ) {
    return 'WRITING_REQUIREMENT_FINGERPRINT_DRIFT';
  }
  if (!input.frozenContext.freezeFingerprint) {
    return 'WRITING_FROZEN_CONTEXT_MISSING';
  }
  if (input.trace.freezeFingerprint !== input.frozenContext.freezeFingerprint) {
    return 'WRITING_FREEZE_FINGERPRINT_DRIFT';
  }
  if (
    input.trace.requirementsFingerprint &&
    input.trace.requirementsFingerprint !== input.requirements.fingerprint
  ) {
    return 'WRITING_REQUIREMENT_FINGERPRINT_DRIFT';
  }
  const truthDrift = chapterTruthProjectionDriftCode(input.frozenContext);
  if (truthDrift) return truthDrift;
  return null;
}

export function skippedStageResult(
  stage: SharedWritingStageName,
  input: SharedWritingStageInput,
  skipReason: string,
  policyRuleId: string,
) {
  return {
    stage,
    status: 'skipped' as const,
    artifact: {
      stage,
      body: '',
      structured: { skipped: true, skipReason, policyRuleId },
      diagnostics: [skipReason],
    },
    diagnostics: [skipReason],
    skipReason,
    policyRuleId,
    requirementResult: evaluateWritingRequirements({
      requirements: input.requirements,
      satisfiedIds: [],
    }),
  };
}

export function parseSharedWriterOutput(
  stage: SharedWritingStageName,
  text: string,
): SharedWritingArtifact {
  const trimmed = String(text || '').trim();
  const extracted = extractJsonObject(trimmed);
  if (extracted) {
    const json = extracted.value;
    const body =
      typeof json.content === 'string' && json.content.trim()
        ? json.content
        : typeof json.body === 'string' && json.body.trim()
        ? json.body
        : typeof json.report === 'string' && json.report.trim()
        ? json.report
        : extracted.raw;
    return {
      stage,
      body,
      structured: json,
      appliedRequirementIds: asStringArray(
        json.appliedObligationIds ||
          json.appliedRequirementIds ||
          json.appliedCanonRequirementIds,
      ),
      validNoOpRequirementIds: asStringArray(json.validNoOpRequirementIds),
      validNoOpReasons:
        json.validNoOpReasons && typeof json.validNoOpReasons === 'object'
          ? (json.validNoOpReasons as Record<string, string>)
          : undefined,
      diagnostics: asStringArray(json.diagnostics || json.findings),
    };
  }
  return { stage, body: trimmed, diagnostics: [] };
}

function assertStructuredReport(
  stage: SharedWritingStageName,
  artifact: SharedWritingArtifact,
): void {
  if (
    stage !== 'qa' &&
    stage !== 'review' &&
    stage !== 'audit' &&
    stage !== 'factCheck'
  ) {
    return;
  }
  const structured = artifact.structured;
  const keys = [
    'issues',
    'findings',
    'errors',
    'suggestions',
    'strengths',
    'verdict',
    'report',
    'checked',
    'warnings',
    'confirmed',
  ];
  const hasSignal =
    structured != null &&
    keys.some(key => structured[key] != null);
  if (!hasSignal) {
    throw Object.assign(new Error(`${stage} 返回格式无效，需要结构化报告`), {
      code: 'SHARED_WRITER_INVALID_REPORT',
    });
  }
}

function extractJsonObject(
  text: string,
): { value: Record<string, unknown>; raw: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const raw = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { value: parsed as Record<string, unknown>, raw }
      : null;
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

export async function executeSharedWriterStage(input: {
  stage: SharedWritingStageName;
  stageInput: SharedWritingStageInput;
}): Promise<SharedWritingArtifact> {
  const { stage, stageInput } = input;
  const existing = await stageInput.persistAdapter?.loadExisting?.(stage);
  if (existing?.body?.trim()) {
    return existing;
  }
  await stageInput.persistAdapter?.reserve?.(stage);
  const compiled = compileSharedWritingPrompt({
    stage,
    frozenContext: stageInput.frozenContext,
    artifacts: stageInput.artifacts,
    requirements: stageInput.requirements,
    stagePolicy: stageInput.stagePolicy,
  });
  const maxTokens = Math.min(
    compiled.maxTokens,
    Math.max(256, stageInput.modelConfig.maxOutputTokens || compiled.maxTokens),
  );
  const receipts: WritingRequestReceipt[] = [];
  if (stageInput.callStage) {
    const injectedStartedAt = Date.now();
    const injected = await invokePhysicalWriterCall({
      stage,
      stageInput,
      compiled,
      reasoning: { thinking: { type: 'enabled' } },
      receipts,
      call: () =>
        stageInput.callStage!({
          stage,
          messages: compiled.messages,
          maxTokens,
          configId: stageInput.modelConfig.configId,
          responseFormat: compiled.responseFormat,
        }),
    });
    try {
      const adopted = adoptStructuredWriterText({
        stage,
        outputContract: compiled.outputContract,
        text: injected.text,
        reasoningText: (injected as { reasoningText?: string }).reasoningText,
      });
      const artifact = finalizeWriterArtifact(stage, stageInput, adopted.text);
      attachUsage(artifact, injected, {
        kind: classifyWritingLlmCall({}),
        physicalRequestCount: 1,
        protocolFallbackCount: 0,
      });
      recordWriterCall(stageInput, {
        stage,
        kind: classifyWritingLlmCall({}),
        result: injected,
        physicalRequestCount: 1,
        protocolFallbackCount: 0,
        durationMs: Date.now() - injectedStartedAt,
      });
      attachRequestReceipts(artifact, stageInput, receipts);
      await stageInput.persistAdapter?.persistStageArtifact(stage, artifact);
      return artifact;
    } catch (error) {
      throw annotateWriterReceipts(error, receipts);
    }
  }

  const requestConfig = await resolveFrozenRequestConfig(stageInput);
  const stageReasoning = resolveFrozenStageReasoning(stage, stageInput);
  // Phase 4 (二 §7.2): 'qa' is the unified report stage for the compact
  // Standard path. It behaves like review/audit/factCheck for LLM-call
  // shaping (json_object + low temperature) and inherits the structured-
  // report contract from the prompt compiler.
  const isReport =
    stage === 'qa' ||
    stage === 'review' ||
    stage === 'audit' ||
    stage === 'factCheck';
  const primaryStartedAt = Date.now();
  const primary = await invokePhysicalWriterCall({
    stage,
    stageInput,
    compiled: {
      messages: compiled.messages,
      maxTokens,
      responseFormat:
        compiled.responseFormat === 'json_object' || isReport
          ? 'json_object'
          : compiled.responseFormat,
    },
    reasoning: stageReasoning,
    receipts,
    call: () =>
      callWritingStageLLM(
        compiled.messages,
        maxTokens,
        {
          queueClass: 'pipeline',
          queuePriority: 'normal',
          projectId: stageInput.frozenContext.projectId,
          taskId: stageInput.frozenContext.writingRunId,
          scenario:
            stage === 'revision'
              ? 'pipeline_brief'
              : stage === 'factCheck'
              ? 'pipeline_factcheck'
              : `pipeline_${stage}`,
          responseFormat:
            compiled.responseFormat === 'json_object' || isReport
              ? 'json_object'
              : undefined,
          thinking: stageReasoning.thinking,
          reasoningEffort: stageReasoning.reasoningEffort,
          temperature: isReport ? 0.2 : undefined,
          top_p: isReport ? 1 : undefined,
          requestConfig,
        },
        stageInput.abortSignal,
      ),
  });
  if (primary.finishReason === 'content_filter') {
    throw annotateWriterReceipts(
      Object.assign(new Error(`${stage} 被内容安全策略拦截`), {
        code: 'SHARED_WRITER_CONTENT_FILTER',
      }),
      receipts,
    );
  }
  let adopted = adoptStructuredWriterText({
    stage,
    outputContract: compiled.outputContract,
    text: primary.text,
    reasoningText: primary.reasoningText,
  });
  let parsed = parseSharedWriterOutput(stage, adopted.text);
  const primaryAdoptable =
    Boolean(adopted.text.trim()) &&
    (compiled.outputContract !== 'json_envelope' ||
      isAdoptableStructuredReport(stage, parsed.structured));
  if (
    // One-Shot hard gate: the Formatter would be a SECOND physical request
    // for the same stage. Under the one_shot profile the chapter fails
    // closed instead — no automatic rescue call is ever issued.
    allowsFormatterCallForStage(stageInput.stagePolicy, stage) &&
    shouldRunWriterFormatter({
      stage,
      outputContract: compiled.outputContract,
      adoptedText: primaryAdoptable ? adopted.text : '',
      hasReasoning: Boolean(String(primary.reasoningText || '').trim()),
    })
  ) {
    const formatter = compileSharedWriterFormatterPrompt({
      stage,
      outputContract: compiled.outputContract,
      candidate: String(primary.text || primary.reasoningText || ''),
    });
    const formatterStartedAt = Date.now();
    const formatted = await invokePhysicalWriterCall({
      stage,
      stageInput,
      compiled: {
        messages: formatter.messages,
        maxTokens: Math.min(maxTokens, 4096),
        responseFormat:
          compiled.outputContract === 'json_envelope'
            ? 'json_object'
            : 'text',
      },
      reasoning: { thinking: { type: 'disabled' } },
      kind: 'formatter',
      receipts,
      call: () =>
        callWritingStageLLM(
          formatter.messages,
          Math.min(maxTokens, 4096),
          {
            queueClass: 'pipeline',
            queuePriority: 'normal',
            projectId: stageInput.frozenContext.projectId,
            taskId: stageInput.frozenContext.writingRunId,
            scenario: formatter.scenario,
            responseFormat:
              compiled.outputContract === 'json_envelope'
                ? 'json_object'
                : undefined,
            thinking: { type: 'disabled' },
            reasoningEffort: undefined,
            temperature: 0.2,
            top_p: 1,
            requestConfig,
          },
          stageInput.abortSignal,
        ),
    });
    adopted = adoptStructuredWriterText({
      stage,
      outputContract: compiled.outputContract,
      text: formatted.text,
      reasoningText: formatted.reasoningText,
    });
    if (!adopted.text.trim()) {
      throw annotateWriterReceipts(
        Object.assign(emptyWriterError(stage, formatted), {
          formatterUsed: true,
        }),
        receipts,
      );
    }
    try {
      const artifact = finalizeWriterArtifact(stage, stageInput, adopted.text);
      artifact.formatterUsed = true;
      artifact.adoptedFrom = adopted.adoptedFrom;
      attachUsage(artifact, primary, {
        kind: classifyWritingLlmCall({}),
        physicalRequestCount: primary.physicalRequestCount,
        protocolFallbackCount: primary.protocolFallbackCount,
      });
      attachUsage(artifact, formatted, {
        kind: classifyWritingLlmCall({ isFormatter: true }),
        physicalRequestCount: formatted.physicalRequestCount,
        protocolFallbackCount: formatted.protocolFallbackCount,
      });
      recordWriterCall(stageInput, {
        stage,
        kind: classifyWritingLlmCall({}),
        result: primary,
        physicalRequestCount: primary.physicalRequestCount,
        protocolFallbackCount: primary.protocolFallbackCount,
        durationMs: formatterStartedAt - primaryStartedAt,
      });
      recordWriterCall(stageInput, {
        stage,
        kind: classifyWritingLlmCall({ isFormatter: true }),
        result: formatted,
        physicalRequestCount: formatted.physicalRequestCount,
        protocolFallbackCount: formatted.protocolFallbackCount,
        durationMs: Date.now() - formatterStartedAt,
      });
      attachRequestReceipts(artifact, stageInput, receipts);
      await stageInput.persistAdapter?.persistStageArtifact(stage, artifact);
      return artifact;
    } catch (error) {
      throw annotateWriterReceipts(
        Object.assign(
          error instanceof Error ? error : new Error(String(error)),
          { formatterUsed: true },
        ),
        receipts,
      );
    }
  }
  try {
    const artifact = finalizeWriterArtifact(stage, stageInput, adopted.text);
    artifact.adoptedFrom = adopted.adoptedFrom;
    attachUsage(artifact, primary, {
      kind: classifyWritingLlmCall({}),
      physicalRequestCount: primary.physicalRequestCount,
      protocolFallbackCount: primary.protocolFallbackCount,
    });
    recordWriterCall(stageInput, {
      stage,
      kind: classifyWritingLlmCall({}),
      result: primary,
      physicalRequestCount: primary.physicalRequestCount,
      protocolFallbackCount: primary.protocolFallbackCount,
      durationMs: Date.now() - primaryStartedAt,
    });
    attachRequestReceipts(artifact, stageInput, receipts);
    await stageInput.persistAdapter?.persistStageArtifact(stage, artifact);
    return artifact;
  } catch (error) {
    throw annotateWriterReceipts(error, receipts);
  }
}

function startRequestReceipt(
  stage: SharedWritingStageName,
  stageInput: SharedWritingStageInput,
  compiled: {
    messages: Parameters<typeof buildWritingRequestReceipt>[0]['compiled']['messages'];
    maxTokens: number;
    responseFormat: 'json_object' | 'text';
  },
  reasoning: {
    thinking: { type: 'enabled' | 'disabled' };
    reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  },
  kind: 'logical_stage' | 'formatter' = 'logical_stage',
): WritingRequestReceipt {
  const receipt = buildWritingRequestReceipt({
    generationTraceId: stageInput.frozenContext.generationTraceId,
    stage,
    frozenContext: stageInput.frozenContext,
    compiled,
    thinking: reasoning.thinking,
    reasoningEffort: reasoning.reasoningEffort,
    kind,
  });
  recordWritingRequestReceipt(stageInput.trace, receipt);
  return receipt;
}

async function invokePhysicalWriterCall<T>(input: {
  stage: SharedWritingStageName;
  stageInput: SharedWritingStageInput;
  compiled: {
    messages: Parameters<typeof buildWritingRequestReceipt>[0]['compiled']['messages'];
    maxTokens: number;
    responseFormat: 'json_object' | 'text';
  };
  reasoning: {
    thinking: { type: 'enabled' | 'disabled' };
    reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  };
  kind?: 'logical_stage' | 'formatter';
  receipts: WritingRequestReceipt[];
  call: () => Promise<T>;
}): Promise<T> {
  const started = startRequestReceipt(
    input.stage,
    input.stageInput,
    input.compiled,
    input.reasoning,
    input.kind || 'logical_stage',
  );
  input.receipts.push(started);
  try {
    const result = await input.call();
    const completed = finishRequestReceipt(
      started,
      result as {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        reasoningTokens?: number | null;
        finishReason?: string | null;
        usage?: { prompt?: number; completion?: number; total?: number };
      },
      'succeeded',
      input.stageInput,
    );
    input.receipts[input.receipts.length - 1] = completed;
    return result;
  } catch (error) {
    const aborted = Boolean(input.stageInput.abortSignal?.aborted);
    const completed = finishRequestReceipt(
      started,
      {},
      aborted ? 'cancelled' : 'failed',
      input.stageInput,
    );
    input.receipts[input.receipts.length - 1] = completed;
    throw annotateWriterReceipts(error, input.receipts);
  }
}

function annotateWriterReceipts(
  error: unknown,
  receipts: WritingRequestReceipt[],
): Error {
  const next =
    error instanceof Error ? error : new Error(String(error || 'writer failed'));
  Object.assign(next, { requestReceipts: receipts });
  return next;
}

function finishRequestReceipt(
  receipt: WritingRequestReceipt,
  result: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number | null;
    finishReason?: string | null;
    usage?: { prompt?: number; completion?: number; total?: number };
  },
  outcome: 'succeeded' | 'failed' | 'cancelled',
  stageInput: SharedWritingStageInput,
): WritingRequestReceipt {
  const completed = completeWritingRequestReceipt(receipt, {
    outcome,
    usage: {
      inputTokens: Number(result.inputTokens || result.usage?.prompt || 0),
      outputTokens: Number(result.outputTokens || result.usage?.completion || 0),
      totalTokens: Number(
        result.totalTokens || result.usage?.total || 0,
      ),
      reasoningTokens: result.reasoningTokens ?? null,
    },
    finishReason: result.finishReason ?? null,
    resultArtifactRef: `artifact:${stageInput.frozenContext.generationTraceId}:${receipt.stage}`,
  });
  recordWritingRequestReceipt(stageInput.trace, completed);
  return completed;
}

function attachRequestReceipts(
  artifact: SharedWritingArtifact,
  _stageInput: SharedWritingStageInput,
  receipts: WritingRequestReceipt[],
): void {
  artifact.requestReceipts = receipts;
}

function finalizeWriterArtifact(
  stage: SharedWritingStageName,
  stageInput: SharedWritingStageInput,
  text: string,
): SharedWritingArtifact {
  const artifact = parseSharedWriterOutput(stage, text);
  if (
    stage === 'revision' &&
    !String(artifact.structured?.content || '').trim()
  ) {
    const draft = (stageInput.artifacts as { draft?: { body?: string } }).draft
      ?.body;
    if (String(draft || '').trim()) {
      artifact.body = String(draft);
    }
  }
  if (!artifact.body.trim()) {
    throw emptyWriterError(stage, { text, emptyReason: 'empty' });
  }
  if (
    (stage === 'qa' ||
      stage === 'review' ||
      stage === 'audit' ||
      stage === 'factCheck' ||
      stage === 'revision') &&
    !isAdoptableStructuredReport(stage, artifact.structured)
  ) {
    throw Object.assign(new Error(`${stage} 返回格式无效，需要结构化报告`), {
      code: 'SHARED_WRITER_INVALID_REPORT',
    });
  }
  assertStructuredReport(stage, artifact);
  return artifact;
}

function attachUsage(
  artifact: SharedWritingArtifact,
  result: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    usage?: { prompt?: number; completion?: number; total?: number };
    promptCacheHitTokens?: number | null;
    promptCacheMissTokens?: number | null;
  },
  extras?: {
    kind: 'logical_stage' | 'formatter' | 'post_writing_auxiliary';
    physicalRequestCount?: number;
    protocolFallbackCount?: number;
  },
): void {
  const inputTokens = Number(
    result.inputTokens ?? result.usage?.prompt ?? 0,
  );
  const outputTokens = Number(
    result.outputTokens ?? result.usage?.completion ?? 0,
  );
  const previous = artifact.usage;
  const nextInput = (previous?.inputTokens || 0) + inputTokens;
  const nextOutput = (previous?.outputTokens || 0) + outputTokens;
  const cacheHit = nullableSum(
    previous?.promptCacheHitTokens,
    result.promptCacheHitTokens,
  );
  const cacheMiss = nullableSum(
    previous?.promptCacheMissTokens,
    result.promptCacheMissTokens,
  );
  artifact.usage = {
    inputTokens: nextInput,
    outputTokens: nextOutput,
    totalTokens:
      (previous?.totalTokens || 0) +
      Number(
        result.totalTokens ?? result.usage?.total ?? inputTokens + outputTokens,
      ),
    promptCacheHitTokens: cacheHit,
    promptCacheMissTokens: cacheMiss,
    logicalStageCallCount:
      (previous?.logicalStageCallCount || 0) +
      (extras?.kind === 'logical_stage' ? 1 : 0),
    formatterCallCount:
      (previous?.formatterCallCount || 0) +
      (extras?.kind === 'formatter' ? 1 : 0),
    physicalRequestCount:
      (previous?.physicalRequestCount || 0) +
      Math.max(0, extras?.physicalRequestCount ?? 1),
    protocolFallbackCount:
      (previous?.protocolFallbackCount || 0) +
      Math.max(0, extras?.protocolFallbackCount ?? 0),
  };
}

function recordWriterCall(
  stageInput: SharedWritingStageInput,
  input: {
    stage: SharedWritingStageName;
    kind: 'logical_stage' | 'formatter' | 'post_writing_auxiliary';
    result: {
      inputTokens?: number;
      outputTokens?: number;
      usage?: { prompt?: number; completion?: number };
      promptCacheHitTokens?: number | null;
      promptCacheMissTokens?: number | null;
    };
    physicalRequestCount: number;
    protocolFallbackCount: number;
    durationMs: number;
  },
): void {
  recordWritingLlmCall(stageInput.frozenContext.generationTraceId, {
    kind: input.kind,
    stage: input.stage,
    inputTokens: Number(
      input.result.inputTokens ?? input.result.usage?.prompt ?? 0,
    ),
    outputTokens: Number(
      input.result.outputTokens ?? input.result.usage?.completion ?? 0,
    ),
    physicalRequestCount: Math.max(0, input.physicalRequestCount ?? 1),
    protocolFallbackCount: Math.max(0, input.protocolFallbackCount ?? 0),
    promptCacheHitTokens: input.result.promptCacheHitTokens ?? null,
    promptCacheMissTokens: input.result.promptCacheMissTokens ?? null,
    durationMs: Math.max(0, input.durationMs),
  });
}

function nullableSum(
  left: number | null | undefined,
  right: number | null | undefined,
): number | null {
  if (left == null && right == null) return null;
  return (left ?? 0) + (right ?? 0);
}

function emptyWriterError(
  stage: SharedWritingStageName,
  result: {
    emptyReason?: string | null;
    finishReason?: string | null;
    reasoningText?: string | null;
    text?: string | null;
  },
): Error & { code: string } {
  const reason = result.emptyReason || result.finishReason || 'empty';
  const reasoningOnly =
    result.emptyReason === 'reasoning_only' ||
    (Boolean(result.reasoningText && String(result.reasoningText).trim()) &&
      !String(result.text || '').trim());
  const message = reasoningOnly
    ? `${stage} 只返回了推理内容，未返回正文（${reason}）`
    : `${stage} 未返回正文（${reason}）`;
  return Object.assign(new Error(message), {
    code: 'SHARED_WRITER_EMPTY_OUTPUT',
  });
}

async function resolveFrozenRequestConfig(
  input: SharedWritingStageInput,
): Promise<LLMRequestConfig> {
  const frozen = input.modelConfig;
  if (!String(frozen.url || '').trim()) {
    throw Object.assign(
      new Error('冻结模型缺少 endpoint，无法在 Freeze 后发起请求'),
      { code: 'WRITING_FROZEN_MODEL_INCOMPLETE' },
    );
  }
  const apiKey = await resolveWritingCredential(
    frozen.credentialRef ??
      (frozen.configId != null
        ? { kind: 'llm-config-api-key', configId: frozen.configId }
        : null),
  );
  return {
    id: frozen.configId ?? undefined,
    name: frozen.name,
    provider_type: (frozen.providerType ||
      'openai_compatible') as LLMRequestConfig['provider_type'],
    api_key: apiKey,
    model_name: frozen.modelName,
    url: frozen.url,
    context_window: frozen.contextWindow,
    max_output_tokens: frozen.maxOutputTokens,
    allow_insecure_lan_http: frozen.allowInsecureLanHttp,
    thinking: frozen.thinking,
  };
}

export function evaluateStageRequirements(
  input: SharedWritingStageInput,
  artifact: SharedWritingArtifact,
) {
  return evaluateWritingRequirements({
    requirements: input.requirements,
    satisfiedIds: artifact.appliedRequirementIds || [],
  });
}

export function resolveStageSkipOrNull(
  stage: SharedWritingStageName,
  input: SharedWritingStageInput,
) {
  return resolveSharedStageSkip(input.stagePolicy, stage);
}

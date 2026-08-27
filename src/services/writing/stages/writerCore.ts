/**
 * THE one Shared Writer Core. Every post-Freeze prose stage goes through here.
 */
import type { LLMRequestConfig, LLMResult } from '../../llm/types';
import {
  selectStructuredCandidate,
  type StructuredCandidateChannel,
} from '../../pipeline/structuredCandidate';
import { compileSharedWritingPrompt } from '../prompt/sharedPromptCompiler';
import { resolveQaEvidenceProjection } from '../prompt/evidenceQaProjection';
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
  hasExplicitRevisionNoOp,
  shouldRunWriterFormatter,
  validateRevisionStructuredContract,
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
import { aggregateStageFindings } from '../context/findingsAggregator';
import { resolveAnchoredRevisionOutput } from '../revision/anchoredSegmentRepair';
import { extractAuditJsonPayload } from '../../pipelineAuditValidator';
import { normalizeStructuredWriterPayload } from './writerRecovery';

/**
 * B6/B7 failure telemetry carried from the Shared Writer to the durable
 * stage-attempt ledger.  It deliberately contains shapes/counts, never the
 * provider response body or the user's manuscript text.
 */
export interface SharedWriterFailureDiagnostics {
  stage: SharedWritingStageName;
  errorCode: string | null;
  parseFailureCode: string | null;
  responseChannel: 'content' | 'reasoning' | 'both' | 'empty';
  responseCandidateChannel: StructuredCandidateChannel | null;
  finishReason: string | null;
  emptyReason: string | null;
  visibleOutputTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  formatterUsed: boolean;
  validationDetailsJson: string;
}

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
  const extracted = extractAuditJsonPayload(trimmed);
  if (extracted.jsonText) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(extracted.jsonText);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { stage, body: trimmed, diagnostics: [] };
    }
    const json = normalizeStructuredWriterPayload(
      stage,
      parsed as Record<string, unknown>,
    );
    const body =
      typeof json.content === 'string' && json.content.trim()
        ? json.content
        : typeof json.body === 'string' && json.body.trim()
        ? json.body
        : typeof json.report === 'string' && json.report.trim()
        ? json.report
        : extracted.jsonText;
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

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function asFiniteOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeAttemptResponseChannel(
  channel: StructuredCandidateChannel | 'empty',
): 'content' | 'reasoning' | 'both' | 'empty' {
  if (channel === 'empty') return 'empty';
  if (channel === 'content' || channel === 'both_content_preferred') {
    return channel === 'content' ? 'content' : 'both';
  }
  if (channel === 'reasoning' || channel === 'both_reasoning_preferred') {
    return channel === 'reasoning' ? 'reasoning' : 'both';
  }
  return 'empty';
}

function safeRootKeys(value: Record<string, unknown> | undefined): string[] {
  return value ? Object.keys(value).sort().slice(0, 64) : [];
}

/**
 * Build bounded, body-free diagnostics for a failed Shared Writer stage.
 * `selectStructuredCandidate` is reused only for observation; it never
 * changes the candidate that the business validator adopts.
 */
export function buildSharedWriterFailureDiagnostics(input: {
  stage: SharedWritingStageName;
  result?: Partial<Pick<LLMResult, 'text' | 'reasoningText' | 'inputTokens' |
    'outputTokens' | 'totalTokens' | 'reasoningTokens' | 'visibleOutputTokens' |
    'finishReason' | 'emptyReason'>>;
  adoptedText?: string | null;
  parsed?: SharedWritingArtifact | null;
  error?: unknown;
  formatterUsed?: boolean;
}): SharedWriterFailureDiagnostics {
  const result = input.result || {};
  const errorRecord =
    input.error && typeof input.error === 'object'
      ? (input.error as Record<string, unknown>)
      : {};
  const errorCode =
    typeof errorRecord.code === 'string' && errorRecord.code.trim()
      ? errorRecord.code.trim()
      : null;
  const selection = selectStructuredCandidate({
    content: result.text,
    reasoning: result.reasoningText,
    expectedRootKeys:
      input.stage === 'revision'
        ? [
            'content',
            'body',
            'finalContent',
            'revisedBody',
            'strategy',
            'actions',
            'preserve',
            'ending',
            'verdict',
            'report',
          ]
        : ['content', 'verdict', 'findings'],
    findingKeys: ['findings', 'actions', 'issues', 'errors', 'warnings'],
    allowSingleItemArray: input.stage === 'revision',
  });
  const structuredKeys = safeRootKeys(input.parsed?.structured);
  const candidate = selection.candidate;
  const selectionFailure = candidate
    ? null
    : selection.rejected[0]?.reason || 'no_structured_candidate';
  const parseFailureCode =
    errorCode?.startsWith('SHARED_WRITER_') ||
    errorCode === 'PIPELINE_RESPONSE_INVALID'
      ? errorCode
      : selectionFailure &&
        (input.stage === 'revision' || input.parsed?.structured != null)
      ? `WRITER_${selectionFailure.toUpperCase()}`
      : null;
  const validationDetails = {
    version: 1,
    stage: input.stage,
    rawContentChars: String(result.text || '').trim().length,
    reasoningChars: String(result.reasoningText || '').trim().length,
    adoptedChars: String(input.adoptedText || '').trim().length,
    candidateChars: candidate?.candidateChars || 0,
    candidateHash: candidate?.candidateHash || null,
    candidateRootKeys: candidate?.rootKeys || [],
    artifactRootKeys: structuredKeys,
    rejectedChannels: selection.rejected.slice(0, 4),
    truncatedLikely: Boolean(candidate?.truncatedLikely),
    selectionResponseChannel: selection.responseChannel,
  };
  return {
    stage: input.stage,
    errorCode,
    parseFailureCode,
    responseChannel: normalizeAttemptResponseChannel(selection.responseChannel),
    responseCandidateChannel: candidate?.responseChannel || null,
    finishReason:
      typeof result.finishReason === 'string' ? result.finishReason : null,
    emptyReason:
      typeof result.emptyReason === 'string' ? result.emptyReason : null,
    visibleOutputTokens: asFiniteOrNull(result.visibleOutputTokens),
    inputTokens: asFiniteOrNull(result.inputTokens),
    outputTokens: asFiniteOrNull(result.outputTokens),
    totalTokens: asFiniteOrNull(result.totalTokens),
    reasoningTokens: asFiniteOrNull(result.reasoningTokens),
    formatterUsed: input.formatterUsed === true,
    validationDetailsJson: JSON.stringify(validationDetails),
  };
}

function annotateWriterFailure(
  error: unknown,
  input: Parameters<typeof buildSharedWriterFailureDiagnostics>[0],
): Error & { writerDiagnostics: SharedWriterFailureDiagnostics } {
  const next =
    error instanceof Error ? error : new Error(String(error || 'writer failed'));
  const existing = (next as Error & {
    writerDiagnostics?: SharedWriterFailureDiagnostics;
  }).writerDiagnostics;
  if (!existing) {
    Object.assign(next, {
      writerDiagnostics: buildSharedWriterFailureDiagnostics({
        ...input,
        error,
      }),
    });
  }
  return next as Error & { writerDiagnostics: SharedWriterFailureDiagnostics };
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
  // B4: QA 阶段先尝试 Evidence QA Projection（高置信 → 窄投影；
  // 零命中/无相关条目/异常 → fail-safe 回退 union，见 resolver）。
  const qaEvidence =
    stage === 'qa'
      ? resolveQaEvidenceProjection({
          stage,
          frozenContext: stageInput.frozenContext,
          artifacts: stageInput.artifacts,
          requirements: stageInput.requirements,
        })
      : null;
  const compiled = compileSharedWritingPrompt({
    stage,
    frozenContext: stageInput.frozenContext,
    artifacts: stageInput.artifacts,
    requirements: stageInput.requirements,
    stagePolicy: stageInput.stagePolicy,
    qaEvidence,
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
    // Record the provider call before parsing/contract validation. A response
    // can be physically successful yet be rejected by the local writer
    // contract; that request still belongs in the chapter's token and
    // physical-request ledger.
    recordWriterCall(stageInput, {
      stage,
      kind: classifyWritingLlmCall({}),
      result: injected,
      physicalRequestCount: injected.physicalRequestCount ?? 1,
      protocolFallbackCount: injected.protocolFallbackCount ?? 0,
      durationMs: Date.now() - injectedStartedAt,
    });
    let injectedAdopted: ReturnType<typeof adoptStructuredWriterText> = {
      text: String(injected.text || ''),
      adoptedFrom: injected.text ? 'content' : null,
    };
    try {
      injectedAdopted = adoptStructuredWriterText({
        stage,
        outputContract: compiled.outputContract,
        text: injected.text,
        reasoningText: (injected as { reasoningText?: string }).reasoningText,
      });
      const artifact = finalizeWriterArtifact(
        stage,
        stageInput,
        injectedAdopted.text,
        injected as Partial<LLMResult>,
      );
      attachUsage(artifact, injected, {
        kind: classifyWritingLlmCall({}),
        physicalRequestCount: injected.physicalRequestCount,
        protocolFallbackCount: injected.protocolFallbackCount,
      });
      attachRequestReceipts(artifact, stageInput, receipts);
      await stageInput.persistAdapter?.persistStageArtifact(stage, artifact);
      return artifact;
    } catch (error) {
      throw annotateWriterReceipts(
        annotateWriterFailure(error, {
          stage,
          result: injected as Partial<LLMResult>,
          adoptedText: injectedAdopted.text,
        }),
        receipts,
      );
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
  // Keep observability truthful even when a later local contract check rejects
  // the provider response. The receipt is not a substitute for the chapter
  // ledger: both must contain the same physical call.
  recordWriterCall(stageInput, {
    stage,
    kind: classifyWritingLlmCall({}),
    result: primary,
    physicalRequestCount: primary.physicalRequestCount,
    protocolFallbackCount: primary.protocolFallbackCount,
    durationMs: Date.now() - primaryStartedAt,
  });
  if (primary.finishReason === 'content_filter') {
    throw annotateWriterReceipts(
      annotateWriterFailure(
        Object.assign(new Error(`${stage} 被内容安全策略拦截`), {
          code: 'SHARED_WRITER_CONTENT_FILTER',
        }),
        { stage, result: primary },
      ),
      receipts,
    );
  }
  if (
    stage === 'revision' &&
    String(primary.finishReason || '').toLowerCase() === 'length'
  ) {
    throw annotateWriterReceipts(
      annotateWriterFailure(
        Object.assign(
          new Error('Revision 输出以 finishReason=length 截断，拒绝持久化'),
          { code: 'SHARED_WRITER_TRUNCATED_OUTPUT' },
        ),
        { stage, result: primary },
      ),
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
        maxTokens,
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
          maxTokens,
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
    recordWriterCall(stageInput, {
      stage,
      kind: classifyWritingLlmCall({ isFormatter: true }),
      result: formatted,
      physicalRequestCount: formatted.physicalRequestCount,
      protocolFallbackCount: formatted.protocolFallbackCount,
      durationMs: Date.now() - formatterStartedAt,
    });
    adopted = adoptStructuredWriterText({
      stage,
      outputContract: compiled.outputContract,
      text: formatted.text,
      reasoningText: formatted.reasoningText,
    });
    if (!adopted.text.trim()) {
      throw annotateWriterReceipts(
        annotateWriterFailure(
          Object.assign(emptyWriterError(stage, formatted), {
            formatterUsed: true,
          }),
          {
            stage,
            result: formatted,
            adoptedText: adopted.text,
            formatterUsed: true,
          },
        ),
        receipts,
      );
    }
    try {
      const artifact = finalizeWriterArtifact(
        stage,
        stageInput,
        adopted.text,
        formatted as Partial<LLMResult>,
      );
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
      attachRequestReceipts(artifact, stageInput, receipts);
      await stageInput.persistAdapter?.persistStageArtifact(stage, artifact);
      return artifact;
    } catch (error) {
      throw annotateWriterReceipts(
        annotateWriterFailure(
          Object.assign(
            error instanceof Error ? error : new Error(String(error)),
            { formatterUsed: true },
          ),
          {
            stage,
            result: formatted,
            adoptedText: adopted.text,
            formatterUsed: true,
          },
        ),
        receipts,
      );
    }
  }
  try {
    const artifact = finalizeWriterArtifact(
      stage,
      stageInput,
      adopted.text,
      primary as Partial<LLMResult>,
    );
    artifact.adoptedFrom = adopted.adoptedFrom;
    attachUsage(artifact, primary, {
      kind: classifyWritingLlmCall({}),
      physicalRequestCount: primary.physicalRequestCount,
      protocolFallbackCount: primary.protocolFallbackCount,
    });
    attachRequestReceipts(artifact, stageInput, receipts);
    await stageInput.persistAdapter?.persistStageArtifact(stage, artifact);
    return artifact;
  } catch (error) {
    throw annotateWriterReceipts(
      annotateWriterFailure(error, {
        stage,
        result: primary,
        adoptedText: adopted.text,
        parsed,
      }),
      receipts,
    );
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
      error as {
        physicalRequestCount?: number;
        protocolFallbackCount?: number;
      },
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
    physicalRequestCount?: number;
    protocolFallbackCount?: number;
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
    physicalRequestCount:
      result.physicalRequestCount == null
        ? 1
        : Math.max(0, Number(result.physicalRequestCount) || 0),
    protocolFallbackCount:
      result.protocolFallbackCount == null
        ? 0
        : Math.max(0, Number(result.protocolFallbackCount) || 0),
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
  result?: Partial<LLMResult>,
): SharedWritingArtifact {
  const artifact = parseSharedWriterOutput(stage, text);
  if (stage === 'revision') {
    if (String(result?.finishReason || '').toLowerCase() === 'length') {
      throw Object.assign(
        new Error('Revision 输出以 finishReason=length 截断，拒绝持久化'),
        { code: 'SHARED_WRITER_TRUNCATED_OUTPUT' },
      );
    }
    const compactRevision =
      stageInput.stagePolicy.values?.pipelineTopologyVersion ===
      'compact_standard';
    if (!artifact.structured && compactRevision) {
      throw Object.assign(
        new Error('Revision 返回格式无效，未解析出结构化 JSON 合同'),
        { code: 'SHARED_WRITER_INVALID_REVISION_CONTRACT' },
      );
    }
    const draftBody = String(
      (stageInput.artifacts as { draft?: { body?: string } }).draft?.body ?? '',
    );
    if (artifact.structured) {
      const segmentResolution = resolveAnchoredRevisionOutput({
        draftBody,
        findings: aggregateStageFindings(stageInput.artifacts),
        structured: artifact.structured,
      });
      if (segmentResolution.status === 'invalid') {
        throw Object.assign(
          new Error(
            `Revision 局部段级修复无效且未提供完整正文回退（${segmentResolution.reason}）`,
          ),
          { code: 'SHARED_WRITER_INVALID_SEGMENT_REPAIR' },
        );
      }
      if (
        segmentResolution.status === 'segment_repair' ||
        segmentResolution.status === 'full_revision_fallback'
      ) {
        artifact.body = segmentResolution.body;
        artifact.structured = {
          ...artifact.structured,
          content: segmentResolution.body,
          segmentRepair: segmentResolution.metadata,
        };
        artifact.diagnostics = [
          ...(artifact.diagnostics || []),
          ...segmentResolution.diagnostics,
        ];
      }
    }
    if (
      !compactRevision &&
      artifact.structured &&
      !String(artifact.structured.content || '').trim()
    ) {
      // Historical Legacy Brief may be a report-only contract. It has no
      // Compact Revision contract fields, but its body authority remains the
      // already-persisted Draft instead of the JSON report envelope.
      artifact.body = draftBody;
    }
    if (
      compactRevision &&
      !String(artifact.structured?.content || '').trim() &&
      hasExplicitRevisionNoOp(artifact.structured!)
    ) {
      artifact.body = draftBody;
    }
    if (compactRevision) {
      const validation = validateRevisionStructuredContract({
        parsed: artifact.structured,
        finalBody: artifact.body,
      });
      if (!validation.valid) {
        const stateProposalFailure =
          validation.reason?.startsWith('proposal_') ||
          validation.reason?.startsWith('finalStateProposals');
        throw Object.assign(
          new Error(`Revision 返回格式无效（${validation.reason || 'unknown'}）`),
          {
            code: stateProposalFailure
              ? 'SHARED_WRITER_INVALID_STATE_PROPOSAL_CONTRACT'
              : 'SHARED_WRITER_INVALID_REVISION_CONTRACT',
          },
        );
      }
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
    provider_adapter_id: frozen.providerAdapterId,
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

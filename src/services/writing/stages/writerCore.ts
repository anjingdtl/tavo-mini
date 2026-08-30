/**
 * THE one Shared Writer Core. Every post-Freeze prose stage goes through here.
 */
import type {
  LLMFailurePhase,
  LLMRequestConfig,
  LLMRequestMetrics,
  LLMResult,
} from '../../llm/types';
import type { LLMFailureClass } from '../../llm/requestPolicy';
import { resolveProviderOutputBudget } from '../../llm/providerCapabilities';
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
  bindRevisionStateProposalFingerprint,
  sanitizePhase4RevisionSidecar,
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
import {
  completeWritingGovernorShadow,
  decideWritingGovernorWire,
  getWritingGovernorProfileStore,
  resolveWritingGovernorCurrentRequestWire,
  resolveWritingGovernorShadow,
  shouldEnableWritingGovernorProduction,
  type WritingGovernorShadow,
} from '../governor/writingGovernor';
import { deriveGenerationQualityProfile } from '../contracts/generationQualityProfile';
import { resolveExecutionProfileFromValues } from '../contracts/executionProfile';
import { isPhase4GatePolicy } from '../gates/phase4GatePolicy';

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
    'finishReason' | 'emptyReason' | 'failurePhase'>>;
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
        : ['content', 'decision', 'verdict', 'findings'],
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
  const errorRecord = next as Error & {
    code?: string;
    failureClass?: string | null;
    failurePhase?: LLMFailurePhase | null;
    requestMayHaveExecuted?: boolean | null;
  };
  const errorCode = String(errorRecord.code || '').toUpperCase();
  const inferredPhase =
    errorRecord.failurePhase ||
    input.result?.failurePhase ||
    (errorCode.includes('TRUNCATED') ? 'generation' : undefined) ||
    (errorCode.includes('INVALID') || errorCode.includes('EMPTY')
      ? 'parse'
      : undefined);
  if (inferredPhase) {
    const fallbackFailureClass =
      inferredPhase === 'outcome_unknown'
        ? 'outcome_unknown'
        : inferredPhase === 'network'
          ? 'safe_retry'
          : inferredPhase === 'parse' || inferredPhase === 'generation'
            ? 'response_invalid'
            : 'fatal';
    Object.assign(errorRecord, {
      failurePhase: inferredPhase,
      failureClass: errorRecord.failureClass || fallbackFailureClass,
      requestMayHaveExecuted:
        errorRecord.requestMayHaveExecuted ??
        (inferredPhase !== 'queue' && inferredPhase !== 'network'),
    });
  }
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
  const legacyMaxTokens = Math.min(
    compiled.maxTokens,
    Math.max(256, stageInput.modelConfig.maxOutputTokens || compiled.maxTokens),
  );
  const receipts: WritingRequestReceipt[] = [];
  if (stageInput.callStage) {
    const injectedStartedAt = Date.now();
    const injectedReasoning = { thinking: { type: 'enabled' as const } };
    const governorShadow = buildWritingGovernorShadow({
      stage,
      stageInput,
      messages: compiled.messages,
      maxTokens: legacyMaxTokens,
      responseFormat: compiled.responseFormat,
      reasoning: injectedReasoning,
    });
    const wireMaxTokens = resolveStageWireMax(
      stage,
      legacyMaxTokens,
      governorShadow,
      isPhase4GatePolicy(stageInput.stagePolicy.values),
    );
    const injected = await invokePhysicalWriterCall({
      stage,
      stageInput,
      compiled,
      reasoning: injectedReasoning,
      governorShadow,
      receipts,
      call: () =>
        stageInput.callStage!({
          stage,
          messages: compiled.messages,
          maxTokens: wireMaxTokens,
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
      promoteSuccessfulGovernorReceipt(receipts, stageInput.trace);
      attachUsage(artifact, injected, {
        kind: classifyWritingLlmCall({}),
        physicalRequestCount: injected.physicalRequestCount,
        protocolFallbackCount: injected.protocolFallbackCount,
      });
      attachRequestReceipts(artifact, stageInput, receipts);
      await persistWriterArtifact(stage, stageInput, artifact, receipts);
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
  const primaryResponseFormat =
    compiled.responseFormat === 'json_object' || isReport
      ? 'json_object'
      : compiled.responseFormat;
  const governorShadow = buildWritingGovernorShadow({
    stage,
    stageInput,
    messages: compiled.messages,
    maxTokens: legacyMaxTokens,
    responseFormat: primaryResponseFormat,
    reasoning: stageReasoning,
  });
  const maxTokens = resolveStageWireMax(
    stage,
    legacyMaxTokens,
    governorShadow,
    isPhase4GatePolicy(stageInput.stagePolicy.values),
  );
  const primaryStartedAt = Date.now();
  const primary = await invokePhysicalWriterCall({
    stage,
    stageInput,
    compiled: {
      messages: compiled.messages,
      maxTokens,
      responseFormat: primaryResponseFormat,
    },
    reasoning: stageReasoning,
    governorShadow,
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
  try {
    assertWriterFinishReason(stage, primary);
  } catch (error) {
    throw annotateWriterReceipts(
      annotateWriterFailure(error, {
        stage,
        result: primary,
        adoptedText: '',
      }),
      receipts,
    );
  }
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
        maxTokens: legacyMaxTokens,
        responseFormat:
          compiled.outputContract === 'json_envelope'
            ? 'json_object'
            : 'text',
      },
      reasoning: { thinking: { type: 'disabled' } },
      governorShadow: buildWritingGovernorShadow({
        stage,
        stageInput,
        messages: formatter.messages,
        maxTokens: legacyMaxTokens,
        responseFormat:
          compiled.outputContract === 'json_envelope'
            ? 'json_object'
            : 'text',
        reasoning: { thinking: { type: 'disabled' } },
      }),
      kind: 'formatter',
      receipts,
        call: () =>
          callWritingStageLLM(
            formatter.messages,
            legacyMaxTokens,
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
    try {
      assertWriterFinishReason(stage, formatted);
    } catch (error) {
      throw annotateWriterReceipts(
        annotateWriterFailure(error, {
          stage,
          result: formatted,
          adoptedText: '',
          formatterUsed: true,
        }),
        receipts,
      );
    }
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
      promoteSuccessfulGovernorReceipt(receipts, stageInput.trace);
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
      await persistWriterArtifact(stage, stageInput, artifact, receipts);
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
    promoteSuccessfulGovernorReceipt(receipts, stageInput.trace);
    artifact.adoptedFrom = adopted.adoptedFrom;
    attachUsage(artifact, primary, {
      kind: classifyWritingLlmCall({}),
      physicalRequestCount: primary.physicalRequestCount,
      protocolFallbackCount: primary.protocolFallbackCount,
    });
    attachRequestReceipts(artifact, stageInput, receipts);
    await persistWriterArtifact(stage, stageInput, artifact, receipts);
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

function resolveStageWireMax(
  stage: SharedWritingStageName,
  legacyWireMax: number,
  shadow: WritingGovernorShadow,
  phase4 = false,
): number {
  const decision = phase4
    ? resolveWritingGovernorCurrentRequestWire(shadow, legacyWireMax)
    : decideWritingGovernorWire(
        shadow,
        shouldEnableWritingGovernorProduction(stage, shadow),
      );
  if (decision.blocked) {
    const error = new Error(
      `写作预算预检失败：${decision.reason || 'demand_exceeds_hard_ceiling'}`,
    );
    Object.assign(error, {
      code: phase4
        ? 'WRITING_PROVIDER_CAPABILITY_BLOCKED'
        : 'WRITING_GOVERNOR_PREFLIGHT_BLOCKED',
      governorShadow: shadow,
      requestMayHaveExecuted: false,
      physicalRequestCount: 0,
    });
    throw error;
  }
  return (phase4 || decision.enabled) && decision.wireMax != null
    ? Math.max(1, Math.floor(decision.wireMax))
    : legacyWireMax;
}

function resolveProviderCapabilityBoundary(
  stageInput: SharedWritingStageInput,
): ReturnType<typeof resolveProviderOutputBudget> | null {
  try {
    return resolveProviderOutputBudget({
      config: {
        provider_type: stageInput.modelConfig.providerType as 'openai_compatible',
        model_name: stageInput.modelConfig.modelName,
        url: stageInput.modelConfig.url,
        context_window: stageInput.modelConfig.contextWindow,
        max_output_tokens: stageInput.modelConfig.maxOutputTokens,
        provider_adapter_id: stageInput.modelConfig.providerAdapterId,
      },
      requestedMaxTokens: stageInput.modelConfig.maxOutputTokens,
    });
  } catch {
    return null;
  }
}

function buildWritingGovernorShadow(input: {
  stage: SharedWritingStageName;
  stageInput: SharedWritingStageInput;
  messages: Parameters<typeof buildWritingRequestReceipt>[0]['compiled']['messages'];
  maxTokens: number;
  responseFormat: 'json_object' | 'text';
  reasoning: {
    thinking: { type: 'enabled' | 'disabled' };
    reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  };
}): WritingGovernorShadow {
  const values = input.stageInput.stagePolicy.values || {};
  const providerBoundary = resolveProviderCapabilityBoundary(
    input.stageInput,
  );
  return resolveWritingGovernorShadow(
    {
      stage: input.stage,
      messages: input.messages,
      legacyWireMax: input.maxTokens,
      contextWindow: input.stageInput.modelConfig.contextWindow,
      completionCapability: input.stageInput.modelConfig.maxOutputTokens,
      providerWireCeiling: providerBoundary?.providerLimit ?? null,
      providerAdapterId:
        providerBoundary?.adapterId ??
        input.stageInput.modelConfig.providerAdapterId,
      modelName: input.stageInput.modelConfig.modelName,
      targetChars:
        input.stageInput.frozenContext.targetChars ??
        (values.targetChapterChars as number | null | undefined),
      outputContract: input.responseFormat === 'json_object' ? 'json_envelope' : 'prose',
      qualityProfile: deriveGenerationQualityProfile({
        qualityProfile: values.qualityProfile,
        executionProfile: values.executionProfile,
        reasoningEffort: input.reasoning.reasoningEffort,
      }),
      executionProfile: resolveExecutionProfileFromValues(values),
      thinking: input.reasoning.thinking,
      reasoningEffort: input.reasoning.reasoningEffort ?? null,
    },
    getWritingGovernorProfileStore(),
  );
}

function promoteSuccessfulGovernorReceipt(
  receipts: WritingRequestReceipt[],
  trace: SharedWritingStageInput['trace'],
): void {
  const index = receipts.length - 1;
  if (index < 0) return;
  const current = receipts[index];
  if (current.outcome !== 'succeeded' || !current.governorShadow) return;
  const shadow = current.governorShadow;
  const updatedShadow = completeWritingGovernorShadow(
    shadow,
    {
      actualCompletionUsage: shadow.actualCompletionUsage,
      visibleOutput: shadow.visibleOutput,
      reasoningUsage: shadow.reasoningUsage,
      finishReason: shadow.finishReason,
      latencyMs: shadow.latencyMs,
      businessResultValid: true,
      failureClass: null,
    },
    getWritingGovernorProfileStore(),
  );
  const updated = completeWritingRequestReceipt(current, {
    outcome: current.outcome,
    governorShadow: updatedShadow,
  });
  receipts[index] = updated;
  recordWritingRequestReceipt(trace, updated);
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
  governorShadow?: WritingGovernorShadow,
  kind: 'logical_stage' | 'formatter' = 'logical_stage',
): WritingRequestReceipt {
  const receipt = buildWritingRequestReceipt({
    generationTraceId: stageInput.frozenContext.generationTraceId,
    scenario: stageInput.trace.scenario,
    stage,
    frozenContext: stageInput.frozenContext,
    compiled,
    thinking: reasoning.thinking,
    reasoningEffort: reasoning.reasoningEffort,
    kind,
    governorShadow,
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
  governorShadow?: WritingGovernorShadow;
  kind?: 'logical_stage' | 'formatter';
  receipts: WritingRequestReceipt[];
  call: () => Promise<T>;
}): Promise<T> {
  const started = startRequestReceipt(
    input.stage,
    input.stageInput,
    input.compiled,
    input.reasoning,
    input.governorShadow,
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
        rawUsage?: LLMResult['rawUsage'];
        metrics?: LLMRequestMetrics;
        outputBudget?: LLMResult['outputBudget'];
         providerRequestId?: string | null;
         failurePhase?: LLMFailurePhase | null;
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
        failureClass?: string | null;
        requestMayHaveExecuted?: boolean | null;
        providerRequestId?: string | null;
        metrics?: LLMRequestMetrics;
         outputBudget?: LLMResult['outputBudget'];
         failurePhase?: LLMFailurePhase | null;
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
  const record = next as Error & {
    failureClass?: string | null;
    failurePhase?: LLMFailurePhase | null;
    requestMayHaveExecuted?: boolean | null;
  };
  if (record.failurePhase && receipts.length > 0) {
    const current = receipts[receipts.length - 1];
    const fallbackFailureClass: LLMFailureClass =
      normalizeFailureClass(record.failureClass) ||
      (record.failurePhase === 'outcome_unknown'
        ? 'outcome_unknown'
        : record.failurePhase === 'parse' || record.failurePhase === 'generation'
          ? 'response_invalid'
          : 'fatal');
    receipts[receipts.length - 1] = completeWritingRequestReceipt(current, {
      outcome: current.outcome,
      failureClass: current.failureClass || fallbackFailureClass,
      failurePhase: record.failurePhase,
      requestMayHaveExecuted:
        current.requestMayHaveExecuted ?? record.requestMayHaveExecuted ?? true,
    });
  }
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
    visibleOutputTokens?: number | null;
    finishReason?: string | null;
    usage?: { prompt?: number; completion?: number; total?: number };
    rawUsage?: LLMResult['rawUsage'];
    metrics?: LLMRequestMetrics;
    outputBudget?: LLMResult['outputBudget'];
    providerRequestId?: string | null;
    failurePhase?: LLMFailurePhase | null;
    failureClass?: string | null;
    requestMayHaveExecuted?: boolean | null;
    emptyReason?: string | null;
    physicalRequestCount?: number;
    protocolFallbackCount?: number;
  },
  outcome: 'succeeded' | 'failed' | 'cancelled',
  stageInput: SharedWritingStageInput,
): WritingRequestReceipt {
  const usage = resolveReceiptUsage(result);
  const failureClass =
    outcome === 'succeeded'
      ? null
      : normalizeFailureClass(result.failureClass);
  const receiptOutcome =
    outcome === 'failed' && failureClass === 'outcome_unknown'
      ? 'outcome_unknown'
      : outcome;
  const completed = completeWritingRequestReceipt(receipt, {
    outcome: receiptOutcome,
    usage,
    finishReason: result.finishReason ?? null,
    emptyReason: result.emptyReason ?? null,
    failureClass,
    failurePhase: result.failurePhase ?? null,
    requestMayHaveExecuted:
      result.requestMayHaveExecuted ??
      (outcome === 'succeeded' ? false : true),
    providerRequestId: result.providerRequestId ?? null,
    actualPromptTokens: usage.inputTokens,
    outputBudget: result.outputBudget ?? null,
    metrics: result.metrics ?? null,
    governorShadow: receipt.governorShadow
      ? completeWritingGovernorShadow(
          receipt.governorShadow,
          {
            actualCompletionUsage: usage.outputTokens,
            visibleOutput: usage.visibleOutputTokens ?? null,
            reasoningUsage: usage.reasoningTokens ?? null,
            finishReason: result.finishReason ?? null,
            latencyMs: result.metrics?.totalMs ?? null,
            businessResultValid: false,
            failureClass,
            failurePhase: result.failurePhase ?? null,
          },
          getWritingGovernorProfileStore(),
        )
      : undefined,
    timings: {
      persistMs: stageInput.persistAdapter ? null : 0,
    },
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

type ReceiptResult = Parameters<typeof finishRequestReceipt>[1];

function readNullableUsageValue(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function hasOwn(input: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

/**
 * Provider usage is observation data. If rawUsage exists, its missing fields
 * stay null even when the provider result carries local fallback estimates for
 * business compatibility. Injected test callers without rawUsage may still
 * provide explicit numeric usage fields.
 */
function resolveReceiptUsage(result: ReceiptResult) {
  const rawUsagePresent = hasOwn(result, 'rawUsage');
  const raw = result.rawUsage as
    | {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        completion_tokens_details?: { reasoning_tokens?: unknown };
      }
    | undefined;
  const read = (
    direct: unknown,
    rawValue: unknown,
    nested: unknown,
  ): number | null => {
    if (rawUsagePresent) return readNullableUsageValue(rawValue);
    if (direct !== undefined) return readNullableUsageValue(direct);
    return readNullableUsageValue(nested);
  };
  const inputTokens = read(
    result.inputTokens,
    raw?.prompt_tokens,
    result.usage?.prompt,
  );
  const outputTokens = read(
    result.outputTokens,
    raw?.completion_tokens,
    result.usage?.completion,
  );
  const totalTokens = read(
    result.totalTokens,
    raw?.total_tokens,
    result.usage?.total,
  );
  const reasoningTokens = rawUsagePresent
    ? readNullableUsageValue(raw?.completion_tokens_details?.reasoning_tokens)
    : readNullableUsageValue(result.reasoningTokens);
  const visibleOutputTokens = rawUsagePresent
    ? reasoningTokens != null && outputTokens != null
      ? Math.max(0, outputTokens - reasoningTokens)
      : null
    : readNullableUsageValue(result.visibleOutputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    visibleOutputTokens,
  };
}

function normalizeFailureClass(value: unknown):
  | 'safe_retry'
  | 'outcome_unknown'
  | 'rate_limit'
  | 'account_quota'
  | 'config_error'
  | 'context_error'
  | 'content_filter'
  | 'response_invalid'
  | 'fatal'
  | null {
  return [
    'safe_retry',
    'outcome_unknown',
    'rate_limit',
    'account_quota',
    'config_error',
    'context_error',
    'content_filter',
    'response_invalid',
    'fatal',
  ].includes(String(value))
    ? (String(value) as ReturnType<typeof normalizeFailureClass>)
    : null;
}

async function persistWriterArtifact(
  stage: SharedWritingStageName,
  stageInput: SharedWritingStageInput,
  artifact: SharedWritingArtifact,
  receipts: WritingRequestReceipt[],
): Promise<void> {
  const startedAt = Date.now();
  try {
    await stageInput.persistAdapter?.persistStageArtifact(stage, artifact);
  } catch (error) {
    // The provider result is already known, but the durable artifact is not.
    // Keep that distinction explicit so recovery cannot mistake a persist
    // failure for a transport outcome_unknown or silently learn from it.
    for (let index = 0; index < receipts.length; index += 1) {
      const current = receipts[index];
      const updated = completeWritingRequestReceipt(current, {
        outcome: current.outcome,
        failureClass: current.failureClass || 'fatal',
        failurePhase: 'persist',
        requestMayHaveExecuted: current.requestMayHaveExecuted,
      });
      receipts[index] = updated;
      recordWritingRequestReceipt(stageInput.trace, updated);
    }
    const persistError =
      error instanceof Error ? error : new Error(String(error || 'persist failed'));
    Object.assign(persistError, {
      failureClass: 'fatal',
      failurePhase: 'persist',
      requestMayHaveExecuted: false,
      requestReceipts: receipts,
    });
    throw persistError;
  } finally {
    const completedAt = Date.now();
    const measuredPersistMs = stageInput.persistAdapter
      ? Math.max(0, completedAt - startedAt)
      : 0;
    for (let index = 0; index < receipts.length; index += 1) {
      const current = receipts[index];
      const durablePersistMs = current.timings.persistMs;
      const persistMs = durablePersistMs ?? measuredPersistMs;
      const persistCompletedAt =
        current.timings.persistCompletedAt ?? completedAt;
      const previousTotal = current.timings.totalMs;
      const nextTotal =
        previousTotal == null
          ? current.timings.queuedAt == null
            ? null
            : Math.max(0, completedAt - current.timings.queuedAt)
          : durablePersistMs != null
            ? previousTotal
            : previousTotal + persistMs;
      const updated = completeWritingRequestReceipt(current, {
        outcome: current.outcome,
        timings: {
          persistCompletedAt,
          persistMs,
          totalMs: nextTotal,
        },
      });
      receipts[index] = updated;
      recordWritingRequestReceipt(stageInput.trace, updated);
    }
  }
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
  const phase4 = isPhase4GatePolicy(stageInput.stagePolicy.values);
  const qaLengthAdvisory =
    phase4 && stage === 'qa' &&
    String(result?.finishReason || '').toLowerCase() === 'length';
  if (!qaLengthAdvisory) assertWriterFinishReason(stage, result);
  const artifact = parseSharedWriterOutput(stage, text);
  if (qaLengthAdvisory) {
    return {
      ...artifact,
      body: '',
      diagnostics: [
        ...(artifact.diagnostics || []),
        'qa_truncated_advisory',
      ],
    };
  }
  if (stage === 'revision') {
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
      if (phase4) {
        const sanitizedSidecar = sanitizePhase4RevisionSidecar({
          parsed: artifact.structured!,
          finalBody: artifact.body,
        });
        artifact.structured = sanitizedSidecar.parsed;
        if (sanitizedSidecar.dropped || sanitizedSidecar.rebound) {
          artifact.diagnostics = [
            ...(artifact.diagnostics || []),
            'revision_state_sidecar_advisory',
          ];
        }
      }
      const boundStateProposals = bindRevisionStateProposalFingerprint({
        parsed: artifact.structured!,
        finalBody: artifact.body,
      });
      if (boundStateProposals.rebound) {
        artifact.structured = boundStateProposals.parsed;
        artifact.diagnostics = [
          ...(artifact.diagnostics || []),
          'revision_state_proposal_fingerprint_bound_locally',
        ];
      }
      const validation = validateRevisionStructuredContract({
        parsed: artifact.structured,
        finalBody: artifact.body,
        phase4Contract: phase4,
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
  if (!artifact.body.trim() && !(phase4 && stage === 'qa')) {
    throw emptyWriterError(stage, { text, emptyReason: 'empty' });
  }
  const invalidStructuredReport =
    (stage === 'qa' ||
      stage === 'review' ||
      stage === 'audit' ||
      stage === 'factCheck' ||
      stage === 'revision') &&
    !isAdoptableStructuredReport(stage, artifact.structured);
  if (invalidStructuredReport && phase4 && stage === 'qa') {
    return {
      ...artifact,
      diagnostics: [
        ...(artifact.diagnostics || []),
        'qa_contract_advisory',
      ],
    };
  }
  if (invalidStructuredReport) {
    throw Object.assign(new Error(`${stage} 返回格式无效，需要结构化报告`), {
      code: 'SHARED_WRITER_INVALID_REPORT',
    });
  }
  assertStructuredReport(stage, artifact);
  return artifact;
}

function assertWriterFinishReason(
  stage: SharedWritingStageName,
  result?: Pick<LLMResult, 'finishReason'>,
): void {
  if (String(result?.finishReason || '').toLowerCase() !== 'length') return;
  throw Object.assign(
    new Error(`${stage} 输出以 finishReason=length 截断，拒绝持久化`),
    {
      code: 'SHARED_WRITER_TRUNCATED_OUTPUT',
      failureClass: 'response_invalid',
      failurePhase: 'generation',
      requestMayHaveExecuted: true,
    },
  );
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
    failureClass: 'response_invalid',
    failurePhase: 'parse',
    requestMayHaveExecuted: true,
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

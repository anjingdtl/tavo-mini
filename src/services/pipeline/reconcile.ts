/**
 * Single durable pipeline state machine entry.
 *
 * runChapterPipeline / resumePipeline are thin wrappers over this loop.
 * Each iteration reloads SQLite-backed state, plans via
 * determineNextPipelineAction, CAS-claims when needed, executes one action,
 * awaits persistence, then plans again.
 */
import * as db from '../database';
import { one } from '../../data/connection/query';
import {
  callLLMResult,
  resolveLLMRequestConfig,
  resolveLLMRequestConfigById,
  type LLMRequestConfig,
} from '../llm';
import {
  computeInputFingerprint,
  OutlineContextError,
} from '../outlineContextBuilder';
import {
  buildReviewContextFromSnapshot,
  buildFactCheckContextFromSnapshot,
  buildProofConstraintsFromSnapshot,
  buildFinalContinuityCapsule,
  type PipelineContextSnapshot,
} from '../../types/pipelineContext';
import type {
  FrozenPresetSnapshot,
  PipelineExecutionSnapshot,
} from '../../types/pipelineExecution';
import { resolveFinalReviserReasoning } from './finalReviserReasoningPolicy';
import {
  applyPipelineReasoningBudget,
  normalizePipelineReasoningEffort,
  normalizePipelineReasoningTier,
  resolveV3StageReasoning,
  resolveV31StageReasoning,
  resolveV32StageReasoning,
  resolveV33StageReasoning,
  structuredOutputCompatibilityForConfig,
  resolvePipelineReasoning,
  type PipelineReasoningDecision,
} from './reasoningPolicy';
import {
  buildPostDraftAuditContextFromFrozen,
  captureFrozenAuditCandidates,
} from '../postDraftRetrieval';
import { usePipelineTaskStore } from '../../store/pipelineTaskStore';
import { saveDraft } from '../draftService';
import type { PipelineFactCheckReportV2 } from '../../types/pipelineRevision';
import type { PipelineReviewReportV2 } from '../../types/pipelineRevision';
import { sha256Hex } from '../continuation/hashUtils';
import { PipelineForeground } from '../../native/PipelineForegroundModule';
import {
  getPipelineStageOrder,
  getStageProgressPercent,
} from '../../utils/stages';
import {
  allocateOutlinePipelineBudgetV3,
  cloneDefaultOutlinePipelineBudgetPolicyV3,
  resolveElasticStageOutputReservation,
  resolveOutlineElasticStageReservations,
} from '../contextAutoAllocator';
import { estimateTokens } from '../../utils/tokenEstimator';
import type { Chapter, Preset } from '../../types/novel';
import type {
  PipelineConfig,
  PipelineMode,
  PipelineReasoningEffort,
  PipelineStageName,
} from '../../types/pipeline';
import type { PipelineReasoningTier } from './reasoningPolicy';
import {
  describeAuditFailureReason,
  formatAuditFailureMessage,
  logPipelineAudit,
  validateFactCheckResult,
  validateReviewResult,
} from '../pipelineAuditValidator';
import {
  validateFactCheckV2Result,
  validateReviewV2Result,
  validateFactCheckV3Result,
  validateReviewV3Result,
} from './revisionAuditValidator';
import { compileRevisionContract } from './revisionContract';
import { validateFinalArtifact } from './finalArtifactValidator';
import {
  buildRevisionAnchors,
  buildTaggedDraft,
  canonicalizeDraft,
  computeDraftHash,
} from './revisionAnchors';
import type { LLMResult, ReasoningEffort } from '../llm/types';
import {
  parsePersistedPipelineTaskContext,
  serializePipelineTaskContext,
  type ParsedPipelineTaskContext,
} from '../pipelineTaskContext';
import { determineNextPipelineAction } from './determineNextPipelineAction';
import {
  determineRetryDisposition,
  type RetryDisposition,
} from './determineNextPipelineAction';
import { buildPersistedTaskView, resolveStageCheckpoints } from './taskView';
import {
  compileDraftFromFrozenRequest,
  compileDraftStageRequest,
  compileFactCheckStageRequest,
  compileFactCheckV2StageRequest,
  compileFinalReviserStageRequest,
  compileFinalReviserV3StageRequest,
  compileProofStageRequest,
  compileReviewStageRequest,
  compileReviewV2StageRequest,
  requireReadyStageRequest,
  type ReadyStageRequest,
} from './compileStageRequest';
import { compileBriefStageRequest } from './compileBriefStageRequest';
import {
  compileDeterministicBrief,
  computeBriefSourceHash,
} from './deterministicBriefCompiler';
import {
  validateFinalWritingBrief,
  validateFinalWritingBriefV31,
  validateFinalWritingBriefV32,
  validateFinalWritingBriefV33,
} from './briefResultValidator';
import {
  buildBriefImmutableEnvelopeV31,
  buildBriefImmutableEnvelopeV32,
  buildBriefImmutableEnvelopeV33,
} from './briefCompilerTypes';
import {
  FINAL_PROOF_RETRY_REQUIRED_ERROR_CODE,
  validateFinalBriefCompliance,
} from './finalBriefComplianceValidator';
import { shouldCallBriefCompiler } from './briefTriggerPolicy';
import type {
  BriefCompilerInputV1,
  BriefCompilerInputV31,
  FinalWritingBriefV31,
  FinalWritingBriefV32,
  FinalWritingBriefV1,
  BriefCompilerInputV32,
  BriefCompilerInputV33,
  NormalizedFactCheckV3,
  NormalizedReviewV3,
  FinalWritingBriefV33,
} from './briefCompilerTypes';
import { renderFinalWritingBrief } from './renderFinalWritingBrief';
import {
  buildFactCheckV31Messages,
  buildReviewV31Messages,
  buildFactCheckV32Messages,
  buildReviewV32Messages,
  buildFactCheckV33Messages,
  buildReviewV33Messages,
} from '../pipelineMessages';
import { adaptV31AuditResult } from './v31AuditCompatibility';
import { adaptV32AuditResult } from './v32AuditCompatibility';
import { selectStructuredCandidate } from './structuredCandidate';
import {
  buildFactCheckImmutableEnvelopeV32,
  buildFactCheckInputRefsV32,
  buildReviewImmutableEnvelopeV32,
  validateFactCheckSemanticPayloadV32,
  validateReviewSemanticPayloadV32,
  buildAuditSourceManifest,
  REVIEW_V32_DIMENSIONS,
  type FactCheckV32Category,
} from './auditSemanticEnvelope';
import {
  buildFactCheckImmutableEnvelopeV33,
  buildReviewImmutableEnvelopeV33,
  validateFactCheckSemanticPayloadV33,
  validateReviewSemanticPayloadV33,
} from './currentSemanticContract';
import { buildAuditFormatterPrompt } from './auditFormatter';
import { buildBriefContractFormatterPrompt } from './briefFormatter';
import { executeClaimedStage } from './executeClaimedStage';
import { mapOutlineErrorToPipelineError } from './errors';
import type { PipelineAction } from './types';
import {
  isCurrentOutlinePipelineContextBudgetVersion,
  isStructuredContextBudgetVersion,
  isStructuredOutlineWorkflowVersion,
  normalizePersistedContextBudgetVersion,
  shouldIncludeBriefCheckpoint,
} from './outlineWorkflowVersion';
import {
  clearTemporaryReasoningForTaskStage,
  createStageAttempt,
  getStageAttempts,
  getLatestStageAttempt,
  updateStageAttempt,
} from '../../data/repositories/pipelineStageAttemptRepository';
import { setBatchUsageFromRuns } from '../../data/repositories/multiChapterBatchRepository';
import { getContextAutomationPolicyV3 } from '../../data/repositories/contextAutoRepository';
import {
  isContextAutomationPolicyV3,
  hashContextAutomationPolicyV3,
  type ContextAutomationPolicyV3,
} from '../contextAutomationPolicy';
import {
  LLMRequestError,
  computeRetryBackoffMs,
  MAX_AUTO_RETRY_ATTEMPTS,
  type LLMFailureClass,
} from '../llm/requestPolicy';

export type StageInfo = {
  stage: PipelineStageName | 'idle';
  label: string;
  startedAt: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Stage → checkpoint stage mapping for auto-retry. */
const ACTION_TO_STAGE: Record<string, PipelineStageName | undefined> = {
  run_draft: 'draft',
  run_review: 'review',
  run_fact_check: 'factCheck',
  run_review_and_fact_check: 'review',
  run_brief: 'brief',
  run_proof: 'proof',
};

/** The provider answered, but the structured business contract was unusable. */
export const PIPELINE_RESPONSE_INVALID_ERROR_CODE = 'PIPELINE_RESPONSE_INVALID';

/** Next attempt sequence number for a task+stage (persisted count + 1). */
async function nextAttemptNo(taskId: string, stage: string): Promise<number> {
  const attempts = await getStageAttempts(taskId, stage);
  return attempts.length + 1;
}

function classifyAttemptError(
  error: any,
  attemptNo: number,
): {
  status:
    | 'safe_to_retry'
    | 'outcome_unknown'
    | 'blocked'
    | 'failed'
    | 'cancelled';
  failureClass: LLMFailureClass | null;
  errorCode: string | null;
  errorMessage: string | null;
  httpStatus: number | null;
  retryAfterMs: number | null;
  providerRequestId: string | null;
  nextRetryAt: number | null;
} {
  if (error?.code === 'cancelled' || error?.name === 'AbortError') {
    return {
      status: 'cancelled',
      failureClass: 'fatal',
      errorCode: 'cancelled',
      errorMessage: '已取消',
      httpStatus: null,
      retryAfterMs: null,
      providerRequestId: null,
      nextRetryAt: null,
    };
  }
  if (error instanceof LLMRequestError) {
    const failureClass = error.failureClass || 'fatal';
    const backoffMs = Math.max(
      error.retryAfterMs ?? 0,
      computeRetryBackoffMs(attemptNo),
    );
    let status: 'safe_to_retry' | 'outcome_unknown' | 'blocked' | 'failed';
    let nextRetryAt: number | null;
    if (failureClass === 'safe_retry' || failureClass === 'rate_limit') {
      status = 'safe_to_retry';
      nextRetryAt = Date.now() + backoffMs;
    } else if (failureClass === 'outcome_unknown') {
      // Request may have executed — never auto-retry silently.
      status = 'outcome_unknown';
      nextRetryAt = null;
    } else if (failureClass === 'context_error') {
      status = 'blocked';
      nextRetryAt = null;
    } else {
      status = 'failed';
      nextRetryAt = null;
    }
    return {
      status,
      failureClass,
      errorCode: String(error.code || ''),
      errorMessage: error.message || '',
      httpStatus: error.httpStatus ?? null,
      retryAfterMs: error.retryAfterMs ?? null,
      providerRequestId: error.providerRequestId ?? null,
      nextRetryAt,
    };
  }
  return {
    status: 'failed',
    failureClass: 'fatal',
    errorCode: null,
    errorMessage: error?.message ? String(error.message) : '阶段失败',
    httpStatus: null,
    retryAfterMs: null,
    providerRequestId: null,
    nextRetryAt: null,
  };
}

/**
 * Wrap ONE LLM call in a persisted pipeline_stage_attempts row.
 * On success returns the LLM result (caller keeps existing control flow); on
 * failure the attempt is classified + scheduled, then the original error is
 * RE-THROWN so the existing checkpoint/status flow is unchanged.
 * Fail-closed: attempt write errors propagate (no silent no-op).
 *
 * BN-04: when a `batchId` is provided, the batch's hard budget caps are
 * checked BEFORE any HTTP attempt row is created. The caller will see a
 * typed BatchBudgetExceededError; no attempt is recorded (so no bill is
 * accrued) and the batch reconciler will pause the item as
 * `paused_batch_budget` for user action.
 */
async function runStageAttempt<
  T extends {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reasoningTokens?: number | null;
    text?: string | null;
    reasoningText?: string | null;
    visibleOutputTokens?: number | null;
    finishReason?: string | null;
    emptyReason?: string;
    // Schema 51: optional provider cache telemetry (DeepSeek prompt cache).
    promptCacheHitTokens?: number | null;
    promptCacheMissTokens?: number | null;
  },
>(params: {
  taskId: string;
  stage: string;
  /** Request protocol version recorded on the attempt (V2 audits = 2). */
  requestVersion?: number;
  requestFingerprint: string;
  allocationTraceJson?: string | null;
  frozenRequestJson?: string | null;
  llmConfigId?: number | null;
  llmConfigSnapshotJson: string;
  /** BN-04/CL-06: when set, enforce the batch's hard caps before issuing the request. */
  batchBudgetGate?: { batchId: string };
  /** CL-06: worst-case input/output for the upcoming request (compiled). */
  estimatedInputTokens?: number;
  reservedOutputTokens?: number;
  /** True for the one-shot lightweight Audit Formatter call. */
  formatterUsed?: boolean;
  /** V3.1 only: retain reasoning for same-checkpoint cold-start recovery. */
  persistReasoningContentTemp?: boolean;
  /** V3.2/general structured candidate scratch for cold-start recovery. */
  persistResponseCandidateTemp?: boolean;
  run: () => Promise<T>;
}): Promise<T> {
  if (params.batchBudgetGate) {
    await assertBatchBudgetAvailable({
      batchId: params.batchBudgetGate.batchId,
      stage: params.stage,
      estimatedInputTokens: params.estimatedInputTokens,
      reservedOutputTokens: params.reservedOutputTokens,
    });
  }
  const attemptNo = await nextAttemptNo(params.taskId, params.stage);
  const attemptId = `${params.taskId}:${params.stage}:${attemptNo}`;
  const now = Date.now();
  await createStageAttempt({
    id: attemptId,
    pipelineTaskId: params.taskId,
    stage: params.stage,
    attemptNo,
    requestVersion: params.requestVersion ?? 1,
    requestFingerprint: params.requestFingerprint,
    allocationTraceJson: params.allocationTraceJson ?? null,
    frozenRequestJson: params.frozenRequestJson ?? null,
    llmConfigId: params.llmConfigId ?? null,
    llmConfigSnapshotJson: params.llmConfigSnapshotJson,
    clientRequestId: attemptId,
    startedAt: now,
    formatterUsed: params.formatterUsed ?? false,
  });
  try {
    const result = await params.run();
    const isV33Request = params.requestVersion === 33;
    const isV32Request = params.requestVersion === 32;
    const isV31Request = params.requestVersion === 31;
    const expectedRootKeys = isV33Request
      ? params.stage === 'review' || params.stage === 'factCheck'
        ? ['verdict', 'checked', 'findings']
        : params.stage === 'brief'
        ? ['strategy', 'actions', 'preserve', 'ending']
        : []
      : isV32Request
      ? params.stage === 'review'
        ? ['verdict', 'findings', 'outlineAssessment', 'coverage']
        : params.stage === 'factCheck'
        ? ['verdict', 'findings', 'confirmedFactRefs', 'coverage']
        : params.stage === 'brief'
        ? ['verdict', 'instructions', 'openingContinuity', 'styleAdvisories']
        : []
      : isV31Request
      ? params.stage === 'review'
        ? ['schemaVersion', 'draftHash', 'corrections', 'outlineExecution']
        : params.stage === 'factCheck'
        ? ['schemaVersion', 'draftHash', 'corrections', 'hardConstraints']
        : params.stage === 'brief'
        ? ['schemaVersion', 'coveredRequiredIds', 'mustFix', 'endingState']
        : []
      : [];
    const coverageKeys = isV33Request
      ? ['checked']
      : isV32Request
      ? params.stage === 'review'
        ? [
            'opening_continuity',
            'outline_execution',
            'character',
            'prose',
            'ending_boundary',
          ]
        : params.stage === 'factCheck'
        ? [
            'timeline',
            'character_state',
            'object_state',
            'world_rule',
            'spatial_logic',
            'knowledge_boundary',
            'outline_boundary',
          ]
        : []
      : [];
    const candidateSelection = params.persistResponseCandidateTemp
      ? selectStructuredCandidate({
          content: result.text ?? null,
          reasoning: result.reasoningText ?? null,
          expectedRootKeys,
          coverageKeys,
          findingKeys:
            params.stage === 'brief'
              ? ['actions', 'instructions', 'mustFix']
              : [
                  'findings',
                  'corrections',
                  'requiredCorrections',
                  'issues',
                  'errors',
                ],
        })
      : null;
    const scratchCandidate = candidateSelection?.candidate;
    const scratchText =
      scratchCandidate?.text ||
      result.text?.trim() ||
      result.reasoningText?.trim() ||
      '';
    const scratchChannel =
      candidateSelection && candidateSelection.responseChannel !== 'empty'
        ? candidateSelection.responseChannel
        : result.text?.trim()
        ? result.reasoningText?.trim()
          ? 'both_content_preferred'
          : 'content'
        : result.reasoningText?.trim()
        ? 'reasoning'
        : null;
    await updateStageAttempt({
      id: attemptId,
      status: 'succeeded',
      completedAt: Date.now(),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.totalTokens,
      reasoningTokens: result.reasoningTokens ?? null,
      // Schema 51: persist provider-reported cache telemetry on the success
      // path. null when unreported; never influences status/retry/budget.
      promptCacheHitTokens: result.promptCacheHitTokens ?? null,
      promptCacheMissTokens: result.promptCacheMissTokens ?? null,
      finishReason: result.finishReason ?? null,
      emptyReason:
        result.emptyReason ??
        (result.text?.trim()
          ? null
          : result.reasoningText?.trim()
          ? 'reasoning_only'
          : 'empty'),
      responseChannel: result.text?.trim()
        ? result.reasoningText?.trim()
          ? 'both'
          : 'content'
        : result.reasoningText?.trim()
        ? 'reasoning'
        : 'empty',
      visibleOutputTokens:
        result.visibleOutputTokens ??
        Math.max(
          0,
          Number(result.outputTokens || 0) -
            Number(result.reasoningTokens || 0),
        ),
      formatterUsed: params.formatterUsed ?? false,
      // Keep reasoning only long enough for same-checkpoint cold-start
      // recovery. Callers clear it once validation settles the checkpoint.
      reasoningContentTemp: params.persistReasoningContentTemp
        ? result.reasoningText?.trim() || null
        : null,
      responseCandidateTemp: params.persistResponseCandidateTemp
        ? scratchText.slice(0, 12000) || null
        : null,
      responseCandidateChannel: params.persistResponseCandidateTemp
        ? scratchChannel
        : null,
    });
    // CL-06: usage must reflect this attempt immediately (not at adoption).
    await refreshBatchUsage(params.batchBudgetGate);
    return result;
  } catch (error: any) {
    const classified = classifyAttemptError(error, attemptNo);
    try {
      await updateStageAttempt({
        id: attemptId,
        status: classified.status,
        failureClass: classified.failureClass,
        errorCode: classified.errorCode,
        errorMessage: classified.errorMessage,
        httpStatus: classified.httpStatus,
        retryAfterMs: classified.retryAfterMs,
        providerRequestId: classified.providerRequestId,
        nextRetryAt: classified.nextRetryAt,
        completedAt: Date.now(),
      });
    } catch {
      // attempt persistence failure must not mask the original error
    }
    // CL-06: a failed / retryable / unknown attempt still consumed budget —
    // reflect it immediately (the next gate re-checks used + upcoming).
    await refreshBatchUsage(params.batchBudgetGate);
    throw error;
  }
}

/** Stable fingerprint for a non-draft stage request (messages + window). */
function stageFingerprint(
  stage: string,
  compiled: ReadyStageRequest,
  semantics?: {
    thinking?: 'enabled' | 'disabled';
    reasoningEffort?: string;
    reasoningPolicyVersion?: number;
  },
): string {
  try {
    return sha256Hex(
      JSON.stringify({
        stage,
        messages: compiled.messages,
        maxTokens: compiled.reservedOutputTokens,
        contextWindow: compiled.contextWindow,
        thinking: semantics?.thinking,
        reasoningEffort: semantics?.reasoningEffort,
        reasoningPolicyVersion: semantics?.reasoningPolicyVersion,
      }),
    ).slice(0, 32);
  } catch {
    return `${stage}:${compiled.estimatedInputTokens}`;
  }
}

/** LLM config snapshot without secrets (never api_key). */
function llmConfigSnapshotJson(requestConfig: any): string {
  return JSON.stringify({
    name: requestConfig?.name,
    modelName: requestConfig?.model_name,
    contextWindow: requestConfig?.context_window,
    maxOutputTokens: requestConfig?.max_output_tokens,
    provider: requestConfig?.provider_type,
  });
}

function llmConfigIdOf(requestConfig: any): number | null {
  const id = Number(requestConfig?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Auto-retry gate: when the next action targets a stage whose latest attempt
 * is safe_to_retry and its persisted next_retry_at has arrived, reset the
 * stage checkpoint to pending so the loop re-runs it with the SAME frozen
 * request (never recompiled). Returns 'continue' (retry scheduled/executed)
 * or 'stop' (still waiting — hand back to UI/batch resume).
 */
async function maybeAutoRetryStage(params: {
  taskId: string;
  stages: ReturnType<typeof resolveStageCheckpoints>;
  action: PipelineAction;
  options: ReconcileOptions;
}): Promise<'continue' | 'stop'> {
  const stage = ACTION_TO_STAGE[params.action.type];
  if (!stage) return 'continue';
  const checkpoint = params.stages.find(s => s.stage === stage);
  if (!checkpoint || checkpoint.status !== 'failed') return 'continue';
  const attempts = await getStageAttempts(params.taskId, stage);
  const latest = attempts[attempts.length - 1];
  if (!latest) return 'continue';
  if (latest.status !== 'safe_to_retry') return 'continue';
  if (latest.attemptNo > MAX_AUTO_RETRY_ATTEMPTS) return 'continue';
  const now = Date.now();
  const nextRetryAt = latest.nextRetryAt ?? now;
  if (nextRetryAt > now) {
    // Persisted schedule already durable; wait briefly then hand back if
    // still not due (batch/cold-start resume re-checks next_retry_at).
    const waitMs = Math.min(nextRetryAt - now, 15_000);
    await sleep(waitMs);
    if (params.options.abortSignal?.aborted) return 'stop';
    if (Date.now() < nextRetryAt) return 'stop';
  }
  // Reset checkpoint to pending so determineNextPipelineAction re-runs the
  // stage. Same frozen request: attempts are keyed per stage, and the stage
  // run path always reads the frozen request (never live data).
  await db.upsertStageCheckpoint({
    taskId: params.taskId,
    stage: stage as any,
    status: 'pending',
    errorCode: null,
    errorMessage: null,
    bumpAttempt: true,
  });
  return 'continue';
}

export interface ReconcileOptions {
  onStageUpdate?: (info: StageInfo | string) => void;
  abortSignal?: AbortSignal;
  isCancelled?: (taskId: string) => boolean;
  registerCancel?: (taskId: string) => void;
  /**
   * Batch-owned tasks execute with the mode chosen on the batch form; only
   * applied when no frozen execution snapshot exists yet (first run).
   */
  pipelineModeOverride?: PipelineMode;
  /** Batch-owned V2 tasks inherit the batch-frozen product tier on first run. */
  pipelineReasoningEffortOverride?:
    | PipelineReasoningEffort
    | PipelineReasoningTier
    | null;
  /** Batch-frozen V3 policy. A supplied snapshot disables live-policy reads. */
  contextAutomationPolicyV3?: ContextAutomationPolicyV3 | null;
  /**
   * BN-04: when set, every stage attempt is preceded by a hard batch-budget
   * check. Exceeding the cap throws BatchBudgetExceededError BEFORE any
   * HTTP request is issued and the batch reconciler pauses the item.
   */
  batchBudgetGate?: { batchId: string };
  /**
   * CL-10: call-level foreground ownership. 'batch' suppresses per-task
   * PipelineForeground notifications (the batch owns the aggregate).
   * Defaults to 'task'.
   */
  foregroundOwner?: 'task' | 'batch';
}

/**
 * Pipeline protocol versions are FROZEN per task (task row columns + the
 * execution snapshot) — no module-level mutable flags, no live settings
 * reads. Concurrent tasks each read their own frozen versions; a global
 * boolean would let task A/B overwrite each other's strategy mid-process.
 */
const reconciling = new Set<string>();

function getErrorMessage(error: any, fallback: string): string {
  return error?.message ? String(error.message) : fallback;
}

function freezePreset(preset: Preset | null): FrozenPresetSnapshot | null {
  if (!preset) return null;
  return {
    id: preset.id ?? null,
    name: (preset as any).name,
    system_prompt: preset.system_prompt || '',
    writing_style: preset.writing_style || '',
    extra_instructions: preset.extra_instructions || '',
    temperature: Number(preset.temperature ?? 0.7),
    top_p: Number(preset.top_p ?? 0.9),
    max_tokens: Number(preset.max_tokens ?? 0),
  };
}

function presetFromFrozen(frozen: FrozenPresetSnapshot | null): Preset | null {
  if (!frozen) return null;
  return {
    id: frozen.id ?? 0,
    project_id: 0,
    name: frozen.name || '',
    is_default: 0,
    system_prompt: frozen.system_prompt,
    writing_style: frozen.writing_style,
    extra_instructions: frozen.extra_instructions,
    temperature: frozen.temperature,
    top_p: frozen.top_p,
    max_tokens: frozen.max_tokens,
  };
}

function resolvePreset(
  presetId: number | null,
  presets: Preset[],
): Preset | null {
  if (presetId != null) {
    const found = presets.find(p => p.id === presetId);
    if (found) return found;
  }
  return presets[0] || null;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildExecutionSnapshot(params: {
  config: PipelineConfig;
  draftPreset: Preset | null;
  reviewPreset: Preset | null;
  factCheckPreset: Preset | null;
  proofPreset: Preset | null;
  requestConfig: LLMRequestConfig;
  outlineWorkflowVersion?: 1 | 2 | 3 | 4;
  contextBudgetVersion?: 1 | 2 | 3 | 4 | 5 | 6;
  contextAutomationPolicyV3?: ContextAutomationPolicyV3;
  reasoningProfileVersion?: 1 | 2 | 3 | 4 | 5;
  finalReviserReasoningPolicyVersion?: 1 | 2 | 3;
  reasoningEffort?: PipelineConfig['reasoningEffort'];
}): PipelineExecutionSnapshot {
  const contextWindow = Number(params.requestConfig.context_window) || 0;
  if (!(contextWindow > 0)) {
    throw new OutlineContextError(
      'OUTLINE_MODEL_UNAVAILABLE',
      '当前模型未配置有效上下文窗口，无法冻结流水线执行配置。',
      'open_llm_settings',
    );
  }
  const llmConfigId = Number(params.requestConfig.id);
  if (!Number.isInteger(llmConfigId) || llmConfigId <= 0) {
    throw new OutlineContextError(
      'OUTLINE_MODEL_UNAVAILABLE',
      '当前没有可用的模型配置，无法启动流水线。',
      'open_llm_settings',
    );
  }
  // Structured-pipeline predicates are owned by outlineWorkflowVersion
  // (Closure Plan §5). Version 6 (V3 hierarchical) is structured exactly like
  // 5 (same stages / reasoning profile / Brief); only the contextBuilder
  // budget path differs (>= 6 → hierarchical allocator).
  const isStructuredWorkflow = isStructuredOutlineWorkflowVersion(
    params.outlineWorkflowVersion,
  );
  const isV3 =
    isStructuredWorkflow &&
    Number(params.outlineWorkflowVersion) === 3 &&
    (Number(params.contextBudgetVersion) === 3 ||
      Number(params.contextBudgetVersion) === 4);
  const isV4 =
    isStructuredWorkflow &&
    Number(params.outlineWorkflowVersion) === 4 &&
    isStructuredContextBudgetVersion(params.contextBudgetVersion);
  const isCurrentElasticBudget =
    Number(params.outlineWorkflowVersion) === 4 &&
    isCurrentOutlinePipelineContextBudgetVersion(params.contextBudgetVersion);
  const isStructured = isV3 || isV4;
  const reasoningProfileVersion = isV4
    ? 5
    : isV3
    ? params.contextBudgetVersion === 4 || params.reasoningProfileVersion === 4
      ? 4
      : params.reasoningProfileVersion === 2
      ? 2
      : 3
    : undefined;
  const requestedTier = isStructured
    ? normalizePipelineReasoningTier(
        params.reasoningEffort ?? params.config.reasoningEffort,
      )
    : undefined;
  const stageReasoning =
    isStructured && requestedTier
      ? (Object.fromEntries(
          (['draft', 'review', 'factCheck', 'brief', 'proof'] as const).map(
            stage => {
              const resolved =
                reasoningProfileVersion === 2
                  ? resolveV3StageReasoning(
                      requestedTier,
                      stage,
                      params.requestConfig,
                    )
                : reasoningProfileVersion === 3
                  ? resolveV31StageReasoning(
                      requestedTier,
                      stage,
                      params.requestConfig,
                    )
                  : reasoningProfileVersion === 4
                  ? resolveV32StageReasoning(
                      requestedTier,
                      stage,
                      params.requestConfig,
                    )
                  : resolveV33StageReasoning(
                      requestedTier,
                      stage,
                      params.requestConfig,
                    );
              return [
                stage,
                {
                  stage,
                  requestedTier: resolved.requestedTier,
                  effectiveTier: resolved.effectiveTier,
                  thinking: resolved.thinking.type,
                  effort: resolved.effort,
                  supported: resolved.supported,
                  downgradeReason: resolved.downgradeReason,
                },
              ];
            },
          ),
        ) as PipelineExecutionSnapshot['stageReasoning'])
      : undefined;
  const briefVisibleOutputFloor = isStructured
    ? clampNumber(
        Number(params.config.briefVisibleOutputFloor) || 1200,
        768,
        2048,
      )
    : undefined;
  const briefReasoningHeadroom = isStructured
    ? clampNumber(
        Number(params.config.briefReasoningHeadroom) || 1200,
        1024,
        2048,
      )
    : undefined;
  const briefMaxTokens = isStructured
    ? resolveElasticStageOutputReservation({
        contextWindow,
        modelMaxOutputTokens: params.requestConfig.max_output_tokens,
      })
    : undefined;
  const stageBudgets =
    isStructured && requestedTier
      ? (() => {
          const budgetPolicy = cloneDefaultOutlinePipelineBudgetPolicyV3();
          const briefHeadroom = briefReasoningHeadroom || 1200;
          budgetPolicy.stages.brief.reasoningHeadroom = {
            low: briefHeadroom,
            high: briefHeadroom,
            max: briefHeadroom,
          };
          const allocation = allocateOutlinePipelineBudgetV3({
            contextWindow,
            requestedTier,
            modelMaxOutputTokens: params.requestConfig.max_output_tokens,
            requestMaxTokenOverrides: isCurrentElasticBudget
              ? resolveOutlineElasticStageReservations({
                  contextWindow,
                  modelMaxOutputTokens: params.requestConfig.max_output_tokens,
                })
              : { brief: briefMaxTokens },
            visibleOutputFloors: isCurrentElasticBudget
              ? { brief: briefVisibleOutputFloor || 1200 }
              : {
                  draft: Math.max(1, params.config.draftMaxTokens),
                  review: Math.max(1, params.config.reviewMaxTokens),
                  factCheck: Math.max(1, params.config.factCheckMaxTokens),
                  brief: briefVisibleOutputFloor || 1200,
                  proof: Math.max(
                    1024,
                    Math.ceil(params.config.draftMaxTokens * 1.2) + 256,
                  ),
                },
            policy: budgetPolicy,
          });
          return (
            ['draft', 'review', 'factCheck', 'brief', 'proof'] as const
          ).map(stage => {
            const item = allocation.stages[stage];
            return {
              stage,
              visibleOutputFloor: item.visibleOutputFloor,
              reasoningHeadroom: item.reasoningHeadroom,
              requestMaxTokens: item.requestMaxTokens,
              estimatedMandatoryInput: item.estimatedMandatoryInputTokens,
              optionalInputBudget: item.optionalInputBudget,
              safetyMargin: item.safetyReserveTokens,
              softInputLimit: item.softInputLimit,
              hardInputLimit: item.hardInputLimit,
              fitsSoftInput: item.fitsSoftInput,
              fitsModelOutput: item.fitsModelOutput,
              localFallbackRecommended: item.localFallbackRecommended,
            };
          });
        })()
      : undefined;
  const frozenStageMax = (stage: PipelineStageName, fallback: number): number =>
    stageBudgets?.find(item => item.stage === stage)?.requestMaxTokens ||
    fallback;
  return {
    pipelineMode: isV4 ? 'full' : params.config.pipelineMode,
    ...(params.outlineWorkflowVersion
      ? { outlineWorkflowVersion: params.outlineWorkflowVersion }
      : {}),
    ...(params.contextBudgetVersion
      ? { contextBudgetVersion: params.contextBudgetVersion }
      : {}),
    ...(Number(params.contextBudgetVersion) === 6 &&
    params.contextAutomationPolicyV3 &&
    isContextAutomationPolicyV3(params.contextAutomationPolicyV3)
      ? {
          contextAutomationPolicyVersion: 'context-automation-v3' as const,
          contextAutomationPolicyHash: hashContextAutomationPolicyV3(
            params.contextAutomationPolicyV3,
          ),
          contextAutomationPolicySnapshot: JSON.parse(
            JSON.stringify(params.contextAutomationPolicyV3),
          ) as ContextAutomationPolicyV3,
        }
      : {}),
    ...(params.finalReviserReasoningPolicyVersion
      ? {
          finalReviserReasoningPolicyVersion:
            params.finalReviserReasoningPolicyVersion,
        }
      : {}),
    ...(params.reasoningEffort
      ? { reasoningEffort: params.reasoningEffort }
      : {}),
    ...(isStructured
      ? {
          reasoningProfileVersion: reasoningProfileVersion as 2 | 3 | 4 | 5,
          requestedReasoningTier: requestedTier,
          stageReasoning,
          briefPolicyVersion: (reasoningProfileVersion === 2
            ? 1
            : reasoningProfileVersion === 3
            ? 2
            : reasoningProfileVersion === 4
            ? 3
            : 4) as 1 | 2 | 3 | 4,
          briefVisibleOutputFloor,
          briefReasoningHeadroom,
          briefMaxTokens,
          stageBudgets,
        }
      : {}),
    draftMaxTokens: frozenStageMax('draft', params.config.draftMaxTokens),
    reviewMaxTokens: frozenStageMax('review', params.config.reviewMaxTokens),
    factCheckMaxTokens: frozenStageMax(
      'factCheck',
      params.config.factCheckMaxTokens,
    ),
    proofMaxTokens: frozenStageMax('proof', params.config.proofMaxTokens),
    draftPresetId: params.config.draftPresetId,
    reviewPresetId: params.config.reviewPresetId,
    factCheckPresetId: params.config.factCheckPresetId,
    proofPresetId: params.config.proofPresetId,
    draftPreset: freezePreset(params.draftPreset),
    reviewPreset: freezePreset(params.reviewPreset),
    factCheckPreset: freezePreset(params.factCheckPreset),
    proofPreset: freezePreset(params.proofPreset),
    model: {
      llmConfigId,
      name: params.requestConfig.name,
      provider: params.requestConfig.provider_type,
      modelName: params.requestConfig.model_name,
      contextWindow,
      maxOutputTokens: params.requestConfig.max_output_tokens,
    },
    createdAt: Date.now(),
  };
}

function configFromExecution(
  execution: PipelineExecutionSnapshot,
): PipelineConfig {
  return {
    pipelineMode: execution.pipelineMode,
    reasoningEffort: execution.reasoningEffort,
    reasoningProfileVersion: execution.reasoningProfileVersion,
    draftPresetId: execution.draftPresetId,
    reviewPresetId: execution.reviewPresetId,
    factCheckPresetId: execution.factCheckPresetId,
    proofPresetId: execution.proofPresetId,
    draftMaxTokens: execution.draftMaxTokens,
    reviewMaxTokens: execution.reviewMaxTokens,
    factCheckMaxTokens: execution.factCheckMaxTokens,
    proofMaxTokens: execution.proofMaxTokens,
    briefVisibleOutputFloor: execution.briefVisibleOutputFloor,
    briefReasoningHeadroom: execution.briefReasoningHeadroom,
  };
}

function requestConfigFromExecution(
  execution: PipelineExecutionSnapshot,
  live: LLMRequestConfig,
): LLMRequestConfig {
  // Identity check: config id + model name must match frozen snapshot.
  if (Number(live.id) !== Number(execution.model.llmConfigId)) {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      `模型配置 id 已变化（冻结 ${execution.model.llmConfigId}，当前 ${live.id}）。请重新开始生成。`,
      'open_llm_settings',
    );
  }
  if (
    execution.model.modelName &&
    live.model_name &&
    String(live.model_name) !== String(execution.model.modelName)
  ) {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      `模型名已变化（冻结 ${execution.model.modelName}，当前 ${live.model_name}）。请重新开始生成。`,
      'open_llm_settings',
    );
  }
  return {
    ...live,
    id: execution.model.llmConfigId,
    name: execution.model.name || live.name,
    provider_type:
      (execution.model.provider as LLMRequestConfig['provider_type']) ||
      live.provider_type,
    model_name: execution.model.modelName || live.model_name,
    context_window: execution.model.contextWindow,
    max_output_tokens:
      execution.model.maxOutputTokens ?? live.max_output_tokens,
  };
}

function buildCallConfig(
  preset: Preset | null,
  maxTokens: number,
  scenario: string,
  projectId: number,
  requestConfig: LLMRequestConfig,
  taskId: string,
  extras?: {
    responseFormat?: 'json_object';
    /** OpenAI-compatible extension; lets reasoning-capable gateways skip CoT. */
    thinking?: { type: 'enabled' | 'disabled' };
    /** Provider reasoning intensity when the provider accepts the extension. */
    reasoningEffort?: ReasoningEffort;
  },
) {
  return {
    temperature: preset?.temperature,
    top_p: preset?.top_p,
    max_tokens: maxTokens,
    scenario,
    projectId,
    taskId,
    responseFormat: extras?.responseFormat,
    thinking: extras?.thinking,
    reasoningEffort: extras?.reasoningEffort,
    requestConfig,
  };
}

/**
 * Defensive budget increase for a retry that the provider explicitly ended
 * with `finishReason=length`. A `reasoning_only` classification alone does
 * not prove budget exhaustion; callers must inspect the finish reason before
 * using this helper.
 */
function bumpRetryBudget(stageMax: number, modelMax?: number): number {
  const safeStage = Number.isFinite(stageMax) && stageMax > 0 ? stageMax : 0;
  const doubled = Math.max(safeStage, Math.floor(safeStage * 2));
  if (!modelMax || modelMax <= 0) return doubled;
  return Math.min(doubled, Math.floor(modelMax));
}

/**
 * Reasoning-only specific repair instruction (more directive than the generic
 * describeAuditFailureReason label). Tells the model to skip CoT entirely.
 */
const REASONING_ONLY_REPAIR_HINT =
  '上一轮只输出了 reasoning_content，message.content 为空，未给出 JSON 报告。请把最终 JSON 报告写入 content 本体，不要只结束在 reasoning_content；不要输出任何推理、分析或思考过程。';

/**
 * V2 audit reports are machine-readable contracts, not creative prose.
 * Reasoning-capable gateways must skip chain-of-thought for every audit
 * attempt, including the first request and non-reasoning format repairs. A
 * low, fixed sampling temperature also prevents a preset intended for prose
 * generation from destabilising the contract shape.
 */
function buildStructuredAuditCallConfig(
  preset: Preset | null,
  maxTokens: number,
  scenario: string,
  projectId: number,
  requestConfig: LLMRequestConfig,
  taskId: string,
  reasoning?: PipelineReasoningDecision,
) {
  const v2Reasoning = reasoning?.thinking
    ? {
        thinking: reasoning.thinking,
        reasoningEffort: reasoning.effort,
      }
    : {
        thinking: { type: 'disabled' as const },
      };
  return {
    ...buildCallConfig(
      preset,
      maxTokens,
      scenario,
      projectId,
      requestConfig,
      taskId,
      {
        responseFormat: 'json_object',
        ...v2Reasoning,
      },
    ),
    temperature: 0.2,
    top_p: 1,
  };
}

function buildV2RepairReason(
  reason: Parameters<typeof describeAuditFailureReason>[0],
  details: string | undefined,
): string {
  const label = describeAuditFailureReason(reason);
  const detail =
    typeof details === 'string' ? details.trim().slice(0, 240) : '';
  return detail ? `${label}；校验提示：${detail}` : label;
}

function tokenBreakdown(result: LLMResult) {
  const reasoning = Math.max(
    0,
    Number(
      result.reasoningTokens ??
        result.rawUsage?.completion_tokens_details?.reasoning_tokens ??
        0,
    ),
  );
  const visible = Math.max(
    0,
    Number(
      result.visibleOutputTokens ??
        Math.max(0, result.outputTokens - reasoning),
    ),
  );
  return {
    input: result.inputTokens || 0,
    output: result.outputTokens || 0,
    total: result.totalTokens || 0,
    reasoning,
    visible,
  };
}

/** Safe, body-free diagnostics for distinguishing empty JSON from truncation. */
function auditObservation(result: LLMResult) {
  const usage = tokenBreakdown(result);
  const reasoningOnly =
    result.emptyReason === 'reasoning_only' ||
    (!result.text && Boolean(result.reasoningText));
  return {
    reasoningLength: result.reasoningText?.length || 0,
    finishReason: result.finishReason,
    outputTokens: result.outputTokens,
    reasoningTokens: result.reasoningTokens,
    visibleOutputTokens: result.visibleOutputTokens ?? usage.visible,
    emptyReason: result.emptyReason,
    reasoningBudgetExhausted: reasoningOnly && result.finishReason === 'length',
  };
}

/** Persist only bounded, body-free structured-stage diagnostics. */
function validationDetailsJson(params: {
  validation: any;
  selection?: ReturnType<typeof selectStructuredCandidate> | null;
  formatterEligible: boolean;
  formatterDecision: string;
}): string {
  const details =
    params.validation?.details && typeof params.validation.details === 'object'
      ? params.validation.details
      : {};
  const validationError =
    typeof params.validation?.details === 'string'
      ? params.validation.details.slice(0, 600)
      : undefined;
  const candidate = params.selection?.candidate;
  return JSON.stringify({
    version: 1,
    failureCode:
      params.validation?.reason ||
      params.validation?.error ||
      (params.validation?.valid ? 'ok' : 'AUDIT_INVALID'),
    missingPaths: Array.isArray(details.missingPaths)
      ? details.missingPaths.slice(0, 32)
      : [],
    invalidPaths: Array.isArray(details.invalidPaths)
      ? details.invalidPaths.slice(0, 32)
      : [],
    rootKeys: candidate?.rootKeys?.slice(0, 32) || [],
    candidateChannel:
      params.selection?.responseChannel &&
      params.selection.responseChannel !== 'empty'
        ? params.selection.responseChannel
        : undefined,
    candidateChars: candidate?.candidateChars || 0,
    candidateHash: candidate?.candidateHash,
    findingCount:
      typeof details.findingCount === 'number'
        ? details.findingCount
        : undefined,
    requiredFindingCount:
      typeof details.requiredFindingCount === 'number'
        ? details.requiredFindingCount
        : undefined,
    coverageDimensions: Array.isArray(details.coverageDimensions)
      ? details.coverageDimensions.slice(0, 32)
      : [],
    formatterEligible: params.formatterEligible,
    formatterDecision: params.formatterDecision,
    ...(validationError ? { validationError } : {}),
    rejectedChannels: params.selection?.rejected?.slice(0, 8) || [],
  }).slice(0, 4000);
}

function validationFieldHint(validation: any): string {
  const details =
    validation?.details && typeof validation.details === 'object'
      ? validation.details
      : {};
  const paths = [
    ...(Array.isArray(details.missingPaths) ? details.missingPaths : []),
    ...(Array.isArray(details.invalidPaths) ? details.invalidPaths : []),
  ]
    .map(item => String(item).trim())
    .filter(Boolean)
    .slice(0, 6);
  return paths.length ? '；字段诊断：' + paths.join('、') : '';
}

async function updateLatestAttemptDiagnostics(
  taskId: string,
  stage: string,
  fields: {
    parseFailureCode?: string | null;
    failureClass?: LLMFailureClass | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    formatterUsed?: boolean;
    clearReasoning?: boolean;
    clearCandidate?: boolean;
    responseCandidateChannel?:
      | 'content'
      | 'reasoning'
      | 'both_content_preferred'
      | 'both_reasoning_preferred'
      | null;
    validationDetailsJson?: string | null;
  },
): Promise<void> {
  const latest = await getLatestStageAttempt(taskId, stage);
  if (!latest) return;
  await updateStageAttempt({
    id: latest.id,
    status: latest.status,
    ...(fields.parseFailureCode !== undefined
      ? { parseFailureCode: fields.parseFailureCode }
      : {}),
    ...(fields.failureClass !== undefined
      ? { failureClass: fields.failureClass }
      : {}),
    ...(fields.errorCode !== undefined ? { errorCode: fields.errorCode } : {}),
    ...(fields.errorMessage !== undefined
      ? { errorMessage: fields.errorMessage }
      : {}),
    ...(fields.formatterUsed !== undefined
      ? { formatterUsed: fields.formatterUsed }
      : {}),
    ...(fields.responseCandidateChannel !== undefined
      ? { responseCandidateChannel: fields.responseCandidateChannel }
      : {}),
    ...(fields.validationDetailsJson !== undefined
      ? { validationDetailsJson: fields.validationDetailsJson }
      : {}),
    ...(fields.clearReasoning || fields.clearCandidate
      ? {
          reasoningContentTemp: fields.clearReasoning ? null : undefined,
          responseCandidateTemp:
            fields.clearCandidate || fields.clearReasoning ? null : undefined,
        }
      : {}),
  });
  if (fields.clearReasoning || fields.clearCandidate) {
    await clearTemporaryReasoningForTaskStage(taskId, stage);
  }
}

function accumulateTokens(
  acc: {
    input: number;
    output: number;
    total: number;
    reasoning?: number;
    visible?: number;
  },
  result: LLMResult,
) {
  const current = tokenBreakdown(result);
  return {
    input: acc.input + current.input,
    output: acc.output + current.output,
    total: acc.total + current.total,
    reasoning: (acc.reasoning || 0) + current.reasoning,
    visible: (acc.visible || 0) + current.visible,
  };
}

function isAbortError(error: any, abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted || error?.code === 'cancelled');
}

/** BN-11/CL-10: foreground ownership is CALL-LEVEL state (options), never a
 *  module global — two concurrent tasks (single-chapter A + batch B) must not
 *  pollute each other's notification ownership. Batch-owned tasks suppress
 *  per-task PipelineForeground calls; the batch owns the single aggregated
 *  notification. Single-chapter mode defaults to 'task'. */

/**
 * BN-04 / CL-06: hard batch budget gate. Read the batch's durable caps and
 * CURRENT usage (re-aggregated from pipeline_stage_attempts right before the
 * check — never stale adoption-time counters), estimate the worst-case cost
 * for the upcoming stage, and throw a typed error BEFORE any HTTP attempt
 * row is created. The error carries the batch + stage context so the
 * reconciler can pause the batch correctly.
 *
 * The real gate is `used + upcoming <= cap` (plan §9):
 *   usedCalls + 1          <= maxLlmCalls
 *   usedInput + estimated  <= maxInputTokens
 *   usedOutput + reserved  <= maxOutputTokens
 *
 * When a cap is null (uncapped) we skip the check. `estimatedInputTokens` /
 * `reservedOutputTokens` come from the compiled stage request; callers that
 * cannot provide them pass 0 (the call-count gate still applies).
 */
export class BatchBudgetExceededError extends Error {
  readonly code: 'BATCH_BUDGET_EXCEEDED';
  readonly batchId: string;
  readonly stage: string;
  readonly cap: 'calls' | 'input' | 'output';
  constructor(
    batchId: string,
    stage: string,
    cap: BatchBudgetExceededError['cap'],
    message: string,
  ) {
    super(message);
    this.name = 'BatchBudgetExceededError';
    this.code = 'BATCH_BUDGET_EXCEEDED';
    this.batchId = batchId;
    this.stage = stage;
    this.cap = cap;
  }
}

async function assertBatchBudgetAvailable(params: {
  batchId: string;
  stage: string;
  estimatedInputTokens?: number;
  reservedOutputTokens?: number;
}): Promise<void> {
  const { batchId, stage } = params;
  const row = await one(
    `SELECT max_llm_calls, max_input_tokens, max_output_tokens,
            used_llm_calls, used_input_tokens, used_output_tokens
     FROM multi_chapter_batches WHERE id = ?`,
    [batchId],
  );
  if (!row) return; // batch vanished — caller will surface the missing-state error.
  const maxLlmCalls =
    row.max_llm_calls != null ? Number(row.max_llm_calls) : null;
  const maxInput =
    row.max_input_tokens != null ? Number(row.max_input_tokens) : null;
  const maxOutput =
    row.max_output_tokens != null ? Number(row.max_output_tokens) : null;

  // CL-06: re-aggregate usage from the durable attempt history so used_*
  // reflects every attempt that already happened — never the adoption-time
  // counters (they lag by a whole chapter).
  let usedLlmCalls = Number(row.used_llm_calls ?? 0);
  let usedInput = Number(row.used_input_tokens ?? 0);
  let usedOutput = Number(row.used_output_tokens ?? 0);
  try {
    const fresh = await setBatchUsageFromRuns(batchId);
    usedLlmCalls = fresh.llmCalls;
    usedInput = fresh.inputTokens;
    usedOutput = fresh.outputTokens;
  } catch {
    // non-fatal: the counters we already read are used as a fallback; the
    // attempt row itself remains the audit source of truth.
  }

  const estimatedInput = Math.max(0, Number(params.estimatedInputTokens ?? 0));
  const reservedOutput = Math.max(0, Number(params.reservedOutputTokens ?? 0));

  // used + upcoming <= cap — the real hard gate (not just used < cap).
  if (maxLlmCalls != null && usedLlmCalls + 1 > maxLlmCalls) {
    throw new BatchBudgetExceededError(
      batchId,
      stage,
      'calls',
      `批次 LLM 调用将超上限（已用 ${usedLlmCalls} + 本次 1 > ${maxLlmCalls}），已暂停第 ${stage} 阶段请求。`,
    );
  }
  if (maxInput != null && usedInput + estimatedInput > maxInput) {
    throw new BatchBudgetExceededError(
      batchId,
      stage,
      'input',
      `批次输入 token 将超上限（已用 ${usedInput} + 预计 ${estimatedInput} > ${maxInput}），已暂停第 ${stage} 阶段请求。`,
    );
  }
  if (maxOutput != null && usedOutput + reservedOutput > maxOutput) {
    throw new BatchBudgetExceededError(
      batchId,
      stage,
      'output',
      `批次输出 token 将超上限（已用 ${usedOutput} + 预留 ${reservedOutput} > ${maxOutput}），已暂停第 ${stage} 阶段请求。`,
    );
  }
}

/** CL-06: re-aggregate batch usage after an attempt terminal state so used_*
 *  reflects every attempt that already happened (never adoption-time lag). */
async function refreshBatchUsage(
  gate: { batchId: string } | undefined,
): Promise<void> {
  if (!gate) return;
  try {
    await setBatchUsageFromRuns(gate.batchId);
  } catch {
    // non-fatal: the attempt row remains the audit source of truth and the
    // next request's gate re-aggregates before checking.
  }
}

function cancelled(taskId: string, options: ReconcileOptions): boolean {
  if (options.abortSignal?.aborted) return true;
  if (options.isCancelled?.(taskId)) {
    usePipelineTaskStore.getState().cancelTask(taskId);
    return true;
  }
  return false;
}

/**
 * Abort handling shared by every stage executor and the outer loop:
 * - user cancel (isCancelled set): terminate the task (cancelled).
 * - pause interrupt (abort signal only): keep the task recoverable — the
 *   running checkpoint is already `interrupted`, resume reuses succeeded
 *   stages and re-fetches from the frozen request.
 */
async function settleInterruptedTask(
  taskId: string,
  options: ReconcileOptions,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  if (options.isCancelled?.(taskId)) {
    store.cancelTask(taskId);
  } else {
    if (store.persistTaskStatus) {
      await store.persistTaskStatus(taskId, 'interrupted');
    } else {
      store.setTaskStatus(taskId, 'interrupted');
    }
  }
}

async function persistSkipped(
  taskId: string,
  stage: PipelineStageName,
  text: string,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  if (store.persistTaskStage) {
    await store.persistTaskStage(taskId, {
      stage,
      text,
      status: 'skipped',
      durationMs: 0,
    });
  } else {
    store.updateTaskStage(taskId, {
      stage,
      text,
      status: 'skipped',
      durationMs: 0,
    });
  }
}

async function persistStage(
  taskId: string,
  result: {
    stage: PipelineStageName;
    text: string;
    status: 'success' | 'failed' | 'skipped';
    error?: string;
    errorCode?: string;
    tokens?: { input: number; output: number; total: number };
    warnings?: string[];
    durationMs: number;
  },
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  if (store.persistTaskStage) {
    await store.persistTaskStage(taskId, result);
  } else {
    store.updateTaskStage(taskId, result);
  }
}

/**
 * Main loop. Safe for first-run and resume.
 */
export async function reconcilePipelineTask(
  taskId: string,
  chapter: Chapter,
  options: ReconcileOptions = {},
): Promise<void> {
  if (reconciling.has(taskId)) {
    const err = new Error('任务已在运行') as Error & { code?: string };
    err.code = 'TASK_ALREADY_RUNNING';
    throw err;
  }
  reconciling.add(taskId);
  // CL-10: call-level (never module-global) foreground ownership. Defaults to
  // 'task' unless the caller (batch reconciler) declares 'batch'.
  const emitForeground = (options.foregroundOwner ?? 'task') === 'task';

  const store = usePipelineTaskStore.getState();
  const onStageUpdate = options.onStageUpdate;
  const abortSignal = options.abortSignal;

  // BN-11: batch-owned tasks defer all notifications to the single
  // batch-owned notification owned by the reconciler. Without this gate
  // every sub-task fires its own Android notification on top of the batch's.
  if (emitForeground) {
    PipelineForeground.start(
      taskId,
      chapter.title || '流水线',
      '正在准备写作',
      0,
    ).catch(() => {});
  }

  try {
    // Schema 39+: checkpoint rows are required. Fail-closed on DB errors.
    const initialTask = usePipelineTaskStore
      .getState()
      .tasks.find(t => t.id === taskId);
    const initialStages = shouldIncludeBriefCheckpoint({
      outlineWorkflowVersion: initialTask?.outlineWorkflowVersion,
      contextBudgetVersion: initialTask?.contextBudgetVersion,
    })
      ? ['draft', 'review', 'factCheck', 'brief', 'proof']
      : ['draft', 'review', 'factCheck', 'proof'];
    await db.ensurePendingCheckpoints(taskId, initialStages as any);

    // Bound iterations to avoid infinite loops on bugs.
    for (let step = 0; step < 32; step++) {
      if (cancelled(taskId, options)) {
        await PipelineForeground.stop(taskId);
        return;
      }

      // Reload memory projection; prefer DB checkpoints when available.
      const task = usePipelineTaskStore
        .getState()
        .tasks.find(t => t.id === taskId);
      if (!task) {
        throw new Error('找不到管线任务');
      }

      // Fail-closed: checkpoint query errors must not fall back to memory-only.
      const checkpointRows = await db.getStageCheckpoints(taskId);

      const stages = resolveStageCheckpoints({
        checkpointRows,
        stageResults: task.stageResults,
        outlineWorkflowVersion: task.outlineWorkflowVersion,
        contextBudgetVersion: task.contextBudgetVersion,
      });
      const view = buildPersistedTaskView(task);
      const action = determineNextPipelineAction(view, stages);

      // CL-01: a failed stage checkpoint with a persisted safe_retry /
      // rate_limit attempt must NOT be blocked terminally by STAGE_FAILED.
      // Consume the retry disposition first: waiting → hand back to the
      // UI/batch watchdog; retried → loop re-runs the stage; manual_* →
      // surface the distinct message instead of the generic failure.
      if (action.type === 'blocked' && action.reason.code === 'STAGE_FAILED') {
        const retry = await consumeFailedStageRetryDisposition({
          taskId,
          stage: action.reason.stage,
          options,
        });
        if (retry.outcome === 'waiting') return;
        if (retry.outcome === 'retried') continue;
        await handleBlocked(
          taskId,
          chapter,
          action,
          stages,
          retry.message,
          emitForeground,
        );
        return;
      }

      if (action.type === 'blocked') {
        await handleBlocked(
          taskId,
          chapter,
          action,
          stages,
          undefined,
          emitForeground,
        );
        return;
      }

      // Phase 3: persisted auto-retry gate (safe_retry/rate_limit only).
      // outcome_unknown never auto-retries; waiting_retry survives restarts
      // via the persisted next_retry_at.
      const retryResult = await maybeAutoRetryStage({
        taskId,
        stages,
        action,
        options,
      });
      if (retryResult === 'stop') {
        return;
      }

      // V2 proof resume (§6.5): a FAILED proof checkpoint with a persisted
      // safe_to_retry attempt must re-fire the SAME protocol proof instead of
      // degrading to draft immediately. The decision layer returns
      // finalize_from_draft (degraded) for proof failures, so consume the
      // retry disposition right before finalize: retried → loop re-runs the
      // proof stage with the frozen request; waiting → hand back (task stays
      // failed, watchdog/UI resumes later); none → degrade as designed.
      if (action.type === 'finalize_from_draft' && action.degraded === true) {
        const proofRetry = await consumeFailedStageRetryDisposition({
          taskId,
          stage: 'proof',
          options,
        });
        if (proofRetry.outcome === 'retried') continue;
        if (proofRetry.outcome === 'waiting') return;
      }

      const handled = await executeAction({
        taskId,
        chapter,
        action,
        stages,
        onStageUpdate,
        abortSignal,
        options,
      });
      if (handled === 'stop') {
        return;
      }
      // 'continue' → loop and re-read SQLite
    }

    store.failTask(taskId, '流水线状态机步数超限，已停止以防死循环');
    await PipelineForeground.stop(taskId);
  } catch (error: any) {
    if (isAbortError(error, abortSignal) || cancelled(taskId, options)) {
      await settleInterruptedTask(taskId, options);
      await PipelineForeground.stop(taskId);
      return;
    }
    // CL-06: batch budget gate errors must NOT be swallowed into a generic
    // failed task — the batch reconciler catches this typed error and pauses
    // the batch (paused_batch_budget). Swallowing it here would leave the
    // batch spinning on pause_unknown_outcome instead of the durable pause.
    if (error instanceof BatchBudgetExceededError) {
      throw error;
    }
    const mapped = mapOutlineErrorToPipelineError(error);
    const message = mapped?.message || getErrorMessage(error, '流水线执行失败');
    if (store.persistFailTask) {
      await store.persistFailTask(taskId, message);
    } else {
      store.failTask(taskId, message);
    }
    if (emitForeground) {
      await PipelineForeground.notifyFailed(
        taskId,
        chapter.title || '流水线',
        mapped?.message || '执行失败',
      );
    }
    await PipelineForeground.stop(taskId);
  } finally {
    reconciling.delete(taskId);
  }
}

/**
 * CL-01: consume the persisted retry disposition for a failed stage checkpoint
 * BEFORE `blocked(STAGE_FAILED)` is handled terminally.
 *
 * The pure decision lives in `determineRetryDisposition`; this function only
 * executes the durable transitions:
 *   - wait_retry  → sleep a bounded chunk; if still not due, hand back to the
 *                   UI / batch watchdog (the attempt row's next_retry_at is
 *                   already durable). If due during the wait, fall through to
 *                   reset the checkpoint and retry.
 *   - retry_now   → reset the checkpoint to pending with a bumped attempt
 *                   count so the loop re-runs the stage with the SAME frozen
 *                   request (never recompiled).
 *   - manual_*    → return the reason message so handleBlocked can surface it
 *                   instead of the generic STAGE_FAILED text.
 *   - fail        → no retry; STAGE_FAILED proceeds as before.
 */
async function consumeFailedStageRetryDisposition(params: {
  taskId: string;
  stage?: string;
  options: ReconcileOptions;
}): Promise<
  | { outcome: 'waiting' }
  | { outcome: 'retried' }
  | { outcome: 'none'; message?: string }
> {
  const stage = params.stage;
  if (!stage) return { outcome: 'none' };
  const attempts = await getStageAttempts(params.taskId, stage);
  const latest = attempts[attempts.length - 1];
  if (!latest) return { outcome: 'none' };
  const disposition: RetryDisposition = determineRetryDisposition(latest);

  if (disposition.kind === 'fail') return { outcome: 'none' };
  if (
    disposition.kind === 'manual_pause' ||
    disposition.kind === 'manual_confirm'
  ) {
    return { outcome: 'none', message: disposition.message };
  }

  if (disposition.kind === 'wait_retry') {
    const waitMs = Math.min(
      Math.max(0, disposition.retryAt - Date.now()),
      15_000,
    );
    await sleep(waitMs);
    if (params.options.abortSignal?.aborted) return { outcome: 'waiting' };
    if (Date.now() < disposition.retryAt) return { outcome: 'waiting' };
    // Due during the bounded wait — reset and retry now.
  }

  // retry_now (or wait_retry became due): reset checkpoint → re-run the stage.
  await db.upsertStageCheckpoint({
    taskId: params.taskId,
    stage: stage as any,
    status: 'pending',
    errorCode: null,
    errorMessage: null,
    bumpAttempt: true,
  });
  return { outcome: 'retried' };
}

async function handleBlocked(
  taskId: string,
  chapter: Chapter,
  action: Extract<PipelineAction, { type: 'blocked' }>,
  stages: ReturnType<typeof resolveStageCheckpoints>,
  messageOverride?: string,
  emitForeground = true,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  const code = action.reason.code;
  const message = messageOverride || action.reason.message;
  if (code === 'TASK_TERMINAL') {
    await PipelineForeground.stop(taskId);
    return;
  }
  if (code === 'TASK_ALREADY_RUNNING') {
    // Another executor owns a running stage — do not fail the task.
    await PipelineForeground.stop(taskId);
    return;
  }
  if (code === 'STAGE_FAILED' || code === 'TASK_NOT_RECOVERABLE') {
    if (store.persistFailTask) {
      await store.persistFailTask(taskId, message);
    } else {
      store.failTask(taskId, message);
    }
    if (emitForeground) {
      await PipelineForeground.notifyFailed(
        taskId,
        chapter.title || '流水线',
        message,
      );
    }
    await PipelineForeground.stop(taskId);
    return;
  }
  if (store.persistFailTask) {
    await store.persistFailTask(taskId, message);
  } else {
    store.failTask(taskId, message);
  }
  if (emitForeground) {
    await PipelineForeground.notifyFailed(
      taskId,
      chapter.title || '流水线',
      message,
    );
  }
  await PipelineForeground.stop(taskId);
  void stages;
}

async function executeAction(params: {
  taskId: string;
  chapter: Chapter;
  action: PipelineAction;
  stages: ReturnType<typeof resolveStageCheckpoints>;
  onStageUpdate?: (info: StageInfo | string) => void;
  abortSignal?: AbortSignal;
  options: ReconcileOptions;
}): Promise<'continue' | 'stop'> {
  const { taskId, chapter, action, onStageUpdate, abortSignal, options } =
    params;
  const store = usePipelineTaskStore.getState();

  switch (action.type) {
    case 'persist_initial_snapshot':
      await actionPersistInitialSnapshot(taskId, chapter, abortSignal, options);
      return 'continue';
    case 'run_draft':
      await actionRunDraft(
        taskId,
        chapter,
        onStageUpdate,
        abortSignal,
        options,
      );
      return 'continue';
    case 'build_audit_context':
      await actionBuildAuditContext(taskId, chapter, options);
      return 'continue';
    case 'run_review':
      await actionRunReview(
        taskId,
        chapter,
        onStageUpdate,
        abortSignal,
        options,
      );
      return 'continue';
    case 'run_fact_check':
      await actionRunFactCheck(
        taskId,
        chapter,
        onStageUpdate,
        abortSignal,
        options,
      );
      return 'continue';
    case 'run_review_and_fact_check':
      await actionRunReviewAndFactCheck(
        taskId,
        chapter,
        onStageUpdate,
        abortSignal,
        options,
      );
      return 'continue';
    case 'run_brief':
      await actionRunBrief(
        taskId,
        chapter,
        onStageUpdate,
        abortSignal,
        options,
      );
      return 'continue';
    case 'run_proof':
      await actionRunProof(
        taskId,
        chapter,
        onStageUpdate,
        abortSignal,
        options,
      );
      return 'continue';
    case 'finalize_from_draft':
      await actionFinalizeFromDraft(
        taskId,
        chapter,
        action.degraded === true,
        (options.foregroundOwner ?? 'task') === 'task',
      );
      return 'continue';
    case 'finalize_from_proof':
      await actionFinalizeFromProof(
        taskId,
        chapter,
        (options.foregroundOwner ?? 'task') === 'task',
      );
      return 'continue';
    case 'complete':
      await actionComplete(
        taskId,
        chapter,
        (options.foregroundOwner ?? 'task') === 'task',
      );
      return 'stop';
    case 'blocked':
      await handleBlocked(
        taskId,
        chapter,
        action,
        params.stages,
        undefined,
        (params.options.foregroundOwner ?? 'task') === 'task',
      );
      return 'stop';
    default:
      store.failTask(taskId, '未知流水线动作');
      await PipelineForeground.stop(taskId);
      return 'stop';
  }
}

async function loadRuntime(
  taskId: string,
  chapter: Chapter,
): Promise<{
  parsed: ParsedPipelineTaskContext | null;
  config: PipelineConfig;
  requestConfig: LLMRequestConfig;
  draftPreset: Preset | null;
  reviewPreset: Preset | null;
  factCheckPreset: Preset | null;
  proofPreset: Preset | null;
}> {
  const store = usePipelineTaskStore.getState();
  const task = store.tasks.find(t => t.id === taskId);
  let parsed: ParsedPipelineTaskContext | null = null;
  if (task?.pipelineContextJson) {
    try {
      parsed = parsePersistedPipelineTaskContext(task, {
        expectedProjectId: chapter.project_id,
        expectedChapterId: chapter.id,
      });
    } catch {
      parsed = null;
    }
  }

  if (parsed?.execution) {
    const live = await resolveLLMRequestConfigById(
      parsed.execution.model.llmConfigId,
    );
    const requestConfig = requestConfigFromExecution(parsed.execution, live);
    return {
      parsed,
      config: configFromExecution(parsed.execution),
      requestConfig,
      draftPreset: presetFromFrozen(parsed.execution.draftPreset),
      reviewPreset: presetFromFrozen(parsed.execution.reviewPreset),
      factCheckPreset: presetFromFrozen(parsed.execution.factCheckPreset),
      proofPreset: presetFromFrozen(parsed.execution.proofPreset),
    };
  }

  const config = await db.getPipelineConfig({
    includeHistoricalMode: Number(task?.outlineWorkflowVersion) === 2,
  });
  const presets = (await db.getPresetsByProject(
    chapter.project_id,
  )) as Preset[];
  const requestConfig = await resolveLLMRequestConfig();
  return {
    parsed,
    config,
    requestConfig,
    draftPreset: resolvePreset(config.draftPresetId, presets),
    reviewPreset: resolvePreset(config.reviewPresetId, presets),
    factCheckPreset: resolvePreset(config.factCheckPresetId, presets),
    proofPreset: resolvePreset(config.proofPresetId, presets),
  };
}

async function actionPersistInitialSnapshot(
  taskId: string,
  chapter: Chapter,
  abortSignal: AbortSignal | undefined,
  options: ReconcileOptions,
): Promise<void> {
  if (cancelled(taskId, options)) return;
  const store = usePipelineTaskStore.getState();
  // Fire the project lookup in parallel with loadRuntime so first-freeze never
  // adds a serial DB round-trip to the microtask chain.
  const runtime = await loadRuntime(taskId, chapter);
  // Resolve the protocol versions ONCE at first freeze from the TASK ROW
  // (frozen at task creation). Resume never re-reads live project mode /
  // defaults: frozen tasks keep their version. Missing or unparseable row
  // values fail closed to V1. New snapshots always carry both fields.
  // snapshots interprets an absent field as 1.
  const existingExecution = runtime.parsed?.execution;
  let outlineWorkflowVersion: 1 | 2 | 3 | 4;
  let contextBudgetVersion: 1 | 2 | 3 | 4 | 5 | 6;
  if (existingExecution) {
    outlineWorkflowVersion =
      existingExecution.outlineWorkflowVersion === 4
        ? 4
        : existingExecution.outlineWorkflowVersion === 3
        ? 3
        : existingExecution.outlineWorkflowVersion === 2
        ? 2
        : 1;
    contextBudgetVersion = normalizePersistedContextBudgetVersion(
      existingExecution.contextBudgetVersion,
    );
  } else {
    const taskRow = store.tasks.find(t => t.id === taskId);
    outlineWorkflowVersion =
      Number(taskRow?.outlineWorkflowVersion) === 4
        ? 4
        : Number(taskRow?.outlineWorkflowVersion) === 3
        ? 3
        : Number(taskRow?.outlineWorkflowVersion) === 2
        ? 2
        : 1;
    contextBudgetVersion = normalizePersistedContextBudgetVersion(
      taskRow?.contextBudgetVersion,
    );
  }
  const isStructured = shouldIncludeBriefCheckpoint({
    outlineWorkflowVersion,
    contextBudgetVersion,
  });
  // Fresh freeze from live config only when no execution yet. V2 preserves its
  // historical multiplier; V3 stores requested/effective stage tiers and uses
  // independent output + reasoning reservations.
  const selectedReasoningEffort =
    options.pipelineReasoningEffortOverride !== undefined
      ? options.pipelineReasoningEffortOverride
      : isStructured
      ? normalizePipelineReasoningTier(runtime.config.reasoningEffort)
      : normalizePipelineReasoningEffort(runtime.config.reasoningEffort);
  const freshConfig =
    isStructured && !existingExecution && selectedReasoningEffort
      ? {
          ...runtime.config,
          pipelineMode:
            outlineWorkflowVersion === 4 ? ('full' as const) : runtime.config.pipelineMode,
          reasoningEffort: normalizePipelineReasoningTier(
            selectedReasoningEffort,
          ),
          reasoningProfileVersion:
            outlineWorkflowVersion === 4
              ? (5 as const)
              : contextBudgetVersion === 4
              ? (4 as const)
              : (3 as const),
        }
      : outlineWorkflowVersion === 2 &&
        !existingExecution &&
        selectedReasoningEffort
      ? applyPipelineReasoningBudget(
          runtime.config,
          normalizePipelineReasoningEffort(selectedReasoningEffort),
        )
      : outlineWorkflowVersion === 2 &&
        !existingExecution &&
        options.pipelineReasoningEffortOverride === null
      ? { ...runtime.config, reasoningEffort: undefined }
      : runtime.config;

  // Read the persisted V3 policy ONCE at first freeze so the actual user
  // policy (not the default preset) drives the hierarchical allocator. On a
  // resume, prefer the policy already frozen in the execution/context
  // snapshot; never replace it with a newly edited live setting. Batch-owned
  // callers may provide the batch header snapshot as the final fallback for
  // historical V6 rows that predate execution-policy persistence.
  const persistedExecutionPolicy = existingExecution?.contextAutomationPolicySnapshot;
  const persistedContextPolicy =
    runtime.parsed?.draftContext?.contextBudgetV3Summary
      ?.contextAutomationPolicySnapshot;
  let frozenV3Policy: ContextAutomationPolicyV3 | undefined =
    persistedExecutionPolicy && isContextAutomationPolicyV3(persistedExecutionPolicy)
      ? persistedExecutionPolicy
      : persistedContextPolicy && isContextAutomationPolicyV3(persistedContextPolicy)
      ? persistedContextPolicy
      : options.contextAutomationPolicyV3 &&
        isContextAutomationPolicyV3(options.contextAutomationPolicyV3)
      ? options.contextAutomationPolicyV3
      : undefined;
  if (!frozenV3Policy && !existingExecution && contextBudgetVersion === 6) {
    try {
      const persistedPolicy = await getContextAutomationPolicyV3();
      if (persistedPolicy && isContextAutomationPolicyV3(persistedPolicy)) {
        frozenV3Policy = persistedPolicy;
      }
    } catch {
      // Settings read failure: buildContext falls back to the default policy.
    }
  }
  const execution =
    runtime.parsed?.execution ||
    buildExecutionSnapshot({
      config: freshConfig,
      draftPreset: runtime.draftPreset,
      reviewPreset: runtime.reviewPreset,
      factCheckPreset: runtime.factCheckPreset,
      proofPreset: runtime.proofPreset,
      requestConfig: runtime.requestConfig,
      outlineWorkflowVersion,
      contextBudgetVersion,
      contextAutomationPolicyV3: frozenV3Policy,
      finalReviserReasoningPolicyVersion:
        outlineWorkflowVersion === 4 || outlineWorkflowVersion === 3
          ? 3
          : outlineWorkflowVersion === 2
          ? 2
          : 1,
      reasoningProfileVersion:
      outlineWorkflowVersion === 4
          ? 5
          : outlineWorkflowVersion === 3
          ? contextBudgetVersion === 4
            ? 4
            : freshConfig.reasoningProfileVersion === 2
            ? 2
            : 3
          : undefined,
      reasoningEffort:
        outlineWorkflowVersion === 2 || outlineWorkflowVersion === 3 || outlineWorkflowVersion === 4
          ? freshConfig.reasoningEffort
          : undefined,
    });
  // Batch-owned first run: the batch form's mode wins over the global
  // pipeline setting. Resume never overrides a frozen snapshot.
  if (
    options.pipelineModeOverride &&
    !runtime.parsed?.execution &&
    outlineWorkflowVersion !== 4
  ) {
    execution.pipelineMode = options.pipelineModeOverride;
  }

  const compiled = await compileDraftStageRequest({
    chapter,
    requestConfig: runtime.requestConfig,
    draftPreset: runtime.draftPreset,
    draftMaxTokens: execution.draftMaxTokens,
    // Story Memory is an enhancement, not a writing license. Freeze the
    // latest usable checkpoint and pending bridge here, but never make the
    // first Draft request wait for synchronous checkpoint maintenance. The
    // prepare step returns a durable degradation warning when coverage is
    // incomplete; Story Memory maintenance remains available through its own
    // flow / chapter finalization.
    storyMemoryMode: 'preview',
    // Drive the V3 hierarchical branch from the FROZEN task version so the
    // allocator actually runs for the pipeline draft (not just Preview), and
    // pass the frozen policy so allocation matches Preview = Send (Closure
    // Plan §14/§16). The elastic flag is a belt-and-suspenders fallback.
    contextBudgetVersion: execution.contextBudgetVersion,
    contextAutomationPolicyV3: frozenV3Policy,
    elasticBudget:
      execution.contextBudgetVersion === 2 ||
      execution.contextBudgetVersion === 3 ||
      execution.contextBudgetVersion === 4 ||
      execution.contextBudgetVersion === 5 ||
      execution.contextBudgetVersion === 6,
  });
  if (!compiled.ready) {
    const code =
      compiled.error.code === 'OUTLINE_TOO_LARGE'
        ? 'OUTLINE_OVER_BUDGET'
        : 'OUTLINE_CONTEXT_WINDOW_EXCEEDED';
    throw new OutlineContextError(
      code,
      compiled.error.message,
      compiled.error.userAction === 'open_outline'
        ? 'open_outlines'
        : 'restart_task',
    );
  }
  const pipelineContext = compiled.draftCompile!.pipelineContext;
  const frozenDraftRequest = compiled.frozenDraftRequest!;

  // Freeze full-mode audit candidate pool at the same moment as draft context.
  let frozenAuditCandidates = runtime.parsed?.frozenAuditCandidates || null;
  if (execution.pipelineMode === 'full' && !frozenAuditCandidates) {
    const contextConfig = await db.getContextConfig();
    frozenAuditCandidates = await captureFrozenAuditCandidates(
      chapter,
      chapter.project_id,
      contextConfig,
      { contextBudgetVersion: execution.contextBudgetVersion },
    );
  }

  await store.persistTaskPipelineContext(
    taskId,
    serializePipelineTaskContext({
      draftContext: pipelineContext,
      execution,
      frozenDraftRequest,
      frozenAuditCandidates,
    }),
  );
  void abortSignal;
}

async function actionRunDraft(
  taskId: string,
  chapter: Chapter,
  onStageUpdate: ReconcileOptions['onStageUpdate'],
  abortSignal: AbortSignal | undefined,
  options: ReconcileOptions,
): Promise<void> {
  if (cancelled(taskId, options)) return;

  const emitForeground = (options.foregroundOwner ?? 'task') === 'task';
  const claim = await executeClaimedStage({
    taskId,
    stage: 'draft',
    abortSignal,
    isCancelled: () => cancelled(taskId, options),
    onClaimed: async () => {
      const store = usePipelineTaskStore.getState();
      if (store.persistTaskStatus) {
        await store.persistTaskStatus(taskId, 'drafting');
      } else {
        store.setTaskStatus(taskId, 'drafting');
      }
      onStageUpdate?.({
        stage: 'draft',
        label: '正在生成初稿',
        startedAt: Date.now(),
      });
      if (emitForeground) {
        PipelineForeground.updateProgress(taskId, '正在生成初稿', 0).catch(
          () => {},
        );
      }
    },
    run: async () => {
      const runtime = await loadRuntime(taskId, chapter);
      if (!runtime.parsed?.draftContext || !runtime.parsed.execution) {
        throw new OutlineContextError(
          'OUTLINE_SNAPSHOT_INVALID',
          '缺少冻结草稿上下文，无法生成初稿。',
          'restart_task',
        );
      }
      if (!runtime.parsed.frozenDraftRequest) {
        throw new OutlineContextError(
          'OUTLINE_SNAPSHOT_INVALID',
          '缺少冻结初稿请求，无法安全恢复。请重新开始生成。',
          'restart_task',
        );
      }
      const reasoning =
        stageReasoning(runtime, 'draft') ||
        resolvePipelineReasoning(
          runtime.parsed.execution,
          runtime.requestConfig,
        );
      const draftMaxTokens = stageMaxTokens(
        runtime,
        'draft',
        runtime.config.draftMaxTokens,
      );
      const draftReasoningSemantics = {
        thinking: reasoning.thinking?.type,
        reasoningEffort: reasoning.effort,
        reasoningPolicyVersion:
          runtime.parsed.execution.finalReviserReasoningPolicyVersion,
      } as const;

      // Draft must send frozen messages — never recompile from live project data.
      const firstCompile = compileDraftFromFrozenRequest({
        frozen: runtime.parsed.frozenDraftRequest,
      });
      const firstReady = requireReadyStageRequest(firstCompile);
      const start = Date.now();
      let tokens = { input: 0, output: 0, total: 0 };

      try {
        let result = await runStageAttempt({
          taskId,
          stage: 'draft',
          requestVersion: isV31Profile(runtime) ? 3 : undefined,
          requestFingerprint: runtime.parsed.execution.reasoningEffort
            ? stageFingerprint('draft', firstReady, draftReasoningSemantics)
            : runtime.parsed.frozenDraftRequest.requestFingerprint || '',
          allocationTraceJson: firstReady.elasticBudgetTrace
            ? JSON.stringify(firstReady.elasticBudgetTrace)
            : null,
          frozenRequestJson: JSON.stringify({
            ref: 'pipeline_context_json',
            fingerprint: runtime.parsed.frozenDraftRequest.requestFingerprint,
            thinking: reasoning.thinking?.type ?? 'omitted',
            reasoningEffort: reasoning.effort ?? null,
          }),
          llmConfigId: llmConfigIdOf(runtime.requestConfig),
          llmConfigSnapshotJson: llmConfigSnapshotJson(runtime.requestConfig),
          batchBudgetGate: options.batchBudgetGate,
          estimatedInputTokens: firstReady.estimatedInputTokens,
          reservedOutputTokens: firstReady.reservedOutputTokens,
          persistReasoningContentTemp: isV31Profile(runtime),
          run: () =>
            callReadyLLM(
              firstReady,
              draftMaxTokens,
              buildCallConfig(
                runtime.draftPreset,
                draftMaxTokens,
                'pipeline_draft',
                chapter.project_id,
                runtime.requestConfig,
                taskId,
                {
                  thinking: reasoning.thinking,
                  reasoningEffort: reasoning.effort,
                },
              ),
              abortSignal,
            ),
        });
        if (cancelled(taskId, options)) {
          const err = new Error('任务已取消') as Error & { code?: string };
          err.code = 'cancelled';
          throw err;
        }
        tokens = accumulateTokens(tokens, result);
        let draftText = result.text || '';
        if (
          !draftText.trim() &&
          !isV31Profile(runtime) &&
          (result.emptyReason === 'reasoning_only' ||
            result.emptyReason === 'length')
        ) {
          const retryCompile = compileDraftFromFrozenRequest({
            frozen: runtime.parsed.frozenDraftRequest,
            retryInstruction:
              '请直接输出章节正文；不要输出分析、思考过程或标题。',
          });
          if (!retryCompile.ready) {
            throw new OutlineContextError(
              'OUTLINE_CONTEXT_WINDOW_EXCEEDED',
              retryCompile.error.message,
              'restart_task',
            );
          }
          const retryReady = requireReadyStageRequest(retryCompile);
          result = await runStageAttempt({
            taskId,
            stage: 'draft',
            requestFingerprint: runtime.parsed.execution.reasoningEffort
              ? stageFingerprint('draft', retryReady, draftReasoningSemantics)
              : runtime.parsed.frozenDraftRequest.requestFingerprint || '',
            allocationTraceJson: retryReady.elasticBudgetTrace
              ? JSON.stringify(retryReady.elasticBudgetTrace)
              : null,
            frozenRequestJson: JSON.stringify({
              ref: 'pipeline_context_json',
              fingerprint: runtime.parsed.frozenDraftRequest.requestFingerprint,
              thinking: reasoning.thinking?.type ?? 'omitted',
              reasoningEffort: reasoning.effort ?? null,
            }),
            llmConfigId: llmConfigIdOf(runtime.requestConfig),
            llmConfigSnapshotJson: llmConfigSnapshotJson(runtime.requestConfig),
            batchBudgetGate: options.batchBudgetGate,
            estimatedInputTokens: retryReady.estimatedInputTokens,
            reservedOutputTokens: retryReady.reservedOutputTokens,
            run: () =>
              callReadyLLM(
                retryReady,
                draftMaxTokens,
                buildCallConfig(
                  runtime.draftPreset,
                  draftMaxTokens,
                  'pipeline_draft',
                  chapter.project_id,
                  runtime.requestConfig,
                  taskId,
                  {
                    thinking: reasoning.thinking,
                    reasoningEffort: reasoning.effort,
                  },
                ),
                abortSignal,
              ),
          });
          if (cancelled(taskId, options)) {
            const err = new Error('任务已取消') as Error & { code?: string };
            err.code = 'cancelled';
            throw err;
          }
          tokens = accumulateTokens(tokens, result);
          draftText = result.text || '';
        }
        if (!draftText.trim()) {
          switch (result.emptyReason) {
            case 'reasoning_only':
              throw new Error(
                '初稿仅返回推理内容，未产生正文。请提高模型最大输出 token 或改用非推理模型。',
              );
            case 'length':
              throw new Error(
                '初稿输出被 max_tokens 截断，未产生正文。请提高初稿或模型最大输出 token。',
              );
            default:
              throw new Error('初稿未返回正文，请检查模型服务后重试。');
          }
        }
        await persistStage(taskId, {
          stage: 'draft',
          text: draftText,
          status: 'success',
          tokens,
          durationMs: Date.now() - start,
        });
        if (isV31Profile(runtime)) {
          await updateLatestAttemptDiagnostics(taskId, 'draft', {
            parseFailureCode: null,
            clearReasoning: true,
          });
        }
      } catch (error: any) {
        if (isAbortError(error, abortSignal) || cancelled(taskId, options)) {
          await settleInterruptedTask(taskId, options);
          await PipelineForeground.stop(taskId);
          throw error;
        }
        // CL-06: budget-blocked requests never mark the stage failed — the
        // batch pauses itself; a later resume must be able to retry.
        if (error instanceof BatchBudgetExceededError) {
          throw error;
        }
        await persistStage(taskId, {
          stage: 'draft',
          text: '',
          status: 'failed',
          error: getErrorMessage(error, '初稿生成失败'),
          tokens,
          durationMs: Date.now() - start,
        });
        if (isV31Profile(runtime)) {
          await updateLatestAttemptDiagnostics(taskId, 'draft', {
            parseFailureCode: 'DRAFT_OUTPUT_INVALID',
            clearReasoning: true,
          });
        }
        throw error;
      }
    },
  });

  if (!claim.claimed) {
    throw Object.assign(new Error('任务已在运行'), {
      code: 'TASK_ALREADY_RUNNING',
    });
  }
}

async function actionBuildAuditContext(
  taskId: string,
  chapter: Chapter,
  options: ReconcileOptions,
): Promise<void> {
  if (cancelled(taskId, options)) return;
  const store = usePipelineTaskStore.getState();
  const runtime = await loadRuntime(taskId, chapter);
  if (!runtime.parsed?.draftContext || !runtime.parsed.execution) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '无法构建审核上下文：缺少冻结快照。',
      'restart_task',
    );
  }
  const draftText = await getDraftText(taskId);
  if (!draftText) {
    throw new Error('无法构建审核上下文：缺少初稿正文');
  }

  let auditContext = runtime.parsed.draftContext;
  let auditFellBack = false;

  // Full mode: only re-score within frozen candidate pool. Never re-query live DB.
  if (runtime.config.pipelineMode === 'full') {
    if (!runtime.parsed.frozenAuditCandidates) {
      throw new OutlineContextError(
        'OUTLINE_SNAPSHOT_INVALID',
        '缺少冻结审核候选集合，无法安全恢复审核上下文。请重新开始生成。',
        'restart_task',
      );
    }
    const retrieval = buildPostDraftAuditContextFromFrozen(
      runtime.parsed.draftContext,
      draftText,
      runtime.parsed.frozenAuditCandidates,
    );
    auditContext = retrieval.snapshot;
    auditFellBack = Boolean(retrieval.fellBack);
  }

  await store.persistTaskPipelineContext(
    taskId,
    serializePipelineTaskContext({
      draftContext: runtime.parsed.draftContext,
      auditContext,
      execution: runtime.parsed.execution,
      frozenDraftRequest: runtime.parsed.frozenDraftRequest,
      frozenAuditCandidates: runtime.parsed.frozenAuditCandidates,
      draftCompletedAt: Date.now(),
      auditContextCreatedAt: Date.now(),
      auditFellBack,
    }),
  );
}

async function getDraftText(taskId: string): Promise<string> {
  // Fail-closed: checkpoint read errors propagate.
  const row = await db.getStageCheckpoint(taskId, 'draft');
  if (row?.outputText) return row.outputText;
  const task = usePipelineTaskStore.getState().tasks.find(t => t.id === taskId);
  return (
    task?.stageResults.find(s => s.stage === 'draft' && s.status === 'success')
      ?.text || ''
  );
}

async function getStageText(
  taskId: string,
  stage: PipelineStageName,
): Promise<string> {
  const row = await db.getStageCheckpoint(taskId, stage);
  if (row?.status === 'succeeded' && row.outputText) return row.outputText;
  const task = usePipelineTaskStore.getState().tasks.find(t => t.id === taskId);
  return (
    task?.stageResults.find(s => s.stage === stage && s.status === 'success')
      ?.text || ''
  );
}

/** Model callers may only receive ReadyStageRequest. */
async function callReadyLLM(
  ready: ReadyStageRequest,
  maxTokens: number,
  config: ReturnType<typeof buildCallConfig>,
  abortSignal?: AbortSignal,
): Promise<LLMResult> {
  return callLLMResult(ready.messages, maxTokens, config, abortSignal);
}

function auditSnapshot(
  parsed: ParsedPipelineTaskContext,
): PipelineContextSnapshot {
  return parsed.auditContext || parsed.draftContext;
}

/** True when the frozen execution selected the V5-Lite V2 workflow. */
function isOutlineWorkflowV2(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
): boolean {
  return runtime.parsed?.execution?.outlineWorkflowVersion === 2;
}

function isOutlineWorkflowV3(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
): boolean {
  return shouldIncludeBriefCheckpoint({
    outlineWorkflowVersion: runtime.parsed?.execution?.outlineWorkflowVersion,
    contextBudgetVersion: runtime.parsed?.execution?.contextBudgetVersion,
  });
}

function isV31Profile(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
): boolean {
  return (
    isOutlineWorkflowV3(runtime) &&
    runtime.parsed?.execution?.reasoningProfileVersion === 3
  );
}

function isV32Profile(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
): boolean {
  return (
    isOutlineWorkflowV3(runtime) &&
    runtime.parsed?.execution?.reasoningProfileVersion === 4
  );
}

function isV33Profile(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
): boolean {
  return (
    runtime.parsed?.execution?.outlineWorkflowVersion === 4 &&
    runtime.parsed?.execution?.reasoningProfileVersion === 5
  );
}

function stageMaxTokens(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
  stage: PipelineStageName,
  fallback: number,
): number {
  const frozen = runtime.parsed?.execution?.stageBudgets?.find(
    budget => budget.stage === stage,
  );
  return frozen?.requestMaxTokens && frozen.requestMaxTokens > 0
    ? frozen.requestMaxTokens
    : fallback;
}

function stageReasoning(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
  stage: PipelineStageName,
): PipelineReasoningDecision | null {
  const execution = runtime.parsed?.execution;
  if (!execution) return null;
  const frozen = execution.stageReasoning?.[stage];
  if ([3, 4].includes(Number(execution.outlineWorkflowVersion)) && frozen) {
    return {
      effort: frozen.effort || frozen.effectiveTier,
      thinking: {
        type: frozen.thinking === 'enabled' ? 'enabled' : 'disabled',
      },
      supported: frozen.supported ?? frozen.effort != null,
      historical: false,
    };
  }
  return resolvePipelineReasoning(execution, runtime.requestConfig);
}

/** V2 and V3 both use the existing per-request elastic allocator. */
function isElasticBudgetEnabled(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
): boolean {
  const version = runtime.parsed?.execution?.contextBudgetVersion;
  return version === 2 || version === 3 || version === 4 || version === 5;
}

/**
 * V5-Lite V2 review stage: canonical draft + stable anchors + tagged single
 * injection + tolerant Review V2 contract validation. Review V2 protocol
 * normalization is deliberately local and single-shot; FactCheck V2 remains
 * strict and keeps its existing repair policy.
 * request_version=2 is recorded on attempts (§13).
 */
async function runReviewV2Stage(params: {
  taskId: string;
  chapter: Chapter;
  runtime: Awaited<ReturnType<typeof loadRuntime>>;
  abortSignal?: AbortSignal;
  options: ReconcileOptions;
}): Promise<void> {
  const { taskId, chapter, runtime, abortSignal, options } = params;
  if (!runtime.parsed?.execution) throw new Error('缺少冻结上下文');
  const reasoning = resolvePipelineReasoning(
    runtime.parsed.execution,
    runtime.requestConfig,
  );
  const draftText = await getDraftText(taskId);
  const canonicalDraft = canonicalizeDraft(draftText);
  const anchors = buildRevisionAnchors(canonicalDraft);
  const draftHash = computeDraftHash(canonicalDraft);
  const tagged = buildTaggedDraft(canonicalDraft);
  const ctxSnap =
    runtime.config.pipelineMode === 'full'
      ? auditSnapshot(runtime.parsed)
      : runtime.parsed.draftContext;
  const context = buildReviewContextFromSnapshot(ctxSnap);
  const start = Date.now();
  let tokens = { input: 0, output: 0, total: 0 };

  const compile = (
    repairReason?: string,
    maxTokens = runtime.config.reviewMaxTokens,
  ) =>
    compileReviewV2StageRequest({
      taggedDraft: tagged.taggedText,
      context,
      draftHash,
      maxTokens,
      contextWindow: runtime.requestConfig.context_window || 0,
      repairReason,
    });
  const validate = (result: LLMResult) =>
    validateReviewV2Result({
      result,
      canonicalDraft,
      expectedHash: draftHash,
      anchors,
    });

  let compiled = compile();
  if (!compiled.ready) {
    await persistStage(taskId, {
      stage: 'review',
      text: '',
      status: 'failed',
      error: compiled.error.message,
      durationMs: Date.now() - start,
    });
    return;
  }

  try {
    const first = await runStageAttempt({
      taskId,
      stage: 'review',
      requestVersion: 2,
      requestFingerprint: stageFingerprint('review', compiled, {
        thinking: reasoning.thinking?.type,
        reasoningEffort: reasoning.effort,
        reasoningPolicyVersion:
          runtime.parsed.execution.finalReviserReasoningPolicyVersion,
      }),
      allocationTraceJson: compiled.elasticBudgetTrace
        ? JSON.stringify(compiled.elasticBudgetTrace)
        : null,
      llmConfigId: llmConfigIdOf(runtime.requestConfig),
      llmConfigSnapshotJson: llmConfigSnapshotJson(runtime.requestConfig),
      batchBudgetGate: options.batchBudgetGate,
      estimatedInputTokens: compiled.estimatedInputTokens,
      reservedOutputTokens: compiled.reservedOutputTokens,
      run: () =>
        callReadyLLM(
          compiled,
          runtime.config.reviewMaxTokens,
          buildStructuredAuditCallConfig(
            runtime.reviewPreset,
            runtime.config.reviewMaxTokens,
            'pipeline_review',
            chapter.project_id,
            runtime.requestConfig,
            taskId,
            reasoning,
          ),
          abortSignal,
        ),
    });
    if (cancelled(taskId, options)) {
      const err = new Error('任务已取消') as Error & { code?: string };
      err.code = 'cancelled';
      throw err;
    }
    tokens = accumulateTokens(tokens, first);
    let validation = validate(first);
    logPipelineAudit({
      stage: 'review',
      attempt: 1,
      valid: validation.valid,
      reason: validation.reason,
      textLength: first.text?.length || 0,
      ...auditObservation(first),
      taskId,
    });

    if (validation.valid && validation.normalizedText) {
      await persistStage(taskId, {
        stage: 'review',
        text: validation.normalizedText,
        status: 'success',
        warnings: validation.warnings,
        tokens,
        durationMs: Date.now() - start,
      });
      return;
    }
    await updateLatestAttemptDiagnostics(taskId, 'review', {
      parseFailureCode: validation.reason || 'AUDIT_INVALID',
      failureClass: 'response_invalid',
      errorCode: PIPELINE_RESPONSE_INVALID_ERROR_CODE,
      errorMessage:
        validation.reason === 'reasoning_only'
          ? '文学评估仅返回推理内容，未产生 message.content 合同'
          : formatAuditFailureMessage('review', validation.reason),
    });
    await persistStage(taskId, {
      stage: 'review',
      text: '',
      status: 'failed',
      error:
        validation.reason === 'reasoning_only'
          ? '文学评估的 content 为空，仅返回推理通道 reasoning_content，未产生报告；请结合 finishReason 判断是否截断，不能仅凭此结论提高 max_tokens。'
          : formatAuditFailureMessage('review', validation.reason),
      tokens,
      durationMs: Date.now() - start,
    });
  } catch (error: any) {
    if (isAbortError(error, abortSignal)) {
      await settleInterruptedTask(taskId, options);
      await PipelineForeground.stop(taskId);
      throw error;
    }
    if (error instanceof BatchBudgetExceededError) {
      throw error;
    }
    await persistStage(taskId, {
      stage: 'review',
      text: '',
      status: 'failed',
      error: getErrorMessage(error, '文学评估失败'),
      tokens,
      durationMs: Date.now() - start,
    });
  }
}

/**
 * V5-Lite V2 fact-check stage: anchored single injection + FactCheck V2
 * contract validation + one-shot format repair. request_version=2 (§13).
 */
async function runFactCheckV2Stage(params: {
  taskId: string;
  chapter: Chapter;
  runtime: Awaited<ReturnType<typeof loadRuntime>>;
  abortSignal?: AbortSignal;
  options: ReconcileOptions;
}): Promise<void> {
  const { taskId, chapter, runtime, abortSignal, options } = params;
  if (!runtime.parsed?.execution) throw new Error('缺少冻结上下文');
  const reasoning = resolvePipelineReasoning(
    runtime.parsed.execution,
    runtime.requestConfig,
  );
  const draftText = await getDraftText(taskId);
  const canonicalDraft = canonicalizeDraft(draftText);
  const anchors = buildRevisionAnchors(canonicalDraft);
  const draftHash = computeDraftHash(canonicalDraft);
  const tagged = buildTaggedDraft(canonicalDraft);
  const ctxSnap =
    runtime.config.pipelineMode === 'full'
      ? auditSnapshot(runtime.parsed)
      : runtime.parsed.draftContext;
  const context = buildFactCheckContextFromSnapshot(ctxSnap);
  const start = Date.now();
  let tokens = { input: 0, output: 0, total: 0 };

  const compile = (
    repairReason?: string,
    maxTokens = runtime.config.factCheckMaxTokens,
  ) =>
    compileFactCheckV2StageRequest({
      taggedDraft: tagged.taggedText,
      context,
      draftHash,
      maxTokens,
      contextWindow: runtime.requestConfig.context_window || 0,
      repairReason,
    });
  const validate = (result: LLMResult) =>
    validateFactCheckV2Result({
      result,
      canonicalDraft,
      expectedHash: draftHash,
      anchors,
    });

  let compiled = compile();
  if (!compiled.ready) {
    await persistStage(taskId, {
      stage: 'factCheck',
      text: '',
      status: 'failed',
      error: compiled.error.message,
      durationMs: Date.now() - start,
    });
    return;
  }

  try {
    const first = await runStageAttempt({
      taskId,
      stage: 'factCheck',
      requestVersion: 2,
      requestFingerprint: stageFingerprint('factCheck', compiled, {
        thinking: reasoning.thinking?.type,
        reasoningEffort: reasoning.effort,
        reasoningPolicyVersion:
          runtime.parsed.execution.finalReviserReasoningPolicyVersion,
      }),
      allocationTraceJson: compiled.elasticBudgetTrace
        ? JSON.stringify(compiled.elasticBudgetTrace)
        : null,
      llmConfigId: llmConfigIdOf(runtime.requestConfig),
      llmConfigSnapshotJson: llmConfigSnapshotJson(runtime.requestConfig),
      batchBudgetGate: options.batchBudgetGate,
      estimatedInputTokens: compiled.estimatedInputTokens,
      reservedOutputTokens: compiled.reservedOutputTokens,
      run: () =>
        callReadyLLM(
          compiled,
          runtime.config.factCheckMaxTokens,
          buildStructuredAuditCallConfig(
            runtime.factCheckPreset,
            runtime.config.factCheckMaxTokens,
            'pipeline_factcheck',
            chapter.project_id,
            runtime.requestConfig,
            taskId,
            reasoning,
          ),
          abortSignal,
        ),
    });
    if (cancelled(taskId, options)) {
      const err = new Error('任务已取消') as Error & { code?: string };
      err.code = 'cancelled';
      throw err;
    }
    tokens = accumulateTokens(tokens, first);
    let validation = validate(first);
    logPipelineAudit({
      stage: 'factCheck',
      attempt: 1,
      valid: validation.valid,
      reason: validation.reason,
      textLength: first.text?.length || 0,
      ...auditObservation(first),
      taskId,
    });

    if (!validation.valid) {
      const isReasoningOnly = validation.reason === 'reasoning_only';
      const retryMaxTokens =
        isReasoningOnly && first.finishReason === 'length'
          ? bumpRetryBudget(
              runtime.config.factCheckMaxTokens,
              runtime.requestConfig.max_output_tokens,
            )
          : runtime.config.factCheckMaxTokens;
      const repair = compile(
        isReasoningOnly
          ? REASONING_ONLY_REPAIR_HINT
          : buildV2RepairReason(validation.reason, validation.details),
        retryMaxTokens,
      );
      if (!repair.ready) {
        await persistStage(taskId, {
          stage: 'factCheck',
          text: '',
          status: 'failed',
          error: repair.error.message,
          tokens,
          durationMs: Date.now() - start,
        });
        return;
      }
      const repairReady = requireReadyStageRequest(repair);
      const retryReasoning: PipelineReasoningDecision = isReasoningOnly
        ? { supported: false, historical: false }
        : reasoning;
      const retry = await runStageAttempt({
        taskId,
        stage: 'factCheck',
        requestVersion: 2,
        requestFingerprint: stageFingerprint('factCheck', repairReady, {
          thinking: retryReasoning.thinking?.type,
          reasoningEffort: retryReasoning.effort,
          reasoningPolicyVersion:
            runtime.parsed.execution.finalReviserReasoningPolicyVersion,
        }),
        allocationTraceJson: repairReady.elasticBudgetTrace
          ? JSON.stringify(repairReady.elasticBudgetTrace)
          : null,
        llmConfigId: llmConfigIdOf(runtime.requestConfig),
        llmConfigSnapshotJson: llmConfigSnapshotJson(runtime.requestConfig),
        batchBudgetGate: options.batchBudgetGate,
        estimatedInputTokens: repairReady.estimatedInputTokens,
        reservedOutputTokens: repairReady.reservedOutputTokens,
        run: () =>
          callReadyLLM(
            repairReady,
            retryMaxTokens,
            buildStructuredAuditCallConfig(
              runtime.factCheckPreset,
              retryMaxTokens,
              'pipeline_factcheck',
              chapter.project_id,
              runtime.requestConfig,
              taskId,
              retryReasoning,
            ),
            abortSignal,
          ),
      });
      if (cancelled(taskId, options)) {
        const err = new Error('任务已取消') as Error & { code?: string };
        err.code = 'cancelled';
        throw err;
      }
      tokens = accumulateTokens(tokens, retry);
      validation = validate(retry);
      logPipelineAudit({
        stage: 'factCheck',
        attempt: 2,
        valid: validation.valid,
        reason: validation.reason,
        textLength: retry.text?.length || 0,
        ...auditObservation(retry),
        taskId,
      });
    }

    if (validation.valid && validation.normalizedText) {
      await persistStage(taskId, {
        stage: 'factCheck',
        text: validation.normalizedText,
        status: 'success',
        tokens,
        durationMs: Date.now() - start,
      });
      return;
    }
    await updateLatestAttemptDiagnostics(taskId, 'factCheck', {
      parseFailureCode: validation.reason || 'AUDIT_INVALID',
      failureClass: 'response_invalid',
      errorCode: PIPELINE_RESPONSE_INVALID_ERROR_CODE,
      errorMessage:
        validation.reason === 'reasoning_only'
          ? '事实核查仅返回推理内容，未产生 message.content 合同'
          : formatAuditFailureMessage('factCheck', validation.reason),
    });
    await persistStage(taskId, {
      stage: 'factCheck',
      text: '',
      status: 'failed',
      error:
        validation.reason === 'reasoning_only'
          ? '事实核查的 content 为空，仅返回推理通道 reasoning_content，未产生报告；请结合 finishReason 判断是否截断，不能仅凭此结论提高 max_tokens。'
          : formatAuditFailureMessage('factCheck', validation.reason),
      tokens,
      durationMs: Date.now() - start,
    });
  } catch (error: any) {
    if (isAbortError(error, abortSignal)) {
      await settleInterruptedTask(taskId, options);
      await PipelineForeground.stop(taskId);
      throw error;
    }
    if (error instanceof BatchBudgetExceededError) {
      throw error;
    }
    await persistStage(taskId, {
      stage: 'factCheck',
      text: '',
      status: 'failed',
      error: getErrorMessage(error, '事实核查失败'),
      tokens,
      durationMs: Date.now() - start,
    });
  }
}

async function runV3AuditStage(params: {
  stage: 'review' | 'factCheck';
  taskId: string;
  chapter: Chapter;
  runtime: Awaited<ReturnType<typeof loadRuntime>>;
  abortSignal?: AbortSignal;
  options: ReconcileOptions;
}): Promise<void> {
  const { stage, taskId, chapter, runtime, abortSignal, options } = params;
  if (!runtime.parsed?.execution) throw new Error('缺少冻结上下文');
  const draftText = await getDraftText(taskId);
  const canonicalDraft = canonicalizeDraft(draftText);
  const anchors = buildRevisionAnchors(canonicalDraft);
  const draftHash = computeDraftHash(canonicalDraft);
  const taggedDraft = buildTaggedDraft(canonicalDraft).taggedText;
  const snapshot =
    runtime.config.pipelineMode === 'full'
      ? auditSnapshot(runtime.parsed)
      : runtime.parsed.draftContext;
  const baseContext =
    stage === 'review'
      ? buildReviewContextFromSnapshot(snapshot)
      : buildFactCheckContextFromSnapshot(snapshot);
  // V3 audit requests must retain the independently frozen seam. Put the
  // ending first because the conservation clip keeps the prefix; this keeps
  // the immediately preceding scene visible even when the optional bridge is
  // shortened under a small model window.
  const seamText = [
    snapshot.immediatePreviousChapterEnding
      ? `【上一章即时结尾】\n${snapshot.immediatePreviousChapterEnding}`
      : '',
    snapshot.immediatePreviousChapterText
      ? `【上一章即时正文】\n${snapshot.immediatePreviousChapterText}`
      : '',
    baseContext.recentBridgeText
      ? `【近期桥接】\n${baseContext.recentBridgeText}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const context = {
    ...baseContext,
    recentBridgeText: seamText || baseContext.recentBridgeText,
  };
  const maxTokens = stageMaxTokens(
    runtime,
    stage,
    stage === 'review'
      ? runtime.config.reviewMaxTokens
      : runtime.config.factCheckMaxTokens,
  );
  const reasoning = stageReasoning(runtime, stage);
  const v31 = isV31Profile(runtime);
  const v32 = isV32Profile(runtime);
  const v33 = isV33Profile(runtime);
  const factCheckInputRefs = v32 || v33
    ? buildFactCheckInputRefsV32([
        {
          key: 'continuity',
          text: [
            snapshot.immediatePreviousChapterText,
            snapshot.immediatePreviousChapterEnding,
            snapshot.recentBridgeText,
            snapshot.storyMemoryText,
            snapshot.episodicMemoryText,
          ]
            .filter(Boolean)
            .join('\n'),
        },
        { key: 'characters', text: snapshot.characterText },
        { key: 'worldbook', text: snapshot.worldbookText },
        { key: 'outline', text: snapshot.outlineText },
      ])
    : [];
  const v32ReviewEnvelope = v32
    ? buildReviewImmutableEnvelopeV32({
        draftHash,
        endingBoundary: snapshot.outlineText.trim().slice(-1200),
      })
    : null;
  const v32FactCheckEnvelope = v32
    ? buildFactCheckImmutableEnvelopeV32({
        draftHash,
        inputFactRefs: factCheckInputRefs,
      })
    : null;
  const v33ReviewEnvelope = v33
    ? buildReviewImmutableEnvelopeV33({
        draftHash,
        endingBoundary: snapshot.outlineText.trim().slice(-1200),
      })
    : null;
  const v33FactCheckEnvelope = v33
    ? buildFactCheckImmutableEnvelopeV33({
        draftHash,
        inputFactRefs: factCheckInputRefs,
      })
    : null;
  const factCheckInputDimensions: FactCheckV32Category[] = v32 || v33
    ? [
        ...(snapshot.immediatePreviousChapterText ||
        snapshot.immediatePreviousChapterEnding ||
        snapshot.recentBridgeText ||
        snapshot.episodicMemoryText
          ? (['timeline', 'spatial_logic'] as FactCheckV32Category[])
          : []),
        ...(snapshot.characterText
          ? ([
              'character_state',
              'knowledge_boundary',
            ] as FactCheckV32Category[])
          : []),
        ...(snapshot.worldbookText
          ? (['object_state', 'world_rule'] as FactCheckV32Category[])
          : []),
        ...(snapshot.outlineText
          ? (['outline_boundary'] as FactCheckV32Category[])
          : []),
      ]
    : [];
  const start = Date.now();
  let tokens = { input: 0, output: 0, total: 0 };

  const compile = (repairReason?: string) =>
    stage === 'review'
      ? compileReviewV2StageRequest({
          taggedDraft,
          context: context as ReturnType<typeof buildReviewContextFromSnapshot>,
          draftHash,
          maxTokens,
          contextWindow: runtime.requestConfig.context_window || 0,
          repairReason,
          elasticBudget: isElasticBudgetEnabled(runtime),
        })
      : compileFactCheckV2StageRequest({
          taggedDraft,
          context: context as ReturnType<
            typeof buildFactCheckContextFromSnapshot
          >,
          draftHash,
          maxTokens,
          contextWindow: runtime.requestConfig.context_window || 0,
          repairReason,
          elasticBudget: isElasticBudgetEnabled(runtime),
        });

  let lastCandidateSelection: ReturnType<
    typeof selectStructuredCandidate
  > | null = null;
  let legalSourceIdsForFormatter: string[] | undefined = v33
    ? anchors.map(anchor => anchor.id)
    : undefined;
  const validate = (result: LLMResult) => {
    if (v33) {
      const selection = selectStructuredCandidate({
        result,
        expectedRootKeys: ['verdict', 'checked', 'findings'],
        coverageKeys: ['checked'],
        findingKeys: ['findings'],
      });
      lastCandidateSelection = selection;
      if (!selection.candidate) {
        return {
          valid: false as const,
          reason:
            result.emptyReason === 'reasoning_only' ||
            (!result.text?.trim() && result.reasoningText?.trim())
              ? 'reasoning_only'
              : 'invalid_json',
          details: selection.rejected
            .map(item => item.channel + ':' + item.reason)
            .join(', '),
        };
      }
      return stage === 'review'
        ? validateReviewSemanticPayloadV33({
            raw: selection.candidate.parsed,
            envelope: v33ReviewEnvelope!,
            anchors,
          })
        : validateFactCheckSemanticPayloadV33({
            raw: selection.candidate.parsed,
            envelope: v33FactCheckEnvelope!,
            inputDimensions: factCheckInputDimensions,
            anchors,
          });
    }
    if (v32) {
      const adapted = adaptV32AuditResult(result, stage);
      lastCandidateSelection = adapted.selection;
      if (!adapted.selection.candidate) {
        return {
          valid: false as const,
          reason:
            result.emptyReason === 'reasoning_only' ||
            (!result.text?.trim() && result.reasoningText?.trim())
              ? 'reasoning_only'
              : 'invalid_json',
          details: adapted.selection.rejected
            .map(item => item.channel + ':' + item.reason)
            .join(', '),
        };
      }
      return stage === 'review'
        ? validateReviewSemanticPayloadV32({
            raw: adapted.selection.candidate.parsed,
            envelope: v32ReviewEnvelope!,
            legalSourceIds: legalSourceIdsForFormatter,
          })
        : validateFactCheckSemanticPayloadV32({
            raw: adapted.selection.candidate.parsed,
            envelope: v32FactCheckEnvelope!,
            inputDimensions: factCheckInputDimensions,
            legalSourceIds: legalSourceIdsForFormatter,
          });
    }
    const structuredCandidate = v31
      ? selectStructuredCandidate({
          result,
          expectedRootKeys:
            stage === 'review'
              ? [
                  'schemaVersion',
                  'draftHash',
                  'corrections',
                  'outlineExecution',
                ]
              : [
                  'schemaVersion',
                  'draftHash',
                  'corrections',
                  'hardConstraints',
                ],
          findingKeys: [
            'corrections',
            'requiredCorrections',
            'issues',
            'errors',
          ],
        })
      : null;
    lastCandidateSelection = structuredCandidate;
    const candidateResult =
      v31 && structuredCandidate
        ? structuredCandidate.candidate
          ? {
              ...result,
              text: structuredCandidate.candidate.text,
              reasoningText: null,
            }
          : result
        : result;
    const compatible = v31
      ? adaptV31AuditResult(candidateResult, stage, draftHash).result
      : candidateResult;
    // The standalone V3 validator may inspect reasoning text for diagnostics
    // and compatibility tests. A live V3.1 task must never adopt that hidden
    // channel as the business report: only message.content is admissible.
    if (v31 && !compatible.text?.trim() && compatible.reasoningText?.trim()) {
      return {
        valid: false as const,
        reason: 'reasoning_only' as const,
        details: 'content 为空，仅返回 reasoning_content',
      };
    }
    return stage === 'review'
      ? validateReviewV3Result({
          result: compatible,
          expectedHash: draftHash,
          anchors,
          strictSemantic: v31,
        })
      : validateFactCheckV3Result({
          result: compatible,
          expectedHash: draftHash,
          anchors,
          strictSemantic: v31,
        });
  };

  const compiledBase = compile();
  if (!compiledBase.ready) {
    await persistStage(taskId, {
      stage,
      text: '',
      status: 'failed',
      error: compiledBase.error.message,
      durationMs: Date.now() - start,
    });
    return;
  }
  const compiled: ReadyStageRequest =
    v31 || v32 || v33
      ? (() => {
          const messages = v33
            ? stage === 'review'
              ? buildReviewV33Messages({
                  canonicalDraft: taggedDraft,
                  context: context as ReturnType<
                    typeof buildReviewContextFromSnapshot
                  >,
                })
              : buildFactCheckV33Messages({
                  canonicalDraft: taggedDraft,
                  context: context as ReturnType<
                    typeof buildFactCheckContextFromSnapshot
                  >,
                  inputFactRefs: factCheckInputRefs,
                  inputDimensions: factCheckInputDimensions,
                })
            : v32
            ? stage === 'review'
              ? buildReviewV32Messages({
                  canonicalDraft,
                  context: context as ReturnType<
                    typeof buildReviewContextFromSnapshot
                  >,
                })
              : buildFactCheckV32Messages({
                  canonicalDraft,
                  context: context as ReturnType<
                    typeof buildFactCheckContextFromSnapshot
                  >,
                  inputFactRefs: factCheckInputRefs,
                  inputDimensions: factCheckInputDimensions,
                })
            : stage === 'review'
            ? buildReviewV31Messages({
                canonicalDraft,
                context: context as ReturnType<
                  typeof buildReviewContextFromSnapshot
                >,
                draftHash,
              })
            : buildFactCheckV31Messages({
                canonicalDraft,
                context: context as ReturnType<
                  typeof buildFactCheckContextFromSnapshot
                >,
                draftHash,
              });
          return {
            ...compiledBase,
            messages,
            estimatedInputTokens: estimateTokens(
              messages.map(message => message.content).join('\n'),
            ),
          };
        })()
      : compiledBase;

  const callCompiled = async (
    ready: ReadyStageRequest,
    attemptNo: number,
    disableThinking: boolean,
  ) => {
    const semantics = {
      thinking: disableThinking
        ? ('disabled' as const)
        : reasoning?.thinking?.type,
      reasoningEffort: disableThinking ? undefined : reasoning?.effort,
      reasoningPolicyVersion: v33 ? 5 : v32 ? 4 : 3,
    };
    const frozenRequestJson = JSON.stringify({
      requestVersion: v33 ? 33 : v32 ? 32 : 3,
      stage,
      attempt: attemptNo,
      thinking: semantics.thinking || 'omitted',
      reasoningEffort: semantics.reasoningEffort || null,
      responseFormat: 'json_object',
      temperature: 0.2,
      topP: 1,
      messagesHash: sha256Hex(JSON.stringify(ready.messages)).slice(0, 32),
      maxTokens: ready.reservedOutputTokens,
      contextWindow: ready.contextWindow,
    });
    return runStageAttempt({
      taskId,
      stage,
      requestVersion: v33 ? 33 : v32 ? 32 : 3,
      requestFingerprint: stageFingerprint(stage, ready, semantics),
      allocationTraceJson: ready.elasticBudgetTrace
        ? JSON.stringify(ready.elasticBudgetTrace)
        : null,
      frozenRequestJson,
      llmConfigId: llmConfigIdOf(runtime.requestConfig),
      llmConfigSnapshotJson: llmConfigSnapshotJson(runtime.requestConfig),
      batchBudgetGate: options.batchBudgetGate,
      estimatedInputTokens: ready.estimatedInputTokens,
      reservedOutputTokens: ready.reservedOutputTokens,
      persistReasoningContentTemp: v31,
      persistResponseCandidateTemp: v31 || v32 || v33,
      run: () =>
        callReadyLLM(
          ready,
          ready.reservedOutputTokens,
          disableThinking
            ? buildStructuredAuditCallConfig(
                stage === 'review'
                  ? runtime.reviewPreset
                  : runtime.factCheckPreset,
                ready.reservedOutputTokens,
                stage === 'review' ? 'pipeline_review' : 'pipeline_factcheck',
                chapter.project_id,
                runtime.requestConfig,
                taskId,
                { supported: false, historical: false },
              )
            : buildStructuredAuditCallConfig(
                stage === 'review'
                  ? runtime.reviewPreset
                  : runtime.factCheckPreset,
                ready.reservedOutputTokens,
                stage === 'review' ? 'pipeline_review' : 'pipeline_factcheck',
                chapter.project_id,
                runtime.requestConfig,
                taskId,
                reasoning || undefined,
              ),
          abortSignal,
        ),
    });
  };

  const runAuditFormatter = async (
    invalid: LLMResult,
  ): Promise<{ result: LLMResult; legalSourceIds: string[] }> => {
    const selection = selectStructuredCandidate({
      result: invalid,
      expectedRootKeys:
        v33
          ? ['verdict', 'checked', 'findings']
          : stage === 'review'
          ? ['verdict', 'findings', 'outlineAssessment', 'coverage']
          : ['verdict', 'findings', 'confirmedFactRefs', 'coverage'],
      findingKeys: [
        'findings',
        'corrections',
        'requiredCorrections',
        'issues',
        'errors',
      ],
    });
    const candidate =
      selection.candidate?.text ||
      invalid.text?.trim() ||
      invalid.reasoningText?.trim() ||
      '';
    const formatter = buildAuditFormatterPrompt({
      stage,
      candidate,
      contractVersion: v33 ? 33 : v32 ? 32 : 31,
      legalSourceIds: v33 || v32 ? legalSourceIdsForFormatter : undefined,
      requiredCoverageDimensions: v33 || v32
        ? stage === 'review'
          ? [...REVIEW_V32_DIMENSIONS]
          : factCheckInputDimensions
        : undefined,
      requiredFactRefs:
        (v33 || v32) && stage === 'factCheck'
          ? factCheckInputRefs
          : undefined,
    });
    const { messages, legalSourceIds } = formatter;
    // The formatter is body-free and never re-runs the primary audit, but a
    // legacy V3.1 contract can still contain several executable corrections
    // plus its required envelope arrays.  1536 tokens was small enough to
    // truncate a valid formatter response (finish_reason=length), turning a
    // recoverable candidate into a failed checkpoint.  Keep this independent
    // from the primary stage budget while leaving ample room for the compact
    // semantic V3.2 contract.
    const reservedOutputTokens = Math.min(
      4096,
      Math.max(1024, Math.floor(maxTokens || 1024)),
    );
    const ready = {
      ready: true as const,
      stage,
      messages,
      estimatedInputTokens: estimateTokens(
        messages.map(message => message.content).join('\n'),
      ),
      reservedOutputTokens,
      safetyMargin: 128,
      contextWindow: runtime.requestConfig.context_window || 0,
      allocations: [],
    } as ReadyStageRequest;
    const semantics = {
      thinking: 'disabled' as const,
      reasoningPolicyVersion: v33 ? 5 : v32 ? 4 : 3,
    };
    const result = await runStageAttempt({
      taskId,
      stage,
      requestVersion: v33 ? 33 : v32 ? 32 : 31,
      requestFingerprint: stageFingerprint(stage, ready, semantics),
      allocationTraceJson: JSON.stringify({ formatter: true }),
      frozenRequestJson: JSON.stringify({
        requestVersion: v33 ? 33 : v32 ? 32 : 31,
        formatter: true,
        thinking: 'disabled',
        maxTokens: reservedOutputTokens,
        legalSourceIds,
        messagesHash: sha256Hex(JSON.stringify(messages)).slice(0, 32),
      }),
      llmConfigId: llmConfigIdOf(runtime.requestConfig),
      llmConfigSnapshotJson: llmConfigSnapshotJson(runtime.requestConfig),
      batchBudgetGate: options.batchBudgetGate,
      estimatedInputTokens: ready.estimatedInputTokens,
      reservedOutputTokens,
      formatterUsed: true,
      persistReasoningContentTemp: true,
      persistResponseCandidateTemp: true,
      run: () =>
        callReadyLLM(
          ready,
          reservedOutputTokens,
          buildStructuredAuditCallConfig(
            stage === 'review' ? runtime.reviewPreset : runtime.factCheckPreset,
            reservedOutputTokens,
            stage === 'review'
              ? 'pipeline_review_formatter'
              : 'pipeline_factcheck_formatter',
            chapter.project_id,
            runtime.requestConfig,
            taskId,
            { supported: false, historical: false },
          ),
          abortSignal,
        ),
    });
    return { result, legalSourceIds };
  };

  try {
    // A process can die after the provider response is durably recorded but
    // before the checkpoint is settled. V3.1 may recover only the same
    // checkpoint's persisted reasoning; it must never silently replay a full
    // audit request. A new explicit retry gets a newer checkpoint.startedAt
    // and therefore starts a fresh bounded decision.
    const structuredProfile = v31 || v32 || v33;
    const checkpointAtStart = structuredProfile
      ? await db.getStageCheckpoint(taskId, stage)
      : null;
    const latestAttempt = structuredProfile
      ? await getLatestStageAttempt(taskId, stage)
      : null;
    const sameCheckpointAttempt = Boolean(
      structuredProfile &&
        checkpointAtStart?.startedAt != null &&
        latestAttempt &&
        latestAttempt.startedAt >= checkpointAtStart.startedAt,
    );
    const formatterAlreadyAttempted = Boolean(
      sameCheckpointAttempt && latestAttempt?.formatterUsed,
    );
    const coldStartHasNoRecoverableCandidate = Boolean(
      sameCheckpointAttempt &&
        !latestAttempt?.responseCandidateTemp &&
        !latestAttempt?.reasoningContentTemp,
    );
    let result: LLMResult;
    let validation: any;
    let formatterUsedThisRun = false;
    if (sameCheckpointAttempt && latestAttempt) {
      const candidateScratch = latestAttempt.responseCandidateTemp || '';
      result = {
        text: candidateScratch || '',
        reasoningText: candidateScratch
          ? null
          : latestAttempt.reasoningContentTemp || null,
        inputTokens: Number(latestAttempt.inputTokens || 0),
        outputTokens: Number(latestAttempt.outputTokens || 0),
        totalTokens: Number(latestAttempt.totalTokens || 0),
        reasoningTokens: latestAttempt.reasoningTokens,
        visibleOutputTokens: latestAttempt.visibleOutputTokens,
        finishReason: latestAttempt.finishReason,
        emptyReason: (latestAttempt.emptyReason ||
          'empty') as LLMResult['emptyReason'],
      };
      tokens = accumulateTokens(tokens, result);
      validation = validate(result);
      logPipelineAudit({
        stage,
        attempt: latestAttempt.attemptNo,
        valid: validation.valid,
        reason: validation.reason,
        textLength: result.text?.length || 0,
        ...auditObservation(result),
        taskId,
      });
    } else {
      result = await callCompiled(compiled, 1, false);
      tokens = accumulateTokens(tokens, result);
      validation = validate(result);
      logPipelineAudit({
        stage,
        attempt: 1,
        valid: validation.valid,
        reason: validation.reason,
        textLength: result.text?.length || 0,
        ...auditObservation(result),
        taskId,
      });
    }
    const formatterSelection = selectStructuredCandidate({
      result,
      expectedRootKeys:
        v33
          ? ['verdict', 'checked', 'findings']
          : stage === 'review'
          ? ['verdict', 'findings', 'outlineAssessment', 'coverage']
          : ['verdict', 'findings', 'confirmedFactRefs', 'coverage'],
      findingKeys: [
        'findings',
        'corrections',
        'requiredCorrections',
        'issues',
        'errors',
      ],
    });
    const recoverableFormatterInput =
      formatterSelection.candidate?.text ||
      result.text?.trim() ||
      result.reasoningText?.trim() ||
      '';
    const formatterEligible =
      Boolean(recoverableFormatterInput) &&
      // V3.2 may receive prose or a JSON fragment only in reasoning_content.
      // Let the body-free Formatter normalize that bounded candidate once;
      // requiring a parsed root here would turn recoverable reasoning-only
      // responses into an unnecessary full-stage retry.
      (!(v32 || v33) ||
        Boolean(formatterSelection.candidate) ||
        Boolean(result.reasoningText?.trim())) &&
      result.finishReason !== 'content_filter' &&
      !formatterAlreadyAttempted &&
      !coldStartHasNoRecoverableCandidate;
    if (
      v32 &&
      !(legalSourceIdsForFormatter || []).length &&
      formatterSelection.candidate
    ) {
      legalSourceIdsForFormatter = buildAuditSourceManifest(
        stage,
        formatterSelection.candidate.parsed,
      );
    }
    if (!validation.valid && (v31 || v32 || v33) && formatterEligible) {
      await updateLatestAttemptDiagnostics(taskId, stage, {
        parseFailureCode: validation.reason || 'AUDIT_INVALID',
        validationDetailsJson: validationDetailsJson({
          validation,
          selection: lastCandidateSelection || formatterSelection,
          formatterEligible,
          formatterDecision: 'formatter_started',
        }),
      });
      formatterUsedThisRun = true;
      const formatted = await runAuditFormatter(result);
      result = formatted.result;
      tokens = accumulateTokens(tokens, result);
      validation = validate(result);
      if (validation.valid && validation.report) {
        const legalIds = new Set(formatted.legalSourceIds);
        const corrections =
          stage === 'review'
            ? [
                ...(validation.report.executableCorrections || []),
                ...(validation.report.unlocatedRequired || []),
              ]
            : validation.report.corrections || [];
        if (
          v31 &&
          corrections.some(
            (item: { sourceId?: string }) =>
              !legalIds.has(String(item.sourceId || '').trim()),
          )
        ) {
          validation = {
            valid: false,
            reason: 'missing_required_fields',
            details: 'Audit Formatter 生成了候选 reasoning 中不存在的 sourceId',
          };
        }
      }
      if (
        validation.valid &&
        v32 &&
        validation.report &&
        formatted.legalSourceIds.length === 0 &&
        ((validation.report.executableCorrections || []).length ||
          (validation.report.corrections || []).length)
      ) {
        validation = {
          valid: false,
          reason: 'missing_required_fields',
          details: 'Audit Formatter 未得到候选 sourceId manifest',
        };
      }
      logPipelineAudit({
        stage,
        attempt: 2,
        valid: validation.valid,
        reason: validation.reason,
        textLength: result.text?.length || 0,
        ...auditObservation(result),
        taskId,
      });
    }
    const diagnosticSelection = (lastCandidateSelection ||
      formatterSelection) as ReturnType<typeof selectStructuredCandidate>;
    if (validation.valid && validation.normalizedText) {
      await updateLatestAttemptDiagnostics(taskId, stage, {
        parseFailureCode: null,
        responseCandidateChannel:
          diagnosticSelection.responseChannel !== 'empty'
            ? diagnosticSelection.responseChannel
            : null,
        validationDetailsJson: validationDetailsJson({
          validation,
          selection: diagnosticSelection,
          formatterEligible,
          formatterDecision: formatterUsedThisRun
            ? 'formatter_succeeded'
            : formatterAlreadyAttempted
            ? 'formatter_already_attempted'
            : 'primary_contract',
        }),
        clearReasoning: true,
      });
      await persistStage(taskId, {
        stage,
        text: validation.normalizedText,
        status: 'success',
        warnings: [
          ...(validation.warnings || []),
          formatterUsedThisRun
            ? 'Contract Formatter（Thinking disabled；未重跑完整主审）'
            : v33
            ? `合同首轮通过（当前 ${
                stage === 'review' ? 'Review' : 'FactCheck'
              }：Thinking enabled + ${reasoning?.effort || 'low'}）`
            : v32
            ? '合同首轮通过（Review/FactCheck primary：Thinking enabled + low）'
            : '合同首轮通过',
        ],
        tokens,
        durationMs: Date.now() - start,
      });
      return;
    }
    await updateLatestAttemptDiagnostics(taskId, stage, {
      parseFailureCode: validation.reason || 'AUDIT_INVALID',
      failureClass: 'response_invalid',
      errorCode: PIPELINE_RESPONSE_INVALID_ERROR_CODE,
      errorMessage:
        validation.reason === 'reasoning_only'
          ? `${
              stage === 'review' ? '文学评估' : '事实核查'
            }仅返回推理内容，未产生 message.content 合同`
          : formatAuditFailureMessage(stage, validation.reason),
      responseCandidateChannel:
        diagnosticSelection.responseChannel !== 'empty'
          ? diagnosticSelection.responseChannel
          : null,
      validationDetailsJson: validationDetailsJson({
        validation,
        selection: diagnosticSelection,
        formatterEligible,
        formatterDecision:
          formatterEligible && !formatterAlreadyAttempted
            ? 'formatter_not_used_or_failed'
            : 'not_eligible',
      }),
      clearReasoning: true,
    });
    await persistStage(taskId, {
      stage,
      text: '',
      status: 'failed',
      warnings: [
        '结构化合同失败：' +
          String(validation.reason || 'AUDIT_INVALID') +
          validationFieldHint(validation),
        formatterUsedThisRun
          ? 'Contract Formatter（Thinking disabled；已尝试一次）'
          : 'Contract Formatter 未执行',
      ],
      error:
        validation.reason === 'reasoning_only'
          ? `${
              stage === 'review' ? '文学评估' : '事实核查'
            }仅返回推理内容，提取重试后仍无报告`
          : formatAuditFailureMessage(stage, validation.reason),
      tokens,
      durationMs: Date.now() - start,
    });
  } catch (error: any) {
    if (isAbortError(error, abortSignal)) {
      await settleInterruptedTask(taskId, options);
      await PipelineForeground.stop(taskId);
      throw error;
    }
    if (error instanceof BatchBudgetExceededError) throw error;
    await persistStage(taskId, {
      stage,
      text: '',
      status: 'failed',
      error: getErrorMessage(
        error,
        stage === 'review' ? '文学评估失败' : '事实核查失败',
      ),
      tokens,
      durationMs: Date.now() - start,
    });
  }
}

async function actionRunReview(
  taskId: string,
  chapter: Chapter,
  onStageUpdate: ReconcileOptions['onStageUpdate'],
  abortSignal: AbortSignal | undefined,
  options: ReconcileOptions,
): Promise<void> {
  if (cancelled(taskId, options)) return;

  const claim = await executeClaimedStage({
    taskId,
    stage: 'review',
    abortSignal,
    isCancelled: () => cancelled(taskId, options),
    onClaimed: async () => {
      const store = usePipelineTaskStore.getState();
      if (store.persistTaskStatus) {
        await store.persistTaskStatus(taskId, 'reviewing');
      } else {
        store.setTaskStatus(taskId, 'reviewing');
      }
      onStageUpdate?.({
        stage: 'review',
        label: '正在进行文学评估',
        startedAt: Date.now(),
      });
    },
    run: async () => {
      const runtime = await loadRuntime(taskId, chapter);
      if (isOutlineWorkflowV3(runtime)) {
        await runV3AuditStage({
          stage: 'review',
          taskId,
          chapter,
          runtime,
          abortSignal,
          options,
        });
        return;
      }
      if (isOutlineWorkflowV2(runtime)) {
        await runReviewV2Stage({
          taskId,
          chapter,
          runtime,
          abortSignal,
          options,
        });
        return;
      }
      if (!runtime.parsed) throw new Error('缺少冻结上下文');
      const draftText = await getDraftText(taskId);
      const ctxSnap =
        runtime.config.pipelineMode === 'full'
          ? auditSnapshot(runtime.parsed)
          : runtime.parsed.draftContext;
      const context = buildReviewContextFromSnapshot(ctxSnap);
      const start = Date.now();
      let tokens = { input: 0, output: 0, total: 0 };

      const compiled = compileReviewStageRequest({
        draftText,
        context,
        maxTokens: runtime.config.reviewMaxTokens,
        contextWindow: runtime.requestConfig.context_window || 0,
        elasticBudget: isElasticBudgetEnabled(runtime),
      });
      if (!compiled.ready) {
        await persistStage(taskId, {
          stage: 'review',
          text: '',
          status: 'failed',
          error: compiled.error.message,
          durationMs: Date.now() - start,
        });
        return;
      }

      // Phase 3: persist one durable attempt row per LLM call.
      try {
        const first = await runStageAttempt({
          taskId,
          stage: 'review',
          requestFingerprint: stageFingerprint('review', compiled),
          allocationTraceJson: compiled.elasticBudgetTrace
            ? JSON.stringify(compiled.elasticBudgetTrace)
            : null,
          llmConfigId: llmConfigIdOf(runtime.requestConfig),
          llmConfigSnapshotJson: llmConfigSnapshotJson(runtime.requestConfig),
          batchBudgetGate: options.batchBudgetGate,
          estimatedInputTokens: compiled.estimatedInputTokens,
          reservedOutputTokens: compiled.reservedOutputTokens,
          run: () =>
            callReadyLLM(
              compiled,
              runtime.config.reviewMaxTokens,
              buildCallConfig(
                runtime.reviewPreset,
                runtime.config.reviewMaxTokens,
                'pipeline_review',
                chapter.project_id,
                runtime.requestConfig,
                taskId,
                { responseFormat: 'json_object' },
              ),
              abortSignal,
            ),
        });
        if (cancelled(taskId, options)) {
          const err = new Error('任务已取消') as Error & { code?: string };
          err.code = 'cancelled';
          throw err;
        }
        tokens = accumulateTokens(tokens, first);
        const hasOutline = !!(
          context.outlineText && context.outlineText.trim()
        );
        let validation = validateReviewResult(first, draftText, { hasOutline });
        logPipelineAudit({
          stage: 'review',
          attempt: 1,
          valid: validation.valid,
          reason: validation.reason,
          textLength: first.text?.length || 0,
          ...auditObservation(first),
          taskId,
        });

        if (!validation.valid) {
          const isReasoningOnly = validation.reason === 'reasoning_only';
          // A reasoning-only response may be either a length truncation or a
          // stop-without-content response. Keep the existing bounded recovery
          // retry, but use finishReason diagnostics rather than assuming that
          // the model exhausted its CoT budget.
          const retryMaxTokens =
            isReasoningOnly && first.finishReason === 'length'
              ? bumpRetryBudget(
                  runtime.config.reviewMaxTokens,
                  runtime.requestConfig.max_output_tokens,
                )
              : runtime.config.reviewMaxTokens;
          const repair = compileReviewStageRequest({
            draftText,
            context,
            maxTokens: retryMaxTokens,
            contextWindow: runtime.requestConfig.context_window || 0,
            repairReason: isReasoningOnly
              ? REASONING_ONLY_REPAIR_HINT
              : describeAuditFailureReason(validation.reason),
            elasticBudget: isElasticBudgetEnabled(runtime),
          });
          if (!repair.ready) {
            await persistStage(taskId, {
              stage: 'review',
              text: '',
              status: 'failed',
              error: repair.error.message,
              tokens,
              durationMs: Date.now() - start,
            });
            return;
          }
          const repairReady = requireReadyStageRequest(repair);
          const retry = await runStageAttempt({
            taskId,
            stage: 'review',
            requestFingerprint: stageFingerprint('review', repairReady),
            allocationTraceJson: repairReady.elasticBudgetTrace
              ? JSON.stringify(repairReady.elasticBudgetTrace)
              : null,
            llmConfigId: llmConfigIdOf(runtime.requestConfig),
            llmConfigSnapshotJson: llmConfigSnapshotJson(runtime.requestConfig),
            batchBudgetGate: options.batchBudgetGate,
            estimatedInputTokens: repairReady.estimatedInputTokens,
            reservedOutputTokens: repairReady.reservedOutputTokens,
            run: () =>
              callReadyLLM(
                repairReady,
                retryMaxTokens,
                buildCallConfig(
                  runtime.reviewPreset,
                  retryMaxTokens,
                  'pipeline_review',
                  chapter.project_id,
                  runtime.requestConfig,
                  taskId,
                  isReasoningOnly
                    ? {
                        responseFormat: 'json_object',
                        thinking: { type: 'disabled' },
                      }
                    : { responseFormat: 'json_object' },
                ),
                abortSignal,
              ),
          });
          if (cancelled(taskId, options)) {
            const err = new Error('任务已取消') as Error & { code?: string };
            err.code = 'cancelled';
            throw err;
          }
          tokens = accumulateTokens(tokens, retry);
          validation = validateReviewResult(retry, draftText, { hasOutline });
          logPipelineAudit({
            stage: 'review',
            attempt: 2,
            valid: validation.valid,
            reason: validation.reason,
            textLength: retry.text?.length || 0,
            ...auditObservation(retry),
            taskId,
          });
        }

        if (validation.valid && validation.normalizedText) {
          await persistStage(taskId, {
            stage: 'review',
            text: validation.normalizedText,
            status: 'success',
            tokens,
            durationMs: Date.now() - start,
          });
          return;
        }
        await persistStage(taskId, {
          stage: 'review',
          text: '',
          status: 'failed',
          error:
            validation.reason === 'reasoning_only'
              ? '文学评估的 content 为空，仅返回推理通道 reasoning_content，未产生报告；请结合 finishReason 判断是否截断，不能仅凭此结论提高 max_tokens。'
              : formatAuditFailureMessage('review', validation.reason),
          tokens,
          durationMs: Date.now() - start,
        });
      } catch (error: any) {
        if (isAbortError(error, abortSignal)) {
          await settleInterruptedTask(taskId, options);
          await PipelineForeground.stop(taskId);
          throw error;
        }
        // CL-06: budget-blocked requests never mark the stage failed.
        if (error instanceof BatchBudgetExceededError) {
          throw error;
        }
        await persistStage(taskId, {
          stage: 'review',
          text: '',
          status: 'failed',
          error: getErrorMessage(error, '文学评估失败'),
          tokens,
          durationMs: Date.now() - start,
        });
      }
    },
  });

  if (!claim.claimed) {
    throw Object.assign(new Error('任务已在运行'), {
      code: 'TASK_ALREADY_RUNNING',
    });
  }
}

async function actionRunFactCheck(
  taskId: string,
  chapter: Chapter,
  onStageUpdate: ReconcileOptions['onStageUpdate'],
  abortSignal: AbortSignal | undefined,
  options: ReconcileOptions,
): Promise<void> {
  if (cancelled(taskId, options)) return;

  const claim = await executeClaimedStage({
    taskId,
    stage: 'factCheck',
    abortSignal,
    isCancelled: () => cancelled(taskId, options),
    onClaimed: async () => {
      const store = usePipelineTaskStore.getState();
      if (store.persistTaskStatus) {
        await store.persistTaskStatus(taskId, 'factChecking');
      } else {
        store.setTaskStatus(taskId, 'factChecking');
      }
      onStageUpdate?.({
        stage: 'factCheck',
        label: '正在进行事实核查',
        startedAt: Date.now(),
      });
    },
    run: async () => {
      const runtime = await loadRuntime(taskId, chapter);
      if (isOutlineWorkflowV3(runtime)) {
        await runV3AuditStage({
          stage: 'factCheck',
          taskId,
          chapter,
          runtime,
          abortSignal,
          options,
        });
        return;
      }
      if (isOutlineWorkflowV2(runtime)) {
        await runFactCheckV2Stage({
          taskId,
          chapter,
          runtime,
          abortSignal,
          options,
        });
        return;
      }
      if (!runtime.parsed) throw new Error('缺少冻结上下文');
      const draftText = await getDraftText(taskId);
      const ctxSnap =
        runtime.config.pipelineMode === 'full'
          ? auditSnapshot(runtime.parsed)
          : runtime.parsed.draftContext;
      const context = buildFactCheckContextFromSnapshot(ctxSnap);
      const start = Date.now();
      let tokens = { input: 0, output: 0, total: 0 };

      const compiled = compileFactCheckStageRequest({
        draftText,
        context,
        maxTokens: runtime.config.factCheckMaxTokens,
        contextWindow: runtime.requestConfig.context_window || 0,
        elasticBudget: isElasticBudgetEnabled(runtime),
      });
      if (!compiled.ready) {
        await persistStage(taskId, {
          stage: 'factCheck',
          text: '',
          status: 'failed',
          error: compiled.error.message,
          durationMs: Date.now() - start,
        });
        return;
      }

      // Phase 3: persist one durable attempt row per LLM call.
      try {
        const first = await runStageAttempt({
          taskId,
          stage: 'factCheck',
          requestFingerprint: stageFingerprint('factCheck', compiled),
          allocationTraceJson: compiled.elasticBudgetTrace
            ? JSON.stringify(compiled.elasticBudgetTrace)
            : null,
          llmConfigId: llmConfigIdOf(runtime.requestConfig),
          llmConfigSnapshotJson: llmConfigSnapshotJson(runtime.requestConfig),
          batchBudgetGate: options.batchBudgetGate,
          estimatedInputTokens: compiled.estimatedInputTokens,
          reservedOutputTokens: compiled.reservedOutputTokens,
          run: () =>
            callReadyLLM(
              compiled,
              runtime.config.factCheckMaxTokens,
              buildCallConfig(
                runtime.factCheckPreset,
                runtime.config.factCheckMaxTokens,
                'pipeline_factcheck',
                chapter.project_id,
                runtime.requestConfig,
                taskId,
                { responseFormat: 'json_object' },
              ),
              abortSignal,
            ),
        });
        if (cancelled(taskId, options)) {
          const err = new Error('任务已取消') as Error & { code?: string };
          err.code = 'cancelled';
          throw err;
        }
        tokens = accumulateTokens(tokens, first);
        let validation = validateFactCheckResult(first, draftText);
        logPipelineAudit({
          stage: 'factCheck',
          attempt: 1,
          valid: validation.valid,
          reason: validation.reason,
          textLength: first.text?.length || 0,
          ...auditObservation(first),
          taskId,
        });
        if (!validation.valid) {
          const isReasoningOnly = validation.reason === 'reasoning_only';
          // A reasoning-only response may be either a length truncation or a
          // stop-without-content response. Keep the existing bounded recovery
          // retry, but use finishReason diagnostics rather than assuming that
          // the model exhausted its CoT budget.
          const retryMaxTokens =
            isReasoningOnly && first.finishReason === 'length'
              ? bumpRetryBudget(
                  runtime.config.factCheckMaxTokens,
                  runtime.requestConfig.max_output_tokens,
                )
              : runtime.config.factCheckMaxTokens;
          const repair = compileFactCheckStageRequest({
            draftText,
            context,
            maxTokens: retryMaxTokens,
            contextWindow: runtime.requestConfig.context_window || 0,
            repairReason: isReasoningOnly
              ? REASONING_ONLY_REPAIR_HINT
              : describeAuditFailureReason(validation.reason),
            elasticBudget: isElasticBudgetEnabled(runtime),
          });
          if (!repair.ready) {
            await persistStage(taskId, {
              stage: 'factCheck',
              text: '',
              status: 'failed',
              error: repair.error.message,
              tokens,
              durationMs: Date.now() - start,
            });
            return;
          }
          const repairReady = requireReadyStageRequest(repair);
          const retry = await runStageAttempt({
            taskId,
            stage: 'factCheck',
            requestFingerprint: stageFingerprint('factCheck', repairReady),
            allocationTraceJson: repairReady.elasticBudgetTrace
              ? JSON.stringify(repairReady.elasticBudgetTrace)
              : null,
            llmConfigId: llmConfigIdOf(runtime.requestConfig),
            llmConfigSnapshotJson: llmConfigSnapshotJson(runtime.requestConfig),
            batchBudgetGate: options.batchBudgetGate,
            estimatedInputTokens: repairReady.estimatedInputTokens,
            reservedOutputTokens: repairReady.reservedOutputTokens,
            run: () =>
              callReadyLLM(
                repairReady,
                retryMaxTokens,
                buildCallConfig(
                  runtime.factCheckPreset,
                  retryMaxTokens,
                  'pipeline_factcheck',
                  chapter.project_id,
                  runtime.requestConfig,
                  taskId,
                  isReasoningOnly
                    ? {
                        responseFormat: 'json_object',
                        thinking: { type: 'disabled' },
                      }
                    : { responseFormat: 'json_object' },
                ),
                abortSignal,
              ),
          });
          if (cancelled(taskId, options)) {
            const err = new Error('任务已取消') as Error & { code?: string };
            err.code = 'cancelled';
            throw err;
          }
          tokens = accumulateTokens(tokens, retry);
          validation = validateFactCheckResult(retry, draftText);
          logPipelineAudit({
            stage: 'factCheck',
            attempt: 2,
            valid: validation.valid,
            reason: validation.reason,
            textLength: retry.text?.length || 0,
            ...auditObservation(retry),
            taskId,
          });
        }
        if (validation.valid && validation.normalizedText) {
          await persistStage(taskId, {
            stage: 'factCheck',
            text: validation.normalizedText,
            status: 'success',
            tokens,
            durationMs: Date.now() - start,
          });
          return;
        }
        await persistStage(taskId, {
          stage: 'factCheck',
          text: '',
          status: 'failed',
          error:
            validation.reason === 'reasoning_only'
              ? '事实核查的 content 为空，仅返回推理通道 reasoning_content，未产生报告；请结合 finishReason 判断是否截断，不能仅凭此结论提高 max_tokens。'
              : formatAuditFailureMessage('factCheck', validation.reason),
          tokens,
          durationMs: Date.now() - start,
        });
      } catch (error: any) {
        if (isAbortError(error, abortSignal)) {
          await settleInterruptedTask(taskId, options);
          await PipelineForeground.stop(taskId);
          throw error;
        }
        // CL-06: budget-blocked requests never mark the stage failed.
        if (error instanceof BatchBudgetExceededError) {
          throw error;
        }
        await persistStage(taskId, {
          stage: 'factCheck',
          text: '',
          status: 'failed',
          error: getErrorMessage(error, '事实核查失败'),
          tokens,
          durationMs: Date.now() - start,
        });
      }
    },
  });

  if (!claim.claimed) {
    throw Object.assign(new Error('任务已在运行'), {
      code: 'TASK_ALREADY_RUNNING',
    });
  }
}

async function actionRunReviewAndFactCheck(
  taskId: string,
  chapter: Chapter,
  onStageUpdate: ReconcileOptions['onStageUpdate'],
  abortSignal: AbortSignal | undefined,
  options: ReconcileOptions,
): Promise<void> {
  onStageUpdate?.({
    stage: 'review',
    label: '正在进行文学评估与事实核查',
    startedAt: Date.now(),
  });
  // Parallel: each stage CAS-claims independently.
  await Promise.all([
    actionRunReview(taskId, chapter, onStageUpdate, abortSignal, options),
    actionRunFactCheck(taskId, chapter, onStageUpdate, abortSignal, options),
  ]);
}

function parseNormalizedAudit<T>(text: string): T | null {
  try {
    const parsed = JSON.parse(text) as T & { schemaVersion?: number };
    return parsed &&
      (parsed.schemaVersion === 3 ||
        parsed.schemaVersion === 4 ||
        parsed.schemaVersion === 5)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function buildBriefCompilerInput(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
  reviewText: string,
  factCheckText: string,
): BriefCompilerInputV1 {
  const review = parseNormalizedAudit<NormalizedReviewV3>(reviewText);
  const factCheck = parseNormalizedAudit<NormalizedFactCheckV3>(factCheckText);
  const sourceWithoutHash: Omit<BriefCompilerInputV1, 'sourceHash'> = {
    schemaVersion: 1,
    workflowMode:
      runtime.config.pipelineMode === 'conditional'
        ? 'conditional'
        : runtime.config.pipelineMode === 'full'
        ? 'full'
        : 'twoStage',
    ...(review
      ? {
          review: {
            executableCorrections: review.executableCorrections,
            unlocatedRequired: review.unlocatedRequired,
            advisoryNotes: review.advisoryNotes,
            outlineExecution: review.outlineExecution,
          },
        }
      : {}),
    ...(factCheck
      ? {
          factCheck: {
            corrections: factCheck.corrections,
            protectedFacts: factCheck.protectedFacts,
            hardConstraints: factCheck.hardConstraints,
          },
        }
      : {}),
  };
  return {
    ...sourceWithoutHash,
    sourceHash: computeBriefSourceHash(sourceWithoutHash),
  };
}

function buildBriefCompilerInputV31(
  input: BriefCompilerInputV1,
): BriefCompilerInputV31 {
  const immutableEnvelope = buildBriefImmutableEnvelopeV31(input);
  return {
    ...input,
    schemaVersion: 2,
    immutableEnvelope,
  };
}

function buildBriefCompilerInputV32(
  input: BriefCompilerInputV1,
): BriefCompilerInputV32 {
  const immutableEnvelope = buildBriefImmutableEnvelopeV32(input);
  return {
    ...input,
    schemaVersion: 3,
    briefPolicyVersion: 3,
    immutableEnvelope,
  };
}

/** Current Brief uses short local aliases instead of long audit IDs. */
function buildBriefCompilerInputV33(
  input: BriefCompilerInputV1,
): BriefCompilerInputV33 {
  const aliases = new Map<string, string>();
  const aliasFor = (source: string, prefix: 'R' | 'F'): string => {
    const existing = aliases.get(source);
    if (existing) return existing;
    const next = [
      ...aliases.values(),
    ].filter(value => value.startsWith(prefix)).length + 1;
    const alias = `${prefix}${next}`;
    aliases.set(source, alias);
    return alias;
  };
  const mapItem = (item: any, prefix: 'R' | 'F') => ({
    ...item,
    sourceId: aliasFor(String(item.sourceId || ''), prefix),
  });
  const sourceWithoutHash: Omit<BriefCompilerInputV1, 'sourceHash'> = {
    schemaVersion: 1,
    workflowMode: 'full',
    ...(input.review
      ? {
          review: {
            ...input.review,
            executableCorrections: input.review.executableCorrections.map(item =>
              mapItem(item, 'R'),
            ),
            unlocatedRequired: input.review.unlocatedRequired.map(item =>
              mapItem(item, 'R'),
            ),
          },
        }
      : {}),
    ...(input.factCheck
      ? {
          factCheck: {
            ...input.factCheck,
            corrections: input.factCheck.corrections.map(item =>
              mapItem(item, 'F'),
            ),
          },
        }
      : {}),
  };
  const sourceHash = computeBriefSourceHash(sourceWithoutHash);
  const base: BriefCompilerInputV1 = { ...sourceWithoutHash, sourceHash };
  return {
    ...base,
    workflowMode: 'full',
    schemaVersion: 4,
    briefPolicyVersion: 4,
    immutableEnvelope: buildBriefImmutableEnvelopeV33(base),
  };
}

async function actionRunBrief(
  taskId: string,
  chapter: Chapter,
  onStageUpdate: ReconcileOptions['onStageUpdate'],
  abortSignal: AbortSignal | undefined,
  options: ReconcileOptions,
): Promise<void> {
  if (cancelled(taskId, options)) return;
  const claim = await executeClaimedStage({
    taskId,
    stage: 'brief',
    countAttempt: false,
    abortSignal,
    isCancelled: () => cancelled(taskId, options),
    onClaimed: async () => {
      const store = usePipelineTaskStore.getState();
      if (store.persistTaskStatus)
        await store.persistTaskStatus(taskId, 'briefing');
      else store.setTaskStatus(taskId, 'briefing');
      onStageUpdate?.({
        stage: 'brief',
        label: '正在整理终稿写作要求',
        startedAt: Date.now(),
      });
    },
    run: async () => {
      const runtime = await loadRuntime(taskId, chapter);
      if (!runtime.parsed?.execution) throw new Error('缺少冻结上下文');
      const start = Date.now();
      const inputBase = buildBriefCompilerInput(
        runtime,
        await getStageText(taskId, 'review'),
        await getStageText(taskId, 'factCheck'),
      );
      const v31 = isV31Profile(runtime);
      const v32 = isV32Profile(runtime);
      const v33 = isV33Profile(runtime);
      const input:
        | BriefCompilerInputV1
        | BriefCompilerInputV31
        | BriefCompilerInputV32
        | BriefCompilerInputV33 = v33
        ? buildBriefCompilerInputV33(inputBase)
        : v32
        ? buildBriefCompilerInputV32(inputBase)
        : v31
        ? buildBriefCompilerInputV31(inputBase)
        : inputBase;
      const decision =
        v33 || v32 || v31
          ? {
              callApi: true,
              reason: v33
                ? '当前 Brief primary 必须调用 API'
                : v32
                ? 'V3.2 Brief primary is mandatory'
                : 'V3.1 Final path requires Brief API',
            }
          : shouldCallBriefCompiler(inputBase);
      const fallback = () => compileDeterministicBrief(inputBase);
      const persistLocal = async (
        brief:
          | FinalWritingBriefV1
          | FinalWritingBriefV31
          | FinalWritingBriefV32
          | FinalWritingBriefV33,
        warnings: string[],
        tokens?: {
          input: number;
          output: number;
          total: number;
          reasoning?: number;
          visible?: number;
        },
      ) => {
        await persistStage(taskId, {
          stage: 'brief',
          text: JSON.stringify(brief),
          status: 'success',
          warnings: warnings || [
            v33
              ? '当前 Brief 合同/API 失败，已阻断终稿'
              : v32
              ? 'Brief V3.2 合同/API 失败，已阻断终稿'
              : v31
              ? 'Brief V3.1 合同/API 失败，已阻断终稿'
              : 'Brief 合同/API 失败，已阻断终稿',
          ],
          tokens,
          durationMs: Date.now() - start,
        });
      };
      const persistBriefFailure = async (
        error: string,
        tokens?: {
          input: number;
          output: number;
          total: number;
          reasoning?: number;
          visible?: number;
        },
        warnings?: string[],
      ) => {
        // Once the API Brief has been admitted and returned an invalid or
        // failed result, a local fallback is not equivalent evidence.  The
        // state machine must stop before Final and expose a restart-from-Brief
        // action so an unverified Final can never be adopted silently.
        await persistStage(taskId, {
          stage: 'brief',
          text: '',
          status: 'failed',
          error,
          warnings,
          tokens,
          durationMs: Date.now() - start,
        });
      };

      if (!decision.callApi) {
        await persistLocal(fallback(), [
          '本地确定性 Brief（简单合同，无 API）',
        ]);
        return;
      }

      const compiled = compileBriefStageRequest({
        input,
        contextWindow: runtime.requestConfig.context_window || 0,
        modelMaxOutputTokens: runtime.requestConfig.max_output_tokens,
        visibleOutputFloor: runtime.parsed.execution.briefVisibleOutputFloor,
        reasoningHeadroom: runtime.parsed.execution.briefReasoningHeadroom,
        requestMaxTokens: runtime.parsed.execution.briefMaxTokens,
      });
      if (!compiled.ready) {
        if (v31 || v32 || v33) {
          await persistBriefFailure(
            `Brief ${v33 ? '当前协议' : v32 ? 'V3.2' : 'V3.1'} 上下文窗口不足，已阻断终稿：${
              compiled.error?.message || '无法编译请求'
            }`,
          );
        } else {
          await persistLocal(fallback(), [
            'Brief API 因上下文窗口不足未调用，已使用本地 Brief；Thinking 未被静默关闭',
          ]);
        }
        return;
      }

      // The checkpoint claim above is deliberately not an API attempt: a
      // simple/local Brief must remain attempt_count=0. Count exactly one
      // attempt only after the API budget gate has admitted the request.
      await db.upsertStageCheckpoint({
        taskId,
        stage: 'brief',
        status: 'running',
        startedAt: start,
        bumpAttempt: true,
      });
      const briefAttemptNo =
        (await getStageAttempts(taskId, 'brief')).length + 1;

      const briefReasoning = stageReasoning(runtime, 'brief');
      const briefThinking = v31
        ? ('disabled' as const)
        : (briefReasoning?.thinking?.type || 'enabled');
      const briefEffort = v31 ? undefined : briefReasoning?.effort || 'low';
      const semantics = {
        thinking: briefThinking,
        reasoningEffort: briefEffort,
        reasoningPolicyVersion: v33 ? 5 : v32 ? 4 : v31 ? 2 : 1,
      };
      const frozenRequestJson = JSON.stringify({
        requestVersion: v33 ? 33 : v32 ? 32 : v31 ? 31 : 1,
        sourceHash: input.sourceHash,
        thinking: briefThinking,
        reasoningEffort: briefEffort || null,
        visibleOutputFloor: compiled.budget.visibleOutputFloor,
        reasoningHeadroom: compiled.budget.reasoningHeadroom,
        maxTokens: compiled.reservedOutputTokens,
        immutableEnvelope: v33
          ? (input as BriefCompilerInputV33).immutableEnvelope
          : v32
          ? (input as BriefCompilerInputV32).immutableEnvelope
          : v31
          ? (input as BriefCompilerInputV31).immutableEnvelope
          : undefined,
        elasticBudgetTrace: compiled.elasticBudgetTrace || null,
        messagesHash: sha256Hex(JSON.stringify(compiled.messages)).slice(0, 32),
      });
      const runBriefContractFormatter = async (
        invalid: LLMResult,
      ): Promise<LLMResult> => {
        if (!v31 && !v32 && !v33)
          throw new Error('Brief Contract Formatter 仅适用于结构化流水线');
        const selection = selectStructuredCandidate({
          result: invalid,
          expectedRootKeys: v33
            ? ['strategy', 'actions', 'preserve', 'ending']
            : v32
            ? [
                'verdict',
                'instructions',
                'openingContinuity',
                'styleAdvisories',
              ]
            : [
                'schemaVersion',
                'coveredRequiredIds',
                'openingContinuity',
                'mustFix',
              ],
          findingKeys: ['instructions', 'mustFix'],
        });
        const prompt = buildBriefContractFormatterPrompt({
          candidate:
            selection.candidate?.text ||
            invalid.text?.trim() ||
            invalid.reasoningText?.trim() ||
            '',
          envelope: v33
            ? (input as BriefCompilerInputV33).immutableEnvelope
            : v32
            ? (input as BriefCompilerInputV32).immutableEnvelope
            : (input as BriefCompilerInputV31).immutableEnvelope,
          contractVersion: v33 ? 33 : v32 ? 32 : 31,
        });
        const reservedOutputTokens = Math.min(
          1536,
          Math.max(768, Math.floor(compiled.reservedOutputTokens)),
        );
        const ready = {
          ready: true as const,
          stage: 'brief' as const,
          messages: prompt.messages,
          estimatedInputTokens: estimateTokens(
            prompt.messages.map(message => message.content).join('\n'),
          ),
          reservedOutputTokens,
          safetyMargin: 128,
          contextWindow: runtime.requestConfig.context_window || 0,
          allocations: [],
        } as ReadyStageRequest;
        return runStageAttempt({
          taskId,
          stage: 'brief',
          requestVersion: v33 ? 33 : v32 ? 32 : 31,
          requestFingerprint: stageFingerprint('brief', ready, {
            thinking: 'disabled',
            reasoningPolicyVersion: v33 ? 5 : v32 ? 4 : 3,
          }),
          allocationTraceJson: JSON.stringify({ formatter: true }),
          frozenRequestJson: JSON.stringify({
            requestVersion: v33 ? 33 : v32 ? 32 : 31,
            formatter: true,
            thinking: 'disabled',
            legalSourceIds: prompt.legalSourceIds,
            messagesHash: sha256Hex(JSON.stringify(prompt.messages)).slice(
              0,
              32,
            ),
          }),
          llmConfigId: llmConfigIdOf(runtime.requestConfig),
          llmConfigSnapshotJson: llmConfigSnapshotJson(runtime.requestConfig),
          batchBudgetGate: options.batchBudgetGate,
          estimatedInputTokens: ready.estimatedInputTokens,
          reservedOutputTokens,
          formatterUsed: true,
          persistReasoningContentTemp: true,
          persistResponseCandidateTemp: true,
          run: () =>
            callReadyLLM(
              ready,
              reservedOutputTokens,
              buildStructuredAuditCallConfig(
                null,
                reservedOutputTokens,
                'pipeline_brief_formatter',
                chapter.project_id,
                runtime.requestConfig,
                taskId,
                { supported: false, historical: false },
              ),
              abortSignal,
            ),
        });
      };
      let callTokens = {
        input: 0,
        output: 0,
        total: 0,
        reasoning: 0,
        visible: 0,
      };
      try {
        const firstResult = await runStageAttempt({
          taskId,
          stage: 'brief',
          requestVersion: v33 ? 33 : v32 ? 32 : v31 ? 31 : 1,
          requestFingerprint: stageFingerprint(
            'brief',
            compiled as unknown as ReadyStageRequest,
            semantics,
          ),
          allocationTraceJson: compiled.elasticBudgetTrace
            ? JSON.stringify({
                ...compiled.elasticBudgetTrace,
                visibleOutputFloor: compiled.budget.visibleOutputFloor,
                reasoningHeadroom: compiled.budget.reasoningHeadroom,
              })
            : null,
          frozenRequestJson,
          llmConfigId: llmConfigIdOf(runtime.requestConfig),
          llmConfigSnapshotJson: llmConfigSnapshotJson(runtime.requestConfig),
          batchBudgetGate: options.batchBudgetGate,
          estimatedInputTokens: compiled.estimatedInputTokens,
          reservedOutputTokens: compiled.reservedOutputTokens,
          formatterUsed: false,
          persistReasoningContentTemp: v31,
          persistResponseCandidateTemp: v31 || v32 || v33,
          run: () =>
            callReadyLLM(
              compiled as unknown as ReadyStageRequest,
              compiled.reservedOutputTokens,
              {
                ...buildCallConfig(
                  null,
                  compiled.reservedOutputTokens,
                  'pipeline_brief',
                  chapter.project_id,
                  runtime.requestConfig,
                  taskId,
                  {
                    responseFormat: 'json_object',
                    thinking: { type: briefThinking },
                    ...(briefEffort ? { reasoningEffort: briefEffort } : {}),
                  },
                ),
                temperature: 0.1,
                top_p: 1,
              },
              abortSignal,
            ),
        });
        callTokens = accumulateTokens(callTokens, firstResult);
        let briefSelection: ReturnType<typeof selectStructuredCandidate> = {
          candidate: null,
          responseChannel: 'empty',
          rejected: [],
        };
        const validateBriefResult = (value: LLMResult) => {
          briefSelection = selectStructuredCandidate({
            result: value,
            expectedRootKeys: v33
              ? ['strategy', 'actions', 'preserve', 'ending']
              : v32
              ? [
                  'verdict',
                  'instructions',
                  'openingContinuity',
                  'styleAdvisories',
                ]
              : v31
              ? [
                  'schemaVersion',
                  'coveredRequiredIds',
                  'openingContinuity',
                  'mustFix',
                ]
              : [
                  'schemaVersion',
                  'sourceHash',
                  'coveredRequiredIds',
                  'mustFix',
                ],
            findingKeys: ['instructions', 'mustFix'],
          });
          const raw =
            briefSelection.candidate?.text ||
            value.text ||
            value.reasoningText ||
            '';
          if (v33) {
            return validateFinalWritingBriefV33({
              raw,
              envelope: (input as BriefCompilerInputV33).immutableEnvelope,
            });
          }
          if (v32) {
            return validateFinalWritingBriefV32({
              raw,
              envelope: (input as BriefCompilerInputV32).immutableEnvelope,
            });
          }
          if (v31) {
            return validateFinalWritingBriefV31({
              raw,
              envelope: (input as BriefCompilerInputV31).immutableEnvelope,
              compatibility: structuredOutputCompatibilityForConfig(
                runtime.requestConfig,
              ),
            });
          }
          return validateFinalWritingBrief({
            raw,
            input: input as BriefCompilerInputV1,
          });
        };
        let result = firstResult;
        let validation = validateBriefResult(result);
        logPipelineAudit({
          stage: 'brief',
          attempt: briefAttemptNo,
          valid: validation.valid,
          textLength: result.text?.length || 0,
          ...auditObservation(result),
          taskId,
        });
        if (
          (v31 || v32 || v33) &&
          !validation.valid &&
          (briefSelection.candidate ||
            result.reasoningText?.trim() ||
            result.text?.trim()) &&
          result.finishReason !== 'content_filter'
        ) {
          await updateLatestAttemptDiagnostics(taskId, 'brief', {
            parseFailureCode: validation.error || 'BRIEF_SCHEMA_INVALID',
            validationDetailsJson: validationDetailsJson({
              validation,
              selection: briefSelection,
              formatterEligible: true,
              formatterDecision: 'formatter_started',
            }),
          });
          result = await runBriefContractFormatter(firstResult);
          callTokens = accumulateTokens(callTokens, result);
          validation = validateBriefResult(result);
          logPipelineAudit({
            stage: 'brief',
            attempt: briefAttemptNo + 1,
            valid: validation.valid,
            textLength: result.text?.length || 0,
            ...auditObservation(result),
            taskId,
          });
        }
        await updateLatestAttemptDiagnostics(taskId, 'brief', {
          parseFailureCode: validation.valid ? null : 'BRIEF_SCHEMA_INVALID',
          ...(validation.valid
            ? {}
            : {
                failureClass: 'response_invalid' as const,
                errorCode: PIPELINE_RESPONSE_INVALID_ERROR_CODE,
                errorMessage: `Brief ${v33 ? '当前协议' : v32 ? 'V3.2' : 'V3.1'} 结构化合同无效：${
                  validation.error || '未知原因'
                }`,
              }),
          responseCandidateChannel:
            briefSelection.responseChannel !== 'empty'
              ? briefSelection.responseChannel
              : null,
          validationDetailsJson: validationDetailsJson({
            validation,
            selection: briefSelection,
            formatterEligible:
              Boolean(briefSelection.candidate) ||
              Boolean(result.text?.trim() || result.reasoningText?.trim()),
            formatterDecision:
              result === firstResult
                ? 'primary_contract'
                : 'formatter_succeeded_or_failed',
          }),
          clearReasoning: true,
        });
        if (validation.valid && validation.brief) {
          await persistLocal(
            validation.brief,
            [
              v33
                ? `Brief Compiler（Thinking enabled + ${briefEffort || 'low'}；简化合同）`
                : v31
                ? 'Brief Compiler（Thinking disabled，优先输出 content 合同）'
                : v32
                ? 'Brief Compiler V3.2（Thinking enabled + low）'
                : 'Brief Compiler（Thinking enabled + low）',
              ...(result === firstResult
                ? []
                : ['Contract Formatter（Thinking disabled）']),
              ...(validation.warnings || []),
            ],
            {
              ...callTokens,
            },
          );
          return;
        }
        await persistBriefFailure(
          `Brief API 输出未通过完整性门禁，已阻断终稿：${
            validation.error || '未知原因'
          }`,
          callTokens,
        );
      } catch (error: any) {
        if (isAbortError(error, abortSignal)) {
          await settleInterruptedTask(taskId, options);
          await PipelineForeground.stop(taskId);
          throw error;
        }
        if (error instanceof BatchBudgetExceededError) throw error;
        await persistBriefFailure(
          `Brief API 调用失败，已阻断终稿：${getErrorMessage(
            error,
            '未知错误',
          )}`,
          callTokens,
        );
      }
    },
  });
  if (!claim.claimed) {
    throw Object.assign(new Error('任务已在运行'), {
      code: 'TASK_ALREADY_RUNNING',
    });
  }
}

/**
 * V5-Lite V2 Final Reviser stage (§11–§12):
 *   persisted draft → canonical + anchors → parse V2 audits → compile
 *   revision contract (0 LLM) → Final Reviser request (contract first,
 *   full draft second) → Local Final Artifact Validator before success
 *   persist. request_version=2 recorded on attempts (§13).
 *
 * Fail-closed (§10.6): when both audit sides are invalid, no proof request
 * is issued and the task degrades to draft fallback (existing semantics).
 */
async function runFinalReviserV2Stage(params: {
  taskId: string;
  chapter: Chapter;
  runtime: Awaited<ReturnType<typeof loadRuntime>>;
  abortSignal?: AbortSignal;
  options: ReconcileOptions;
}): Promise<void> {
  const { taskId, chapter, runtime, abortSignal, options } = params;
  if (!runtime.parsed?.execution) throw new Error('缺少冻结上下文');
  const draftText = await getDraftText(taskId);
  const canonicalDraft = canonicalizeDraft(draftText);
  const anchors = buildRevisionAnchors(canonicalDraft);
  const ctxSnap =
    runtime.config.pipelineMode === 'full'
      ? auditSnapshot(runtime.parsed)
      : runtime.parsed.draftContext;
  const constraints = buildProofConstraintsFromSnapshot(ctxSnap);
  const start = Date.now();
  const tokens = { input: 0, output: 0, total: 0 };

  // Parse persisted V2 audit reports (already normalized by the validator).
  const reviewText = await getStageText(taskId, 'review');
  const factCheckText = await getStageText(taskId, 'factCheck');
  const parseV2 = (raw: string) => {
    if (!raw || !raw.trim()) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.schemaVersion === 2) {
        return parsed as PipelineReviewReportV2 | PipelineFactCheckReportV2;
      }
      return null;
    } catch {
      return null;
    }
  };
  const reviewV2 = reviewText
    ? (parseV2(reviewText) as PipelineReviewReportV2 | null)
    : null;
  const factV2 = factCheckText
    ? (parseV2(factCheckText) as PipelineFactCheckReportV2 | null)
    : null;

  const compiledContract = compileRevisionContract({
    canonicalDraft,
    anchors,
    review: reviewV2,
    factCheck: factV2,
  });
  if (!compiledContract.ok) {
    // Both audit sides invalid → draft fallback, proof never fires (§10.6).
    await persistStage(taskId, {
      stage: 'proof',
      text: draftText,
      status: 'failed',
      error: '修订合同构建失败（审核报告均无法使用），已回退到初稿',
      durationMs: Date.now() - start,
    });
    return;
  }
  const contractJson = JSON.stringify(compiledContract.contract);

  const compiled = compileFinalReviserStageRequest({
    contractJson,
    workItemCount: compiledContract.contract.workItems.length,
    canonicalDraft,
    constraints,
    maxTokens: runtime.config.proofMaxTokens,
    contextWindow: runtime.requestConfig.context_window || 0,
  });
  if (!compiled.ready) {
    await persistStage(taskId, {
      stage: 'proof',
      text: draftText,
      status: 'failed',
      error: compiled.error.message,
      durationMs: Date.now() - start,
    });
    return;
  }

  const reasoning = resolveFinalReviserReasoning({
    execution: runtime.parsed.execution,
    model: runtime.requestConfig,
    contract: compiledContract.contract,
  });
  const proofSemantics = {
    thinking: reasoning.thinking?.type,
    reasoningEffort: reasoning.effort,
    reasoningPolicyVersion: reasoning.policyVersion,
  } as const;
  const frozenProofRequest = JSON.stringify({
    requestVersion: 2,
    reasoningPolicyVersion: reasoning.policyVersion ?? 1,
    thinking: reasoning.thinking?.type ?? 'omitted',
    reasoningEffort: reasoning.effort ?? null,
    messagesHash: sha256Hex(JSON.stringify(compiled.messages)).slice(0, 32),
    maxTokens: runtime.config.proofMaxTokens,
    contextWindow: compiled.contextWindow,
  });

  try {
    const result = await runStageAttempt({
      taskId,
      stage: 'proof',
      requestVersion: 2,
      requestFingerprint: stageFingerprint('proof', compiled, proofSemantics),
      allocationTraceJson: compiled.elasticBudgetTrace
        ? JSON.stringify(compiled.elasticBudgetTrace)
        : null,
      frozenRequestJson: frozenProofRequest,
      llmConfigId: llmConfigIdOf(runtime.requestConfig),
      llmConfigSnapshotJson: llmConfigSnapshotJson(runtime.requestConfig),
      batchBudgetGate: options.batchBudgetGate,
      estimatedInputTokens: compiled.estimatedInputTokens,
      reservedOutputTokens: compiled.reservedOutputTokens,
      run: () =>
        callReadyLLM(
          compiled,
          runtime.config.proofMaxTokens,
          buildCallConfig(
            runtime.proofPreset,
            runtime.config.proofMaxTokens,
            'pipeline_proof',
            chapter.project_id,
            runtime.requestConfig,
            taskId,
            {
              thinking: reasoning.thinking,
              reasoningEffort: reasoning.effort,
            },
          ),
          abortSignal,
        ),
    });
    if (cancelled(taskId, options)) {
      const err = new Error('任务已取消') as Error & { code?: string };
      err.code = 'cancelled';
      throw err;
    }
    tokens.input += result.inputTokens || 0;
    tokens.output += result.outputTokens || 0;
    tokens.total += result.totalTokens || 0;

    const content =
      typeof result.text === 'string' && result.text.trim().length > 0
        ? result.text
        : null;
    if (!content) {
      const hasReasoning =
        typeof result.reasoningText === 'string' &&
        result.reasoningText.trim().length > 0;
      await persistStage(taskId, {
        stage: 'proof',
        text: draftText,
        status: 'failed',
        error: hasReasoning
          ? '终稿仅返回推理内容，已回退到初稿'
          : '终稿输出为空，已回退到初稿',
        tokens: {
          input: result.inputTokens,
          output: result.outputTokens,
          total: result.totalTokens,
        },
        durationMs: Date.now() - start,
      });
      return;
    }

    // Local Final Artifact Validator (§12): 0 LLM, no attempt, before the
    // proof checkpoint is persisted as success. Fail → draft fallback.
    const validator = validateFinalArtifact({
      text: content,
      reasoningText: result.reasoningText,
      finishReason: result.finishReason,
      canonicalDraft,
      contractJson,
    });
    if (!validator.valid) {
      await persistStage(taskId, {
        stage: 'proof',
        text: draftText,
        status: 'failed',
        error: `终稿本地校验未通过（${validator.code}），已回退到初稿`,
        tokens: {
          input: result.inputTokens,
          output: result.outputTokens,
          total: result.totalTokens,
        },
        durationMs: Date.now() - start,
      });
      return;
    }

    await persistStage(taskId, {
      stage: 'proof',
      text: content,
      status: 'success',
      warnings: [...compiledContract.warnings, ...(validator.warnings || [])],
      tokens: {
        input: result.inputTokens,
        output: result.outputTokens,
        total: result.totalTokens,
      },
      durationMs: Date.now() - start,
    });
  } catch (error: any) {
    if (isAbortError(error, abortSignal)) {
      await settleInterruptedTask(taskId, options);
      await PipelineForeground.stop(taskId);
      throw error;
    }
    if (error instanceof BatchBudgetExceededError) {
      throw error;
    }
    await persistStage(taskId, {
      stage: 'proof',
      text: draftText,
      status: 'failed',
      error: getErrorMessage(error, '终审失败，已回退到初稿'),
      durationMs: Date.now() - start,
    });
  }
}

async function runFinalReviserV3Stage(params: {
  taskId: string;
  chapter: Chapter;
  runtime: Awaited<ReturnType<typeof loadRuntime>>;
  abortSignal?: AbortSignal;
  options: ReconcileOptions;
}): Promise<void> {
  const { taskId, chapter, runtime, abortSignal, options } = params;
  if (!runtime.parsed?.execution) throw new Error('缺少冻结上下文');
  const draftText = await getDraftText(taskId);
  const canonicalDraft = canonicalizeDraft(draftText);
  const briefText = await getStageText(taskId, 'brief');
  const v31 = isV31Profile(runtime);
  const v32 = isV32Profile(runtime);
  const v33 = isV33Profile(runtime);
  let brief:
    | FinalWritingBriefV1
    | FinalWritingBriefV31
    | FinalWritingBriefV32
    | FinalWritingBriefV33
    | null = null;
  try {
    const parsed = JSON.parse(briefText) as
      | FinalWritingBriefV1
      | FinalWritingBriefV31
      | FinalWritingBriefV32
      | FinalWritingBriefV33;
    if (
      parsed &&
      parsed.schemaVersion === (v33 ? 4 : v32 ? 3 : v31 ? 2 : 1)
    )
      brief = parsed;
  } catch {
    brief = null;
  }
  if ((v31 || v32 || v33) && brief) {
    const briefInputBase = buildBriefCompilerInput(
      runtime,
      await getStageText(taskId, 'review'),
      await getStageText(taskId, 'factCheck'),
    );
    const validated = v33
      ? validateFinalWritingBriefV33({
          raw: briefText,
          envelope:
            buildBriefCompilerInputV33(briefInputBase).immutableEnvelope,
        })
      : v32
      ? validateFinalWritingBriefV32({
          raw: briefText,
          envelope:
            buildBriefCompilerInputV32(briefInputBase).immutableEnvelope,
        })
      : validateFinalWritingBriefV31({
          raw: briefText,
          envelope:
            buildBriefCompilerInputV31(briefInputBase).immutableEnvelope,
          compatibility: structuredOutputCompatibilityForConfig(
            runtime.requestConfig,
          ),
        });
    brief = validated.valid ? validated.brief || null : null;
  }
  if (!brief) {
    await persistStage(taskId, {
      stage: 'proof',
      text: '',
      status: 'failed',
      error: 'Final V3 缺少有效 Brief，请从失败节点重试',
      errorCode: FINAL_PROOF_RETRY_REQUIRED_ERROR_CODE,
      durationMs: 0,
    });
    return;
  }
  const draftSnapshot = runtime.parsed.draftContext;
  const sourceSnapshot = runtime.parsed.auditContext || draftSnapshot;
  const baseCapsule = buildFinalContinuityCapsule({
    ...sourceSnapshot,
    // Immediate previous chapter is a Draft-time mandatory seam. Audit
    // retrieval may intentionally replace optional modules but never it.
    outlineText: draftSnapshot.outlineText,
    immediatePreviousChapterText: draftSnapshot.immediatePreviousChapterText,
    immediatePreviousChapterEnding:
      draftSnapshot.immediatePreviousChapterEnding,
    immediatePreviousChapterId: draftSnapshot.immediatePreviousChapterId,
    immediatePreviousChapterPosition:
      draftSnapshot.immediatePreviousChapterPosition,
  });
  const derivedInstruction = String(
    usePipelineTaskStore.getState().tasks.find(item => item.id === taskId)
      ?.derivedInstruction || '',
  ).trim();
  const capsule = derivedInstruction
    ? {
        ...baseCapsule,
        currentInstructionText: [
          baseCapsule.currentInstructionText,
          '【用户补充的终稿修订要求｜优先级低于 Brief 硬约束与事实边界】',
          derivedInstruction,
        ]
          .filter(Boolean)
          .join('\n'),
      }
    : baseCapsule;
  const writingBrief = renderFinalWritingBrief(brief);
  const maxTokens = stageMaxTokens(
    runtime,
    'proof',
    runtime.config.proofMaxTokens,
  );
  const compiled = compileFinalReviserV3StageRequest({
    writingBrief,
    canonicalDraft,
    capsule,
    maxTokens,
    contextWindow: runtime.requestConfig.context_window || 0,
    modelMaxOutputTokens: runtime.requestConfig.max_output_tokens,
    elasticBudget: isElasticBudgetEnabled(runtime),
  });
  const start = Date.now();
  if (!compiled.ready) {
    await persistStage(taskId, {
      stage: 'proof',
      text: '',
      status: 'failed',
      error: `${compiled.error.message}；请从失败节点重试`,
      errorCode: FINAL_PROOF_RETRY_REQUIRED_ERROR_CODE,
      durationMs: Date.now() - start,
    });
    return;
  }
  const reasoning = stageReasoning(runtime, 'proof');
  const semantics = {
    thinking: reasoning?.thinking?.type,
    reasoningEffort: reasoning?.effort,
    reasoningPolicyVersion: v33 ? 5 : v32 ? 4 : 3,
  } as const;
  const runProofAttempt = (request: ReadyStageRequest, repairPass: number) =>
    runStageAttempt({
      taskId,
      stage: 'proof',
      requestVersion: v33 ? 33 : v32 ? 32 : 3,
      requestFingerprint: stageFingerprint('proof', request, semantics),
      allocationTraceJson: JSON.stringify(request.allocations),
      frozenRequestJson: JSON.stringify({
        requestVersion: v33 ? 33 : v32 ? 32 : 3,
        thinking: semantics.thinking || 'omitted',
        reasoningEffort: semantics.reasoningEffort || null,
        messagesHash: sha256Hex(JSON.stringify(request.messages)).slice(0, 32),
        maxTokens: request.reservedOutputTokens,
        visibleFinalFloor: Math.max(
          1024,
          Math.ceil(estimateTokens(canonicalDraft) * 1.2) + 256,
        ),
        contextWindow: request.contextWindow,
        continuityRepairPass: repairPass,
      }),
      llmConfigId: llmConfigIdOf(runtime.requestConfig),
      llmConfigSnapshotJson: llmConfigSnapshotJson(runtime.requestConfig),
      batchBudgetGate: options.batchBudgetGate,
      estimatedInputTokens: request.estimatedInputTokens,
      reservedOutputTokens: request.reservedOutputTokens,
      persistReasoningContentTemp: v31,
      run: () =>
        callReadyLLM(
          request,
          request.reservedOutputTokens,
          buildCallConfig(
            runtime.proofPreset,
            request.reservedOutputTokens,
            'pipeline_proof',
            chapter.project_id,
            runtime.requestConfig,
            taskId,
            {
              thinking: reasoning?.thinking,
              reasoningEffort: reasoning?.effort,
            },
          ),
          abortSignal,
        ),
    });
  try {
    if (v31 || v32 || v33) {
      // V3.1 Final is exactly one model call. The local checks below are a
      // hard gate only; a failed result is persisted for manual retry from
      // Proof and is never repaired by a hidden second Final call.
      const result = await runProofAttempt(compiled, 0);
      const tokens = tokenBreakdown(result);
      const content =
        typeof result.text === 'string' && result.text.trim().length > 0
          ? result.text
          : null;
      if (!content) {
        await updateLatestAttemptDiagnostics(taskId, 'proof', {
          parseFailureCode: result.reasoningText?.trim()
            ? 'FINAL_REASONING_ONLY'
            : 'FINAL_EMPTY_CONTENT',
          failureClass: 'response_invalid',
          errorCode: PIPELINE_RESPONSE_INVALID_ERROR_CODE,
          errorMessage: result.reasoningText?.trim()
            ? '终稿仅返回 reasoning_content，未产生 message.content'
            : '终稿 content 为空',
          clearReasoning: true,
        });
        await persistStage(taskId, {
          stage: 'proof',
          text: '',
          status: 'failed',
          error: result.reasoningText?.trim()
            ? '终稿仅返回 reasoning_content，已阻断；请从失败节点重试'
            : '终稿输出为空，已阻断；请从失败节点重试',
          errorCode: FINAL_PROOF_RETRY_REQUIRED_ERROR_CODE,
          tokens,
          durationMs: Date.now() - start,
        });
        return;
      }
      const validator = validateFinalArtifact({
        text: content,
        reasoningText: result.reasoningText,
        finishReason: result.finishReason,
        canonicalDraft,
      });
      if (!validator.valid) {
        await updateLatestAttemptDiagnostics(taskId, 'proof', {
          parseFailureCode: `FINAL_ARTIFACT_${validator.code}`,
          failureClass: 'response_invalid',
          errorCode: PIPELINE_RESPONSE_INVALID_ERROR_CODE,
          errorMessage: `终稿本地校验未通过（${validator.code}）`,
          clearReasoning: true,
        });
        await persistStage(taskId, {
          stage: 'proof',
          text: '',
          status: 'failed',
          error: `终稿本地校验未通过（${validator.code}），请从失败节点重试`,
          errorCode: FINAL_PROOF_RETRY_REQUIRED_ERROR_CODE,
          tokens,
          durationMs: Date.now() - start,
        });
        return;
      }
      const compliance = validateFinalBriefCompliance({ text: content, brief });
      if (!compliance.valid) {
        await updateLatestAttemptDiagnostics(taskId, 'proof', {
          parseFailureCode: `FINAL_${compliance.code}`,
          failureClass: 'response_invalid',
          errorCode: PIPELINE_RESPONSE_INVALID_ERROR_CODE,
          errorMessage: `终稿连续性硬门禁未通过（${compliance.code}）`,
          clearReasoning: true,
        });
        await persistStage(taskId, {
          stage: 'proof',
          text: '',
          status: 'failed',
          error: `终稿连续性硬门禁未通过（${compliance.code}），请从失败节点重试`,
          errorCode: FINAL_PROOF_RETRY_REQUIRED_ERROR_CODE,
          tokens,
          durationMs: Date.now() - start,
        });
        return;
      }
      await updateLatestAttemptDiagnostics(taskId, 'proof', {
        parseFailureCode: null,
        clearReasoning: true,
      });
      await persistStage(taskId, {
        stage: 'proof',
        text: content,
        status: 'success',
        warnings: validator.warnings,
        tokens,
        durationMs: Date.now() - start,
      });
      return;
    }
    let request: ReadyStageRequest = compiled;
    let repairPass = 0;
    let acceptedContent: string | null = null;
    let acceptedTokens: ReturnType<typeof tokenBreakdown> | null = null;
    let acceptedWarnings: string[] | undefined;
    while (repairPass <= 1) {
      const result = await runProofAttempt(request, repairPass);
      const content =
        typeof result.text === 'string' && result.text.trim().length > 0
          ? result.text
          : null;
      const tokens = tokenBreakdown(result);
      if (!content) {
        await persistStage(taskId, {
          stage: 'proof',
          text: '',
          status: 'failed',
          error:
            result.reasoningText && result.reasoningText.trim()
              ? '终稿仅返回推理内容，请从失败节点重试'
              : '终稿输出为空，请从失败节点重试',
          errorCode: FINAL_PROOF_RETRY_REQUIRED_ERROR_CODE,
          tokens,
          durationMs: Date.now() - start,
        });
        return;
      }
      const validator = validateFinalArtifact({
        text: content,
        reasoningText: result.reasoningText,
        finishReason: result.finishReason,
        canonicalDraft,
      });
      if (!validator.valid) {
        await persistStage(taskId, {
          stage: 'proof',
          text: '',
          status: 'failed',
          error: `终稿本地校验未通过（${validator.code}），请从失败节点重试`,
          errorCode: FINAL_PROOF_RETRY_REQUIRED_ERROR_CODE,
          tokens,
          durationMs: Date.now() - start,
        });
        return;
      }
      const compliance = validateFinalBriefCompliance({ text: content, brief });
      if (!compliance.valid) {
        console.log(
          `[pipeline-audit] stage=proof taskId=${taskId} continuityGate=failed code=${compliance.code} repairPass=${repairPass}`,
        );
        if (repairPass === 0) {
          const repairBrief = `${writingBrief}\n\n【上一次终稿未通过连续性硬门禁】\n${
            compliance.details || 'Brief 禁止提前推进的内容仍出现在正文中。'
          }\n必须删除包含这些未来信息的完整段落或场景，不得只替换关键词；严格收束在 Brief 的结尾状态，直接输出完整终稿正文。`;
          const repaired = compileFinalReviserV3StageRequest({
            writingBrief: repairBrief,
            canonicalDraft,
            capsule,
            maxTokens,
            contextWindow: runtime.requestConfig.context_window || 0,
            modelMaxOutputTokens: runtime.requestConfig.max_output_tokens,
            elasticBudget: isElasticBudgetEnabled(runtime),
          });
          if (!repaired.ready) {
            await persistStage(taskId, {
              stage: 'proof',
              text: '',
              status: 'failed',
              error: `终稿连续性修复请求无法编译：${repaired.error.message}；请从失败节点重试`,
              errorCode: FINAL_PROOF_RETRY_REQUIRED_ERROR_CODE,
              tokens,
              durationMs: Date.now() - start,
            });
            return;
          }
          request = repaired;
          repairPass += 1;
          continue;
        }
        await persistStage(taskId, {
          stage: 'proof',
          text: '',
          status: 'failed',
          error: `终稿连续性硬门禁未通过（${compliance.code}），请从失败节点重试`,
          errorCode: FINAL_PROOF_RETRY_REQUIRED_ERROR_CODE,
          tokens,
          durationMs: Date.now() - start,
        });
        return;
      }
      console.log(
        `[pipeline-audit] stage=proof taskId=${taskId} continuityGate=passed repairPass=${repairPass}`,
      );
      acceptedContent = content;
      acceptedTokens = tokens;
      acceptedWarnings = validator.warnings;
      break;
    }
    if (!acceptedContent || !acceptedTokens) {
      await persistStage(taskId, {
        stage: 'proof',
        text: '',
        status: 'failed',
        error: '终稿连续性硬门禁未产生可交付正文，请从失败节点重试',
        errorCode: FINAL_PROOF_RETRY_REQUIRED_ERROR_CODE,
        durationMs: Date.now() - start,
      });
      return;
    }
    await persistStage(taskId, {
      stage: 'proof',
      text: acceptedContent,
      status: 'success',
      warnings: acceptedWarnings,
      tokens: acceptedTokens,
      durationMs: Date.now() - start,
    });
  } catch (error: any) {
    if (isAbortError(error, abortSignal)) {
      await settleInterruptedTask(taskId, options);
      await PipelineForeground.stop(taskId);
      throw error;
    }
    if (error instanceof BatchBudgetExceededError) throw error;
    await persistStage(taskId, {
      stage: 'proof',
      text: '',
      status: 'failed',
      error: `${getErrorMessage(error, '终稿失败')}；请从失败节点重试`,
      errorCode: FINAL_PROOF_RETRY_REQUIRED_ERROR_CODE,
      durationMs: Date.now() - start,
    });
  }
}

async function actionRunProof(
  taskId: string,
  chapter: Chapter,
  onStageUpdate: ReconcileOptions['onStageUpdate'],
  abortSignal: AbortSignal | undefined,
  options: ReconcileOptions,
): Promise<void> {
  if (cancelled(taskId, options)) return;

  // Mark skipped counterpart stages before claim (mode-dependent).
  {
    const runtime = await loadRuntime(taskId, chapter);
    if (runtime.config.pipelineMode === 'twoStage') {
      await persistSkipped(taskId, 'factCheck', '仅评估模式已跳过事实核查');
    } else if (runtime.config.pipelineMode === 'conditional') {
      await persistSkipped(taskId, 'review', '仅核查模式已跳过文学评估');
    }
  }

  const claim = await executeClaimedStage({
    taskId,
    stage: 'proof',
    abortSignal,
    isCancelled: () => cancelled(taskId, options),
    onClaimed: async () => {
      const store = usePipelineTaskStore.getState();
      if (store.persistTaskStatus) {
        await store.persistTaskStatus(taskId, 'proofing');
      } else {
        store.setTaskStatus(taskId, 'proofing');
      }
      onStageUpdate?.({
        stage: 'proof',
        label: '正在综合修订',
        startedAt: Date.now(),
      });
    },
    run: async () => {
      const emitForeground = (options.foregroundOwner ?? 'task') === 'task';
      const runtime = await loadRuntime(taskId, chapter);
      if (emitForeground) {
        PipelineForeground.updateProgress(
          taskId,
          '正在综合修订',
          getStageProgressPercent(
            runtime.config.pipelineMode,
            Math.max(
              0,
              getPipelineStageOrder(runtime.config.pipelineMode, {
                outlineWorkflowVersion:
                  runtime.parsed?.execution?.outlineWorkflowVersion,
                contextBudgetVersion:
                  runtime.parsed?.execution?.contextBudgetVersion,
              }).indexOf('proof'),
            ),
            {
              outlineWorkflowVersion:
                runtime.parsed?.execution?.outlineWorkflowVersion,
              contextBudgetVersion:
                runtime.parsed?.execution?.contextBudgetVersion,
            },
          ),
        ).catch(() => {});
      }

      if (isOutlineWorkflowV3(runtime)) {
        await runFinalReviserV3Stage({
          taskId,
          chapter,
          runtime,
          abortSignal,
          options,
        });
        return;
      }
      if (isOutlineWorkflowV2(runtime)) {
        await runFinalReviserV2Stage({
          taskId,
          chapter,
          runtime,
          abortSignal,
          options,
        });
        return;
      }

      if (!runtime.parsed) throw new Error('缺少冻结上下文');
      const draftText = await getDraftText(taskId);
      const reviewText = await getStageText(taskId, 'review');
      const factCheckText = await getStageText(taskId, 'factCheck');
      const ctxSnap =
        runtime.config.pipelineMode === 'full'
          ? auditSnapshot(runtime.parsed)
          : runtime.parsed.draftContext;
      const constraints = buildProofConstraintsFromSnapshot(ctxSnap);
      const start = Date.now();
      const compiled = compileProofStageRequest({
        draftText,
        reviewText,
        factCheckText,
        constraints,
        maxTokens: runtime.config.proofMaxTokens,
        contextWindow: runtime.requestConfig.context_window || 0,
        elasticBudget: isElasticBudgetEnabled(runtime),
      });
      if (!compiled.ready) {
        await persistStage(taskId, {
          stage: 'proof',
          text: draftText,
          status: 'failed',
          error: compiled.error.message,
          durationMs: Date.now() - start,
        });
        return;
      }

      // Phase 3: persist one durable attempt row per LLM call.
      try {
        const result = await runStageAttempt({
          taskId,
          stage: 'proof',
          requestFingerprint: stageFingerprint('proof', compiled),
          allocationTraceJson: compiled.elasticBudgetTrace
            ? JSON.stringify(compiled.elasticBudgetTrace)
            : null,
          llmConfigId: llmConfigIdOf(runtime.requestConfig),
          llmConfigSnapshotJson: llmConfigSnapshotJson(runtime.requestConfig),
          batchBudgetGate: options.batchBudgetGate,
          estimatedInputTokens: compiled.estimatedInputTokens,
          reservedOutputTokens: compiled.reservedOutputTokens,
          run: () =>
            callReadyLLM(
              compiled,
              runtime.config.proofMaxTokens,
              buildCallConfig(
                runtime.proofPreset,
                runtime.config.proofMaxTokens,
                'pipeline_proof',
                chapter.project_id,
                runtime.requestConfig,
                taskId,
              ),
              abortSignal,
            ),
        });
        if (cancelled(taskId, options)) {
          const err = new Error('任务已取消') as Error & { code?: string };
          err.code = 'cancelled';
          throw err;
        }
        const content =
          typeof result.text === 'string' && result.text.trim().length > 0
            ? result.text
            : null;
        if (!content) {
          const hasReasoning =
            typeof result.reasoningText === 'string' &&
            result.reasoningText.trim().length > 0;
          const error = hasReasoning
            ? '终审仅返回推理内容，已回退到初稿'
            : '终审输出为空，已回退到初稿';
          await persistStage(taskId, {
            stage: 'proof',
            text: draftText,
            status: 'failed',
            error,
            tokens: {
              input: result.inputTokens,
              output: result.outputTokens,
              total: result.totalTokens,
            },
            durationMs: Date.now() - start,
          });
          return;
        }
        await persistStage(taskId, {
          stage: 'proof',
          text: content,
          status: 'success',
          tokens: {
            input: result.inputTokens,
            output: result.outputTokens,
            total: result.totalTokens,
          },
          durationMs: Date.now() - start,
        });
      } catch (error: any) {
        if (isAbortError(error, abortSignal)) {
          await settleInterruptedTask(taskId, options);
          await PipelineForeground.stop(taskId);
          throw error;
        }
        // CL-06: budget-blocked requests never mark the stage failed.
        if (error instanceof BatchBudgetExceededError) {
          throw error;
        }
        await persistStage(taskId, {
          stage: 'proof',
          text: draftText,
          status: 'failed',
          error: getErrorMessage(error, '终审失败，已回退到初稿'),
          durationMs: Date.now() - start,
        });
      }
    },
  });

  if (!claim.claimed) {
    throw Object.assign(new Error('任务已在运行'), {
      code: 'TASK_ALREADY_RUNNING',
    });
  }
}

async function saveDraftBody(
  taskId: string,
  chapter: Chapter,
  text: string,
): Promise<void> {
  try {
    await saveDraft({
      projectId: chapter.project_id,
      targetType: chapter.id > 0 ? 'chapter' : 'freeform',
      targetId: chapter.id > 0 ? chapter.id : chapter.project_id,
      content: text,
      source: 'pipeline',
      pipelineTaskId: taskId,
    });
  } catch {
    /* best-effort */
  }
  try {
    const task = usePipelineTaskStore
      .getState()
      .tasks.find(t => t.id === taskId);
    const fpOutline =
      task?.pipelineContextJson != null
        ? parsePersistedPipelineTaskContext(task).draftContext
            .outlineFingerprint
        : '';
    const fingerprint = await computeInputFingerprint({
      projectId: chapter.project_id,
      chapterId: chapter.id,
      chapterUpdatedAt: chapter.updated_at,
      outlineFingerprint: fpOutline,
    });
    usePipelineTaskStore
      .getState()
      .setTaskInputFingerprint(taskId, fingerprint);
  } catch {
    /* */
  }
}

async function actionFinalizeFromDraft(
  taskId: string,
  chapter: Chapter,
  degraded: boolean,
  emitForeground = true,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  const draftText = await getDraftText(taskId);
  const mode = (await loadRuntime(taskId, chapter)).config.pipelineMode;
  if (mode === 'noReview') {
    await persistSkipped(taskId, 'review', '无审核模式已跳过审阅/评估');
    await persistSkipped(taskId, 'factCheck', '无审核模式已跳过事实核查');
    await persistSkipped(taskId, 'brief', '无审核模式已跳过 Brief 整理');
    await persistSkipped(taskId, 'proof', '无审核模式已跳过终审校对');
  } else if (degraded) {
    // Do not leave proof pending — decision already made.
    // Never overwrite an already failed/succeeded proof checkpoint.
    const existingProof =
      store.tasks
        .find(x => x.id === taskId)
        ?.stageResults?.find(s => s.stage === 'proof') || null;
    if (
      !existingProof ||
      (existingProof.status !== 'failed' &&
        existingProof.status !== 'success' &&
        existingProof.status !== 'skipped')
    ) {
      await persistSkipped(taskId, 'proof', '前置阶段失败，未执行终审');
    }
    const existingBrief =
      store.tasks
        .find(x => x.id === taskId)
        ?.stageResults?.find(s => s.stage === 'brief') || null;
    if (
      !existingBrief ||
      (existingBrief.status !== 'failed' &&
        existingBrief.status !== 'success' &&
        existingBrief.status !== 'skipped')
    ) {
      await persistSkipped(taskId, 'brief', '前置阶段失败，未执行 Brief 整理');
    }
  }
  await saveDraftBody(taskId, chapter, draftText);
  if (degraded) {
    const t = store.tasks.find(x => x.id === taskId);
    const reviewFailed = t?.stageResults?.some(
      s => s.stage === 'review' && s.status === 'failed',
    );
    const factFailed = t?.stageResults?.some(
      s => s.stage === 'factCheck' && s.status === 'failed',
    );
    const proofFailed = t?.stageResults?.some(
      s => s.stage === 'proof' && s.status === 'failed',
    );
    let message = t?.error || '审核/终审失败，已保留初稿';
    if (reviewFailed && factFailed) {
      message = '文学评估与事实核查均失败，已保留初稿，未生成终审稿。';
    } else if (reviewFailed && !factFailed) {
      message = '文学评估失败，已保留初稿，未生成终审稿。';
    } else if (factFailed && !reviewFailed) {
      message = '事实核查失败，已保留初稿，未生成终审稿。';
    } else if (proofFailed) {
      message =
        t?.stageResults?.find(s => s.stage === 'proof' && s.status === 'failed')
          ?.error || '终审失败，已保留初稿，未生成终审稿。';
    }
    if (store.persistFailTask) {
      await store.persistFailTask(taskId, message);
    } else {
      store.failTask(taskId, message);
    }
    if (store.persistTaskFinalText) {
      await store.persistTaskFinalText(taskId, draftText);
    } else {
      store.setTaskFinalText(taskId, draftText);
    }
    if (emitForeground) {
      await PipelineForeground.notifyFailed(
        taskId,
        chapter.title || '流水线',
        message,
      );
      await PipelineForeground.updateProgress(taskId, '已保留初稿', 100);
    }
    await PipelineForeground.stop(taskId);
    return;
  }
  if (store.persistTaskFinalText) {
    await store.persistTaskFinalText(taskId, draftText);
  } else {
    store.setTaskFinalText(taskId, draftText);
  }
  // complete happens in next reconcile step (or we can complete now)
  if (store.persistCompleteTask) {
    await store.persistCompleteTask(taskId, draftText);
  } else {
    store.completeTask(taskId, draftText);
  }
  if (emitForeground) {
    await PipelineForeground.updateProgress(taskId, '已完成', 100);
    await PipelineForeground.notifyComplete(
      taskId,
      chapter.title || '流水线',
      '已写完，点击查看',
    );
  }
  await PipelineForeground.stop(taskId);
}

async function actionFinalizeFromProof(
  taskId: string,
  chapter: Chapter,
  emitForeground = true,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  const proofText = await getStageText(taskId, 'proof');
  const text = proofText || (await getDraftText(taskId));
  await saveDraftBody(taskId, chapter, text);
  // Atomically complete with final text (one durable transition).
  if (store.persistCompleteTask) {
    await store.persistCompleteTask(taskId, text);
  } else {
    store.completeTask(taskId, text);
  }
  if (emitForeground) {
    await PipelineForeground.updateProgress(taskId, '已完成', 100);
    await PipelineForeground.notifyComplete(
      taskId,
      chapter.title || '流水线',
      '已写完，点击查看',
    );
  }
  await PipelineForeground.stop(taskId);
}

async function actionComplete(
  taskId: string,
  chapter: Chapter,
  emitForeground = true,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  const task = store.tasks.find(t => t.id === taskId);
  if (task?.status === 'completed') {
    await PipelineForeground.stop(taskId);
    return;
  }
  const text =
    task?.finalText ||
    (await getStageText(taskId, 'proof')) ||
    (await getDraftText(taskId)) ||
    '';
  if (store.persistCompleteTask) {
    await store.persistCompleteTask(taskId, text);
  } else {
    store.completeTask(taskId, text);
  }
  if (emitForeground) {
    await PipelineForeground.updateProgress(taskId, '已完成', 100);
    await PipelineForeground.notifyComplete(
      taskId,
      chapter.title || '流水线',
      '已写完，点击查看',
    );
  }
  await PipelineForeground.stop(taskId);
}

export function isReconcileActive(taskId: string): boolean {
  return reconciling.has(taskId);
}

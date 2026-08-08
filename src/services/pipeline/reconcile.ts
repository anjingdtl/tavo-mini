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
  type PipelineContextSnapshot,
} from '../../types/pipelineContext';
import type {
  FrozenPresetSnapshot,
  PipelineExecutionSnapshot,
} from '../../types/pipelineExecution';
import {
  CURRENT_FINAL_REVISER_REASONING_POLICY_VERSION,
  resolveFinalReviserReasoning,
} from './finalReviserReasoningPolicy';
import {
  applyPipelineReasoningBudget,
  normalizePipelineReasoningEffort,
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
import { getStageProgressPercent } from '../../utils/stages';
import type { Chapter, Preset } from '../../types/novel';
import type {
  PipelineConfig,
  PipelineMode,
  PipelineReasoningEffort,
  PipelineStageName,
} from '../../types/pipeline';
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
import {
  buildPersistedTaskView,
  resolveStageCheckpoints,
} from './taskView';
import {
  compileDraftFromFrozenRequest,
  compileDraftStageRequest,
  compileFactCheckStageRequest,
  compileFactCheckV2StageRequest,
  compileFinalReviserStageRequest,
  compileProofStageRequest,
  compileReviewStageRequest,
  compileReviewV2StageRequest,
  requireReadyStageRequest,
  type ReadyStageRequest,
} from './compileStageRequest';
import { executeClaimedStage } from './executeClaimedStage';
import { mapOutlineErrorToPipelineError } from './errors';
import type { PipelineAction } from './types';
import {
  createStageAttempt,
  getStageAttempts,
  updateStageAttempt,
} from '../../data/repositories/pipelineStageAttemptRepository';
import { setBatchUsageFromRuns } from '../../data/repositories/multiChapterBatchRepository';
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
  run_proof: 'proof',
};

/** Next attempt sequence number for a task+stage (persisted count + 1). */
async function nextAttemptNo(taskId: string, stage: string): Promise<number> {
  const attempts = await getStageAttempts(taskId, stage);
  return attempts.length + 1;
}

function classifyAttemptError(
  error: any,
  attemptNo: number,
): {
  status: 'safe_to_retry' | 'outcome_unknown' | 'blocked' | 'failed' | 'cancelled';
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
async function runStageAttempt<T extends {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number | null;
}>(params: {
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
  });
  try {
    const result = await params.run();
    await updateStageAttempt({
      id: attemptId,
      status: 'succeeded',
      completedAt: Date.now(),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.totalTokens,
      reasoningTokens: result.reasoningTokens ?? null,
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
  pipelineReasoningEffortOverride?: PipelineReasoningEffort | null;
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

function buildExecutionSnapshot(params: {
  config: PipelineConfig;
  draftPreset: Preset | null;
  reviewPreset: Preset | null;
  factCheckPreset: Preset | null;
  proofPreset: Preset | null;
  requestConfig: LLMRequestConfig;
  outlineWorkflowVersion?: 1 | 2;
  contextBudgetVersion?: 1 | 2;
  finalReviserReasoningPolicyVersion?: 1 | 2;
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
  return {
    pipelineMode: params.config.pipelineMode,
    ...(params.outlineWorkflowVersion
      ? { outlineWorkflowVersion: params.outlineWorkflowVersion }
      : {}),
    ...(params.contextBudgetVersion
      ? { contextBudgetVersion: params.contextBudgetVersion }
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
    draftMaxTokens: params.config.draftMaxTokens,
    reviewMaxTokens: params.config.reviewMaxTokens,
    factCheckMaxTokens: params.config.factCheckMaxTokens,
    proofMaxTokens: params.config.proofMaxTokens,
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

function configFromExecution(execution: PipelineExecutionSnapshot): PipelineConfig {
  return {
    pipelineMode: execution.pipelineMode,
    reasoningEffort: execution.reasoningEffort,
    draftPresetId: execution.draftPresetId,
    reviewPresetId: execution.reviewPresetId,
    factCheckPresetId: execution.factCheckPresetId,
    proofPresetId: execution.proofPresetId,
    draftMaxTokens: execution.draftMaxTokens,
    reviewMaxTokens: execution.reviewMaxTokens,
    factCheckMaxTokens: execution.factCheckMaxTokens,
    proofMaxTokens: execution.proofMaxTokens,
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
    /** DeepSeek V4 Flash Final Reviser reasoning intensity. */
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
 * For reasoning models whose chain-of-thought exhausted the stage budget,
 * double the per-stage max tokens for the retry, clamped to the model's own
 * output ceiling so we never request more than the endpoint can return.
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
  '上一轮只输出了推理/思考过程，未给出 JSON 报告。请直接输出 JSON 报告本体，不要输出任何推理、分析或思考过程。';

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
  const v2Reasoning =
    reasoning?.thinking && reasoning.effort
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
  const detail = typeof details === 'string' ? details.trim().slice(0, 240) : '';
  return detail ? `${label}；校验提示：${detail}` : label;
}

function accumulateTokens(
  acc: { input: number; output: number; total: number },
  result: LLMResult,
) {
  return {
    input: acc.input + (result.inputTokens || 0),
    output: acc.output + (result.outputTokens || 0),
    total: acc.total + (result.totalTokens || 0),
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
  constructor(batchId: string, stage: string, cap: BatchBudgetExceededError['cap'], message: string) {
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
  const maxLlmCalls = row.max_llm_calls != null ? Number(row.max_llm_calls) : null;
  const maxInput = row.max_input_tokens != null ? Number(row.max_input_tokens) : null;
  const maxOutput = row.max_output_tokens != null ? Number(row.max_output_tokens) : null;

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

function cancelled(
  taskId: string,
  options: ReconcileOptions,
): boolean {
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
    await db.ensurePendingCheckpoints(taskId, [
      'draft',
      'review',
      'factCheck',
      'proof',
    ]);

    // Bound iterations to avoid infinite loops on bugs.
    for (let step = 0; step < 32; step++) {
      if (cancelled(taskId, options)) {
        await PipelineForeground.stop(taskId);
        return;
      }

      // Reload memory projection; prefer DB checkpoints when available.
      const task = usePipelineTaskStore.getState().tasks.find(t => t.id === taskId);
      if (!task) {
        throw new Error('找不到管线任务');
      }

      // Fail-closed: checkpoint query errors must not fall back to memory-only.
      const checkpointRows = await db.getStageCheckpoints(taskId);

      const stages = resolveStageCheckpoints({
        checkpointRows,
        stageResults: task.stageResults,
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
        await handleBlocked(taskId, chapter, action, stages, undefined, emitForeground);
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
      if (
        action.type === 'finalize_from_draft' &&
        action.degraded === true
      ) {
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
    const message =
      mapped?.message || getErrorMessage(error, '流水线执行失败');
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
  { outcome: 'waiting' } | { outcome: 'retried' } | { outcome: 'none'; message?: string }
> {
  const stage = params.stage;
  if (!stage) return { outcome: 'none' };
  const attempts = await getStageAttempts(params.taskId, stage);
  const latest = attempts[attempts.length - 1];
  if (!latest) return { outcome: 'none' };
  const disposition: RetryDisposition = determineRetryDisposition(latest);

  if (disposition.kind === 'fail') return { outcome: 'none' };
  if (disposition.kind === 'manual_pause' || disposition.kind === 'manual_confirm') {
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
      await actionRunDraft(taskId, chapter, onStageUpdate, abortSignal, options);
      return 'continue';
    case 'build_audit_context':
      await actionBuildAuditContext(taskId, chapter, options);
      return 'continue';
    case 'run_review':
      await actionRunReview(taskId, chapter, onStageUpdate, abortSignal, options);
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
    case 'run_proof':
      await actionRunProof(taskId, chapter, onStageUpdate, abortSignal, options);
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

async function loadRuntime(taskId: string, chapter: Chapter): Promise<{
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

  const config = await db.getPipelineConfig();
  const presets = (await db.getPresetsByProject(chapter.project_id)) as Preset[];
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
  // (frozen at task creation, Schema 44). Resume never re-reads live
  // project mode / defaults: frozen tasks keep their version. Missing or
  // unparseable row values fail closed to V1 (§4.3). New snapshots always
  // carry BOTH fields explicitly (1 or 2) — only parsing HISTORICAL
  // snapshots interprets an absent field as 1.
  const existingExecution = runtime.parsed?.execution;
  let outlineWorkflowVersion: 1 | 2;
  let contextBudgetVersion: 1 | 2;
  if (existingExecution) {
    outlineWorkflowVersion =
      existingExecution.outlineWorkflowVersion === 2 ? 2 : 1;
    contextBudgetVersion =
      existingExecution.contextBudgetVersion === 2 ? 2 : 1;
  } else {
    const taskRow = store.tasks.find(t => t.id === taskId);
    outlineWorkflowVersion =
      Number(taskRow?.outlineWorkflowVersion) === 2 ? 2 : 1;
    contextBudgetVersion =
      Number(taskRow?.contextBudgetVersion) === 2 ? 2 : 1;
  }
  // Fresh freeze from live config only when no execution yet. The selected
  // V2 tier scales all four stage output reserves once; resume reuses the
  // already-scaled values from the frozen snapshot.
  const selectedReasoningEffort =
    options.pipelineReasoningEffortOverride !== undefined
      ? options.pipelineReasoningEffortOverride
      : normalizePipelineReasoningEffort(runtime.config.reasoningEffort);
  const freshConfig =
    outlineWorkflowVersion === 2 && !existingExecution && selectedReasoningEffort
      ? applyPipelineReasoningBudget(runtime.config, selectedReasoningEffort)
      : outlineWorkflowVersion === 2 &&
          !existingExecution &&
          options.pipelineReasoningEffortOverride === null
        ? { ...runtime.config, reasoningEffort: undefined }
        : runtime.config;
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
      finalReviserReasoningPolicyVersion:
        outlineWorkflowVersion === 2
          ? CURRENT_FINAL_REVISER_REASONING_POLICY_VERSION
          : 1,
      reasoningEffort:
        outlineWorkflowVersion === 2 ? freshConfig.reasoningEffort : undefined,
    });
  // Batch-owned first run: the batch form's mode wins over the global
  // pipeline setting. Resume never overrides a frozen snapshot.
  if (options.pipelineModeOverride && !runtime.parsed?.execution) {
    execution.pipelineMode = options.pipelineModeOverride;
  }

  const compiled = await compileDraftStageRequest({
    chapter,
    requestConfig: runtime.requestConfig,
    draftPreset: runtime.draftPreset,
    draftMaxTokens: execution.draftMaxTokens,
    elasticBudget: execution.contextBudgetVersion === 2,
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
      const reasoning = resolvePipelineReasoning(
        runtime.parsed.execution,
        runtime.requestConfig,
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
          requestFingerprint:
            runtime.parsed.execution.reasoningEffort
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
          run: () =>
            callReadyLLM(
              firstReady,
              runtime.config.draftMaxTokens,
              buildCallConfig(
                runtime.draftPreset,
                runtime.config.draftMaxTokens,
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
            requestFingerprint:
              runtime.parsed.execution.reasoningEffort
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
                runtime.config.draftMaxTokens,
                buildCallConfig(
                  runtime.draftPreset,
                  runtime.config.draftMaxTokens,
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

function auditSnapshot(parsed: ParsedPipelineTaskContext): PipelineContextSnapshot {
  return parsed.auditContext || parsed.draftContext;
}

/** True when the frozen execution selected the V5-Lite V2 workflow. */
function isOutlineWorkflowV2(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
): boolean {
  return runtime.parsed?.execution?.outlineWorkflowVersion === 2;
}

/** True when the frozen execution selected the elastic budget V2 strategy. */
function isElasticBudgetV2(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
): boolean {
  return runtime.parsed?.execution?.contextBudgetVersion === 2;
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
    await persistStage(taskId, {
      stage: 'review',
      text: '',
      status: 'failed',
      error:
        validation.reason === 'reasoning_only'
          ? '文学评估仅返回推理内容，未产生报告。请在「设置」中提高该模型的审阅 max_tokens，或改用非推理模型。'
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
      taskId,
    });

    if (!validation.valid) {
      const isReasoningOnly = validation.reason === 'reasoning_only';
      const retryMaxTokens = isReasoningOnly
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
      const retry = await runStageAttempt({
        taskId,
        stage: 'factCheck',
        requestVersion: 2,
        requestFingerprint: stageFingerprint('factCheck', repairReady, {
          thinking: reasoning.thinking?.type,
          reasoningEffort: reasoning.effort,
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
      tokens = accumulateTokens(tokens, retry);
      validation = validate(retry);
      logPipelineAudit({
        stage: 'factCheck',
        attempt: 2,
        valid: validation.valid,
        reason: validation.reason,
        textLength: retry.text?.length || 0,
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
          ? '事实核查仅返回推理内容，未产生报告。请在「设置」中提高该模型的核查 max_tokens，或改用非推理模型。'
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
        elasticBudget: isElasticBudgetV2(runtime),
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
        const hasOutline = !!(context.outlineText && context.outlineText.trim());
        let validation = validateReviewResult(first, draftText, { hasOutline });
        logPipelineAudit({
          stage: 'review',
          attempt: 1,
          valid: validation.valid,
          reason: validation.reason,
          textLength: first.text?.length || 0,
          taskId,
        });

        if (!validation.valid) {
          const isReasoningOnly = validation.reason === 'reasoning_only';
          // For reasoning models that burned the whole budget on CoT, retry
          // with a doubled budget (clamped to the model ceiling) and ask the
          // gateway to disable thinking. Otherwise fall through to the generic
          // one-shot format repair.
          const retryMaxTokens = isReasoningOnly
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
            elasticBudget: isElasticBudgetV2(runtime),
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
              ? '文学评估仅返回推理内容，未产生报告。请在「设置」中提高该模型的审阅 max_tokens，或改用非推理模型。'
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
        elasticBudget: isElasticBudgetV2(runtime),
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
          taskId,
        });
        if (!validation.valid) {
          const isReasoningOnly = validation.reason === 'reasoning_only';
          // For reasoning models that burned the whole budget on CoT, retry
          // with a doubled budget (clamped to the model ceiling) and ask the
          // gateway to disable thinking. Otherwise fall through to the generic
          // one-shot format repair.
          const retryMaxTokens = isReasoningOnly
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
            elasticBudget: isElasticBudgetV2(runtime),
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
              ? '事实核查仅返回推理内容，未产生报告。请在「设置」中提高该模型的事实核查 max_tokens，或改用非推理模型。'
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
  const reviewV2 = reviewText ? (parseV2(reviewText) as PipelineReviewReportV2 | null) : null;
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
      warnings: [
        ...compiledContract.warnings,
        ...(validator.warnings || []),
      ],
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
          getStageProgressPercent(runtime.config.pipelineMode, 2),
        ).catch(() => {});
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
        elasticBudget: isElasticBudgetV2(runtime),
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
    const task = usePipelineTaskStore.getState().tasks.find(t => t.id === taskId);
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
    usePipelineTaskStore.getState().setTaskInputFingerprint(taskId, fingerprint);
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

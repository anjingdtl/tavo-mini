import * as db from './database';
import {
  callLLMResult,
  resolveLLMRequestConfig,
  type LLMRequestConfig,
} from './llm';
import {
  checkRequestFitsContextWindow,
  computeInputFingerprint,
  OutlineContextError,
} from './outlineContextBuilder';
import {
  buildReviewMessages,
  buildFactCheckMessages,
  buildProofMessages,
  buildReviewRepairMessages,
  buildFactCheckRepairMessages,
  estimateStageInputTokens,
} from './pipelineMessages';
import {
  buildReviewContextFromSnapshot,
  buildFactCheckContextFromSnapshot,
  buildProofConstraintsFromSnapshot,
  PIPELINE_CONTEXT_SNAPSHOT_VERSION,
  type FactCheckContext,
  type PipelineContextSnapshot,
  type ProofConstraints,
  type ReviewContext,
} from '../types/pipelineContext';
import type {
  FrozenPresetSnapshot,
  PipelineExecutionSnapshot,
} from '../types/pipelineExecution';
import { sha256Hex } from './continuation/hashUtils';
import type { ChatMessage } from './llm';
import { buildPostDraftAuditContext } from './postDraftRetrieval';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { saveDraft } from './draftService';
import { PipelineForeground } from '../native/PipelineForegroundModule';
import { getStageProgressPercent } from '../utils/stages';
import type { Chapter, Preset } from '../types/novel';
import type {
  PipelineConfig,
  PipelineStageName,
  PipelineTaskStatus,
} from '../types/pipeline';
import {
  clearLLMTaskQueueDefaults,
  setLLMTaskQueueDefaults,
} from './llm/requestScheduler';
import {
  describeAuditFailureReason,
  formatAuditFailureMessage,
  logPipelineAudit,
  validateFactCheckResult,
  validateReviewResult,
} from './pipelineAuditValidator';
import type { LLMResult } from './llm/types';
import {
  parsePersistedPipelineTaskContext,
  resolveAuditContext,
  serializePipelineTaskContext,
  type ParsedPipelineTaskContext,
} from './pipelineTaskContext';
import { compileDraftPipelineRequest } from './draftPipelineCompiler';
import { reconcilePipelineTask } from './pipeline/reconcile';

const cancelledTasks = new Set<string>();
const taskAbortControllers = new Map<string, AbortController>();

export function cancelPipeline(taskId: string): void {
  try {
    cancelledTasks.add(taskId);
    // 不等待网络或原生回调：用户明确停止时必须先把终态写入 SQLite，
    // 否则进程在 prefill 中被关闭后，冷启动会把旧任务错误地显示为仍在运行。
    usePipelineTaskStore.getState().cancelTask(taskId);
    PipelineForeground.stop(taskId).catch(() => {});
    const controller = taskAbortControllers.get(taskId);
    if (controller) {
      try {
        controller.abort();
      } catch {
        // AbortController.abort must not escape into the UI press handler.
      }
    }
  } catch (error) {
    console.warn('[pipeline] cancelPipeline failed:', error);
  }
}

export function isPipelineCancelled(taskId: string): boolean {
  return cancelledTasks.has(taskId);
}

function registerTaskAbort(taskId: string): AbortSignal {
  const controller = new AbortController();
  taskAbortControllers.set(taskId, controller);
  return controller.signal;
}

function releaseTaskAbort(taskId: string): void {
  taskAbortControllers.delete(taskId);
}

function resolvePreset(
  presetId: number | null,
  presets: Preset[],
  options?: { allowFallback?: boolean },
): Preset | null {
  if (presetId != null) {
    const found = presets.find(p => p.id === presetId);
    if (found) return found;
    if (options?.allowFallback === false) {
      return null;
    }
    // Live-start path: soft fallback to first preset with a warning.
    console.warn(
      `[pipeline] presetId=${presetId} not found, falling back to first preset`,
    );
  }
  return presets[0] || null;
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

function buildExecutionSnapshot(params: {
  config: PipelineConfig;
  draftPreset: Preset | null;
  reviewPreset: Preset | null;
  factCheckPreset: Preset | null;
  proofPreset: Preset | null;
  requestConfig: LLMRequestConfig;
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

function requestConfigFromExecution(
  execution: PipelineExecutionSnapshot,
  live: LLMRequestConfig,
): LLMRequestConfig {
  // Reuse live credentials/url for the same config id; window/model name stay frozen.
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

function configFromExecution(execution: PipelineExecutionSnapshot): PipelineConfig {
  return {
    pipelineMode: execution.pipelineMode,
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

function checkCancelled(taskId: string): boolean {
  if (cancelledTasks.has(taskId)) {
    usePipelineTaskStore.getState().cancelTask(taskId);
    return true;
  }
  return false;
}

function throwIfCancelled(taskId: string, abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted || checkCancelled(taskId)) {
    const error = new Error('已取消') as Error & { code?: string };
    error.code = 'cancelled';
    throw error;
  }
}

function buildCallConfig(
  preset: Preset | null,
  maxTokens: number,
  scenario: string,
  projectId?: number,
  requestConfig?: LLMRequestConfig,
  taskId?: string,
  extras?: { responseFormat?: 'json_object' },
) {
  const statusForScenario = (): PipelineTaskStatus => {
    if (scenario === 'pipeline_draft') return 'drafting';
    if (scenario === 'pipeline_review') return 'reviewing';
    if (scenario === 'pipeline_factcheck') return 'factChecking';
    return 'proofing';
  };
  return {
    temperature: preset?.temperature,
    top_p: preset?.top_p,
    max_tokens: maxTokens,
    scenario,
    projectId,
    taskId,
    responseFormat: extras?.responseFormat,
    onQueueState: (state: 'queued' | 'running' | 'cancelled') => {
      if (state === 'queued') {
        usePipelineTaskStore.getState().setTaskStatus(taskId || '', 'queued');
      } else if (state === 'running') {
        usePipelineTaskStore
          .getState()
          .setTaskStatus(taskId || '', statusForScenario());
      } else {
        usePipelineTaskStore.getState().cancelTask(taskId || '');
      }
    },
    requestConfig,
  };
}

function accumulateTokens(
  acc: { input: number; output: number; total: number },
  result: LLMResult,
): { input: number; output: number; total: number } {
  return {
    input: acc.input + (result.inputTokens || 0),
    output: acc.output + (result.outputTokens || 0),
    total: acc.total + (result.totalTokens || 0),
  };
}

function getErrorMessage(error: any, fallback: string): string {
  return error?.message ? String(error.message) : fallback;
}

/**
 * Serialize + hash a frozen pipeline context snapshot.
 * Prefer {@link serializePipelineTaskContext} (V2 envelope). This wrapper
 * remains for unit tests that only have a bare snapshot.
 */
export function serializePipelineContextSnapshot(
  snapshot: PipelineContextSnapshot,
  execution?: PipelineExecutionSnapshot,
): {
  pipelineContextJson: string;
  pipelineContextVersion: number;
  pipelineContextHash: string;
} {
  if (execution) {
    return serializePipelineTaskContext({
      draftContext: snapshot,
      execution,
    });
  }
  // Legacy V1 bare snapshot (tests / migration helpers).
  const enriched: PipelineContextSnapshot = {
    ...snapshot,
    snapshotVersion: PIPELINE_CONTEXT_SNAPSHOT_VERSION,
    createdAt: snapshot.createdAt ?? Date.now(),
  };
  const pipelineContextJson = JSON.stringify(enriched);
  return {
    pipelineContextJson,
    pipelineContextVersion: 1,
    pipelineContextHash: sha256Hex(pipelineContextJson).slice(0, 32),
  };
}

/**
 * Load a previously persisted snapshot (draft context).
 * Throws OutlineContextError when missing/corrupt. Prefer
 * {@link parsePersistedPipelineTaskContext} when audit/execution are needed.
 */
export function parsePersistedPipelineContextSnapshot(
  task: {
    pipelineContextJson?: string | null;
    pipelineContextHash?: string | null;
    pipelineContextVersion?: number | null;
  },
  ownership?: {
    expectedProjectId?: number;
    expectedChapterId?: number;
    expectedTaskId?: string;
  },
): PipelineContextSnapshot {
  return parsePersistedPipelineTaskContext(task, ownership).draftContext;
}

/**
 * Fail-closed final request window check. Uses the actual request model's
 * context window — never re-reads the live active config.
 */
function assertMessagesFitContextWindow(params: {
  messages: ChatMessage[];
  reservedOutputTokens: number;
  contextWindow: number;
  stageLabel: string;
}): void {
  const estimatedInputTokens = estimateStageInputTokens(params.messages);
  const reason = checkRequestFitsContextWindow({
    estimatedInputTokens,
    reservedOutputTokens: params.reservedOutputTokens,
    contextWindow: params.contextWindow,
    stageLabel: params.stageLabel,
  });
  if (reason) {
    throw new OutlineContextError(
      'OUTLINE_OVER_BUDGET',
      reason,
      'open_outlines',
    );
  }
}

function contextWindowOf(requestConfig?: LLMRequestConfig): number {
  return Number(requestConfig?.context_window) || 0;
}

/** Never allow an HTTP-success response without manuscript content to advance
 * the outline pipeline. `reasoning_content` is intentionally not a draft. */
function draftEmptyResponseError(result: LLMResult): Error {
  switch (result.emptyReason) {
    case 'reasoning_only':
      return new Error(
        '初稿仅返回推理内容，未产生正文。请提高模型最大输出 token 或改用非推理模型。',
      );
    case 'length':
      return new Error(
        '初稿输出被 max_tokens 截断，未产生正文。请提高初稿或模型最大输出 token。',
      );
    case 'content_filter':
      return new Error('初稿输出被内容过滤拦截，请调整写作要求后重试。');
    case 'no_choices':
      return new Error('初稿收到空响应（无 choices），请检查模型服务状态。');
    default:
      return new Error('初稿未返回正文，请检查模型服务后重试。');
  }
}

function markSkipped(
  taskId: string,
  stage: PipelineStageName,
  text: string,
): void {
  usePipelineTaskStore.getState().updateTaskStage(taskId, {
    stage,
    text,
    status: 'skipped',
    durationMs: 0,
  });
}

function isAbortError(error: any, abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted || error?.code === 'cancelled');
}

export type StageInfo = {
  stage: PipelineStageName | 'idle';
  label: string;
  startedAt: number;
};

export interface PipelineRunOptions {
  queueClass?: 'pipeline' | 'background';
  queuePriority?: 'manual' | 'background';
}

/* =========================================================================
 * Shared stage runners (SPEC §15)
 *
 * Each stage helper owns: status transitions, foreground notifications, the
 * LLM call, token + durationMs accounting, cancellation, and the per-stage
 * error → skipped/failed mapping. They NEVER start the next stage — that is the
 * caller's job, so the dependency order stays explicit in the mode branches.
 * ========================================================================= */

interface StageCommonArgs {
  taskId: string;
  projectId: number;
  requestConfig?: LLMRequestConfig;
  abortSignal?: AbortSignal;
}

/**
 * Literary review stage. Validates structure + draft-echo before success.
 * At most one format-repair retry. Returns normalized JSON on success or '' on
 * failure (caller decides whether to skip proof). Throws only on cancellation.
 */
async function runReviewStage(
  args: StageCommonArgs & {
    draftText: string;
    context: ReviewContext;
    maxTokens: number;
    preset: Preset | null;
  },
): Promise<string> {
  const { taskId, projectId, requestConfig, abortSignal } = args;
  const store = usePipelineTaskStore.getState();
  if (abortSignal?.aborted || checkCancelled(taskId)) {
    throw new Error('cancelled');
  }
  store.setTaskStatus(taskId, 'reviewing');
  const start = Date.now();
  let tokens = { input: 0, output: 0, total: 0 };
  try {
    const reviewMessages = buildReviewMessages(args.draftText, args.context);
    assertMessagesFitContextWindow({
      messages: reviewMessages,
      reservedOutputTokens: args.maxTokens,
      contextWindow: contextWindowOf(requestConfig),
      stageLabel: '文学评估',
    });
    const first = await callLLMResult(
      reviewMessages,
      args.maxTokens,
      buildCallConfig(
        args.preset,
        args.maxTokens,
        'pipeline_review',
        projectId,
        requestConfig,
        taskId,
        { responseFormat: 'json_object' },
      ),
      abortSignal,
    );
    // Some provider implementations can settle after fetch has been aborted.
    // A late response must never advance this pipeline to the next stage.
    throwIfCancelled(taskId, abortSignal);
    tokens = accumulateTokens(tokens, first);

    const hasOutline = !!(args.context.outlineText && args.context.outlineText.trim());
    let validation = validateReviewResult(first, args.draftText, { hasOutline });
    logPipelineAudit({
      stage: 'review',
      attempt: 1,
      valid: validation.valid,
      reason: validation.reason,
      textLength: first.text?.length || 0,
      reasoningLength: first.reasoningText?.length || 0,
      finishReason: first.finishReason,
      similarity: validation.similarity,
      taskId,
    });

    if (!validation.valid) {
      PipelineForeground.updateProgress(
        taskId,
        '审核格式异常，正在重试',
        getStageProgressPercent('twoStage', 1),
      ).catch(() => {});
      logPipelineAudit({
        stage: 'review',
        attempt: 2,
        valid: false,
        retry: true,
        taskId,
      });

      const repairMessages = buildReviewRepairMessages(
        args.draftText,
        args.context,
        describeAuditFailureReason(validation.reason),
      );
      assertMessagesFitContextWindow({
        messages: repairMessages,
        reservedOutputTokens: args.maxTokens,
        contextWindow: contextWindowOf(requestConfig),
        stageLabel: '文学评估格式修复',
      });
      const retry = await callLLMResult(
        repairMessages,
        args.maxTokens,
        buildCallConfig(
          args.preset,
          args.maxTokens,
          'pipeline_review',
          projectId,
          requestConfig,
          taskId,
          { responseFormat: 'json_object' },
        ),
        abortSignal,
      );
      throwIfCancelled(taskId, abortSignal);
      tokens = accumulateTokens(tokens, retry);
      validation = validateReviewResult(retry, args.draftText, { hasOutline });
      logPipelineAudit({
        stage: 'review',
        attempt: 2,
        valid: validation.valid,
        reason: validation.reason,
        textLength: retry.text?.length || 0,
        reasoningLength: retry.reasoningText?.length || 0,
        finishReason: retry.finishReason,
        similarity: validation.similarity,
        taskId,
      });
    }

    if (validation.valid && validation.normalizedText) {
      store.updateTaskStage(taskId, {
        stage: 'review',
        text: validation.normalizedText,
        status: 'success',
        tokens,
        durationMs: Date.now() - start,
      });
      return validation.normalizedText;
    }

    store.updateTaskStage(taskId, {
      stage: 'review',
      text: '',
      status: 'failed',
      error: formatAuditFailureMessage('review', validation.reason),
      tokens,
      durationMs: Date.now() - start,
    });
    return '';
  } catch (error: any) {
    if (isAbortError(error, abortSignal)) {
      store.cancelTask(taskId);
      await PipelineForeground.stop(taskId);
      throw error;
    }
    store.updateTaskStage(taskId, {
      stage: 'review',
      text: '',
      status: 'failed',
      error: error.message || '文学评估失败',
      tokens,
      durationMs: Date.now() - start,
    });
    return '';
  }
}

/**
 * Fact-check stage. Same validation / one-shot repair contract as review.
 */
async function runFactCheckStage(
  args: StageCommonArgs & {
    draftText: string;
    context: FactCheckContext;
    maxTokens: number;
    preset: Preset | null;
  },
): Promise<string> {
  const { taskId, projectId, requestConfig, abortSignal } = args;
  const store = usePipelineTaskStore.getState();
  if (abortSignal?.aborted || checkCancelled(taskId)) {
    throw new Error('cancelled');
  }
  store.setTaskStatus(taskId, 'factChecking');
  const start = Date.now();
  let tokens = { input: 0, output: 0, total: 0 };
  try {
    const factMessages = buildFactCheckMessages(args.draftText, args.context);
    assertMessagesFitContextWindow({
      messages: factMessages,
      reservedOutputTokens: args.maxTokens,
      contextWindow: contextWindowOf(requestConfig),
      stageLabel: '事实核查',
    });
    const first = await callLLMResult(
      factMessages,
      args.maxTokens,
      buildCallConfig(
        args.preset,
        args.maxTokens,
        'pipeline_factcheck',
        projectId,
        requestConfig,
        taskId,
        { responseFormat: 'json_object' },
      ),
      abortSignal,
    );
    throwIfCancelled(taskId, abortSignal);
    tokens = accumulateTokens(tokens, first);

    let validation = validateFactCheckResult(first, args.draftText);
    logPipelineAudit({
      stage: 'factCheck',
      attempt: 1,
      valid: validation.valid,
      reason: validation.reason,
      textLength: first.text?.length || 0,
      reasoningLength: first.reasoningText?.length || 0,
      finishReason: first.finishReason,
      similarity: validation.similarity,
      taskId,
    });

    if (!validation.valid) {
      PipelineForeground.updateProgress(
        taskId,
        '审核格式异常，正在重试',
        getStageProgressPercent('conditional', 1),
      ).catch(() => {});
      logPipelineAudit({
        stage: 'factCheck',
        attempt: 2,
        valid: false,
        retry: true,
        taskId,
      });

      const repairMessages = buildFactCheckRepairMessages(
        args.draftText,
        args.context,
        describeAuditFailureReason(validation.reason),
      );
      assertMessagesFitContextWindow({
        messages: repairMessages,
        reservedOutputTokens: args.maxTokens,
        contextWindow: contextWindowOf(requestConfig),
        stageLabel: '事实核查格式修复',
      });
      const retry = await callLLMResult(
        repairMessages,
        args.maxTokens,
        buildCallConfig(
          args.preset,
          args.maxTokens,
          'pipeline_factcheck',
          projectId,
          requestConfig,
          taskId,
          { responseFormat: 'json_object' },
        ),
        abortSignal,
      );
      throwIfCancelled(taskId, abortSignal);
      tokens = accumulateTokens(tokens, retry);
      validation = validateFactCheckResult(retry, args.draftText);
      logPipelineAudit({
        stage: 'factCheck',
        attempt: 2,
        valid: validation.valid,
        reason: validation.reason,
        textLength: retry.text?.length || 0,
        reasoningLength: retry.reasoningText?.length || 0,
        finishReason: retry.finishReason,
        similarity: validation.similarity,
        taskId,
      });
    }

    if (validation.valid && validation.normalizedText) {
      store.updateTaskStage(taskId, {
        stage: 'factCheck',
        text: validation.normalizedText,
        status: 'success',
        tokens,
        durationMs: Date.now() - start,
      });
      return validation.normalizedText;
    }

    store.updateTaskStage(taskId, {
      stage: 'factCheck',
      text: '',
      status: 'failed',
      error: formatAuditFailureMessage('factCheck', validation.reason),
      tokens,
      durationMs: Date.now() - start,
    });
    return '';
  } catch (error: any) {
    if (isAbortError(error, abortSignal)) {
      store.cancelTask(taskId);
      await PipelineForeground.stop(taskId);
      throw error;
    }
    store.updateTaskStage(taskId, {
      stage: 'factCheck',
      text: '',
      status: 'failed',
      error: error.message || '事实核查失败',
      tokens,
      durationMs: Date.now() - start,
    });
    return '';
  }
}

/** Structured result from the proof stage — callers must not complete on failure. */
export interface ProofStageResult {
  text: string;
  succeeded: boolean;
  error?: string;
}

/**
 * Proof / final-revision stage. Never uses reasoning_content as the final
 * manuscript. Empty content / reasoning-only / request error → failed + draft
 * fallback with succeeded=false (caller must not completeTask).
 */
async function runProofStage(
  args: StageCommonArgs & {
    draftText: string;
    reviewText: string;
    factCheckText: string;
    constraints: ProofConstraints;
    maxTokens: number;
    preset: Preset | null;
  },
): Promise<ProofStageResult> {
  const { taskId, projectId, requestConfig, abortSignal } = args;
  const store = usePipelineTaskStore.getState();
  if (abortSignal?.aborted || checkCancelled(taskId)) {
    throw new Error('cancelled');
  }
  store.setTaskStatus(taskId, 'proofing');
  const start = Date.now();
  try {
    const proofMessages = buildProofMessages(
      args.draftText,
      args.reviewText,
      args.factCheckText,
      args.constraints,
    );
    assertMessagesFitContextWindow({
      messages: proofMessages,
      reservedOutputTokens: args.maxTokens,
      contextWindow: contextWindowOf(requestConfig),
      stageLabel: '综合修订',
    });
    const result = await callLLMResult(
      proofMessages,
      args.maxTokens,
      buildCallConfig(
        args.preset,
        args.maxTokens,
        'pipeline_proof',
        projectId,
        requestConfig,
        taskId,
      ),
      abortSignal,
    );
    throwIfCancelled(taskId, abortSignal);
    // Strict: only official content may become the final manuscript.
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
      store.updateTaskStage(taskId, {
        stage: 'proof',
        text: args.draftText,
        status: 'failed',
        error,
        tokens: {
          input: result.inputTokens,
          output: result.outputTokens,
          total: result.totalTokens,
        },
        durationMs: Date.now() - start,
      });
      return { text: args.draftText, succeeded: false, error };
    }
    store.updateTaskStage(taskId, {
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
    return { text: content, succeeded: true };
  } catch (error: any) {
    if (isAbortError(error, abortSignal)) {
      store.cancelTask(taskId);
      await PipelineForeground.stop(taskId);
      throw error;
    }
    // SPEC §13.5: proof failure falls back to the draft, marked as failed so
    // the UI can distinguish "real proof" from "fallback draft".
    const message = error.message || '终审失败，已回退到初稿';
    store.updateTaskStage(taskId, {
      stage: 'proof',
      text: args.draftText,
      status: 'failed',
      error: message,
      durationMs: Date.now() - start,
    });
    return { text: args.draftText, succeeded: false, error: message };
  }
}

/* =========================================================================
 * Entry points
 * ========================================================================= */

/**
 * Single entry for first-run and resume. Both call {@link reconcilePipelineTask}.
 * @deprecated Prefer reconcilePipelineTask; kept as stable public API.
 */
export async function runChapterPipeline(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (info: StageInfo | string) => void,
  options: PipelineRunOptions = {},
): Promise<void> {
  setLLMTaskQueueDefaults(taskId, {
    queueClass: options.queueClass || 'pipeline',
    queuePriority: options.queuePriority || 'manual',
  });
  const abortSignal = registerTaskAbort(taskId);
  // 必须在用户仍处于前台、且任何数据库/网络 await 之前启动服务。若等到配置读取
  // 完成后用户已经切到后台，Android 12+ 会拒绝 startForegroundService，原先错误被
  // 静默降级后就表现为“流水线一切后台必失败”。
  PipelineForeground.start(
    taskId,
    chapter.title || '流水线',
    '正在准备写作',
    0,
  ).catch(error => {
    console.warn(
      '[pipeline] early foreground start failed (non-fatal):',
      error,
    );
  });
  try {
    await reconcilePipelineTask(taskId, chapter, {
      onStageUpdate,
      abortSignal,
      isCancelled: isPipelineCancelled,
    });
  } finally {
    releaseTaskAbort(taskId);
    clearLLMTaskQueueDefaults(taskId);
    // 任务结束（无论成功/失败/取消）后清理取消标记，避免 cancelledTasks 累积
    cancelledTasks.delete(taskId);
  }
}

async function runChapterPipelineInner(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (info: StageInfo | string) => void,
  abortSignal?: AbortSignal,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  let config;
  let contextConfig;
  let presets;
  let requestConfig: LLMRequestConfig;
  try {
    config = await db.getPipelineConfig();
    contextConfig = await db.getContextConfig();
    presets = await db.getPresetsByProject(chapter.project_id);
    requestConfig = await resolveLLMRequestConfig();
  } catch (error: any) {
    store.failTask(taskId, getErrorMessage(error, '流水线配置读取失败'));
    await PipelineForeground.notifyFailed(
      taskId,
      chapter.title || '流水线',
      '配置读取失败',
    );
    await PipelineForeground.stop(taskId);
    return;
  }

  const draftPreset = resolvePreset(config.draftPresetId, presets as Preset[]);
  const reviewPreset = resolvePreset(
    config.reviewPresetId,
    presets as Preset[],
  );
  const factCheckPreset = resolvePreset(
    config.factCheckPresetId,
    presets as Preset[],
  );
  const proofPreset = resolvePreset(config.proofPresetId, presets as Preset[]);

  // Freeze execution config (mode, budgets, presets, model window) at start.
  let execution: PipelineExecutionSnapshot;
  try {
    execution = buildExecutionSnapshot({
      config,
      draftPreset,
      reviewPreset,
      factCheckPreset,
      proofPreset,
      requestConfig,
    });
  } catch (error: any) {
    store.failTask(taskId, getErrorMessage(error, '流水线执行配置冻结失败'));
    await PipelineForeground.notifyFailed(
      taskId,
      chapter.title || '流水线',
      '执行配置不可用',
    );
    await PipelineForeground.stop(taskId);
    return;
  }

  // 通知栏进度计算封装到 utils/stages，便于测试与 resume 共用。
  // 阶段"开始"时跳到该阶段起点，成功 complete / 降级保留初稿 时设 100，
  // 让用户在通知栏看到进度条单调递增。
  const pct = (completedStages: number) =>
    getStageProgressPercent(config.pipelineMode, completedStages);

  /**
   * Persist draft content (saveDraft) then set task terminal state.
   * Success path: completeTask + "已完成" notify.
   * Degraded path (audit/proof failed): setTaskFinalText only — never
   * completeTask (would overwrite failed), never success notify.
   */
  const saveDraftAndFinalize = async (
    text: string,
    options?: { degraded?: boolean },
  ) => {
    if (abortSignal?.aborted || checkCancelled(taskId)) return;
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
    // Freeze the input fingerprint at terminal state so the result-adoption
    // flow can later detect outline/chapter drift. Uses the snapshot's outline
    // fingerprint (frozen at buildContext) and the chapter's saved updatedAt.
    try {
      const fingerprint = await computeInputFingerprint({
        projectId: chapter.project_id,
        chapterId: chapter.id,
        chapterUpdatedAt: chapter.updated_at,
        outlineFingerprint: pipelineContext.outlineFingerprint,
      });
      store.setTaskInputFingerprint(taskId, fingerprint);
    } catch {
      /* best-effort: a missing fingerprint just disables drift detection */
    }
    if (options?.degraded) {
      // Keep status/error from failTask; only attach retained draft text.
      store.setTaskFinalText(taskId, text);
      await PipelineForeground.updateProgress(taskId, '已保留初稿', 100);
      await PipelineForeground.stop(taskId);
      return;
    }
    store.completeTask(taskId, text);
    await PipelineForeground.updateProgress(taskId, '已完成', 100);
    await PipelineForeground.notifyComplete(
      taskId,
      chapter.title || '流水线',
      '已写完，点击查看',
    );
    await PipelineForeground.stop(taskId);
  };

  /** Finish after proof: only complete when proof actually succeeded. */
  const finalizeAfterProof = async (proof: ProofStageResult) => {
    if (abortSignal?.aborted || checkCancelled(taskId)) return;
    if (!proof.succeeded) {
      store.failTask(
        taskId,
        proof.error || '终审失败，已保留初稿，未生成终审稿。',
      );
      await PipelineForeground.notifyFailed(
        taskId,
        chapter.title || '流水线',
        proof.error || '终审失败，已保留初稿',
      );
      await saveDraftAndFinalize(proof.text, { degraded: true });
      return;
    }
    await saveDraftAndFinalize(proof.text);
  };

  if (checkCancelled(taskId)) {
    await PipelineForeground.notifyFailed(
      taskId,
      chapter.title || '流水线',
      '已取消',
    );
    await PipelineForeground.stop(taskId);
    return;
  }

  /* ----------------------------- Draft ----------------------------- */
  store.setTaskStatus(taskId, 'drafting');
  onStageUpdate?.({
    stage: 'draft',
    label: '正在生成初稿',
    startedAt: Date.now(),
  });
  PipelineForeground.updateProgress(taskId, '正在生成初稿', pct(0)).catch(
    () => {},
  );

  let draftText = '';
  let pipelineContext: PipelineContextSnapshot;
  const draftStart = Date.now();
  try {
    // Shared compiler with Context Preview so messages are byte-identical.
    const compiled = await compileDraftPipelineRequest({
      chapter,
      requestConfig,
      draftPreset,
      draftMaxTokens: config.draftMaxTokens,
    });
    pipelineContext = compiled.pipelineContext;

    // Critical path: await durable snapshot write BEFORE any LLM call.
    // Fire-and-forget store writes leave a process-death race.
    try {
      await store.persistTaskPipelineContext(
        taskId,
        serializePipelineTaskContext({
          draftContext: pipelineContext,
          execution,
        }),
      );
    } catch (persistError: any) {
      throw persistError instanceof OutlineContextError
        ? persistError
        : new OutlineContextError(
            'OUTLINE_SNAPSHOT_PERSIST_FAILED',
            getErrorMessage(
              persistError,
              '冻结上下文保存失败，已阻止调用模型。',
            ),
            'restart_task',
          );
    }

    const draftMessages = compiled.messages;

    assertMessagesFitContextWindow({
      messages: draftMessages,
      reservedOutputTokens: config.draftMaxTokens,
      contextWindow: contextWindowOf(requestConfig),
      stageLabel: '初稿',
    });

    const firstDraftResult = await callLLMResult(
      draftMessages,
      config.draftMaxTokens,
      buildCallConfig(
        draftPreset,
        config.draftMaxTokens,
        'pipeline_draft',
        chapter.project_id,
        requestConfig,
        taskId,
      ),
      abortSignal,
    );
    throwIfCancelled(taskId, abortSignal);
    let draftResult = firstDraftResult;
    let draftTokens = {
      input: firstDraftResult.inputTokens,
      output: firstDraftResult.outputTokens,
      total: firstDraftResult.totalTokens,
    };
    draftText = draftResult.text || '';
    if (
      !draftText.trim() &&
      (draftResult.emptyReason === 'reasoning_only' ||
        draftResult.emptyReason === 'length')
    ) {
      // Outline contexts are already packed from the persisted pipeline budget,
      // so increasing max_tokens here could exceed the model window. Retry once
      // at the same safe budget with an explicit no-reasoning instruction.
      const draftRetryMessages: ChatMessage[] = [
        ...draftMessages,
        {
          role: 'user',
          content: '请直接输出章节正文；不要输出分析、思考过程或标题。',
        },
      ];
      assertMessagesFitContextWindow({
        messages: draftRetryMessages,
        reservedOutputTokens: config.draftMaxTokens,
        contextWindow: contextWindowOf(requestConfig),
        stageLabel: '初稿重试',
      });
      draftResult = await callLLMResult(
        draftRetryMessages,
        config.draftMaxTokens,
        buildCallConfig(
          draftPreset,
          config.draftMaxTokens,
          'pipeline_draft',
          chapter.project_id,
          requestConfig,
          taskId,
        ),
        abortSignal,
      );
      throwIfCancelled(taskId, abortSignal);
      draftTokens = {
        input: draftTokens.input + draftResult.inputTokens,
        output: draftTokens.output + draftResult.outputTokens,
        total: draftTokens.total + draftResult.totalTokens,
      };
      draftText = draftResult.text || '';
    }
    if (!draftText.trim()) {
      throw draftEmptyResponseError(draftResult);
    }

    store.updateTaskStage(taskId, {
      stage: 'draft',
      text: draftText,
      status: 'success',
      tokens: draftTokens,
      durationMs: Date.now() - draftStart,
    });
  } catch (error: any) {
    // 取消信号在阶段内被吞修复：先判断是否为用户取消，是则走取消路径不走 fail
    if (isAbortError(error, abortSignal)) {
      store.cancelTask(taskId);
      await PipelineForeground.stop(taskId);
      return;
    }
    store.updateTaskStage(taskId, {
      stage: 'draft',
      text: '',
      status: 'failed',
      error: error.message || '初稿生成失败',
      durationMs: Date.now() - draftStart,
    });
    store.failTask(taskId, getErrorMessage(error, '初稿生成失败'));
    await PipelineForeground.notifyFailed(
      taskId,
      chapter.title || '流水线',
      '初稿生成失败',
    );
    await PipelineForeground.stop(taskId);
    return;
  }

  /* ----------------------------- noReview ----------------------------- */
  if (config.pipelineMode === 'noReview') {
    onStageUpdate?.({
      stage: 'idle',
      label: '无审核模式，初稿即为完稿',
      startedAt: Date.now(),
    });
    markSkipped(taskId, 'review', '无审核模式已跳过审阅/评估');
    markSkipped(taskId, 'factCheck', '无审核模式已跳过事实核查');
    markSkipped(taskId, 'proof', '无审核模式已跳过终审校对');
    await saveDraftAndFinalize(draftText);
    return;
  }

  /* ------------- Post-draft local retrieval (full only, SPEC §10) ------------- *
   * Only `full` runs review + factCheck; the post-draft retrieval enriches the
   * shared snapshot so fact-check can catch continuity issues the draft itself
   * introduced (old character, "first time", etc.). twoStage / conditional do
   * not need it because they only run one audit branch.
   */
  let auditContext = pipelineContext;
  if (config.pipelineMode === 'full') {
    let auditFellBack = false;
    try {
      const retrieval = await buildPostDraftAuditContext(
        pipelineContext,
        draftText,
        chapter.project_id,
        chapter,
        contextConfig,
      );
      auditContext = retrieval.snapshot;
      auditFellBack = Boolean(retrieval.fellBack);
      // Dev-only observability (SPEC §22). Never logs full body / keys.
      console.log(
        `[pipeline] post-draft retrieval episodicHits=${retrieval.episodicHitsAdded} worldbookHits=${retrieval.worldbookHitsAdded} characterHits=${retrieval.characterHitsAdded} fellBack=${retrieval.fellBack}`,
      );
    } catch (error: any) {
      // Never block the pipeline on local retrieval — fall back to draftContext.
      auditFellBack = true;
      auditContext = pipelineContext;
      console.warn(
        '[pipeline] post-draft retrieval error (non-fatal):',
        error?.message,
      );
    }
    // Persist the final auditContext so resume sees the same post-draft hits.
    try {
      await store.persistTaskPipelineContext(
        taskId,
        serializePipelineTaskContext({
          draftContext: pipelineContext,
          auditContext,
          execution,
          draftCompletedAt: Date.now(),
          auditContextCreatedAt: Date.now(),
          auditFellBack,
        }),
      );
    } catch (persistError: any) {
      store.failTask(
        taskId,
        getErrorMessage(
          persistError,
          '审核上下文保存失败，已阻止继续后续阶段。',
        ),
      );
      await PipelineForeground.notifyFailed(
        taskId,
        chapter.title || '流水线',
        '审核上下文保存失败',
      );
      await PipelineForeground.stop(taskId);
      return;
    }
  }

  /* ----------------------------- twoStage ----------------------------- *
   * draft → review → proof (SEQUENTIAL). proof waits for review and receives
   * the real reviewText. factCheck is skipped. (SPEC §5.2)
   */
  if (config.pipelineMode === 'twoStage') {
    markSkipped(taskId, 'factCheck', '仅评估模式已跳过事实核查');

    onStageUpdate?.({
      stage: 'review',
      label: '正在进行文学评估',
      startedAt: Date.now(),
    });
    PipelineForeground.updateProgress(taskId, '正在进行文学评估', pct(1)).catch(
      () => {},
    );

    const reviewText = await runReviewStage({
      taskId,
      projectId: chapter.project_id,
      requestConfig,
      abortSignal,
      draftText,
      context: buildReviewContextFromSnapshot(pipelineContext),
      maxTokens: config.reviewMaxTokens,
      preset: reviewPreset,
    }).catch((error: any) => {
      if (isAbortError(error, abortSignal)) {
        return '__CANCELLED__';
      }
      return '';
    });

    if (reviewText === '__CANCELLED__') return;

    if (!reviewText.trim()) {
      // SPEC §13.2: review failed → no proof, fallback to draft.
      markSkipped(taskId, 'proof', '文学评估失败，未执行终审');
      store.failTask(taskId, '文学评估失败，已保留初稿，未生成终审稿。');
      await PipelineForeground.notifyFailed(
        taskId,
        chapter.title || '流水线',
        '文学评估失败，已保留初稿',
      );
      await saveDraftAndFinalize(draftText, { degraded: true });
      return;
    }

    onStageUpdate?.({
      stage: 'proof',
      label: '正在根据评估修订',
      startedAt: Date.now(),
    });
    PipelineForeground.updateProgress(taskId, '正在根据评估修订', pct(2)).catch(
      () => {},
    );

    let proofResult: ProofStageResult;
    try {
      proofResult = await runProofStage({
        taskId,
        projectId: chapter.project_id,
        requestConfig,
        abortSignal,
        draftText,
        reviewText,
        factCheckText: '',
        constraints: buildProofConstraintsFromSnapshot(pipelineContext),
        maxTokens: config.proofMaxTokens,
        preset: proofPreset,
      });
    } catch (error: any) {
      if (isAbortError(error, abortSignal)) return;
      proofResult = {
        text: draftText,
        succeeded: false,
        error: getErrorMessage(error, '终审失败，已回退到初稿'),
      };
    }

    await finalizeAfterProof(proofResult);
    return;
  }

  /* ----------------------------- conditional ----------------------------- *
   * draft → factCheck → proof (SEQUENTIAL). proof waits for factCheck and
   * receives the real factCheckText. review is skipped. (SPEC §5.3)
   */
  if (config.pipelineMode === 'conditional') {
    markSkipped(taskId, 'review', '仅核查模式已跳过文学评估');

    onStageUpdate?.({
      stage: 'factCheck',
      label: '正在进行事实核查',
      startedAt: Date.now(),
    });
    PipelineForeground.updateProgress(taskId, '正在进行事实核查', pct(1)).catch(
      () => {},
    );

    const factCheckText = await runFactCheckStage({
      taskId,
      projectId: chapter.project_id,
      requestConfig,
      abortSignal,
      draftText,
      context: buildFactCheckContextFromSnapshot(pipelineContext),
      maxTokens: config.factCheckMaxTokens,
      preset: factCheckPreset,
    }).catch((error: any) => {
      if (isAbortError(error, abortSignal)) {
        return '__CANCELLED__';
      }
      return '';
    });

    if (factCheckText === '__CANCELLED__') return;

    if (!factCheckText.trim()) {
      // SPEC §13.3: factCheck failed → no proof, fallback to draft.
      markSkipped(taskId, 'proof', '事实核查失败，未执行终审');
      store.failTask(taskId, '事实核查失败，已保留初稿，未生成终审稿。');
      await PipelineForeground.notifyFailed(
        taskId,
        chapter.title || '流水线',
        '事实核查失败，已保留初稿',
      );
      await saveDraftAndFinalize(draftText, { degraded: true });
      return;
    }

    onStageUpdate?.({
      stage: 'proof',
      label: '正在根据核查修订',
      startedAt: Date.now(),
    });
    PipelineForeground.updateProgress(taskId, '正在根据核查修订', pct(2)).catch(
      () => {},
    );

    let proofResult: ProofStageResult;
    try {
      proofResult = await runProofStage({
        taskId,
        projectId: chapter.project_id,
        requestConfig,
        abortSignal,
        draftText,
        reviewText: '',
        factCheckText,
        constraints: buildProofConstraintsFromSnapshot(pipelineContext),
        maxTokens: config.proofMaxTokens,
        preset: proofPreset,
      });
    } catch (error: any) {
      if (isAbortError(error, abortSignal)) return;
      proofResult = {
        text: draftText,
        succeeded: false,
        error: getErrorMessage(error, '终审失败，已回退到初稿'),
      };
    }

    await finalizeAfterProof(proofResult);
    return;
  }

  /* ----------------------------- full ----------------------------- *
   * draft → (review ∥ factCheck) → proof. Review and factCheck run in parallel
   * ONLY with each other. proof MUST wait for both. If both fail, no proof.
   * (SPEC §5.4, §6, §13.4)
   */
  onStageUpdate?.({
    stage: 'review',
    label: '正在进行文学评估与事实核查',
    startedAt: Date.now(),
  });
  PipelineForeground.updateProgress(
    taskId,
    '正在进行文学评估与事实核查',
    pct(1),
  ).catch(() => {});
  console.log('[pipeline] review/factcheck started in parallel');

  const [reviewSettled, factCheckSettled] = await Promise.allSettled([
    runReviewStage({
      taskId,
      projectId: chapter.project_id,
      requestConfig,
      abortSignal,
      draftText,
      context: buildReviewContextFromSnapshot(auditContext),
      maxTokens: config.reviewMaxTokens,
      preset: reviewPreset,
    }),
    runFactCheckStage({
      taskId,
      projectId: chapter.project_id,
      requestConfig,
      abortSignal,
      draftText,
      context: buildFactCheckContextFromSnapshot(auditContext),
      maxTokens: config.factCheckMaxTokens,
      preset: factCheckPreset,
    }),
  ]);

  // Cancellation during the parallel window: short-circuit. Either stage may
  // have already persisted cancelTask; we still stop the foreground service.
  if (abortSignal?.aborted || checkCancelled(taskId)) {
    await PipelineForeground.stop(taskId);
    return;
  }

  const reviewText =
    reviewSettled.status === 'fulfilled' ? reviewSettled.value : '';
  const factCheckText =
    factCheckSettled.status === 'fulfilled' ? factCheckSettled.value : '';
  // 防御性诊断：Promise.allSettled 的 reject 不应被静默吞掉。
  // runReviewStage / runFactCheckStage 内部已 catch 大部分异常并返回 ''，
  // 但参数求值（如 buildFactCheckContextFromSnapshot）若抛异常会让 Promise reject，
  // 此处打印 reason 便于未来排查"factCheck 被跳过"类问题。
  if (reviewSettled.status === 'rejected') {
    console.warn(
      '[pipeline] review stage rejected:',
      reviewSettled.reason?.message || reviewSettled.reason,
    );
  }
  if (factCheckSettled.status === 'rejected') {
    console.warn(
      '[pipeline] factCheck stage rejected:',
      factCheckSettled.reason?.message || factCheckSettled.reason,
    );
  }

  console.log(
    `[pipeline] review=${reviewText.trim() ? 'success' : 'failed'} factcheck=${
      factCheckText.trim() ? 'success' : 'failed'
    }`,
  );

  // SPEC §13.4: both failed → no proof, fallback to draft.
  if (!reviewText.trim() && !factCheckText.trim()) {
    markSkipped(taskId, 'proof', '文学评估与事实核查均失败，未执行终审');
    store.failTask(
      taskId,
      '文学评估与事实核查均失败，已保留初稿，未生成终审稿。',
    );
    await PipelineForeground.notifyFailed(
      taskId,
      chapter.title || '流水线',
      '评估与核查均失败，已保留初稿',
    );
    await saveDraftAndFinalize(draftText, { degraded: true });
    return;
  }

  console.log(
    `[pipeline] proof started with review=${Boolean(
      reviewText.trim(),
    )} factcheck=${Boolean(factCheckText.trim())}`,
  );
  onStageUpdate?.({
    stage: 'proof',
    label: '正在综合修订',
    startedAt: Date.now(),
  });
  PipelineForeground.updateProgress(taskId, '正在综合修订', pct(3)).catch(
    () => {},
  );

  let proofResult: ProofStageResult;
  try {
    proofResult = await runProofStage({
      taskId,
      projectId: chapter.project_id,
      requestConfig,
      abortSignal,
      draftText,
      reviewText,
      factCheckText,
      constraints: buildProofConstraintsFromSnapshot(auditContext),
      maxTokens: config.proofMaxTokens,
      preset: proofPreset,
    });
  } catch (error: any) {
    if (isAbortError(error, abortSignal)) return;
    proofResult = {
      text: draftText,
      succeeded: false,
      error: getErrorMessage(error, '终审失败，已回退到初稿'),
    };
  }

  await finalizeAfterProof(proofResult);
}

export async function runFreeformPipeline(
  taskId: string,
  projectId: number,
  documentText: string,
  steerText: string,
  onStageUpdate?: (info: StageInfo | string) => void,
  options?: PipelineRunOptions,
): Promise<void> {
  const pseudoChapter: Chapter = {
    id: 0,
    project_id: projectId,
    position: Number.MAX_SAFE_INTEGER,
    title: '自由写作',
    synopsis: steerText,
    content: documentText,
    status: 'draft',
    summary_json: null,
    created_at: '',
    updated_at: '',
  };
  await runChapterPipeline(taskId, pseudoChapter, onStageUpdate, options);
}

/* =========================================================================
 * Resume
 *
 * Resume re-runs any missing stage using the SAME corrected dependency order.
 * It must not depend on the old parallel semantics: a resumed twoStage task
 * will re-run review (if missing) THEN proof; a resumed conditional task will
 * re-run factCheck THEN proof; a resumed full task re-runs both audits THEN
 * proof. Already-succeeded stages are not re-run and the saved final text is
 * never overwritten. (SPEC §18.3)
 * ========================================================================= */

/**
 * Resume / continue — same state machine as first run.
 */
export async function resumePipeline(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (info: StageInfo | string) => void,
  options: PipelineRunOptions = {},
): Promise<void> {
  setLLMTaskQueueDefaults(taskId, {
    queueClass: options.queueClass || 'pipeline',
    queuePriority: options.queuePriority || 'manual',
  });
  const abortSignal = registerTaskAbort(taskId);
  PipelineForeground.start(
    taskId,
    chapter.title || '流水线',
    '正在恢复任务',
    0,
  ).catch(() => {});
  try {
    await reconcilePipelineTask(taskId, chapter, {
      onStageUpdate,
      abortSignal,
      isCancelled: isPipelineCancelled,
    });
  } finally {
    releaseTaskAbort(taskId);
    clearLLMTaskQueueDefaults(taskId);
    cancelledTasks.delete(taskId);
  }
}

export { reconcilePipelineTask };

async function resumePipelineInner(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (info: StageInfo | string) => void,
  abortSignal?: AbortSignal,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  const task = store.tasks.find(t => t.id === taskId);
  if (!task) throw new Error('找不到管线任务');

  // 续跑同样要趁用户点击“续跑”仍在前台时建立前台服务，不能等配置读取完成。
  PipelineForeground.start(
    taskId,
    chapter.title || '流水线',
    '正在恢复任务',
    0,
  ).catch(error => {
    console.warn(
      '[pipeline] early foreground resume start failed (non-fatal):',
      error,
    );
  });

  const completedStages = new Set(
    task.stageResults.filter(s => s.status === 'success').map(s => s.stage),
  );

  const draftResult = task.stageResults.find(
    s => s.stage === 'draft' && s.status === 'success',
  );
  const reviewResult = task.stageResults.find(
    s => s.stage === 'review' && s.status === 'success',
  );
  const factCheckResult = task.stageResults.find(
    s => s.stage === 'factCheck' && s.status === 'success',
  );

  if (!draftResult) {
    await runChapterPipelineInner(taskId, chapter, onStageUpdate, abortSignal);
    return;
  }

  // Load frozen task context first — resume must not re-read live pipeline settings
  // when a V2 execution snapshot is available.
  let parsedTaskContext: ParsedPipelineTaskContext;
  try {
    const taskRow = store.tasks.find(t => t.id === taskId);
    parsedTaskContext = parsePersistedPipelineTaskContext(
      taskRow || {
        pipelineContextJson: null,
        pipelineContextHash: null,
      },
      {
        expectedProjectId: chapter.project_id,
        expectedChapterId: chapter.id,
        expectedTaskId: taskId,
      },
    );
  } catch (error: any) {
    const message = getErrorMessage(
      error,
      '无法加载冻结的流水线上下文快照，已阻止恢复。请重新开始生成。',
    );
    store.failTask(taskId, message);
    await PipelineForeground.stop(taskId);
    throw error;
  }

  let config: PipelineConfig;
  let reviewPreset: Preset | null;
  let factCheckPreset: Preset | null;
  let proofPreset: Preset | null;
  let requestConfig: LLMRequestConfig;
  try {
    if (parsedTaskContext.execution) {
      config = configFromExecution(parsedTaskContext.execution);
      reviewPreset = presetFromFrozen(parsedTaskContext.execution.reviewPreset);
      factCheckPreset = presetFromFrozen(
        parsedTaskContext.execution.factCheckPreset,
      );
      proofPreset = presetFromFrozen(parsedTaskContext.execution.proofPreset);
      // Resolve live credentials for the frozen model id; keep frozen window.
      let live: LLMRequestConfig;
      try {
        const { resolveLLMRequestConfigById } = await import('./llm');
        live = await resolveLLMRequestConfigById(
          parsedTaskContext.execution.model.llmConfigId,
        );
      } catch {
        // Model deleted: do not silently fall back to active model.
        throw new OutlineContextError(
          'OUTLINE_MODEL_UNAVAILABLE',
          `原任务使用的模型配置（id=${parsedTaskContext.execution.model.llmConfigId}）已不可用。恢复将改变执行环境，请重新开始生成或在设置中恢复该模型。`,
          'open_llm_settings',
        );
      }
      requestConfig = requestConfigFromExecution(
        parsedTaskContext.execution,
        live,
      );
    } else {
      // V1 legacy: no frozen execution — fall back to live config with warning.
      console.warn(
        '[pipeline] resume V1 snapshot without execution freeze; using live config',
      );
      config = await db.getPipelineConfig();
      const presets = await db.getPresetsByProject(chapter.project_id);
      requestConfig = await resolveLLMRequestConfig();
      reviewPreset = resolvePreset(config.reviewPresetId, presets as Preset[]);
      factCheckPreset = resolvePreset(
        config.factCheckPresetId,
        presets as Preset[],
      );
      proofPreset = resolvePreset(config.proofPresetId, presets as Preset[]);
    }
  } catch (error: any) {
    store.failTask(taskId, getErrorMessage(error, '流水线配置读取失败'));
    await PipelineForeground.notifyFailed(
      taskId,
      chapter.title || '流水线',
      '配置读取失败',
    );
    await PipelineForeground.stop(taskId);
    return;
  }

  // Clear interrupted status when user explicitly resumes.
  if (task.status === 'interrupted' || task.status === 'failed') {
    store.setTaskStatus(taskId, 'reviewing');
  }

  const pct = (completedStageCount: number) =>
    getStageProgressPercent(config.pipelineMode, completedStageCount);

  /**
   * Persist draft content then set task terminal state.
   * Degraded: setTaskFinalText only (keep failed), no success notify.
   */
  const saveDraftAndFinalize = async (
    text: string,
    options?: { degraded?: boolean },
  ) => {
    if (abortSignal?.aborted || checkCancelled(taskId)) return;
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
    // Freeze the input fingerprint at terminal state so the result-adoption
    // flow can later detect outline/chapter drift. Uses the snapshot's outline
    // fingerprint (frozen at buildContext) and the chapter's saved updatedAt.
    try {
      const fingerprint = await computeInputFingerprint({
        projectId: chapter.project_id,
        chapterId: chapter.id,
        chapterUpdatedAt: chapter.updated_at,
        outlineFingerprint: pipelineContext.outlineFingerprint,
      });
      store.setTaskInputFingerprint(taskId, fingerprint);
    } catch {
      /* best-effort: a missing fingerprint just disables drift detection */
    }
    if (options?.degraded) {
      store.setTaskFinalText(taskId, text);
      await PipelineForeground.updateProgress(taskId, '已保留初稿', 100);
      await PipelineForeground.stop(taskId);
      return;
    }
    store.completeTask(taskId, text);
    await PipelineForeground.updateProgress(taskId, '已完成', 100);
    await PipelineForeground.notifyComplete(
      taskId,
      chapter.title || '流水线',
      '已写完，点击查看',
    );
    await PipelineForeground.stop(taskId);
  };

  const finalizeAfterProof = async (proof: ProofStageResult) => {
    if (abortSignal?.aborted || checkCancelled(taskId)) return;
    if (!proof.succeeded) {
      store.failTask(
        taskId,
        proof.error || '终审失败，已保留初稿，未生成终审稿。',
      );
      await PipelineForeground.notifyFailed(
        taskId,
        chapter.title || '流水线',
        proof.error || '终审失败，已保留初稿',
      );
      await saveDraftAndFinalize(proof.text, { degraded: true });
      return;
    }
    await saveDraftAndFinalize(proof.text);
  };

  const draftText = draftResult.text;

  if (config.pipelineMode === 'noReview') {
    await saveDraftAndFinalize(draftText);
    return;
  }

  // Schema 38+: resume MUST reuse the frozen snapshot persisted at task start.
  // Never rebuild from the live DB — mid-task outline edits would otherwise
  // change what Review / Fact Check / Proof see.
  const pipelineContext: PipelineContextSnapshot = parsedTaskContext.draftContext;
  // full mode: prefer persisted auditContext (post-draft retrieval hits).
  const auditContext: PipelineContextSnapshot =
    config.pipelineMode === 'full'
      ? resolveAuditContext(parsedTaskContext)
      : pipelineContext;

  // If full mode still lacks auditContext after a successful draft, rebuild
  // post-draft retrieval from the frozen draftContext + draft text only when
  // audit was never written (interrupted between draft success and audit persist).
  let effectiveAuditContext = auditContext;
  if (
    config.pipelineMode === 'full' &&
    !parsedTaskContext.auditContext &&
    !completedStages.has('review')
  ) {
    try {
      const contextConfig = await db.getContextConfig();
      const retrieval = await buildPostDraftAuditContext(
        pipelineContext,
        draftText,
        chapter.project_id,
        chapter,
        contextConfig,
      );
      effectiveAuditContext = retrieval.snapshot;
      if (parsedTaskContext.execution) {
        await store.persistTaskPipelineContext(
          taskId,
          serializePipelineTaskContext({
            draftContext: pipelineContext,
            auditContext: effectiveAuditContext,
            execution: parsedTaskContext.execution,
            draftCompletedAt: Date.now(),
            auditContextCreatedAt: Date.now(),
            auditFellBack: Boolean(retrieval.fellBack),
          }),
        );
      }
    } catch (error: any) {
      console.warn(
        '[pipeline] resume post-draft retrieval error (using draft context):',
        error?.message,
      );
      effectiveAuditContext = pipelineContext;
    }
  }

  let reviewText = reviewResult?.text || '';
  let factCheckText = factCheckResult?.text || '';

  /* ---------------- twoStage resume: review THEN proof ---------------- */
  if (config.pipelineMode === 'twoStage') {
    if (!completedStages.has('review')) {
      if (checkCancelled(taskId)) return;
      markSkipped(taskId, 'factCheck', '仅评估模式已跳过事实核查');
      onStageUpdate?.({
        stage: 'review',
        label: '正在进行文学评估',
        startedAt: Date.now(),
      });
      PipelineForeground.updateProgress(
        taskId,
        '正在进行文学评估',
        pct(1),
      ).catch(() => {});
      reviewText = await runReviewStage({
        taskId,
        projectId: chapter.project_id,
        requestConfig,
        abortSignal,
        draftText,
        context: buildReviewContextFromSnapshot(pipelineContext),
        maxTokens: config.reviewMaxTokens,
        preset: reviewPreset,
      }).catch((error: any) => {
        if (isAbortError(error, abortSignal)) return '__CANCELLED__';
        return '';
      });
      if (reviewText === '__CANCELLED__') return;
    }

    if (!reviewText.trim()) {
      markSkipped(taskId, 'proof', '文学评估失败，未执行终审');
      store.failTask(taskId, '文学评估失败，已保留初稿，未生成终审稿。');
      await PipelineForeground.notifyFailed(
        taskId,
        chapter.title || '流水线',
        '文学评估失败，已保留初稿',
      );
      await saveDraftAndFinalize(draftText, { degraded: true });
      return;
    }

    if (checkCancelled(taskId)) return;
    onStageUpdate?.({
      stage: 'proof',
      label: '正在根据评估修订',
      startedAt: Date.now(),
    });
    PipelineForeground.updateProgress(taskId, '正在根据评估修订', pct(2)).catch(
      () => {},
    );
    let proofResult: ProofStageResult;
    try {
      proofResult = await runProofStage({
        taskId,
        projectId: chapter.project_id,
        requestConfig,
        abortSignal,
        draftText,
        reviewText,
        factCheckText: '',
        constraints: buildProofConstraintsFromSnapshot(pipelineContext),
        maxTokens: config.proofMaxTokens,
        preset: proofPreset,
      });
    } catch (error: any) {
      if (isAbortError(error, abortSignal)) return;
      proofResult = {
        text: draftText,
        succeeded: false,
        error: getErrorMessage(error, '终审失败，已回退到初稿'),
      };
    }
    await finalizeAfterProof(proofResult);
    return;
  }

  /* --------------- conditional resume: factCheck THEN proof --------------- */
  if (config.pipelineMode === 'conditional') {
    if (!completedStages.has('factCheck')) {
      if (checkCancelled(taskId)) return;
      markSkipped(taskId, 'review', '仅核查模式已跳过文学评估');
      onStageUpdate?.({
        stage: 'factCheck',
        label: '正在进行事实核查',
        startedAt: Date.now(),
      });
      PipelineForeground.updateProgress(
        taskId,
        '正在进行事实核查',
        pct(1),
      ).catch(() => {});
      factCheckText = await runFactCheckStage({
        taskId,
        projectId: chapter.project_id,
        requestConfig,
        abortSignal,
        draftText,
        context: buildFactCheckContextFromSnapshot(pipelineContext),
        maxTokens: config.factCheckMaxTokens,
        preset: factCheckPreset,
      }).catch((error: any) => {
        if (isAbortError(error, abortSignal)) return '__CANCELLED__';
        return '';
      });
      if (factCheckText === '__CANCELLED__') return;
    }

    if (!factCheckText.trim()) {
      markSkipped(taskId, 'proof', '事实核查失败，未执行终审');
      store.failTask(taskId, '事实核查失败，已保留初稿，未生成终审稿。');
      await PipelineForeground.notifyFailed(
        taskId,
        chapter.title || '流水线',
        '事实核查失败，已保留初稿',
      );
      await saveDraftAndFinalize(draftText, { degraded: true });
      return;
    }

    if (checkCancelled(taskId)) return;
    onStageUpdate?.({
      stage: 'proof',
      label: '正在根据核查修订',
      startedAt: Date.now(),
    });
    PipelineForeground.updateProgress(taskId, '正在根据核查修订', pct(2)).catch(
      () => {},
    );
    let proofResult: ProofStageResult;
    try {
      proofResult = await runProofStage({
        taskId,
        projectId: chapter.project_id,
        requestConfig,
        abortSignal,
        draftText,
        reviewText: '',
        factCheckText,
        constraints: buildProofConstraintsFromSnapshot(pipelineContext),
        maxTokens: config.proofMaxTokens,
        preset: proofPreset,
      });
    } catch (error: any) {
      if (isAbortError(error, abortSignal)) return;
      proofResult = {
        text: draftText,
        succeeded: false,
        error: getErrorMessage(error, '终审失败，已回退到初稿'),
      };
    }
    await finalizeAfterProof(proofResult);
    return;
  }

  /* --------------- full resume: review + factCheck THEN proof --------------- */
  // Re-run whichever audit is missing. Use effectiveAuditContext so post-draft
  // retrieval hits match the normal full-mode path.
  if (!completedStages.has('review') && !completedStages.has('factCheck')) {
    // Both missing: run them in parallel exactly like the first run.
    if (checkCancelled(taskId)) return;
    onStageUpdate?.({
      stage: 'review',
      label: '正在进行文学评估与事实核查',
      startedAt: Date.now(),
    });
    PipelineForeground.updateProgress(
      taskId,
      '正在进行文学评估与事实核查',
      pct(1),
    ).catch(() => {});

    const [reviewSettled, factCheckSettled] = await Promise.allSettled([
      runReviewStage({
        taskId,
        projectId: chapter.project_id,
        requestConfig,
        abortSignal,
        draftText,
        context: buildReviewContextFromSnapshot(effectiveAuditContext),
        maxTokens: config.reviewMaxTokens,
        preset: reviewPreset,
      }),
      runFactCheckStage({
        taskId,
        projectId: chapter.project_id,
        requestConfig,
        abortSignal,
        draftText,
        context: buildFactCheckContextFromSnapshot(effectiveAuditContext),
        maxTokens: config.factCheckMaxTokens,
        preset: factCheckPreset,
      }),
    ]);
    if (abortSignal?.aborted || checkCancelled(taskId)) {
      await PipelineForeground.stop(taskId);
      return;
    }
    reviewText =
      reviewSettled.status === 'fulfilled' ? reviewSettled.value : '';
    factCheckText =
      factCheckSettled.status === 'fulfilled' ? factCheckSettled.value : '';
  } else {
    // At least one done; re-run only the missing one (sequentially is fine).
    if (!completedStages.has('review')) {
      if (checkCancelled(taskId)) return;
      onStageUpdate?.({
        stage: 'review',
        label: '正在进行文学评估',
        startedAt: Date.now(),
      });
      PipelineForeground.updateProgress(
        taskId,
        '正在进行文学评估',
        pct(1),
      ).catch(() => {});
      reviewText = await runReviewStage({
        taskId,
        projectId: chapter.project_id,
        requestConfig,
        abortSignal,
        draftText,
        context: buildReviewContextFromSnapshot(effectiveAuditContext),
        maxTokens: config.reviewMaxTokens,
        preset: reviewPreset,
      }).catch((error: any) => {
        if (isAbortError(error, abortSignal)) return '__CANCELLED__';
        return '';
      });
      if (reviewText === '__CANCELLED__') return;
    }
    if (!completedStages.has('factCheck')) {
      if (checkCancelled(taskId)) return;
      onStageUpdate?.({
        stage: 'factCheck',
        label: '正在进行事实核查',
        startedAt: Date.now(),
      });
      PipelineForeground.updateProgress(
        taskId,
        '正在进行事实核查',
        pct(2),
      ).catch(() => {});
      factCheckText = await runFactCheckStage({
        taskId,
        projectId: chapter.project_id,
        requestConfig,
        abortSignal,
        draftText,
        context: buildFactCheckContextFromSnapshot(effectiveAuditContext),
        maxTokens: config.factCheckMaxTokens,
        preset: factCheckPreset,
      }).catch((error: any) => {
        if (isAbortError(error, abortSignal)) return '__CANCELLED__';
        return '';
      });
      if (factCheckText === '__CANCELLED__') return;
    }
  }

  if (!reviewText.trim() && !factCheckText.trim()) {
    markSkipped(taskId, 'proof', '文学评估与事实核查均失败，未执行终审');
    store.failTask(
      taskId,
      '文学评估与事实核查均失败，已保留初稿，未生成终审稿。',
    );
    await PipelineForeground.notifyFailed(
      taskId,
      chapter.title || '流水线',
      '评估与核查均失败，已保留初稿',
    );
    await saveDraftAndFinalize(draftText, { degraded: true });
    return;
  }

  if (checkCancelled(taskId)) return;
  onStageUpdate?.({
    stage: 'proof',
    label: '正在综合修订',
    startedAt: Date.now(),
  });
  PipelineForeground.updateProgress(taskId, '正在综合修订', pct(3)).catch(
    () => {},
  );
  let proofResult: ProofStageResult;
  try {
    proofResult = await runProofStage({
      taskId,
      projectId: chapter.project_id,
      requestConfig,
      abortSignal,
      draftText,
      reviewText,
      factCheckText,
      constraints: buildProofConstraintsFromSnapshot(effectiveAuditContext),
      maxTokens: config.proofMaxTokens,
      preset: proofPreset,
    });
  } catch (error: any) {
    if (isAbortError(error, abortSignal)) return;
    proofResult = {
      text: draftText,
      succeeded: false,
      error: getErrorMessage(error, '终审失败，已回退到初稿'),
    };
  }
  await finalizeAfterProof(proofResult);
}

import * as db from './database';
import {
  callLLMResult,
  resolveLLMRequestConfig,
  type LLMRequestConfig,
} from './llm';
import { buildContext } from './contextBuilder';
import { createChapterGenerationRequest } from './chapterGeneration';
import {
  buildDraftMessages,
  buildReviewMessages,
  buildFactCheckMessages,
  buildProofMessages,
  buildReviewRepairMessages,
  buildFactCheckRepairMessages,
} from './pipelineMessages';
import {
  buildReviewContextFromSnapshot,
  buildFactCheckContextFromSnapshot,
  buildProofConstraintsFromSnapshot,
  type FactCheckContext,
  type PipelineContextSnapshot,
  type ProofConstraints,
  type ReviewContext,
} from '../types/pipelineContext';
import { buildPostDraftAuditContext } from './postDraftRetrieval';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { saveDraft } from './draftService';
import { PipelineForeground } from '../native/PipelineForegroundModule';
import { getStageProgressPercent } from '../utils/stages';
import type { Chapter, Preset } from '../types/novel';
import type { PipelineStageName, PipelineTaskStatus } from '../types/pipeline';
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

const cancelledTasks = new Set<string>();
const taskAbortControllers = new Map<string, AbortController>();

export function cancelPipeline(taskId: string): void {
  cancelledTasks.add(taskId);
  // 不等待网络或原生回调：用户明确停止时必须先把终态写入 SQLite，
  // 否则进程在 prefill 中被关闭后，冷启动会把旧任务错误地显示为仍在运行。
  usePipelineTaskStore.getState().cancelTask(taskId);
  PipelineForeground.stop(taskId).catch(() => {});
  const controller = taskAbortControllers.get(taskId);
  if (controller) {
    controller.abort();
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
): Preset | null {
  if (presetId != null) {
    const found = presets.find(p => p.id === presetId);
    if (found) return found;
    // resolvePreset 静默回退修复：presetId 找不到时（被删除/换项目）不报错，
    // 静默用第一个 preset，用户以为用自定义预设实际用默认
    console.warn(
      `[pipeline] presetId=${presetId} not found, falling back to first preset`,
    );
  }
  return presets[0] || null;
}

function checkCancelled(taskId: string): boolean {
  if (cancelledTasks.has(taskId)) {
    cancelledTasks.delete(taskId);
    usePipelineTaskStore.getState().cancelTask(taskId);
    return true;
  }
  return false;
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
    const first = await callLLMResult(
      buildReviewMessages(args.draftText, args.context),
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
    tokens = accumulateTokens(tokens, first);

    let validation = validateReviewResult(first, args.draftText);
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

      const retry = await callLLMResult(
        buildReviewRepairMessages(
          args.draftText,
          args.context,
          describeAuditFailureReason(validation.reason),
        ),
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
      tokens = accumulateTokens(tokens, retry);
      validation = validateReviewResult(retry, args.draftText);
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
    const first = await callLLMResult(
      buildFactCheckMessages(args.draftText, args.context),
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

      const retry = await callLLMResult(
        buildFactCheckRepairMessages(
          args.draftText,
          args.context,
          describeAuditFailureReason(validation.reason),
        ),
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

/**
 * Proof / final-revision stage. Never uses reasoning_content as the final
 * manuscript. Empty content → failed + draft fallback.
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
): Promise<string> {
  const { taskId, projectId, requestConfig, abortSignal } = args;
  const store = usePipelineTaskStore.getState();
  if (abortSignal?.aborted || checkCancelled(taskId)) {
    throw new Error('cancelled');
  }
  store.setTaskStatus(taskId, 'proofing');
  const start = Date.now();
  try {
    const result = await callLLMResult(
      buildProofMessages(
        args.draftText,
        args.reviewText,
        args.factCheckText,
        args.constraints,
      ),
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
    // Strict: only official content may become the final manuscript.
    const content =
      typeof result.text === 'string' && result.text.trim().length > 0
        ? result.text
        : null;
    if (!content) {
      const hasReasoning =
        typeof result.reasoningText === 'string' &&
        result.reasoningText.trim().length > 0;
      store.updateTaskStage(taskId, {
        stage: 'proof',
        text: args.draftText,
        status: 'failed',
        error: hasReasoning
          ? '终审仅返回推理内容，已回退到初稿'
          : '终审输出为空，已回退到初稿',
        tokens: {
          input: result.inputTokens,
          output: result.outputTokens,
          total: result.totalTokens,
        },
        durationMs: Date.now() - start,
      });
      return args.draftText;
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
    return content;
  } catch (error: any) {
    if (isAbortError(error, abortSignal)) {
      store.cancelTask(taskId);
      await PipelineForeground.stop(taskId);
      throw error;
    }
    // SPEC §13.5: proof failure falls back to the draft, marked as failed so
    // the UI can distinguish "real proof" from "fallback draft".
    store.updateTaskStage(taskId, {
      stage: 'proof',
      text: args.draftText,
      status: 'failed',
      error: error.message || '终审失败，已回退到初稿',
      durationMs: Date.now() - start,
    });
    return args.draftText;
  }
}

/* =========================================================================
 * Entry points
 * ========================================================================= */

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
    await runChapterPipelineInner(taskId, chapter, onStageUpdate, abortSignal);
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

    // 本地模型 CPU 推理能力有限，自动收紧上下文预算，避免 prefill 阶段耗时数分钟。
    if (requestConfig.provider_type === 'llama_cpp') {
      contextConfig = {
        ...contextConfig,
        slidingWindowSize: Math.min(contextConfig.slidingWindowSize, 1024),
        summaryBudgetTokens: Math.min(
          contextConfig.summaryBudgetTokens ?? 20000,
          1024,
        ),
        resourceBudget: Math.min(contextConfig.resourceBudget, 512),
        worldbookScanDepth: Math.min(contextConfig.worldbookScanDepth ?? 4, 1),
      };
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

  // 通知栏进度计算封装到 utils/stages，便于测试与 resume 共用。
  // 阶段"开始"时跳到该阶段起点，saveDraftAndComplete 时设 100，
  // 让用户在通知栏看到进度条单调递增。
  const pct = (completedStages: number) =>
    getStageProgressPercent(config.pipelineMode, completedStages);

  /**
   * Persist draft/final text and close the task.
   * `degraded: true` is for audit-failed / proof-skipped paths: keep prior
   * failTask error, never send a "已写完" success notification.
   */
  const saveDraftAndComplete = async (
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
    store.completeTask(taskId, text);
    if (options?.degraded) {
      await PipelineForeground.updateProgress(taskId, '已保留初稿', 100);
      await PipelineForeground.stop(taskId);
      return;
    }
    await PipelineForeground.updateProgress(taskId, '已完成', 100);
    await PipelineForeground.notifyComplete(
      taskId,
      chapter.title || '流水线',
      '已写完，点击查看',
    );
    await PipelineForeground.stop(taskId);
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
    const request = createChapterGenerationRequest(chapter);
    const { messages: baseContext, chapters: allChapters, pipelineContext: ctx } =
      await buildContext(
        chapter,
        contextConfig,
        chapter.project_id,
        draftPreset || undefined,
        { retrievalUserPrompt: request.userPrompt },
      );
    pipelineContext = ctx;

    // Extract previous chapter ending from already-fetched chapters.
    const prevChapter = allChapters
      .filter(c => c.position < chapter.position && c.content)
      .sort((a, b) => b.position - a.position)[0];
    const prevEnding = prevChapter?.content?.slice(-800) || '';

    const draftMessages = buildDraftMessages(
      baseContext,
      chapter.title || `第 ${chapter.position + 1} 章`,
      chapter.content || '',
      request.userPrompt,
      prevEnding,
      chapter.synopsis,
    );

    const draftResult = await callLLMResult(
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
    draftText = draftResult.text || '';

    store.updateTaskStage(taskId, {
      stage: 'draft',
      text: draftText,
      status: 'success',
      tokens: {
        input: draftResult.inputTokens,
        output: draftResult.outputTokens,
        total: draftResult.totalTokens,
      },
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
    await saveDraftAndComplete(draftText);
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
    try {
      const retrieval = await buildPostDraftAuditContext(
        pipelineContext,
        draftText,
        chapter.project_id,
        chapter,
        contextConfig,
      );
      auditContext = retrieval.snapshot;
      // Dev-only observability (SPEC §22). Never logs full body / keys.
      console.log(
        `[pipeline] post-draft retrieval episodicHits=${retrieval.episodicHitsAdded} worldbookHits=${retrieval.worldbookHitsAdded} characterHits=${retrieval.characterHitsAdded} fellBack=${retrieval.fellBack}`,
      );
    } catch (error: any) {
      // Never block the pipeline on local retrieval.
      console.warn(
        '[pipeline] post-draft retrieval error (non-fatal):',
        error?.message,
      );
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
      store.failTask(
        taskId,
        '文学评估失败，已保留初稿，未生成终审稿。',
      );
      await PipelineForeground.notifyFailed(
        taskId,
        chapter.title || '流水线',
        '文学评估失败，已保留初稿',
      );
      await saveDraftAndComplete(draftText, { degraded: true });
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

    const finalText = await runProofStage({
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
    }).catch((error: any) => {
      if (isAbortError(error, abortSignal)) {
        return '__CANCELLED__';
      }
      return draftText;
    });

    if (finalText === '__CANCELLED__') return;

    await saveDraftAndComplete(finalText);
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
      store.failTask(
        taskId,
        '事实核查失败，已保留初稿，未生成终审稿。',
      );
      await PipelineForeground.notifyFailed(
        taskId,
        chapter.title || '流水线',
        '事实核查失败，已保留初稿',
      );
      await saveDraftAndComplete(draftText, { degraded: true });
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

    const finalText = await runProofStage({
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
    }).catch((error: any) => {
      if (isAbortError(error, abortSignal)) {
        return '__CANCELLED__';
      }
      return draftText;
    });

    if (finalText === '__CANCELLED__') return;

    await saveDraftAndComplete(finalText);
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

  console.log(
    `[pipeline] review=${reviewText.trim() ? 'success' : 'failed'} factcheck=${factCheckText.trim() ? 'success' : 'failed'}`,
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
    await saveDraftAndComplete(draftText, { degraded: true });
    return;
  }

  console.log(
    `[pipeline] proof started with review=${Boolean(reviewText.trim())} factcheck=${Boolean(factCheckText.trim())}`,
  );
  onStageUpdate?.({
    stage: 'proof',
    label: '正在综合修订',
    startedAt: Date.now(),
  });
  PipelineForeground.updateProgress(taskId, '正在综合修订', pct(3)).catch(
    () => {},
  );

  const finalText = await runProofStage({
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
  }).catch((error: any) => {
    if (isAbortError(error, abortSignal)) {
      return '__CANCELLED__';
    }
    return draftText;
  });

  if (finalText === '__CANCELLED__') return;

  await saveDraftAndComplete(finalText);
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
  try {
    await resumePipelineInner(taskId, chapter, onStageUpdate, abortSignal);
  } finally {
    releaseTaskAbort(taskId);
    clearLLMTaskQueueDefaults(taskId);
    cancelledTasks.delete(taskId);
  }
}

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
  const reviewPreset = resolvePreset(
    config.reviewPresetId,
    presets as Preset[],
  );
  const factCheckPreset = resolvePreset(
    config.factCheckPresetId,
    presets as Preset[],
  );
  const proofPreset = resolvePreset(config.proofPresetId, presets as Preset[]);

  const pct = (completedStageCount: number) =>
    getStageProgressPercent(config.pipelineMode, completedStageCount);

  /**
   * Persist draft/final text and close the task.
   * `degraded: true` is for audit-failed / proof-skipped paths: keep prior
   * failTask error, never send a "已写完" success notification.
   */
  const saveDraftAndComplete = async (
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
    store.completeTask(taskId, text);
    if (options?.degraded) {
      await PipelineForeground.updateProgress(taskId, '已保留初稿', 100);
      await PipelineForeground.stop(taskId);
      return;
    }
    await PipelineForeground.updateProgress(taskId, '已完成', 100);
    await PipelineForeground.notifyComplete(
      taskId,
      chapter.title || '流水线',
      '已写完，点击查看',
    );
    await PipelineForeground.stop(taskId);
  };

  const draftText = draftResult.text;

  if (config.pipelineMode === 'noReview') {
    await saveDraftAndComplete(draftText);
    return;
  }

  // Rebuild the shared snapshot for downstream stages. Resume is allowed to
  // rebuild the snapshot because the original in-memory snapshot was lost when
  // the previous process died; this read-only rebuild produces the same view
  // buildContext would have produced. (SPEC §18.3 — does not modify saved
  // final text, only re-derives the audit context.)
  let pipelineContext: PipelineContextSnapshot;
  try {
    const built = await buildContext(
      chapter,
      contextConfig,
      chapter.project_id,
      presets[0],
    );
    pipelineContext = built.pipelineContext;
  } catch (error: any) {
    // Snapshot rebuild failed: fall back to an empty snapshot so stages still
    // run with whatever the draft stored, rather than blocking resume.
    console.warn(
      '[pipeline] resume snapshot rebuild failed (non-fatal):',
      error?.message,
    );
    pipelineContext = {
      presetText: '',
      storyMemoryText: '',
      characterText: '',
      noteText: '',
      worldbookText: '',
      episodicMemoryText: '',
      recentBridgeText: '',
      currentInstructionText: '',
      retrievalUserPrompt: '',
    };
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
      await saveDraftAndComplete(draftText, { degraded: true });
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
    const finalText = await runProofStage({
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
    }).catch((error: any) => {
      if (isAbortError(error, abortSignal)) return '__CANCELLED__';
      return draftText;
    });
    if (finalText === '__CANCELLED__') return;
    await saveDraftAndComplete(finalText);
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
      await saveDraftAndComplete(draftText, { degraded: true });
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
    const finalText = await runProofStage({
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
    }).catch((error: any) => {
      if (isAbortError(error, abortSignal)) return '__CANCELLED__';
      return draftText;
    });
    if (finalText === '__CANCELLED__') return;
    await saveDraftAndComplete(finalText);
    return;
  }

  /* --------------- full resume: review + factCheck THEN proof --------------- */
  // Re-run whichever audit is missing. Conditional semantics: both audits may
  // already be done (only proof missing), one may be done, or both missing.
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
        context: buildReviewContextFromSnapshot(pipelineContext),
        maxTokens: config.reviewMaxTokens,
        preset: reviewPreset,
      }),
      runFactCheckStage({
        taskId,
        projectId: chapter.project_id,
        requestConfig,
        abortSignal,
        draftText,
        context: buildFactCheckContextFromSnapshot(pipelineContext),
        maxTokens: config.factCheckMaxTokens,
        preset: factCheckPreset,
      }),
    ]);
    if (abortSignal?.aborted || checkCancelled(taskId)) {
      await PipelineForeground.stop(taskId);
      return;
    }
    reviewText = reviewSettled.status === 'fulfilled' ? reviewSettled.value : '';
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
        context: buildReviewContextFromSnapshot(pipelineContext),
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
        context: buildFactCheckContextFromSnapshot(pipelineContext),
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
    await saveDraftAndComplete(draftText, { degraded: true });
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
  const finalText = await runProofStage({
    taskId,
    projectId: chapter.project_id,
    requestConfig,
    abortSignal,
    draftText,
    reviewText,
    factCheckText,
    constraints: buildProofConstraintsFromSnapshot(pipelineContext),
    maxTokens: config.proofMaxTokens,
    preset: proofPreset,
  }).catch((error: any) => {
    if (isAbortError(error, abortSignal)) return '__CANCELLED__';
    return draftText;
  });
  if (finalText === '__CANCELLED__') return;
  await saveDraftAndComplete(finalText);
}

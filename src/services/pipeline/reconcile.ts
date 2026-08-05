/**
 * Single durable pipeline state machine entry.
 *
 * runChapterPipeline / resumePipeline are thin wrappers over this loop.
 * Each iteration reloads SQLite-backed state, plans via
 * determineNextPipelineAction, CAS-claims when needed, executes one action,
 * awaits persistence, then plans again.
 */
import * as db from '../database';
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
  buildPostDraftAuditContextFromFrozen,
  captureFrozenAuditCandidates,
} from '../postDraftRetrieval';
import { usePipelineTaskStore } from '../../store/pipelineTaskStore';
import { saveDraft } from '../draftService';
import { PipelineForeground } from '../../native/PipelineForegroundModule';
import { getStageProgressPercent } from '../../utils/stages';
import type { Chapter, Preset } from '../../types/novel';
import type { PipelineConfig, PipelineStageName } from '../../types/pipeline';
import {
  describeAuditFailureReason,
  formatAuditFailureMessage,
  logPipelineAudit,
  validateFactCheckResult,
  validateReviewResult,
} from '../pipelineAuditValidator';
import type { LLMResult } from '../llm/types';
import {
  parsePersistedPipelineTaskContext,
  serializePipelineTaskContext,
  type ParsedPipelineTaskContext,
} from '../pipelineTaskContext';
import { determineNextPipelineAction } from './determineNextPipelineAction';
import {
  buildPersistedTaskView,
  resolveStageCheckpoints,
} from './taskView';
import {
  compileDraftFromFrozenRequest,
  compileDraftStageRequest,
  compileFactCheckStageRequest,
  compileProofStageRequest,
  compileReviewStageRequest,
  requireReadyStageRequest,
  type ReadyStageRequest,
} from './compileStageRequest';
import { executeClaimedStage } from './executeClaimedStage';
import { mapOutlineErrorToPipelineError } from './errors';
import type { PipelineAction } from './types';

export type StageInfo = {
  stage: PipelineStageName | 'idle';
  label: string;
  startedAt: number;
};

export interface ReconcileOptions {
  onStageUpdate?: (info: StageInfo | string) => void;
  abortSignal?: AbortSignal;
  isCancelled?: (taskId: string) => boolean;
  registerCancel?: (taskId: string) => void;
}

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
  extras?: { responseFormat?: 'json_object' },
) {
  return {
    temperature: preset?.temperature,
    top_p: preset?.top_p,
    max_tokens: maxTokens,
    scenario,
    projectId,
    taskId,
    responseFormat: extras?.responseFormat,
    requestConfig,
  };
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

  const store = usePipelineTaskStore.getState();
  const onStageUpdate = options.onStageUpdate;
  const abortSignal = options.abortSignal;

  PipelineForeground.start(
    taskId,
    chapter.title || '流水线',
    '正在准备写作',
    0,
  ).catch(() => {});

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

      if (action.type === 'blocked') {
        await handleBlocked(taskId, chapter, action, stages);
        return;
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
      store.cancelTask(taskId);
      await PipelineForeground.stop(taskId);
      return;
    }
    const mapped = mapOutlineErrorToPipelineError(error);
    const message =
      mapped?.message || getErrorMessage(error, '流水线执行失败');
    if (store.persistFailTask) {
      await store.persistFailTask(taskId, message);
    } else {
      store.failTask(taskId, message);
    }
    await PipelineForeground.notifyFailed(
      taskId,
      chapter.title || '流水线',
      mapped?.message || '执行失败',
    );
    await PipelineForeground.stop(taskId);
  } finally {
    reconciling.delete(taskId);
  }
}

async function handleBlocked(
  taskId: string,
  chapter: Chapter,
  action: Extract<PipelineAction, { type: 'blocked' }>,
  stages: ReturnType<typeof resolveStageCheckpoints>,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  const code = action.reason.code;
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
      await store.persistFailTask(taskId, action.reason.message);
    } else {
      store.failTask(taskId, action.reason.message);
    }
    await PipelineForeground.notifyFailed(
      taskId,
      chapter.title || '流水线',
      action.reason.message,
    );
    await PipelineForeground.stop(taskId);
    return;
  }
  if (store.persistFailTask) {
    await store.persistFailTask(taskId, action.reason.message);
  } else {
    store.failTask(taskId, action.reason.message);
  }
  await PipelineForeground.notifyFailed(
    taskId,
    chapter.title || '流水线',
    action.reason.message,
  );
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
      await actionFinalizeFromDraft(taskId, chapter, action.degraded === true);
      return 'continue';
    case 'finalize_from_proof':
      await actionFinalizeFromProof(taskId, chapter);
      return 'continue';
    case 'complete':
      await actionComplete(taskId, chapter);
      return 'stop';
    case 'blocked':
      await handleBlocked(taskId, chapter, action, params.stages);
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
  const runtime = await loadRuntime(taskId, chapter);
  // Fresh freeze from live config only when no execution yet.
  const execution =
    runtime.parsed?.execution ||
    buildExecutionSnapshot({
      config: runtime.config,
      draftPreset: runtime.draftPreset,
      reviewPreset: runtime.reviewPreset,
      factCheckPreset: runtime.factCheckPreset,
      proofPreset: runtime.proofPreset,
      requestConfig: runtime.requestConfig,
    });

  const compiled = await compileDraftStageRequest({
    chapter,
    requestConfig: runtime.requestConfig,
    draftPreset: runtime.draftPreset,
    draftMaxTokens: execution.draftMaxTokens,
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
      PipelineForeground.updateProgress(taskId, '正在生成初稿', 0).catch(
        () => {},
      );
    },
    run: async () => {
      const store = usePipelineTaskStore.getState();
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

      // Draft must send frozen messages — never recompile from live project data.
      const firstCompile = compileDraftFromFrozenRequest({
        frozen: runtime.parsed.frozenDraftRequest,
      });
      const firstReady = requireReadyStageRequest(firstCompile);
      const start = Date.now();
      let tokens = { input: 0, output: 0, total: 0 };

      try {
        let result = await callReadyLLM(
          firstReady,
          runtime.config.draftMaxTokens,
          buildCallConfig(
            runtime.draftPreset,
            runtime.config.draftMaxTokens,
            'pipeline_draft',
            chapter.project_id,
            runtime.requestConfig,
            taskId,
          ),
          abortSignal,
        );
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
          result = await callReadyLLM(
            retryCompile,
            runtime.config.draftMaxTokens,
            buildCallConfig(
              runtime.draftPreset,
              runtime.config.draftMaxTokens,
              'pipeline_draft',
              chapter.project_id,
              runtime.requestConfig,
              taskId,
            ),
            abortSignal,
          );
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
          store.cancelTask(taskId);
          await PipelineForeground.stop(taskId);
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
      const store = usePipelineTaskStore.getState();
      const runtime = await loadRuntime(taskId, chapter);
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

      try {
        const first = await callReadyLLM(
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
        );
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
          const repair = compileReviewStageRequest({
            draftText,
            context,
            maxTokens: runtime.config.reviewMaxTokens,
            contextWindow: runtime.requestConfig.context_window || 0,
            repairReason: describeAuditFailureReason(validation.reason),
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
          const retry = await callReadyLLM(
            repair,
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
          );
          if (cancelled(taskId, options)) {
            const err = new Error('任务已取消') as Error & { code?: string };
            err.code = 'cancelled';
            throw err;
          }
          tokens = accumulateTokens(tokens, retry);
          validation = validateReviewResult(retry, draftText, { hasOutline });
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
          error: formatAuditFailureMessage('review', validation.reason),
          tokens,
          durationMs: Date.now() - start,
        });
      } catch (error: any) {
        if (isAbortError(error, abortSignal)) {
          store.cancelTask(taskId);
          await PipelineForeground.stop(taskId);
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
      const store = usePipelineTaskStore.getState();
      const runtime = await loadRuntime(taskId, chapter);
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

      try {
        const first = await callReadyLLM(
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
        );
        if (cancelled(taskId, options)) {
          const err = new Error('任务已取消') as Error & { code?: string };
          err.code = 'cancelled';
          throw err;
        }
        tokens = accumulateTokens(tokens, first);
        let validation = validateFactCheckResult(first, draftText);
        if (!validation.valid) {
          const repair = compileFactCheckStageRequest({
            draftText,
            context,
            maxTokens: runtime.config.factCheckMaxTokens,
            contextWindow: runtime.requestConfig.context_window || 0,
            repairReason: describeAuditFailureReason(validation.reason),
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
          const retry = await callReadyLLM(
            repair,
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
          );
          if (cancelled(taskId, options)) {
            const err = new Error('任务已取消') as Error & { code?: string };
            err.code = 'cancelled';
            throw err;
          }
          tokens = accumulateTokens(tokens, retry);
          validation = validateFactCheckResult(retry, draftText);
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
          error: formatAuditFailureMessage('factCheck', validation.reason),
          tokens,
          durationMs: Date.now() - start,
        });
      } catch (error: any) {
        if (isAbortError(error, abortSignal)) {
          store.cancelTask(taskId);
          await PipelineForeground.stop(taskId);
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
      const store = usePipelineTaskStore.getState();
      const runtime = await loadRuntime(taskId, chapter);
      PipelineForeground.updateProgress(
        taskId,
        '正在综合修订',
        getStageProgressPercent(runtime.config.pipelineMode, 2),
      ).catch(() => {});

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

      try {
        const result = await callReadyLLM(
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
        );
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
          store.cancelTask(taskId);
          await PipelineForeground.stop(taskId);
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
    await PipelineForeground.notifyFailed(
      taskId,
      chapter.title || '流水线',
      message,
    );
    await PipelineForeground.updateProgress(taskId, '已保留初稿', 100);
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
  await PipelineForeground.updateProgress(taskId, '已完成', 100);
  await PipelineForeground.notifyComplete(
    taskId,
    chapter.title || '流水线',
    '已写完，点击查看',
  );
  await PipelineForeground.stop(taskId);
}

async function actionFinalizeFromProof(
  taskId: string,
  chapter: Chapter,
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
  await PipelineForeground.updateProgress(taskId, '已完成', 100);
  await PipelineForeground.notifyComplete(
    taskId,
    chapter.title || '流水线',
    '已写完，点击查看',
  );
  await PipelineForeground.stop(taskId);
}

async function actionComplete(taskId: string, chapter: Chapter): Promise<void> {
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
  await PipelineForeground.updateProgress(taskId, '已完成', 100);
  await PipelineForeground.notifyComplete(
    taskId,
    chapter.title || '流水线',
    '已写完，点击查看',
  );
  await PipelineForeground.stop(taskId);
}

export function isReconcileActive(taskId: string): boolean {
  return reconciling.has(taskId);
}

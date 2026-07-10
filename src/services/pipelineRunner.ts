import * as db from './database';
import { callLLMResult, resolveLLMRequestConfig, type LLMRequestConfig } from './llm';
import { buildContext } from './contextBuilder';
import { createChapterGenerationRequest } from './chapterGeneration';
import {
  buildDraftMessages,
  buildReviewMessages,
  buildFactCheckMessages,
  buildProofMessages,
} from './pipelineMessages';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import { saveDraft } from './draftService';
import { PipelineForeground } from '../native/PipelineForegroundModule';
import { getStageProgressPercent } from '../utils/stages';
import type { Chapter, Preset } from '../types/novel';
import type { PipelineStageName } from '../types/pipeline';
import type { ChatMessage } from './llm';

const cancelledTasks = new Set<string>();
const taskAbortControllers = new Map<string, AbortController>();

export function cancelPipeline(taskId: string): void {
  cancelledTasks.add(taskId);
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

function resolvePreset(presetId: number | null, presets: Preset[]): Preset | null {
  if (presetId != null) {
    const found = presets.find((p) => p.id === presetId);
    if (found) return found;
    // resolvePreset 静默回退修复：presetId 找不到时（被删除/换项目）不报错，
    // 静默用第一个 preset，用户以为用自定义预设实际用默认
    console.warn(`[pipeline] presetId=${presetId} not found, falling back to first preset`);
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

function buildContextPreview(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
}

function buildCallConfig(
  preset: Preset | null,
  maxTokens: number,
  scenario: string,
  projectId?: number,
  requestConfig?: LLMRequestConfig,
) {
  return {
    temperature: preset?.temperature,
    top_p: preset?.top_p,
    max_tokens: maxTokens,
    scenario,
    projectId,
    requestConfig,
  };
}

function getErrorMessage(error: any, fallback: string): string {
  return error?.message ? String(error.message) : fallback;
}

function markSkipped(taskId: string, stage: PipelineStageName, text: string): void {
  usePipelineTaskStore.getState().updateTaskStage(taskId, {
    stage,
    text,
    status: 'skipped',
    durationMs: 0,
  });
}

async function runProofStage({
  taskId,
  draftText,
  reviewText,
  factCheckText,
  maxTokens,
  proofPreset,
  scenario = 'pipeline_proof',
  projectId,
  requestConfig,
  abortSignal,
}: {
  taskId: string,
  draftText: string;
  reviewText: string;
  factCheckText: string;
  maxTokens: number;
  proofPreset: Preset | null;
  scenario?: string;
  projectId?: number;
  requestConfig?: LLMRequestConfig;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const store = usePipelineTaskStore.getState();
  store.setTaskStatus(taskId, 'proofing');

  const proofStart = Date.now();
  try {
    const messages = buildProofMessages(draftText, reviewText, factCheckText);
    const proofResult = await callLLMResult(
      messages,
      maxTokens,
      buildCallConfig(proofPreset, maxTokens, scenario, projectId, requestConfig),
      abortSignal,
    );
    const finalText = proofResult.text || draftText;
    store.updateTaskStage(taskId, {
      stage: 'proof',
      text: finalText,
      status: 'success',
      tokens: {
        input: proofResult.inputTokens,
        output: proofResult.outputTokens,
        total: proofResult.totalTokens,
      },
      durationMs: Date.now() - proofStart,
    });
    return finalText;
  } catch (error: any) {
    store.updateTaskStage(taskId, {
      stage: 'proof',
      text: draftText,
      status: 'failed',
      error: error.message || '终审失败，已回退到初稿',
      durationMs: Date.now() - proofStart,
    });
    return draftText;
  }
}

export type StageInfo = {
  stage: PipelineStageName | 'idle';
  label: string;
  startedAt: number;
};

export async function runChapterPipeline(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (info: StageInfo | string) => void,
): Promise<void> {
  const abortSignal = registerTaskAbort(taskId);
  try {
    await runChapterPipelineInner(taskId, chapter, onStageUpdate, abortSignal);
  } finally {
    releaseTaskAbort(taskId);
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
        summaryBudgetTokens: Math.min(contextConfig.summaryBudgetTokens ?? 20000, 1024),
        resourceBudget: Math.min(contextConfig.resourceBudget, 512),
        worldbookScanDepth: Math.min(contextConfig.worldbookScanDepth ?? 4, 1),
      };
    }
  } catch (error: any) {
    store.failTask(taskId, getErrorMessage(error, '流水线配置读取失败'));
    await PipelineForeground.notifyFailed(taskId, chapter.title || '流水线', '配置读取失败');
    await PipelineForeground.stop(taskId);
    return;
  }

  const draftPreset = resolvePreset(config.draftPresetId, presets as Preset[]);
  const reviewPreset = resolvePreset(config.reviewPresetId, presets as Preset[]);
  const factCheckPreset = resolvePreset(config.factCheckPresetId, presets as Preset[]);
  const proofPreset = resolvePreset(config.proofPresetId, presets as Preset[]);

  // 通知栏进度计算封装到 utils/stages，便于测试与 resume 共用。
  // 阶段"开始"时跳到该阶段起点，saveDraftAndComplete 时设 100，
  // 让用户在通知栏看到进度条单调递增。
  const pct = (completedStages: number) => getStageProgressPercent(config.pipelineMode, completedStages);

  const saveDraftAndComplete = async (text: string) => {
    try {
      await saveDraft({
        projectId: chapter.project_id,
        targetType: chapter.id > 0 ? 'chapter' : 'freeform',
        targetId: chapter.id > 0 ? chapter.id : chapter.project_id,
        content: text,
        source: 'pipeline',
        pipelineTaskId: taskId,
      });
    } catch { /* best-effort */ }
    store.completeTask(taskId, text);
    await PipelineForeground.updateProgress(taskId, '已完成', 100);
    await PipelineForeground.notifyComplete(taskId, chapter.title || '流水线', '已写完，点击查看');
    await PipelineForeground.stop(taskId);
  };

  if (checkCancelled(taskId)) {
    await PipelineForeground.notifyFailed(taskId, chapter.title || '流水线', '已取消');
    await PipelineForeground.stop(taskId);
    return;
  }
  store.setTaskStatus(taskId, 'drafting');
  onStageUpdate?.({ stage: 'draft', label: '草稿中...', startedAt: Date.now() });
  // BUG-8 修复：start 内部涉及 Android 前台服务+wakelock，在通知权限 NONE 或后台运行未启用时
  // 可能 hang 或抛 SecurityException 让 promise 不 resolve，阻塞下游 buildContext/callLLMResult。
  // fire-and-forget：通知/保活失败不该阻塞业务，错误已在桥内部 try-catch warn
  PipelineForeground.start(taskId, chapter.title || '流水线', '草稿中', pct(0)).catch((e) => {
    console.warn('[pipeline] foreground start failed (non-fatal):', e);
  });

  let baseContext: ChatMessage[] = [];
  let draftText = '';
  let draftMessages: ChatMessage[] = [];
  const draftStart = Date.now();
  try {
    const { messages, chapters: allChapters } = await buildContext(chapter, contextConfig, chapter.project_id, draftPreset || undefined);
    baseContext = messages;
    const request = createChapterGenerationRequest(chapter);

    // Extract previous chapter ending from already-fetched chapters.
    const prevChapter = allChapters
      .filter(c => c.position < chapter.position && c.content)
      .sort((a, b) => b.position - a.position)[0];
    const prevEnding = prevChapter?.content?.slice(-800) || '';

    draftMessages = buildDraftMessages(
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
      buildCallConfig(draftPreset, config.draftMaxTokens, 'pipeline_draft', chapter.project_id, requestConfig),
      abortSignal,
    );
    draftText = draftResult.text || '';
    const draftTokens = {
      inputTokens: draftResult.inputTokens,
      outputTokens: draftResult.outputTokens,
      totalTokens: draftResult.totalTokens,
    };

    store.updateTaskStage(taskId, {
      stage: 'draft',
      text: draftText,
      status: 'success',
      tokens: {
        input: draftTokens.inputTokens,
        output: draftTokens.outputTokens,
        total: draftTokens.totalTokens,
      },
      durationMs: Date.now() - draftStart,
    });
  } catch (error: any) {
    // 取消信号在阶段内被吞修复：先判断是否为用户取消，是则走取消路径不走 fail
    if (abortSignal?.aborted || error?.code === 'cancelled') {
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
    await PipelineForeground.notifyFailed(taskId, chapter.title || '流水线', '初稿生成失败');
    await PipelineForeground.stop(taskId);
    return;
  }

  if (config.pipelineMode === 'noReview') {
    onStageUpdate?.({ stage: 'idle', label: '无审核模式，初稿即为完稿', startedAt: Date.now() });
    markSkipped(taskId, 'review', '无审核模式已跳过审阅/评估');
    markSkipped(taskId, 'factCheck', '无审核模式已跳过事实核查');
    markSkipped(taskId, 'proof', '无审核模式已跳过终审校对');
    await saveDraftAndComplete(draftText);
    return;
  }

  if (config.pipelineMode === 'twoStage') {
    if (checkCancelled(taskId)) return;
    store.setTaskStatus(taskId, 'reviewing');
    onStageUpdate?.({ stage: 'review', label: '点评中...（与打磨并行）', startedAt: Date.now() });
    PipelineForeground.updateProgress(taskId, '点评与打磨中', pct(1));

    markSkipped(taskId, 'factCheck', '仅评估模式已跳过事实核查');

    // V2.2.0：review 和 proof 并行启动，节省一个阶段的延迟
    // proof 看到的是纯 draft；如果 review 完成后 proof 也完成，不再二次调用
    const reviewStart = Date.now();
    const reviewPromise = (async () => {
      try {
        const reviewResult = await callLLMResult(
          buildReviewMessages(draftText),
          config.reviewMaxTokens,
          buildCallConfig(reviewPreset, config.reviewMaxTokens, 'pipeline_review', chapter.project_id, requestConfig),
          abortSignal,
        );
        const reviewText = reviewResult.text || '';
        store.updateTaskStage(taskId, {
          stage: 'review',
          text: reviewText,
          status: 'success',
          tokens: {
            input: reviewResult.inputTokens,
            output: reviewResult.outputTokens,
            total: reviewResult.totalTokens,
          },
          durationMs: Date.now() - reviewStart,
        });
        return reviewText;
      } catch (error: any) {
        store.updateTaskStage(taskId, {
          stage: 'review',
          text: '',
          status: 'failed',
          error: error.message || '审阅/评估失败',
          durationMs: Date.now() - reviewStart,
        });
        return '';
      }
    })();

    onStageUpdate?.({ stage: 'proof', label: '打磨中...（与点评并行）', startedAt: Date.now() });
    const proofPromise = (async () => {
      const text = await runProofStage({
        taskId,
        draftText,
        reviewText: '',
        factCheckText: '',
        maxTokens: config.proofMaxTokens,
        proofPreset,
        projectId: chapter.project_id,
        requestConfig,
        abortSignal,
      });
      // proof 完成（不论成功/失败回退）之后才返回结果
      return text;
    })();

    // 同时等 review 和 proof。如果 proof 完成而 review 失败/慢，不二次调用 proof
    await Promise.all([
      reviewPromise.catch(() => ''),
      proofPromise.catch(() => draftText),
    ]);
    const finalText = await proofPromise.catch(() => draftText);
    await saveDraftAndComplete(finalText);
    return;
  }

  if (config.pipelineMode === 'conditional') {
    if (checkCancelled(taskId)) return;
    // conditional 模式状态语义错配修复：factCheck 阶段不应设为 'reviewing'
    // 改为 'factChecking' 让 UI 状态栏正确显示"事实核查中"
    store.setTaskStatus(taskId, 'factChecking');
    onStageUpdate?.({ stage: 'factCheck', label: '事实检查中...（与打磨并行）', startedAt: Date.now() });
    PipelineForeground.updateProgress(taskId, '事实检查与打磨中', pct(1));

    markSkipped(taskId, 'review', '仅核查模式已跳过审阅/评估');

    // V2.2.0：factCheck 和 proof 并行启动（逻辑同 twoStage 的 review+proof 并行）
    const contextText = buildContextPreview(baseContext);
    const factCheckStart = Date.now();
    const factCheckPromise = (async () => {
      try {
        const result = await callLLMResult(
          buildFactCheckMessages(draftText, contextText),
          config.factCheckMaxTokens,
          buildCallConfig(factCheckPreset, config.factCheckMaxTokens, 'pipeline_factcheck', chapter.project_id, requestConfig),
          abortSignal,
        );
        const text = result.text || '';
        store.updateTaskStage(taskId, {
          stage: 'factCheck',
          text,
          status: 'success',
          tokens: {
            input: result.inputTokens,
            output: result.outputTokens,
            total: result.totalTokens,
          },
          durationMs: Date.now() - factCheckStart,
        });
        return text;
      } catch (error: any) {
        store.updateTaskStage(taskId, {
          stage: 'factCheck',
          text: '',
          status: 'failed',
          error: error.message || '事实核查失败',
          durationMs: Date.now() - factCheckStart,
        });
        return '';
      }
    })();

    onStageUpdate?.({ stage: 'proof', label: '打磨中...（与事实核查并行）', startedAt: Date.now() });
    const proofPromise = (async () => {
      return runProofStage({
        taskId,
        draftText,
        reviewText: '',
        factCheckText: '',
        maxTokens: config.proofMaxTokens,
        proofPreset,
        projectId: chapter.project_id,
        requestConfig,
        abortSignal,
      });
    })();

    await Promise.all([
      factCheckPromise.catch(() => ''),
      proofPromise.catch(() => draftText),
    ]);
    const finalText = await proofPromise.catch(() => draftText);
    await saveDraftAndComplete(finalText);
    return;
  }

  if (checkCancelled(taskId)) return;
  store.setTaskStatus(taskId, 'reviewing');
  onStageUpdate?.({ stage: 'review', label: '点评中...', startedAt: Date.now() });
  PipelineForeground.updateProgress(taskId, '审阅与核查中', pct(1));

  const contextText = buildContextPreview(baseContext);
  const reviewStart = Date.now();
  const factCheckStart = Date.now();

  const reviewPromise = callLLMResult(
    buildReviewMessages(draftText),
    config.reviewMaxTokens,
    buildCallConfig(reviewPreset, config.reviewMaxTokens, 'pipeline_review', chapter.project_id, requestConfig),
    abortSignal,
  );
  const factCheckPromise = callLLMResult(
    buildFactCheckMessages(draftText, contextText),
    config.factCheckMaxTokens,
    buildCallConfig(factCheckPreset, config.factCheckMaxTokens, 'pipeline_factcheck', chapter.project_id, requestConfig),
    abortSignal,
  );

  let reviewText = '';
  let factCheckText = '';
  let reviewFailed = false;
  let factCheckFailed = false;

  const [reviewResult, factResult] = await Promise.allSettled([reviewPromise, factCheckPromise]);

  if (reviewResult.status === 'fulfilled') {
    reviewText = reviewResult.value.text || '';
    store.updateTaskStage(taskId, {
      stage: 'review',
      text: reviewText,
      status: 'success',
      tokens: {
        input: reviewResult.value.inputTokens,
        output: reviewResult.value.outputTokens,
        total: reviewResult.value.totalTokens,
      },
      durationMs: Date.now() - reviewStart,
    });
  } else {
    reviewFailed = true;
    store.updateTaskStage(taskId, {
      stage: 'review',
      text: '',
      status: 'failed',
      error: reviewResult.reason?.message || '审阅失败',
      durationMs: Date.now() - reviewStart,
    });
  }

  if (factResult.status === 'fulfilled') {
    factCheckText = factResult.value.text || '';
    store.updateTaskStage(taskId, {
      stage: 'factCheck',
      text: factCheckText,
      status: 'success',
      tokens: {
        input: factResult.value.inputTokens,
        output: factResult.value.outputTokens,
        total: factResult.value.totalTokens,
      },
      durationMs: Date.now() - factCheckStart,
    });
  } else {
    factCheckFailed = true;
    store.updateTaskStage(taskId, {
      stage: 'factCheck',
      text: '',
      status: 'failed',
      error: factResult.reason?.message || '事实核查失败',
      durationMs: Date.now() - factCheckStart,
    });
  }

  if (reviewFailed && factCheckFailed) {
    await saveDraftAndComplete(draftText);
    return;
  }

  if (checkCancelled(taskId)) return;
  onStageUpdate?.({ stage: 'proof', label: '打磨中...', startedAt: Date.now() });
  PipelineForeground.updateProgress(taskId, '终审打磨中', pct(3));
  const finalText = await runProofStage({
    taskId,
    draftText,
    reviewText,
    factCheckText,
    maxTokens: config.proofMaxTokens,
    proofPreset,
    projectId: chapter.project_id,
    requestConfig,
    abortSignal,
  });
  await saveDraftAndComplete(finalText);
}

export async function runFreeformPipeline(
  taskId: string,
  projectId: number,
  documentText: string,
  steerText: string,
  onStageUpdate?: (info: StageInfo | string) => void,
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
  await runChapterPipeline(taskId, pseudoChapter, onStageUpdate);
}

export async function resumePipeline(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (info: StageInfo | string) => void,
): Promise<void> {
  const abortSignal = registerTaskAbort(taskId);
  try {
    await resumePipelineInner(taskId, chapter, onStageUpdate, abortSignal);
  } finally {
    releaseTaskAbort(taskId);
    // 任务结束（无论成功/失败/取消）后清理取消标记，避免 cancelledTasks 累积
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

  const completedStages = new Set(
    task.stageResults
      .filter(s => s.status === 'success')
      .map(s => s.stage),
  );

  const draftResult = task.stageResults.find(s => s.stage === 'draft' && s.status === 'success');
  const reviewResult = task.stageResults.find(s => s.stage === 'review' && s.status === 'success');
  const factCheckResult = task.stageResults.find(s => s.stage === 'factCheck' && s.status === 'success');

  if (!draftResult) {
    await runChapterPipelineInner(taskId, chapter, onStageUpdate, abortSignal);
    return;
  }

  let config;
  let presets;
  let requestConfig: LLMRequestConfig;
  try {
    config = await db.getPipelineConfig();
    presets = await db.getPresetsByProject(chapter.project_id);
    requestConfig = await resolveLLMRequestConfig();
  } catch (error: any) {
    store.failTask(taskId, getErrorMessage(error, '流水线配置读取失败'));
    return;
  }
  const reviewPreset = resolvePreset(config.reviewPresetId, presets as Preset[]);
  const factCheckPreset = resolvePreset(config.factCheckPresetId, presets as Preset[]);
  const proofPreset = resolvePreset(config.proofPresetId, presets as Preset[]);

  // 通知栏进度计算（与首次运行保持一致），各阶段起点百分比
  const totalStages = config.pipelineMode === 'noReview' ? 1
    : (config.pipelineMode === 'twoStage' || config.pipelineMode === 'conditional') ? 3
    : 4; // full
  const pct = (doneStages: number) => Math.min(99, Math.round((doneStages / totalStages) * 100));

  // resume 入口补启前台服务（原首次运行被系统杀后续跑，前台服务可能缺失）
  if (!completedStages.has('proof')) {
    const nextLabel = !completedStages.has('review') ? '点评中'
      : !completedStages.has('factCheck') ? '事实检查中'
      : '终审打磨中';
    const nextPct = !completedStages.has('review') ? pct(1)
      : !completedStages.has('factCheck') ? pct(1)
      : pct(3);
    await PipelineForeground.start(taskId, chapter.title || '流水线', nextLabel, nextPct);
  }

  const saveDraftAndComplete = async (text: string) => {
    try {
      await saveDraft({
        projectId: chapter.project_id,
        targetType: chapter.id > 0 ? 'chapter' : 'freeform',
        targetId: chapter.id > 0 ? chapter.id : chapter.project_id,
        content: text,
        source: 'pipeline',
        pipelineTaskId: taskId,
      });
    } catch { /* best-effort */ }
    store.completeTask(taskId, text);
    await PipelineForeground.updateProgress(taskId, '已完成', 100);
    await PipelineForeground.notifyComplete(taskId, chapter.title || '流水线', '已写完，点击查看');
    await PipelineForeground.stop(taskId);
  };

  const draftText = draftResult.text;

  if (config.pipelineMode === 'noReview') {
    await saveDraftAndComplete(draftText);
    return;
  }

  let reviewText = reviewResult?.text || '';
  let factCheckText = factCheckResult?.text || '';

  if (config.pipelineMode === 'twoStage') {
    if (!completedStages.has('review')) {
      if (checkCancelled(taskId)) return;
      store.setTaskStatus(taskId, 'reviewing');
      onStageUpdate?.({ stage: 'review', label: '点评中...', startedAt: Date.now() });
      PipelineForeground.updateProgress(taskId, '点评中', pct(1));
      // resume 阶段 durationMs 修复：记录 start，写 Date.now()-start 而非时间戳
      const reviewStart = Date.now();
      try {
        const reviewCallResult = await callLLMResult(
          buildReviewMessages(draftText),
          config.reviewMaxTokens,
          buildCallConfig(reviewPreset, config.reviewMaxTokens, 'pipeline_review', chapter.project_id, requestConfig),
          abortSignal,
        );
        reviewText = reviewCallResult.text || '';
        store.updateTaskStage(taskId, {
          stage: 'review',
          text: reviewText,
          status: 'success',
          tokens: { input: reviewCallResult.inputTokens, output: reviewCallResult.outputTokens, total: reviewCallResult.totalTokens },
          durationMs: Date.now() - reviewStart,
        });
      } catch (error: any) {
        store.updateTaskStage(taskId, { stage: 'review', text: '', status: 'failed', error: error.message || '审阅失败', durationMs: Date.now() - reviewStart });
        // review 失败时不直接结束，统一与首次运行一致：用空 reviewText 继续走 proof
      }
    }

    if (checkCancelled(taskId)) return;
    onStageUpdate?.({ stage: 'proof', label: '打磨中...', startedAt: Date.now() });
    PipelineForeground.updateProgress(taskId, '终审打磨中', pct(2));
    const finalText = await runProofStage({ taskId, draftText, reviewText, factCheckText: '', maxTokens: config.proofMaxTokens, proofPreset, projectId: chapter.project_id, requestConfig, abortSignal });
    await saveDraftAndComplete(finalText);
    return;
  }

  // conditional / full
  // full 模式下补做 review 阶段（conditional 模式跳过 review）
  if (config.pipelineMode === 'full' && !completedStages.has('review')) {
    if (checkCancelled(taskId)) return;
    store.setTaskStatus(taskId, 'reviewing');
    onStageUpdate?.({ stage: 'review', label: '点评中...', startedAt: Date.now() });
    PipelineForeground.updateProgress(taskId, '点评中', pct(1));
    // resume 阶段 durationMs 修复
    const reviewStart = Date.now();
    try {
      const reviewCallResult = await callLLMResult(
        buildReviewMessages(draftText),
        config.reviewMaxTokens,
        buildCallConfig(reviewPreset, config.reviewMaxTokens, 'pipeline_review', chapter.project_id, requestConfig),
        abortSignal,
      );
      reviewText = reviewCallResult.text || '';
      store.updateTaskStage(taskId, {
        stage: 'review',
        text: reviewText,
        status: 'success',
        tokens: { input: reviewCallResult.inputTokens, output: reviewCallResult.outputTokens, total: reviewCallResult.totalTokens },
        durationMs: Date.now() - reviewStart,
      });
    } catch (error: any) {
      store.updateTaskStage(taskId, { stage: 'review', text: '', status: 'failed', error: error.message || '审阅失败', durationMs: Date.now() - reviewStart });
    }
  }

  if (!completedStages.has('factCheck') && config.pipelineMode !== 'twoStage') {
    if (checkCancelled(taskId)) return;
    store.setTaskStatus(taskId, 'reviewing');
    onStageUpdate?.({ stage: 'factCheck', label: '事实检查中...', startedAt: Date.now() });
    PipelineForeground.updateProgress(taskId, '事实检查中', pct(1));
    // resume 阶段 durationMs 修复
    const factCheckStart = Date.now();
    try {
      const { messages: baseContext } = await buildContext(chapter, await db.getContextConfig(), chapter.project_id);
      const contextText = buildContextPreview(baseContext);
      const factCheckCallResult = await callLLMResult(
        buildFactCheckMessages(draftText, contextText),
        config.factCheckMaxTokens,
        buildCallConfig(factCheckPreset, config.factCheckMaxTokens, 'pipeline_factcheck', chapter.project_id, requestConfig),
        abortSignal,
      );
      factCheckText = factCheckCallResult.text || '';
      store.updateTaskStage(taskId, {
        stage: 'factCheck',
        text: factCheckText,
        status: 'success',
        tokens: { input: factCheckCallResult.inputTokens, output: factCheckCallResult.outputTokens, total: factCheckCallResult.totalTokens },
        durationMs: Date.now() - factCheckStart,
      });
    } catch (error: any) {
      store.updateTaskStage(taskId, { stage: 'factCheck', text: '', status: 'failed', error: error.message || '事实核查失败', durationMs: Date.now() - factCheckStart });
    }
  }

  if (checkCancelled(taskId)) return;
  onStageUpdate?.('正在终审校对（续跑）...');
  const finalText = await runProofStage({ taskId, draftText, reviewText, factCheckText, maxTokens: config.proofMaxTokens, proofPreset, projectId: chapter.project_id, requestConfig, abortSignal });
  await saveDraftAndComplete(finalText);
}

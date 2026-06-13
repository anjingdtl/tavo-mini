import * as db from './database';
import { callLLMResult } from './llm';
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
import type { Chapter, Preset } from '../types/novel';
import type { PipelineStageName } from '../types/pipeline';
import type { ChatMessage } from './llm';

const cancelledTasks = new Set<string>();

export function cancelPipeline(taskId: string): void {
  cancelledTasks.add(taskId);
}

export function isPipelineCancelled(taskId: string): boolean {
  return cancelledTasks.has(taskId);
}

function resolvePreset(presetId: number | null, presets: Preset[]): Preset | null {
  if (presetId != null) {
    const found = presets.find((p) => p.id === presetId);
    if (found) return found;
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

function buildCallConfig(preset: Preset | null, maxTokens: number, scenario: string, projectId?: number) {
  return {
    temperature: preset?.temperature,
    top_p: preset?.top_p,
    max_tokens: maxTokens,
    scenario,
    projectId,
  };
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
}: {
  taskId: string,
  draftText: string;
  reviewText: string;
  factCheckText: string;
  maxTokens: number;
  proofPreset: Preset | null;
  scenario?: string;
  projectId?: number;
}): Promise<string> {
  const store = usePipelineTaskStore.getState();
  store.setTaskStatus(taskId, 'proofing');

  const proofStart = Date.now();
  try {
    const messages = buildProofMessages(draftText, reviewText, factCheckText);
    const proofResult = await callLLMResult(
      messages,
      maxTokens,
      buildCallConfig(proofPreset, maxTokens, scenario, projectId),
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

export async function runChapterPipeline(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (status: string) => void,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  const config = await db.getPipelineConfig();
  const contextConfig = await db.getContextConfig();
  const presets = await db.getPresetsByProject(chapter.project_id);

  const draftPreset = resolvePreset(config.draftPresetId, presets as Preset[]);
  const reviewPreset = resolvePreset(config.reviewPresetId, presets as Preset[]);
  const factCheckPreset = resolvePreset(config.factCheckPresetId, presets as Preset[]);
  const proofPreset = resolvePreset(config.proofPresetId, presets as Preset[]);

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
  };

  if (checkCancelled(taskId)) return;
  store.setTaskStatus(taskId, 'drafting');
  onStageUpdate?.('正在创作初稿...');

  const { messages: baseContext, chapters: allChapters } = await buildContext(chapter, contextConfig, chapter.project_id, draftPreset || undefined);
  const request = createChapterGenerationRequest(chapter);

  // Extract previous chapter ending from already-fetched chapters
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

  let draftText = '';
  const draftStart = Date.now();
  try {
    const draftResult = await callLLMResult(
      draftMessages,
      config.draftMaxTokens,
      buildCallConfig(draftPreset, config.draftMaxTokens, 'pipeline_draft', chapter.project_id),
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
    store.updateTaskStage(taskId, {
      stage: 'draft',
      text: '',
      status: 'failed',
      error: error.message || '初稿生成失败',
      durationMs: Date.now() - draftStart,
    });
    store.failTask(taskId, error.message || '初稿生成失败');
    return;
  }

  if (config.pipelineMode === 'noReview') {
    onStageUpdate?.('无审核模式，初稿即为完稿');
    markSkipped(taskId, 'review', '无审核模式已跳过审阅/评估');
    markSkipped(taskId, 'factCheck', '无审核模式已跳过事实核查');
    markSkipped(taskId, 'proof', '无审核模式已跳过终审校对');
    saveDraftAndComplete(draftText);
    return;
  }

  if (config.pipelineMode === 'twoStage') {
    if (checkCancelled(taskId)) return;
    store.setTaskStatus(taskId, 'reviewing');
    onStageUpdate?.('正在审阅/评估草稿...');

    const reviewStart = Date.now();
    let reviewText = '';
    try {
      const reviewResult = await callLLMResult(
        buildReviewMessages(draftText),
        config.reviewMaxTokens,
        buildCallConfig(reviewPreset, config.reviewMaxTokens, 'pipeline_review', chapter.project_id),
      );
      reviewText = reviewResult.text || '';
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
    } catch (error: any) {
      store.updateTaskStage(taskId, {
        stage: 'review',
        text: '',
        status: 'failed',
        error: error.message || '审阅/评估失败',
        durationMs: Date.now() - reviewStart,
      });
    }

    markSkipped(taskId, 'factCheck', '仅评估模式已跳过事实核查');
    if (checkCancelled(taskId)) return;
    onStageUpdate?.('正在根据审阅/评估终审...');
    const finalText = await runProofStage({
      taskId,
      draftText,
      reviewText,
      factCheckText: '',
      maxTokens: config.proofMaxTokens,
      proofPreset,
      projectId: chapter.project_id,
    });
    saveDraftAndComplete(finalText);
    return;
  }

  if (config.pipelineMode === 'conditional') {
    if (checkCancelled(taskId)) return;
    store.setTaskStatus(taskId, 'reviewing');
    onStageUpdate?.('正在事实核查草稿...');

    const contextText = buildContextPreview(baseContext);
    const factCheckStart = Date.now();
    let factCheckText = '';
    try {
      const factCheckResult = await callLLMResult(
        buildFactCheckMessages(draftText, contextText),
        config.factCheckMaxTokens,
        buildCallConfig(factCheckPreset, config.factCheckMaxTokens, 'pipeline_factcheck', chapter.project_id),
      );
      factCheckText = factCheckResult.text || '';
      store.updateTaskStage(taskId, {
        stage: 'factCheck',
        text: factCheckText,
        status: 'success',
        tokens: {
          input: factCheckResult.inputTokens,
          output: factCheckResult.outputTokens,
          total: factCheckResult.totalTokens,
        },
        durationMs: Date.now() - factCheckStart,
      });
    } catch (error: any) {
      store.updateTaskStage(taskId, {
        stage: 'factCheck',
        text: '',
        status: 'failed',
        error: error.message || '事实核查失败',
        durationMs: Date.now() - factCheckStart,
      });
    }

    markSkipped(taskId, 'review', '仅核查模式已跳过审阅/评估');
    if (checkCancelled(taskId)) return;
    onStageUpdate?.('正在根据事实核查终审...');
    const finalText = await runProofStage({
      taskId,
      draftText,
      reviewText: '',
      factCheckText,
      maxTokens: config.proofMaxTokens,
      proofPreset,
      projectId: chapter.project_id,
    });
    await saveDraftAndComplete(finalText);
    return;
  }

  if (checkCancelled(taskId)) return;
  store.setTaskStatus(taskId, 'reviewing');
  onStageUpdate?.('正在并行审阅与事实核查...');

  const contextText = buildContextPreview(baseContext);
  const reviewStart = Date.now();
  const factCheckStart = Date.now();

  const reviewPromise = callLLMResult(
    buildReviewMessages(draftText),
    config.reviewMaxTokens,
    buildCallConfig(reviewPreset, config.reviewMaxTokens, 'pipeline_review', chapter.project_id),
  );
  const factCheckPromise = callLLMResult(
    buildFactCheckMessages(draftText, contextText),
    config.factCheckMaxTokens,
    buildCallConfig(factCheckPreset, config.factCheckMaxTokens, 'pipeline_factcheck', chapter.project_id),
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
    saveDraftAndComplete(draftText);
    return;
  }

  if (checkCancelled(taskId)) return;
  onStageUpdate?.('正在终审校对...');
  const finalText = await runProofStage({
    taskId,
    draftText,
    reviewText,
    factCheckText,
    maxTokens: config.proofMaxTokens,
    proofPreset,
    projectId: chapter.project_id,
  });
  saveDraftAndComplete(finalText);
}

export async function runFreeformPipeline(
  taskId: string,
  projectId: number,
  documentText: string,
  steerText: string,
  onStageUpdate?: (status: string) => void,
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
  onStageUpdate?: (status: string) => void,
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
    await runChapterPipeline(taskId, chapter, onStageUpdate);
    return;
  }

  const config = await db.getPipelineConfig();
  const presets = await db.getPresetsByProject(chapter.project_id);
  const reviewPreset = resolvePreset(config.reviewPresetId, presets as Preset[]);
  const factCheckPreset = resolvePreset(config.factCheckPresetId, presets as Preset[]);
  const proofPreset = resolvePreset(config.proofPresetId, presets as Preset[]);

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
  };

  const draftText = draftResult.text;

  if (config.pipelineMode === 'noReview') {
    saveDraftAndComplete(draftText);
    return;
  }

  let reviewText = reviewResult?.text || '';
  let factCheckText = factCheckResult?.text || '';

  if (config.pipelineMode === 'twoStage') {
    if (!completedStages.has('review')) {
      if (checkCancelled(taskId)) return;
      store.setTaskStatus(taskId, 'reviewing');
      onStageUpdate?.('正在审阅/评估草稿（续跑）...');
      try {
        const reviewCallResult = await callLLMResult(
          buildReviewMessages(draftText),
          config.reviewMaxTokens,
          buildCallConfig(reviewPreset, config.reviewMaxTokens, 'pipeline_review', chapter.project_id),
        );
        reviewText = reviewCallResult.text || '';
        store.updateTaskStage(taskId, {
          stage: 'review',
          text: reviewText,
          status: 'success',
          tokens: { input: reviewCallResult.inputTokens, output: reviewCallResult.outputTokens, total: reviewCallResult.totalTokens },
          durationMs: Date.now(),
        });
      } catch (error: any) {
        store.updateTaskStage(taskId, { stage: 'review', text: '', status: 'failed', error: error.message || '审阅失败', durationMs: Date.now() });
        saveDraftAndComplete(draftText);
        return;
      }
    }

    if (checkCancelled(taskId)) return;
    onStageUpdate?.('正在终审校对（续跑）...');
    const finalText = await runProofStage({ taskId, draftText, reviewText, factCheckText: '', maxTokens: config.proofMaxTokens, proofPreset, projectId: chapter.project_id });
    saveDraftAndComplete(finalText);
    return;
  }

  // conditional / full
  if (!completedStages.has('factCheck') && config.pipelineMode !== 'twoStage') {
    if (checkCancelled(taskId)) return;
    store.setTaskStatus(taskId, 'reviewing');
    onStageUpdate?.('正在事实核查（续跑）...');
    try {
      const { messages: baseContext } = await buildContext(chapter, await db.getContextConfig(), chapter.project_id);
      const contextText = buildContextPreview(baseContext);
      const factCheckCallResult = await callLLMResult(
        buildFactCheckMessages(draftText, contextText),
        config.factCheckMaxTokens,
        buildCallConfig(factCheckPreset, config.factCheckMaxTokens, 'pipeline_factcheck', chapter.project_id),
      );
      factCheckText = factCheckCallResult.text || '';
      store.updateTaskStage(taskId, {
        stage: 'factCheck',
        text: factCheckText,
        status: 'success',
        tokens: { input: factCheckCallResult.inputTokens, output: factCheckCallResult.outputTokens, total: factCheckCallResult.totalTokens },
        durationMs: Date.now(),
      });
    } catch (error: any) {
      store.updateTaskStage(taskId, { stage: 'factCheck', text: '', status: 'failed', error: error.message || '事实核查失败', durationMs: Date.now() });
    }
  }

  if (checkCancelled(taskId)) return;
  onStageUpdate?.('正在终审校对（续跑）...');
  const finalText = await runProofStage({ taskId, draftText, reviewText, factCheckText, maxTokens: config.proofMaxTokens, proofPreset, projectId: chapter.project_id });
  saveDraftAndComplete(finalText);
}

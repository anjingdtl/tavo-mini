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
import type { Chapter } from '../types/novel';
import type { PipelineConfig, PipelineStageResult } from '../types/pipeline';
import type { ChatMessage } from './llm';

const cancelledTasks = new Set<string>();

export function cancelPipeline(taskId: string): void {
  cancelledTasks.add(taskId);
}

export function isPipelineCancelled(taskId: string): boolean {
  return cancelledTasks.has(taskId);
}

function resolvePreset(presetId: number | null, presets: any[]): any {
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

export async function runChapterPipeline(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (status: string) => void,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  const config = await db.getPipelineConfig();
  const contextConfig = await db.getContextConfig();
  const presets = await db.getPresetsByProject(chapter.project_id);

  const draftPreset = resolvePreset(config.draftPresetId, presets);
  const proofPreset = resolvePreset(config.proofPresetId, presets);

  // Stage 1: Draft
  if (checkCancelled(taskId)) return;
  store.setTaskStatus(taskId, 'drafting');
  onStageUpdate?.('正在创作初稿...');

  const baseContext = await buildContext(chapter, contextConfig, chapter.project_id, draftPreset);
  const request = createChapterGenerationRequest(chapter);
  const draftMessages = buildDraftMessages(
    baseContext,
    chapter.title || `第 ${chapter.position + 1} 章`,
    chapter.content || '',
    request.userPrompt,
  );

  let draftText = '';
  const draftStart = Date.now();
  try {
    const draftResult = await callLLMResult(draftMessages, config.draftMaxTokens, {
      max_tokens: config.draftMaxTokens,
      scenario: 'pipeline_draft',
    });
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

  // Stage 2a + 2b: Review & FactCheck (parallel)
  if (checkCancelled(taskId)) return;
  store.setTaskStatus(taskId, 'reviewing');
  onStageUpdate?.('正在并行审阅与事实核查...');

  const contextText = buildContextPreview(baseContext);

  const reviewStart = Date.now();
  const factCheckStart = Date.now();

  const reviewPromise = callLLMResult(
    buildReviewMessages(draftText),
    config.reviewMaxTokens,
    { max_tokens: config.reviewMaxTokens, scenario: 'pipeline_review' },
  );

  const factCheckPromise = callLLMResult(
    buildFactCheckMessages(draftText, contextText),
    config.factCheckMaxTokens,
    { max_tokens: config.factCheckMaxTokens, scenario: 'pipeline_factcheck' },
  );

  let reviewText = '';
  let factCheckText = '';
  let reviewFailed = false;
  let factCheckFailed = false;

  try {
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
  } catch {
    // Promise.allSettled should never throw
  }

  // If both review and factcheck failed, abort and fallback to draft
  if (reviewFailed && factCheckFailed) {
    store.completeTask(taskId, draftText);
    return;
  }

  // Stage 3: Proofreading
  if (checkCancelled(taskId)) return;
  store.setTaskStatus(taskId, 'proofing');
  onStageUpdate?.('正在终审校对...');

  const proofStart = Date.now();
  try {
    const proofResult = await callLLMResult(
      buildProofMessages(draftText, reviewText, factCheckText),
      config.proofMaxTokens,
      { max_tokens: config.proofMaxTokens, scenario: 'pipeline_proof' },
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
    store.completeTask(taskId, finalText);
  } catch (error: any) {
    store.updateTaskStage(taskId, {
      stage: 'proof',
      text: draftText,
      status: 'failed',
      error: error.message || '终审失败，回退到初稿',
      durationMs: Date.now() - proofStart,
    });
    store.completeTask(taskId, draftText);
  }
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

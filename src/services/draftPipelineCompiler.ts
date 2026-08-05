/**
 * Shared Draft pipeline request compiler.
 *
 * Generation and Context Preview MUST use the same message assembly so the
 * preview equals the real Draft request (minus side effects).
 */
import * as db from './database';
import { buildContext } from './contextBuilder';
import { createChapterGenerationRequest } from './chapterGeneration';
import {
  buildDraftMessages,
  estimateStageInputTokens,
} from './pipelineMessages';
import {
  checkRequestFitsContextWindow,
  deriveContextSafetyMargin,
  OutlineContextError,
} from './outlineContextBuilder';
import { resolveLLMRequestConfig } from './llm';
import type { ChatMessage, LLMRequestConfig } from './llm';
import type { Chapter, Preset } from '../types/novel';
import type { PipelineContextSnapshot } from '../types/pipelineContext';
import { PIPELINE_CONTEXT_SNAPSHOT_VERSION } from '../types/pipelineContext';
import type { ContextTraceItem } from '../types/contextTrace';

export interface CompileDraftPipelineRequestResult {
  messages: ChatMessage[];
  baseContext: ChatMessage[];
  pipelineContext: PipelineContextSnapshot;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  safetyMargin: number;
  contextWindow: number;
  fits: boolean;
  blockingReason: string | null;
  chapterTitle: string;
  prevEnding: string;
  userPrompt: string;
  draftPreset: Preset | null;
  requestConfig: LLMRequestConfig;
  trace: ContextTraceItem[];
  allocations?: Record<string, number>;
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

/**
 * Compile the exact Draft-stage messages for a chapter pipeline run.
 *
 * @param options.preview When true, only builds context (story memory preview
 *   mode). Never creates tasks, writes DB pipeline rows, or calls LLM.
 */
export async function compileDraftPipelineRequest(params: {
  chapter: Chapter;
  preview?: boolean;
  requestConfig?: LLMRequestConfig;
  draftPreset?: Preset | null;
  draftMaxTokens?: number;
}): Promise<CompileDraftPipelineRequestResult> {
  const chapter = params.chapter;
  const pipelineConfig = await db.getPipelineConfig();
  const contextConfig = await db.getContextConfig();
  const presets = (await db.getPresetsByProject(
    chapter.project_id,
  )) as Preset[];
  const requestConfig =
    params.requestConfig || (await resolveLLMRequestConfig());
  const draftPreset =
    params.draftPreset !== undefined
      ? params.draftPreset
      : resolvePreset(pipelineConfig.draftPresetId, presets);
  const reservedOutputTokens =
    params.draftMaxTokens ?? pipelineConfig.draftMaxTokens;
  const contextWindow = Number(requestConfig.context_window) || 0;

  if (!(contextWindow > 0)) {
    throw new OutlineContextError(
      'OUTLINE_MODEL_UNAVAILABLE',
      '当前模型未配置有效上下文窗口，无法编译初稿请求。',
      'open_llm_settings',
    );
  }

  const request = createChapterGenerationRequest(chapter);
  const {
    messages: baseContext,
    chapters: allChapters,
    pipelineContext: ctx,
    trace,
    estimatedInputTokens: baseEstimated,
  } = await buildContext(
    chapter,
    contextConfig,
    chapter.project_id,
    draftPreset || undefined,
    {
      retrievalUserPrompt: request.userPrompt,
      storyMemoryMode: params.preview ? 'preview' : undefined,
      reservedOutputTokens,
      contextWindow,
    },
  );

  const pipelineContext: PipelineContextSnapshot = {
    ...ctx,
    projectId: chapter.project_id,
    chapterId: chapter.id,
    chapterUpdatedAt:
      (chapter as any).updated_at ?? (chapter as any).updatedAt ?? '',
    createdAt: Date.now(),
    snapshotVersion: PIPELINE_CONTEXT_SNAPSHOT_VERSION,
  };

  const prevChapter = allChapters
    .filter(c => c.position < chapter.position && c.content)
    .sort((a, b) => b.position - a.position)[0];
  const prevEnding = prevChapter?.content?.slice(-800) || '';

  let chapterTitle = chapter.title || `第 ${chapter.position + 1} 章`;
  try {
    const project = await db.getProjectById(chapter.project_id);
    if (project?.mode === 'continuation') {
      const { getContinuationChapterNumbering } = await import(
        './continuation/chapterNumbering/continuationChapterNumbering'
      );
      const numbering = await getContinuationChapterNumbering(
        chapter.project_id,
      );
      chapterTitle = numbering.getDisplayTitle(chapter) || chapterTitle;
    }
  } catch {
    // Non-fatal.
  }

  const messages = buildDraftMessages(
    baseContext,
    chapterTitle,
    chapter.content || '',
    request.userPrompt,
    prevEnding,
    chapter.synopsis,
    pipelineContext.outlineText,
  );

  const estimatedInputTokens = estimateStageInputTokens(messages);
  const safetyMargin = deriveContextSafetyMargin(contextWindow);
  const blockingReason = checkRequestFitsContextWindow({
    estimatedInputTokens,
    reservedOutputTokens,
    contextWindow,
    stageLabel: '初稿',
  });

  return {
    messages,
    baseContext,
    pipelineContext,
    estimatedInputTokens: estimatedInputTokens || baseEstimated || 0,
    reservedOutputTokens,
    safetyMargin,
    contextWindow,
    fits: !blockingReason,
    blockingReason,
    chapterTitle,
    prevEnding,
    userPrompt: request.userPrompt,
    draftPreset,
    requestConfig,
    trace: trace || [],
  };
}

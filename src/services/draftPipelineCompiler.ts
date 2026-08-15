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
import {
  PIPELINE_CONTEXT_SNAPSHOT_VERSION,
  PIPELINE_CONTEXT_SNAPSHOT_VERSION_V4,
  PIPELINE_CONTEXT_SNAPSHOT_VERSION_V5,
} from '../types/pipelineContext';
import { ResourceContextError } from './context/resources/resourceContextErrors';
import { isPhase2ContextBudgetVersion } from './pipeline/outlineWorkflowVersion';
import type { ContextTraceItem } from '../types/contextTrace';
import type { FrozenWriterStyleV1 } from './writerStyle/types';

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
  /**
   * Non-blocking Story Memory warnings from the same buildContext() call the
   * messages were compiled from. Preview / reconcile surfaces them as warning
   * panels instead of blocking generation.
   */
  storyMemoryWarnings: import('./storyMemory/storyMemoryPrepare').StoryMemoryPrepareWarning[];
  allocations?: Record<string, number>;
  /** Phase 2+ elastic budget trace when elasticBudget is enabled. */
  elasticBudgetTrace?: import('./pipeline/elasticBudgetAllocator').ElasticBudgetTrace;
  /**
   * Context Budget V3 hierarchical allocator trace when contextBudgetVersion
   * >= 6 (Plan §15). Carries per-board demand / soft target / allocated /
   * borrowed plus per-item traces for resources. The Preview screen renders a
   * board summary panel and per-item diagnostics when this is present.
   */
  hierarchicalBudgetTrace?: import('./context/hierarchicalContextAllocator').HierarchicalBudgetResult;
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

function resolvePresetForPhase2(
  presetId: number | null,
  presets: Preset[],
): Preset | null {
  const requested = Number(presetId);
  if (!Number.isInteger(requested) || requested <= 0) {
    return null;
  }
  const found = presets.find(p => p.id === requested);
  if (!found) {
    throw new ResourceContextError(
      'PRESET_SOURCE_READ_FAILED',
      `已选择的作家风格 #${requested} 读取失败，已阻止生成，以免静默换成默认文风。`,
      'open_resources',
      { requestedPresetId: requested },
    );
  }
  return found;
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
  /**
   * Story Memory policy for this compile. Pipeline first-run snapshots use
   * `preview` deliberately: a missing/partial checkpoint is a degradable
   * context warning, never a synchronous prerequisite for the first Draft
   * request. The explicit option keeps this separate from the UI preview
   * flag so other callers can retain the maintenance policy when needed.
   */
  storyMemoryMode?: 'generation' | 'preview';
  requestConfig?: LLMRequestConfig;
  draftPreset?: Preset | null;
  draftMaxTokens?: number;
  elasticBudget?: boolean;
  /**
   * Context Budget protocol version frozen on the task (Plan §12). When >= 6
   * the V3 hierarchical board/item allocator takes over the elastic path in
   * `buildContext`; otherwise the V2 single-level elastic allocator runs as
   * before. Plumbed from the task snapshot so resumed/preview compiles use the
   * same allocator that produced the draft.
   */
  contextBudgetVersion?: number;
  /**
   * Frozen V3 policy forwarded to buildContext so the hierarchical allocator
   * uses the real user policy (Closure Plan §14). When omitted buildContext
   * falls back to the default preset.
   */
  contextAutomationPolicyV3?: import('./contextAutomationPolicy').ContextAutomationPolicyV3;
  /** New tasks freeze Writer Style before compiling the first request. */
  writerStyleSnapshot?: FrozenWriterStyleV1;
}): Promise<CompileDraftPipelineRequestResult> {
  const chapter = params.chapter;
  const pipelineConfig = await db.getPipelineConfig({ projectId: chapter.project_id });
  const contextConfig = await db.getContextConfig();
  const presets = (await db.getPresetsByProject(
    chapter.project_id,
  )) as Preset[];
  const requestConfig =
    params.requestConfig || (await resolveLLMRequestConfig());
  const phase2 = isPhase2ContextBudgetVersion(params.contextBudgetVersion);
  const rawRequested =
    params.draftPreset !== undefined
      ? params.draftPreset?.id ?? null
      : pipelineConfig.draftPresetId ?? null;
  const requestedPresetId =
    Number(rawRequested) > 0 ? Number(rawRequested) : null;
  const draftPreset =
    params.draftPreset !== undefined
      ? params.draftPreset
      : phase2
        ? resolvePresetForPhase2(pipelineConfig.draftPresetId, presets)
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

  // The compiler owns the single current-body injection. Keep the body out
  // of retrievalUserPrompt so revision/continuation does not see tail + full
  // body twice.
  const request = createChapterGenerationRequest(chapter, {
    includeExistingContent: false,
  });
  const {
    messages: baseContext,
    chapters: allChapters,
    pipelineContext: ctx,
    trace,
    estimatedInputTokens: baseEstimated,
    elasticBudgetTrace,
    hierarchicalBudgetTrace,
    storyMemoryWarnings,
  } = await buildContext(
    chapter,
    contextConfig,
    chapter.project_id,
    draftPreset || undefined,
    {
      retrievalUserPrompt: request.userPrompt,
      storyMemoryMode:
        params.storyMemoryMode ?? (params.preview ? 'preview' : undefined),
      reservedOutputTokens,
      contextWindow,
      elasticBudget: params.elasticBudget,
      contextBudgetVersion: params.contextBudgetVersion,
      contextAutomationPolicyV3: params.contextAutomationPolicyV3,
      requestedPresetId: phase2 ? requestedPresetId : undefined,
      protectedWriterStyleTokens:
        params.writerStyleSnapshot?.stageProjections.draft.estimatedTokens,
    },
  );

  if (params.writerStyleSnapshot) {
    const style = params.writerStyleSnapshot;
    const draftProjection = style.stageProjections.draft;
    trace.push(
      {
        kind: 'writer_style',
        sourceId: style.assetId,
        title: style.assetName,
        reason: `Active Writer Style｜${style.sourceFormat}｜fingerprint ${style.sourceFingerprint.slice(0, 12)}`,
        estimatedTokens: draftProjection.estimatedTokens,
        included: true,
        clipped: false,
        preview: draftProjection.text.slice(0, 500),
        sourceFingerprint: style.sourceFingerprint,
        awarenessMode: 'preset',
      },
      {
        kind: 'writer_style_projection',
        sourceId: style.assetId,
        title: `Draft Projection · ${draftProjection.mode}`,
        reason: 'Protected Writer Style Projection；不参与普通 Resource allocator，不得 tail clip。',
        estimatedTokens: draftProjection.estimatedTokens,
        included: true,
        clipped: false,
        preview: draftProjection.text.slice(0, 500),
        sourceFingerprint: style.sourceFingerprint,
      },
      {
        kind: 'writer_style_compat',
        sourceId: style.assetId,
        title: 'Writer Style Compatibility',
        reason: `${style.compatibilitySummary?.promptCount || 0} prompts · ${style.compatibilitySummary?.preservedCount || 0} preserved · ${style.compatibilitySummary?.injectedCount || 0} injected`,
        estimatedTokens: 0,
        included: true,
        clipped: false,
        preview: style.compatibilityFingerprint || '',
        sourceFingerprint: style.compatibilityFingerprint,
      },
      {
        kind: 'writer_style_sampler',
        sourceId: style.assetId,
        title: 'Writer Style Sampler',
        reason: 'Pipeline output reservation remains stage-owned；Tavern max_tokens/openai_max_tokens仅展示与保留。',
        estimatedTokens: 0,
        included: true,
        clipped: false,
        preview: JSON.stringify(style.samplerResolution),
        sourceFingerprint: style.sourceFingerprint,
      },
    );
  }

  const pipelineContext: PipelineContextSnapshot = {
    ...ctx,
    projectId: chapter.project_id,
    chapterId: chapter.id,
    chapterUpdatedAt:
      (chapter as any).updated_at ?? (chapter as any).updatedAt ?? '',
    createdAt: Date.now(),
    snapshotVersion: params.writerStyleSnapshot
      ? PIPELINE_CONTEXT_SNAPSHOT_VERSION_V5
      : phase2
        ? PIPELINE_CONTEXT_SNAPSHOT_VERSION_V4
        : PIPELINE_CONTEXT_SNAPSHOT_VERSION,
    ...(params.writerStyleSnapshot
      ? { writerStyleSnapshot: params.writerStyleSnapshot }
      : {}),
  };

  const prevChapter = allChapters
    .filter(c => c.position < chapter.position && c.content)
    .sort((a, b) => b.position - a.position)[0];
  const prevEnding = prevChapter?.content?.slice(-800) || '';
  const immediatePreviousChapterText = prevChapter?.content || '';
  const immediatePreviousChapterEnding =
    immediatePreviousChapterText.slice(-1200);
  pipelineContext.immediatePreviousChapterText = immediatePreviousChapterText;
  pipelineContext.immediatePreviousChapterEnding =
    immediatePreviousChapterEnding;
  pipelineContext.immediatePreviousChapterId = prevChapter?.id;
  pipelineContext.immediatePreviousChapterPosition = prevChapter?.position;

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

  // 批次写章：章节摘要只存独立计划摘要；批次总目标/节拍/衔接等指令存于
  // summary_json.batch_instruction，Draft 生成时合并进章节指令（列表显示
  // 保持简洁，生成质量不受影响）。
  let chapterSynopsis = String(chapter.synopsis || '');
  try {
    const meta =
      typeof chapter.summary_json === 'string'
        ? JSON.parse(chapter.summary_json || '{}')
        : chapter.summary_json || {};
    if (
      typeof meta?.batch_instruction === 'string' &&
      meta.batch_instruction.trim()
    ) {
      chapterSynopsis = `${chapterSynopsis}\n\n${meta.batch_instruction.trim()}`;
    }
  } catch {
    // summary_json 非 JSON 或读取失败时忽略批次指令。
  }

  const messages = buildDraftMessages(
    baseContext,
    chapterTitle,
    chapter.content || '',
    request.userPrompt,
    prevEnding,
    chapterSynopsis,
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
    storyMemoryWarnings: storyMemoryWarnings || [],
    elasticBudgetTrace,
    hierarchicalBudgetTrace,
  };
}

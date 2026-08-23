import * as db from '../../database';
import {
  buildEpisodicRetrievalQuery,
  resolvePreviousChapterForQuery,
  type MemoryRetrievalOptions,
} from '../../episodicMemoryRetriever';
import {
  excludeRawFromEpisodicCandidates,
  STORY_MEMORY_MAX_RAW_CHAPTERS,
} from '../../storyMemory/storyMemoryCoverage';
import { prepareStoryMemoryForGeneration } from '../../storyMemory/storyMemoryPrepare';
import { renderStoryMemoryForContext } from '../../storyMemory/storyMemoryRenderer';
import { getOrAnalyzeNoteStyle } from '../../styleAnalyzer';
import { retrieveNoteFragments, type RetrievalQuery } from '../../noteRetriever';
import {
  buildOutlineContext,
  deriveContextSafetyMargin,
  deriveOutlineBudgetTokens,
  EMPTY_OUTLINE_CONTEXT,
  OutlineContextError,
  type BuiltOutlineContext,
} from '../../outlineContextBuilder';
import {
  collectAllResourceCandidates,
  type ResourceContextCandidate,
} from '../resourceContextCandidates';
import { collectPhase2BudgetResources, type Phase2BudgetResources } from '../resources/buildPhase2BudgetResources';
import type { DiagnosticSink } from '../generationDiagnostics';
import { selectPreviousChapters } from './selectPreviousChapters';
import type {
  CollectedGenerationMaterials,
  GenerationStageBuildInput,
  GenerationResourceSources,
} from './generationContracts';

export interface CollectGenerationMaterialsInput extends GenerationStageBuildInput {
  options?: GenerationStageBuildInput['options'] & {
    contextBudgetVersion?: number;
    storyMemoryMode?: 'generation' | 'preview';
    contextWindow?: number;
    reservedOutputTokens?: number;
    retrievalUserPrompt?: string;
  };
  /** Pure episodic probe supplied by the orchestration boundary. */
  measureEpisodicDemand?: (input: {
    projectId: number;
    candidates: import('../../../types/novel').Chapter[];
    currentChapter: import('../../../types/novel').Chapter;
    retrievalOptions: MemoryRetrievalOptions;
    onDiagnostic?: DiagnosticSink;
  }) => Promise<{ demandTokens: number; text: string }>;
  onDiagnostic?: DiagnosticSink;
}

function deriveGenerationOutlineBudgetTokens(
  contextWindow: number,
  reservedOutputTokens = 0,
): number {
  if (!(contextWindow > 0)) return 0;
  const safety = deriveContextSafetyMargin(contextWindow);
  const reserved = Math.max(0, Number(reservedOutputTokens) || 0);
  return Math.max(0, contextWindow - reserved - safety - 256);
}

async function collectOutline(
  projectId: number,
  contextWindowOverride?: number,
  reservedOutputTokens?: number,
  onDiagnostic?: DiagnosticSink,
): Promise<BuiltOutlineContext> {
  if (typeof (db as any).getProjectById !== 'function') {
    return EMPTY_OUTLINE_CONTEXT;
  }
  let project;
  try {
    project = await db.getProjectById(projectId);
  } catch (error: any) {
    throw new OutlineContextError(
      'OUTLINE_READ_FAILED',
      `读取项目信息失败：${error?.message ? String(error.message) : '数据库错误'}`,
      'open_outlines',
    );
  }
  if (project?.mode !== 'outline') return EMPTY_OUTLINE_CONTEXT;
  let contextWindow = 0;
  if (contextWindowOverride != null && contextWindowOverride > 0) {
    contextWindow = Number(contextWindowOverride);
  } else {
    try {
      const llmConfig = await db.getActiveLLMConfig();
      contextWindow = Number(llmConfig?.context_window) || 0;
    } catch (error) {
      onDiagnostic?.({
        code: 'BUDGET_INVALID_CAPACITY',
        severity: 'warning',
        message: '模型上下文窗口读取失败，大纲预算按不可用容量处理',
        stage: 'collect',
        source: 'collectGenerationMaterials.collectOutline.activeModel',
        detail: { reason: String((error as Error)?.message || error) },
      });
      contextWindow = 0;
    }
  }
  const generationBudget = deriveGenerationOutlineBudgetTokens(
    contextWindow,
    reservedOutputTokens,
  );
  const outlineBudgetTokens =
    generationBudget > 0
      ? generationBudget
      : deriveOutlineBudgetTokens(contextWindow);
  return buildOutlineContext({
    projectId,
    projectMode: project.mode,
    outlineBudgetTokens,
  });
}

async function collectResourceSources(
  projectId: number,
  includeResources: boolean,
  capture?: {
    scanText: string;
    chapterTitle: string;
    chapterSynopsis: string;
    retrievalUserPrompt: string;
  },
  onDiagnostic?: DiagnosticSink,
): Promise<GenerationResourceSources> {
  const empty: GenerationResourceSources = {
    characters: [],
    notes: [],
    noteConfig: null,
    noteContents: {},
    worldbookEntries: [],
    noteStyleProfiles: [],
    noteRetrievalFragments: [],
  };
  if (!includeResources) return empty;
  const [characters, notes, noteConfig, worldbookEntries] =
    await Promise.allSettled([
      typeof (db as any).getCharactersByProject === 'function'
        ? (db as any).getCharactersByProject(projectId)
        : Promise.resolve([]),
      typeof (db as any).getNotesByProject === 'function'
        ? (db as any).getNotesByProject(projectId)
        : Promise.resolve([]),
      typeof (db as any).getProjectNoteConfig === 'function'
        ? (db as any).getProjectNoteConfig(projectId)
        : Promise.resolve(null),
      typeof (db as any).getWorldbookEntriesByProject === 'function'
        ? (db as any).getWorldbookEntriesByProject(projectId)
        : Promise.resolve([]),
    ]);
  const reportFailure = (
    result: PromiseSettledResult<unknown>,
    code: string,
    source: string,
    message: string,
  ) => {
    if (result.status !== 'rejected') return;
    onDiagnostic?.({
      code,
      severity: 'warning',
      message,
      stage: 'collect',
      source,
      detail: { reason: String((result.reason as Error)?.message || result.reason) },
    });
  };
  reportFailure(
    characters,
    'RESOURCE_RETRIEVAL_FAILED',
    'collectGenerationMaterials.resourceSources.characters',
    '角色资料读取失败，角色资料按空参与本次生成',
  );
  reportFailure(
    notes,
    'RESOURCE_RETRIEVAL_FAILED',
    'collectGenerationMaterials.resourceSources.notes',
    '笔记索引读取失败，笔记资料按空参与本次生成',
  );
  reportFailure(
    noteConfig,
    'NOTE_RETRIEVAL_FAILED',
    'collectGenerationMaterials.resourceSources.noteConfig',
    '笔记模式配置读取失败，按默认模式处理',
  );
  reportFailure(
    worldbookEntries,
    'RESOURCE_RETRIEVAL_FAILED',
    'collectGenerationMaterials.resourceSources.worldbook',
    '世界书读取失败，世界书资料按空参与本次生成',
  );
  const reportInvalidArray = (
    result: PromiseSettledResult<unknown>,
    source: string,
    label: string,
  ) => {
    if (result.status !== 'fulfilled' || Array.isArray(result.value)) return;
    onDiagnostic?.({
      code: 'RESOURCE_RETRIEVAL_FAILED',
      severity: 'warning',
      message: `${label}返回格式无效，按空资料参与本次生成`,
      stage: 'collect',
      source,
      detail: { reason: 'expected_array' },
    });
  };
  reportInvalidArray(
    characters,
    'collectGenerationMaterials.resourceSources.characters',
    '角色资料',
  );
  reportInvalidArray(
    notes,
    'collectGenerationMaterials.resourceSources.notes',
    '笔记索引',
  );
  reportInvalidArray(
    worldbookEntries,
    'collectGenerationMaterials.resourceSources.worldbook',
    '世界书',
  );
  if (
    noteConfig.status === 'fulfilled' &&
    noteConfig.value != null &&
    (typeof noteConfig.value !== 'object' || Array.isArray(noteConfig.value))
  ) {
    onDiagnostic?.({
      code: 'NOTE_RETRIEVAL_FAILED',
      severity: 'warning',
      message: '笔记模式配置返回格式无效，按默认模式处理',
      stage: 'collect',
      source: 'collectGenerationMaterials.resourceSources.noteConfig',
      detail: { reason: 'expected_object_or_null' },
    });
  }
  const notesValue = notes.status === 'fulfilled' && Array.isArray(notes.value)
    ? notes.value
    : [];
  const noteConfigValue =
    noteConfig.status === 'fulfilled' && noteConfig.value
      ? noteConfig.value
      : null;
  let noteContents: Record<number, string> = {};
  if (
    (noteConfigValue as any)?.mode !== 'none' &&
    notesValue.length > 0 &&
    typeof (db as any).getNotesContentByIds === 'function'
  ) {
    try {
      const loadedContents = await (db as any).getNotesContentByIds(
        notesValue.map((note: any) => Number(note.id)),
      );
      if (
        !loadedContents ||
        typeof loadedContents !== 'object' ||
        Array.isArray(loadedContents)
      ) {
        throw new Error('expected_object');
      }
      noteContents = loadedContents;
    } catch (error) {
      onDiagnostic?.({
        code: 'NOTE_RETRIEVAL_FAILED',
        severity: 'warning',
        message: '笔记正文读取失败，相关笔记未进入本次生成',
        stage: 'collect',
        source: 'collectGenerationMaterials.resourceSources.noteContents',
        detail: { reason: String((error as Error)?.message || error) },
      });
      noteContents = {};
    }
  }
  const noteStyleProfiles: unknown[] = [];
  const noteRetrievalFragments: unknown[] = [];
  const mode = String((noteConfigValue as any)?.mode || 'none');
  if (mode === 'style' && notesValue.length > 0) {
    const configuredIds = Array.isArray((noteConfigValue as any)?.enabledNoteIds)
      ? (noteConfigValue as any).enabledNoteIds.map(Number)
      : [];
    const eligibleIds = notesValue.map((note: any) => Number(note.id));
    const noteIds =
      configuredIds.length > 0
        ? configuredIds.filter((id: number) => eligibleIds.includes(id))
        : eligibleIds;
    const settled = await Promise.allSettled(
      noteIds.map((id: number) => getOrAnalyzeNoteStyle(id)),
    );
    settled.forEach((result, index) => {
      if (
        result.status === 'fulfilled' &&
        result.value &&
        result.value.profileJson &&
        Object.keys(result.value.profileJson).length > 0
      ) {
        noteStyleProfiles.push(result.value);
      } else if (result.status === 'rejected') {
        onDiagnostic?.({
          code: 'NOTE_STYLE_ANALYSIS_FAILED',
          severity: 'warning',
          message: '笔记风格分析失败，该笔记风格画像未进入本次生成',
          stage: 'collect',
          source: 'collectGenerationMaterials.resourceSources.noteStyleProfiles',
          detail: {
            noteId: noteIds[index],
            reason: String((result.reason as Error)?.message || result.reason),
          },
        });
      } else {
        onDiagnostic?.({
          code: 'NOTE_STYLE_ANALYSIS_FAILED',
          severity: 'warning',
          message: '笔记风格分析返回空画像，该笔记风格画像未进入本次生成',
          stage: 'collect',
          source: 'collectGenerationMaterials.resourceSources.noteStyleProfiles',
          detail: { noteId: noteIds[index], reason: 'empty_profile' },
        });
      }
    });
  } else if (mode === 'retrieval' && capture) {
    try {
      const fragments = await retrieveNoteFragments(
        projectId,
        {
          chapterTitle: capture.chapterTitle,
          chapterSynopsis: capture.chapterSynopsis,
          previousEnding: capture.scanText.slice(-500),
          userPrompt: capture.retrievalUserPrompt,
        } satisfies RetrievalQuery,
        Number((noteConfigValue as any)?.retrievalTopK) || 5,
      );
      noteRetrievalFragments.push(...fragments);
    } catch (error) {
      onDiagnostic?.({
        code: 'NOTE_RETRIEVAL_FAILED',
        severity: 'warning',
        message: '资料库笔记检索失败，笔记内容未进入本次生成',
        stage: 'collect',
        source: 'collectGenerationMaterials.resourceSources.noteRetrieval',
        detail: { reason: String((error as Error)?.message || error) },
      });
      // The legacy renderer preserves its existing empty-on-retrieval-failure
      // behavior, but now receives the failed result as an empty capture.
    }
  }
  return {
    characters:
      characters.status === 'fulfilled' && Array.isArray(characters.value)
        ? characters.value
        : [],
    notes: notesValue,
    noteConfig: noteConfigValue,
    noteContents,
    noteStyleProfiles,
    noteRetrievalFragments,
    worldbookEntries:
      worldbookEntries.status === 'fulfilled' &&
      Array.isArray(worldbookEntries.value)
        ? worldbookEntries.value
        : [],
  };
}

/**
 * Collect owns all source capture and repository boundaries. It intentionally
 * stops before final selection, budget allocation, message assembly, and
 * snapshot construction.
 */
export async function collectGenerationMaterials(
  input: CollectGenerationMaterialsInput,
): Promise<CollectedGenerationMaterials> {
  const options = input.options || {};
  const budgetVersion = Number(options.contextBudgetVersion) || 0;
  // 统一写作核心：候选采集不再按预算版本分流。与 buildContext 同源的窗口
  // 判定决定采集形态——有窗口信息：V3/V7 候选 + episodic 探针；无窗口信息：
  // 保留原始 resourceSources 直通兜底（V7 专属资源仅 version >= 7 采集）。
  const useHierarchicalBoards =
    Number(options.contextWindow) > 0 &&
    Number(options.reservedOutputTokens) > 0;
  let chapters = await db.getChaptersByProject(input.projectId);
  const prepared = await prepareStoryMemoryForGeneration(
    input.projectId,
    input.currentChapter,
    input.config,
    {
      mode: options.storyMemoryMode === 'preview' ? 'preview' : 'generation',
      contextBudgetVersion: options.contextBudgetVersion,
    },
  );
  if (prepared.fatal) {
    throw new Error(prepared.blockReason || '故事记忆覆盖不足，无法安全生成。');
  }
  if (prepared.checkpointUpdated) {
    chapters = await db.getChaptersByProject(input.projectId);
  }
  const previousChapters = chapters.filter(
    chapter => chapter.position < input.currentChapter.position,
  );
  const rawChapterIds = prepared.coverage?.rawChapterIds || [];
  const episodicCandidates = excludeRawFromEpisodicCandidates(
    previousChapters,
    useHierarchicalBoards && prepared.coverageCandidates ? [] : rawChapterIds,
  );
  const preOutlineContext = await collectOutline(
    input.projectId,
    options.contextWindow,
    options.reservedOutputTokens,
    input.onDiagnostic,
  );
  const worldbookScanContent = selectPreviousChapters(
    input.currentChapter,
    {
      strategy: 'sliding',
      recentChapterCount: useHierarchicalBoards
        ? STORY_MEMORY_MAX_RAW_CHAPTERS
        : input.config.worldbookScanDepth ?? 4,
    },
    chapters,
  )
    .map(chapter => chapter.content)
    .join('\n\n');
  const previousForQuery = resolvePreviousChapterForQuery(
    previousChapters,
    input.currentChapter,
  );
  const episodicQuery = buildEpisodicRetrievalQuery({
    currentChapter: input.currentChapter,
    previousChapter: previousForQuery,
    retrievalUserPrompt: options.retrievalUserPrompt,
  });
  const retrievalOptions: MemoryRetrievalOptions = {
    queryText: episodicQuery,
    storyState:
      prepared?.checkpoint?.status === 'clean'
        ? prepared.checkpoint.state
        : null,
  };
  const resourceSources = await collectResourceSources(
    input.projectId,
    input.config.includeResources !== false && !useHierarchicalBoards,
    {
      scanText: [
        input.currentChapter.title,
        input.currentChapter.synopsis,
        input.currentChapter.content,
        options.retrievalUserPrompt || '',
        worldbookScanContent,
      ]
        .filter(Boolean)
        .join('\n\n'),
      chapterTitle: input.currentChapter.title || '',
      chapterSynopsis: input.currentChapter.synopsis || '',
      retrievalUserPrompt: options.retrievalUserPrompt || '',
    },
    input.onDiagnostic,
  );
  let storyMemoryText = '';
  if (prepared?.checkpoint && prepared.checkpointEligibility?.usable) {
    try {
      storyMemoryText = renderStoryMemoryForContext(
        prepared.checkpoint.state,
        {
          currentChapter: input.currentChapter,
          budgetTokens: 1_000_000,
          retrievalUserPrompt: options.retrievalUserPrompt,
        },
      ).text;
    } catch (error) {
      input.onDiagnostic?.({
        code: 'STORY_MEMORY_RENDER_FAILED',
        severity: 'warning',
        message: '故事记忆渲染失败，故事记忆按空参与本次生成',
        stage: 'collect',
        source: 'collectGenerationMaterials.storyMemory',
        detail: { reason: String((error as Error)?.message || error) },
      });
      storyMemoryText = '';
    }
  }
  let resourcePreparation: CollectedGenerationMaterials['resourcePreparation'];
  if (useHierarchicalBoards) {
    const episodicProbe = input.measureEpisodicDemand
      ? await input.measureEpisodicDemand({
          projectId: input.projectId,
          candidates: episodicCandidates,
          currentChapter: input.currentChapter,
          retrievalOptions,
          onDiagnostic: input.onDiagnostic,
        })
      : { demandTokens: 0, text: '' };
    const fullScanText = [
      input.currentChapter.title,
      input.currentChapter.synopsis,
      input.currentChapter.content,
      options.retrievalUserPrompt || '',
      worldbookScanContent,
      episodicProbe.text,
    ]
      .filter(Boolean)
      .join('\n\n');
    let v3ResourceCandidates: ResourceContextCandidate[] | undefined;
    let v7Resources: Phase2BudgetResources | undefined;
    let resourceCollectionError: string | undefined;
    if (input.config.includeResources !== false || useHierarchicalBoards) {
      try {
        if (budgetVersion >= 7) {
          v7Resources = await collectPhase2BudgetResources({
            projectId: input.projectId,
            config: input.config,
            preset:
              typeof input.preset === 'string'
                ? undefined
                : input.preset || null,
            haystack: {
              chapter: input.currentChapter,
              retrievalUserPrompt: options.retrievalUserPrompt,
              previousChaptersText: worldbookScanContent,
              previousEnding: fullScanText.slice(-500),
              storyMemoryText: '',
              outlineText: preOutlineContext.text || '',
              episodicText: episodicProbe.text,
            },
            onDiagnostic: input.onDiagnostic,
          });
        } else {
          const collectedResources = await collectAllResourceCandidates(
            input.projectId,
            fullScanText,
            input.currentChapter,
            {
              retrievalUserPrompt: options.retrievalUserPrompt,
              recursiveWorldbook: input.config.worldbookRecursive !== false,
              onDiagnostic: input.onDiagnostic,
            },
          );
          v3ResourceCandidates = collectedResources.candidates;
        }
      } catch (error) {
        if (budgetVersion >= 7) {
          // V7 awareness is mandatory and already fail-closed in the
          // resource compiler. Preserve that contract while moving the IO
          // boundary into Collect.
          throw error;
        }
        resourceCollectionError = String((error as Error)?.message || error);
      }
    }
    resourcePreparation = {
      v3ResourceCandidates,
      v7Resources,
      episodicProbeText: episodicProbe.text,
      episodicProbeDemandTokens: episodicProbe.demandTokens,
      resourceCollectionError,
    };
  }
  return {
    projectId: input.projectId,
    currentChapter: input.currentChapter,
    config: input.config,
    preset: input.preset,
    options,
    chapters,
    previousChapters,
    episodicCandidates,
    rawChapterIds,
    prepared,
    coverage: prepared.coverage,
    coverageCandidates: prepared.coverageCandidates,
    preOutlineContext,
    worldbookScanContent,
    episodicQuery,
    retrievalOptions: retrievalOptions as unknown as Record<string, unknown>,
    resourceCandidates: [],
    resourceSources,
    storyMemoryText,
    resourcePreparation,
  };
}

export { deriveGenerationOutlineBudgetTokens, collectOutline };

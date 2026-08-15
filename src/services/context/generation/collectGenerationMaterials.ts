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
    } catch {
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
      noteContents = await (db as any).getNotesContentByIds(
        notesValue.map((note: any) => Number(note.id)),
      );
    } catch {
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
    settled.forEach(result => {
      if (result.status === 'fulfilled' && result.value) {
        noteStyleProfiles.push(result.value);
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
    } catch {
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
  const useHierarchicalBoards = budgetVersion >= 6;
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
    } catch {
      storyMemoryText = '';
    }
  }
  let resourcePreparation: CollectedGenerationMaterials['resourcePreparation'];
  if (
    useHierarchicalBoards &&
    Number(options.contextWindow) > 0 &&
    Number(options.reservedOutputTokens) > 0
  ) {
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
          });
        } else {
          const collectedResources = await collectAllResourceCandidates(
            input.projectId,
            fullScanText,
            input.currentChapter,
            {
              retrievalUserPrompt: options.retrievalUserPrompt,
              recursiveWorldbook: input.config.worldbookRecursive !== false,
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

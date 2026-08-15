import type { Chapter, ContextConfig, Preset } from '../../../types/novel';
import { captureResourceSourceSnapshot } from './resourceSourceSnapshot';
import { buildResourceContextV2 } from './resourceContextV2';
import type { DiagnosticSink } from '../generationDiagnostics';
import type {
  GlobalAwarenessCandidate,
  ResourceDetailCandidate,
  ResourceDetailIntensity,
  ResourceContextWarning,
  FrozenNoteRetrievalQuery,
  ResourceSourceSnapshot,
} from './resourceAwarenessTypes';

export interface Phase2HaystackInput {
  chapter: Chapter;
  retrievalUserPrompt?: string;
  previousChaptersText: string;
  /** Exact V6 retrieval seam; captured before the V7 snapshot closes. */
  previousEnding?: string;
  storyMemoryText: string;
  outlineText: string;
  episodicText: string;
}

export interface Phase2BudgetResources {
  source: ResourceSourceSnapshot;
  awareness: GlobalAwarenessCandidate[];
  details: ResourceDetailCandidate[];
  characterAwarenessText: string;
  worldbookAwarenessText: string;
  globalResourceAwarenessText: string;
  awarenessTokens: number;
  detailDemandTokens: number;
  warnings: ResourceContextWarning[];
  styleNotePresent: boolean;
  includeResources: boolean;
}

export async function collectPhase2BudgetResources(input: {
  projectId: number;
  config: ContextConfig;
  preset?: Preset | null;
  haystack: Phase2HaystackInput;
  onDiagnostic?: DiagnosticSink;
}): Promise<Phase2BudgetResources> {
  const includeResources = input.config.includeResources !== false;
  const source = await captureResourceSourceSnapshot(input.projectId, {
    includeResources,
    preset: input.preset,
    noteQuery: {
      chapterTitle: input.haystack.chapter.title || '',
      chapterSynopsis: input.haystack.chapter.synopsis || '',
      previousEnding:
        input.haystack.previousEnding ??
        input.haystack.previousChaptersText.slice(-500),
      userPrompt: input.haystack.retrievalUserPrompt || '',
    } satisfies FrozenNoteRetrievalQuery,
  });
  if (!includeResources) {
    return {
      source,
      awareness: [],
      details: [],
      characterAwarenessText: '',
      worldbookAwarenessText: '',
      globalResourceAwarenessText: '',
      awarenessTokens: 0,
      detailDemandTokens: 0,
      warnings: source.warnings || [],
      styleNotePresent: false,
      includeResources: false,
    };
  }

  const haystack = {
    title: input.haystack.chapter.title || '',
    synopsis: input.haystack.chapter.synopsis || '',
    currentBody: input.haystack.chapter.content || '',
    userPrompt: input.haystack.retrievalUserPrompt || '',
    previousChapter: input.haystack.previousChaptersText,
    previousChapters: input.haystack.previousChaptersText,
    storyMemory: input.haystack.storyMemoryText,
    outline: input.haystack.outlineText,
    episodic: input.haystack.episodicText,
    activatedDetailText: '',
  };

  const built = buildResourceContextV2({
    // V7 is compiled only from the captured source view. In particular, do
    // not replace notes here with a later projectId-based read: the snapshot
    // fingerprint, injected text, and stage resume must share one payload.
    source,
    haystack,
    recursiveWorldbook: input.config.worldbookRecursive !== false,
    detailIntensity: input.config.resourceDetailIntensity,
  });
  built.warnings.forEach(warning => {
    input.onDiagnostic?.({
      code:
        warning.code === 'NOTE_DETAIL_COMPILE_FAILED'
          ? 'RESOURCE_RENDER_FAILED'
          : warning.code === 'NOTE_STYLE_ANALYSIS_FAILED'
            ? 'NOTE_STYLE_ANALYSIS_FAILED'
            : 'NOTE_RETRIEVAL_FAILED',
      severity: 'warning',
      message: warning.message,
      stage: 'collect',
      source: `collectPhase2BudgetResources.resourceWarnings.${warning.code}`,
      detail: {
        sourceId: warning.sourceId ?? null,
        title: warning.title || null,
        action: warning.action || null,
      },
    });
  });

  return {
    ...built,
    source,
    includeResources: true,
  };
}

export function resolveDetailIntensity(
  config: ContextConfig,
): ResourceDetailIntensity {
  return config.resourceDetailIntensity === 'save' ||
    config.resourceDetailIntensity === 'rich'
    ? config.resourceDetailIntensity
    : 'balanced';
}

import type { Chapter, ContextConfig, Preset } from '../../../types/novel';
import { collectNoteCandidates } from '../resourceContextCandidates';
import { captureResourceSourceSnapshot } from './resourceSourceSnapshot';
import { buildResourceContextV2 } from './resourceContextV2';
import type {
  GlobalAwarenessCandidate,
  ResourceDetailCandidate,
  ResourceDetailIntensity,
  ResourceSourceSnapshot,
} from './resourceAwarenessTypes';

export interface Phase2HaystackInput {
  chapter: Chapter;
  retrievalUserPrompt?: string;
  previousChaptersText: string;
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
  styleNotePresent: boolean;
  includeResources: boolean;
}

export async function collectPhase2BudgetResources(input: {
  projectId: number;
  config: ContextConfig;
  preset?: Preset | null;
  haystack: Phase2HaystackInput;
}): Promise<Phase2BudgetResources> {
  const includeResources = input.config.includeResources !== false;
  const source = await captureResourceSourceSnapshot(input.projectId, {
    includeResources,
    preset: input.preset,
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
    source: { ...source, notes: [] },
    haystack,
    recursiveWorldbook: input.config.worldbookRecursive !== false,
    detailIntensity: input.config.resourceDetailIntensity,
  });

  const scanText = [
    haystack.title,
    haystack.synopsis,
    haystack.currentBody,
    haystack.userPrompt,
    haystack.previousChapters,
    haystack.storyMemory,
    haystack.episodic,
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const notes = await collectNoteCandidates(input.projectId, scanText, {
      retrievalUserPrompt: input.haystack.retrievalUserPrompt,
      chapterTitle: input.haystack.chapter.title,
      chapterSynopsis: input.haystack.chapter.synopsis,
    });
    const noteDetails: ResourceDetailCandidate[] = notes.candidates.map(
      (item, index) => ({
        id: item.id,
        sourceKind: 'note' as const,
        sourceId: item.sourceId,
        title: item.title,
        content: item.content,
        actualTokens: item.actualTokens,
        activationReason:
          item.title.includes('风格画像') ? 'style_note' : 'explicit',
        relevance: item.title.includes('风格画像') ? 0.42 : 0.55,
        explicitSelected: item.explicitSelected,
        sourceOrder: 2000 + index,
        retrievalScore: item.retrievalScore,
      }),
    );
    built.details.push(...noteDetails);
    if (noteDetails.some(item => item.activationReason === 'style_note')) {
      built.styleNotePresent = true;
    }
    built.detailDemandTokens += notes.totalActualTokens;
  } catch {
    // Notes stay compatible with the existing soft-degrade policy.
  }

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

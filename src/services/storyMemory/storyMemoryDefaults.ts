import { estimateTokens } from '../../utils/tokenEstimator';
import { fingerprintStoryMemoryState } from './storyMemoryFingerprint';
import type {
  ChapterMemoryPatchDraft,
  StoryMemoryState,
} from './storyMemoryTypes';

export function createEmptyStoryMemory(
  projectId: number,
  source: StoryMemoryState['metadata']['source'] = 'native',
): StoryMemoryState {
  const state: StoryMemoryState = {
    schemaVersion: 1,
    projectId,
    throughChapterId: null,
    throughChapterPosition: -1,
    characters: {},
    relationships: {},
    mainline: {
      currentArc: null,
      currentObjective: '',
      activeConflicts: {},
      openThreads: {},
      foreshadowing: {},
      timelineAnchors: {},
      recentCompletedBeats: [],
      recentResolvedThreads: [],
      archiveDigest: '',
    },
    metadata: {
      status: 'empty',
      source,
      stateFingerprint: '',
      lastAppliedPatchId: null,
      estimatedTokens: 0,
      dirtyFromPosition: null,
      lastError: '',
      updatedAt: new Date(0).toISOString(),
    },
  };
  state.metadata.stateFingerprint = fingerprintStoryMemoryState(state);
  state.metadata.estimatedTokens = estimateTokens(JSON.stringify(state));
  return state;
}

export function createEmptyChapterMemoryPatch(input: {
  chapterId: number;
  chapterPosition: number;
  title: string;
}): ChapterMemoryPatchDraft {
  return {
    schemaVersion: 1,
    chapterRef: input,
    episodicSummary: {
      brief: '',
      keywords: [],
      events: [],
      characterChanges: [],
      relationshipChanges: [],
      mainlineChanges: [],
      newThreads: [],
      resolvedThreads: [],
    },
    newCharacters: [],
    characterUpdates: [],
    newRelationships: [],
    relationshipUpdates: [],
    mainlinePatch: {
      assessment: { result: 'unchanged', reason: '本章无持续主线变化' },
      currentArcUpdate: {
        action: 'none',
        arcRef: '',
        name: '',
        summary: '',
        evidenceQuote: '',
      },
      conflictUpserts: [],
      conflictResolutions: [],
      threadOpens: [],
      threadUpdates: [],
      threadResolutions: [],
      foreshadowingUpserts: [],
      timelineAnchors: [],
      completedBeats: [],
    },
  };
}

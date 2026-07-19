import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import {
  applyStoryMemoryBatchPatch,
  batchPatchToChapterDraft,
} from '../src/services/storyMemory/storyMemoryMerger';
import type { StoryMemoryBatchPatchDraft } from '../src/services/storyMemory/storyMemoryTypes';

function baseBatch(): StoryMemoryBatchPatchDraft {
  return {
    schemaVersion: 2,
    rangeRef: {
      fromChapterId: 1,
      fromPosition: 0,
      throughChapterId: 3,
      throughPosition: 2,
    },
    chapterSummaries: [0, 1, 2].map(position => ({
      chapterId: position + 1,
      chapterPosition: position,
      brief: `事件${position + 1}`,
      keywords: [],
      events: [],
      characterChanges: [],
      relationshipChanges: [],
      mainlineChanges: [],
      newThreads: [],
      resolvedThreads: [],
    })),
    newCharacters: [
      {
        tempRef: 'new_char_lan',
        canonicalName: '林岚',
        aliases: [],
        role: '调查员',
        identity: '',
        stableTraits: [],
        // Net-change semantics: final state at batch end is 旅馆.
        initialState: { location: '旅馆' },
        status: 'active',
        evidence: [{ chapterId: 1, quote: '林岚推开暗门' }],
      },
    ],
    characterUpdates: [],
    newRelationships: [],
    relationshipUpdates: [],
    mainlinePatch: {
      currentArcUpdate: {
        action: 'none',
        arcRef: '',
        name: '',
        summary: '',
        evidence: [],
      },
      conflictUpserts: [],
      threadOpens: [],
      threadUpdates: [],
      threadResolutions: [],
      foreshadowingUpserts: [],
      timelineAnchors: [],
      completedBeats: [],
    },
  };
}

describe('story memory checkpoint merger', () => {
  it('uses first evidence chapter for stable character ids', () => {
    const previous = createEmptyStoryMemory(9);
    const draft = baseBatch();
    const first = applyStoryMemoryBatchPatch(previous, draft, {
      projectId: 9,
      sourceFingerprint: 'src_a',
      batchId: 'batch_a',
    });
    const chars = Object.values(first.state.characters);
    expect(chars).toHaveLength(1);
    expect(chars[0].canonicalName).toBe('林岚');
    expect(chars[0].firstSeenChapterId).toBe(1);
    expect(chars[0].currentState.location).toBe('旅馆');
    expect(first.state.throughChapterPosition).toBe(2);
    expect(first.state.metadata.lastAppliedPatchId).toBe('batch_a');
  });

  it('produces same stable id regardless of batch end chapter', () => {
    const draft = baseBatch();
    const { characterSeedChapterIds } = batchPatchToChapterDraft(draft);
    expect(characterSeedChapterIds.get('new_char_lan')).toBe(1);
    const a = applyStoryMemoryBatchPatch(createEmptyStoryMemory(9), draft, {
      projectId: 9,
      sourceFingerprint: 's1',
      batchId: 'b1',
    });
    const b = applyStoryMemoryBatchPatch(createEmptyStoryMemory(9), draft, {
      projectId: 9,
      sourceFingerprint: 's2',
      batchId: 'b2',
    });
    expect(Object.keys(a.state.characters)[0]).toBe(
      Object.keys(b.state.characters)[0],
    );
  });
});

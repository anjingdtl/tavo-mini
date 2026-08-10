import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import {
  buildStoryMemoryCheckpointMessages,
  buildStoryMemoryCheckpointRepairMessages,
  buildStoryMemoryPatchMessages,
} from '../src/services/storyMemory/storyMemoryPrompts';
import { validateStoryMemoryBatchPatch } from '../src/services/storyMemory/storyMemoryBatchValidator';

const chapter = {
  id: 1,
  project_id: 7,
  position: 0,
  title: '钟楼暗门',
  synopsis: '',
  content: '林岚决定查清钟楼暗门的来历。',
  status: 'final' as const,
  summary_json: null,
  created_at: '',
  updated_at: '',
};

function emptyBatchWithMainlineSummary() {
  return {
    schemaVersion: 2,
    rangeRef: {
      fromChapterId: 1,
      fromPosition: 0,
      throughChapterId: 1,
      throughPosition: 0,
    },
    chapterSummaries: [
      {
        chapterId: 1,
        chapterPosition: 0,
        brief: '林岚决定调查钟楼暗门。',
        keywords: [],
        events: [],
        characterChanges: [],
        relationshipChanges: [],
        mainlineChanges: ['林岚决定调查钟楼暗门。'],
        newThreads: [],
        resolvedThreads: [],
      },
    ],
    newCharacters: [],
    characterUpdates: [],
    newRelationships: [],
    relationshipUpdates: [],
    mainlinePatch: {
      assessment: { result: 'changed', reason: '形成持续调查目标' },
      currentArcUpdate: {
        action: 'none',
        arcRef: '',
        name: '',
        summary: '',
        evidence: [],
      },
      currentObjective: undefined,
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

describe('story memory mainline contract', () => {
  it('exposes objective, assessment, and conflict resolution in both prompt schemas', () => {
    const state = createEmptyStoryMemory(7);
    const single = buildStoryMemoryPatchMessages(chapter, state)[1].content;
    const batch = buildStoryMemoryCheckpointMessages([chapter], state)[1]
      .content;

    for (const message of [single, batch]) {
      expect(message).toContain('currentObjective');
      expect(message).toContain('conflictResolutions');
      expect(message).toContain('assessment');
      expect(message).toContain('故事主线检查清单');
    }
  });

  it('repair instructions forbid clearing mainline operations to bypass validation', () => {
    const base = buildStoryMemoryCheckpointMessages(
      [chapter],
      createEmptyStoryMemory(7),
    );
    const repaired = buildStoryMemoryCheckpointRepairMessages(
      base,
      '{}',
      '主线摘要与补丁不一致',
    );
    expect(repaired.at(-1)?.content).toContain('禁止把 mainlinePatch 改成全空');
  });

  it('locally reconciles a changed mainline assessment with no state mutation (governance §4 Rule A+E)', () => {
    // Old behavior: this combination hard-failed with MEMORY_CHECKPOINT_SCHEMA_INVALID,
    // consuming a paid Repair round. Per the final governance plan, pure
    // classification divergence is now reconciled locally:
    //   - mainlineChanges text → downgraded to events (retrieval preserved)
    //   - assessment=changed with no mutation → normalized to unchanged
    // Structured State remains the sole persistent authority.
    const draft = validateStoryMemoryBatchPatch(
      emptyBatchWithMainlineSummary(),
      createEmptyStoryMemory(7),
      [chapter],
      { requireMainlineAssessment: true },
    );
    expect(draft.mainlinePatch.assessment?.result).toBe('unchanged');
    expect(draft.chapterSummaries[0].mainlineChanges).toHaveLength(0);
    // The mainline information is preserved for retrieval, tagged by origin.
    expect(draft.chapterSummaries[0].events).toContain(
      '[主线] 林岚决定调查钟楼暗门。',
    );
  });
});

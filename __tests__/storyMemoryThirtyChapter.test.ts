/**
 * Deterministic 30-chapter request-count proof for default smart/interval=3.
 * Proves main checkpoint requests ≈ 10, not 30, with zero uncovered chapters.
 */
import type { Chapter } from '../src/types/novel';
import {
  evaluateStoryMemoryDue,
  listPendingChapters,
  createDefaultStoryMemoryPolicy,
  splitCheckpointBatches,
} from '../src/services/storyMemory/storyMemoryPolicy';
import { planStoryMemoryCoverage } from '../src/services/storyMemory/storyMemoryCoverage';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import { applyStoryMemoryBatchPatch } from '../src/services/storyMemory/storyMemoryMerger';
import type { StoryMemoryBatchPatchDraft } from '../src/services/storyMemory/storyMemoryTypes';

function makeChapter(position: number): Chapter {
  return {
    id: position + 1,
    project_id: 1,
    position,
    title: `第 ${position + 1} 章`,
    synopsis: `概要${position + 1}`,
    content: `第 ${position + 1} 章正文。主角推进剧情，出现线索。`.repeat(2),
    status: 'final',
    summary_json: null,
    memory_summary: `核心事件：第 ${position + 1} 章事件`,
    created_at: '',
    updated_at: '',
  };
}

function emptyBatch(chapters: Chapter[]): StoryMemoryBatchPatchDraft {
  const ordered = [...chapters].sort((a, b) => a.position - b.position);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  return {
    schemaVersion: 2,
    rangeRef: {
      fromChapterId: first.id,
      fromPosition: first.position,
      throughChapterId: last.id,
      throughPosition: last.position,
    },
    chapterSummaries: ordered.map(chapter => ({
      chapterId: chapter.id,
      chapterPosition: chapter.position,
      brief: `第 ${chapter.position + 1} 章事件`,
      keywords: ['线索'],
      events: [`事件${chapter.position + 1}`],
      characterChanges: [],
      relationshipChanges: [],
      mainlineChanges: [],
      newThreads: [],
      resolvedThreads: [],
    })),
    newCharacters: [],
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

describe('30-chapter story memory checkpoint request proof', () => {
  it('defaults to 10 main checkpoint batches for 30 chapters at interval 3', () => {
    const policy = createDefaultStoryMemoryPolicy(1, {
      mode: 'smart',
      intervalChapters: 3,
    });
    expect(policy.mode).toBe('smart');
    expect(policy.intervalChapters).toBe(3);

    const chapters = Array.from({ length: 30 }, (_, i) => makeChapter(i));
    let through = -1;
    let mainRequests = 0;
    let nonDueFinalizes = 0;
    const requestLog: Array<{ from: number; through: number }> = [];

    for (const chapter of chapters) {
      const pending = listPendingChapters(
        chapters.filter(c => c.position <= chapter.position),
        through,
      );
      const due = evaluateStoryMemoryDue({
        policy,
        checkpointThroughPosition: through,
        pendingChapters: pending,
      });
      if (!due.due) {
        nonDueFinalizes += 1;
        continue;
      }
      const batchChapters = pending.filter(
        item =>
          item.position >= (due.fromPosition ?? item.position) &&
          item.position <= (due.throughPosition ?? item.position),
      );
      const batches = splitCheckpointBatches(batchChapters);
      for (const batch of batches) {
        mainRequests += 1;
        requestLog.push({
          from: batch[0].position,
          through: batch[batch.length - 1].position,
        });
        through = batch[batch.length - 1].position;
      }
    }

    expect(mainRequests).toBe(10);
    expect(mainRequests).toBe(Math.ceil(30 / 3));
    expect(nonDueFinalizes).toBe(20);
    expect(requestLog).toHaveLength(10);
    expect(through).toBe(29);
  });

  it('keeps uncoveredChapterIds empty after each checkpoint with default budget', () => {
    const chapters = Array.from({ length: 30 }, (_, i) => makeChapter(i));
    let through = -1;
    let state = createEmptyStoryMemory(1);
    for (let i = 0; i < 30; i += 3) {
      const batch = chapters.slice(i, i + 3);
      const draft = emptyBatch(batch);
      const applied = applyStoryMemoryBatchPatch(state, draft, {
        projectId: 1,
        sourceFingerprint: `src_${i}`,
        baseMemoryFingerprint: state.metadata.stateFingerprint,
        batchId: `batch_${i}`,
        now: new Date().toISOString(),
      });
      state = applied.state;
      through = batch[batch.length - 1].position;

      // Simulate generating the next chapter after this checkpoint.
      if (through < 29) {
        const current = chapters[through + 1];
        const plan = planStoryMemoryCoverage({
          currentChapter: current,
          chapters,
          checkpointThroughPosition: through,
          slidingBudgetTokens: 4000,
        });
        expect(plan.uncoveredChapterIds).toEqual([]);
        expect(plan.hardDue).toBe(false);
      }
    }
    expect(state.throughChapterPosition).toBe(29);
  });

  it('never uses N sequential per-chapter requests for a due batch', () => {
    const pending = [makeChapter(0), makeChapter(1), makeChapter(2)];
    const batches = splitCheckpointBatches(pending);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    // One batch object → one LLM request contract.
    expect(batches.reduce((sum, b) => sum + b.length, 0)).toBe(3);
  });
});

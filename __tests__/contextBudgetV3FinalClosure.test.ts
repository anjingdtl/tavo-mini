import {
  collectStoryMemoryCoverageCandidates,
  resolveStoryMemoryCoverage,
} from '../src/services/storyMemory/storyMemoryCoverage';
import type { Chapter } from '../src/types/novel';

function chapter(id: number, content: string, summary = ''): Chapter {
  return {
    id,
    project_id: 1,
    position: id,
    title: `第${id + 1}章`,
    synopsis: '',
    content,
    memory_summary: summary || null,
    summary_json: null,
    status: 'final',
    finalized_at: '2026-08-12T00:00:00.000Z',
    created_at: '',
    updated_at: '',
  } as Chapter;
}

describe('Context Budget V3 final closure — candidate-first Story Coverage', () => {
  test('candidate planning is independent of legacy sliding budget', () => {
    const chapters = Array.from({ length: 12 }, (_, index) =>
      chapter(index, `正文 ${index} `.repeat(120), `摘要 ${index}`),
    );
    const currentChapter = chapter(12, '当前章');

    const candidates = collectStoryMemoryCoverageCandidates({
      currentChapter,
      chapters,
      checkpointThroughPosition: -1,
    });

    expect(candidates.rawEligibleChapters).toHaveLength(10);
    expect(candidates.rawEligibleChapters.map(item => item.id)).toEqual(
      chapters.slice(-10).map(item => item.id),
    );
    expect(candidates.rawEligibleChapters.map(item => item.id)).not.toContain(0);
  });

  test('V3 grant, not legacy config, decides raw versus episodic coverage', () => {
    const chapters = Array.from({ length: 4 }, (_, index) =>
      chapter(index, `正文 ${index} `.repeat(100), `摘要 ${index}`),
    );
    const candidates = collectStoryMemoryCoverageCandidates({
      currentChapter: chapter(4, '当前章'),
      chapters,
      checkpointThroughPosition: -1,
    });

    const smallGrant = resolveStoryMemoryCoverage({
      candidates,
      slidingBudgetTokens: 20,
    });
    const largeGrant = resolveStoryMemoryCoverage({
      candidates,
      slidingBudgetTokens: 100_000,
    });

    expect(smallGrant.rawChapterIds.length).toBeLessThanOrEqual(10);
    expect(largeGrant.rawChapterIds).toHaveLength(4);
    expect(largeGrant.rawChapterIds).not.toEqual(smallGrant.rawChapterIds);
    expect(smallGrant.reason).toMatch(/coverage|episodic|raw/);
  });
});

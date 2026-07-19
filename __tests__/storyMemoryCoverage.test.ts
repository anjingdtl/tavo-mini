import type { Chapter } from '../src/types/novel';
import {
  buildPendingBridgeText,
  excludeRawFromEpisodicCandidates,
  planStoryMemoryCoverage,
} from '../src/services/storyMemory/storyMemoryCoverage';

function chapter(
  position: number,
  options: { content?: string; summary?: string; id?: number } = {},
): Chapter {
  return {
    id: options.id ?? position + 1,
    project_id: 1,
    position,
    title: `第 ${position + 1} 章`,
    synopsis: '',
    content: options.content ?? `第 ${position + 1} 章正文。`,
    memory_summary: options.summary,
    status: 'final',
    summary_json: null,
    created_at: '',
    updated_at: '',
  };
}

describe('storyMemoryCoverage', () => {
  const current = chapter(9, { content: '当前章' });

  it('returns empty coverage when no pending chapters', () => {
    const plan = planStoryMemoryCoverage({
      currentChapter: chapter(1),
      chapters: [chapter(0)],
      checkpointThroughPosition: 0,
      slidingBudgetTokens: 4000,
    });
    expect(plan.pendingChapters).toHaveLength(0);
    expect(plan.hardDue).toBe(false);
    expect(plan.uncoveredChapterIds).toEqual([]);
    expect(plan.seamChapter?.position).toBe(0);
  });

  it('covers pending chapters fully with raw text when budget allows', () => {
    const chapters = [chapter(5), chapter(6), chapter(7), chapter(8), current];
    const plan = planStoryMemoryCoverage({
      currentChapter: current,
      chapters,
      checkpointThroughPosition: 5,
      slidingBudgetTokens: 4000,
    });
    expect(plan.pendingChapters.map(c => c.position)).toEqual([6, 7, 8]);
    expect(plan.rawChapterIds).toEqual([7, 8, 9]);
    expect(plan.episodicFallbackChapterIds).toEqual([]);
    expect(plan.uncoveredChapterIds).toEqual([]);
    expect(plan.hardDue).toBe(false);
    expect(plan.seamChapter?.position).toBe(8);
  });

  it('uses episodic fallback when raw exceeds budget', () => {
    const long = '长正文'.repeat(200);
    const chapters = [
      chapter(5),
      chapter(6, { content: long, summary: '第六章事件摘要' }),
      chapter(7, { content: long, summary: '第七章事件摘要' }),
      chapter(8, { content: '短正文', summary: '第八章摘要' }),
      current,
    ];
    const plan = planStoryMemoryCoverage({
      currentChapter: current,
      chapters,
      checkpointThroughPosition: 5,
      slidingBudgetTokens: 80,
    });
    expect(plan.uncoveredChapterIds).toEqual([]);
    expect(
      plan.rawChapterIds.length + plan.episodicFallbackChapterIds.length,
    ).toBe(3);
    expect(plan.hardDue).toBe(false);
  });

  it('marks hardDue when raw and summaries cannot cover all pending', () => {
    const huge = '超长'.repeat(500);
    const chapters = [
      chapter(0, { content: huge }),
      chapter(1, { content: huge }),
      chapter(2, { content: huge }),
      chapter(3, { content: '当前' }),
    ];
    const plan = planStoryMemoryCoverage({
      currentChapter: chapters[3],
      chapters,
      checkpointThroughPosition: -1,
      slidingBudgetTokens: 20,
    });
    expect(plan.hardDue).toBe(true);
    expect(plan.uncoveredChapterIds.length).toBeGreaterThan(0);
    const covered = new Set([
      ...plan.rawChapterIds,
      ...plan.episodicFallbackChapterIds,
      ...plan.uncoveredChapterIds,
    ]);
    expect(covered.size).toBe(plan.pendingChapters.length);
  });

  it('handles position holes without inventing missing chapters', () => {
    const chapters = [chapter(0), chapter(2), chapter(5), chapter(6)];
    const plan = planStoryMemoryCoverage({
      currentChapter: chapters[3],
      chapters,
      checkpointThroughPosition: 0,
      slidingBudgetTokens: 4000,
    });
    expect(plan.pendingChapters.map(c => c.position)).toEqual([2, 5]);
    expect(plan.uncoveredChapterIds).toEqual([]);
  });

  it('builds bridge text in position order and excludes raw from episodic', () => {
    const chapters = [chapter(0), chapter(1, { summary: '摘要1' }), chapter(2)];
    const plan = planStoryMemoryCoverage({
      currentChapter: chapters[2],
      chapters,
      checkpointThroughPosition: -1,
      slidingBudgetTokens: 4000,
    });
    const text = buildPendingBridgeText(
      plan,
      new Map(chapters.map(c => [c.id, c])),
    );
    expect(text.indexOf('第 1 章')).toBeLessThan(text.indexOf('第 2 章'));
    const filtered = excludeRawFromEpisodicCandidates(chapters, plan.rawChapterIds);
    expect(filtered.every(c => !plan.rawChapterIds.includes(c.id))).toBe(true);
  });

  it('never treats empty summary as coverage', () => {
    const huge = '超长'.repeat(400);
    const chapters = [
      chapter(0, { content: huge, summary: '' }),
      chapter(1, { content: huge, summary: '   ' }),
      chapter(2, { content: '当前' }),
    ];
    const plan = planStoryMemoryCoverage({
      currentChapter: chapters[2],
      chapters,
      checkpointThroughPosition: -1,
      slidingBudgetTokens: 10,
    });
    expect(plan.episodicFallbackChapterIds).toEqual([]);
    expect(plan.hardDue).toBe(true);
  });
});

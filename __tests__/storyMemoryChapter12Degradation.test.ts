/**
 * V2.11.38 repair plan P0 acceptance — the deterministic chapter-12 boundary.
 *
 * Scenario: 11 finalized chapters exist, checkpoint never succeeded
 * (throughPosition = -1), no episodic summaries. Chapter 12 (position 11) is
 * the target:
 *   - the most recent 10 chapters may enter the context as raw text;
 *   - chapter 1 falls into uncoveredChapterIds;
 *   - prepare() must DEGRADE with warnings, never block;
 *   - buildContext() must still compile non-empty messages with a
 *     story_memory trace entry that lists the omitted chapter.
 */

import type { Chapter } from '../src/types/novel';

const mockGetChapters = jest.fn();
const mockGetMemory = jest.fn();
const mockEnsure = jest.fn();

jest.mock('../src/services/database', () => ({
  getChaptersByProject: (...args: any[]) => mockGetChapters(...args),
  getProjectStoryMemory: (...args: any[]) => mockGetMemory(...args),
  ensureProjectStoryMemoryRow: (...args: any[]) => mockEnsure(...args),
  getCharactersByProject: jest.fn(async () => []),
  getWorldbookEntriesByProject: jest.fn(async () => []),
  getNotesByProject: jest.fn(async () => []),
  getNotesContentByIds: jest.fn(async () => ({})),
  getProjectNoteConfig: jest.fn(async () => null),
}));

jest.mock('../src/services/macroReplace', () => ({
  processMacros: jest.fn(async (text: string) => text),
}));

import { prepareStoryMemoryForGeneration } from '../src/services/storyMemory/storyMemoryPrepare';
import { buildContext } from '../src/services/contextBuilder';
import { STORY_MEMORY_MAX_RAW_CHAPTERS } from '../src/services/storyMemory/storyMemoryCoverage';

function chapter(position: number, content: string): Chapter {
  return {
    id: position + 1,
    project_id: 1,
    position,
    title: `第 ${position + 1} 章`,
    synopsis: '',
    content,
    status: 'final',
    summary_json: null,
    memory_summary: '',
    created_at: '',
    updated_at: '',
  };
}

function buildElevenChapters(): Chapter[] {
  const chapters: Chapter[] = [];
  for (let position = 0; position < 11; position += 1) {
    chapters.push(chapter(position, `第 ${position + 1} 章正文。`));
  }
  return chapters;
}

const targetChapter = chapter(11, '当前章正文');

const EMPTY_RECORD = {
  state: { throughChapterPosition: -1, throughChapterId: null },
  status: 'empty',
  dirtyFromPosition: null,
  lastError: '',
  updatedAt: '',
};

const CONTEXT_CONFIG = {
  strategy: 'sliding',
  slidingWindowSize: 4000,
  customRangeStart: 0,
  customRangeEnd: -1,
  includeResources: false,
  resourceBudget: 0,
  summaryBudgetTokens: 2000,
  episodicMemoryBudgetTokens: 1000,
  storyStateBudgetTokens: 4000,
} as any;

describe('repair plan P0 — chapter 12 with never-succeeded checkpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetChapters.mockResolvedValue([...buildElevenChapters(), targetChapter]);
    mockGetMemory.mockResolvedValue(EMPTY_RECORD);
  });

  it('prepare degrades: fatal=false, raw ≤ 10 chapters, chapter 1 uncovered, warning emitted', async () => {
    const prepared = await prepareStoryMemoryForGeneration(
      1,
      targetChapter,
      { slidingWindowSize: 4000 } as any,
      { mode: 'preview' },
    );

    expect(prepared.fatal).toBe(false);
    expect(prepared.blocked).toBe(false);
    expect(prepared.degraded).toBe(true);
    expect(prepared.coverage.rawChapterIds.length).toBeLessThanOrEqual(
      STORY_MEMORY_MAX_RAW_CHAPTERS,
    );
    // Chapter 1 (position 0) is the only chapter older than the raw-10 tail.
    const uncoveredPositions = prepared.coverage.uncoveredChapterIds.map(
      id => id - 1,
    );
    expect(uncoveredPositions).toEqual([0]);
    const omitted = prepared.warnings.find(
      w => w.code === 'history_partially_omitted',
    );
    expect(omitted).toBeDefined();
    expect(omitted?.uncoveredChapterIds).toEqual([1]);
    expect(prepared.checkpoint).toBeNull();
  });

  it('buildContext compiles non-empty messages with degraded trace and warnings', async () => {
    const result = await buildContext(
      targetChapter,
      CONTEXT_CONFIG,
      1,
      undefined,
      { storyMemoryMode: 'preview', retrievalUserPrompt: '' },
    );

    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.storyMemoryWarnings.length).toBeGreaterThan(0);
    expect(
      result.storyMemoryWarnings.some(
        w => w.code === 'history_partially_omitted',
      ),
    ).toBe(true);
    const storyTrace = result.trace.find(t => t.kind === 'story_memory');
    expect(storyTrace).toBeDefined();
    expect(storyTrace?.reason).toContain('未覆盖');
    // The degraded preview must not pretend history was fully covered.
    expect(result.messages.some(m => m.content.includes('第 1 章'))).toBe(false);
  });

  it('non-degraded early chapter (≤ 10 pending) stays quiet', async () => {
    const earlyTarget = chapter(5, '当前章正文');
    mockGetChapters.mockResolvedValue([...buildElevenChapters().slice(0, 6), earlyTarget]);
    const prepared = await prepareStoryMemoryForGeneration(
      1,
      earlyTarget,
      { slidingWindowSize: 4000 } as any,
      { mode: 'preview' },
    );
    expect(prepared.fatal).toBe(false);
    expect(prepared.degraded).toBe(false);
    expect(prepared.coverage.uncoveredChapterIds).toEqual([]);
  });
});

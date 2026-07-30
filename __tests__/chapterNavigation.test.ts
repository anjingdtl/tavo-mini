/* eslint-env jest */

import { findOrCreateNextChapter } from '../src/services/chapterNavigation';

const mockGetChaptersByProject = jest.fn();
const mockCreateChapter = jest.fn();
const mockGetNextContinuationChapterPosition = jest.fn();
const mockGetContinuationChapterNumbering = jest.fn();

jest.mock('../src/services/database', () => ({
  getChaptersByProject: (...args: any[]) =>
    mockGetChaptersByProject(...args),
  createChapter: (...args: any[]) => mockCreateChapter(...args),
}));

jest.mock(
  '../src/services/continuation/chapterNumbering/continuationChapterNumbering',
  () => ({
    getNextContinuationChapterPosition: (...args: any[]) =>
      mockGetNextContinuationChapterPosition(...args),
    getContinuationChapterNumbering: (...args: any[]) =>
      mockGetContinuationChapterNumbering(...args),
  }),
);

function makeChapters(
  rows: Array<{ id: number; position: number; title?: string }>,
) {
  return rows.map(row => ({
    id: row.id,
    project_id: 10,
    position: row.position,
    title: row.title ?? `第 ${row.position + 1} 章`,
    synopsis: '',
    content: '已采纳内容',
    status: 'draft',
    summary_json: null,
    created_at: '',
    updated_at: '',
  }));
}

beforeEach(() => {
  mockGetChaptersByProject.mockReset();
  mockCreateChapter.mockReset();
  mockGetNextContinuationChapterPosition.mockReset();
  mockGetContinuationChapterNumbering.mockReset();
});

describe('findOrCreateNextChapter — outline', () => {
  it('returns the next existing chapter id without creating', async () => {
    const chapters = makeChapters([
      { id: 1, position: 0 },
      { id: 2, position: 1 },
      { id: 3, position: 2 },
    ]);
    mockGetChaptersByProject.mockResolvedValue(chapters);

    const nextId = await findOrCreateNextChapter(10, 2, 'outline');

    expect(nextId).toBe(3);
    expect(mockCreateChapter).not.toHaveBeenCalled();
  });

  it('appends a new chapter when current is the last one (position = chapters.length)', async () => {
    const chapters = makeChapters([
      { id: 1, position: 0 },
      { id: 2, position: 1 },
    ]);
    mockGetChaptersByProject.mockResolvedValue(chapters);
    mockCreateChapter.mockResolvedValue(99);

    const nextId = await findOrCreateNextChapter(10, 2, 'outline');

    expect(mockCreateChapter).toHaveBeenCalledWith(10, chapters.length);
    expect(nextId).toBe(99);
  });

  it('treats missing current chapter as "append to end"', async () => {
    // Defensive: currentChapterId 不在 chapters 里时 → 走到末尾追加分支
    const chapters = makeChapters([{ id: 1, position: 0 }]);
    mockGetChaptersByProject.mockResolvedValue(chapters);
    mockCreateChapter.mockResolvedValue(50);

    const nextId = await findOrCreateNextChapter(10, 999, 'outline');

    expect(mockCreateChapter).toHaveBeenCalledWith(10, 1);
    expect(nextId).toBe(50);
  });
});

describe('findOrCreateNextChapter — freeform', () => {
  it('mirrors outline behavior (freeform shares chapters table, no continuation semantics)', async () => {
    const chapters = makeChapters([
      { id: 1, position: 0 },
      { id: 2, position: 1 },
    ]);
    mockGetChaptersByProject.mockResolvedValue(chapters);
    mockCreateChapter.mockResolvedValue(77);

    const nextId = await findOrCreateNextChapter(10, 2, 'freeform');

    expect(mockCreateChapter).toHaveBeenCalledWith(10, 2);
    expect(nextId).toBe(77);
  });
});

describe('findOrCreateNextChapter — continuation', () => {
  it('returns the next existing continuation chapter id without creating', async () => {
    const chapters = makeChapters([
      { id: 10, position: 0 },
      { id: 11, position: 1 },
    ]);
    mockGetChaptersByProject.mockResolvedValue(chapters);

    const nextId = await findOrCreateNextChapter(
      10,
      10,
      'continuation',
    );

    expect(nextId).toBe(11);
    expect(mockGetNextContinuationChapterPosition).not.toHaveBeenCalled();
    expect(mockCreateChapter).not.toHaveBeenCalled();
  });

  it('uses MAX(position)+1 and continues title from boundary (§11.4)', async () => {
    const chapters = makeChapters([
      { id: 10, position: 0 },
      { id: 11, position: 1 },
    ]);
    mockGetChaptersByProject.mockResolvedValue(chapters);
    // 当前最后一章 position=1 → 下一章 position=2
    mockGetNextContinuationChapterPosition.mockResolvedValue(2);
    mockGetContinuationChapterNumbering.mockResolvedValue({
      boundaryChapterNumber: 20,
      getDisplayNumber: (p: number) => 20 + Number(p) + 1,
      // 第 20 章为边界 → 续写第 0 章 = 第 21 章，第 2 章 = 第 23 章
      getDefaultTitle: (p: number) => `第 ${20 + Number(p) + 1} 章`,
      getDisplayTitle: (chapter: any) => chapter.title,
    });
    mockCreateChapter.mockResolvedValue(42);

    const nextId = await findOrCreateNextChapter(
      10,
      11,
      'continuation',
    );

    expect(mockGetNextContinuationChapterPosition).toHaveBeenCalledWith(10);
    expect(mockCreateChapter).toHaveBeenCalledWith(
      10,
      2,
      '第 23 章',
    );
    expect(nextId).toBe(42);
  });

  it('handles non-contiguous positions without colliding after deletion (§11.4)', async () => {
    // 续写 position=0,1,3（中间 2 被删）→ 下一章应该是 MAX+1=4，不是 length=3
    const chapters = makeChapters([
      { id: 10, position: 0 },
      { id: 11, position: 1 },
      { id: 13, position: 3 },
    ]);
    mockGetChaptersByProject.mockResolvedValue(chapters);
    mockGetNextContinuationChapterPosition.mockResolvedValue(4);
    mockGetContinuationChapterNumbering.mockResolvedValue({
      boundaryChapterNumber: 20,
      getDisplayNumber: (p: number) => 20 + Number(p) + 1,
      getDefaultTitle: (p: number) => `第 ${20 + Number(p) + 1} 章`,
      getDisplayTitle: (chapter: any) => chapter.title,
    });
    mockCreateChapter.mockResolvedValue(99);

    const nextId = await findOrCreateNextChapter(
      10,
      13,
      'continuation',
    );

    // 当前是 position=3 那一章（id=13），它就是最后一章；下一章 position=4
    expect(mockGetNextContinuationChapterPosition).toHaveBeenCalledWith(10);
    expect(mockCreateChapter).toHaveBeenCalledWith(10, 4, '第 25 章');
    expect(nextId).toBe(99);
  });

  it('returns next chapter when not at last (position 1 → 3, gap at 2)', async () => {
    // position=0,1,3 都有章节，当前是 position=1，下一章按 chapters 数组顺序是 position=3
    // （getChaptersByProject ORDER BY position ASC, id ASC 已确保这个顺序）
    const chapters = makeChapters([
      { id: 10, position: 0 },
      { id: 11, position: 1 },
      { id: 13, position: 3 },
    ]);
    mockGetChaptersByProject.mockResolvedValue(chapters);

    const nextId = await findOrCreateNextChapter(
      10,
      11,
      'continuation',
    );

    expect(nextId).toBe(13);
    expect(mockCreateChapter).not.toHaveBeenCalled();
  });
});
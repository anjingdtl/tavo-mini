/* eslint-env jest */

jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: jest.fn(),
}));

jest.mock('../src/services/continuation/continuationSourceReader', () => ({
  continuationSourceReader: {
    getSnapshot: jest.fn(),
  },
}));

import { openDatabase } from '../src/data/connection/openDatabase';
import { continuationSourceReader } from '../src/services/continuation/continuationSourceReader';
import {
  AUTO_TITLE_REGEX,
  getNextContinuationChapterPosition,
  isAutoChapterTitle,
  makeContinuationChapterNumbering,
  renumberContinuationChapterTitles,
} from '../src/services/continuation/chapterNumbering/continuationChapterNumbering';
import type { ContinuationChapterPosition } from '../src/types/novel';

const pos = (n: number) => n as ContinuationChapterPosition;

function mockRows(items: Array<Record<string, unknown>>) {
  return {
    rows: {
      length: items.length,
      item: (i: number) => items[i],
    },
  };
}

describe('continuation chapter numbering — pure mapping', () => {
  it('continues from the boundary source chapter (§11.2)', () => {
    // Boundary at end of source chapter 20 → first continuation is 第21章.
    const n = makeContinuationChapterNumbering(20);
    expect(n.boundaryChapterNumber).toBe(20);
    expect(n.getDisplayNumber(pos(0))).toBe(21);
    expect(n.getDisplayNumber(pos(1))).toBe(22);
    expect(n.getDisplayNumber(pos(2))).toBe(23);
    expect(n.getDefaultTitle(pos(0))).toBe('第 21 章');
    expect(n.getDefaultTitle(pos(1))).toBe('第 22 章');
  });

  it('falls back to position+1 when no source/boundary (§11.2)', () => {
    const n = makeContinuationChapterNumbering(null);
    expect(n.boundaryChapterNumber).toBeNull();
    expect(n.getDisplayNumber(pos(0))).toBe(1);
    expect(n.getDisplayNumber(pos(1))).toBe(2);
    expect(n.getDefaultTitle(pos(0))).toBe('第 1 章');
  });

  it('boundary chapter 0 (first source chapter) yields continuation 第1章', () => {
    const n = makeContinuationChapterNumbering(0);
    expect(n.getDisplayNumber(pos(0))).toBe(1);
  });
});

describe('continuation chapter numbering — title protection (§11.5)', () => {
  it('keeps user-custom titles verbatim', () => {
    const n = makeContinuationChapterNumbering(20);
    expect(n.getDisplayTitle({ title: '夜雨来客', position: 0 })).toBe(
      '夜雨来客',
    );
    expect(
      n.getDisplayTitle({ title: '第 21 章 夜雨', position: 0 }),
    ).toBe('第 21 章 夜雨');
  });

  it('renumbers pure auto titles to follow the boundary', () => {
    const n = makeContinuationChapterNumbering(20);
    // An old auto title (e.g. from before a boundary change) is recomputed.
    expect(n.getDisplayTitle({ title: '第 1 章', position: 0 })).toBe('第 21 章');
    expect(n.getDisplayTitle({ title: '第 5 章', position: 4 })).toBe('第 25 章');
  });

  it('auto-title regex covers CN/EN whitespace variants', () => {
    expect(isAutoChapterTitle('第1章')).toBe(true);
    expect(isAutoChapterTitle('第 1 章')).toBe(true);
    expect(isAutoChapterTitle('第  21  章')).toBe(true);
    expect(isAutoChapterTitle('第21章')).toBe(true);
    // Anything with a subtitle or non-numeric is custom.
    expect(isAutoChapterTitle('第 21 章 夜雨')).toBe(false);
    expect(isAutoChapterTitle('夜雨来客')).toBe(false);
    expect(isAutoChapterTitle('Chapter 1')).toBe(false);
    expect(isAutoChapterTitle('')).toBe(false);
    expect(isAutoChapterTitle('第序章')).toBe(false);
    expect(isAutoChapterTitle('第一章')).toBe(false); // 中文数字不支持，视为自定义
  });

  it('AUTO_TITLE_REGEX captures the numeric segment', () => {
    const m = AUTO_TITLE_REGEX.exec('第 21 章');
    expect(m?.[1]).toBe('21');
  });
});

describe('getNextContinuationChapterPosition (§11.4)', () => {
  const executeSql = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (openDatabase as jest.Mock).mockResolvedValue({ executeSql });
  });

  it('returns 0 when the project has no chapters', async () => {
    // COALESCE(MAX(position), -1) → -1 → next = 0
    executeSql.mockResolvedValueOnce([mockRows([{ max_pos: -1 }])]);
    await expect(getNextContinuationChapterPosition(7)).resolves.toBe(0);
    expect(executeSql).toHaveBeenCalledWith(
      'SELECT COALESCE(MAX(position), -1) AS max_pos FROM chapters WHERE project_id = ?',
      [7],
    );
  });

  it('returns max(position)+1 for contiguous chapters', async () => {
    executeSql.mockResolvedValueOnce([mockRows([{ max_pos: 2 }])]);
    await expect(getNextContinuationChapterPosition(7)).resolves.toBe(3);
  });

  it('uses max+1 even when positions have holes (never chapters.length)', async () => {
    // Existing positions 0, 1, 5 → next must be 6, not 3.
    executeSql.mockResolvedValueOnce([mockRows([{ max_pos: 5 }])]);
    await expect(getNextContinuationChapterPosition(7)).resolves.toBe(6);
  });
});

describe('renumberContinuationChapterTitles (§11.5)', () => {
  const executeSql = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (openDatabase as jest.Mock).mockResolvedValue({ executeSql });
  });

  it('rewrites pure auto titles after a boundary change', async () => {
    // Boundary at source chapter position 19 → display source number 20.
    (continuationSourceReader.getSnapshot as jest.Mock).mockResolvedValue({
      boundary: { chapterPosition: 19 },
    });
    executeSql
      // SELECT chapters
      .mockResolvedValueOnce([
        mockRows([
          { id: 1, position: 0, title: '第 1 章' },
          { id: 2, position: 1, title: '第 2 章' },
        ]),
      ])
      // UPDATE chapter 1
      .mockResolvedValueOnce([mockRows([])])
      // UPDATE chapter 2
      .mockResolvedValueOnce([mockRows([])]);

    const result = await renumberContinuationChapterTitles(42);
    expect(result.renamed).toBe(2);
    expect(executeSql).toHaveBeenNthCalledWith(
      1,
      'SELECT id, position, title FROM chapters WHERE project_id = ? ORDER BY position ASC, id ASC',
      [42],
    );
    // First update: position 0 → 第 21 章
    expect(executeSql.mock.calls[1][0]).toBe(
      'UPDATE chapters SET title = ?, updated_at = ? WHERE id = ?',
    );
    expect(executeSql.mock.calls[1][1][0]).toBe('第 21 章');
    expect(executeSql.mock.calls[1][1][2]).toBe(1);
    expect(executeSql.mock.calls[2][1][0]).toBe('第 22 章');
    expect(executeSql.mock.calls[2][1][2]).toBe(2);
  });

  it('protects user-custom titles and never rewrites them', async () => {
    (continuationSourceReader.getSnapshot as jest.Mock).mockResolvedValue({
      boundary: { chapterPosition: 19 },
    });
    executeSql.mockResolvedValueOnce([
      mockRows([
        { id: 1, position: 0, title: '夜雨来客' },
        { id: 2, position: 1, title: '第 21 章 夜雨' },
        { id: 3, position: 2, title: '第 3 章' }, // auto — should rewrite
      ]),
    ]);
    executeSql.mockResolvedValueOnce([mockRows([])]); // only one UPDATE

    const result = await renumberContinuationChapterTitles(42);
    expect(result.renamed).toBe(1);
    // Only the pure auto title at position 2 is rewritten.
    expect(executeSql).toHaveBeenCalledTimes(2);
    expect(executeSql.mock.calls[1][1][0]).toBe('第 23 章');
    expect(executeSql.mock.calls[1][1][2]).toBe(3);
  });

  it('skips UPDATE when auto title already matches the boundary', async () => {
    (continuationSourceReader.getSnapshot as jest.Mock).mockResolvedValue({
      boundary: { chapterPosition: 19 },
    });
    executeSql.mockResolvedValueOnce([
      mockRows([{ id: 1, position: 0, title: '第 21 章' }]),
    ]);
    const result = await renumberContinuationChapterTitles(42);
    expect(result.renamed).toBe(0);
    expect(executeSql).toHaveBeenCalledTimes(1); // SELECT only
  });

  it('does not move internal positions or touch state events', async () => {
    (continuationSourceReader.getSnapshot as jest.Mock).mockResolvedValue({
      boundary: { chapterPosition: 4 },
    });
    executeSql
      .mockResolvedValueOnce([
        mockRows([{ id: 9, position: 0, title: '第 1 章' }]),
      ])
      .mockResolvedValueOnce([mockRows([])]);

    await renumberContinuationChapterTitles(42);
    // Only SELECT + UPDATE title. No position UPDATE, no state-event SQL.
    const sqls = executeSql.mock.calls.map(c => String(c[0]));
    expect(sqls.some(s => /state_event|valid_from|SET position/i.test(s))).toBe(
      false,
    );
    expect(sqls.filter(s => s.startsWith('UPDATE chapters SET title')).length).toBe(
      1,
    );
  });

  it('falls back to position+1 when no source/boundary is available', async () => {
    (continuationSourceReader.getSnapshot as jest.Mock).mockRejectedValue(
      new Error('no source'),
    );
    executeSql
      .mockResolvedValueOnce([
        mockRows([{ id: 1, position: 0, title: '第 99 章' }]),
      ])
      .mockResolvedValueOnce([mockRows([])]);

    const result = await renumberContinuationChapterTitles(42);
    expect(result.renamed).toBe(1);
    expect(executeSql.mock.calls[1][1][0]).toBe('第 1 章');
  });
});

describe('formatMemoryCandidatePrefix with display mapper (§11.3)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {
    formatMemoryCandidatePrefix,
  } = require('../src/services/episodicMemoryRetriever');

  it('continues from boundary when getDisplayNumber is provided', () => {
    const prefix = formatMemoryCandidatePrefix(
      { position: 0, title: '夜雨' },
      (p: number) => 20 + p + 1,
    );
    expect(prefix).toBe('第 21 章「夜雨」摘要：');
  });

  it('defaults to position+1 for outline callers and .map callback safety', () => {
    expect(
      formatMemoryCandidatePrefix({ position: 2, title: '测试' }),
    ).toBe('第 3 章「测试」摘要：');
    // `.map(fn)` passes index as 2nd arg — must not throw or treat as mapper.
    expect(
      formatMemoryCandidatePrefix({ position: 0, title: 'x' }, 0),
    ).toBe('第 1 章「x」摘要：');
  });
});

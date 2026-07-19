/**
 * Production-path regression: updateChapter / deleteChapter →
 * markStoryMemoryDirtyIfCovered → markStoryMemoryDirty →
 * invalidateAppliedStoryMemoryBatchesFrom
 *
 * Exercises real repository modules with connection-layer mocks (not pure helpers).
 */
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';

const mockAll = jest.fn();
const mockOne = jest.fn();
const mockExecute = jest.fn();
const mockExecuteTransaction = jest.fn();
const mockDatabase = { name: 'test' };

jest.mock('../src/data/connection/query', () => ({
  all: (...args: unknown[]) => mockAll(...args),
  one: (...args: unknown[]) => mockOne(...args),
}));
jest.mock('../src/data/connection/execute', () => ({
  execute: (...args: unknown[]) => mockExecute(...args),
}));
jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: jest.fn(async () => mockDatabase),
}));
jest.mock('../src/data/connection/transaction', () => ({
  executeTransaction: (...args: unknown[]) => mockExecuteTransaction(...args),
}));
jest.mock('../src/data/repositories/presetRepository', () => ({
  ensureDefaultPreset: jest.fn(async () => 1),
}));
jest.mock('../src/utils/idfCache', () => ({
  invalidateIdf: jest.fn(),
}));

import {
  deleteChapter,
  updateChapter,
} from '../src/data/repositories/projectRepository';

function memoryRow(opts: {
  projectId: number;
  through: number;
  status?: string;
  dirtyFrom?: number | null;
}) {
  const state = createEmptyStoryMemory(opts.projectId);
  state.throughChapterPosition = opts.through;
  return {
    project_id: opts.projectId,
    schema_version: 1,
    through_chapter_id: opts.through >= 0 ? 100 + opts.through : null,
    through_chapter_position: opts.through,
    memory_json: JSON.stringify(state),
    estimated_tokens: 10,
    state_fingerprint: state.metadata.stateFingerprint,
    last_applied_patch_id: null,
    status: opts.status ?? 'clean',
    source: 'native',
    dirty_from_position: opts.dirtyFrom ?? null,
    last_error: '',
    updated_at: '2026-07-19T00:00:00.000Z',
  };
}

function chapterRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    project_id: 7,
    position: 1,
    title: '第2章',
    synopsis: '',
    content: '林岚发现红色钥匙。',
    status: 'final',
    summary_json: null,
    memory_summary: '发现红色钥匙',
    memory_summary_tokens: 4,
    finalized_at: '2026-07-19T00:00:00.000Z',
    created_at: '2026-07-19T00:00:00.000Z',
    updated_at: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

function sqlOf(call: unknown[]): string {
  return String(call[1] ?? '');
}

function findExecute(predicate: (sql: string) => boolean) {
  return mockExecute.mock.calls.find(call => predicate(sqlOf(call)));
}

function wireQueries(opts: {
  chapter: Record<string, unknown>;
  memory: ReturnType<typeof memoryRow> | null;
}) {
  mockOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM chapters WHERE id = ?')) {
      return opts.chapter;
    }
    if (sql.includes('FROM project_story_memory WHERE project_id = ?')) {
      return opts.memory;
    }
    return null;
  });
}

describe('updateChapter / deleteChapter → story memory dirty production path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue({ rowsAffected: 1, insertId: 0 });
    mockExecuteTransaction.mockResolvedValue(undefined);
    mockAll.mockResolvedValue([]);
  });

  it('saves covered finalized chapter content and marks dirty + invalidates applied batches', async () => {
    wireQueries({
      chapter: chapterRow(),
      memory: memoryRow({ projectId: 7, through: 5, status: 'clean' }),
    });

    await updateChapter(42, { content: '林岚发现蓝色徽章。' });

    const chapterUpdate = findExecute(
      sql =>
        sql.includes('UPDATE chapters SET') && sql.includes('WHERE id = ?'),
    );
    expect(chapterUpdate).toBeTruthy();
    expect(chapterUpdate![2]).toEqual(
      expect.arrayContaining(['林岚发现蓝色徽章。', 42]),
    );

    const dirtyUpdate = findExecute(sql =>
      sql.includes('dirty_from_position = CASE'),
    );
    expect(dirtyUpdate).toBeTruthy();
    expect(dirtyUpdate![2]).toEqual(
      expect.arrayContaining([
        1,
        1,
        1,
        '已定稿章节内容或顺序发生变化。',
        7,
      ]),
    );

    const invalidate = findExecute(
      sql =>
        sql.includes("status = 'invalidated'") &&
        sql.includes('through_position >='),
    );
    expect(invalidate).toBeTruthy();
    expect(invalidate![2]).toEqual(
      expect.arrayContaining([
        expect.stringContaining('已覆盖章节已变更'),
        7,
        1,
      ]),
    );
  });

  it('does not mark whole long-term memory dirty for uncovered pending positions', async () => {
    wireQueries({
      chapter: chapterRow({
        id: 99,
        position: 8,
        content: '后续草稿',
        finalized_at: '2026-07-19T00:00:00.000Z',
      }),
      memory: memoryRow({ projectId: 7, through: 5, status: 'clean' }),
    });

    await updateChapter(99, { content: '后续草稿已改' });

    expect(findExecute(sql => sql.includes('dirty_from_position = CASE'))).toBe(
      undefined,
    );

    const pendingInvalidate = findExecute(
      sql =>
        sql.includes("status = 'invalidated'") &&
        sql.includes("status IN ('generated', 'failed')"),
    );
    expect(pendingInvalidate).toBeTruthy();
    expect(pendingInvalidate![2]).toEqual(
      expect.arrayContaining(['pending 范围章节已变更', 7, 8, 8]),
    );

    const appliedInvalidate = findExecute(
      sql =>
        sql.includes("status = 'invalidated'") &&
        sql.includes("status = 'applied'") &&
        sql.includes('through_position >='),
    );
    expect(appliedInvalidate).toBeUndefined();
  });

  it('does not trigger dirty when only non-continuity fields change', async () => {
    wireQueries({
      chapter: chapterRow(),
      memory: memoryRow({ projectId: 7, through: 5 }),
    });

    await updateChapter(42, {
      summary_json: { brief: '仅摘要变更' } as any,
      memory_summary_tokens: 12,
    });

    expect(findExecute(sql => sql.includes('UPDATE chapters SET'))).toBeTruthy();
    expect(findExecute(sql => sql.includes('dirty_from_position = CASE'))).toBe(
      undefined,
    );
    expect(
      findExecute(sql => sql.includes("status = 'invalidated'")),
    ).toBeUndefined();
  });

  it('deleteChapter on covered chapter marks dirty and invalidates from delete position', async () => {
    wireQueries({
      chapter: chapterRow({ id: 42, position: 1 }),
      memory: memoryRow({ projectId: 7, through: 5, status: 'clean' }),
    });

    await deleteChapter(42);

    const deleteSql = findExecute(sql =>
      sql.includes('DELETE FROM chapters WHERE id = ?'),
    );
    expect(deleteSql).toBeTruthy();
    expect(deleteSql![2]).toEqual([42]);

    const dirtyUpdate = findExecute(sql =>
      sql.includes('dirty_from_position = CASE'),
    );
    expect(dirtyUpdate).toBeTruthy();
    expect(dirtyUpdate![2]).toEqual(
      expect.arrayContaining([
        1,
        1,
        1,
        '已删除章节，需要重建故事记忆。',
        7,
      ]),
    );

    const invalidate = findExecute(
      sql =>
        sql.includes("status = 'invalidated'") &&
        sql.includes('through_position >='),
    );
    expect(invalidate).toBeTruthy();
    expect(invalidate![2]).toEqual(
      expect.arrayContaining([
        expect.stringContaining('已覆盖章节已变更'),
        7,
        1,
      ]),
    );
  });

  it('does not dirty when content is unchanged even if key is present', async () => {
    wireQueries({
      chapter: chapterRow({ content: '同一正文' }),
      memory: memoryRow({ projectId: 7, through: 5 }),
    });

    await updateChapter(42, { content: '同一正文' });

    expect(findExecute(sql => sql.includes('UPDATE chapters SET'))).toBeTruthy();
    expect(findExecute(sql => sql.includes('dirty_from_position = CASE'))).toBe(
      undefined,
    );
  });
});

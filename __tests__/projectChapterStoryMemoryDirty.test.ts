/**
 * Production-path regression: updateChapter / deleteChapter compose chapter
 * write + project touch + story-memory dirty/batch invalidation into ONE
 * SQLite transaction (executeTransaction). Partial commit is forbidden.
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
  createProject,
  deleteChapter,
  setProjectResourceEnabled,
  updateChapter,
} from '../src/data/repositories/projectRepository';
import { invalidateIdf } from '../src/utils/idfCache';
import { ensureDefaultPreset } from '../src/data/repositories/presetRepository';

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

type TxStatement = { sql: string; params?: unknown[] };

function txStatements(callIndex = 0): TxStatement[] {
  return (mockExecuteTransaction.mock.calls[callIndex]?.[1] ??
    []) as TxStatement[];
}

function findTx(
  predicate: (sql: string) => boolean,
  callIndex = 0,
): TxStatement | undefined {
  return txStatements(callIndex).find(s => predicate(s.sql));
}

function wireQueries(opts: {
  chapter: Record<string, unknown> | null;
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

/** Chapter UPDATE/DELETE must never be scheduled via standalone execute(). */
function expectNoStandaloneChapterWrite() {
  const chapterWrite = mockExecute.mock.calls.find(call => {
    const sql = String(call[1] ?? '');
    return (
      (sql.includes('UPDATE chapters SET') && sql.includes('WHERE id = ?')) ||
      sql.includes('DELETE FROM chapters WHERE id = ?')
    );
  });
  expect(chapterWrite).toBeUndefined();
}

describe('updateChapter / deleteChapter → atomic story-memory dirty transaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue({ rowsAffected: 1, insertId: 0 });
    mockExecuteTransaction.mockResolvedValue(undefined);
    mockAll.mockResolvedValue([]);
  });

  it('UPDATE covered finalized chapter: one transaction with chapter+touch+dirty+applied invalidate', async () => {
    wireQueries({
      chapter: chapterRow(),
      memory: memoryRow({ projectId: 7, through: 5, status: 'clean' }),
    });

    await updateChapter(42, { content: '林岚发现蓝色徽章。' });

    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1);
    expect(mockExecuteTransaction).toHaveBeenCalledWith(
      mockDatabase,
      expect.any(Array),
    );
    expectNoStandaloneChapterWrite();

    const stmts = txStatements();
    expect(stmts).toHaveLength(6); // chapter + stats projection + touch + memory effects

    const chapterUpdate = findTx(
      sql =>
        sql.includes('UPDATE chapters SET') && sql.includes('WHERE id = ?'),
    );
    expect(chapterUpdate).toBeTruthy();
    expect(chapterUpdate!.params).toEqual(
      expect.arrayContaining(['林岚发现蓝色徽章。', 42]),
    );

    const projectTouch = findTx(sql =>
      sql.includes('UPDATE projects SET updated_at'),
    );
    expect(projectTouch).toBeTruthy();
    expect(projectTouch!.params).toEqual(expect.arrayContaining([7]));

    const dirtyUpdate = findTx(sql =>
      sql.includes('dirty_from_position = CASE'),
    );
    expect(dirtyUpdate).toBeTruthy();
    expect(dirtyUpdate!.params).toEqual(
      expect.arrayContaining([1, 1, 1, '已定稿章节内容或顺序发生变化。', 7]),
    );

    const invalidate = findTx(
      sql =>
        sql.includes("status = 'invalidated'") &&
        sql.includes('through_position >='),
    );
    expect(invalidate).toBeTruthy();
    expect(invalidate!.params).toEqual(
      expect.arrayContaining([
        expect.stringContaining('已覆盖章节已变更'),
        7,
        1,
      ]),
    );
  });

  it('rejects whole updateChapter when transaction rejects (dirty statement failure path)', async () => {
    wireQueries({
      chapter: chapterRow(),
      memory: memoryRow({ projectId: 7, through: 5, status: 'clean' }),
    });
    const txError = new Error('FAULT_INJECTION: dirty statement failed');
    mockExecuteTransaction.mockRejectedValueOnce(txError);

    await expect(
      updateChapter(42, { content: '林岚发现蓝色徽章。' }),
    ).rejects.toBe(txError);

    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1);
    expectNoStandaloneChapterWrite();
    // All six statements were prepared for the single transaction — no
    // sequential fallback path that could leave chapter committed alone.
    const stmts = txStatements();
    expect(stmts.map(s => s.sql).join('\n')).toEqual(
      expect.stringContaining('UPDATE chapters SET'),
    );
    expect(stmts.map(s => s.sql).join('\n')).toEqual(
      expect.stringContaining('dirty_from_position = CASE'),
    );
    expect(stmts.map(s => s.sql).join('\n')).toEqual(
      expect.stringContaining("status = 'invalidated'"),
    );
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('rejects whole updateChapter when transaction rejects (batch invalidation failure path)', async () => {
    wireQueries({
      chapter: chapterRow(),
      memory: memoryRow({ projectId: 7, through: 5, status: 'clean' }),
    });
    const txError = new Error('FAULT_INJECTION: applied invalidate failed');
    mockExecuteTransaction.mockRejectedValueOnce(txError);

    await expect(
      updateChapter(42, { content: '林岚发现蓝色徽章。' }),
    ).rejects.toThrow(/applied invalidate failed/);

    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1);
    expectNoStandaloneChapterWrite();
    const stmts = txStatements();
    expect(stmts).toHaveLength(6);
    expect(
      stmts.some(
        s =>
          s.sql.includes("status = 'invalidated'") &&
          s.sql.includes("status = 'applied'"),
      ),
    ).toBe(true);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('DELETE covered chapter: one transaction with delete+touch+dirty+applied invalidate', async () => {
    wireQueries({
      chapter: chapterRow({ id: 42, position: 1 }),
      memory: memoryRow({ projectId: 7, through: 5, status: 'clean' }),
    });

    await deleteChapter(42);

    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1);
    expectNoStandaloneChapterWrite();

    const stmts = txStatements();
    expect(stmts).toHaveLength(6);

    const deleteSql = findTx(sql =>
      sql.includes('DELETE FROM chapters WHERE id = ?'),
    );
    expect(deleteSql).toBeTruthy();
    expect(deleteSql!.params).toEqual([42]);

    expect(
      findTx(sql => sql.includes('UPDATE projects SET updated_at')),
    ).toBeTruthy();

    const dirtyUpdate = findTx(sql =>
      sql.includes('dirty_from_position = CASE'),
    );
    expect(dirtyUpdate).toBeTruthy();
    expect(dirtyUpdate!.params).toEqual(
      expect.arrayContaining([1, 1, 1, '已删除章节，需要重建故事记忆。', 7]),
    );

    const invalidate = findTx(
      sql =>
        sql.includes("status = 'invalidated'") &&
        sql.includes('through_position >='),
    );
    expect(invalidate).toBeTruthy();
    expect(invalidate!.params).toEqual(
      expect.arrayContaining([
        expect.stringContaining('已覆盖章节已变更'),
        7,
        1,
      ]),
    );
    expect(invalidateIdf).toHaveBeenCalledWith(7);
  });

  it('rejects whole deleteChapter when transaction rejects — no standalone DELETE fallback', async () => {
    wireQueries({
      chapter: chapterRow({ id: 42, position: 1 }),
      memory: memoryRow({ projectId: 7, through: 5, status: 'clean' }),
    });
    const txError = new Error(
      'FAULT_INJECTION: dirty/invalidate failed on delete',
    );
    mockExecuteTransaction.mockRejectedValueOnce(txError);

    await expect(deleteChapter(42)).rejects.toBe(txError);

    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1);
    expectNoStandaloneChapterWrite();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(invalidateIdf).not.toHaveBeenCalled();

    const stmts = txStatements();
    expect(stmts.some(s => s.sql.includes('DELETE FROM chapters'))).toBe(true);
    expect(stmts.some(s => s.sql.includes('dirty_from_position = CASE'))).toBe(
      true,
    );
  });

  it('uncovered pending chapter: same transaction invalidates pending only, no dirty/applied', async () => {
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

    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1);
    expectNoStandaloneChapterWrite();

    const stmts = txStatements();
    // chapter update + stats projection + project touch + pending invalidate
    expect(stmts).toHaveLength(5);

    expect(
      findTx(sql => sql.includes('dirty_from_position = CASE')),
    ).toBeUndefined();

    const pendingInvalidate = findTx(
      sql =>
        sql.includes("status = 'invalidated'") &&
        sql.includes("status IN ('generated', 'failed')"),
    );
    expect(pendingInvalidate).toBeTruthy();
    expect(pendingInvalidate!.params).toEqual(
      expect.arrayContaining(['pending 范围章节已变更', 7, 8, 8]),
    );

    expect(
      findTx(
        sql =>
          sql.includes("status = 'invalidated'") &&
          sql.includes("status = 'applied'") &&
          sql.includes('through_position >='),
      ),
    ).toBeUndefined();
  });

  it('no story-memory row: UPDATE/DELETE still commit without dirty SQL', async () => {
    wireQueries({
      chapter: chapterRow(),
      memory: null,
    });

    await updateChapter(42, { content: '无记忆行也可保存' });

    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1);
    expectNoStandaloneChapterWrite();
    let stmts = txStatements();
    expect(stmts).toHaveLength(4); // chapter + stats projection + project touch
    expect(stmts.some(s => s.sql.includes('dirty_from_position'))).toBe(false);
    expect(stmts.some(s => s.sql.includes('story_memory_batches'))).toBe(false);

    jest.clearAllMocks();
    mockExecuteTransaction.mockResolvedValue(undefined);
    wireQueries({
      chapter: chapterRow(),
      memory: null,
    });

    await deleteChapter(42);

    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1);
    expectNoStandaloneChapterWrite();
    stmts = txStatements();
    expect(stmts.some(s => s.sql.includes('DELETE FROM chapters'))).toBe(true);
    expect(stmts.some(s => s.sql.includes('dirty_from_position'))).toBe(false);
  });

  it('already dirty with earlier dirty_from keeps the earlier position in SQL CASE', async () => {
    wireQueries({
      chapter: chapterRow({ position: 4 }),
      memory: memoryRow({
        projectId: 7,
        through: 5,
        status: 'dirty',
        dirtyFrom: 1,
      }),
    });

    await updateChapter(42, { content: '再次修改第5章' });

    const dirtyUpdate = findTx(sql =>
      sql.includes('dirty_from_position = CASE'),
    );
    expect(dirtyUpdate).toBeTruthy();
    // Params bind the NEW affected position (4); SQL CASE preserves earlier
    // dirty_from_position when it is already smaller.
    expect(dirtyUpdate!.params).toEqual(expect.arrayContaining([4, 4, 4, 7]));
    expect(dirtyUpdate!.sql).toContain('WHEN dirty_from_position > ? THEN ?');
    expect(dirtyUpdate!.sql).toContain('ELSE dirty_from_position');
  });

  it('position change uses min(old, new) as dirty origin', async () => {
    wireQueries({
      chapter: chapterRow({ position: 4 }),
      memory: memoryRow({ projectId: 7, through: 8, status: 'clean' }),
    });

    await updateChapter(42, { position: 2 });

    const dirtyUpdate = findTx(sql =>
      sql.includes('dirty_from_position = CASE'),
    );
    expect(dirtyUpdate).toBeTruthy();
    // min(4, 2) = 2
    expect(dirtyUpdate!.params).toEqual(expect.arrayContaining([2, 2, 2, 7]));

    const invalidate = findTx(
      sql =>
        sql.includes("status = 'applied'") &&
        sql.includes('through_position >='),
    );
    expect(invalidate!.params).toEqual(expect.arrayContaining([7, 2]));
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

    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1);
    expectNoStandaloneChapterWrite();
    const stmts = txStatements();
    expect(findTx(sql => sql.includes('UPDATE chapters SET'))).toBeTruthy();
    expect(findTx(sql => sql.includes('dirty_from_position = CASE'))).toBe(
      undefined,
    );
    expect(
      findTx(sql => sql.includes("status = 'invalidated'")),
    ).toBeUndefined();
    // Still touches project in the same transaction
    expect(stmts).toHaveLength(2);
  });

  it('does not dirty when content is unchanged even if key is present', async () => {
    wireQueries({
      chapter: chapterRow({ content: '同一正文' }),
      memory: memoryRow({ projectId: 7, through: 5 }),
    });

    await updateChapter(42, { content: '同一正文' });

    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1);
    expect(findTx(sql => sql.includes('UPDATE chapters SET'))).toBeTruthy();
    expect(findTx(sql => sql.includes('dirty_from_position = CASE'))).toBe(
      undefined,
    );
  });
});

describe('createProject → resources start disabled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue({ rowsAffected: 1, insertId: 77 });
    mockExecuteTransaction.mockResolvedValue(undefined);
    (ensureDefaultPreset as jest.Mock).mockResolvedValue(11);
  });

  it('links the resolved default preset as disabled and materializes disabled resource defaults', async () => {
    await createProject('预设关联回归', 'outline');

    expect(ensureDefaultPreset).toHaveBeenCalledWith(mockDatabase);
    const statements = txStatements();
    const presetLink = statements.find(statement =>
      statement.sql.includes('project_resources') &&
      statement.params?.[1] === 'preset' &&
      statement.params?.[2] === 11,
    );
    expect(presetLink?.params).toEqual([77, 'preset', 11, 0]);
    expect(presetLink?.params?.[2]).not.toBe(0);

    expect(statements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sql: expect.stringContaining("SELECT ?, 'character', id, 0 FROM characters"),
          params: [77],
        }),
        expect.objectContaining({
          sql: expect.stringContaining("SELECT ?, 'worldbook', id, 0 FROM worldbook_entries"),
          params: [77],
        }),
        expect.objectContaining({
          sql: expect.stringContaining("SELECT ?, 'note', id, 0 FROM notes"),
          params: [77],
        }),
        expect.objectContaining({
          sql: expect.stringContaining("SELECT ?, 'preset', id, 0 FROM presets"),
          params: [77],
        }),
        expect.objectContaining({
          sql: expect.stringContaining("SELECT ?, 'worldbook', id, 0 FROM worldbook_collections"),
          params: [77],
        }),
      ]),
    );
  });

  it('unlocks only the worldbook parent when a child is enabled after project creation', async () => {
    mockOne.mockResolvedValueOnce({ collection_id: 29 });

    await setProjectResourceEnabled(77, 'worldbook', 88, true);

    const statements = txStatements();
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sql: expect.stringContaining('project_resources'),
          params: [77, 'worldbook', 88, 1],
        }),
        expect.objectContaining({
          sql: expect.stringContaining('constant'),
          params: [88],
        }),
        expect.objectContaining({
          sql: expect.stringContaining('project_collection_settings'),
          params: [77, 'worldbook', 29],
        }),
      ]),
    );
  });
});

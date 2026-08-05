/**
 * Outline repository tests (大纲创作模式升级, 阶段 2).
 *
 * Verifies CRUD, deterministic ordering, enable/disable, reorder, default
 * disabled state, and token/hash computation — all against mocked connection
 * layers so the SQL shape is asserted without a real SQLite.
 */
const mockExecute = jest.fn();
const mockExecuteTransaction = jest.fn();
const mockOpenDatabase = jest.fn(async () => ({ name: 'outline-test' }));

jest.mock('../src/data/connection/execute', () => ({
  execute: (...args: any[]) => (mockExecute as any)(...args),
}));
jest.mock('../src/data/connection/transaction', () => ({
  executeTransaction: (...args: any[]) => mockExecuteTransaction(...args),
}));
jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: (...args: any[]) => (mockOpenDatabase as any)(...args),
}));

// query.all / query.one resolve against captured mock returns.
const mockAll = jest.fn(async () => [] as any[]);
const mockOne = jest.fn(async () => null as any);
jest.mock('../src/data/connection/query', () => ({
  all: (...args: any[]) => (mockAll as any)(...args),
  one: (...args: any[]) => (mockOne as any)(...args),
}));

import {
  createOutline,
  updateOutline,
  deleteOutline,
  setOutlineEnabled,
  reorderOutlines,
  getOutlinesByProject,
  getEnabledOutlinesByProject,
  getOutlineById,
} from '../src/data/repositories/outlineRepository';

function rows(items: Array<Record<string, unknown>>) {
  return { length: items.length, item: (index: number) => items[index] };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExecute.mockResolvedValue({ insertId: 1, rows: rows([]) });
  mockExecuteTransaction.mockResolvedValue(undefined);
  mockAll.mockResolvedValue([]);
  mockOne.mockResolvedValue(null);
});

describe('createOutline', () => {
  it('inserts with enabled=0 (default disabled) and computes tokens + hash', async () => {
    mockOne.mockResolvedValue({ max_pos: 5 }); // next position = 6
    await createOutline(7, { title: '主线', content: '主角旅程' });

    const [, sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('INSERT INTO outlines');
    expect(sql).toContain('enabled'); // column present
    // enabled is hardcoded as 0 in the SQL (VALUES (..., 0, ...)), NOT a param,
    // so newly created/imported outlines always start disabled.
    expect(sql).toMatch(/VALUES \(\?, \?, \?, \?, \?, 0, /);
    // Param order: projectId, title, content, sourceType, sourceFileName,
    // position, tokens, hash, createdAt, updatedAt.
    expect(params[0]).toBe(7); // projectId
    expect(params[1]).toBe('主线');
    expect(params[2]).toBe('主角旅程');
  });

  it('auto-assigns position = max(existing) + 1', async () => {
    mockOne.mockResolvedValue({ max_pos: 2 });
    await createOutline(7, { title: 'T', content: 'C' });
    const [, , params] = mockExecute.mock.calls[0];
    // position is the 7th value (index 6): projectId,title,content,sourceType,
    // sourceFileName,position,...
    expect(params[5]).toBe(3); // max_pos 2 + 1
  });

  it('uses position 0 for a project with no existing outlines', async () => {
    mockOne.mockResolvedValue({ max_pos: null });
    await createOutline(7, { title: 'T', content: 'C' });
    const [, , params] = mockExecute.mock.calls[0];
    expect(params[5]).toBe(0);
  });

  it('marks sourceType as txt when provided', async () => {
    mockOne.mockResolvedValue({ max_pos: null });
    await createOutline(7, {
      title: 'T',
      content: 'C',
      sourceType: 'txt',
      sourceFileName: 'outline.txt',
    });
    const [, , params] = mockExecute.mock.calls[0];
    expect(params[3]).toBe('txt');
    expect(params[4]).toBe('outline.txt');
  });
});

describe('updateOutline', () => {
  it('recomputes tokens and hash when content changes', async () => {
    await updateOutline(1, { title: '新标题', content: '新内容' });
    const [, sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('UPDATE outlines SET');
    expect(sql).toContain('title = ?');
    expect(sql).toContain('content = ?');
    expect(sql).toContain('estimated_tokens = ?');
    expect(sql).toContain('content_hash = ?');
    expect(params).toContain('新标题');
    expect(params).toContain('新内容');
  });

  it('only updates title when content not provided', async () => {
    await updateOutline(1, { title: '只改标题' });
    const [, sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('title = ?');
    expect(sql).not.toContain('content = ?');
    expect(sql).not.toContain('content_hash');
  });

  it('is a no-op when patch is empty', async () => {
    await updateOutline(1, {});
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('deleteOutline', () => {
  it('deletes by id', async () => {
    await deleteOutline(42);
    const [, sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('DELETE FROM outlines WHERE id = ?');
    expect(params).toEqual([42]);
  });
});

describe('setOutlineEnabled', () => {
  it('scopes the update by projectId and id', async () => {
    mockOne.mockResolvedValue({
      id: 42,
      project_id: 7,
      title: 'T',
      content: '有正文',
      enabled: 0,
      position: 0,
      estimated_tokens: 1,
      content_hash: 'h',
      created_at: 1,
      updated_at: 1,
    });
    await setOutlineEnabled(7, 42, true);
    const [, sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('WHERE id = ? AND project_id = ?');
    expect(params[0]).toBe(1); // enabled=1
    expect(params[2]).toBe(42); // outlineId
    expect(params[3]).toBe(7); // projectId
  });

  it('writes 0 when disabling', async () => {
    await setOutlineEnabled(7, 42, false);
    const [, , params] = mockExecute.mock.calls[0];
    expect(params[0]).toBe(0);
  });

  it('rejects enabling empty content', async () => {
    mockOne.mockResolvedValue({
      id: 42,
      project_id: 7,
      title: 'T',
      content: '   ',
      enabled: 0,
      position: 0,
      estimated_tokens: 0,
      content_hash: 'h',
      created_at: 1,
      updated_at: 1,
    });
    await expect(setOutlineEnabled(7, 42, true)).rejects.toThrow(/正文为空/);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('reorderOutlines', () => {
  it('writes sequential positions 0..n in one transaction', async () => {
    mockAll.mockResolvedValue([
      { id: 10, project_id: 7, position: 0 },
      { id: 20, project_id: 7, position: 1 },
      { id: 30, project_id: 7, position: 2 },
    ]);
    await reorderOutlines(7, [10, 20, 30]);
    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1);
    const [, statements] = mockExecuteTransaction.mock.calls[0];
    expect(statements).toHaveLength(3);
    expect(statements[0].params).toEqual([0, expect.any(Number), 10, 7]);
    expect(statements[1].params).toEqual([1, expect.any(Number), 20, 7]);
    expect(statements[2].params).toEqual([2, expect.any(Number), 30, 7]);
  });

  it('is a no-op for an empty id list when project has no outlines', async () => {
    mockAll.mockResolvedValue([]);
    await reorderOutlines(7, []);
    expect(mockExecuteTransaction).not.toHaveBeenCalled();
  });

  it('rejects mismatched id sets before writing', async () => {
    mockAll.mockResolvedValue([
      { id: 10, project_id: 7, position: 0 },
      { id: 20, project_id: 7, position: 1 },
    ]);
    await expect(reorderOutlines(7, [10, 99])).rejects.toThrow(/不一致|实际有/);
    expect(mockExecuteTransaction).not.toHaveBeenCalled();
  });

  it('rejects duplicate ids before writing', async () => {
    mockAll.mockResolvedValue([
      { id: 10, project_id: 7, position: 0 },
      { id: 20, project_id: 7, position: 1 },
    ]);
    await expect(reorderOutlines(7, [10, 10])).rejects.toThrow(/重复/);
    expect(mockExecuteTransaction).not.toHaveBeenCalled();
  });
});

describe('list queries', () => {
  it('getOutlinesByProject orders by position then id', async () => {
    mockAll.mockResolvedValue([]);
    await getOutlinesByProject(7);
    const [sql, params] = (mockAll.mock.calls[0] as any[]) as [string, any[]];
    expect(sql).toContain('ORDER BY position ASC, id ASC');
    expect(params).toEqual([7]);
  });

  it('getEnabledOutlinesByProject filters enabled=1', async () => {
    mockAll.mockResolvedValue([]);
    await getEnabledOutlinesByProject(7);
    const [sql] = (mockAll.mock.calls[0] as any[]) as [string, any[]];
    expect(sql).toContain('enabled = 1');
    expect(sql).toContain('ORDER BY position ASC, id ASC');
  });

  it('getOutlineById queries by id only', async () => {
    mockOne.mockResolvedValue({ id: 5, project_id: 7 });
    const result = await getOutlineById(5);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(5);
    const [sql, params] = (mockOne.mock.calls[0] as any[]) as [string, any[]];
    expect(sql).toContain('WHERE id = ?');
    expect(params).toEqual([5]);
  });

  it('maps DB rows to domain type (0/1 → boolean)', async () => {
    mockAll.mockResolvedValue([
      {
        id: 1,
        project_id: 7,
        title: 'T',
        content: 'C',
        source_type: 'txt',
        source_file_name: 'a.txt',
        enabled: 1,
        position: 0,
        estimated_tokens: 10,
        content_hash: 'h',
        created_at: 1000,
        updated_at: 2000,
      },
    ]);
    const outlines = await getOutlinesByProject(7);
    expect(outlines).toHaveLength(1);
    expect(outlines[0].enabled).toBe(true);
    expect(outlines[0].sourceType).toBe('txt');
    expect(outlines[0].sourceFileName).toBe('a.txt');
  });
});

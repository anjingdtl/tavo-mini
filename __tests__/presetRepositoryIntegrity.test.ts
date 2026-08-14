const mockExecute = jest.fn();
const mockExecuteTransaction = jest.fn();
const mockOpenDatabase = jest.fn(async () => ({ name: 'preset-test' }));

jest.mock('../src/data/connection/execute', () => ({
  execute: (...args: any[]) => (mockExecute as any)(...args),
}));
jest.mock('../src/data/connection/transaction', () => ({
  executeTransaction: (...args: any[]) => mockExecuteTransaction(...args),
}));
jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: (...args: any[]) => (mockOpenDatabase as any)(...args),
}));
jest.mock('../src/data/repositories/projectRepository', () => ({
  linkResourceToProject: jest.fn(async () => undefined),
  usageJoin: jest.fn(() => '0 AS enabled_for_project'),
}));
jest.mock('../src/data/connection/query', () => ({ all: jest.fn() }));

import {
  deletePreset,
  ensureDefaultPreset,
  updatePreset,
} from '../src/data/repositories/presetRepository';

function rows(items: Array<Record<string, unknown>>) {
  return { length: items.length, item: (index: number) => items[index] };
}

describe('preset default integrity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecuteTransaction.mockResolvedValue(undefined);
  });

  it('does not clear an existing default when a missing preset is selected as default', async () => {
    await updatePreset(999, { is_default: 1 });

    const statements = mockExecuteTransaction.mock.calls[0][1];
    expect(statements[0]).toEqual(
      expect.objectContaining({
        sql: expect.stringContaining(
          'EXISTS (SELECT 1 FROM presets WHERE id = ?)',
        ),
        params: [999, 999],
      }),
    );
  });

  it('rebinds projects to the replacement preset and promotes it when a default is deleted', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: rows([{ id: 5 }]) })
      .mockResolvedValueOnce({ rows: rows([{ id: 6 }]) });

    await deletePreset(5);

    const statements = mockExecuteTransaction.mock.calls[0][1];
    expect(statements[0]).toEqual(
      expect.objectContaining({
        sql: expect.stringContaining(
          'INSERT OR REPLACE INTO project_resources',
        ),
        params: ['preset', 6, 'preset', 5],
      }),
    );
    expect(
      statements.map((statement: any) => statement.sql).join('\n'),
    ).toContain('NOT EXISTS(SELECT 1 FROM presets WHERE is_default = 1)');
  });

  it('refuses to delete the last preset', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: rows([{ id: 5 }]) })
      .mockResolvedValueOnce({ rows: rows([]) });

    await expect(deletePreset(5)).rejects.toThrow('至少需要保留一个作家风格');
    expect(mockExecuteTransaction).not.toHaveBeenCalled();
  });

  it('repairs a legacy preset list with no default marker', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: rows([]) })
      .mockResolvedValueOnce({ rows: rows([{ id: 12 }]) })
      .mockResolvedValueOnce({ rows: rows([]) });

    await expect(ensureDefaultPreset()).resolves.toBe(12);
    expect(mockExecute).toHaveBeenLastCalledWith(
      expect.anything(),
      'UPDATE presets SET is_default = 1 WHERE id = ?',
      [12],
    );
  });
});

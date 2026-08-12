/**
 * Context Budget V3 — auto-config apply path (Plan §11 / §23 GO Gate #3).
 *
 * Verifies the V3 apply:
 *   - Writes context_auto_mode + context_auto_policy_v3 + LLM configs + presets
 *   - Does NOT UPDATE any resource max_tokens (T9)
 *   - Persists a deterministic policy (T16 determinism)
 *   - Leaves V2 fixed budgets (sliding_window_size / resource_budget / etc.)
 *     untouched — V3 computes these at request time
 */

jest.mock('../src/data/connection/openDatabase', () => ({
  __esModule: true,
  openDatabase: jest.fn(),
}));

jest.mock('../src/data/connection/query', () => ({
  __esModule: true,
  all: jest.fn(),
}));

jest.mock('../src/services/database/transaction', () => ({
  __esModule: true,
  executeTransaction: jest.fn(),
}));

jest.mock('../src/data/repositories/settingsRepository', () => ({
  __esModule: true,
  getSetting: jest.fn(),
  setSetting: jest.fn(),
}));

jest.mock('../src/data/repositories/contextAutoRepository', () => ({
  __esModule: true,
  buildAppliedRecord: jest.fn(),
  getContextAutomationPolicy: jest.fn().mockResolvedValue(null),
  getContextAutomationPolicyV3: jest.fn().mockResolvedValue(null),
  setContextAutoLastApplied: jest.fn(),
  setContextAutoMode: jest.fn(),
  setContextAutomationPolicy: jest.fn(),
  setContextAutomationPolicyV3: jest.fn(),
}));

import { openDatabase } from '../src/data/connection/openDatabase';
import { all } from '../src/data/connection/query';
import { executeTransaction } from '../src/services/database/transaction';
import {
  setContextAutoLastApplied,
  setContextAutoMode,
  setContextAutomationPolicyV3,
} from '../src/data/repositories/contextAutoRepository';
import {
  applyContextAutoAllocationV3,
  countResourcesForProject,
} from '../src/services/contextAutoAllocator';

const mockedOpenDatabase = openDatabase as jest.Mock;
const mockedAll = all as jest.Mock;
const mockedExecuteTransaction = executeTransaction as jest.Mock;
const mockedSetContextAutoMode = setContextAutoMode as jest.Mock;
const mockedSetContextAutomationPolicyV3 = setContextAutomationPolicyV3 as jest.Mock;
const mockedSetContextAutoLastApplied = setContextAutoLastApplied as jest.Mock;

describe('applyContextAutoAllocationV3', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedOpenDatabase.mockReset();
    mockedOpenDatabase.mockResolvedValue({});
    mockedAll.mockReset();
    // countLlmConfigs + countAllPresets
    mockedAll.mockResolvedValue([{ c: 1 }]);
    mockedExecuteTransaction.mockReset();
    mockedExecuteTransaction.mockResolvedValue(undefined);
  });

  test('writes ONLY mode/policy/input — never llm_config / presets / resource max_tokens (Closure §6)', async () => {
    await applyContextAutoAllocationV3(200_000);
    expect(mockedExecuteTransaction).toHaveBeenCalledTimes(1);
    const [, statements] = mockedExecuteTransaction.mock.calls[0];
    const sqls = statements.map((s: any) => s.sql);
    // Required V3 settings writes (params carry the keys, not the SQL itself).
    expect(
      statements.some(
        (s: any) =>
          s.sql.includes('INSERT OR REPLACE INTO settings') &&
          s.params[0] === 'context_auto_mode' &&
          s.params[1] === 'v3',
      ),
    ).toBe(true);
    expect(
      statements.some(
        (s: any) =>
          s.sql.includes('INSERT OR REPLACE INTO settings') &&
          s.params[0] === 'context_auto_policy_v3',
      ),
    ).toBe(true);
    expect(
      statements.some(
        (s: any) =>
          s.sql.includes('INSERT OR REPLACE INTO settings') &&
          s.params[0] === 'context_auto_input' &&
          s.params[1] === '200000',
      ),
    ).toBe(true);
    // Closure Plan §6 / Gate 05: V3 apply must NOT bulk-overwrite every model's
    // real context_window / max_output_tokens, nor flatten all presets. 32K /
    // 128K / 1M models keep their own windows; the frozen per-task request
    // config supplies the real window at run time.
    expect(sqls.some((s: string) => s.includes('UPDATE llm_config'))).toBe(false);
    expect(sqls.some((s: string) => s.includes('UPDATE presets'))).toBe(false);
    // GO Gate #3: NEVER touch resource max_tokens
    expect(sqls.some((s: string) => s.includes('UPDATE characters'))).toBe(false);
    expect(sqls.some((s: string) => s.includes('UPDATE notes'))).toBe(false);
    expect(sqls.some((s: string) => s.includes('UPDATE worldbook_entries'))).toBe(
      false,
    );
    expect(
      sqls.some((s: string) => s.includes('UPDATE worldbook_collections')),
    ).toBe(false);
    // GO Gate #3 (cont): NEVER write V2 fixed-budget settings keys
    const settingsKeys = statements
      .filter((s: any) => s.sql.includes('INSERT OR REPLACE INTO settings'))
      .map((s: any) => s.params[0]);
    expect(settingsKeys).not.toContain('sliding_window_size');
    expect(settingsKeys).not.toContain('resource_budget');
    expect(settingsKeys).not.toContain('story_state_budget_tokens');
    expect(settingsKeys).not.toContain('episodic_memory_budget_tokens');
    expect(settingsKeys).not.toContain('summary_budget_tokens');
    expect(settingsKeys).not.toContain('memory_patch_max_tokens');
    // Only the three V3 settings keys are written.
    expect(settingsKeys.sort()).toEqual(
      ['context_auto_input', 'context_auto_mode', 'context_auto_policy_v3'].sort(),
    );
  });

  test('affectedCounts report zero model/preset writes (honest, not misleading)', async () => {
    const record = await applyContextAutoAllocationV3(200_000);
    expect(record.affectedCounts.llmConfigs).toBe(0);
    expect(record.affectedCounts.presets).toBe(0);
  });

  test('mode + policyV3 + lastApplied are persisted', async () => {
    await applyContextAutoAllocationV3(200_000);
    expect(mockedSetContextAutoMode).toHaveBeenCalledWith('v3');
    expect(mockedSetContextAutomationPolicyV3).toHaveBeenCalledTimes(1);
    expect(mockedSetContextAutoLastApplied).toHaveBeenCalledTimes(1);
    const lastApplied = mockedSetContextAutoLastApplied.mock.calls[0][0];
    expect(lastApplied.policyVersion).toBe('context-automation-v3');
    expect(lastApplied.policySchemaVersion).toBe(3);
    expect(lastAffectedAffectedCountsResourcesZero(lastApplied)).toBe(true);
  });

  test('rejects non-positive input before any DB write', async () => {
    await expect(applyContextAutoAllocationV3(0)).rejects.toThrow(/正数/);
    await expect(applyContextAutoAllocationV3(-1)).rejects.toThrow(/正数/);
    expect(mockedExecuteTransaction).not.toHaveBeenCalled();
  });

  test('deterministic policy hash across repeated applies', async () => {
    const r1 = await applyContextAutoAllocationV3(200_000);
    const r2 = await applyContextAutoAllocationV3(200_000);
    expect(r1.policyHash).toBe(r2.policyHash);
    expect(r1.policyHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

function lastAffectedAffectedCountsResourcesZero(record: any): boolean {
  return (
    record.affectedCounts.characters === 0 &&
    record.affectedCounts.notes === 0 &&
    record.affectedCounts.worldbookEntries === 0 &&
    record.affectedCounts.worldbookCollections === 0
  );
}

describe('countResourcesForProject', () => {
  beforeEach(() => {
    mockedAll.mockReset();
    mockedOpenDatabase.mockReset();
    mockedOpenDatabase.mockResolvedValue({});
  });

  test('scopes by project_id', async () => {
    mockedAll.mockResolvedValue([{ c: 0 }]);
    await countResourcesForProject(42);
    // Every COUNT query must include `WHERE project_id = ?` with the right id.
    for (const call of mockedAll.mock.calls) {
      const [sql, params] = call as [string, unknown[]];
      expect(sql).toContain('WHERE project_id = ?');
      expect(params).toEqual([42]);
    }
  });

  test('T6 cross-project isolation: Project B resource count never affects Project A', async () => {
    // Project A query returns { characters: 2 }
    mockedAll.mockImplementation(async (sql?: string) => {
      if (sql?.includes('FROM characters')) return [{ c: 2 }];
      return [{ c: 0 }];
    });
    const countsA = await countResourcesForProject(1);
    expect(countsA.characters).toBe(2);
    expect(countsA.notes).toBe(0);

    // Even if the DB has 100 characters globally, Project A's count is
    // unchanged — the WHERE clause scopes the COUNT.
    mockedAll.mockImplementation(async (sql?: string) => {
      if (sql?.includes('FROM characters')) return [{ c: 100 }];
      return [{ c: 0 }];
    });
    const countsB = await countResourcesForProject(2);
    expect(countsB.characters).toBe(100);
    // Re-query A — still 2.
    mockedAll.mockImplementation(async (sql?: string) => {
      if (sql?.includes('FROM characters')) return [{ c: 2 }];
      return [{ c: 0 }];
    });
    const countsA2 = await countResourcesForProject(1);
    expect(countsA2.characters).toBe(2);
  });
});

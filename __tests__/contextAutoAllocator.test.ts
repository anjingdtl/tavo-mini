/* eslint-env jest */

import {
  allocateContextBudget,
  RATIO_INPUT,
  RATIO_OUTPUT,
  RATIO_SLIDING_WINDOW,
  RATIO_RESOURCE_BUDGET,
  RATIO_SUMMARY_BUDGET,
  RATIO_DRAFT,
  RATIO_REVIEW,
  RATIO_FACT_CHECK,
  RATIO_PROOF,
  RATIO_RESOURCE_CHARACTER,
  RATIO_RESOURCE_NOTE,
  RATIO_RESOURCE_WORLDBOOK,
  MIN_SLIDING_WINDOW,
  MIN_SUMMARY_BUDGET,
  MIN_CHARACTER_TOKENS,
  MIN_NOTE_TOKENS,
  MIN_WORLDBOOK_ENTRY_TOKENS,
  MIN_WORLDBOOK_COLLECTION_TOKENS,
  MIN_PIPELINE_TOKENS,
  MIN_RESOURCE_BUDGET,
} from '../src/services/contextAutoAllocator';

const ZERO_COUNTS = {
  characters: 0,
  notes: 0,
  worldbookEntries: 0,
  worldbookCollections: 0,
};

describe('allocateContextBudget', () => {
  test('抛错：maxContextTokens <= 0', () => {
    expect(() => allocateContextBudget(0, ZERO_COUNTS)).toThrow(/正数/);
    expect(() => allocateContextBudget(-1, ZERO_COUNTS)).toThrow(/正数/);
  });

  test('抛错：maxContextTokens 非有限数', () => {
    expect(() => allocateContextBudget(NaN, ZERO_COUNTS)).toThrow(/正数/);
    expect(() => allocateContextBudget(Infinity, ZERO_COUNTS)).toThrow(/正数/);
  });

  test('典型值 200000 的分配比例正确', () => {
    const result = allocateContextBudget(200000, {
      characters: 10,
      notes: 10,
      worldbookEntries: 20,
      worldbookCollections: 4,
    });
    // 顶层
    expect(result.inputBudget).toBe(160000);
    expect(result.outputBudget).toBe(40000);
    // 输入侧（允许 round 误差 ±1）
    expect(result.slidingWindowSize).toBe(104000);
    expect(result.resourceBudget).toBe(32000);
    expect(result.summaryBudgetTokens).toBe(24000);
    // 输出侧
    expect(result.draftMaxTokens).toBe(20000);
    expect(result.reviewMaxTokens).toBe(6000);
    expect(result.factCheckMaxTokens).toBe(6000);
    expect(result.proofMaxTokens).toBe(8000);
    // 同步字段
    expect(result.llmContextWindow).toBe(200000);
    expect(result.llmMaxOutputTokens).toBe(40000);
    expect(result.presetMaxTokens).toBe(20000);
    // 资料预算内部分配
    // 角色：32000 * 0.35 / 10 = 1120
    expect(result.characterMaxTokens).toBe(1120);
    // 笔记：32000 * 0.20 / 10 = 640
    expect(result.noteMaxTokens).toBe(640);
    // 世界书条目：32000 * 0.45 / 20 = 720
    expect(result.worldbookEntryMaxTokens).toBe(720);
    // 世界书合集：32000 * 0.45 / 4 = 3600
    expect(result.worldbookCollectionMaxTokens).toBe(3600);
  });

  test('1M 极大值不溢出', () => {
    const result = allocateContextBudget(1000000, {
      characters: 50,
      notes: 100,
      worldbookEntries: 200,
      worldbookCollections: 20,
    });
    expect(result.inputBudget).toBe(800000);
    expect(result.outputBudget).toBe(200000);
    expect(result.slidingWindowSize).toBe(520000);
    expect(result.draftMaxTokens).toBe(100000);
    // inputBudget=800000, resourceBudget=160000, characterTotal=56000, /50=1120
    expect(result.characterMaxTokens).toBe(1120);
  });

  test('资源数量=0 时单项仍计算但用 MAX(0,1)=1 兜底', () => {
    const result = allocateContextBudget(200000, ZERO_COUNTS);
    // 不抛错
    expect(result.characterMaxTokens).toBeGreaterThan(0);
    expect(result.noteMaxTokens).toBeGreaterThan(0);
    expect(result.worldbookEntryMaxTokens).toBeGreaterThan(0);
    expect(result.worldbookCollectionMaxTokens).toBeGreaterThan(0);
    // 数值合理（资源预算 32000 * 0.35 / 1 = 11200）
    expect(result.characterMaxTokens).toBe(11200);
  });

  test('极小值 100 触发所有 floor', () => {
    const result = allocateContextBudget(100, ZERO_COUNTS);
    // inputBudget=80, sliding=80*0.65=52 → floor 到 1000
    expect(result.slidingWindowSize).toBe(MIN_SLIDING_WINDOW);
    expect(result.summaryBudgetTokens).toBe(MIN_SUMMARY_BUDGET);
    expect(result.resourceBudget).toBe(MIN_RESOURCE_BUDGET);
    expect(result.characterMaxTokens).toBe(MIN_CHARACTER_TOKENS);
    expect(result.noteMaxTokens).toBe(MIN_NOTE_TOKENS);
    expect(result.worldbookEntryMaxTokens).toBe(MIN_WORLDBOOK_ENTRY_TOKENS);
    expect(result.worldbookCollectionMaxTokens).toBe(MIN_WORLDBOOK_COLLECTION_TOKENS);
    expect(result.draftMaxTokens).toBe(MIN_PIPELINE_TOKENS);
    expect(result.reviewMaxTokens).toBe(MIN_PIPELINE_TOKENS);
    expect(result.factCheckMaxTokens).toBe(MIN_PIPELINE_TOKENS);
    expect(result.proofMaxTokens).toBe(MIN_PIPELINE_TOKENS);
  });

  test('非整千（如 999）正常计算', () => {
    const result = allocateContextBudget(999, ZERO_COUNTS);
    expect(result.inputBudget).toBe(Math.round(999 * RATIO_INPUT));
    expect(result.outputBudget).toBe(Math.round(999 * RATIO_OUTPUT));
  });

  test('比例常量正确', () => {
    expect(RATIO_INPUT + RATIO_OUTPUT).toBeCloseTo(1);
    expect(
      RATIO_SLIDING_WINDOW + RATIO_RESOURCE_BUDGET + RATIO_SUMMARY_BUDGET,
    ).toBeCloseTo(1);
    expect(RATIO_DRAFT + RATIO_REVIEW + RATIO_FACT_CHECK + RATIO_PROOF).toBeCloseTo(1);
    expect(
      RATIO_RESOURCE_CHARACTER + RATIO_RESOURCE_NOTE + RATIO_RESOURCE_WORLDBOOK,
    ).toBeCloseTo(1);
  });
});

// ============================================================================
// 集成测试：applyContextAutoAllocation + 资源计数
// ============================================================================

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
  buildAppliedRecord: jest.fn(
    (maxContextTokens: number, allocation: any, affectedCounts: any) => ({
      maxContextTokens,
      appliedAt: 1700000000000,
      allocation,
      affectedCounts,
    }),
  ),
  setContextAutoLastApplied: jest.fn(),
}));

import { openDatabase } from '../src/data/connection/openDatabase';
import { all } from '../src/data/connection/query';
import { executeTransaction } from '../src/services/database/transaction';
import { setContextAutoLastApplied } from '../src/data/repositories/contextAutoRepository';
import {
  applyContextAutoAllocation,
  countAllResources,
  countNonLocalLlmConfigs,
  countAllPresets,
} from '../src/services/contextAutoAllocator';

const mockedOpenDatabase = openDatabase as jest.Mock;
const mockedAll = all as jest.Mock;
const mockedExecuteTransaction = executeTransaction as jest.Mock;
const mockedSetContextAutoLastApplied = setContextAutoLastApplied as jest.Mock;

describe('countAllResources', () => {
  beforeEach(() => {
    mockedAll.mockReset();
    mockedOpenDatabase.mockReset();
    mockedOpenDatabase.mockResolvedValue({});
  });

  test('聚合四个表的 COUNT', async () => {
    mockedAll
      .mockResolvedValueOnce([{ c: 5 }]) // characters
      .mockResolvedValueOnce([{ c: 8 }]) // notes
      .mockResolvedValueOnce([{ c: 20 }]) // worldbook_entries
      .mockResolvedValueOnce([{ c: 3 }]); // worldbook_collections
    const counts = await countAllResources();
    expect(counts).toEqual({
      characters: 5,
      notes: 8,
      worldbookEntries: 20,
      worldbookCollections: 3,
    });
  });

  test('空表返回 0', async () => {
    mockedAll.mockResolvedValue([{ c: 0 }]);
    const counts = await countAllResources();
    expect(counts.characters).toBe(0);
  });
});

describe('countNonLocalLlmConfigs', () => {
  beforeEach(() => {
    mockedAll.mockReset();
  });
  test('返回 COUNT 结果', async () => {
    mockedAll.mockResolvedValueOnce([{ c: 2 }]);
    expect(await countNonLocalLlmConfigs()).toBe(2);
  });
});

describe('countAllPresets', () => {
  beforeEach(() => {
    mockedAll.mockReset();
  });
  test('返回 COUNT 结果', async () => {
    mockedAll.mockResolvedValueOnce([{ c: 7 }]);
    expect(await countAllPresets()).toBe(7);
  });
});

describe('applyContextAutoAllocation', () => {
  beforeEach(() => {
    mockedAll.mockReset();
    mockedExecuteTransaction.mockReset();
    mockedSetContextAutoLastApplied.mockReset();
    mockedOpenDatabase.mockReset();
    mockedOpenDatabase.mockResolvedValue({});

    // countAllResources 4 次 + countNonLocalLlmConfigs 1 次 + countAllPresets 1 次 = 6 次 all
    mockedAll.mockResolvedValue([{ c: 1 }]);
    mockedExecuteTransaction.mockResolvedValue(undefined);
  });

  test('成功路径：执行事务 + 写 last_applied 记录', async () => {
    const record = await applyContextAutoAllocation(200000);
    expect(mockedExecuteTransaction).toHaveBeenCalledTimes(1);
    const [dbArg, statements] = mockedExecuteTransaction.mock.calls[0];
    expect(dbArg).toEqual({});
    // 7 个 settings + llm_config + presets + 4 个资源表（count=1>0）= 13 个
    expect(statements.length).toBe(13);
    // 检测参数（SQL 用 VALUES(?,?)，key 在 params[0]）
    const settingsStmts = statements.filter(
      (s: any) => typeof s.params[0] === 'string' && !s.sql.includes('UPDATE'),
    );
    const settingsKeys = settingsStmts.map((s: any) => s.params[0]);
    expect(settingsKeys).toContain('sliding_window_size');
    expect(settingsKeys).toContain('resource_budget');
    expect(settingsKeys).toContain('summary_budget_tokens');
    expect(settingsKeys).toContain('pipeline_draft_max_tokens');
    expect(settingsKeys).toContain('pipeline_review_max_tokens');
    expect(settingsKeys).toContain('pipeline_factcheck_max_tokens');
    expect(settingsKeys).toContain('pipeline_proof_max_tokens');
    // UPDATE 语句
    const sqls = statements.map((s: any) => s.sql);
    expect(sqls.some((s: string) => s.includes('UPDATE llm_config'))).toBe(true);
    expect(sqls.some((s: string) => s.includes('UPDATE presets'))).toBe(true);
    expect(sqls.some((s: string) => s.includes('UPDATE characters'))).toBe(true);
    expect(sqls.some((s: string) => s.includes('UPDATE notes'))).toBe(true);
    expect(sqls.some((s: string) => s.includes('UPDATE worldbook_entries'))).toBe(true);
    expect(sqls.some((s: string) => s.includes('UPDATE worldbook_collections'))).toBe(true);
    expect(mockedSetContextAutoLastApplied).toHaveBeenCalledTimes(1);
    expect(record.maxContextTokens).toBe(200000);
    expect(record.allocation.inputBudget).toBe(160000);
  });

  test('资源数量为 0 时跳过对应 UPDATE', async () => {
    mockedAll.mockReset();
    // 用 mockImplementation 按 SQL 内容区分，规避 Promise.all 顺序不确定性
    mockedAll.mockImplementation(async (sql?: string) => {
      if (!sql) return [{ c: 1 }];
      if (sql.includes('FROM characters')) return [{ c: 0 }];
      if (sql.includes('FROM notes')) return [{ c: 0 }];
      if (sql.includes('FROM worldbook_entries')) return [{ c: 0 }];
      if (sql.includes('FROM worldbook_collections')) return [{ c: 0 }];
      if (sql.includes('FROM llm_config')) return [{ c: 1 }];
      if (sql.includes('FROM presets')) return [{ c: 1 }];
      return [{ c: 1 }];
    });
    await applyContextAutoAllocation(200000);
    const [, statements] = mockedExecuteTransaction.mock.calls[0];
    const sqls = statements.map((s: any) => s.sql);
    expect(sqls.some((s: string) => s.includes('UPDATE characters'))).toBe(false);
    expect(sqls.some((s: string) => s.includes('UPDATE notes'))).toBe(false);
    expect(sqls.some((s: string) => s.includes('UPDATE worldbook_entries'))).toBe(false);
    expect(sqls.some((s: string) => s.includes('UPDATE worldbook_collections'))).toBe(false);
    // 仍然有 settings + llm_config + presets
    expect(sqls.some((s: string) => s.includes('UPDATE llm_config'))).toBe(true);
    expect(sqls.some((s: string) => s.includes('UPDATE presets'))).toBe(true);
  });

  test('llm_config UPDATE 排除 llama_cpp', async () => {
    await applyContextAutoAllocation(200000);
    const [, statements] = mockedExecuteTransaction.mock.calls[0];
    const llmStmt = statements.find((s: any) => s.sql.includes('UPDATE llm_config'));
    expect(llmStmt).toBeDefined();
    expect(llmStmt.sql).toContain("provider_type IS NOT 'llama_cpp'");
    expect(llmStmt.params).toEqual([200000, 40000]);
  });

  test('presets UPDATE 用 draftMaxTokens 作为 max_tokens', async () => {
    await applyContextAutoAllocation(200000);
    const [, statements] = mockedExecuteTransaction.mock.calls[0];
    const presetStmt = statements.find((s: any) => s.sql.includes('UPDATE presets'));
    expect(presetStmt.params).toEqual([20000]); // draftMaxTokens = 40000 * 0.5
  });

  test('事务失败抛错且不写 last_applied', async () => {
    mockedExecuteTransaction.mockRejectedValue(new Error('transaction failed'));
    await expect(applyContextAutoAllocation(200000)).rejects.toThrow(
      /transaction failed/,
    );
    expect(mockedSetContextAutoLastApplied).not.toHaveBeenCalled();
  });

  test('maxContextTokens 非正数抛错（在 allocateContextBudget 阶段）', async () => {
    await expect(applyContextAutoAllocation(0)).rejects.toThrow(/正数/);
    await expect(applyContextAutoAllocation(-1)).rejects.toThrow(/正数/);
    expect(mockedExecuteTransaction).not.toHaveBeenCalled();
  });

  test('ContextConfig/PipelineConfig 其他字段不被覆写（INSERT OR REPLACE 单 key）', async () => {
    await applyContextAutoAllocation(200000);
    const [, statements] = mockedExecuteTransaction.mock.calls[0];
    // 7 个 settings INSERT OR REPLACE（3 ContextConfig + 4 PipelineConfig）
    const settingsStmts = statements.filter((s: any) =>
      s.sql.includes('INSERT OR REPLACE INTO settings'),
    );
    expect(settingsStmts.length).toBe(7);
    // 不应包含 strategy / pipelineMode / presetId 等 key
    const settingsKeys = settingsStmts.map((s: any) => s.params[0]);
    expect(settingsKeys).not.toContain('context_strategy');
    expect(settingsKeys).not.toContain('pipeline_mode');
    expect(settingsKeys).not.toContain('pipeline_draft_preset_id');
  });
});


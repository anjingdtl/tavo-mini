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
  MIN_CHARACTER_TOKENS,
  MIN_NOTE_TOKENS,
  MIN_WORLDBOOK_ENTRY_TOKENS,
  MIN_WORLDBOOK_COLLECTION_TOKENS,
  MIN_PIPELINE_TOKENS,
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
    expect(result.slidingWindowSize).toBe(80000);
    expect(result.resourceBudget).toBe(32000);
    expect(result.storyStateBudgetTokens).toBe(32000);
    expect(result.episodicMemoryBudgetTokens).toBe(16000);
    expect(result.summaryBudgetTokens).toBe(48000);
    expect(result.memoryPatchMaxTokens).toBe(3200);
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
    expect(result.slidingWindowSize).toBe(592000);
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
    expect(result.slidingWindowSize).toBe(36);
    expect(result.storyStateBudgetTokens).toBe(20);
    expect(result.episodicMemoryBudgetTokens).toBe(8);
    expect(result.summaryBudgetTokens).toBe(28);
    expect(result.resourceBudget).toBe(16);
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

  test.each([128000, 200000, 512000, 1000000])(
    '%i 上下文的输入分项总和不超过 inputBudget',
    value => {
      const result = allocateContextBudget(value, ZERO_COUNTS);
      expect(
        result.slidingWindowSize +
          result.resourceBudget +
          result.storyStateBudgetTokens +
          result.episodicMemoryBudgetTokens,
      ).toBe(result.inputBudget);
      expect(result.storyStateBudgetTokens).toBeLessThanOrEqual(32000);
      expect(result.episodicMemoryBudgetTokens).toBeLessThanOrEqual(16000);
    },
  );

  test('8000 使用正常下限，小于 5000 输入预算使用比例 fallback', () => {
    const normal = allocateContextBudget(8000, ZERO_COUNTS);
    expect(normal.storyStateBudgetTokens).toBeGreaterThanOrEqual(2000);
    expect(normal.episodicMemoryBudgetTokens).toBeGreaterThanOrEqual(1000);
    const tiny = allocateContextBudget(4000, ZERO_COUNTS);
    expect(tiny.inputBudget).toBe(3200);
    expect(tiny.slidingWindowSize).toBe(1440);
    expect(tiny.memoryPatchMaxTokens).toBe(800);
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
    // 10 个 settings + llm_config + presets + 4 个资源表（count=1>0）= 16 个
    expect(statements.length).toBe(16);
    // 检测参数（SQL 用 VALUES(?,?)，key 在 params[0]）
    const settingsStmts = statements.filter(
      (s: any) => typeof s.params[0] === 'string' && !s.sql.includes('UPDATE'),
    );
    const settingsKeys = settingsStmts.map((s: any) => s.params[0]);
    expect(settingsKeys).toContain('sliding_window_size');
    expect(settingsKeys).toContain('resource_budget');
    expect(settingsKeys).toContain('summary_budget_tokens');
    expect(settingsKeys).toContain('story_state_budget_tokens');
    expect(settingsKeys).toContain('episodic_memory_budget_tokens');
    expect(settingsKeys).toContain('memory_patch_max_tokens');
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

  test('llm_config UPDATE applies to every online configuration', async () => {
    await applyContextAutoAllocation(200000);
    const [, statements] = mockedExecuteTransaction.mock.calls[0];
    const llmStmt = statements.find((s: any) => s.sql.includes('UPDATE llm_config'));
    expect(llmStmt).toBeDefined();
    expect(llmStmt.sql).not.toContain('provider_type');
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
    // 10 个 settings INSERT OR REPLACE（6 ContextConfig + 4 PipelineConfig）
    const settingsStmts = statements.filter((s: any) =>
      s.sql.includes('INSERT OR REPLACE INTO settings'),
    );
    expect(settingsStmts.length).toBe(10);
    // 不应包含 strategy / pipelineMode / presetId 等 key
    const settingsKeys = settingsStmts.map((s: any) => s.params[0]);
    expect(settingsKeys).not.toContain('context_strategy');
    expect(settingsKeys).not.toContain('pipeline_mode');
    expect(settingsKeys).not.toContain('pipeline_draft_preset_id');
  });
});

// ============================================================================
// 轻量级同步：computePipelineMaxTokensFromContextWindow + syncPipelineMaxTokensFromContextWindow
// ============================================================================

import {
  computePipelineMaxTokensFromContextWindow,
  syncPipelineMaxTokensFromContextWindow,
} from '../src/services/contextAutoAllocator';
import { setSetting } from '../src/data/repositories/settingsRepository';

describe('computePipelineMaxTokensFromContextWindow', () => {
  test('抛错：contextWindow <= 0', () => {
    expect(() => computePipelineMaxTokensFromContextWindow(0)).toThrow(/正数/);
    expect(() => computePipelineMaxTokensFromContextWindow(-1)).toThrow(/正数/);
  });

  test('抛错：contextWindow 非有限数', () => {
    expect(() => computePipelineMaxTokensFromContextWindow(NaN)).toThrow(/正数/);
    expect(() => computePipelineMaxTokensFromContextWindow(Infinity)).toThrow(
      /正数/,
    );
  });

  test('典型值 200000 的比例正确（与 allocateContextBudget 输出一致）', () => {
    const tokens = computePipelineMaxTokensFromContextWindow(200000);
    // outputBudget = 200000 * 0.2 = 40000
    // draft = 40000 * 0.5 = 20000
    // review = 40000 * 0.15 = 6000
    // factCheck = 40000 * 0.15 = 6000
    // proof = 40000 * 0.2 = 8000
    expect(tokens.draftMaxTokens).toBe(20000);
    expect(tokens.reviewMaxTokens).toBe(6000);
    expect(tokens.factCheckMaxTokens).toBe(6000);
    expect(tokens.proofMaxTokens).toBe(8000);
  });

  test('与 allocateContextBudget 的输出侧完全一致', () => {
    const full = allocateContextBudget(200000, {
      characters: 10,
      notes: 10,
      worldbookEntries: 20,
      worldbookCollections: 4,
    });
    const lite = computePipelineMaxTokensFromContextWindow(200000);
    expect(lite.draftMaxTokens).toBe(full.draftMaxTokens);
    expect(lite.reviewMaxTokens).toBe(full.reviewMaxTokens);
    expect(lite.factCheckMaxTokens).toBe(full.factCheckMaxTokens);
    expect(lite.proofMaxTokens).toBe(full.proofMaxTokens);
  });

  test('极小值 100 触发 MIN_PIPELINE_TOKENS floor', () => {
    const tokens = computePipelineMaxTokensFromContextWindow(100);
    // outputBudget = 100 * 0.2 = 20
    // draft = 20 * 0.5 = 10 → floor 到 256
    expect(tokens.draftMaxTokens).toBe(MIN_PIPELINE_TOKENS);
    expect(tokens.reviewMaxTokens).toBe(MIN_PIPELINE_TOKENS);
    expect(tokens.factCheckMaxTokens).toBe(MIN_PIPELINE_TOKENS);
    expect(tokens.proofMaxTokens).toBe(MIN_PIPELINE_TOKENS);
  });

  test('DeepSeek 常见上下文 65536 算出合理值', () => {
    const tokens = computePipelineMaxTokensFromContextWindow(65536);
    // outputBudget = 65536 * 0.2 = 13107
    // draft = 13107 * 0.5 = 6554
    // review = 13107 * 0.15 = 1966
    // factCheck = 13107 * 0.15 = 1966
    // proof = 13107 * 0.2 = 2621
    expect(tokens.draftMaxTokens).toBe(6554);
    expect(tokens.reviewMaxTokens).toBe(1966);
    expect(tokens.factCheckMaxTokens).toBe(1966);
    expect(tokens.proofMaxTokens).toBe(2621);
    // review/factCheck 大于 1500 默认值，证明能解决 full 模式被截断的问题
    expect(tokens.reviewMaxTokens).toBeGreaterThan(1500);
    expect(tokens.factCheckMaxTokens).toBeGreaterThan(1500);
  });
});

describe('syncPipelineMaxTokensFromContextWindow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('调用 setSetting 4 次，写入正确的 key 和值', async () => {
    const tokens = await syncPipelineMaxTokensFromContextWindow(200000);
    expect(setSetting).toHaveBeenCalledTimes(4);
    // 4 个 key 必须正确
    const keys = (setSetting as jest.Mock).mock.calls.map(c => c[0]);
    expect(keys).toEqual([
      'pipeline_draft_max_tokens',
      'pipeline_review_max_tokens',
      'pipeline_factcheck_max_tokens',
      'pipeline_proof_max_tokens',
    ]);
    // 值与 compute 函数一致
    const calls = (setSetting as jest.Mock).mock.calls;
    expect(calls[0][1]).toBe(String(tokens.draftMaxTokens));
    expect(calls[1][1]).toBe(String(tokens.reviewMaxTokens));
    expect(calls[2][1]).toBe(String(tokens.factCheckMaxTokens));
    expect(calls[3][1]).toBe(String(tokens.proofMaxTokens));
  });

  test('不写其他 settings key（不污染 ContextConfig）', async () => {
    await syncPipelineMaxTokensFromContextWindow(65536);
    const keys = (setSetting as jest.Mock).mock.calls.map(c => c[0]);
    expect(keys).not.toContain('sliding_window_size');
    expect(keys).not.toContain('resource_budget');
    expect(keys).not.toContain('pipeline_mode');
    expect(keys).not.toContain('pipeline_draft_preset_id');
  });

  test('contextWindow <= 0 时抛错且不调 setSetting', async () => {
    await expect(syncPipelineMaxTokensFromContextWindow(0)).rejects.toThrow(
      /正数/,
    );
    expect(setSetting).not.toHaveBeenCalled();
  });

  test('返回值与 compute 函数一致', async () => {
    const expected = computePipelineMaxTokensFromContextWindow(100000);
    const actual = await syncPipelineMaxTokensFromContextWindow(100000);
    expect(actual).toEqual(expected);
  });
});

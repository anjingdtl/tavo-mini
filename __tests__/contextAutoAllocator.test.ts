/* eslint-env jest */

import {
  allocateContextBudget,
  buildOutlineElasticBudgetPreview,
  resolveElasticStageOutputReservation,
  RATIO_INPUT,
  RATIO_OUTPUT,
  RATIO_SLIDING_WINDOW,
  RATIO_RESOURCE_BUDGET,
  RATIO_SUMMARY_BUDGET,
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
    // 同步字段
    expect(result.llmContextWindow).toBe(200000);
    expect(result.llmMaxOutputTokens).toBe(40000);
    expect(result.presetMaxTokens).toBe(40000);
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
  getContextAutomationPolicy: jest.fn().mockResolvedValue(null),
  setContextAutomationPolicy: jest.fn(),
  setContextAutoLastApplied: jest.fn(),
}));

import { openDatabase } from '../src/data/connection/openDatabase';
import { all } from '../src/data/connection/query';
import { executeTransaction } from '../src/services/database/transaction';
import { setContextAutoLastApplied } from '../src/data/repositories/contextAutoRepository';
import {
  getContextAutomationPolicy,
  setContextAutomationPolicy,
} from '../src/data/repositories/contextAutoRepository';
import {
  applyContextAutoAllocation,
  countAllResources,
  countNonLocalLlmConfigs,
  countAllPresets,
  ensureContextAutomationPolicy,
} from '../src/services/contextAutoAllocator';

const mockedOpenDatabase = openDatabase as jest.Mock;
const mockedAll = all as jest.Mock;
const mockedExecuteTransaction = executeTransaction as jest.Mock;
const mockedGetContextAutomationPolicy =
  getContextAutomationPolicy as jest.Mock;
const mockedSetContextAutomationPolicy =
  setContextAutomationPolicy as jest.Mock;
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

describe('ensureContextAutomationPolicy', () => {
  beforeEach(() => {
    mockedGetContextAutomationPolicy.mockReset();
    mockedSetContextAutomationPolicy.mockReset();
  });

  test('已有持久化策略时原样返回且不重复写入', async () => {
    const persisted = {
      schemaVersion: 2,
      allocatorVersion: 'persisted-policy',
    } as any;
    mockedGetContextAutomationPolicy.mockResolvedValue(persisted);

    await expect(ensureContextAutomationPolicy()).resolves.toBe(persisted);
    expect(mockedSetContextAutomationPolicy).not.toHaveBeenCalled();
  });

  test('缺少策略时写入版本化默认策略', async () => {
    mockedGetContextAutomationPolicy.mockResolvedValue(null);

    const policy = await ensureContextAutomationPolicy();
    expect(policy.schemaVersion).toBe(2);
    expect(policy.allocatorVersion).toBe('context-automation-v2');
    expect(mockedSetContextAutomationPolicy).toHaveBeenCalledWith(policy);
  });
});

describe('applyContextAutoAllocation', () => {
  beforeEach(() => {
    mockedAll.mockReset();
    mockedExecuteTransaction.mockReset();
    mockedSetContextAutoLastApplied.mockReset();
    mockedGetContextAutomationPolicy.mockReset();
    mockedGetContextAutomationPolicy.mockResolvedValue(null);
    mockedSetContextAutomationPolicy.mockReset();
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
    // 8 个 settings（含 input + policy + 6 个 ContextConfig）+ llm_config
    // + presets + 4 个资源表 = 14 个；大纲阶段预算不再写入 settings。
    expect(statements.length).toBe(14);
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
    expect(settingsKeys).not.toContain('pipeline_draft_max_tokens');
    expect(settingsKeys).not.toContain('pipeline_review_max_tokens');
    expect(settingsKeys).not.toContain('pipeline_factcheck_max_tokens');
    expect(settingsKeys).not.toContain('pipeline_proof_max_tokens');
    expect(settingsKeys).toContain('context_auto_input');
    expect(settingsKeys).toContain('context_auto_policy_v2');
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

  test('当前自动分配不再写入旧流水线四阶段固定预算', async () => {
    await applyContextAutoAllocation(200000);
    const [, statements] = mockedExecuteTransaction.mock.calls[0];
    const settingsKeys = statements
      .filter((s: any) => s.sql.includes('INSERT OR REPLACE INTO settings'))
      .map((s: any) => s.params[0]);
    expect(settingsKeys).not.toEqual(
      expect.arrayContaining([
        'pipeline_draft_max_tokens',
        'pipeline_review_max_tokens',
        'pipeline_factcheck_max_tokens',
        'pipeline_proof_max_tokens',
      ]),
    );
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

  test('presets UPDATE 使用模型输出基线，不再使用 Draft 的旧 50% 分配', async () => {
    await applyContextAutoAllocation(200000);
    const [, statements] = mockedExecuteTransaction.mock.calls[0];
    const presetStmt = statements.find((s: any) => s.sql.includes('UPDATE presets'));
    expect(presetStmt.params).toEqual([40000]);
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
    // 8 个 settings INSERT OR REPLACE（含 policy/input + 6 ContextConfig）
    const settingsStmts = statements.filter((s: any) =>
      s.sql.includes('INSERT OR REPLACE INTO settings'),
    );
    expect(settingsStmts.length).toBe(8);
    // 不应包含 strategy / pipelineMode / presetId 等 key
    const settingsKeys = settingsStmts.map((s: any) => s.params[0]);
    expect(settingsKeys).not.toContain('context_strategy');
    expect(settingsKeys).not.toContain('pipeline_mode');
    expect(settingsKeys).not.toContain('pipeline_draft_preset_id');
  });
});

// ============================================================================
// 大纲流水线：五阶段独立弹性 reservation
// ============================================================================

const OUTLINE_STAGES = ['draft', 'review', 'factCheck', 'brief', 'proof'] as const;

describe('buildOutlineElasticBudgetPreview', () => {
  test.each([
    [1_000_000, 200_000, 200_000],
    [1_000_000, 64_000, 64_000],
    [128_000, 32_000, 25_600],
  ])(
    'context=%i modelMax=%i 时五阶段都使用独立 reservation=%i',
    (contextWindow, modelMaxOutputTokens, expected) => {
      const preview = buildOutlineElasticBudgetPreview({
        contextWindow,
        modelMaxOutputTokens,
      });
      expect(
        OUTLINE_STAGES.map(stage => preview.stages[stage].requestMaxTokens),
      ).toEqual(OUTLINE_STAGES.map(() => expected));
    },
  );

  test('预览使用同一个 resolver，并保留阶段语义 floor', () => {
    const preview = buildOutlineElasticBudgetPreview({
      contextWindow: 1_000_000,
      modelMaxOutputTokens: 200_000,
    });
    const expected = resolveElasticStageOutputReservation({
      contextWindow: 1_000_000,
      modelMaxOutputTokens: 200_000,
    });
    expect(preview.stages.draft.requestMaxTokens).toBe(expected);
    expect(preview.stages.brief.visibleOutputFloor).toBe(1200);
    expect(preview.stages.proof.visibleOutputFloor).toBe(5000);
  });

  test('无模型输出上限时仍受 context 的 20% reservation 和最小值保护', () => {
    expect(
      resolveElasticStageOutputReservation({ contextWindow: 100 }),
    ).toBe(MIN_PIPELINE_TOKENS);
  });
});

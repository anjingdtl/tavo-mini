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
import * as contextAutoAllocator from '../src/services/contextAutoAllocator';

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
test('旧版全局 Context Auto 写入口不再导出', () => {
  expect((contextAutoAllocator as any).applyContextAutoAllocation).toBeUndefined();
});

// 旧版全局写库集成测试已随遗留入口移除；下方只覆盖受支持的 V3 策略。

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

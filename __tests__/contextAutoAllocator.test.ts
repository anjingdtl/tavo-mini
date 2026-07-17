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

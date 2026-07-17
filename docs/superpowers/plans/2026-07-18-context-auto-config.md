# 上下文自动化配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设置板块新增"上下文自动化配置"模块，用户填一个数字（如 200000），系统按内置比例分配到 ContextConfig / PipelineConfig / llm_config / presets / 资源表 5 处。

**Architecture:** 方案 B（薄层 + settings 元数据）。
- 纯函数 `allocateContextBudget(maxContextTokens, resourceCounts)` 计算分配方案
- 应用函数 `applyContextAutoAllocation` 在单一 `executeTransaction` 内原子写入
- 新屏幕 `ContextAutoConfigScreen` 实时预览 + 一键应用
- 不修改 schema 版本（settings 键值表 + JSON 序列化）

**Tech Stack:** React Native CLI + TypeScript + Zustand + react-native-sqlite-storage + Jest

**Spec:** `docs/superpowers/specs/2026-07-18-context-auto-config-design.md`

---

## File Structure

### 新增（5）

| 路径 | 职责 |
|---|---|
| `src/services/contextAutoAllocator.ts` | 类型 + `allocateContextBudget` 纯函数 + `applyContextAutoAllocation` 应用函数 |
| `src/data/repositories/contextAutoRepository.ts` | 读写 settings 表两个新 key（`context_auto_input` / `context_auto_last_applied`） |
| `src/screens/ContextAutoConfigScreen.tsx` | 新屏幕 |
| `__tests__/contextAutoAllocator.test.ts` | 纯函数单测 |
| `__tests__/contextAutoRepository.test.ts` | repository 读写测试 |

### 修改（4）

| 路径 | 修改点 |
|---|---|
| `src/navigation/TabNavigator.tsx` | `SettingsStackParamList` + 栈注册 |
| `src/screens/SettingsScreen.tsx` | AI Section 顶部插入入口 Card |
| `src/services/database.ts` | re-export `contextAutoRepository`（与其他 repository 一致） |
| `src/types/novel.ts`（如需要） | 若资源 repository 返回 Row，无需改 |

---

## Phase 1: 纯函数 `allocateContextBudget` + 类型

**Files:**
- Create: `src/services/contextAutoAllocator.ts`
- Test: `__tests__/contextAutoAllocator.test.ts`

### Task 1.1: 创建类型定义文件骨架

- [ ] **Step 1: 创建 `src/services/contextAutoAllocator.ts`，写入类型定义和占位实现**

```ts
/* eslint-env jest */
// 文件顶部
/**
 * 上下文自动化配置：纯计算 + 应用函数。
 *
 * 设计文档：docs/superpowers/specs/2026-07-18-context-auto-config-design.md
 *
 * 顶层分配：maxContextTokens 的 80% 作输入预算、20% 作输出预算。
 * 输入侧再按 65/20/15 拆给滑动窗口/资料/摘要；
 * 输出侧按 50/15/15/20 拆给草稿/审阅/事实/校对。
 * 资源级单项上限按实际数量动态分摊（R1 算法）。
 */

export interface ResourceCounts {
  characters: number;
  notes: number;
  worldbookEntries: number;
  worldbookCollections: number;
}

export interface AllocationResult {
  // 输入侧（写入 ContextConfig）
  slidingWindowSize: number;
  resourceBudget: number;
  summaryBudgetTokens: number;
  // 输出侧（写入 PipelineConfig）
  draftMaxTokens: number;
  reviewMaxTokens: number;
  factCheckMaxTokens: number;
  proofMaxTokens: number;
  // 同步写入 llm_config / presets
  llmContextWindow: number;
  llmMaxOutputTokens: number;
  presetMaxTokens: number;
  // 资源级单项
  characterMaxTokens: number;
  noteMaxTokens: number;
  worldbookEntryMaxTokens: number;
  worldbookCollectionMaxTokens: number;
  // 元信息
  inputBudget: number;
  outputBudget: number;
  resourceCounts: ResourceCounts;
}

// 写死比例
export const RATIO_INPUT = 0.8;
export const RATIO_OUTPUT = 0.2;

// 输入侧内部比例（占 inputBudget）
export const RATIO_SLIDING_WINDOW = 0.65;
export const RATIO_RESOURCE_BUDGET = 0.2;
export const RATIO_SUMMARY_BUDGET = 0.15;

// 输出侧内部比例（占 outputBudget）
export const RATIO_DRAFT = 0.5;
export const RATIO_REVIEW = 0.15;
export const RATIO_FACT_CHECK = 0.15;
export const RATIO_PROOF = 0.2;

// 资料预算内部子比例（contextBuilder.ts 现有约定）
export const RATIO_RESOURCE_CHARACTER = 0.35;
export const RATIO_RESOURCE_NOTE = 0.2;
export const RATIO_RESOURCE_WORLDBOOK = 0.45;

// 数值下限（兜底）
export const MIN_CONTEXT_TOKENS = 1;
export const WARNING_CONTEXT_TOKENS = 8000;
export const MIN_SLIDING_WINDOW = 1000;
export const MIN_SUMMARY_BUDGET = 2000;
export const MIN_RESOURCE_BUDGET = 500;
export const MIN_CHARACTER_TOKENS = 1000;
export const MIN_NOTE_TOKENS = 500;
export const MIN_WORLDBOOK_ENTRY_TOKENS = 500;
export const MIN_WORLDBOOK_COLLECTION_TOKENS = 2000;
export const MIN_PIPELINE_TOKENS = 256;

const floor = (value: number, min: number): number =>
  Math.max(min, Math.round(value));

/**
 * 根据用户输入的 maxContextTokens 和当前资源数量，
 * 计算出所有要覆写的字段值。纯函数，无副作用。
 *
 * @throws Error 当 maxContextTokens <= 0 或非有限数
 */
export function allocateContextBudget(
  maxContextTokens: number,
  resourceCounts: ResourceCounts,
): AllocationResult {
  if (!Number.isFinite(maxContextTokens) || maxContextTokens <= 0) {
    throw new Error(
      `maxContextTokens 必须为正数，收到：${maxContextTokens}`,
    );
  }

  const inputBudget = Math.round(maxContextTokens * RATIO_INPUT);
  const outputBudget = Math.round(maxContextTokens * RATIO_OUTPUT);

  // 输入侧
  const slidingWindowSize = floor(
    inputBudget * RATIO_SLIDING_WINDOW,
    MIN_SLIDING_WINDOW,
  );
  const resourceBudget = floor(
    inputBudget * RATIO_RESOURCE_BUDGET,
    MIN_RESOURCE_BUDGET,
  );
  const summaryBudgetTokens = floor(
    inputBudget * RATIO_SUMMARY_BUDGET,
    MIN_SUMMARY_BUDGET,
  );

  // 输出侧
  const draftMaxTokens = floor(outputBudget * RATIO_DRAFT, MIN_PIPELINE_TOKENS);
  const reviewMaxTokens = floor(
    outputBudget * RATIO_REVIEW,
    MIN_PIPELINE_TOKENS,
  );
  const factCheckMaxTokens = floor(
    outputBudget * RATIO_FACT_CHECK,
    MIN_PIPELINE_TOKENS,
  );
  const proofMaxTokens = floor(
    outputBudget * RATIO_PROOF,
    MIN_PIPELINE_TOKENS,
  );

  // 资料预算内部子分配（角色 35% / 笔记 20% / 世界书 45%）
  const characterTotal = resourceBudget * RATIO_RESOURCE_CHARACTER;
  const noteTotal = resourceBudget * RATIO_RESOURCE_NOTE;
  const worldbookTotal = resourceBudget * RATIO_RESOURCE_WORLDBOOK;

  // 单项 = 子总额 / MAX(数量, 1)，避免除零；count=0 时单项仍计算但不写入（由应用函数处理）
  const safeCount = (n: number): number => Math.max(n, 1);
  const characterMaxTokens = floor(
    characterTotal / safeCount(resourceCounts.characters),
    MIN_CHARACTER_TOKENS,
  );
  const noteMaxTokens = floor(
    noteTotal / safeCount(resourceCounts.notes),
    MIN_NOTE_TOKENS,
  );
  const worldbookEntryMaxTokens = floor(
    worldbookTotal / safeCount(resourceCounts.worldbookEntries),
    MIN_WORLDBOOK_ENTRY_TOKENS,
  );
  const worldbookCollectionMaxTokens = floor(
    worldbookTotal / safeCount(resourceCounts.worldbookCollections),
    MIN_WORLDBOOK_COLLECTION_TOKENS,
  );

  return {
    slidingWindowSize,
    resourceBudget,
    summaryBudgetTokens,
    draftMaxTokens,
    reviewMaxTokens,
    factCheckMaxTokens,
    proofMaxTokens,
    llmContextWindow: Math.round(maxContextTokens),
    llmMaxOutputTokens: outputBudget,
    presetMaxTokens: draftMaxTokens,
    characterMaxTokens,
    noteMaxTokens,
    worldbookEntryMaxTokens,
    worldbookCollectionMaxTokens,
    inputBudget,
    outputBudget,
    resourceCounts,
  };
}
```

- [ ] **Step 2: 运行 typecheck 验证文件无语法错误**

Run: `npm run typecheck`
Expected: PASS（无新增错误；如果报错与本文件无关，是 baseline）

### Task 1.2: 写纯函数单测

- [ ] **Step 1: 创建 `__tests__/contextAutoAllocator.test.ts`**

```ts
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
    // 每个角色：800000*0.65*0.2*0.35 / 50 = 728
    // 简化：800000 * 0.8 * 0.2 * 0.35 / 50
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
```

- [ ] **Step 2: 运行测试，确认全部通过**

Run: `npx jest __tests__/contextAutoAllocator.test.ts`
Expected: PASS（7 个 test 全绿）

- [ ] **Step 3: Commit**

```bash
git add src/services/contextAutoAllocator.ts __tests__/contextAutoAllocator.test.ts
git commit -m "feat(context-auto): 添加上下文预算分配纯函数

实现 allocateContextBudget 及 12 个比例/下限常量。
覆盖典型/极大/极小/零资源数量等分支的单测。"
```

---

## Phase 2: `contextAutoRepository`

**Files:**
- Create: `src/data/repositories/contextAutoRepository.ts`
- Modify: `src/services/database.ts`（re-export）
- Test: `__tests__/contextAutoRepository.test.ts`

### Task 2.1: 实现 repository

- [ ] **Step 1: 创建 `src/data/repositories/contextAutoRepository.ts`**

```ts
/**
 * 上下文自动化配置：在 settings 键值表存两个 key。
 *
 * - context_auto_input：用户最后输入的 maxContextTokens（number）
 * - context_auto_last_applied：最近一次应用记录（JSON）
 *
 * 与 settingsRepository 风格一致（单独 export 异步函数）。
 */

import type { AllocationResult, ResourceCounts } from '../../services/contextAutoAllocator';
import { getSetting, setSetting } from './settingsRepository';

const KEY_INPUT = 'context_auto_input';
const KEY_LAST_APPLIED = 'context_auto_last_applied';

export interface ContextAutoAppliedRecord {
  maxContextTokens: number;
  appliedAt: number; // Unix 毫秒
  allocation: AllocationResult;
  affectedCounts: {
    llmConfigs: number;
    presets: number;
    characters: number;
    notes: number;
    worldbookEntries: number;
    worldbookCollections: number;
  };
}

export async function getContextAutoInput(): Promise<number | null> {
  const raw = await getSetting(KEY_INPUT);
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export async function setContextAutoInput(value: number): Promise<void> {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`setContextAutoInput: value 必须为正数，收到 ${value}`);
  }
  await setSetting(KEY_INPUT, String(Math.round(value)));
}

export async function getContextAutoLastApplied(): Promise<ContextAutoAppliedRecord | null> {
  const raw = await getSetting(KEY_LAST_APPLIED);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ContextAutoAppliedRecord;
  } catch {
    return null;
  }
}

export async function setContextAutoLastApplied(
  record: ContextAutoAppliedRecord,
): Promise<void> {
  await setSetting(KEY_LAST_APPLIED, JSON.stringify(record));
}

/**
 * 应用函数构建 last_applied 记录时的辅助类型。
 * 仅供 applyContextAutoAllocation 使用。
 */
export function buildAppliedRecord(
  maxContextTokens: number,
  allocation: AllocationResult,
  affectedCounts: ContextAutoAppliedRecord['affectedCounts'],
): ContextAutoAppliedRecord {
  return {
    maxContextTokens,
    appliedAt: Date.now(),
    allocation,
    affectedCounts,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _typeCheck: ResourceCounts | null = null;
void _typeCheck;
```

- [ ] **Step 2: 在 `src/services/database.ts` 末尾添加 re-export**

读 `src/services/database.ts`，确认在 `export * from '../data/repositories/pipelineTaskRepository';` 之后（约第 30 行）追加：

```ts
export * from '../data/repositories/contextAutoRepository';
```

### Task 2.2: 写 repository 测试

- [ ] **Step 1: 创建 `__tests__/contextAutoRepository.test.ts`**

```ts
/* eslint-env jest */

// 在 import 之前 mock settingsRepository
jest.mock('../src/data/repositories/settingsRepository', () => ({
  __esModule: true,
  getSetting: jest.fn(),
  setSetting: jest.fn(),
}));

import {
  getContextAutoInput,
  setContextAutoInput,
  getContextAutoLastApplied,
  setContextAutoLastApplied,
  buildAppliedRecord,
} from '../src/data/repositories/contextAutoRepository';
import { getSetting, setSetting } from '../src/data/repositories/settingsRepository';

const mockedGetSetting = getSetting as jest.Mock;
const mockedSetSetting = setSetting as jest.Mock;

describe('contextAutoRepository', () => {
  beforeEach(() => {
    mockedGetSetting.mockReset();
    mockedSetSetting.mockReset();
  });

  describe('getContextAutoInput', () => {
    test('未配置时返回 null', async () => {
      mockedGetSetting.mockResolvedValue(null);
      expect(await getContextAutoInput()).toBeNull();
    });

    test('空字符串返回 null', async () => {
      mockedGetSetting.mockResolvedValue('');
      expect(await getContextAutoInput()).toBeNull();
    });

    test('合法数值返回 number', async () => {
      mockedGetSetting.mockResolvedValue('200000');
      expect(await getContextAutoInput()).toBe(200000);
    });

    test('非法值（0/负数/NaN）返回 null', async () => {
      mockedGetSetting.mockResolvedValue('0');
      expect(await getContextAutoInput()).toBeNull();
      mockedGetSetting.mockResolvedValue('-1');
      expect(await getContextAutoInput()).toBeNull();
      mockedGetSetting.mockResolvedValue('not-a-number');
      expect(await getContextAutoInput()).toBeNull();
    });
  });

  describe('setContextAutoInput', () => {
    test('合法值写入字符串', async () => {
      await setContextAutoInput(200000);
      expect(mockedSetSetting).toHaveBeenCalledWith('context_auto_input', '200000');
    });

    test('小数会被取整', async () => {
      await setContextAutoInput(200000.7);
      expect(mockedSetSetting).toHaveBeenCalledWith('context_auto_input', '200001');
    });

    test('非正数抛错', async () => {
      await expect(setContextAutoInput(0)).rejects.toThrow(/正数/);
      await expect(setContextAutoInput(-1)).rejects.toThrow(/正数/);
      await expect(setContextAutoInput(NaN)).rejects.toThrow(/正数/);
    });
  });

  describe('getContextAutoLastApplied', () => {
    test('未配置返回 null', async () => {
      mockedGetSetting.mockResolvedValue(null);
      expect(await getContextAutoLastApplied()).toBeNull();
    });

    test('合法 JSON 返回 record', async () => {
      const record = {
        maxContextTokens: 200000,
        appliedAt: 1234567890,
        allocation: { slidingWindowSize: 104000 } as any,
        affectedCounts: {
          llmConfigs: 1, presets: 2, characters: 3,
          notes: 4, worldbookEntries: 5, worldbookCollections: 6,
        },
      };
      mockedGetSetting.mockResolvedValue(JSON.stringify(record));
      const result = await getContextAutoLastApplied();
      expect(result).toEqual(record);
    });

    test('非法 JSON 返回 null', async () => {
      mockedGetSetting.mockResolvedValue('{not valid json');
      expect(await getContextAutoLastApplied()).toBeNull();
    });
  });

  describe('setContextAutoLastApplied', () => {
    test('写入 JSON 字符串', async () => {
      const record = buildAppliedRecord(
        200000,
        { slidingWindowSize: 104000 } as any,
        { llmConfigs: 1, presets: 2, characters: 3, notes: 4, worldbookEntries: 5, worldbookCollections: 6 },
      );
      await setContextAutoLastApplied(record);
      expect(mockedSetSetting).toHaveBeenCalled();
      const [key, value] = mockedSetSetting.mock.calls[0];
      expect(key).toBe('context_auto_last_applied');
      const parsed = JSON.parse(value);
      expect(parsed.maxContextTokens).toBe(200000);
      expect(parsed.appliedAt).toBeGreaterThan(0);
      expect(parsed.affectedCounts.characters).toBe(3);
    });
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `npx jest __tests__/contextAutoRepository.test.ts`
Expected: PASS（全部 case）

- [ ] **Step 3: Commit**

```bash
git add src/data/repositories/contextAutoRepository.ts src/services/database.ts __tests__/contextAutoRepository.test.ts
git commit -m "feat(context-auto): 添加 contextAutoRepository 读写 settings key

新增 getContextAutoInput/setContextAutoInput/getContextAutoLastApplied/
setContextAutoLastApplied/buildAppliedRecord。在 services/database.ts
re-export。"
```

---

## Phase 3: `applyContextAutoAllocation` 应用函数 + 集成测试

**Files:**
- Modify: `src/services/contextAutoAllocator.ts`（追加应用函数）
- Test: `__tests__/contextAutoAllocator.test.ts`（追加集成测试）

### Task 3.1: 在 contextAutoAllocator.ts 追加资源计数 + 应用函数

- [ ] **Step 1: 在 `src/services/contextAutoAllocator.ts` 文件末尾追加（不重写已有内容）**

```ts
// ============================================================================
// 应用函数：以下为有副作用部分，与纯函数分开维护
// ============================================================================

import { openDatabase } from '../data/connection/openDatabase';
import { executeTransaction, type SqlStatement } from './database/transaction';
import { all } from '../data/connection/query';
import {
  buildAppliedRecord,
  setContextAutoLastApplied,
  type ContextAutoAppliedRecord,
} from '../data/repositories/contextAutoRepository';

/**
 * 查询所有项目的资源数量（用于动态分配单项上限）。
 * 跨项目，无 WHERE 限制。
 */
export async function countAllResources(): Promise<ResourceCounts> {
  const db = await openDatabase();
  const countOf = async (table: string): Promise<number> => {
    const rows = await all<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`);
    return Number(rows[0]?.c ?? 0);
  };
  const [characters, notes, worldbookEntries, worldbookCollections] =
    await Promise.all([
      countOf('characters'),
      countOf('notes'),
      countOf('worldbook_entries'),
      countOf('worldbook_collections'),
    ]);
  return { characters, notes, worldbookEntries, worldbookCollections };
}

/**
 * 查询非本地 LLM 配置数（context_window/max_output_tokens 会被覆写）。
 * 本地 llama_cpp 配置不覆写。
 */
export async function countNonLocalLlmConfigs(): Promise<number> {
  const rows = await all<{ c: number }>(
    `SELECT COUNT(*) AS c FROM llm_config WHERE provider_type IS NOT 'llama_cpp' OR provider_type IS NULL`,
  );
  return Number(rows[0]?.c ?? 0);
}

/**
 * 查询 preset 总数。
 */
export async function countAllPresets(): Promise<number> {
  const rows = await all<{ c: number }>(`SELECT COUNT(*) AS c FROM presets`);
  return Number(rows[0]?.c ?? 0);
}

/**
 * 应用上下文自动化分配方案。
 *
 * 单一 executeTransaction 原子写入所有目标字段。任一步失败 → 整体回滚。
 *
 * 1. 读现有 ContextConfig / PipelineConfig（合并未覆写字段）
 * 2. 读资源数量
 * 3. 计算 AllocationResult
 * 4. 构建 SqlStatement[] 一次性执行
 * 5. 写 last_applied 记录
 *
 * @returns 应用记录（含 allocation 与 affectedCounts）
 */
export async function applyContextAutoAllocation(
  maxContextTokens: number,
): Promise<ContextAutoAppliedRecord> {
  // 阶段 1：读 + 算
  const [resourceCounts, llmCount, presetCount] = await Promise.all([
    countAllResources(),
    countNonLocalLlmConfigs(),
    countAllPresets(),
  ]);

  const allocation = allocateContextBudget(maxContextTokens, resourceCounts);

  // 构建语句列表。settings 表用 INSERT OR REPLACE，其他表用 UPDATE。
  const statements: SqlStatement[] = [
    // ContextConfig 字段（保留 strategy/recentChapterCount/memoryTopK 等）
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: ['sliding_window_size', String(allocation.slidingWindowSize)],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: ['resource_budget', String(allocation.resourceBudget)],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: ['summary_budget_tokens', String(allocation.summaryBudgetTokens)],
    },
    // PipelineConfig 字段（保留 pipelineMode 与 presetId）
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: ['pipeline_draft_max_tokens', String(allocation.draftMaxTokens)],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: ['pipeline_review_max_tokens', String(allocation.reviewMaxTokens)],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: [
        'pipeline_factcheck_max_tokens',
        String(allocation.factCheckMaxTokens),
      ],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: ['pipeline_proof_max_tokens', String(allocation.proofMaxTokens)],
    },
    // llm_config：仅非本地配置
    {
      sql: `UPDATE llm_config SET context_window = ?, max_output_tokens = ?
            WHERE provider_type IS NOT 'llama_cpp' OR provider_type IS NULL`,
      params: [allocation.llmContextWindow, allocation.llmMaxOutputTokens],
    },
    // presets：全部
    {
      sql: 'UPDATE presets SET max_tokens = ?',
      params: [allocation.presetMaxTokens],
    },
  ];

  // 资源表：仅 count > 0 时加入
  if (resourceCounts.characters > 0) {
    statements.push({
      sql: 'UPDATE characters SET max_tokens = ?',
      params: [allocation.characterMaxTokens],
    });
  }
  if (resourceCounts.notes > 0) {
    statements.push({
      sql: 'UPDATE notes SET max_tokens = ?',
      params: [allocation.noteMaxTokens],
    });
  }
  if (resourceCounts.worldbookEntries > 0) {
    statements.push({
      sql: 'UPDATE worldbook_entries SET max_tokens = ?',
      params: [allocation.worldbookEntryMaxTokens],
    });
  }
  if (resourceCounts.worldbookCollections > 0) {
    statements.push({
      sql: 'UPDATE worldbook_collections SET max_tokens = ?',
      params: [allocation.worldbookCollectionMaxTokens],
    });
  }

  // 阶段 2：执行单一事务
  const db = await openDatabase();
  await executeTransaction(db, statements);

  // 阶段 3：写 last_applied 记录（与主事务分开，避免读现有值与执行时机冲突）
  const record = buildAppliedRecord(maxContextTokens, allocation, {
    llmConfigs: llmCount,
    presets: presetCount,
    characters: resourceCounts.characters,
    notes: resourceCounts.notes,
    worldbookEntries: resourceCounts.worldbookEntries,
    worldbookCollections: resourceCounts.worldbookCollections,
  });
  await setContextAutoLastApplied(record);

  return record;
}
```

注意：当前实现用 SQL `INSERT OR REPLACE INTO settings` 直接覆写 ContextConfig / PipelineConfig 的 token 字段，不读取现有值——保留 `strategy` / `pipelineMode` / `*PresetId` 等其他字段不动。

- [ ] **Step 2: 运行 typecheck**

Run: `npm run typecheck`
Expected: PASS

### Task 3.2: 写应用函数集成测试

- [ ] **Step 1: 在 `__tests__/contextAutoAllocator.test.ts` 末尾追加（不删除现有内容）**

```ts
// 集成测试：mock 数据库
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
    expect(statements.length).toBeGreaterThan(7); // 至少 7 个 settings + llm_config + presets
    // 检查关键字段
    const sqls = statements.map((s: any) => s.sql);
    expect(sqls.some((s: string) => s.includes('sliding_window_size'))).toBe(true);
    expect(sqls.some((s: string) => s.includes('pipeline_draft_max_tokens'))).toBe(true);
    expect(sqls.some((s: string) => s.includes("FROM llm_config SET") || s.includes('UPDATE llm_config'))).toBe(true);
    expect(sqls.some((s: string) => s.includes('UPDATE presets'))).toBe(true);
    // 资源表（count=1 > 0，应有 UPDATE）
    expect(sqls.some((s: string) => s.includes('UPDATE characters'))).toBe(true);
    expect(sqls.some((s: string) => s.includes('UPDATE notes'))).toBe(true);
    expect(sqls.some((s: string) => s.includes('UPDATE worldbook_entries'))).toBe(true);
    expect(sqls.some((s: string) => s.includes('UPDATE worldbook_collections'))).toBe(true);
    // last_applied
    expect(mockedSetContextAutoLastApplied).toHaveBeenCalledTimes(1);
    expect(record.maxContextTokens).toBe(200000);
    expect(record.allocation.inputBudget).toBe(160000);
  });

  test('资源数量为 0 时跳过对应 UPDATE', async () => {
    mockedAll.mockReset();
    mockedAll
      .mockResolvedValueOnce([{ c: 0 }]) // characters
      .mockResolvedValueOnce([{ c: 0 }]) // notes
      .mockResolvedValueOnce([{ c: 0 }]) // worldbook_entries
      .mockResolvedValueOnce([{ c: 0 }]) // worldbook_collections
      .mockResolvedValueOnce([{ c: 1 }]) // llmCount
      .mockResolvedValueOnce([{ c: 1 }]); // presetCount
    await applyContextAutoAllocation(200000);
    const [, statements] = mockedExecuteTransaction.mock.calls[0];
    const sqls = statements.map((s: any) => s.sql);
    expect(sqls.some((s: string) => s.includes('UPDATE characters'))).toBe(false);
    expect(sqls.some((s: string) => s.includes('UPDATE notes'))).toBe(false);
    expect(sqls.some((s: string) => s.includes('UPDATE worldbook_entries'))).toBe(false);
    expect(sqls.some((s: string) => s.includes('UPDATE worldbook_collections'))).toBe(false);
  });

  test('llm_config UPDATE WHERE 子句排除 llama_cpp', async () => {
    await applyContextAutoAllocation(200000);
    const [, statements] = mockedExecuteTransaction.mock.calls[0];
    const llmStmt = statements.find((s: any) => s.sql.includes('UPDATE llm_config'));
    expect(llmStmt).toBeDefined();
    expect(llmStmt.sql).toContain("provider_type IS NOT 'llama_cpp'");
    expect(llmStmt.params).toEqual([200000, 40000]);
  });

  test('事务失败抛错且不写 last_applied', async () => {
    mockedExecuteTransaction.mockRejectedValue(new Error('transaction failed'));
    await expect(applyContextAutoAllocation(200000)).rejects.toThrow(/transaction failed/);
    expect(mockedSetContextAutoLastApplied).not.toHaveBeenCalled();
  });

  test('maxContextTokens 非正数抛错（在 allocateContextBudget 阶段）', async () => {
    await expect(applyContextAutoAllocation(0)).rejects.toThrow(/正数/);
    await expect(applyContextAutoAllocation(-1)).rejects.toThrow(/正数/);
    expect(mockedExecuteTransaction).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行全部 contextAutoAllocator 测试**

Run: `npx jest __tests__/contextAutoAllocator.test.ts`
Expected: PASS（Phase 1 + Phase 3 全部 case）

- [ ] **Step 3: Commit**

```bash
git add src/services/contextAutoAllocator.ts __tests__/contextAutoAllocator.test.ts
git commit -m "feat(context-auto): 添加 applyContextAutoAllocation 应用函数

读现有配置 + 资源数量 → 算分配方案 → 单一 executeTransaction 原子写入
→ 写 last_applied 记录。集成测试覆盖成功/失败/边界。"
```

---

## Phase 4: `ContextAutoConfigScreen` + 接线 + 手动验收

**Files:**
- Create: `src/screens/ContextAutoConfigScreen.tsx`
- Modify: `src/navigation/TabNavigator.tsx`
- Modify: `src/screens/SettingsScreen.tsx`

### Task 4.1: 创建屏幕

- [ ] **Step 1: 创建 `src/screens/ContextAutoConfigScreen.tsx`**

```tsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { RotateCcw, Sparkles } from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import { Button, Card, Header, Screen, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import {
  allocateContextBudget,
  applyContextAutoAllocation,
  countAllResources,
  type AllocationResult,
  type ResourceCounts,
} from '../services/contextAutoAllocator';
import {
  getContextAutoInput,
  getContextAutoLastApplied,
  setContextAutoInput,
  type ContextAutoAppliedRecord,
} from '../data/repositories/contextAutoRepository';
import {
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_MAX_TOKENS,
} from '../constants/defaults';
import * as db from '../services/database';

const QUICK_PRESETS: { label: string; value: number }[] = [
  { label: '128K', value: 128000 },
  { label: '200K', value: 200000 },
  { label: '512K', value: 512000 },
  { label: '1M', value: 1000000 },
];

const DEFAULT_INPUT_VALUE = 200000;
const WARNING_THRESHOLD = 8000;

// 数字格式化：1000 → "1,000"
function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export const ContextAutoConfigScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const [inputText, setInputText] = useState<string>(String(DEFAULT_INPUT_VALUE));
  const [resourceCounts, setResourceCounts] = useState<ResourceCounts>({
    characters: 0,
    notes: 0,
    worldbookEntries: 0,
    worldbookCollections: 0,
  });
  const [lastApplied, setLastApplied] = useState<ContextAutoAppliedRecord | null>(null);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // 初次加载
  useEffect(() => {
    (async () => {
      try {
        const [savedInput, counts, applied] = await Promise.all([
          getContextAutoInput(),
          countAllResources(),
          getContextAutoLastApplied(),
        ]);
        if (savedInput != null) setInputText(String(savedInput));
        setResourceCounts(counts);
        setLastApplied(applied);
      } catch (e: any) {
        Toast.show({ type: 'error', text1: '加载失败', text2: e?.message });
      }
    })();
  }, []);

  const numericInput = useMemo(() => {
    const v = Number(inputText);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }, [inputText]);

  const preview: AllocationResult | null = useMemo(() => {
    if (numericInput <= 0) return null;
    try {
      return allocateContextBudget(numericInput, resourceCounts);
    } catch {
      return null;
    }
  }, [numericInput, resourceCounts]);

  const isWarning = numericInput > 0 && numericInput < WARNING_THRESHOLD;

  const handleQuickPreset = (value: number) => {
    setInputText(String(value));
  };

  const handleApply = () => {
    if (numericInput <= 0) {
      Toast.show({ type: 'error', text1: '请输入有效的上下文大小' });
      return;
    }
    Alert.alert(
      '确认应用',
      `将以 ${formatNumber(numericInput)} tokens 为基准，覆写：\n\n` +
        '• 所有 LLM 配置的 context_window 与 max_output_tokens\n' +
        '• 所有预设的 max_tokens\n' +
        '• 当前项目的上下文与流水线配置\n' +
        '• 所有项目的角色、笔记、世界书 max_tokens\n\n' +
        '本地 GGUF 模型的配置不会被修改。此操作不可撤销。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '应用',
          style: 'destructive',
          onPress: async () => {
            setApplying(true);
            try {
              await setContextAutoInput(numericInput);
              const record = await applyContextAutoAllocation(numericInput);
              setLastApplied(record);
              Toast.show({
                type: 'success',
                text1: `已应用 ${formatNumber(numericInput)} tokens 的分配方案`,
              });
            } catch (e: any) {
              Toast.show({
                type: 'error',
                text1: '应用失败',
                text2: e?.message,
              });
            } finally {
              setApplying(false);
            }
          },
        },
      ],
    );
  };

  const handleRestoreDefaults = () => {
    Alert.alert(
      '恢复默认配置',
      '将把 ContextConfig、PipelineConfig 的 token 字段恢复到出厂默认值。\n\n' +
        '注意：LLM 配置、预设、资源级 max_tokens 不会被重置。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '恢复',
          style: 'destructive',
          onPress: async () => {
            setRestoring(true);
            try {
              const pipelineConfig = await db.getPipelineConfig();
              await db.setContextConfig({
                ...DEFAULT_CONTEXT_CONFIG,
              });
              await db.setPipelineConfig({
                ...pipelineConfig,
                draftMaxTokens: 4000,
                reviewMaxTokens: 1500,
                factCheckMaxTokens: 1500,
                proofMaxTokens: 4000,
              });
              Toast.show({ type: 'success', text1: '已恢复默认配置' });
              setLastApplied(null);
            } catch (e: any) {
              Toast.show({
                type: 'error',
                text1: '恢复失败',
                text2: e?.message,
              });
            } finally {
              setRestoring(false);
            }
          },
        },
      ],
    );
  };

  return (
    <Screen>
      <Header
        title="上下文自动化配置"
        subtitle="填一个数字，自动分配所有 token 预算"
      />
      <ScrollView contentContainerStyle={styles.content}>
        {/* 上次应用记录 */}
        {lastApplied ? (
          <Card>
            <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>
              上次应用记录
            </Text>
            <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
              上下文大小：{formatNumber(lastApplied.maxContextTokens)} tokens
            </Text>
            <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
              时间：{new Date(lastApplied.appliedAt).toLocaleString('zh-CN')}
            </Text>
            <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
              已覆盖：
              {lastApplied.affectedCounts.llmConfigs} 个 LLM 配置 ·{' '}
              {lastApplied.affectedCounts.presets} 个预设 ·{' '}
              {lastApplied.affectedCounts.characters +
                lastApplied.affectedCounts.notes +
                lastApplied.affectedCounts.worldbookEntries +
                lastApplied.affectedCounts.worldbookCollections}{' '}
              个资源
            </Text>
          </Card>
        ) : null}

        {/* 输入最大上下文 */}
        <Card>
          <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>
            模型支持的最大上下文
          </Text>
          <Text style={[styles.cardMeta, { color: theme.colors.textSecondary }]}>
            查看你的模型文档（如 Claude/Gemini/DeepSeek），填入它支持的最大 tokens 数。
          </Text>
          <View style={styles.quickRow}>
            {QUICK_PRESETS.map((p) => {
              const active = numericInput === p.value;
              return (
                <TouchableOpacity
                  key={p.value}
                  onPress={() => handleQuickPreset(p.value)}
                  style={[
                    styles.quickChip,
                    {
                      borderColor: active ? theme.colors.accent : theme.colors.border,
                      backgroundColor: active
                        ? theme.colors.accentSoft
                        : theme.colors.card,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.quickText,
                      { color: active ? theme.colors.accent : theme.colors.textSecondary },
                    ]}
                  >
                    {p.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View
            style={[
              styles.inputBox,
              { borderColor: theme.colors.border, backgroundColor: theme.colors.card },
            ]}
          >
            <TextInput
              value={inputText}
              onChangeText={setInputText}
              keyboardType="number-pad"
              placeholder="例：200000"
              placeholderTextColor={theme.colors.textMuted}
              style={[styles.input, { color: theme.colors.textPrimary }]}
            />
            <Text style={[styles.inputSuffix, { color: theme.colors.textSecondary }]}>
              tokens
            </Text>
          </View>
          {isWarning ? (
            <Text style={[styles.warning, { color: theme.colors.warning }]}>
              ⚠️ 上下文过小，可能影响生成质量
            </Text>
          ) : null}
        </Card>

        {/* 分配预览 */}
        {preview ? (
          <Card>
            <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>
              分配预览
            </Text>

            <Text style={[styles.groupTitle, { color: theme.colors.accent }]}>
              📥 输入侧（80% = {formatNumber(preview.inputBudget)}）
            </Text>
            <PreviewRow label="滑动窗口" value={preview.slidingWindowSize} color={theme.colors.textPrimary} />
            <PreviewRow label="资料预算" value={preview.resourceBudget} color={theme.colors.textPrimary} />
            <PreviewRow label="摘要预算" value={preview.summaryBudgetTokens} color={theme.colors.textPrimary} />

            <Text style={[styles.groupTitle, { color: theme.colors.accent, marginTop: spacing.md }]}>
              📤 输出侧（20% = {formatNumber(preview.outputBudget)}）
            </Text>
            <PreviewRow label="草稿" value={preview.draftMaxTokens} color={theme.colors.textPrimary} />
            <PreviewRow label="审阅" value={preview.reviewMaxTokens} color={theme.colors.textPrimary} />
            <PreviewRow label="事实核查" value={preview.factCheckMaxTokens} color={theme.colors.textPrimary} />
            <PreviewRow label="校对" value={preview.proofMaxTokens} color={theme.colors.textPrimary} />

            <Text style={[styles.groupTitle, { color: theme.colors.accent, marginTop: spacing.md }]}>
              📊 资源级（按实际数量分摊）
            </Text>
            <PreviewRow
              label={`角色（${resourceCounts.characters} 个，单项）`}
              value={preview.characterMaxTokens}
              color={theme.colors.textPrimary}
              dimmed={resourceCounts.characters === 0}
            />
            <PreviewRow
              label={`笔记（${resourceCounts.notes} 个，单项）`}
              value={preview.noteMaxTokens}
              color={theme.colors.textPrimary}
              dimmed={resourceCounts.notes === 0}
            />
            <PreviewRow
              label={`世界书条目（${resourceCounts.worldbookEntries} 个，单项）`}
              value={preview.worldbookEntryMaxTokens}
              color={theme.colors.textPrimary}
              dimmed={resourceCounts.worldbookEntries === 0}
            />
            <PreviewRow
              label={`世界书合集（${resourceCounts.worldbookCollections} 个，单项）`}
              value={preview.worldbookCollectionMaxTokens}
              color={theme.colors.textPrimary}
              dimmed={resourceCounts.worldbookCollections === 0}
            />

            <Text style={[styles.groupTitle, { color: theme.colors.accent, marginTop: spacing.md }]}>
              🔗 同步写入
            </Text>
            <PreviewRow label="LLM context_window（非本地）" value={preview.llmContextWindow} color={theme.colors.textPrimary} />
            <PreviewRow label="LLM max_output_tokens（非本地）" value={preview.llmMaxOutputTokens} color={theme.colors.textPrimary} />
            <PreviewRow label="Presets max_tokens（全部）" value={preview.presetMaxTokens} color={theme.colors.textPrimary} />
          </Card>
        ) : null}

        <View style={styles.buttonRow}>
          <Button
            label="恢复默认"
            icon={RotateCcw}
            variant="ghost"
            flex
            disabled={restoring || applying}
            onPress={handleRestoreDefaults}
          />
          <Button
            label={applying ? '应用中...' : '一键应用'}
            icon={Sparkles}
            flex
            disabled={applying || restoring || numericInput <= 0}
            onPress={handleApply}
          />
        </View>

        <Text style={[styles.footnote, { color: theme.colors.textMuted }]}>
          本地 GGUF 模型的 context_window 不会被修改（由模型文件元数据决定）。
          {'\n'}默认输出 token 上限：{DEFAULT_MAX_TOKENS}。
        </Text>
      </ScrollView>
    </Screen>
  );
};

const PreviewRow: React.FC<{
  label: string;
  value: number;
  color: string;
  dimmed?: boolean;
}> = ({ label, value, color, dimmed }) => (
  <View style={previewStyles.row}>
    <Text style={[previewStyles.label, { color: dimmed ? '#999' : color }]}>
      {label}
    </Text>
    <Text style={[previewStyles.value, { color: dimmed ? '#999' : color }]}>
      {formatNumber(value)}
    </Text>
  </View>
);

// 用 require 避免 react-native-web 兼容问题（与本仓 ContextConfig.tsx 一致风格）
// 但本项目用 pure RN，直接 import 即可

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 96, gap: spacing.md },
  cardTitle: { fontSize: 16, fontFamily: 'serif', fontWeight: '700', marginBottom: spacing.xs },
  cardMeta: { fontSize: 12, lineHeight: 18, marginBottom: spacing.md },
  metaText: { fontSize: 13, lineHeight: 20 },
  quickRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md, flexWrap: 'wrap' },
  quickChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  quickText: { fontSize: 13, fontWeight: '700' },
  inputBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 7,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
  },
  input: { flex: 1, paddingVertical: spacing.sm, fontSize: 16 },
  inputSuffix: { fontSize: 13 },
  warning: { fontSize: 12, marginTop: spacing.xs },
  groupTitle: { fontSize: 13, fontWeight: '800', marginBottom: spacing.xs, letterSpacing: 0.3 },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  footnote: { fontSize: 11, lineHeight: 17, marginTop: spacing.sm },
});

const previewStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  label: { fontSize: 13 },
  value: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
```

- [ ] **Step 2: 运行 typecheck**

Run: `npm run typecheck`
Expected: PASS

### Task 4.2: 接线路由

- [ ] **Step 1: 修改 `src/navigation/TabNavigator.tsx`**

a) 在 `SettingsStackParamList`（第 44 行附近）末尾的 `LocalModelManager` 后追加：

```ts
  LocalModelManager: undefined;
  ContextAutoConfig: undefined;
```

b) 在 import 区（第 11 行 `LLMSettingsScreen` 之后或末尾）追加：

```ts
import { ContextAutoConfigScreen } from '../screens/ContextAutoConfigScreen';
```

c) 在 `SettingsStackScreen` 函数（第 108 行）的 `<SettingsStack.Screen name="LocalModelManager" ...>` 之后追加：

```tsx
      <SettingsStack.Screen name="ContextAutoConfig" component={ContextAutoConfigScreen} />
```

- [ ] **Step 2: 修改 `src/screens/SettingsScreen.tsx`**

a) 在 import 区第 3 行（lucide-react-native 那行）末尾加上 `Gauge`（如果没有 `Gauge` 就用 `Sparkles`，避免与已有重复）：

把第 3 行：
```ts
import { Database, Factory, KeyRound, ListChecks, Moon, Palette, Sun, TreePine, BarChart3, Volume2 } from 'lucide-react-native';
```
改为：
```ts
import { Database, Factory, KeyRound, ListChecks, Moon, Palette, Sun, TreePine, BarChart3, Volume2, Gauge } from 'lucide-react-native';
```

b) 在 `<Section title="AI">`（第 66 行）的**第一个 Card 之前**（紧接 `<Section title="AI">` 之后、`<Card>` OpenAI 之前），插入新 Card：

```tsx
          <Card>
            <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>上下文自动化配置</Text>
            <Text style={[styles.cardMeta, { color: theme.colors.textSecondary }]}>填一个数字（如 200K），自动分配滑动窗口、流水线、LLM 配置和资源级 token 预算。</Text>
            <Button label="上下文自动化配置" icon={Gauge} onPress={() => navigation.navigate('ContextAutoConfig')} />
          </Card>
```

- [ ] **Step 3: 运行 typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS（如有 lint 警告，按提示修）

- [ ] **Step 4: Commit**

```bash
git add src/screens/ContextAutoConfigScreen.tsx src/navigation/TabNavigator.tsx src/screens/SettingsScreen.tsx
git commit -m "feat(context-auto): 添加上下文自动化配置屏幕与入口

- 新屏幕：填一个数字 + 实时预览分配方案 + 一键应用 + 恢复默认
- SettingsStack 注册 ContextAutoConfig 路由
- SettingsScreen AI 板块顶部加入口 Card"
```

### Task 4.3: 全量回归 + 手动验收

- [ ] **Step 1: 跑全量 Jest**

Run: `npm run test:ci`
Expected: PASS（无回归）

- [ ] **Step 2: 跑 lint + typecheck + test 三连**

Run: `npm run verify`
Expected: PASS

- [ ] **Step 3: 跑 build**

Run: `npm run prebuild`
Expected: PASS（生成 `src/constants/version.json`）

- [ ] **Step 4: 手动验收（Android 设备/模拟器）**

Run: `npm run android`

验收清单：
- [ ] 设置页 → AI 板块看到"上下文自动化配置"入口
- [ ] 进入新屏幕，看到输入框（默认 200000）+ 实时分配预览
- [ ] 点 128K / 200K / 512K / 1M 快捷按钮，输入框与预览联动
- [ ] 手输入 200000，预览显示滑动窗口 104000 等
- [ ] 点"一键应用"，弹 Alert 确认 → 确认后 Toast 成功 → 显示"上次应用记录"卡片
- [ ] 退出再进屏幕，记录仍在
- [ ] 到 LLM 设置屏，非本地配置的 context_window 显示 200000
- [ ] 到上下文配置屏，slidingWindowSize/resourceBudget/summaryBudgetTokens 已更新
- [ ] 到流水线配置屏，4 阶段 max_tokens 已更新
- [ ] 输入 100，看到"⚠️ 上下文过小"警告，仍可应用
- [ ] 点"恢复默认"，Alert 确认 → ContextConfig/PipelineConfig 回到默认值
- [ ] 重启 App，配置仍生效

- [ ] **Step 5: Commit 回归结果（无需新增代码，仅记录）**

```bash
# 如有 fixup，单独 commit
# 否则跳过
```

---

## Phase 5: 文档 + 版本号 + tag

### Task 5.1: 更新 README + CHANGELOG + progress

- [ ] **Step 1: 读 README.md，找到版本号与功能列表位置**

Run: `grep -n "2.4.5\|2\.4\.5\|V2\.4\.5\|## 功能\|功能列表" README.md`

- [ ] **Step 2: 在 README.md 的功能列表区追加新功能条目**

在合适位置插入：

```md
- **上下文自动化配置**：填一个数字（如 200K），自动按 80/20 比例分配到滑动窗口、流水线、LLM 配置和资源级 token 预算。
```

- [ ] **Step 3: 在 CHANGELOG.md 顶部追加 V2.4.6 条目**

```md
## [V2.4.6] - 2026-07-18

### Added
- 设置板块新增"上下文自动化配置"模块：用户填一个数字（如 200000），系统按内置比例（输入 80% / 输出 20%）自动分配到 ContextConfig、PipelineConfig、llm_config、presets 和资源级 max_tokens 5 处。
- 支持快捷按钮（128K / 200K / 512K / 1M）+ 自由输入 + 实时预览。
- 本地 GGUF 模型的 context_window 不被覆写。

### Changed
- 无 schema 版本变化（保持 14）。
- 不引入新依赖。
```

- [ ] **Step 4: 在 progress/优化文档追加进度记录**

读 `docs/superpowers/specs/Tavo-Mini-Agent-Optimization-Plan.md`，在合适章节追加：

```md
### 2026-07-18：上下文自动化配置上线
- 设置板块新增独立模块，spec：`docs/superpowers/specs/2026-07-18-context-auto-config-design.md`
- 实现：纯函数 + 应用函数 + 新屏幕
- 覆盖 ContextConfig / PipelineConfig / llm_config / presets / 资源级 5 处
```

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md docs/
git commit -m "docs: 上下文自动化配置 V2.4.6 文档更新"
```

### Task 5.2: 升级版本号

- [ ] **Step 1: 改 package.json**

把 `"version": "2.4.5"` 改为 `"version": "2.4.6"`。

- [ ] **Step 2: 跑 prebuild 让 version.json 同步**

Run: `npm run prebuild`
Expected: `src/constants/version.json` 自动更新为 2.4.6。

- [ ] **Step 3: 校验三处版本号一致**

Run: `grep '"2.4.6"' package.json src/constants/version.json`
Expected: 至少 2 行命中

确认 `version.json` 内：
```json
{
  "version": "2.4.6",
  "versionName": "V2.4.6",
  "versionCode": <递增>,
  "releaseTitle": "..."
}
```

如果 `versionCode` 没自动递增，手动 +1（参考上一版）。

- [ ] **Step 4: Commit**

```bash
git add package.json src/constants/version.json
git commit -m "chore(release): prepare V2.4.6

- 上下文自动化配置（设置板块新模块）
- 不修改 schema 版本"
```

### Task 5.3: 创建 tag + push

- [ ] **Step 1: 创建 annotated tag**

```bash
git tag -a V2.4.6 -m "V2.4.6：上下文自动化配置

设置板块新增上下文自动化配置模块，用户填一个数字即可
自动分配 token 预算到 5 处现有配置。

详见 CHANGELOG.md。"
```

- [ ] **Step 2: 推送 commit + tag 到 main**

```bash
git push origin main
git push origin V2.4.6
```

Expected: 推送成功

- [ ] **Step 3: 验证远端**

Run: `git ls-remote --heads --tags origin | grep V2.4.6`
Expected: 命中 V2.4.6 tag

---

## Self-Review Checklist

### Spec coverage
- [x] §3 分配算法 → Task 1.1
- [x] §4.1-4.3 settings key + record → Task 2.1
- [x] §4.4 应用函数（事务） → Task 3.1
- [x] §4.5 不新增 repository 方法 → 已落实（直接构建 SQL）
- [x] §5 UI → Task 4.1
- [x] §6 错误处理 → Task 1.1 (validate) + Task 3.1 (transaction) + Task 4.1 (Alert/Toast)
- [x] §7.1 单测 → Task 1.2 + Task 2.2 + Task 3.2
- [x] §7.2 集成测试 → Task 3.2
- [x] §8 实现路径 → 全部 Task
- [x] §9 验收标准 → Task 4.3 + Task 5.x

### Placeholder scan
- [x] 无 TBD/TODO
- [x] 无"add appropriate error handling"
- [x] 所有代码块完整可用

### Type consistency
- [x] `ResourceCounts` / `AllocationResult` / `ContextAutoAppliedRecord` 在所有 Task 一致
- [x] `allocateContextBudget(maxContextTokens, resourceCounts)` 签名一致
- [x] `applyContextAutoAllocation(maxContextTokens)` 返回 `ContextAutoAppliedRecord`
- [x] settings key 名一致：`context_auto_input` / `context_auto_last_applied`
- [x] PipelineConfig key 名一致：`pipeline_*_max_tokens`（与 pipelineTaskRepository.ts 一致）
- [x] ContextConfig key 名一致：`sliding_window_size` / `resource_budget` / `summary_budget_tokens`（与 settingsRepository.ts 一致）

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-18-context-auto-config.md`.

**用户已授权**：自审完直接动工，每完成一个 phase review 一次，全部完成后全量回归 → 更新 README/CHANGELOG/版本号/tag/push。

/**
 * Outline context builder unit tests (大纲创作模式升级, 阶段 5).
 *
 * Tests the pure stitching / budget / fingerprint logic of buildOutlineContext
 * without touching the database: the outline repository is mocked so the tests
 * verify ordering, blocking, non-truncation and mode-gating in isolation.
 */
jest.mock('../src/data/repositories/outlineRepository', () => ({
  getEnabledOutlinesByProject: jest.fn(async () => [] as any[]),
}));

import {
  buildOutlineContext,
  computeOutlineFingerprint,
  computeOutlineBudgetGuidance,
  deriveOutlineBudgetTokens,
  EMPTY_OUTLINE_CONTEXT,
} from '../src/services/outlineContextBuilder';
import { getEnabledOutlinesByProject } from '../src/data/repositories/outlineRepository';
import type { Outline } from '../src/types/outline';

const mockedGetEnabled = getEnabledOutlinesByProject as jest.MockedFunction<
  typeof getEnabledOutlinesByProject
>;

function makeOutline(overrides: Partial<Outline> = {}): Outline {
  return {
    id: 1,
    projectId: 1,
    title: '主线',
    content: '主角踏上旅程。',
    sourceType: 'manual',
    enabled: true,
    position: 0,
    estimatedTokens: 10,
    contentHash: 'aaa',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  mockedGetEnabled.mockReset();
});

describe('buildOutlineContext mode gating', () => {
  test('non-outline modes return empty context (continuation)', async () => {
    const result = await buildOutlineContext({
      projectId: 1,
      projectMode: 'continuation',
      outlineBudgetTokens: 10000,
    });
    expect(result).toBe(EMPTY_OUTLINE_CONTEXT);
    expect(result.text).toBe('');
    expect(mockedGetEnabled).not.toHaveBeenCalled();
  });

  test('non-outline modes return empty context (freeform)', async () => {
    const result = await buildOutlineContext({
      projectId: 1,
      projectMode: 'freeform',
      outlineBudgetTokens: 10000,
    });
    expect(result).toBe(EMPTY_OUTLINE_CONTEXT);
  });

  test('outline mode with no enabled outlines returns empty context', async () => {
    mockedGetEnabled.mockResolvedValue([]);
    const result = await buildOutlineContext({
      projectId: 1,
      projectMode: 'outline',
      outlineBudgetTokens: 10000,
    });
    expect(result).toBe(EMPTY_OUTLINE_CONTEXT);
  });
});

describe('buildOutlineContext stitching', () => {
  test('only enabled outlines are stitched (disabled ones excluded)', async () => {
    // The repository function already filters by enabled; we simulate that.
    mockedGetEnabled.mockResolvedValue([
      makeOutline({ id: 1, position: 0, content: '大纲 A 内容', contentHash: 'a' }),
    ]);
    const result = await buildOutlineContext({
      projectId: 1,
      projectMode: 'outline',
      outlineBudgetTokens: 100000,
    });
    expect(result.enabledCount).toBe(1);
    expect(result.outlineIds).toEqual([1]);
    expect(result.text).toContain('大纲 A 内容');
    expect(result.text).toContain('项目大纲');
    expect(result.complete).toBe(true);
  });

  test('outlines are stitched in deterministic position order', async () => {
    // Repository returns in position order; verify the stitch preserves it.
    mockedGetEnabled.mockResolvedValue([
      makeOutline({ id: 10, position: 0, title: '高优先级', content: '靠前', contentHash: 'h' }),
      makeOutline({ id: 20, position: 1, title: '补充', content: '靠后', contentHash: 'l' }),
    ]);
    const result = await buildOutlineContext({
      projectId: 1,
      projectMode: 'outline',
      outlineBudgetTokens: 100000,
    });
    const highIdx = result.text.indexOf('靠前');
    const lowIdx = result.text.indexOf('靠后');
    expect(highIdx).toBeGreaterThan(-1);
    expect(lowIdx).toBeGreaterThan(-1);
    expect(highIdx).toBeLessThan(lowIdx); // higher-priority first
    expect(result.outlineIds).toEqual([10, 20]);
  });

  test('first outline labeled as highest priority, rest as supplementary', async () => {
    mockedGetEnabled.mockResolvedValue([
      makeOutline({ id: 1, position: 0, content: 'A', contentHash: 'a' }),
      makeOutline({ id: 2, position: 1, content: 'B', contentHash: 'b' }),
    ]);
    const result = await buildOutlineContext({
      projectId: 1,
      projectMode: 'outline',
      outlineBudgetTokens: 100000,
    });
    expect(result.text).toContain('最高优先级');
    expect(result.text).toContain('补充约束');
  });

  test('contract rules are included in the stitched text', async () => {
    mockedGetEnabled.mockResolvedValue([makeOutline()]);
    const result = await buildOutlineContext({
      projectId: 1,
      projectMode: 'outline',
      outlineBudgetTokens: 100000,
    });
    expect(result.text).toContain('大纲约束规则');
    expect(result.text).toContain('已写成的历史事实不可回滚');
  });
});

describe('buildOutlineContext strict budget (no truncation)', () => {
  test('blocks when outline exceeds budget instead of truncating', async () => {
    // A very long outline that exceeds the budget.
    const longContent = '主角'.repeat(2000); // ~4000 tokens
    mockedGetEnabled.mockResolvedValue([
      makeOutline({ content: longContent, contentHash: 'long' }),
    ]);
    const result = await buildOutlineContext({
      projectId: 1,
      projectMode: 'outline',
      outlineBudgetTokens: 100, // tiny budget
    });
    expect(result.complete).toBe(false);
    expect(result.blockingReason).toBeTruthy();
    expect(result.blockingReason).toContain('tokens');
    // The full text is still present (NOT truncated) so preview can show it.
    expect(result.text).toContain(longContent);
  });

  test('does not block when outline fits budget', async () => {
    mockedGetEnabled.mockResolvedValue([
      makeOutline({ content: '短大纲', contentHash: 's' }),
    ]);
    const result = await buildOutlineContext({
      projectId: 1,
      projectMode: 'outline',
      outlineBudgetTokens: 100000,
    });
    expect(result.complete).toBe(true);
    expect(result.blockingReason).toBeUndefined();
  });

  test('blocking reason reports enabled count and token gap', async () => {
    // CJK content so each char is 1 token — predictable large token counts.
    mockedGetEnabled.mockResolvedValue([
      makeOutline({ id: 1, content: '一二三四五六七八九十'.repeat(20), contentHash: 'x' }),
      makeOutline({ id: 2, content: '一二三四五六七八九十'.repeat(20), contentHash: 'y' }),
    ]);
    const result = await buildOutlineContext({
      projectId: 1,
      projectMode: 'outline',
      outlineBudgetTokens: 50,
    });
    expect(result.complete).toBe(false);
    expect(result.blockingReason).toContain('2');
    // Segmented-enablement hint: tells the user to disable low-priority outlines.
    expect(result.blockingReason).toContain('分段启用');
    expect(result.blockingReason).toContain('资料 - 大纲');
  });

  test('perOutlineTokens populated in stitch order', async () => {
    // CJK content so the estimator counts more chars as more tokens.
    mockedGetEnabled.mockResolvedValue([
      makeOutline({ id: 1, position: 0, content: '一二三', contentHash: 'a' }),
      makeOutline({ id: 2, position: 1, content: '一二三四五六七八九十', contentHash: 'b' }),
    ]);
    const result = await buildOutlineContext({
      projectId: 1,
      projectMode: 'outline',
      outlineBudgetTokens: 100000,
    });
    expect(result.perOutlineTokens).toHaveLength(2);
    // Second outline has more CJK chars → more tokens.
    expect(result.perOutlineTokens[1]).toBeGreaterThan(result.perOutlineTokens[0]);
  });

  test('outlineBudgetTokens echoed back in result', async () => {
    mockedGetEnabled.mockResolvedValue([makeOutline()]);
    const result = await buildOutlineContext({
      projectId: 1,
      projectMode: 'outline',
      outlineBudgetTokens: 12345,
    });
    expect(result.outlineBudgetTokens).toBe(12345);
  });

  test('zero budget disables the check (no false block)', async () => {
    mockedGetEnabled.mockResolvedValue([makeOutline()]);
    const result = await buildOutlineContext({
      projectId: 1,
      projectMode: 'outline',
      outlineBudgetTokens: 0,
    });
    // Budget 0 means "no LLM config available" → skip check, still inject.
    expect(result.complete).toBe(true);
  });
});

describe('outline fingerprint stability', () => {
  test('fingerprint is stable for identical outlines', () => {
    const versions = [
      { id: 1, updatedAt: 100, hash: 'a', position: 0 },
      { id: 2, updatedAt: 200, hash: 'b', position: 1 },
    ];
    expect(computeOutlineFingerprint(versions)).toBe(
      computeOutlineFingerprint(versions),
    );
  });

  test('fingerprint changes when content changes', () => {
    const v1 = [{ id: 1, updatedAt: 100, hash: 'a', position: 0 }];
    const v2 = [{ id: 1, updatedAt: 100, hash: 'changed', position: 0 }];
    expect(computeOutlineFingerprint(v1)).not.toBe(computeOutlineFingerprint(v2));
  });

  test('fingerprint changes when order changes', () => {
    const v1 = [
      { id: 1, updatedAt: 100, hash: 'a', position: 0 },
      { id: 2, updatedAt: 200, hash: 'b', position: 1 },
    ];
    const v2 = [
      { id: 1, updatedAt: 100, hash: 'a', position: 1 },
      { id: 2, updatedAt: 200, hash: 'b', position: 0 },
    ];
    expect(computeOutlineFingerprint(v1)).not.toBe(computeOutlineFingerprint(v2));
  });

  test('fingerprint changes when an outline is added/removed', () => {
    const one = [{ id: 1, updatedAt: 100, hash: 'a', position: 0 }];
    const two = [
      { id: 1, updatedAt: 100, hash: 'a', position: 0 },
      { id: 2, updatedAt: 200, hash: 'b', position: 1 },
    ];
    expect(computeOutlineFingerprint(one)).not.toBe(computeOutlineFingerprint(two));
  });

  test('empty fingerprint for no outlines', () => {
    expect(computeOutlineFingerprint([])).toBe('');
  });
});

describe('deriveOutlineBudgetTokens', () => {
  test('returns 30% of context window', () => {
    expect(deriveOutlineBudgetTokens(100000)).toBe(30000);
    expect(deriveOutlineBudgetTokens(8000)).toBe(2400);
  });

  test('returns 0 for invalid context window', () => {
    expect(deriveOutlineBudgetTokens(0)).toBe(0);
    expect(deriveOutlineBudgetTokens(-1)).toBe(0);
    expect(deriveOutlineBudgetTokens(NaN)).toBe(0);
  });
});

describe('computeOutlineBudgetGuidance (segmented enablement)', () => {
  test('not over budget when total <= budget', () => {
    const g = computeOutlineBudgetGuidance([100, 200], [1, 2], 1000);
    expect(g.overBudget).toBe(false);
    expect(g.overageTokens).toBe(0);
    expect(g.totalTokens).toBe(300);
    expect(g.suggestedDisableIds).toEqual([]);
  });

  test('over budget and suggests disabling lowest-priority (tail) outlines', () => {
    // ids [1,2,3], tokens [100,200,300], budget 350. Total 600 > 350.
    // Drop tail: disable id=3 (300) → remaining 300 <= 350 → fits.
    const g = computeOutlineBudgetGuidance([100, 200, 300], [1, 2, 3], 350);
    expect(g.overBudget).toBe(true);
    expect(g.overageTokens).toBe(250);
    expect(g.suggestedDisableIds).toEqual([3]);
  });

  test('disables multiple tail outlines until prefix fits', () => {
    // ids [1,2,3], tokens [400,200,300], budget 350. Total 900 > 350.
    // Drop id=3 (300) → 600 > 350; drop id=2 (200) → 400 > 350; drop none more
    // because id=1 alone (400) still > 350, but we already dropped the tail.
    // Greedy stops once running <= budget OR list exhausted. After dropping 3
    // and 2, running = 400 > 350, loop continues to drop id=1 → running=0.
    const g = computeOutlineBudgetGuidance([400, 200, 300], [1, 2, 3], 350);
    expect(g.overBudget).toBe(true);
    // Even disabling all cannot fit (400 alone > 350) → suggests all.
    expect(g.suggestedDisableIds.sort()).toEqual([1, 2, 3]);
  });

  test('suggests the right set when disabling two is enough', () => {
    // ids [1,2,3], tokens [100,300,300], budget 350. Total 700 > 350.
    // Drop id=3 (300) → 400 > 350; drop id=2 (300) → 100 <= 350 → fits.
    const g = computeOutlineBudgetGuidance([100, 300, 300], [1, 2, 3], 350);
    expect(g.overBudget).toBe(true);
    expect(g.suggestedDisableIds.sort()).toEqual([2, 3]);
  });

  test('unknown budget (0) never reports overage', () => {
    const g = computeOutlineBudgetGuidance([99999], [1], 0);
    expect(g.overBudget).toBe(false);
    expect(g.overageTokens).toBe(0);
    expect(g.suggestedDisableIds).toEqual([]);
  });

  test('exactly at budget is not over', () => {
    const g = computeOutlineBudgetGuidance([300], [1], 300);
    expect(g.overBudget).toBe(false);
    expect(g.suggestedDisableIds).toEqual([]);
  });

  test('empty outline list never over', () => {
    const g = computeOutlineBudgetGuidance([], [], 1000);
    expect(g.overBudget).toBe(false);
    expect(g.totalTokens).toBe(0);
    expect(g.suggestedDisableIds).toEqual([]);
  });

  test('suggested order matches stitch priority (disable last first)', () => {
    // ids [1,2,3,4], tokens [50,50,50,300], budget 200. Total 450 > 200.
    // Drop id=4 (300) → 150 <= 200 → fits. Only id=4 suggested.
    const g = computeOutlineBudgetGuidance([50, 50, 50, 300], [1, 2, 3, 4], 200);
    expect(g.suggestedDisableIds).toEqual([4]);
  });
});

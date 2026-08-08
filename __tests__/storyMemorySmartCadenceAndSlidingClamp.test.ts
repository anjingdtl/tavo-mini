/**
 * P2/P3 最终收口冒烟/回归。
 *
 * P2（Smart 默认10章节奏）：
 * - 1～9 章普通 token 累计不得成为常规提前触发理由；
 * - 第 10 章 → interval_reached；
 * - 安全事件（dirty / coverage gap / manual / key chapter）继续允许提前。
 *
 * P3（Sliding raw <= 10 非法值防御）：
 * - 无论 recentChapterCount 传入什么（100 / NaN / Infinity / -Infinity /
 *   0 / -5 / undefined），strategy=sliding 时 raw candidate count <= 10；
 * - 非法配置不得退化成「全部历史」；
 * - full / custom 语义不受影响。
 */
import type { Chapter } from '../src/types/novel';
import {
  createDefaultStoryMemoryPolicy,
  evaluateStoryMemoryDue,
} from '../src/services/storyMemory/storyMemoryPolicy';

const mockGetChapters = jest.fn();
const mockGetMemory = jest.fn();
const mockEnsure = jest.fn();

jest.mock('../src/services/database', () => ({
  getChaptersByProject: (...args: unknown[]) => mockGetChapters(...args),
  getProjectStoryMemory: (...args: unknown[]) => mockGetMemory(...args),
  ensureProjectStoryMemoryRow: (...args: unknown[]) => mockEnsure(...args),
  getCharactersByProject: jest.fn(async () => []),
  getWorldbookEntriesByProject: jest.fn(async () => []),
  getNotesByProject: jest.fn(async () => []),
  getNotesContentByIds: jest.fn(async () => ({})),
  getProjectNoteConfig: jest.fn(async () => null),
}));

jest.mock('../src/services/macroReplace', () => ({
  processMacros: jest.fn(async (text: string) => text),
}));

import { selectPreviousChapters } from '../src/services/contextBuilder';

function chapter(
  position: number,
  options: { content?: string; id?: number } = {},
): Chapter {
  return {
    id: options.id ?? position + 1,
    project_id: 1,
    position,
    title: `第 ${position + 1} 章`,
    synopsis: '',
    content: options.content ?? `第 ${position + 1} 章正文。`,
    memory_summary: '',
    status: 'final',
    summary_json: null,
    created_at: '',
    updated_at: '',
  };
}

function longChapter(position: number): Chapter {
  return chapter(position, {
    content: '这是一段用于撑大 token 估算的章节正文。'.repeat(120),
  });
}

describe('P2: smart mode 10-chapter cadence', () => {
  const policy = createDefaultStoryMemoryPolicy(1); // smart, interval 10

  it('S1: 9 chapters with short content → not due', () => {
    const pending = Array.from({ length: 9 }, (_, i) => chapter(i));
    const decision = evaluateStoryMemoryDue({
      policy,
      checkpointThroughPosition: -1,
      pendingChapters: pending,
    });
    expect(decision.due).toBe(false);
  });

  it('S2: 9 chapters with very long content → records actual decision', () => {
    const pending = Array.from({ length: 9 }, (_, i) => longChapter(i));
    const decision = evaluateStoryMemoryDue({
      policy,
      checkpointThroughPosition: -1,
      pendingChapters: pending,
    });
    // 产品目标：普通高 token 章节在第 10 章前不触发
    expect(decision.due).toBe(false);
    expect(decision.reason).toBe('none');
  });

  it('S3: 10 chapters → due with interval_reached', () => {
    const pending = Array.from({ length: 10 }, (_, i) => chapter(i));
    const decision = evaluateStoryMemoryDue({
      policy,
      checkpointThroughPosition: -1,
      pendingChapters: pending,
    });
    expect(decision.due).toBe(true);
    expect(decision.hard).toBe(false);
    expect(decision.reason).toBe('interval_reached');
  });

  it('S4: <10 chapters + hardDue → early', () => {
    const pending = Array.from({ length: 5 }, (_, i) => chapter(i));
    const decision = evaluateStoryMemoryDue({
      policy,
      checkpointThroughPosition: -1,
      pendingChapters: pending,
      hardDue: true,
    });
    expect(decision.due).toBe(true);
    expect(decision.hard).toBe(true);
    expect(decision.reason).toBe('coverage_gap');
  });

  it('S5: <10 chapters + dirty → early', () => {
    const pending = Array.from({ length: 5 }, (_, i) => chapter(i));
    const decision = evaluateStoryMemoryDue({
      policy,
      checkpointThroughPosition: -1,
      pendingChapters: pending,
      dirty: true,
    });
    expect(decision.due).toBe(true);
    expect(decision.hard).toBe(true);
    expect(decision.reason).toBe('dirty_rebuild');
  });

  it('S6: manualRequested → executes on request', () => {
    const pending = Array.from({ length: 5 }, (_, i) => chapter(i));
    const decision = evaluateStoryMemoryDue({
      policy,
      checkpointThroughPosition: -1,
      pendingChapters: pending,
      manualRequested: true,
    });
    expect(decision.due).toBe(true);
    expect(decision.reason).toBe('manual');
  });

  it('S7: key chapter below interval still triggers (design preserved)', () => {
    const pending = Array.from({ length: 2 }, (_, i) => chapter(i));
    const decision = evaluateStoryMemoryDue({
      policy,
      checkpointThroughPosition: -1,
      pendingChapters: pending,
      isKeyChapter: true,
    });
    expect(decision.due).toBe(true);
    expect(decision.reason).toBe('key_chapter');
  });

  it('S8: fixed mode is interval-driven only, unaffected by tokens', () => {
    const fixedPolicy = createDefaultStoryMemoryPolicy(1, {
      mode: 'fixed',
      intervalChapters: 10,
    });
    const pending = Array.from({ length: 9 }, (_, i) => longChapter(i));
    const decision = evaluateStoryMemoryDue({
      policy: fixedPolicy,
      checkpointThroughPosition: -1,
      pendingChapters: pending,
    });
    expect(decision.due).toBe(false);
    const ten = Array.from({ length: 10 }, (_, i) => chapter(i));
    expect(
      evaluateStoryMemoryDue({
        policy: fixedPolicy,
        checkpointThroughPosition: -1,
        pendingChapters: ten,
      }).reason,
    ).toBe('interval_reached');
  });
});

describe('P3: sliding raw candidate hard cap at 10', () => {
  function selectWith(recentChapterCount: unknown): Chapter[] {
    const chapters = Array.from({ length: 100 }, (_, i) =>
      chapter(i, { content: `第 ${i + 1} 章正文。` }),
    );
    const current = chapter(100, { content: '当前章' });
    return selectPreviousChapters(
      current,
      {
        strategy: 'sliding',
        recentChapterCount: recentChapterCount as number,
        slidingWindowSize: 1_000_000,
      },
      chapters,
    );
  }

  it('T100: recentChapterCount=100 clamps to 10', () => {
    expect(selectWith(100)).toHaveLength(10);
  });

  it('TNaN: NaN never degrades to all history', () => {
    const selected = selectWith(Number.NaN);
    expect(selected.length).toBeLessThanOrEqual(10);
    expect(selected.length).toBeGreaterThan(0);
  });

  it('TInf: Infinity clamps to 10', () => {
    expect(selectWith(Number.POSITIVE_INFINITY)).toHaveLength(10);
  });

  it('TNegInf: -Infinity clamps to 1..10', () => {
    const selected = selectWith(Number.NEGATIVE_INFINITY);
    expect(selected.length).toBeGreaterThanOrEqual(1);
    expect(selected.length).toBeLessThanOrEqual(10);
  });

  it('T0: 0 clamps to 1', () => {
    expect(selectWith(0)).toHaveLength(1);
  });

  it('TNeg: -5 clamps to 1', () => {
    expect(selectWith(-5)).toHaveLength(1);
  });

  it('TUndef: undefined uses default and stays <= 10', () => {
    const selected = selectWith(undefined);
    expect(selected.length).toBeGreaterThanOrEqual(1);
    expect(selected.length).toBeLessThanOrEqual(10);
  });

  it('T1: recentChapterCount=1 keeps exactly 1 chapter', () => {
    expect(selectWith(1)).toHaveLength(1);
  });

  it('T10: recentChapterCount=10 keeps exactly 10 chapters', () => {
    expect(selectWith(10)).toHaveLength(10);
  });

  it('TStr: persisted garbage string clamps to 10, never all history', () => {
    const selected = selectWith('garbage' as unknown as number);
    expect(selected.length).toBeGreaterThanOrEqual(1);
    expect(selected.length).toBeLessThanOrEqual(10);
    const zero = selectWith('0' as unknown as number);
    expect(zero).toHaveLength(1);
  });

  it('full/custom strategies are unaffected by the sliding clamp', () => {
    const chapters = Array.from({ length: 30 }, (_, i) =>
      chapter(i, { content: `第 ${i + 1} 章正文。` }),
    );
    const current = chapter(30, { content: '当前章' });
    const full = selectPreviousChapters(
      current,
      { strategy: 'full', recentChapterCount: 100 },
      chapters,
    );
    expect(full).toHaveLength(30);
    const custom = selectPreviousChapters(
      current,
      { strategy: 'custom', customRangeStart: 5, customRangeEnd: 9 },
      chapters,
    );
    expect(custom.map(c => c.position)).toEqual([5, 6, 7, 8, 9]);
  });
});

import type { Chapter } from '../src/types/novel';
import {
  clampIntervalChapters,
  createDefaultStoryMemoryPolicy,
  evaluateStoryMemoryDue,
  listPendingChapters,
  normalizeStoryMemoryMode,
  predictNextCheckpointPosition,
  splitCheckpointBatches,
} from '../src/services/storyMemory/storyMemoryPolicy';

function chapter(
  position: number,
  content = '正文内容足够长用来估算 token。'.repeat(3),
): Chapter {
  return {
    id: position + 1,
    project_id: 1,
    position,
    title: `第 ${position + 1} 章`,
    synopsis: '',
    content,
    status: 'final',
    summary_json: null,
    created_at: '',
    updated_at: '',
  };
}

describe('storyMemoryPolicy', () => {
  it('clamps interval to 2～10 and defaults invalid values', () => {
    expect(clampIntervalChapters(0)).toBe(2);
    expect(clampIntervalChapters(-3)).toBe(2);
    expect(clampIntervalChapters(3)).toBe(3);
    expect(clampIntervalChapters(99)).toBe(10);
    expect(clampIntervalChapters(Number.NaN)).toBe(10);
    expect(normalizeStoryMemoryMode('nope')).toBe('smart');
    expect(normalizeStoryMemoryMode('fixed')).toBe('fixed');
  });

  it('lists pending chapters with holes and optional upper bound', () => {
    const chapters = [chapter(0), chapter(2), chapter(4), chapter(5)];
    expect(listPendingChapters(chapters, 0).map(c => c.position)).toEqual([
      2, 4, 5,
    ]);
    expect(listPendingChapters(chapters, 0, 5).map(c => c.position)).toEqual([
      2, 4,
    ]);
  });

  it('splits batches by preferred size (default 3), capped at 10', () => {
    const chapters = Array.from({ length: 11 }, (_, i) => chapter(i));
    const byDefault = splitCheckpointBatches(chapters);
    expect(byDefault).toHaveLength(4); // 3+3+3+2
    expect(byDefault[0]).toHaveLength(3);
    expect(byDefault[3]).toHaveLength(2);

    const byTen = splitCheckpointBatches(chapters, 10);
    expect(byTen).toHaveLength(2);
    expect(byTen[0]).toHaveLength(10);
    expect(byTen[1]).toHaveLength(1);
  });

  it('evaluates four modes and hard/dirty reasons', () => {
    const policy = createDefaultStoryMemoryPolicy(1, {
      mode: 'smart',
      intervalChapters: 3,
    });
    const pending = [chapter(0), chapter(1)];
    expect(evaluateStoryMemoryDue({ policy, checkpointThroughPosition: -1, pendingChapters: pending }).due).toBe(false);

    const three = [chapter(0), chapter(1), chapter(2)];
    const due = evaluateStoryMemoryDue({
      policy,
      checkpointThroughPosition: -1,
      pendingChapters: three,
    });
    expect(due).toEqual(
      expect.objectContaining({
        due: true,
        hard: false,
        reason: 'interval_reached',
        fromPosition: 0,
        throughPosition: 2,
      }),
    );

    expect(
      evaluateStoryMemoryDue({
        policy: createDefaultStoryMemoryPolicy(1, { mode: 'every_chapter' }),
        checkpointThroughPosition: -1,
        pendingChapters: [chapter(0)],
      }).due,
    ).toBe(true);

    expect(
      evaluateStoryMemoryDue({
        policy: createDefaultStoryMemoryPolicy(1, { mode: 'manual' }),
        checkpointThroughPosition: -1,
        pendingChapters: three,
      }).due,
    ).toBe(false);

    expect(
      evaluateStoryMemoryDue({
        policy: createDefaultStoryMemoryPolicy(1, { mode: 'manual' }),
        checkpointThroughPosition: -1,
        pendingChapters: three,
        hardDue: true,
      }),
    ).toEqual(expect.objectContaining({ due: true, hard: true, reason: 'coverage_gap' }));

    expect(
      evaluateStoryMemoryDue({
        policy,
        checkpointThroughPosition: -1,
        pendingChapters: three,
        dirty: true,
      }).reason,
    ).toBe('dirty_rebuild');

    expect(
      evaluateStoryMemoryDue({
        policy: createDefaultStoryMemoryPolicy(1, {
          mode: 'smart',
          updateOnKeyChapter: true,
        }),
        checkpointThroughPosition: -1,
        pendingChapters: [chapter(0)],
        isKeyChapter: true,
      }).reason,
    ).toBe('key_chapter');
  });

  it('smart mode below the interval never triggers on token volume alone', () => {
    const long = chapter(0, '很长的章节正文。'.repeat(400));
    const policy = createDefaultStoryMemoryPolicy(1, {
      mode: 'smart',
      intervalChapters: 3,
      pendingTokenSoftLimit: 50,
    });
    const decision = evaluateStoryMemoryDue({
      policy,
      checkpointThroughPosition: -1,
      pendingChapters: [long],
    });
    // 产品节奏：1..interval-1 章由 interval 主导，token 累计不提前触发；
    // 安全事件（dirty / coverage gap / manual / key chapter）仍可提前。
    expect(decision.due).toBe(false);
    expect(decision.reason).toBe('none');
  });

  it('predicts next checkpoint chapter position', () => {
    const policy = createDefaultStoryMemoryPolicy(1, {
      mode: 'smart',
      intervalChapters: 3,
    });
    // through=-1, pending=2 → next due after chapter index 2 (第3章)
    expect(predictNextCheckpointPosition(policy, -1, 2)).toBe(3);
    expect(
      predictNextCheckpointPosition(
        createDefaultStoryMemoryPolicy(1, { mode: 'manual' }),
        5,
        2,
      ),
    ).toBeNull();
  });
});

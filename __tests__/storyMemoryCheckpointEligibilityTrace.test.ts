/**
 * V2.5.14 — Checkpoint eligibility observability tests.
 *
 * The V2.5.13 fix already preserved "no future injection" but lost the reason
 * (dirty / future / invalid all collapsed to a generic "尚无检查点" in trace).
 * V2.5.14 extends `CheckpointEligibilityResult` and `PrepareStoryMemoryResult`
 * to carry the eligibility reason + original status + through/target so trace
 * can explain WHY a checkpoint was not injected, WITHOUT re-reading the DB.
 *
 * Required coverage (spec §7.2):
 *   - eligibility reason full matrix (missing / not_clean / empty_state /
 *     future_or_same_position / invalid_position / usable)
 *   - originalThroughPosition + targetChapterPosition + originalStatus
 *   - trace copy accurate for each reason
 *   - future / same-position no longer show as plain "missing"
 *   - single buildContext() still reads checkpoint once
 *   - preview does not call LLM
 *   - future checkpoint not injected, not entity-weighted
 */

import type { Chapter } from '../src/types/novel';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import {
  resolveUsableCheckpointForTarget,
} from '../src/services/storyMemory/storyMemoryCheckpointEligibility';
import {
  describeCheckpointEligibility,
  renderPreparedStoryMemoryContext,
} from '../src/services/contextBuilder';
import type { ProjectStoryMemoryRecord } from '../src/data/repositories/storyMemoryRepository';

function record(
  status: ProjectStoryMemoryRecord['status'],
  through: number,
): ProjectStoryMemoryRecord {
  const state = createEmptyStoryMemory(1);
  state.throughChapterPosition = through;
  state.throughChapterId = through >= 0 ? through + 1 : null;
  return {
    state,
    status,
    dirtyFromPosition: status === 'dirty' ? 0 : null,
    lastError: status === 'failed' ? 'rebuild error' : '',
    updatedAt: '',
  };
}

describe('resolveUsableCheckpointForTarget — V2.5.14 enriched fields', () => {
  it('missing: originalStatus=null, originalThrough=-1, target captured', () => {
    const result = resolveUsableCheckpointForTarget(null, 5);
    expect(result.reason).toBe('missing');
    expect(result.usable).toBe(false);
    expect(result.originalStatus).toBeNull();
    expect(result.originalThroughPosition).toBe(-1);
    expect(result.targetChapterPosition).toBe(5);
    expect(result.checkpointThroughPosition).toBe(-1);
  });

  it('usable: originalStatus=clean, through=target through', () => {
    const cp = record('clean', 2);
    const result = resolveUsableCheckpointForTarget(cp, 5);
    expect(result.reason).toBe('usable');
    expect(result.usable).toBe(true);
    expect(result.originalStatus).toBe('clean');
    expect(result.originalThroughPosition).toBe(2);
    expect(result.targetChapterPosition).toBe(5);
    expect(result.checkpointThroughPosition).toBe(2);
  });

  it('dirty: originalStatus=dirty preserved for trace diagnostics', () => {
    const cp = record('dirty', 2);
    const result = resolveUsableCheckpointForTarget(cp, 5);
    expect(result.reason).toBe('not_clean');
    expect(result.originalStatus).toBe('dirty');
    expect(result.originalThroughPosition).toBe(2);
    expect(result.checkpointThroughPosition).toBe(-1);
  });

  it('empty/failed/rebuilding all preserve originalStatus', () => {
    for (const status of ['empty', 'failed', 'rebuilding'] as const) {
      const cp = record(status, 2);
      const result = resolveUsableCheckpointForTarget(cp, 5);
      expect(result.reason).toBe('not_clean');
      expect(result.originalStatus).toBe(status);
    }
  });

  it('future: through >= target preserves both through and target', () => {
    const cp = record('clean', 8);
    const result = resolveUsableCheckpointForTarget(cp, 5);
    expect(result.reason).toBe('future_or_same_position');
    expect(result.originalThroughPosition).toBe(8);
    expect(result.targetChapterPosition).toBe(5);
    expect(result.checkpointThroughPosition).toBe(-1);
  });

  it('same-position (through === target) is future_or_same_position', () => {
    const cp = record('clean', 5);
    const result = resolveUsableCheckpointForTarget(cp, 5);
    expect(result.reason).toBe('future_or_same_position');
    expect(result.originalThroughPosition).toBe(5);
    expect(result.targetChapterPosition).toBe(5);
  });

  it('invalid negative through position: reason=invalid_position', () => {
    const cp = record('clean', -1);
    const result = resolveUsableCheckpointForTarget(cp, 5);
    expect(result.reason).toBe('invalid_position');
    expect(result.originalThroughPosition).toBe(-1);
    expect(result.originalStatus).toBe('clean');
  });

  it('invalid non-integer through position: reason=invalid_position', () => {
    const cp = record('clean', 2);
    // Simulate a corrupted state with a non-integer through.
    (cp.state as any).throughChapterPosition = 2.5;
    const result = resolveUsableCheckpointForTarget(cp, 5);
    expect(result.reason).toBe('invalid_position');
    expect(result.originalThroughPosition).toBe(-1);
  });

  it('empty state object: reason=empty_state', () => {
    const cp = record('clean', 2);
    (cp as any).state = null;
    const result = resolveUsableCheckpointForTarget(cp, 5);
    expect(result.reason).toBe('empty_state');
    expect(result.originalStatus).toBe('clean');
  });

  it('non-finite target: reason=invalid_position, target=NaN', () => {
    const cp = record('clean', 2);
    const result = resolveUsableCheckpointForTarget(cp, Number.NaN);
    expect(result.reason).toBe('invalid_position');
    expect(Number.isNaN(result.targetChapterPosition)).toBe(true);
    expect(result.originalThroughPosition).toBe(2);
  });
});

describe('describeCheckpointEligibility — trace copy matrix', () => {
  const cases: Array<{
    name: string;
    status: ProjectStoryMemoryRecord['status'] | 'missing';
    through: number;
    target: number;
    expectContains: string[];
    mustNotContain?: string[];
  }> = [
    {
      name: 'missing',
      status: 'missing',
      through: 0,
      target: 5,
      expectContains: ['当前项目尚无可用故事记忆检查点'],
    },
    {
      name: 'usable',
      status: 'clean',
      through: 2,
      target: 5,
      // Position 2 → user-facing 第 3 章
      expectContains: ['检查点截至第 3 章'],
    },
    {
      name: 'dirty',
      status: 'dirty',
      through: 2,
      target: 5,
      expectContains: ['不可用', 'dirty'],
    },
    {
      name: 'failed',
      status: 'failed',
      through: 2,
      target: 5,
      expectContains: ['不可用', 'failed'],
    },
    {
      name: 'rebuilding',
      status: 'rebuilding',
      through: 2,
      target: 5,
      expectContains: ['不可用', 'rebuilding'],
    },
    {
      name: 'empty status',
      status: 'empty',
      through: 2,
      target: 5,
      expectContains: ['不可用', 'empty'],
    },
    {
      name: 'future (through>target)',
      status: 'clean',
      through: 8,
      target: 5,
      // through 8 → 第 9 章; target 5 → 第 6 章
      expectContains: ['检测到检查点截至第 9 章', '当前目标为第 6 章', '未注入'],
      mustNotContain: ['尚无可用故事记忆检查点'],
    },
    {
      name: 'same-position (through===target)',
      status: 'clean',
      through: 5,
      target: 5,
      expectContains: ['检测到检查点截至第 6 章', '当前目标为第 6 章', '未注入'],
    },
    {
      name: 'invalid negative position',
      status: 'clean',
      through: -1,
      target: 5,
      expectContains: ['位置无效', '未注入'],
    },
  ];

  it.each(cases)(
    'trace copy for $name',
    ({ status, through, target, expectContains, mustNotContain }) => {
      const cp = status === 'missing' ? null : record(status as any, through);
      const eligibility = resolveUsableCheckpointForTarget(cp, target);
      const text = describeCheckpointEligibility(eligibility);
      for (const fragment of expectContains) {
        expect(text).toContain(fragment);
      }
      if (mustNotContain) {
        for (const forbidden of mustNotContain) {
          expect(text).not.toContain(forbidden);
        }
      }
    },
  );

  it('future reason is distinct from missing reason (no collapse)', () => {
    const missingText = describeCheckpointEligibility(
      resolveUsableCheckpointForTarget(null, 5),
    );
    const futureText = describeCheckpointEligibility(
      resolveUsableCheckpointForTarget(record('clean', 10), 5),
    );
    expect(missingText).not.toBe(futureText);
    expect(missingText).toContain('尚无可用');
    expect(futureText).toContain('检测到检查点');
    expect(futureText).toContain('未注入');
  });
});

describe('renderPreparedStoryMemoryContext — V2.5.14 trace diagnostics', () => {
  function chapter(position: number): Chapter {
    return {
      id: position + 1,
      project_id: 1,
      position,
      title: `第 ${position + 1} 章`,
      synopsis: '',
      content: '',
      status: 'final',
      summary_json: null,
      memory_summary: '',
      created_at: '',
      updated_at: '',
    };
  }

  it('dirty checkpoint: trace reason mentions dirty, preview has status copy', () => {
    const result = renderPreparedStoryMemoryContext(
      1,
      chapter(5),
      record('dirty', 2),
      4000,
    );
    expect(result.text).toBe('');
    expect(result.traceItems).toHaveLength(1);
    expect(result.traceItems[0].included).toBe(false);
    expect(result.traceItems[0].reason).toContain('不可用');
    expect(result.traceItems[0].reason).toContain('dirty');
    expect(result.traceItems[0].preview).toContain('检查点状态：dirty');
  });

  it('future checkpoint: trace reason mentions through and target, not injected', () => {
    const result = renderPreparedStoryMemoryContext(
      1,
      chapter(5), // target position 5
      record('clean', 10), // through 10 → 第 11 章
      4000,
    );
    expect(result.text).toBe('');
    expect(result.traceItems).toHaveLength(1);
    expect(result.traceItems[0].included).toBe(false);
    expect(result.traceItems[0].reason).toContain('检测到检查点截至第 11 章');
    expect(result.traceItems[0].reason).toContain('当前目标为第 6 章');
  });

  it('missing checkpoint: no trace items (legacy contract preserved)', () => {
    const result = renderPreparedStoryMemoryContext(
      1,
      chapter(5),
      null,
      4000,
    );
    expect(result.text).toBe('');
    expect(result.traceItems).toEqual([]);
  });

  it('usable checkpoint: trace reason uses position+1 and included=true', () => {
    const result = renderPreparedStoryMemoryContext(
      1,
      chapter(5),
      record('clean', 2),
      4000,
    );
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.traceItems[0].included).toBe(true);
    expect(result.traceItems[0].reason).toContain('检查点截至第 3 章');
  });

  it('invalid negative position: trace reason says invalid position', () => {
    const result = renderPreparedStoryMemoryContext(
      1,
      chapter(5),
      record('clean', -1),
      4000,
    );
    expect(result.text).toBe('');
    expect(result.traceItems[0].included).toBe(false);
    expect(result.traceItems[0].reason).toContain('位置无效');
  });
});

import { resolveUsableCheckpointForTarget } from '../src/services/storyMemory/storyMemoryCheckpointEligibility';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import type { ProjectStoryMemoryRecord } from '../src/data/repositories/storyMemoryRepository';

function record(
  status: ProjectStoryMemoryRecord['status'],
  through: number,
): ProjectStoryMemoryRecord {
  const state = createEmptyStoryMemory(1);
  state.throughChapterPosition = through;
  return {
    state,
    status,
    dirtyFromPosition: status === 'dirty' ? 0 : null,
    lastError: '',
    updatedAt: '',
  };
}

describe('resolveUsableCheckpointForTarget matrix', () => {
  const cases: Array<{
    status: ProjectStoryMemoryRecord['status'] | 'missing';
    through: number;
    target: number;
    usable: boolean;
    reason: string;
  }> = [
    { status: 'clean', through: 2, target: 5, usable: true, reason: 'usable' },
    {
      status: 'clean',
      through: 5,
      target: 5,
      usable: false,
      reason: 'future_or_same_position',
    },
    {
      status: 'clean',
      through: 8,
      target: 5,
      usable: false,
      reason: 'future_or_same_position',
    },
    { status: 'dirty', through: 2, target: 5, usable: false, reason: 'not_clean' },
    { status: 'empty', through: 2, target: 5, usable: false, reason: 'not_clean' },
    { status: 'failed', through: 2, target: 5, usable: false, reason: 'not_clean' },
    {
      status: 'rebuilding',
      through: 2,
      target: 5,
      usable: false,
      reason: 'not_clean',
    },
    {
      status: 'clean',
      through: -1,
      target: 5,
      usable: false,
      reason: 'invalid_position',
    },
    { status: 'missing', through: 0, target: 5, usable: false, reason: 'missing' },
  ];

  it.each(cases)(
    'status=$status through=$through target=$target → usable=$usable',
    ({ status, through, target, usable, reason }) => {
      const cp =
        status === 'missing' ? null : record(status as any, through);
      const result = resolveUsableCheckpointForTarget(cp, target);
      expect(result.usable).toBe(usable);
      expect(result.reason).toBe(reason);
      expect(result.checkpointThroughPosition).toBe(
        usable ? through : -1,
      );
    },
  );

  it('chapter 0 with through 0 is future_or_same (no time travel)', () => {
    const result = resolveUsableCheckpointForTarget(record('clean', 0), 0);
    expect(result.usable).toBe(false);
    expect(result.reason).toBe('future_or_same_position');
  });

  it('chapter 0 with through -1 invalid; clean through -1 never usable', () => {
    const result = resolveUsableCheckpointForTarget(record('clean', -1), 0);
    expect(result.usable).toBe(false);
  });
});

/**
 * V2.5.15 — Checkpoint eligibility final hardening tests.
 *
 * Two security-relevant changes are locked down here:
 *
 * 1. Target chapter position is validated FIRST and with the full
 *    `isValidChapterPosition` predicate (finite integer >= 0). A bad target
 *    (-1, 2.5, NaN, Infinity, -Infinity, "3", null, undefined) must surface as
 *    `invalid_position` even when the checkpoint is null — it can no longer be
 *    masked by `missing` / `not_clean` / `empty_state`. The same predicate
 *    validates `state.throughChapterPosition`.
 *
 * 2. Unusable eligibility results NEVER expose the full checkpoint record.
 *    `checkpoint` is statically `null` on every `usable === false` branch, so
 *    future characters / secrets / relationships / objects / plot threads can
 *    no longer be reached via `prepared.checkpointEligibility.checkpoint?.state`.
 */

import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import {
  resolveUsableCheckpointForTarget,
  isValidChapterPosition,
  type CheckpointEligibilityResult,
} from '../src/services/storyMemory/storyMemoryCheckpointEligibility';
import type { ProjectStoryMemoryRecord } from '../src/data/repositories/storyMemoryRepository';

function record(
  status: ProjectStoryMemoryRecord['status'],
  through: number,
): ProjectStoryMemoryRecord {
  const state = createEmptyStoryMemory(1);
  state.throughChapterPosition = through;
  state.throughChapterId = through >= 0 ? through + 1 : null;
  // Put sensitive-looking data into the snapshot to prove it never leaks.
  state.characters.char_secret = {
    id: 'char_secret',
    canonicalName: '未来角色',
    aliases: [],
    role: '',
    immutableProfile: { identity: '', stableTraits: [], affiliations: [] },
    currentState: {
      location: '未来地点',
      physicalState: '',
      emotionalState: '',
      currentGoal: '',
      knowledge: ['未来秘密-SHOULD-NOT-LEAK'],
      possessions: ['未来道具'],
      secrets: ['未来秘密-SHOULD-NOT-LEAK'],
    },
    status: 'active',
    firstSeenChapterId: 1,
    firstSeenPosition: 0,
    lastChangedChapterId: through + 1,
    lastChangedPosition: through,
    evidenceChapterIds: [1],
  };
  return {
    state,
    status,
    dirtyFromPosition: status === 'dirty' ? 0 : null,
    lastError: status === 'failed' ? 'rebuild error' : '',
    updatedAt: '',
  };
}

// ---------------------------------------------------------------------------
// isValidChapterPosition — single source of truth for "legal position".
// ---------------------------------------------------------------------------

describe('isValidChapterPosition — V2.5.15 canonical predicate', () => {
  it.each([
    ['0', 0, true],
    ['1', 1, true],
    ['42', 42, true],
    ['-1', -1, false],
    ['2.5', 2.5, false],
    ['NaN', Number.NaN, false],
    ['Infinity', Number.POSITIVE_INFINITY, false],
    ['-Infinity', Number.NEGATIVE_INFINITY, false],
    ['"3"', '3', false],
    ['null', null, false],
    ['undefined', undefined, false],
    ['"abc"', 'abc', false],
    ['{}', {}, false],
  ])('isValidChapterPosition(%s) === %s', (_label, value, expected) => {
    expect(isValidChapterPosition(value)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Section 2 — invalid target matrix, checked BEFORE every other reason.
// ---------------------------------------------------------------------------

describe('resolveUsableCheckpointForTarget — invalid target checked FIRST', () => {
  const invalidTargets: Array<{ label: string; value: unknown }> = [
    { label: '-1', value: -1 },
    { label: '2.5', value: 2.5 },
    { label: 'NaN', value: Number.NaN },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY },
    { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
    { label: '"3"', value: '3' },
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
  ];

  describe.each([
    { checkpointLabel: 'null', checkpoint: null },
    { checkpointLabel: 'clean usable record', checkpoint: record('clean', 2) },
  ])('checkpoint=$checkpointLabel', ({ checkpoint }) => {
    it.each(invalidTargets)(
      'invalid target $label → invalid_position, usable=false, checkpointThroughPosition=-1, checkpoint=null',
      ({ value }) => {
        const result = resolveUsableCheckpointForTarget(
          checkpoint,
          value as unknown as number,
        );
        expect(result.usable).toBe(false);
        expect(result.reason).toBe('invalid_position');
        expect(result.checkpointThroughPosition).toBe(-1);
        // Section 3: the full record must NEVER be exposed on an unusable result.
        expect(result.checkpoint).toBeNull();
      },
    );
  });

  it('invalid target is NOT masked by a missing checkpoint (null case)', () => {
    // Previously a null checkpoint returned `missing` first, hiding a bad target.
    const result = resolveUsableCheckpointForTarget(null, -1 as number);
    expect(result.reason).toBe('invalid_position');
    expect(result.reason).not.toBe('missing');
    expect(result.checkpoint).toBeNull();
  });

  it('invalid target is NOT masked by a dirty checkpoint', () => {
    const result = resolveUsableCheckpointForTarget(record('dirty', 2), NaN);
    expect(result.reason).toBe('invalid_position');
    expect(result.reason).not.toBe('not_clean');
  });

  it('invalid target is NOT masked by a future checkpoint', () => {
    // through 8 > target — but the bad target must win.
    const result = resolveUsableCheckpointForTarget(
      record('clean', 8),
      2.5 as number,
    );
    expect(result.reason).toBe('invalid_position');
    expect(result.reason).not.toBe('future_or_same_position');
  });

  it('invalid target preserves raw numeric target / NaN for diagnostics', () => {
    expect(
      resolveUsableCheckpointForTarget(null, 2.5 as number).targetChapterPosition,
    ).toBe(2.5);
    expect(
      Number.isNaN(
        resolveUsableCheckpointForTarget(null, NaN).targetChapterPosition,
      ),
    ).toBe(true);
    // Non-number targets collapse to NaN so callers can detect "which side".
    expect(
      Number.isNaN(
        resolveUsableCheckpointForTarget(null, '3' as unknown as number)
          .targetChapterPosition,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 2.2 — boundary: 0/0 is future_or_same, 1/0 is usable (NOT invalid).
// ---------------------------------------------------------------------------

describe('resolveUsableCheckpointForTarget — legal-zero boundaries', () => {
  it('target=0 through=0 is future_or_same_position, not invalid', () => {
    const result = resolveUsableCheckpointForTarget(record('clean', 0), 0);
    expect(result.usable).toBe(false);
    expect(result.reason).toBe('future_or_same_position');
  });

  it('target=1 through=0 is usable', () => {
    const result = resolveUsableCheckpointForTarget(record('clean', 0), 1);
    expect(result.usable).toBe(true);
    expect(result.reason).toBe('usable');
    expect(result.checkpointThroughPosition).toBe(0);
  });

  it('invalid through position (clean through -1) is invalid_position', () => {
    const result = resolveUsableCheckpointForTarget(record('clean', -1), 5);
    expect(result.usable).toBe(false);
    expect(result.reason).toBe('invalid_position');
    expect(result.checkpointThroughPosition).toBe(-1);
    expect(result.checkpoint).toBeNull();
  });

  it('invalid non-integer through position is invalid_position', () => {
    const cp = record('clean', 2);
    (cp.state as any).throughChapterPosition = 2.5;
    const result = resolveUsableCheckpointForTarget(cp, 5);
    expect(result.reason).toBe('invalid_position');
    expect(result.checkpoint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Section 3 — unusable results never expose the full snapshot (state leak).
// ---------------------------------------------------------------------------

describe('resolveUsableCheckpointForTarget — unusable results hide checkpoint', () => {
  const cases: Array<{
    name: string;
    checkpoint: ProjectStoryMemoryRecord | null;
    target: number;
    reason: CheckpointEligibilityResult['reason'];
  }> = [
    { name: 'future', checkpoint: record('clean', 8), target: 5, reason: 'future_or_same_position' },
    { name: 'same-position', checkpoint: record('clean', 5), target: 5, reason: 'future_or_same_position' },
    { name: 'dirty', checkpoint: record('dirty', 2), target: 5, reason: 'not_clean' },
    { name: 'failed', checkpoint: record('failed', 2), target: 5, reason: 'not_clean' },
    { name: 'rebuilding', checkpoint: record('rebuilding', 2), target: 5, reason: 'not_clean' },
    { name: 'empty', checkpoint: record('empty', 2), target: 5, reason: 'not_clean' },
    { name: 'empty state object', checkpoint: (() => { const cp = record('clean', 2); (cp as any).state = null; return cp; })(), target: 5, reason: 'empty_state' },
    { name: 'invalid target', checkpoint: record('clean', 2), target: -1 as number, reason: 'invalid_position' },
    { name: 'invalid through', checkpoint: record('clean', -1), target: 5, reason: 'invalid_position' },
    { name: 'missing', checkpoint: null, target: 5, reason: 'missing' },
  ];

  it.each(cases)(
    '$name: usable=false AND checkpoint===null (no state leak)',
    ({ checkpoint, target, reason }) => {
      const result = resolveUsableCheckpointForTarget(checkpoint, target);
      expect(result.usable).toBe(false);
      expect(result.reason).toBe(reason);
      expect(result.checkpoint).toBeNull();
      // Diagnostics only — these are the fields trace is allowed to read.
      expect(result).toHaveProperty('originalStatus');
      expect(result).toHaveProperty('originalThroughPosition');
      expect(result).toHaveProperty('targetChapterPosition');
      expect(result.checkpointThroughPosition).toBe(-1);
    },
  );

  it('usable result DOES expose the checkpoint (only branch that may)', () => {
    const cp = record('clean', 2);
    const result = resolveUsableCheckpointForTarget(cp, 5);
    expect(result.usable).toBe(true);
    expect(result.reason).toBe('usable');
    // Non-null assertion is valid only on the usable branch.
    if (result.usable) {
      expect(result.checkpoint).toBe(cp);
      expect(result.originalStatus).toBe('clean');
    }
  });

  it('no eligibility field carries the raw snapshot body (characters/secrets)', () => {
    // Serialize the whole unusable result and assert sensitive markers never
    // appear — proving the snapshot body is not stashed in any diagnostic field.
    const future = resolveUsableCheckpointForTarget(record('clean', 8), 5);
    expect(future.usable).toBe(false);
    const serialized = JSON.stringify(future);
    expect(serialized).not.toContain('未来秘密-SHOULD-NOT-LEAK');
    expect(serialized).not.toContain('未来角色');
    expect(serialized).not.toContain('未来地点');
    expect(serialized).not.toContain('characters');
    expect(serialized).not.toContain('currentState');
    expect(serialized).not.toContain('secrets');
  });
});

// ---------------------------------------------------------------------------
// Section 3.3 — describeCheckpointEligibility works from diagnostics only.
// (No DB read; full coverage in storyMemoryCheckpointEligibilityTrace.test.ts.)
// ---------------------------------------------------------------------------

describe('resolveUsableCheckpointForTarget — diagnostics are self-contained', () => {
  it('every unusable result carries reason + scalar diagnostics, never state', () => {
    const samples: Array<{
      cp: ProjectStoryMemoryRecord | null;
      target: number;
    }> = [
      { cp: null, target: 5 },
      { cp: record('dirty', 2), target: 5 },
      { cp: record('clean', 8), target: 5 },
      { cp: record('clean', -1), target: 5 },
    ];
    for (const { cp, target } of samples) {
      const result = resolveUsableCheckpointForTarget(cp, target);
      // Allowed diagnostic keys only.
      const keys = Object.keys(result).sort();
      for (const k of keys) {
        expect(
          [
            'usable',
            'reason',
            'checkpoint',
            'checkpointThroughPosition',
            'targetChapterPosition',
            'originalThroughPosition',
            'originalStatus',
            // V2.5.16: scalar only — target vs checkpoint source for invalid_position.
            'invalidPositionSource',
          ].includes(k),
        ).toBe(true);
      }
    }
  });
});

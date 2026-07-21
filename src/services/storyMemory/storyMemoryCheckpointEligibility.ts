/**
 * Single production entry for: is this checkpoint usable for a target chapter?
 * Future / same-position checkpoints must never inject or entity-weight.
 *
 * V2.5.14+ — the eligibility result carries the original status / through /
 * target values so downstream trace/diagnostics can explain *why* a checkpoint
 * was unusable WITHOUT re-reading the database. The reason alone is not enough:
 * a dirty checkpoint and a future checkpoint both need their own diagnostic
 * copy, and trace must stay consistent with the snapshot that coverage /
 * Renderer / entity-weighting all consumed.
 *
 * V2.5.15+ — two hardening changes (both security-relevant):
 *
 * 1. Position validity is checked FIRST. A non-integer / negative / NaN /
 *    Infinity / non-number target must surface as `invalid_position` even when
 *    the checkpoint is null, dirty or empty — it can no longer be masked by a
 *    `missing` / `not_clean` / `empty_state` reason. The same
 *    `isValidChapterPosition` predicate validates BOTH the caller-supplied
 *    `targetChapterPosition` and `state.throughChapterPosition`, so a single
 *    definition of "legal chapter position" (finite integer >= 0) is enforced
 *    everywhere.
 *
 * 2. The full checkpoint record is ONLY exposed when `usable === true`. Every
 *    unusable branch returns `checkpoint: null`, so the discriminated union
 *    makes it impossible at the type level to reach `checkpoint.state`
 *    (future characters / secrets / relationships / plot threads) on a result
 *    that was deemed unusable. Diagnostics still carry `reason` /
 *    `originalStatus` / `originalThroughPosition` / `targetChapterPosition`,
 *    which is enough for trace copy without ever leaking the snapshot body.
 *
 * V2.5.16+ — `invalid_position` now carries `invalidPositionSource` so callers
 * can tell whether the *target chapter* position was illegal (must hard-block
 * context build) or only the checkpoint's through position was illegal
 * (safe degrade: no checkpoint inject / no entity weighting / coverage from -1).
 */

import type { ProjectStoryMemoryRecord } from '../../data/repositories/storyMemoryRepository';

export type CheckpointEligibilityReason =
  | 'usable'
  | 'missing'
  | 'not_clean'
  | 'empty_state'
  | 'future_or_same_position'
  | 'invalid_position';

/**
 * Discriminated union on `usable`. When `usable === false` the `checkpoint`
 * field is statically `null`, so callers cannot read `checkpoint.state` /
 * characters / relationships / secrets / objects / plot threads from an
 * unusable eligibility decision. The full record is only reachable on the
 * `usable === true` branch.
 */
export type CheckpointEligibilityResult =
  | {
      usable: true;
      reason: 'usable';
      checkpoint: ProjectStoryMemoryRecord;
      /**
       * Coverage planning start: state.throughChapterPosition when usable.
       * Callers must not read through from an unusable record for
       * injection/weighting.
       */
      checkpointThroughPosition: number;
      /** The chapter position this eligibility decision was made FOR. */
      targetChapterPosition: number;
      /** The original through position from the usable snapshot. */
      originalThroughPosition: number;
      originalStatus: 'clean';
    }
  | {
      usable: false;
      reason: Exclude<CheckpointEligibilityReason, 'usable'>;
      /** Always null on unusable results — the snapshot body never leaks. */
      checkpoint: null;
      /** Always -1 on unusable results. */
      checkpointThroughPosition: -1;
      /**
       * The target the decision was made for. When the target itself was the
       * invalid input, this preserves the raw value (number) or NaN so the
       * caller can tell *which* side was bad.
       */
      targetChapterPosition: number;
      /**
       * The original state.throughChapterPosition from the snapshot, even when
       * the checkpoint is unusable (future / same-position / dirty). `-1` when
       * there is no readable state or the value is not a legal position. Never
       * re-reads DB.
       */
      originalThroughPosition: number;
      /**
       * The original status string from the snapshot (`clean` / `dirty` /
       * `empty` / `rebuilding` / `failed`) or null when the record is missing.
       * Used by trace to surface "检查点状态：dirty" style diagnostics. This is
       * a scalar status label only — never the snapshot body.
       */
      originalStatus: string | null;
      /**
       * Present only when `reason === 'invalid_position'`. Distinguishes an
       * illegal target chapter position (hard-block context build) from an
       * illegal checkpoint through position (safe degrade). Undefined for
       * every other reason.
       */
      invalidPositionSource?: 'target' | 'checkpoint';
    };

/**
 * Canonical definition of a legal chapter position: a finite, non-negative
 * integer. Applied to BOTH the target chapter position and
 * `state.throughChapterPosition` so there is a single rule for "position
 * validity" instead of the previous looser (finite-only) target check.
 */
export function isValidChapterPosition(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

/**
 * Resolve whether a project checkpoint may be injected / entity-weighted /
 * used as coverage start for the given target chapter position.
 *
 * Check order (the FIRST failing rule wins, and target-position validity is
 * checked before everything else so a bad target is never masked):
 *
 * 1. `invalid_position` — target not a finite non-negative integer (even when
 *    the checkpoint is null).
 * 2. `missing` — no checkpoint record.
 * 3. `not_clean` — status !== 'clean'.
 * 4. `empty_state` — state missing / not an object.
 * 5. `invalid_position` — throughChapterPosition not a finite non-negative
 *    integer.
 * 6. `future_or_same_position` — through >= target (would time-travel).
 * 7. `usable` — all rules pass; the only branch returning the real record.
 *
 * The returned `originalThroughPosition` / `originalStatus` /
 * `targetChapterPosition` fields are derived from the SAME single snapshot
 * argument — callers that need the reason MUST consume this result instead of
 * re-reading the DB.
 */
export function resolveUsableCheckpointForTarget(
  checkpoint: ProjectStoryMemoryRecord | null | undefined,
  targetChapterPosition: number,
): CheckpointEligibilityResult {
  // 1. Target position validity FIRST — a bad target must not be masked by
  //    missing / dirty / empty / future reasons, even when checkpoint is null.
  if (!isValidChapterPosition(targetChapterPosition)) {
    return {
      usable: false,
      reason: 'invalid_position',
      invalidPositionSource: 'target',
      checkpoint: null,
      checkpointThroughPosition: -1,
      targetChapterPosition:
        typeof targetChapterPosition === 'number'
          ? targetChapterPosition
          : Number.NaN,
      originalThroughPosition:
        checkpoint != null ? readThroughPosition(checkpoint) : -1,
      originalStatus: checkpoint != null ? checkpoint.status : null,
    };
  }

  const target = targetChapterPosition;

  // 2. missing
  if (checkpoint == null) {
    return {
      usable: false,
      reason: 'missing',
      checkpoint: null,
      checkpointThroughPosition: -1,
      targetChapterPosition: target,
      originalThroughPosition: -1,
      originalStatus: null,
    };
  }

  // 3. not_clean
  if (checkpoint.status !== 'clean') {
    return {
      usable: false,
      reason: 'not_clean',
      checkpoint: null,
      checkpointThroughPosition: -1,
      targetChapterPosition: target,
      originalThroughPosition: readThroughPosition(checkpoint),
      originalStatus: checkpoint.status,
    };
  }

  // 4. empty_state
  const state = checkpoint.state;
  if (!state || typeof state !== 'object') {
    return {
      usable: false,
      reason: 'empty_state',
      checkpoint: null,
      checkpointThroughPosition: -1,
      targetChapterPosition: target,
      originalThroughPosition: -1,
      originalStatus: checkpoint.status,
    };
  }

  // 5. invalid through position (same predicate as the target).
  //    Source is 'checkpoint' — target was already validated above, so callers
  //    may safely degrade (no inject / coverage from -1) without hard-blocking.
  const through = state.throughChapterPosition;
  if (!isValidChapterPosition(through)) {
    return {
      usable: false,
      reason: 'invalid_position',
      invalidPositionSource: 'checkpoint',
      checkpoint: null,
      checkpointThroughPosition: -1,
      targetChapterPosition: target,
      originalThroughPosition: -1,
      originalStatus: checkpoint.status,
    };
  }

  // 6. future_or_same_position — would time-travel into the past chapter.
  if (through >= target) {
    return {
      usable: false,
      reason: 'future_or_same_position',
      checkpoint: null,
      checkpointThroughPosition: -1,
      targetChapterPosition: target,
      originalThroughPosition: through,
      originalStatus: checkpoint.status,
    };
  }

  // 7. usable — the ONLY branch exposing the real record.
  return {
    usable: true,
    reason: 'usable',
    checkpoint,
    checkpointThroughPosition: through,
    targetChapterPosition: target,
    originalThroughPosition: through,
    originalStatus: checkpoint.status,
  };
}

function readThroughPosition(checkpoint: ProjectStoryMemoryRecord): number {
  const through = checkpoint?.state?.throughChapterPosition;
  return isValidChapterPosition(through) ? through : -1;
}

/**
 * Future-ready hook: when multi-snapshot storage exists, load the latest
 * clean checkpoint with through < target. Today only the latest row exists,
 * so this reuses resolveUsableCheckpointForTarget on that row.
 */
export function getLatestCheckpointBeforePosition(
  checkpoint: ProjectStoryMemoryRecord | null | undefined,
  targetChapterPosition: number,
): CheckpointEligibilityResult {
  return resolveUsableCheckpointForTarget(checkpoint, targetChapterPosition);
}

/**
 * Single production entry for: is this checkpoint usable for a target chapter?
 * Future / same-position checkpoints must never inject or entity-weight.
 *
 * V2.5.14+ — the eligibility result also carries the original status /
 * through / target values so downstream trace/diagnostics can explain *why*
 * a checkpoint was unusable WITHOUT re-reading the database. The reason alone
 * is not enough: a dirty checkpoint and a future checkpoint both need their
 * own diagnostic copy, and trace must stay consistent with the snapshot that
 * coverage / Renderer / entity-weighting all consumed.
 */

import type { ProjectStoryMemoryRecord } from '../../data/repositories/storyMemoryRepository';

export type CheckpointEligibilityReason =
  | 'usable'
  | 'missing'
  | 'not_clean'
  | 'empty_state'
  | 'future_or_same_position'
  | 'invalid_position';

export interface CheckpointEligibilityResult {
  usable: boolean;
  reason: CheckpointEligibilityReason;
  checkpoint: ProjectStoryMemoryRecord | null;
  /**
   * Coverage planning start: state.throughChapterPosition when usable, else -1.
   * Callers must not read through from an unusable record for injection/weighting.
   */
  checkpointThroughPosition: number;
  /**
   * The chapter position this eligibility decision was made FOR (the target).
   * Captured here so trace / diagnostics do not need to thread the original
   * target through separately.
   */
  targetChapterPosition: number;
  /**
   * The original state.throughChapterPosition from the snapshot, even when the
   * checkpoint is unusable (future / same-position / dirty). `-1` when there is
   * no state or the value is not a non-negative integer. Never re-reads DB.
   */
  originalThroughPosition: number;
  /**
   * The original status string from the snapshot (`clean` / `dirty` / `empty` /
   * `rebuilding` / `failed`) or null when the record is missing. Used by trace
   * to surface "检查点状态：dirty" style diagnostics.
   */
  originalStatus: string | null;
}

/**
 * Resolve whether a project checkpoint may be injected / entity-weighted /
 * used as coverage start for the given target chapter position.
 *
 * Rules (all required for usable):
 * - record present
 * - status === 'clean'
 * - state exists
 * - throughChapterPosition is a non-negative integer
 * - throughChapterPosition < targetChapterPosition
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
  const target =
    typeof targetChapterPosition === 'number' &&
    Number.isFinite(targetChapterPosition)
      ? targetChapterPosition
      : Number.NaN;

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

  if (checkpoint.status !== 'clean') {
    return {
      usable: false,
      reason: 'not_clean',
      checkpoint,
      checkpointThroughPosition: -1,
      targetChapterPosition: target,
      originalThroughPosition: readThroughPosition(checkpoint),
      originalStatus: checkpoint.status,
    };
  }

  const state = checkpoint.state;
  if (!state || typeof state !== 'object') {
    return {
      usable: false,
      reason: 'empty_state',
      checkpoint,
      checkpointThroughPosition: -1,
      targetChapterPosition: target,
      originalThroughPosition: -1,
      originalStatus: checkpoint.status,
    };
  }

  const through = state.throughChapterPosition;
  if (
    typeof through !== 'number' ||
    !Number.isInteger(through) ||
    through < 0
  ) {
    return {
      usable: false,
      reason: 'invalid_position',
      checkpoint,
      checkpointThroughPosition: -1,
      targetChapterPosition: target,
      originalThroughPosition: -1,
      originalStatus: checkpoint.status,
    };
  }

  if (Number.isNaN(target)) {
    return {
      usable: false,
      reason: 'invalid_position',
      checkpoint,
      checkpointThroughPosition: -1,
      targetChapterPosition: Number.NaN,
      originalThroughPosition: through,
      originalStatus: checkpoint.status,
    };
  }

  // Future or same-position checkpoint would time-travel into the past chapter.
  if (through >= target) {
    return {
      usable: false,
      reason: 'future_or_same_position',
      checkpoint,
      checkpointThroughPosition: -1,
      targetChapterPosition: target,
      originalThroughPosition: through,
      originalStatus: checkpoint.status,
    };
  }

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

function readThroughPosition(
  checkpoint: ProjectStoryMemoryRecord,
): number {
  const through = checkpoint?.state?.throughChapterPosition;
  if (
    typeof through !== 'number' ||
    !Number.isInteger(through) ||
    through < 0
  ) {
    return -1;
  }
  return through;
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

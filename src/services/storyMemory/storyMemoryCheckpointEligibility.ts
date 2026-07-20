/**
 * Single production entry for: is this checkpoint usable for a target chapter?
 * Future / same-position checkpoints must never inject or entity-weight.
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
 */
export function resolveUsableCheckpointForTarget(
  checkpoint: ProjectStoryMemoryRecord | null | undefined,
  targetChapterPosition: number,
): CheckpointEligibilityResult {
  if (checkpoint == null) {
    return {
      usable: false,
      reason: 'missing',
      checkpoint: null,
      checkpointThroughPosition: -1,
    };
  }

  if (checkpoint.status !== 'clean') {
    return {
      usable: false,
      reason: 'not_clean',
      checkpoint,
      checkpointThroughPosition: -1,
    };
  }

  const state = checkpoint.state;
  if (!state || typeof state !== 'object') {
    return {
      usable: false,
      reason: 'empty_state',
      checkpoint,
      checkpointThroughPosition: -1,
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
    };
  }

  if (
    typeof targetChapterPosition !== 'number' ||
    !Number.isFinite(targetChapterPosition)
  ) {
    return {
      usable: false,
      reason: 'invalid_position',
      checkpoint,
      checkpointThroughPosition: -1,
    };
  }

  // Future or same-position checkpoint would time-travel into the past chapter.
  if (through >= targetChapterPosition) {
    return {
      usable: false,
      reason: 'future_or_same_position',
      checkpoint,
      checkpointThroughPosition: -1,
    };
  }

  return {
    usable: true,
    reason: 'usable',
    checkpoint,
    checkpointThroughPosition: through,
  };
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

/**
 * Overall Canon analysis progress.
 *
 * Extraction work items alone must NOT fill the progress bar: after every
 * character_state / world_plot item finishes, the run still spends significant
 * time on evidence validation, coverage/gate (+ targeted rescan), style
 * analysis and style validation / activation. Users reading "2/2 · 100%"
 * during 风格校验 is a product bug.
 *
 * Model:
 *   progressTotal   = workItemCount + POST_EXTRACTION_STEPS
 *   progressCurrent = completedWorkItems + completedPostSteps(stage, state)
 */
import type { AnalysisRunState, AnalysisStage } from './types';

/**
 * Post-extraction pipeline units counted after all extraction work items.
 * Order matches the production runner after the batch loop.
 */
export const CANON_POST_EXTRACTION_STEPS = [
  'evidence_validation',
  'finalizing',
  'style_analysis',
  'style_validation',
] as const;

export type CanonPostExtractionStep =
  (typeof CANON_POST_EXTRACTION_STEPS)[number];

export const CANON_POST_EXTRACTION_STEP_COUNT =
  CANON_POST_EXTRACTION_STEPS.length;

export function computeCanonProgressTotal(workItemCount: number): number {
  return Math.max(0, workItemCount) + CANON_POST_EXTRACTION_STEP_COUNT;
}

/**
 * How many post-extraction units are fully complete for the current
 * stage/state. The unit currently in progress is NOT counted.
 */
export function completedPostExtractionSteps(input: {
  stage: AnalysisStage;
  state: AnalysisRunState;
}): number {
  if (
    input.state === 'completed' ||
    (input.state === 'awaiting_review' && input.stage === 'style_validation')
  ) {
    return CANON_POST_EXTRACTION_STEP_COUNT;
  }

  switch (input.stage) {
    case 'snapshot':
    case 'chapter_extraction':
      return 0;
    case 'evidence_validation':
      return 0;
    case 'entity_resolution':
    case 'temporal_merge':
    case 'global_synthesis':
    case 'indexing':
    case 'finalizing':
      // Evidence finished; still consolidating / gate / rescan.
      return 1;
    case 'style_analysis':
      return 2;
    case 'style_validation':
      // Style model finished; atomic activation / profile check in progress.
      return 3;
    default:
      return 0;
  }
}

export function computeCanonProgressCurrent(input: {
  completedWorkItems: number;
  workItemCount: number;
  stage: AnalysisStage;
  state: AnalysisRunState;
}): number {
  const workCompleted = Math.min(
    Math.max(0, input.completedWorkItems),
    Math.max(0, input.workItemCount),
  );
  // Post steps only accrue once every extraction work item is done. Dynamic
  // tail sub-batches can raise workItemCount mid-run; until they finish we
  // stay in the extraction band.
  if (workCompleted < input.workItemCount) {
    return workCompleted;
  }
  return (
    workCompleted +
    completedPostExtractionSteps({
      stage: input.stage,
      state: input.state,
    })
  );
}

export function computeCanonOverallProgress(input: {
  completedWorkItems: number;
  workItemCount: number;
  stage: AnalysisStage;
  state: AnalysisRunState;
}): { current: number; total: number; percent: number } {
  const total = computeCanonProgressTotal(input.workItemCount);
  const current = Math.min(
    total,
    computeCanonProgressCurrent(input),
  );
  const percent =
    total > 0 ? Math.round((current / total) * 100) : 0;
  return { current, total, percent };
}

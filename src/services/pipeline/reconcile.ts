/**
 * Durable outline orchestration boundary.
 *
 * This module intentionally exposes only the durable orchestration surface
 * needed by task runners, batch control, and migration-compatible callers.
 * Outline's operation capability is reached through the shared Writing Kernel
 * stage adapter, never through this facade.
 */
export {
  reconcilePipelineTask,
  isReconcileActive,
  BatchBudgetExceededError,
  acquireReconcileLock,
  cancelled,
  consumeFailedStageRetryDisposition,
  handleBlocked,
  maybeAutoRetryStage,
  releaseReconcileLock,
  settleInterruptedTask,
} from './outlineStageRuntime';
export type { StageInfo } from './outlineStageRuntime';

// Keep the orchestration contract visible at this boundary. The owner is
// call-scoped, never module state, so Task and Batch runs cannot cross-talk.
export type ReconcileOptions = Omit<
  import('./outlineStageRuntime').ReconcileOptions,
  'foregroundOwner'
> & {
  foregroundOwner?: 'task' | 'batch';
};

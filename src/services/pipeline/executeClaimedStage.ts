/**
 * Unified stage executor: CAS claim → run → never leave orphan running.
 *
 * Fail-closed: claim throw or rowsAffected !== 1 means no model call.
 */
import * as db from '../database';
import type { PipelineStageName } from '../../types/pipeline';

export interface ExecuteClaimedStageOptions<T> {
  taskId: string;
  stage: PipelineStageName;
  run: () => Promise<T>;
  /** Called only after successful CAS claim (e.g. persist drafting status). */
  onClaimed?: () => Promise<void>;
  abortSignal?: AbortSignal;
  isCancelled?: () => boolean;
}

export type ExecuteClaimedStageResult<T> =
  | { claimed: false; reason: 'TASK_ALREADY_RUNNING' }
  | { claimed: true; result: T };

function isAbortOrCancel(
  error: unknown,
  abortSignal?: AbortSignal,
  isCancelled?: () => boolean,
): boolean {
  if (abortSignal?.aborted) return true;
  if (isCancelled?.()) return true;
  const e = error as { code?: string; name?: string } | null;
  return Boolean(e?.code === 'cancelled' || e?.name === 'AbortError');
}

async function releaseRunningCheckpoint(
  taskId: string,
  stage: PipelineStageName,
  kind: 'interrupted' | 'failed',
  errorMessage?: string,
): Promise<void> {
  const row = await db.getStageCheckpoint(taskId, stage);
  if (!row || row.status !== 'running') return;
  await db.upsertStageCheckpoint({
    taskId,
    stage,
    status: kind,
    errorCode: kind === 'interrupted' ? 'INTERRUPTED' : 'STAGE_FAILED',
    errorMessage: errorMessage || (kind === 'interrupted' ? '阶段中断' : '阶段失败'),
    outputText: row.outputText,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    durationMs: row.durationMs,
    startedAt: row.startedAt,
  });
}

/**
 * CAS-claim a stage, run work, and ensure the checkpoint is not left `running`
 * on ordinary exceptions or cancellation. Process death is handled by cold-start
 * interruptRunningStages — not this helper.
 */
export async function executeClaimedStage<T>(
  options: ExecuteClaimedStageOptions<T>,
): Promise<ExecuteClaimedStageResult<T>> {
  const { taskId, stage, run, onClaimed, abortSignal, isCancelled } = options;

  // Fail-closed: any claim error propagates; never treat as success.
  const claimed = await db.claimStageCheckpoint(taskId, stage);
  if (!claimed) {
    return { claimed: false, reason: 'TASK_ALREADY_RUNNING' };
  }

  let finishedByRun = false;
  try {
    if (abortSignal?.aborted || isCancelled?.()) {
      await releaseRunningCheckpoint(taskId, stage, 'interrupted', '用户取消');
      finishedByRun = true;
      const err = new Error('任务已取消') as Error & { code?: string };
      err.code = 'cancelled';
      throw err;
    }
    if (onClaimed) {
      await onClaimed();
    }
    const result = await run();
    finishedByRun = true;
    // If run() forgot to leave a terminal status, release running.
    try {
      await releaseRunningCheckpoint(
        taskId,
        stage,
        'failed',
        '阶段未写入终态',
      );
    } catch {
      /* do not convert successful work into outer failure */
    }
    return { claimed: true, result };
  } catch (error: unknown) {
    if (!finishedByRun) {
      if (isAbortOrCancel(error, abortSignal, isCancelled)) {
        try {
          await releaseRunningCheckpoint(taskId, stage, 'interrupted', '用户取消');
        } catch {
          /* persistence failure still rethrows original */
        }
      } else {
        const message =
          error instanceof Error ? error.message : String(error || '阶段失败');
        try {
          await releaseRunningCheckpoint(taskId, stage, 'failed', message);
        } catch {
          /* */
        }
      }
    }
    throw error;
  }
}

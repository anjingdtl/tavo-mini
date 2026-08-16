/**
 * Canonical stage-cancel settlement (Kernel Final Closure §8.4): mark every
 * queued/running stage row of a run as interrupted so a cancelled run never
 * auto-re-sends its reservations. Workflow-version agnostic — production
 * callers (writing/persist adoption) use this directly; the legacy V5 runner
 * shim re-exports it under its historical name.
 */
import type { ContinuationGenerationStageResult } from './types';
import { listStageResults, updateStageResult } from './generationRepository';

export async function markContinuationStagesCancelled(
  runId: string,
): Promise<void> {
  const results = await listStageResults(runId).catch(
    () => [] as ContinuationGenerationStageResult[],
  );
  for (const result of results) {
    if (result.status !== 'queued' && result.status !== 'running') continue;
    try {
      await updateStageResult({
        runId,
        stage: result.stage,
        status: 'interrupted',
        outputJson: result.outputJson,
        artifactId: result.artifactId,
        errorCode: 'cancelled',
        errorMessage: '用户取消，reservation 不会自动重发。',
      });
    } catch (error) {
      console.warn(
        `[continuation] mark stage ${result.stage} interrupted failed:`,
        error,
      );
    }
  }
}

/** Legacy-named wrapper (V5) kept for compatibility with old import paths. */
export async function markContinuationV5StagesCancelled(
  runId: string,
): Promise<void> {
  await markContinuationStagesCancelled(runId);
}

/** Legacy-named wrapper (V4) kept for compatibility with old import paths. */
export async function markContinuationV4StagesCancelled(
  runId: string,
): Promise<void> {
  await markContinuationStagesCancelled(runId);
}

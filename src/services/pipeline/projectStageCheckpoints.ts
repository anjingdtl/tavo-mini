/**
 * Project legacy stage_results[] into at-most-one checkpoint per stage.
 *
 * Used until pipeline_stage_checkpoints is the sole authority (phase 2).
 * Preference order for a given stage:
 *   succeeded > skipped > failed > running > interrupted > pending
 * Among equal priority, last occurrence wins (newer attempts).
 */

import type { PipelineStageName, PipelineStageResult } from '../../types/pipeline';
import type {
  PersistedStageCheckpoint,
  StageStatus,
} from './types';

const PRIORITY: Record<StageStatus, number> = {
  succeeded: 50,
  skipped: 40,
  failed: 30,
  running: 20,
  interrupted: 10,
  pending: 0,
};

function mapLegacyStatus(
  status: PipelineStageResult['status'] | string | undefined,
): StageStatus {
  if (status === 'success' || status === 'succeeded') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'skipped') return 'skipped';
  if (status === 'running') return 'running';
  if (status === 'interrupted') return 'interrupted';
  if (status === 'pending') return 'pending';
  return 'pending';
}

/**
 * Collapse append-only stageResults into one checkpoint per stage name.
 */
export function projectStageResultsToCheckpoints(
  stageResults: Array<
    Pick<PipelineStageResult, 'stage' | 'status' | 'text' | 'error' | 'errorCode'> & {
      status?: string;
    }
  >,
  options: { includeBrief?: boolean } = {},
): PersistedStageCheckpoint[] {
  const map = new Map<string, PersistedStageCheckpoint>();

  for (const row of stageResults || []) {
    if (!row || !row.stage) continue;
    const stage = row.stage as PipelineStageName;
    const next: PersistedStageCheckpoint = {
      stage,
      status: mapLegacyStatus(row.status),
      outputText: row.text ?? null,
      errorCode: row.errorCode ?? null,
      errorMessage: row.error ?? null,
    };
    const prev = map.get(stage);
    if (!prev) {
      map.set(stage, next);
      continue;
    }
    const prevPri = PRIORITY[prev.status] ?? 0;
    const nextPri = PRIORITY[next.status] ?? 0;
    // Equal priority: later entry wins (retry history).
    if (nextPri >= prevPri) {
      map.set(stage, next);
    }
  }

  const names = options.includeBrief
    ? ['draft', 'review', 'factCheck', 'brief', 'proof']
    : ['draft', 'review', 'factCheck', 'proof'];
  return names.map(stage => {
    return (
      map.get(stage) || {
        stage: stage as PipelineStageName,
        status: 'pending' as StageStatus,
        outputText: null,
      }
    );
  });
}

export function getCheckpoint(
  stages: PersistedStageCheckpoint[],
  stage: PipelineStageName,
): PersistedStageCheckpoint {
  return (
    stages.find(s => s.stage === stage) || {
      stage,
      status: 'pending',
      outputText: null,
    }
  );
}

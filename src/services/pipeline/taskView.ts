/**
 * Build durable task views for determineNextPipelineAction from DB/store rows.
 */
import type { PipelineMode, PipelineTask } from '../../types/pipeline';
import {
  parsePersistedPipelineTaskContext,
  type ParsedPipelineTaskContext,
} from '../pipelineTaskContext';
import type {
  PersistedPipelineTaskView,
  PersistedStageCheckpoint,
  PipelineCheckpointStage,
  StageStatus,
} from './types';
import type { PipelineStageCheckpointRow } from '../../data/repositories/pipelineStageCheckpointRepository';
import { projectStageResultsToCheckpoints } from './projectStageCheckpoints';

export function checkpointsFromRows(
  rows: PipelineStageCheckpointRow[],
): PersistedStageCheckpoint[] {
  const names: PipelineCheckpointStage[] = rows.some(row => row.stage === 'brief')
    ? ['draft', 'review', 'factCheck', 'brief', 'proof']
    : ['draft', 'review', 'factCheck', 'proof'];
  const map = new Map(rows.map(r => [r.stage, r]));
  return names.map(stage => {
    const row = map.get(stage);
    if (!row) {
      return {
        stage,
        status: 'pending' as StageStatus,
        outputText: null,
      };
    }
    return {
      stage,
      status: row.status,
      outputText: row.outputText,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      attemptCount: row.attemptCount,
    };
  });
}

/**
 * Prefer durable checkpoint rows; fall back to projecting stageResults.
 */
export function resolveStageCheckpoints(params: {
  checkpointRows?: PipelineStageCheckpointRow[] | null;
  stageResults?: PipelineTask['stageResults'];
  outlineWorkflowVersion?: number | null;
  contextBudgetVersion?: number | null;
}): PersistedStageCheckpoint[] {
  if (params.checkpointRows && params.checkpointRows.length > 0) {
    return checkpointsFromRows(params.checkpointRows);
  }
  return projectStageResultsToCheckpoints(params.stageResults || [], {
    includeBrief:
      [3, 4].includes(Number(params.outlineWorkflowVersion)) &&
      [3, 4].includes(Number(params.contextBudgetVersion)),
  });
}

export function buildPersistedTaskView(
  task: Pick<
    PipelineTask,
    | 'id'
    | 'status'
    | 'finalText'
    | 'pipelineContextJson'
    | 'pipelineContextHash'
    | 'pipelineContextVersion'
    | 'outlineWorkflowVersion'
    | 'contextBudgetVersion'
    | 'error'
  >,
  options?: {
    parsed?: ParsedPipelineTaskContext | null;
    allowMissingContext?: boolean;
  },
): PersistedPipelineTaskView {
  let parsed = options?.parsed ?? null;
  if (!parsed && task.pipelineContextJson) {
    try {
      parsed = parsePersistedPipelineTaskContext({
        pipelineContextJson: task.pipelineContextJson,
        pipelineContextHash: task.pipelineContextHash,
        pipelineContextVersion: task.pipelineContextVersion,
      });
    } catch {
      parsed = null;
    }
  }

  const mode: PipelineMode | null =
    parsed?.execution?.pipelineMode ?? null;
  const outlineWorkflowVersion =
    parsed?.execution?.outlineWorkflowVersion ?? task.outlineWorkflowVersion ?? null;
  const contextBudgetVersion =
    parsed?.execution?.contextBudgetVersion ?? task.contextBudgetVersion ?? null;

  return {
    id: task.id,
    status: task.status,
    pipelineMode: mode,
    outlineWorkflowVersion,
    contextBudgetVersion,
    hasExecutionSnapshot: Boolean(parsed?.execution),
    hasDraftContext: Boolean(parsed?.draftContext),
    hasAuditContext: Boolean(parsed?.auditContext),
    finalText: task.finalText,
    terminalFailed: task.status === 'failed',
  };
}

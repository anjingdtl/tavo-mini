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
import {
  isCompactPipelineTopology,
  shouldIncludeBriefCheckpoint,
} from './outlineWorkflowVersion';

/**
 * Stage names the state machine consults for a task. Compact Standard (二 Phase
 * §6/§7) replaces Review/Audit/FactCheck with a unified `qa` stage (Phase 4
 * §7.2 ONE QA) and has NO proof node (Phase 3 §6.2). The compact DAG is
 * therefore draft → qa → brief (when present) → finalize.
 */
export function stageNamesForPipelineTopology(params: {
  hasBrief?: boolean;
  pipelineTopologyVersion?: unknown;
}): PipelineCheckpointStage[] {
  if (isCompactPipelineTopology(params.pipelineTopologyVersion)) {
    return params.hasBrief
      ? ['draft', 'qa', 'brief']
      : ['draft', 'qa'];
  }
  return params.hasBrief
    ? ['draft', 'review', 'factCheck', 'brief', 'proof']
    : ['draft', 'review', 'factCheck', 'proof'];
}

export function checkpointsFromRows(
  rows: PipelineStageCheckpointRow[],
  options?: { pipelineTopologyVersion?: unknown },
): PersistedStageCheckpoint[] {
  const names = stageNamesForPipelineTopology({
    hasBrief: rows.some(row => row.stage === 'brief'),
    pipelineTopologyVersion: options?.pipelineTopologyVersion,
  });
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
  pipelineTopologyVersion?: number | null;
}): PersistedStageCheckpoint[] {
  if (params.checkpointRows && params.checkpointRows.length > 0) {
    return checkpointsFromRows(params.checkpointRows, {
      pipelineTopologyVersion: params.pipelineTopologyVersion,
    });
  }
  return projectStageResultsToCheckpoints(params.stageResults || [], {
    includeBrief: shouldIncludeBriefCheckpoint({
      outlineWorkflowVersion: params.outlineWorkflowVersion,
      contextBudgetVersion: params.contextBudgetVersion,
    }),
    includeProof: !isCompactPipelineTopology(params.pipelineTopologyVersion),
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
    | 'pipelineTopologyVersion'
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
    // §5.2: the topology is frozen on the task row at creation; resume reads
    // this frozen value, never the live CURRENT_PIPELINE_TOPOLOGY_VERSION.
    pipelineTopologyVersion: task.pipelineTopologyVersion ?? null,
    // Frozen with the execution snapshot; resume never re-reads the setting.
    executionProfile:
      parsed?.execution?.executionProfile === 'one_shot'
        ? 'one_shot'
        : 'standard',
    hasExecutionSnapshot: Boolean(parsed?.execution),
    hasDraftContext: Boolean(parsed?.draftContext),
    hasAuditContext: Boolean(parsed?.auditContext),
    finalText: task.finalText,
    terminalFailed: task.status === 'failed',
  };
}

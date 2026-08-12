import {
  createDerivedPipelineTaskWithCheckpoints,
  getPipelineTaskContextPayload,
  getPipelineTaskFinalTextPayload,
  getPipelineTaskForDerivedFinalRewrite,
} from '../../data/repositories/pipelineTaskRepository';
import {
  checkpointsToStageResults,
  getStageCheckpointsForDerivedFinalRewrite,
} from '../../data/repositories/pipelineStageCheckpointRepository';
import { parsePersistedPipelineTaskContext } from '../pipelineTaskContext';
import { getPipelineStageOrder } from '../../utils/stages';
import { shouldIncludeBriefCheckpoint } from './outlineWorkflowVersion';
import { usePipelineTaskStore } from '../../store/pipelineTaskStore';
import type { PipelineTask } from '../../types/pipeline';
import {
  hashContextAutomationPolicyV3,
  isContextAutomationPolicyV3,
} from '../contextAutomationPolicy';

export const DERIVED_FINAL_REWRITE_KIND = 'final_rewrite' as const;
const MAX_DERIVED_INSTRUCTION_LENGTH = 2000;

function makeDerivedTaskId(): string {
  return `pt_rewrite_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

function hasFrozenV3Policy(parsed: {
  execution: {
    contextAutomationPolicyVersion?: string;
    contextAutomationPolicyHash?: string;
    contextAutomationPolicySnapshot?: unknown;
  };
  draftContext: {
    contextBudgetV3Summary?: {
      contextAutomationPolicyVersion?: string;
      contextAutomationPolicyHash?: string;
      contextAutomationPolicySnapshot?: unknown;
    };
  };
}): boolean {
  const executionPolicy = parsed.execution;
  if (
    executionPolicy.contextAutomationPolicyVersion ===
      'context-automation-v3' &&
    isContextAutomationPolicyV3(executionPolicy.contextAutomationPolicySnapshot) &&
    typeof executionPolicy.contextAutomationPolicyHash === 'string' &&
    executionPolicy.contextAutomationPolicyHash ===
      hashContextAutomationPolicyV3(executionPolicy.contextAutomationPolicySnapshot)
  ) {
    return true;
  }

  const summary = parsed.draftContext.contextBudgetV3Summary;
  return Boolean(
    summary?.contextAutomationPolicyVersion === 'context-automation-v3' &&
      isContextAutomationPolicyV3(summary.contextAutomationPolicySnapshot) &&
      typeof summary.contextAutomationPolicyHash === 'string' &&
      summary.contextAutomationPolicyHash ===
        hashContextAutomationPolicyV3(summary.contextAutomationPolicySnapshot),
  );
}

/**
 * Create a child task that reuses the parent's frozen evidence and performs
 * exactly one new Final call. The parent is never mutated or resolved.
 */
export async function createDerivedFinalRewriteTask(
  parentTaskId: string,
  instruction: string,
): Promise<PipelineTask> {
  const normalizedInstruction = String(instruction || '').trim();
  if (!normalizedInstruction) {
    throw new Error('请先填写终稿修订要求。');
  }
  if (normalizedInstruction.length > MAX_DERIVED_INSTRUCTION_LENGTH) {
    throw new Error(`终稿修订要求不能超过 ${MAX_DERIVED_INSTRUCTION_LENGTH} 字。`);
  }

  const parent = await getPipelineTaskForDerivedFinalRewrite(parentTaskId);
  if (!parent) throw new Error('原流水线任务不存在，无法创建派生终稿。');
  if (parent.targetType !== 'chapter') {
    throw new Error('仅章节流水线支持“仅重写终稿”。');
  }
  const parentFinalText = await getPipelineTaskFinalTextPayload(parent.id);
  if (parent.status !== 'completed' || !String(parentFinalText || '').trim()) {
    throw new Error('原任务尚未完成，不能只重写终稿。');
  }
  const parentWorkflowVersion = Number(parent.outlineWorkflowVersion);
  if (
    !shouldIncludeBriefCheckpoint({
      outlineWorkflowVersion: parentWorkflowVersion,
      contextBudgetVersion: Number(parent.contextBudgetVersion),
    })
  ) {
    throw new Error('仅重写终稿仅适用于结构化完整流水线；请重新运行完整流水线。');
  }

  const parentContextJson = await getPipelineTaskContextPayload(parent.id);
  const parentForContext = {
    ...parent,
    pipelineContextJson: parentContextJson,
  };
  let parsed;
  try {
    parsed = parsePersistedPipelineTaskContext(parentForContext, {
      expectedChapterId: Number(parent.targetId),
    });
  } catch {
    throw new Error('原任务冻结证据无效，无法安全派生终稿；请重新运行完整流水线。');
  }
  if (
    !parsed.execution ||
    ![3, 4, 5].includes(Number(parsed.execution.reasoningProfileVersion)) ||
    !shouldIncludeBriefCheckpoint({
      outlineWorkflowVersion: parsed.execution.outlineWorkflowVersion,
      contextBudgetVersion: parsed.execution.contextBudgetVersion,
    })
  ) {
    throw new Error('原任务不是当前结构化冻结配置，已阻止派生终稿。');
  }
  if (
    Number(parsed.execution.contextBudgetVersion) === 6 &&
    !hasFrozenV3Policy(parsed as Parameters<typeof hasFrozenV3Policy>[0])
  ) {
    throw new Error('原任务缺少有效的 V3 冻结策略，已阻止派生终稿；请重新运行完整流水线。');
  }
  if (parsed.execution.pipelineMode === 'noReview') {
    throw new Error('无审核模式没有 Brief，不能只重写终稿；请运行完整流水线。');
  }

  const sourceCheckpoints = await getStageCheckpointsForDerivedFinalRewrite(
    parent.id,
  );
  const byStage = new Map(sourceCheckpoints.map(row => [row.stage, row]));
  const required = getPipelineStageOrder(parsed.execution.pipelineMode, {
    outlineWorkflowVersion: parentWorkflowVersion,
    contextBudgetVersion: parsed.execution.contextBudgetVersion,
  });
  for (const stage of required) {
    const row = byStage.get(stage);
    if (stage === 'proof') {
      if (row?.status !== 'succeeded' || !String(row.outputText || '').trim()) {
        throw new Error('原任务缺少已验证终稿，不能只重写终稿。');
      }
      continue;
    }
    if (row?.status !== 'succeeded' || !String(row.outputText || '').trim()) {
      throw new Error(`原任务的 ${stage} 阶段证据不完整，请运行完整流水线。`);
    }
  }

  const now = Date.now();
  const taskId = makeDerivedTaskId();
  const upstreamResults = checkpointsToStageResults(sourceCheckpoints).filter(
    stage => stage.stage !== 'proof',
  ).map(stage => ({
    ...stage,
    stage: stage.stage as PipelineTask['stageResults'][number]['stage'],
  }));
  const copiedCheckpoints = sourceCheckpoints
    .filter(row => row.stage !== 'proof' && row.stage !== 'finalize')
    .map(row => ({
      ...row,
      taskId,
    }));
  const proofCheckpoint = {
    taskId,
    stage: 'proof' as const,
    status: 'pending' as const,
    outputText: null,
    errorCode: null,
    errorMessage: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    durationMs: null,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    updatedAt: now,
  };
  const child: PipelineTask = {
    id: taskId,
    targetType: 'chapter',
    targetId: Number(parent.targetId),
    status: 'idle',
    stageResults: upstreamResults,
    finalText: null,
    error: null,
    inputFingerprint: parent.inputFingerprint ?? null,
    pipelineContextJson: parentContextJson,
    pipelineContextVersion: parent.pipelineContextVersion ?? null,
    pipelineContextHash: parent.pipelineContextHash ?? null,
    outlineWorkflowVersion: parentWorkflowVersion as 3 | 4,
    contextBudgetVersion: Number(parent.contextBudgetVersion) as 3 | 4 | 5 | 6,
    parentTaskId: parent.id,
    derivedKind: DERIVED_FINAL_REWRITE_KIND,
    derivedInstruction: normalizedInstruction,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    resolvedAction: null,
  };

  await createDerivedPipelineTaskWithCheckpoints(
    {
      ...child,
      parentTaskId: parent.id,
      derivedKind: DERIVED_FINAL_REWRITE_KIND,
      derivedInstruction: normalizedInstruction,
    },
    [
      ...copiedCheckpoints,
      proofCheckpoint,
    ],
  );
  usePipelineTaskStore.getState().registerPersistedTask(child);
  return child;
}

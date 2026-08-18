import { usePipelineTaskStore } from '../../../store/pipelineTaskStore';
import * as db from '../../database';
import type { Chapter } from '../../../types/novel';
import type {
  SharedWritingArtifact,
  SharedWritingStageName,
  SharedWritingStageResult,
  WritingDurablePersistAdapter,
  WritingStageArtifacts,
} from '../contracts/writingStage';

function pipelineStageName(stage: SharedWritingStageName): string {
  if (stage === 'revision') return 'brief';
  return stage;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '阶段失败');
}

export function createOutlineDurableAdapter(input: {
  taskId: string;
  chapter: Chapter;
}): WritingDurablePersistAdapter {
  return {
    binding: 'outline-pipeline-tasks',
    async loadExisting(stage) {
      const store = usePipelineTaskStore.getState();
      const task = store.tasks.find(item => item.id === input.taskId);
      const mapped = pipelineStageName(stage);
      const row = task?.stageResults?.find(
        item => item.stage === mapped && item.status === 'success' && item.text,
      );
      if (row?.text) {
        return { stage, body: row.text };
      }
      if (stage === 'finalValidate' || stage === 'persist') {
        const proof = task?.stageResults?.find(
          item => item.stage === 'proof' && item.status === 'success' && item.text,
        );
        if (proof?.text) return { stage, body: proof.text };
        const draft = task?.stageResults?.find(
          item => item.stage === 'draft' && item.status === 'success' && item.text,
        );
        if (draft?.text) return { stage, body: draft.text };
      }
      return null;
    },
    async persistStageArtifact(stage, artifact) {
      if (stage === 'finalValidate' || stage === 'persist') return;
      if (stage === 'audit' && !artifact.body.trim()) return;
      const store = usePipelineTaskStore.getState();
      const result = {
        stage: pipelineStageName(stage),
        text: artifact.body || '',
        status: artifact.body.trim() ? 'success' : 'skipped',
        durationMs: 0,
        inputTokens: artifact.usage?.inputTokens,
        outputTokens: artifact.usage?.outputTokens,
        totalTokens: artifact.usage?.totalTokens,
        tokens: artifact.usage
          ? {
              input: artifact.usage.inputTokens,
              output: artifact.usage.outputTokens,
              total: artifact.usage.totalTokens,
              reasoning: 0,
              visible: artifact.usage.outputTokens,
            }
          : undefined,
      };
      if (store.persistTaskStage) {
        await store.persistTaskStage(input.taskId, result as any);
      } else {
        store.updateTaskStage(input.taskId, result as any);
      }
      if (typeof db.upsertStageCheckpoint === 'function') {
        await db.upsertStageCheckpoint({
          taskId: input.taskId,
          stage: pipelineStageName(stage) as any,
          status: artifact.body.trim() ? 'succeeded' : 'skipped',
          outputText: artifact.body || '',
          inputTokens: artifact.usage?.inputTokens,
          outputTokens: artifact.usage?.outputTokens,
          totalTokens: artifact.usage?.totalTokens,
        });
      }
    },
    async persistStageSkip(stage, result: SharedWritingStageResult) {
      if (stage === 'finalValidate' || stage === 'persist') return;
      const store = usePipelineTaskStore.getState();
      const mapped = pipelineStageName(stage);
      const skipResult = {
        stage: mapped,
        text: '',
        status: 'skipped' as const,
        error: result.skipReason || 'policy_skipped',
        durationMs: 0,
      };
      if (store.persistTaskStage) {
        await store.persistTaskStage(input.taskId, skipResult as any);
      } else {
        store.updateTaskStage(input.taskId, skipResult as any);
      }
      if (typeof db.upsertStageCheckpoint === 'function') {
        await db.upsertStageCheckpoint({
          taskId: input.taskId,
          stage: mapped as any,
          status: 'skipped',
          errorCode: result.policyRuleId || 'STAGE_SKIPPED',
          errorMessage: result.skipReason || 'policy_skipped',
        });
      }
    },
    async persistStageFailure(stage, error) {
      if (stage === 'finalValidate' || stage === 'persist') return;
      const message = failureMessage(error);
      const store = usePipelineTaskStore.getState();
      const result = {
        stage: pipelineStageName(stage),
        text: '',
        status: 'failed',
        error: message,
        durationMs: 0,
      };
      if (store.persistTaskStage) {
        await store.persistTaskStage(input.taskId, result as any);
      } else {
        store.updateTaskStage(input.taskId, result as any);
      }
      if (typeof db.upsertStageCheckpoint === 'function') {
        await db.upsertStageCheckpoint({
          taskId: input.taskId,
          stage: pipelineStageName(stage) as any,
          status: 'failed',
          errorCode: 'STAGE_FAILED',
          errorMessage: message,
        });
      }
    },
    async persistFinal(artifacts: WritingStageArtifacts) {
      const body = readFinalBody(artifacts);
      const store = usePipelineTaskStore.getState();
      if (store.persistTaskFinalText) {
        await store.persistTaskFinalText(input.taskId, body);
      } else {
        store.setTaskFinalText?.(input.taskId, body);
      }
      void input.chapter;
    },
  };
}

function readFinalBody(artifacts: WritingStageArtifacts): string {
  for (const key of ['finalValidate', 'proof', 'revision', 'draft']) {
    const value = artifacts[key] as SharedWritingArtifact | string | undefined;
    if (!value) continue;
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'object' && typeof value.body === 'string' && value.body.trim()) {
      return value.body;
    }
  }
  return '';
}

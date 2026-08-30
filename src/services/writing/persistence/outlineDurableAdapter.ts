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
import {
  finalCandidateModeForPolicy,
  resolvePersistenceBoundaryCandidate,
} from '../stages/finalCandidate';

function pipelineStageName(stage: SharedWritingStageName): string {
  if (stage === 'revision') return 'brief';
  return stage;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '阶段失败');
}

function persistedStageText(
  stage: SharedWritingStageName,
  artifact: SharedWritingArtifact,
): string {
  // QA's body is only its human summary. Preserve the validated envelope at
  // the action boundary so a later run_brief can preload structured findings.
  if (stage === 'qa' && artifact.structured) {
    return JSON.stringify(artifact.structured);
  }
  return artifact.body || '';
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
        if (stage === 'qa') {
          try {
            const structured = JSON.parse(row.text);
            if (
              structured &&
              typeof structured === 'object' &&
              !Array.isArray(structured)
            ) {
              return {
                stage,
                body:
                  typeof structured.content === 'string' &&
                  structured.content.trim()
                    ? structured.content
                    : row.text,
                structured,
              };
            }
          } catch {
            // Historical QA rows stored only the human summary; keep them
            // visible but let strict admission/aggregation fail closed.
          }
        }
        return { stage, body: row.text };
      }
      if (stage === 'finalValidate' || stage === 'persist') {
        // `brief` is the durable outline-pipeline name for the current
        // Revision result.  Final validation/persistence preload the current
        // candidate, so prefer it before historical proof/draft fallbacks.
        // Otherwise a successful B7 repair can be overwritten by the Draft
        // when finalValidate asks the adapter to load an existing body.
        const revision = task?.stageResults?.find(
          item => item.stage === 'brief' && item.status === 'success' && item.text,
        );
        if (revision?.text) return { stage, body: revision.text };
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
      // Phase 4 §7.2: the unified `qa` stage is the compact Standard's QA
      // artifact. Empty body is still skipped so adoption doesn't pick up
      // an empty revision-trigger source.
      if ((stage === 'qa' || stage === 'audit') && !artifact.body.trim()) return;
      const store = usePipelineTaskStore.getState();
      const text = persistedStageText(stage, artifact);
      const result = {
        stage: pipelineStageName(stage),
        text,
        status: text.trim() ? 'success' : 'skipped',
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
      const store = usePipelineTaskStore.getState();
      const existing = store.tasks.find(item => item.id === input.taskId);
      const body = resolvePersistenceBoundaryCandidate(artifacts, {
        mode: finalCandidateModeForPolicy({
          values: {
            pipelineTopologyVersion:
              existing?.pipelineTopologyVersion === 2
                ? 'compact_standard'
                : 'legacy_standard',
          },
        }),
      }).body;
      if (!shouldPersistFinalBody(existing?.finalText, body)) return;
      if (store.persistTaskFinalText) {
        await store.persistTaskFinalText(input.taskId, body);
      } else {
        store.setTaskFinalText?.(input.taskId, body);
      }
      void input.chapter;
    },
  };
}

/**
 * Final body persistence is a durable idempotency boundary.  A process can
 * die after the final text row is committed but before the task reaches its
 * terminal status; replay must not write the same final body a second time.
 */
export function shouldPersistFinalBody(
  existingBody: string | null | undefined,
  nextBody: string,
): boolean {
  const next = String(nextBody || '').trim();
  if (!next) return false;
  return String(existingBody || '').trim() !== next;
}

/**
 * Automatic pipeline result adoption (Phase 6 core; Phase 7 unifies with the
 * manual result screen).
 *
 * Keeps EVERY existing adoption side effect:
 *   - old body saved as a content revision
 *   - chapter.content written (status stays 'draft' — batch never finalizes)
 *   - updated_at bumped
 *   - pipeline task resolved (accept)
 *   - story memory dirty mark (from adopted chapter position)
 *   - store refresh handled by the caller (store layer)
 *
 * Idempotency: the adoption fingerprint
 *   sha256(batchId|ordinal|chapterId|pipelineTaskId|finalTextHash)
 * is persisted on the item; a repeated reconcile sees the same fingerprint
 * and skips re-writing content / re-creating revisions.
 */
import * as db from '../database';
import { createContentRevision, getLatestContentRevision } from '../../data/repositories/contentRepository';
import { getPipelineTaskById } from '../../data/repositories/pipelineTaskRepository';
import { getBatchItem } from '../../data/repositories/multiChapterBatchRepository';
import { sha256Hex } from '../continuation/hashUtils';
import { usePipelineTaskStore } from '../../store/pipelineTaskStore';
import { MultiChapterBatchError } from './errors';
import type { BatchItemCompletionQuality } from '../../types/multiChapterBatch';

export interface AdoptPipelineTaskResultInput {
  taskId: string;
  chapterId: number;
  source: 'manual' | 'multi_chapter_batch';
  /** Present for batch adoption; the idempotency key lives on the item. */
  batchId?: string;
  ordinal?: number;
  /** Only user-confirmed downgrades pass this (defaults to full_pipeline). */
  completionQuality?: BatchItemCompletionQuality;
}

export interface AdoptPipelineTaskResultOutput {
  adoptedRevisionId: number | null;
  adoptionFingerprint: string;
  finalText: string;
  alreadyAdopted: boolean;
}

export function computeAdoptionFingerprint(params: {
  batchId?: string;
  ordinal?: number;
  chapterId: number;
  pipelineTaskId: string;
  finalText: string;
}): string {
  const finalTextHash = sha256Hex(params.finalText).slice(0, 16);
  return sha256Hex(
    [
      params.batchId || 'manual',
      params.ordinal ?? 0,
      params.chapterId,
      params.pipelineTaskId,
      finalTextHash,
    ].join('|'),
  ).slice(0, 32);
}

/**
 * Adopt a completed pipeline result. Batch callers MUST pass batchId+ordinal
 * so the idempotency fingerprint is persisted on the item (the batch
 * reconciler then checks item.adoption_fingerprint before re-adopting).
 */
export async function adoptPipelineTaskResult(
  input: AdoptPipelineTaskResultInput,
): Promise<AdoptPipelineTaskResultOutput> {
  const task = await getPipelineTaskById(input.taskId);
  if (!task) {
    throw new MultiChapterBatchError(
      'BATCH_ADOPTION_FAILED',
      '找不到流水线任务，无法采用结果',
    );
  }
  const finalText = String(task.finalText || '');
  if (!finalText.trim()) {
    throw new MultiChapterBatchError(
      'BATCH_ADOPTION_FAILED',
      '任务没有可采用的正文',
    );
  }
  const chapter = await db.getChapterById(input.chapterId);
  if (!chapter) {
    throw new MultiChapterBatchError(
      'BATCH_ADOPTION_FAILED',
      '章节不存在，无法采用结果',
    );
  }
  const fingerprint = computeAdoptionFingerprint({
    batchId: input.batchId,
    ordinal: input.ordinal,
    chapterId: input.chapterId,
    pipelineTaskId: input.taskId,
    finalText,
  });

  // Idempotency: the item (or the latest revision) already carries this
  // adoption — repeated reconcile must not duplicate content or revisions.
  const item = input.batchId
    ? await getBatchItem(input.batchId, input.ordinal ?? 0)
    : null;
  if (item?.adoptionFingerprint === fingerprint) {
    return {
      adoptedRevisionId: item.adoptedRevisionId,
      adoptionFingerprint: fingerprint,
      finalText,
      alreadyAdopted: true,
    };
  }
  const latestRevision = await getLatestContentRevision(
    'chapter',
    chapter.id,
  );
  if (latestRevision?.sourceRef === input.taskId) {
    return {
      adoptedRevisionId: latestRevision.id,
      adoptionFingerprint: fingerprint,
      finalText,
      alreadyAdopted: true,
    };
  }

  // 1. Save the OLD body as a revision (content history preservation).
  const oldContent = String(chapter.content || '');
  if (oldContent.trim()) {
    await createContentRevision({
      projectId: chapter.project_id,
      targetType: 'chapter',
      targetId: chapter.id,
      title: chapter.title || '',
      content: oldContent,
      source: 'adoption_previous',
      sourceRef: input.taskId,
    });
  }

  // 2. Write the new body; batch adoption keeps the chapter as draft.
  await db.updateChapter(chapter.id, { content: finalText });

  // 3. Record the adopted body as a pipeline revision.
  const adoptedRevisionId = await createContentRevision({
    projectId: chapter.project_id,
    targetType: 'chapter',
    targetId: chapter.id,
    title: chapter.title || '',
    content: finalText,
    source: 'pipeline',
    sourceRef: input.taskId,
  });

  // 4. Resolve the pipeline task (accept).
  try {
    usePipelineTaskStore.getState().resolveTask(input.taskId, 'accept');
  } catch {
    // store resolution is best-effort; the DB row persists via persistTask
  }

  // 5. Story memory / downstream invalidation mark.
  try {
    await db.markStoryMemoryDirtyIfCovered?.(
      chapter.project_id,
      chapter.position,
      `pipeline_adopt:${input.taskId}`,
    );
  } catch {
    // non-fatal
  }

  return {
    adoptedRevisionId,
    adoptionFingerprint: fingerprint,
    finalText,
    alreadyAdopted: false,
  };
}

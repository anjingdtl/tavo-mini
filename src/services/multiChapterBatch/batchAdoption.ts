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
import { openDatabase } from '../../data/connection/openDatabase';
import { createContentRevision, getLatestContentRevision } from '../../data/repositories/contentRepository';
import { getPipelineTaskById } from '../../data/repositories/pipelineTaskRepository';
import { getBatchItem } from '../../data/repositories/multiChapterBatchRepository';
import { buildCommitBatchItemAdoptionStatements } from '../../data/repositories/multiChapterBatchRepository';
import {
  getProjectStoryMemory,
  buildStoryMemoryContinuitySideEffects,
} from '../../data/repositories/storyMemoryRepository';
import { executeTransaction, type SqlStatement } from '../database/transaction';
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
  if (latestRevision?.source_ref === input.taskId) {
    // Crash-window guard (RB-2): the previous-content revision may have been
    // persisted while the process died BEFORE chapter.content was updated.
    // Only short-circuit when the body actually landed — otherwise re-write
    // the body and record the pipeline revision.
    const bodyLanded = String(chapter.content) === finalText;
    if (bodyLanded) {
      return {
        adoptedRevisionId: latestRevision.id,
        adoptionFingerprint: fingerprint,
        finalText,
        alreadyAdopted: true,
      };
    }
  }

  // 1. Save the OLD body as a revision (content history preservation).
  const oldContent = String(chapter.content || '');
  if (oldContent.trim()) {
    const previousAlreadyRecorded =
      latestRevision?.source_ref === input.taskId &&
      latestRevision?.source === 'adoption_previous';
    if (!previousAlreadyRecorded) {
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

/**
 * CL-07: ATOMIC batch adoption — one SQLite transaction closes the loop:
 *
 *   old-body revision → chapter.content → pipeline revision
 *   → item adoptionFingerprint / adoptedRevisionId → batch counters
 *
 * No half-committed windows: a crash or fault mid-transaction rolls back
 * EVERYTHING (body, revisions, item, counters). Story-memory dirty marking
 * stays POST-transaction best-effort (idempotent SET semantics — a repeated
 * adoption re-marks the same state) and the store resolve is in-memory
 * best-effort (the DB row persists via the store's own write).
 *
 * Returns the same shape as adoptPipelineTaskResult. `alreadyAdopted` is set
 * when the item already carries the same fingerprint (idempotent no-op).
 */
export async function adoptPipelineTaskResultAtomic(
  input: AdoptPipelineTaskResultInput & { chapterCount?: number },
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
  if (latestRevision?.source_ref === input.taskId) {
    const bodyLanded = String(chapter.content) === finalText;
    if (bodyLanded) {
      return {
        adoptedRevisionId: latestRevision.id,
        adoptionFingerprint: fingerprint,
        finalText,
        alreadyAdopted: true,
      };
    }
  }

  const oldContent = String(chapter.content || '');
  const previousAlreadyRecorded =
    latestRevision?.source_ref === input.taskId &&
    latestRevision?.source === 'adoption_previous';

  // 1. Content statements: old-body revision (optional) → chapter.content →
  //    pipeline revision.
  const statements: SqlStatement[] = [];
  if (oldContent.trim() && !previousAlreadyRecorded) {
    statements.push({
      sql: `INSERT INTO content_revisions (
              project_id, target_type, target_id, title, content, source, source_ref, created_at
            ) VALUES (?, 'chapter', ?, ?, ?, 'adoption_previous', ?, ?)`,
      params: [
        chapter.project_id,
        chapter.id,
        chapter.title || '',
        oldContent,
        input.taskId,
        new Date().toISOString(),
      ],
    });
  }
  statements.push({
    sql: `UPDATE chapters SET content = ?, updated_at = ? WHERE id = ?`,
    params: [finalText, new Date().toISOString(), chapter.id],
  });
  statements.push({
    sql: `INSERT INTO content_revisions (
            project_id, target_type, target_id, title, content, source, source_ref, created_at
          ) VALUES (?, 'chapter', ?, ?, ?, 'pipeline', ?, ?)`,
    params: [
      chapter.project_id,
      chapter.id,
      chapter.title || '',
      finalText,
      input.taskId,
      new Date().toISOString(),
    ],
  });

  // 2. Batch item binding + counters fold into the SAME transaction.
  // F2-01: the pipeline revision id only exists at execution time, so the item
  // UPDATE reads last_insert_rowid() (the statement right before it is always
  // the pipeline-revision INSERT) instead of a pre-built NULL parameter.
  let itemStatementIndex = -1;
  let counterStatementIndex = -1;
  if (input.batchId && input.ordinal != null && input.chapterCount != null) {
    const commitStatements = await buildCommitBatchItemAdoptionStatements({
      batchId: input.batchId,
      ordinal: input.ordinal,
      chapterCount: input.chapterCount,
      completionQuality: input.completionQuality ?? 'full_pipeline',
      adoptionFingerprint: fingerprint,
      adoptedRevisionId: null,
    }, { useLastInsertRowId: true });
    for (const stmt of commitStatements) {
      statements.push(stmt);
    }
    if (commitStatements.length > 0) {
      itemStatementIndex = statements.length - commitStatements.length + 1;
      counterStatementIndex = statements.length;
    }
  }

  // F2-02: task resolve + story-memory continuity side effects fold into the
  // SAME transaction. A crash right after COMMIT can no longer strand an
  // unresolved pipeline task or lose the story-memory dirty intent — both are
  // durable before the transaction returns. The post-commit store refresh and
  // best-effort mark remain only as idempotent in-memory/backstop calls.
  const nowIso = new Date().toISOString();
  const smRecord = await getProjectStoryMemory(chapter.project_id);
  const smSideEffects = buildStoryMemoryContinuitySideEffects(
    smRecord,
    chapter.project_id,
    chapter.position,
    `pipeline_adopt:${input.taskId}`,
    nowIso,
  );
  statements.push(
    {
      sql: `UPDATE pipeline_tasks SET resolved_at = ?, resolved_action = 'accept', updated_at = ? WHERE id = ?`,
      params: [nowIso, nowIso, input.taskId],
    },
    ...smSideEffects.statements,
  );

  let adoptedRevisionId: number | null = null;
  // Pipeline revision is the LAST content statement (index 3 when an old-body
  // revision was recorded, otherwise 2). Counter statements follow it.
  const pipelineRevisionIndex =
    itemStatementIndex > 0 ? itemStatementIndex - 1 : statements.length;
  await executeTransaction(
    await openDatabase(),
    statements,
    {
      faultDomain: 'adoption',
      onStatementComplete: (index, rowsAffected, insertId) => {
        if (index === pipelineRevisionIndex) {
          adoptedRevisionId = insertId ?? null;
        }
        if (index === itemStatementIndex && rowsAffected <= 0) {
          throw new Error('BATCH_ADOPTION_MISMATCH');
        }
        if (index === counterStatementIndex && rowsAffected <= 0) {
          throw new Error('BATCH_NOT_FOUND');
        }
      },
    },
  );

  // Post-transaction best-effort (idempotent SET semantics).
  try {
    usePipelineTaskStore.getState().resolveTask(input.taskId, 'accept');
  } catch {
    // store resolution is best-effort; the DB row persists via persistTask
  }
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

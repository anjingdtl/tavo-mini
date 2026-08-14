/**
 * Continuation batch state freshness gate (doc §16, §17).
 *
 * Hard gate: until the previous chapter's state has safely settled, the next
 * chapter's LLM call count must be 0. The orchestrator consults
 * checkNextChapterReady() before creating/starting the next chapter's run and
 * fails closed on every `ready: false` answer.
 *
 * Checks (doc §16):
 *   1. the completed chapter is finalized;
 *   2. its extract_state outbox task finished (not failed);
 *   3. its rebuild_story_memory outbox task finished (not failed);
 *   4. story memory has no hard gap covering the chapter;
 *   5. the Source snapshot still matches the frozen batch anchor;
 *   6. the Canon snapshot id/revision still match the frozen anchor;
 *   7. the chapter body was not concurrently modified after finalize
 *      (content hash vs the adopted run's finalizedRevisionHash).
 */
import * as db from '../database';
import { openDatabase } from '../../data/connection/openDatabase';
import { contentRevisionHash } from '../continuation/generation/generationRepository';
import {
  getOutboxByDedupe,
  getOutboxSummary,
  findLatestAdoptedRunForChapter,
} from '../continuation/generation/generationRepository';
import { processContinuationOutbox } from '../continuation/generation/continuationStateOutboxWorker';
import { continuationSourceReader } from '../continuation/continuationSourceReader';
import { CanonQueryService } from '../continuation/canon/canonQueryService';
import type { ContinuationBatchAnchorV1 } from '../../types/multiChapterBatch';

export type StateGateResult =
  | { ready: true }
  | { ready: false; status: 'waiting'; reason: string }
  | { ready: false; status: 'blocked'; reason: string; errorCode: string };

export interface CheckNextChapterReadyInput {
  projectId: number;
  completedChapterId: number;
  completedPosition: number;
  /** Frozen batch anchor; when absent the drift checks are skipped. */
  anchor: ContinuationBatchAnchorV1 | null;
}

/** Chapter tail position drift (user added/deleted tail chapters mid-batch).
 *
 * `inFlightChapters` counts chapters the batch itself has already created for
 * still-unfinished items (0 or 1 under strict serial execution): the expected
 * tail is anchor tail + completed chapters + in-flight chapters.
 */
export async function checkContinuationTailDrift(input: {
  projectId: number;
  anchor: ContinuationBatchAnchorV1;
  completedCount: number;
  inFlightChapters?: number;
}): Promise<boolean> {
  const chapters = await db.getChaptersByProject(input.projectId);
  if (chapters.length === 0) return false;
  const positions = chapters.map((c: any) => Number(c.position));
  const tail = Math.max(...positions);
  const expectedTail =
    input.anchor.startingContinuationTailPosition +
    input.completedCount +
    (input.inFlightChapters ?? 0);
  return tail !== expectedTail;
}

export async function checkNextChapterReady(
  input: CheckNextChapterReadyInput,
): Promise<StateGateResult> {
  const { projectId, completedChapterId, completedPosition } = input;

  // 1. Finalized + body present.
  const chapter = await db.getChapterById(completedChapterId);
  if (!chapter) {
    return {
      ready: false,
      status: 'blocked',
      reason: '章节已被删除，无法确认状态同步',
      errorCode: 'BATCH_CONTINUATION_CHAPTER_CONFLICT',
    };
  }
  if (String(chapter.status || '') !== 'finalized') {
    return {
      ready: false,
      status: 'waiting',
      reason: '章节尚未定稿',
    };
  }
  const content = String(chapter.content ?? '');
  if (!content.trim()) {
    return {
      ready: false,
      status: 'blocked',
      reason: '定稿章节正文为空',
      errorCode: 'BATCH_CONTINUATION_FINALIZE_FAILED',
    };
  }

  // 7. Concurrent edit after finalize: the body hash must still match the
  // adopted run's finalized revision hash.
  const adoptedRun = await findLatestAdoptedRunForChapter(
    projectId,
    completedChapterId,
  );
  const revisionHash = contentRevisionHash(content);
  if (adoptedRun?.finalizedRevisionHash) {
    if (adoptedRun.finalizedRevisionHash !== revisionHash) {
      return {
        ready: false,
        status: 'blocked',
        reason: '定稿章节在状态同步后被手动修改',
        errorCode: 'BATCH_CONTINUATION_CHAPTER_CONFLICT',
      };
    }
  }

  // 2 + 3. Outbox settlement for this exact revision.
  const extractKey = `extract_state:${completedChapterId}:${revisionHash}`;
  const rebuildKey = `rebuild_story_memory:auto:${projectId}:${completedPosition}:${revisionHash}`;
  const [extractRow, rebuildRow] = await Promise.all([
    getOutboxByDedupe(extractKey),
    getOutboxByDedupe(rebuildKey),
  ]);
  for (const [label, row] of [
    ['状态提取', extractRow],
    ['故事记忆重建', rebuildRow],
  ] as const) {
    if (!row) {
      return {
        ready: false,
        status: 'waiting',
        reason: `${label}任务尚未入队`,
      };
    }
    if (row.state === 'failed') {
      return {
        ready: false,
        status: 'blocked',
        reason: `${label}失败：${row.lastError || '未知原因'}`,
        errorCode: 'BATCH_CONTINUATION_STATE_SYNC_FAILED',
      };
    }
    if (row.state === 'cancelled') {
      return {
        ready: false,
        status: 'blocked',
        reason: `${label}任务被取消`,
        errorCode: 'BATCH_CONTINUATION_STATE_SYNC_FAILED',
      };
    }
    if (row.state !== 'completed') {
      // pending / running / interrupted — interrupted is retried by the
      // cold-start outbox processor, so it stays a bounded wait.
      return {
        ready: false,
        status: 'waiting',
        reason: `${label}进行中（attempt ${row.attemptCount}）`,
      };
    }
  }

  // 4. Story memory hard gap covering the chapter.
  const summary = await getOutboxSummary(projectId);
  if (summary.failedCount > 0) {
    return {
      ready: false,
      status: 'blocked',
      reason: `项目存在失败的状态同步任务（${summary.failedCount} 个）`,
      errorCode: 'BATCH_CONTINUATION_STATE_SYNC_FAILED',
    };
  }
  try {
    const memory = await db.getProjectStoryMemory(projectId);
    const status = String((memory as any)?.status || '');
    const dirtyFrom = (memory as any)?.dirtyFromPosition;
    if (
      (status === 'dirty' || status === 'rebuilding') &&
      dirtyFrom != null &&
      Number(dirtyFrom) <= completedPosition
    ) {
      return {
        ready: false,
        status: 'waiting',
        reason: '故事记忆重建尚未完成',
      };
    }
  } catch {
    // non-fatal — outbox rows above are the authoritative settlement signal
  }

  // 5. Source snapshot drift vs the frozen anchor.
  if (input.anchor) {
    try {
      const snapshot = await continuationSourceReader.getSnapshot(projectId);
      if (Number(snapshot.sourceId) !== Number(input.anchor.sourceId)) {
        return {
          ready: false,
          status: 'blocked',
          reason: '续写原著源已更换',
          errorCode: 'BATCH_CONTINUATION_SOURCE_CHANGED',
        };
      }
      if (
        Number(snapshot.sourceVersion) !== Number(input.anchor.sourceVersion) ||
        snapshot.normalizedSha256 !== input.anchor.sourceSha256
      ) {
        return {
          ready: false,
          status: 'blocked',
          reason: '续写原著内容已更新',
          errorCode: 'BATCH_CONTINUATION_SOURCE_CHANGED',
        };
      }
      if (
        Number(snapshot.boundary.chapterPosition) !==
          Number(input.anchor.boundaryPosition) ||
        Number(snapshot.boundary.charOffsetExclusive) !==
          Number(input.anchor.boundaryCharOffsetExclusive)
      ) {
        return {
          ready: false,
          status: 'blocked',
          reason: '续写起点（边界）已变化',
          errorCode: 'BATCH_CONTINUATION_BOUNDARY_CHANGED',
        };
      }
    } catch {
      return {
        ready: false,
        status: 'blocked',
        reason: '续写原著源不可用或已解绑',
        errorCode: 'BATCH_CONTINUATION_SOURCE_CHANGED',
      };
    }

    // 6. Canon snapshot drift vs the frozen anchor.
    try {
      const canon = await CanonQueryService.getActiveSnapshot(projectId);
      if (String(canon.id) !== String(input.anchor.canonSnapshotId)) {
        return {
          ready: false,
          status: 'blocked',
          reason: 'Canon 快照已变化',
          errorCode: 'BATCH_CONTINUATION_CANON_CHANGED',
        };
      }
      if (Number(canon.revision) !== Number(input.anchor.canonRevision)) {
        return {
          ready: false,
          status: 'blocked',
          reason: 'Canon 版本已变化',
          errorCode: 'BATCH_CONTINUATION_CANON_CHANGED',
        };
      }
    } catch {
      return {
        ready: false,
        status: 'blocked',
        reason: 'Canon 快照不可用',
        errorCode: 'BATCH_CONTINUATION_CANON_CHANGED',
      };
    }
  }

  return { ready: true };
}

/** Kick the outbox processor once (best-effort acceleration, doc §17). */
export async function accelerateContinuationOutbox(): Promise<void> {
  processContinuationOutbox({ limit: 2 }).catch(() => {});
}

/** Direct SQL fallback for tests/tools: read the story memory status row. */
export async function readStoryMemoryStatus(
  projectId: number,
): Promise<{ status: string | null; dirtyFromPosition: number | null } | null> {
  const database = await openDatabase();
  const [res] = await database.executeSql(
    'SELECT status, dirty_from_position FROM project_story_memory WHERE project_id = ?',
    [projectId],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows.item(0) as {
    status: string | null;
    dirty_from_position: number | null;
  };
  return {
    status: row.status,
    dirtyFromPosition:
      row.dirty_from_position != null ? Number(row.dirty_from_position) : null,
  };
}

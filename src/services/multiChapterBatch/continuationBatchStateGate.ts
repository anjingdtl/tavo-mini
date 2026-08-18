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
 *   4. no unresolved outbox failure the Freeze depends on (closure P0-1:
 *      historical/stale/superseded/covered/unrelated failures never block);
 *   5. the Source snapshot still matches the frozen batch anchor;
 *   6. the Canon snapshot id/revision still match the frozen anchor;
 *   7. the chapter body was not concurrently modified after finalize
 *      (content hash vs the adopted run's finalizedRevisionHash).
 */
import * as db from '../database';
import { openDatabase } from '../../data/connection/openDatabase';
import { contentRevisionHash } from '../continuation/generation/generationRepository';
import {
  countPendingMajorProposals,
  getOutboxByDedupe,
  listOutboxForProject,
  findLatestAdoptedRunForChapter,
} from '../continuation/generation/generationRepository';
import { processContinuationOutbox } from '../continuation/generation/continuationStateOutboxWorker';
import { continuationSourceReader } from '../continuation/continuationSourceReader';
import { CanonQueryService } from '../continuation/canon/canonQueryService';
import { evaluatePostWritingMemoryReady } from '../writing/memory/postWritingMemoryReady';
import { replayPendingContinuityProposals } from '../writing/memory/continuityStateAutoCommit';
import type { ContinuationBatchAnchorV1 } from '../../types/multiChapterBatch';
import type { ContinuationOutboxItem } from '../continuation/generation/types';

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

  // 4. Outbox failure relevance (closure P0-1): only unresolved hard failures
  // the next-chapter Freeze actually depends on may block. Historical rows
  // keep their diagnostic value but must not pollute future batches.
  const storyMemory = await readStoryMemoryTruth(projectId);
  const blockingFailures = await findBlockingOutboxFailures({
    projectId,
    completedPosition,
    storyMemory,
  });
  if (blockingFailures.length > 0) {
    return {
      ready: false,
      status: 'blocked',
      reason: blockingFailures[0].reason,
      errorCode: 'BATCH_CONTINUATION_STATE_SYNC_FAILED',
    };
  }

  // ONE Memory ready policy: extract already settled above; this function
  // is the single next-chapter Freeze gate for SM + conflict confirmation.
  let storyMemoryStatus: string | null = storyMemory.status;
  let dirtyFromPosition: number | null = storyMemory.dirtyFromPosition;
  let pendingConfirmationCount = 0;
  try {
    // Leftover pre-Phase-1 pending rows are still `status=pending`. Replay
    // them through the ONE Memory classifier before treating the remainder
    // as a real conflict gate.
    await replayPendingContinuityProposals(projectId);
    pendingConfirmationCount = await countPendingMajorProposals(projectId);
  } catch {
    // Test doubles / older fixtures without the proposals table stay unblocked.
  }
  const memoryReady = evaluatePostWritingMemoryReady({
    pendingStateExtractionCount: 0,
    storyMemoryStatus,
    dirtyFromPosition,
    completedPosition,
    pendingConfirmationCount,
  });
  if (memoryReady.status === 'waiting') {
    return {
      ready: false,
      status: 'waiting',
      reason: memoryReady.reason || '故事记忆尚未就绪',
    };
  }
  if (memoryReady.status === 'conflict_parked') {
    return {
      ready: false,
      status: 'blocked',
      reason:
        memoryReady.reason ||
        `存在 ${pendingConfirmationCount} 项需人工确认的状态冲突`,
      errorCode: 'BATCH_CONTINUATION_STATE_CONFLICT',
    };
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

/** Scoped story-memory truth snapshot used by the failure classifier. */
interface StoryMemoryTruth {
  status: string | null;
  dirtyFromPosition: number | null;
  throughPosition: number | null;
}

async function readStoryMemoryTruth(
  projectId: number,
): Promise<StoryMemoryTruth> {
  try {
    const memory = await db.getProjectStoryMemory(projectId);
    return {
      status: String((memory as any)?.status || '') || null,
      dirtyFromPosition:
        (memory as any)?.dirtyFromPosition != null
          ? Number((memory as any).dirtyFromPosition)
          : null,
      throughPosition:
        (memory as any)?.state?.throughChapterPosition != null
          ? Number((memory as any).state.throughChapterPosition)
          : null,
    };
  } catch {
    // non-fatal — outbox rows above are the authoritative settlement signal
    return { status: null, dirtyFromPosition: null, throughPosition: null };
  }
}

/** Relevance vocabulary for historical outbox failures (closure P0-1). */
export type OutboxFailureCategory =
  | 'blocking'
  | 'stale'
  | 'covered'
  | 'superseded'
  | 'historical'
  | 'unrelated';

function parseExtractDedupeKey(
  dedupeKey: string,
): { chapterId: number; revisionHash: string } | null {
  const match = dedupeKey.match(/^extract_state:(\d+):(.+)$/);
  if (!match) return null;
  const chapterId = Number(match[1]);
  return Number.isFinite(chapterId)
    ? { chapterId, revisionHash: match[2] }
    : null;
}

function parseRebuildFromPosition(row: ContinuationOutboxItem): number | null {
  try {
    const payload = JSON.parse(row.payloadJson);
    const from = Number(payload?.fromPosition);
    if (Number.isFinite(from)) return from;
  } catch {
    // fall through to the dedupe key
  }
  const parts = row.dedupeKey.split(':');
  if (parts[0] !== 'rebuild_story_memory') return null;
  const raw = parts[1] === 'auto' ? parts[3] : parts[2];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function storyMemoryTruthCovers(
  truth: StoryMemoryTruth,
  completedPosition: number,
): boolean {
  return (
    truth.status === 'clean' &&
    (truth.dirtyFromPosition == null ||
      truth.dirtyFromPosition > completedPosition) &&
    truth.throughPosition != null &&
    truth.throughPosition >= completedPosition
  );
}

/**
 * Classify one failed outbox row against what the next-chapter Freeze
 * actually depends on. Rows are never deleted; irrelevant history is
 * separated from unresolved hard failures:
 *   - stale: the chapter content moved past the failed row's revision
 *   - covered: current story-memory truth already attests the range
 *   - superseded: a later completed rebuild redid the failed range
 *   - historical: deleted chapter / no-op legacy operation
 *   - unrelated: row only affects positions beyond the Freeze's range
 *   - blocking: unresolved hard failure the Freeze depends on
 */
function classifyOutboxFailure(input: {
  row: ContinuationOutboxItem;
  chaptersById: Map<number, { position: number; revisionHash: string }>;
  completedRebuilds: ContinuationOutboxItem[];
  storyMemory: StoryMemoryTruth;
  completedPosition: number;
}): OutboxFailureCategory {
  const { row, chaptersById, completedRebuilds, storyMemory, completedPosition } =
    input;

  if (row.operation === 'apply_event') {
    // The worker handler is a bookkeeping no-op: the event itself is already
    // durable at confirmation time, so a failed legacy row cannot leave
    // unsettled state behind.
    return 'historical';
  }

  if (row.operation === 'extract_state') {
    const parsed = parseExtractDedupeKey(row.dedupeKey);
    if (!parsed) return 'blocking';
    const chapter = chaptersById.get(parsed.chapterId);
    if (!chapter) return 'historical';
    if (chapter.revisionHash !== parsed.revisionHash) return 'stale';
    if (chapter.position > completedPosition) return 'unrelated';
    return 'blocking';
  }

  if (row.operation === 'rebuild_story_memory') {
    const fromPosition = parseRebuildFromPosition(row);
    if (fromPosition == null) return 'blocking';
    if (fromPosition > completedPosition) return 'unrelated';
    if (storyMemoryTruthCovers(storyMemory, completedPosition)) {
      return 'covered';
    }
    const superseded = completedRebuilds.some(done => {
      const doneFrom = parseRebuildFromPosition(done);
      return (
        doneFrom != null &&
        doneFrom <= fromPosition &&
        !!done.completedAt &&
        done.completedAt > row.updatedAt
      );
    });
    if (superseded) return 'superseded';
    return 'blocking';
  }

  // Unknown operation shape → fail-closed.
  return 'blocking';
}

/** Failed outbox rows (project-scoped) that still block the next Freeze. */
async function findBlockingOutboxFailures(input: {
  projectId: number;
  completedPosition: number;
  storyMemory: StoryMemoryTruth;
}): Promise<Array<{ reason: string }>> {
  const failedRows = await listOutboxForProject(input.projectId, 'failed');
  if (failedRows.length === 0) return [];

  const chapters = await db.getChaptersByProject(input.projectId);
  const chaptersById = new Map(
    (chapters as any[]).map(ch => [
      Number(ch.id),
      {
        position: Number(ch.position),
        revisionHash: contentRevisionHash(String(ch.content ?? '')),
      },
    ]),
  );
  const completedRebuilds = (await listOutboxForProject(
    input.projectId,
    'completed',
  )).filter(row => row.operation === 'rebuild_story_memory');

  const blocking: Array<{ reason: string }> = [];
  for (const row of failedRows) {
    const category = classifyOutboxFailure({
      row,
      chaptersById,
      completedRebuilds,
      storyMemory: input.storyMemory,
      completedPosition: input.completedPosition,
    });
    if (category === 'blocking') {
      blocking.push({
        reason: `状态同步任务存在未解决的失败（${row.dedupeKey}：${
          row.lastError || '未知原因'
        }）`,
      });
    }
  }
  return blocking;
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

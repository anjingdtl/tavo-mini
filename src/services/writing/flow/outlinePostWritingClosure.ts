import type { PipelineTask } from '../../../types/pipeline';
import { openDatabase } from '../../../data/connection/openDatabase';
import { executeTransaction } from '../../../data/connection/transaction';
import {
  buildStoryMemoryContinuitySideEffects,
  ensureProjectStoryMemoryRow,
  getProjectStoryMemory,
} from '../../../data/repositories/storyMemoryRepository';
import {
  getPipelineTaskById,
  updatePipelineTaskContext,
} from '../../../data/repositories/pipelineTaskRepository';
import { usePipelineTaskStore } from '../../../store/pipelineTaskStore';
import { sha256Hex } from '../../continuation/hashUtils';
import {
  buildOutboxInsertStatement,
  getOutboxByDedupe,
} from '../../continuation/generation/generationRepository';
import { v4 } from '../../uuidBridge';
import type { WritingPersistedEvent } from './writingPersistedEvent';
import {
  assertWritingPersistedEvent,
  assertWritingPersistedEventAllowsMemoryUpdate,
  buildWritingPersistedEvent,
} from './writingPersistedEvent';
import type { WritingKernelTrace } from '../contracts/frozenWritingContext';
import { appendWritingKernelStageEvent } from '../trace/writingTrace';

/**
 * Append the ONE Outline PostWriting marker to an already-finished Kernel
 * trace. Outline adoption/finalization is deliberately outside the draft
 * generation executor: the chapter body is still a draft until the user (or
 * a full-pipeline batch) finalizes it. This helper closes that exact durable
 * handoff without creating another writer or another stage runner.
 */
export function appendOutlinePostWritingClosure(input: {
  trace: WritingKernelTrace;
  durationMs: number;
}): WritingKernelTrace {
  const alreadyClosed = input.trace.events.some(
    event =>
      event.stage === 'postWritingUpdate' && event.status === 'completed',
  );
  if (alreadyClosed) return input.trace;

  const nextTrace = appendWritingKernelStageEvent(
    input.trace,
    'postWritingUpdate',
    'completed',
    'WritingPersistedEvent → Story Memory outbox queued',
  );
  const observability = nextTrace.observability;
  if (!observability) return nextTrace;
  const durationMs = Math.max(0, Number(input.durationMs) || 0);
  return {
    ...nextTrace,
    observability: {
      ...observability,
      postWriting: {
        ...observability.postWriting,
        storyMemoryUpdateMs:
          observability.postWriting.storyMemoryUpdateMs + durationMs,
        postWritingBlockingMs:
          observability.postWriting.postWritingBlockingMs + durationMs,
      },
    },
  };
}

export interface OutlineStoryMemoryPostWritingHandoff {
  eventKey: string;
  dedupeKey: string;
  outboxId: string;
  state: string;
}

/**
 * Commit the Outline PostWriting handoff to the existing ONE Memory outbox.
 *
 * Outline adoption only writes a draft and must not call this function. The
 * caller invokes it after `finalizeChapterMemory` has durably finalized the
 * chapter. The event fingerprint is the stable idempotency boundary: repeated
 * finalize/resume calls reuse the same outbox row and never create a second
 * Memory rebuild for the same body.
 */
export async function enqueueOutlineStoryMemoryPostWriting(input: {
  persistedEvent: WritingPersistedEvent;
  taskId?: string | null;
}): Promise<OutlineStoryMemoryPostWritingHandoff> {
  assertWritingPersistedEventAllowsMemoryUpdate(input.persistedEvent);
  if (input.persistedEvent.scenario !== 'outline') {
    throw new Error(
      'WRITING_POST_WRITING_SCENARIO_INVALID: Outline handoff requires an outline event',
    );
  }

  const { projectId, chapterId, chapterPosition, finalBodyFingerprint } =
    input.persistedEvent;
  const eventKey = `writing_persisted:outline:${projectId}:${chapterId}:${finalBodyFingerprint}`;
  const dedupeKey = `rebuild_story_memory:outline:${projectId}:${chapterId}:${finalBodyFingerprint}`;
  const now = new Date().toISOString();
  const outboxId = `co_${v4().replace(/-/g, '')}`;

  // Ensure the memory truth row exists before composing the same dirty/pending
  // invalidation statements used by Continuation adoption. The actual outbox
  // insert and the memory invalidation then commit together.
  await ensureProjectStoryMemoryRow(projectId);
  const memoryRecord = await getProjectStoryMemory(projectId);
  const memorySideEffects = buildStoryMemoryContinuitySideEffects(
    memoryRecord,
    projectId,
    chapterPosition,
    `outline_post_writing:${eventKey}`,
    now,
  );
  const outbox = buildOutboxInsertStatement({
    id: outboxId,
    projectId,
    chapterId,
    operation: 'rebuild_story_memory',
    payload: {
      schemaVersion: 1,
      eventKey,
      reason: 'outline_post_writing',
      fromPosition: chapterPosition,
      taskId: input.taskId ?? null,
      writingPersistedEvent: input.persistedEvent,
    },
    dedupeKey,
    ts: now,
  });
  await executeTransaction(await openDatabase(), [
    ...memorySideEffects.statements,
    outbox,
  ]);

  const canonicalRow = await getOutboxByDedupe(dedupeKey);
  return {
    eventKey,
    dedupeKey,
    outboxId: canonicalRow?.id || outboxId,
    state: canonicalRow?.state || 'pending',
  };
}

/**
 * Persist the WritingPersistedEvent and the PostWriting trace closure on the
 * same task envelope. The event is kept inside the Kernel trace so the
 * frozen draft/audit context remains byte-for-byte immutable apart from the
 * trace attachment that the Final Closure contract explicitly permits.
 */
export async function persistOutlinePostWritingClosure(input: {
  taskId: string;
  persistedEvent: WritingPersistedEvent;
  durationMs: number;
}): Promise<void> {
  const storeState = usePipelineTaskStore.getState() as any;
  const projectedTask = Array.isArray(storeState.tasks)
    ? storeState.tasks.find((task: PipelineTask) => task.id === input.taskId)
    : undefined;
  const task: PipelineTask | null = projectedTask?.pipelineContextJson
    ? projectedTask
    : await getPipelineTaskById(input.taskId).catch(() => null);
  const mustClose = Number(task?.pipelineTopologyVersion || 1) >= 2;
  if (!task?.pipelineContextJson) {
    if (mustClose || task == null) {
      throw new Error(
        `WRITING_POST_WRITING_TRACE_MISSING: Outline task ${input.taskId} has no durable Kernel context`,
      );
    }
    return;
  }

  let envelope: any;
  try {
    envelope = JSON.parse(task.pipelineContextJson);
  } catch {
    throw new Error(
      `WritingPersistedEvent persistence blocked: task ${input.taskId} context is invalid JSON`,
    );
  }

  let updated = false;
  let traceFound = false;
  for (const contextKey of ['draftContext', 'auditContext'] as const) {
    const context = envelope[contextKey];
    if (!context || typeof context !== 'object') continue;
    const trace = context.writingKernelTrace as WritingKernelTrace | undefined;
    if (!trace) continue;
    traceFound = true;
    if (
      mustClose &&
      (trace.generationTraceId !== input.persistedEvent.generationTraceId ||
        trace.freezeFingerprint !== input.persistedEvent.freezeFingerprint)
    ) {
      throw new Error(
        'WRITING_POST_WRITING_TRACE_BINDING_MISMATCH: Persisted event does not belong to the frozen Outline Kernel trace',
      );
    }
    const legacyContextEvent = context.writingPersistedEvent as
      | WritingPersistedEvent
      | undefined;
    const existingEvent = trace.writingPersistedEvent || legacyContextEvent;
    if (existingEvent) {
      assertWritingPersistedEvent(existingEvent);
      if (
        existingEvent.finalBodyFingerprint !==
          input.persistedEvent.finalBodyFingerprint ||
        existingEvent.chapterId !== input.persistedEvent.chapterId ||
        (mustClose &&
          (existingEvent.generationTraceId !==
            input.persistedEvent.generationTraceId ||
            existingEvent.freezeFingerprint !==
              input.persistedEvent.freezeFingerprint))
      ) {
        throw new Error(
          'WRITING_POST_WRITING_REVISION_DRIFT: Outline trace already belongs to another finalized revision or Freeze',
        );
      }
    }
    const nextTrace = appendOutlinePostWritingClosure({
      trace,
      durationMs: input.durationMs,
    });
    const closedTrace = existingEvent
      ? nextTrace
      : { ...nextTrace, writingPersistedEvent: input.persistedEvent };
    if (closedTrace !== trace || legacyContextEvent) {
      context.writingKernelTrace = closedTrace;
      if (legacyContextEvent) delete context.writingPersistedEvent;
      updated = true;
    }
  }
  if (mustClose && !traceFound) {
    throw new Error(
      `WRITING_POST_WRITING_TRACE_MISSING: Outline task ${input.taskId} has no durable Kernel trace`,
    );
  }
  if (!updated) return;

  const json = JSON.stringify(envelope);
  const snapshot = {
    json,
    version: Number(task.pipelineContextVersion || envelope.version || 4),
    hash: sha256Hex(json).slice(0, 32),
  };
  // This is the durable PostWriting boundary. Use the repository's targeted
  // context update directly so a best-effort/in-memory store adapter cannot
  // turn a successful chapter persist into a silent trace gap.
  await updatePipelineTaskContext(input.taskId, snapshot);
  const store = usePipelineTaskStore.getState();
  store.syncTaskPipelineContext?.(input.taskId, {
    pipelineContextJson: json,
    pipelineContextVersion: snapshot.version,
    pipelineContextHash: snapshot.hash,
  });
}

/**
 * Close an Outline task after its final body has reached durable storage.
 * Current compact tasks must carry a Kernel trace; historical task rows may
 * not, so those rows remain readable and are left untouched.
 */
export async function persistOutlinePostWritingClosureForPersistedBody(input: {
  taskId: string;
  projectId: number;
  chapterId: number;
  chapterPosition: number;
  finalBody: string;
  durationMs?: number;
}): Promise<boolean> {
  const task = await getPipelineTaskById(input.taskId).catch(() => null);
  const mustClose = Number(task?.pipelineTopologyVersion || 1) >= 2;
  if (!task?.pipelineContextJson) {
    // Historical/fault-injection fixtures can resolve a task before a
    // context snapshot exists. There is no trace to mutate in that case;
    // current production tasks are validated by their persisted snapshot.
    return false;
  }

  let envelope: any;
  try {
    envelope = JSON.parse(task.pipelineContextJson);
  } catch {
    if (mustClose) {
      throw new Error(
        'WRITING_POST_WRITING_TRACE_INVALID: Outline task context is not JSON',
      );
    }
    return false;
  }

  const context = [envelope?.draftContext, envelope?.auditContext].find(
    value =>
      value &&
      typeof value === 'object' &&
      value.writingKernelTrace?.scenario === 'outline' &&
      Array.isArray(value.writingKernelTrace.events),
  );
  const trace = context?.writingKernelTrace as WritingKernelTrace | undefined;
  if (!trace) {
    if (mustClose) {
      throw new Error(
        'WRITING_POST_WRITING_TRACE_MISSING: Outline task has no durable Kernel trace',
      );
    }
    return false;
  }

  const persistedEvent = buildWritingPersistedEvent({
    generationTraceId: trace.generationTraceId,
    freezeFingerprint: trace.freezeFingerprint,
    projectId: input.projectId,
    chapterId: input.chapterId,
    chapterPosition: input.chapterPosition,
    finalBody: input.finalBody,
    executionProfile: trace.observability?.executionProfile,
    scenario: 'outline',
  });
  await enqueueOutlineStoryMemoryPostWriting({
    persistedEvent,
    taskId: input.taskId,
  });
  await persistOutlinePostWritingClosure({
    taskId: input.taskId,
    persistedEvent,
    durationMs: input.durationMs ?? 0,
  });
  return true;
}

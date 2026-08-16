/**
 * THE single production writing entry surface (Kernel Final Closure §3.2).
 *
 * Every UI / batch / background / resume path enters writing through
 * `runWritingKernel()` (outline, freeform, resume) or the continuation
 * handoff below. No production code may call the legacy outline pipeline
 * runner or the legacy continuation generation runner.
 *
 * Outline & continuation differ ONLY before Freeze (source adapters +
 * durable substrate binding). After Freeze both run the same kernel stage
 * loop with the same gates and the same trace system.
 */
import type { Chapter } from '../../types/novel';
import {
  getPipelineTaskById,
  updatePipelineTaskContext,
} from '../../data/repositories/pipelineTaskRepository';
import {
  getRunById,
  casUpdateRunState,
} from '../continuation/generation/generationRepository';
import { sha256Hex } from '../continuation/hashUtils';
import { usePipelineTaskStore } from '../../store/pipelineTaskStore';
import type { PipelineRunOptions, StageInfo } from '../pipelineRunner';
import type {
  WritingRequest,
} from './contracts/writingSource';
import { runWritingKernel } from './unifiedWritingKernel';
import type { WritingKernelTrace } from './contracts/frozenWritingContext';
import { createOutlineStageDriver } from './execution/outlineStageDriver';
import {
  createContinuationStageDriver,
} from './execution/continuationStageDriver';
import type { StartContinuationRunInput } from './scenario/continuationWritingTypes';
import type { ContinuationGenerationRun } from '../continuation/generation/types';

export type { StageInfo } from '../pipelineRunner';

/**
 * The durable pipeline freezes the authoritative source bundle before its
 * stage driver starts. Merge post-Freeze kernel events into that exact
 * durable snapshot instead of replacing its real fingerprints.
 */
export function mergePostFreezeKernelTrace(
  existing: WritingKernelTrace,
  completed: WritingKernelTrace,
): WritingKernelTrace {
  if (existing.scenario !== completed.scenario) {
    throw new Error(
      `Writing Kernel trace scenario changed before persistence: ${existing.scenario} != ${completed.scenario}`,
    );
  }
  if (existing.generationTraceId !== completed.generationTraceId) {
    throw new Error(
      `Writing Kernel generation trace changed before persistence: ${existing.generationTraceId} != ${completed.generationTraceId}`,
    );
  }
  const lastFreezeIndex = completed.events.reduce(
    (lastIndex, event, index) =>
      event.stage === 'freeze' && event.status === 'completed'
        ? index
        : lastIndex,
    -1,
  );
  if (lastFreezeIndex < 0) {
    throw new Error(
      'Writing Kernel trace persistence blocked: trace has no completed Freeze',
    );
  }
  const postFreezeEvents = completed.events.slice(lastFreezeIndex + 1);
  if (postFreezeEvents.length === 0) {
    // Nothing to merge (e.g. a waiting hand-back before the first stage).
    return existing;
  }
  const preFreezeStages = new Set([
    'collect',
    'normalize',
    'plan',
    'allocate',
    'render',
    'freeze',
  ]);
  if (postFreezeEvents.some(event => preFreezeStages.has(event.stage))) {
    throw new Error(
      'Writing Kernel trace persistence blocked: post-Freeze bridge contains a pre-Freeze event',
    );
  }
  const seen = new Set(
    existing.events.map(event => JSON.stringify(event)),
  );
  const events = [...existing.events];
  for (const event of postFreezeEvents) {
    const key = JSON.stringify(event);
    if (!seen.has(key)) {
      seen.add(key);
      events.push(event);
    }
  }
  return {
    ...existing,
    events,
  };
}

/**
 * Outline: merge the kernel trace into the durable task envelope. A failed
 * write is fatal: a completed run without its trace is not an acceptable
 * green result.
 */
export async function persistWritingKernelTraceForTask(
  taskId: string,
  completedTrace: WritingKernelTrace,
): Promise<void> {
  const task = await getPipelineTaskById(taskId);
  if (!task?.pipelineContextJson) {
    throw new Error(
      `Writing Kernel trace persistence blocked: task ${taskId} has no context snapshot`,
    );
  }
  let envelope: any;
  try {
    envelope = JSON.parse(task.pipelineContextJson);
  } catch {
    throw new Error(
      `Writing Kernel trace persistence blocked: task ${taskId} context is invalid JSON`,
    );
  }
  let updatedContexts = 0;
  for (const contextKey of ['draftContext', 'auditContext'] as const) {
    const context = envelope[contextKey];
    if (!context || typeof context !== 'object') continue;
    const existing = context.writingKernelTrace as WritingKernelTrace | undefined;
    if (
      existing &&
      context.writingSourceTrace?.sourceFingerprint &&
      context.writingSourceTrace.sourceFingerprint !== existing.sourceFingerprint
    ) {
      throw new Error(
        `Writing Kernel trace persistence blocked: ${contextKey} source trace does not match durable Freeze`,
      );
    }
    if (!existing) {
      throw new Error(
        `Writing Kernel trace persistence blocked: ${contextKey} has no durable Freeze trace`,
      );
    }
    context.writingKernelTrace = mergePostFreezeKernelTrace(
      existing,
      completedTrace,
    );
    updatedContexts += 1;
  }
  if (updatedContexts === 0) {
    throw new Error(
      `Writing Kernel trace persistence blocked: task ${taskId} has no draft/audit context`,
    );
  }
  const json = JSON.stringify(envelope);
  await updatePipelineTaskContext(taskId, {
    json,
    version: Number(task.pipelineContextVersion || envelope.version || 4),
    hash: sha256Hex(json).slice(0, 32),
  });
  // The repository update is intentionally narrow. Keep the in-memory task
  // projection in sync as well, otherwise a later resolve/adoption save would
  // re-persist its stale full-row snapshot and erase post-Freeze events.
  usePipelineTaskStore.getState().syncTaskPipelineContext(taskId, {
    pipelineContextJson: json,
    pipelineContextVersion: Number(task.pipelineContextVersion || envelope.version || 4),
    pipelineContextHash: sha256Hex(json).slice(0, 32),
  });
}

const ALL_RUN_STATES = [
  'queued',
  'running',
  'awaiting_user',
  'awaiting_regeneration',
  'interrupted',
  'failed',
  'completed',
  'cancelled',
  'outdated',
] as any[];

/**
 * Continuation: merge the kernel trace into the durable run row snapshot
 * (the run row owns the single authoritative Freeze for this scenario).
 */
export async function persistWritingKernelTraceForContinuationRun(
  runId: string,
  completedTrace: WritingKernelTrace,
): Promise<void> {
  const run = await getRunById(runId);
  if (!run?.contextSnapshotJson) {
    throw new Error(
      `Writing Kernel trace persistence blocked: run ${runId} has no frozen snapshot`,
    );
  }
  let snapshot: any;
  try {
    snapshot = JSON.parse(run.contextSnapshotJson);
  } catch {
    throw new Error(
      `Writing Kernel trace persistence blocked: run ${runId} snapshot is invalid JSON`,
    );
  }
  const existing = snapshot.writingKernelTrace as WritingKernelTrace | undefined;
  if (!existing) {
    throw new Error(
      `Writing Kernel trace persistence blocked: run ${runId} has no durable Freeze trace`,
    );
  }
  const merged = mergePostFreezeKernelTrace(existing, completedTrace);
  if (merged === existing) {
    return; // nothing to append
  }
  snapshot.writingKernelTrace = merged;
  const changed = await casUpdateRunState(runId, ALL_RUN_STATES, {
    contextSnapshotJson: JSON.stringify(snapshot),
  });
  if (!changed) {
    throw new Error(
      `Writing Kernel trace persistence blocked: run ${runId} snapshot CAS update failed`,
    );
  }
}

export interface WritingKernelExecution {
  createDriver: () => ReturnType<typeof createOutlineStageDriver>;
  request?: WritingRequest;
  persistTrace?: (trace: WritingKernelTrace) => Promise<void>;
}

export function createOutlineWritingKernelExecution(input: {
  taskId: string;
  chapter: Chapter;
  onStageUpdate?: (info: StageInfo | string) => void;
  options?: PipelineRunOptions;
}): WritingKernelExecution {
  return {
    createDriver: () =>
      createOutlineStageDriver({
        taskId: input.taskId,
        chapter: input.chapter,
        mode: 'first-run',
        onStageUpdate: input.onStageUpdate,
        options: input.options,
      }),
    persistTrace: trace =>
      persistWritingKernelTraceForTask(input.taskId, trace),
  };
}

export function createOutlineResumeWritingKernelExecution(input: {
  taskId: string;
  chapter: Chapter;
  onStageUpdate?: (info: StageInfo | string) => void;
  options?: PipelineRunOptions;
}): WritingKernelExecution {
  return {
    createDriver: () =>
      createOutlineStageDriver({
        taskId: input.taskId,
        chapter: input.chapter,
        mode: 'resume',
        onStageUpdate: input.onStageUpdate,
        options: input.options,
      }),
    persistTrace: trace =>
      persistWritingKernelTraceForTask(input.taskId, trace),
  };
}

export function createFreeformWritingKernelExecution(input: {
  taskId: string;
  projectId: number;
  documentText: string;
  steerText: string;
}): WritingKernelExecution {
  const pseudoChapter: Chapter = {
    id: 0,
    project_id: input.projectId,
    position: Number.MAX_SAFE_INTEGER,
    title: '自由写作',
    synopsis: input.steerText,
    content: input.documentText,
    status: 'draft',
    summary_json: null,
    created_at: '',
    updated_at: '',
  };
  return {
    createDriver: () =>
      createOutlineStageDriver({
        taskId: input.taskId,
        chapter: pseudoChapter,
        mode: 'first-run',
      }),
    persistTrace: trace =>
      persistWritingKernelTraceForTask(input.taskId, trace),
  };
}

/**
 * Continuation entry (plan §8.4 / §12): creates the durable run through the
 * kernel pre-Freeze adaptation, hands the run row back to the caller at the
 * same point the legacy runner did, then drives the unified stage loop to
 * settlement under the kernel engine (detached — callers observe progress
 * through the durable run row exactly as before).
 */
export async function runContinuationWritingKernel(
  input: StartContinuationRunInput,
): Promise<ContinuationGenerationRun> {
  const driver = await createContinuationStageDriver(input);
  const run = await driver.handoff;
  void runWritingKernel({
    createDriver: async () => driver,
    persistTrace: trace =>
      persistWritingKernelTraceForContinuationRun(run.id, trace),
  }).catch(error => {
    // Failures are durably recorded on the run row; surface in logs for
    // observability without surfacing a second rejection to the UI.
    console.warn('[writing-kernel] continuation run failed:', error);
  });
  return run;
}

/** Compatibility-shaped entry for background/batch callers; routes through
 * the single Kernel entry and keeps the old callback signature out of
 * product UI code. */
export async function runOutlineWritingKernel(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (info: StageInfo | string) => void,
  options?: PipelineRunOptions,
): Promise<void> {
  await runWritingKernel(
    createOutlineWritingKernelExecution({
      taskId,
      chapter,
      onStageUpdate,
      options,
    }),
  );
}

export async function resumeOutlineWritingKernel(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (info: StageInfo | string) => void,
  options?: PipelineRunOptions,
): Promise<void> {
  await runWritingKernel(
    createOutlineResumeWritingKernelExecution({
      taskId,
      chapter,
      onStageUpdate,
      options,
    }),
  );
}

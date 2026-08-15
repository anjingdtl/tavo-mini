import type { Chapter } from '../../types/novel';
import { v4 } from '../uuidBridge';
import {
  getPipelineTaskById,
  updatePipelineTaskContext,
} from '../../data/repositories/pipelineTaskRepository';
import { sha256Hex } from '../continuation/hashUtils';
import { usePipelineTaskStore } from '../../store/pipelineTaskStore';
import {
  runChapterPipeline,
  runFreeformPipeline,
  resumePipeline,
  type PipelineRunOptions,
  type StageInfo,
} from '../pipelineRunner';
import {
  startContinuationRun,
  type StartContinuationRunInput,
} from '../continuation/generation/continuationGenerationRunner';
import { adaptOutlineWritingSources } from './scenario/outlineWritingAdapter';
import { writingSourceContentHash } from './contracts/writingFingerprint';
import type {
  FrozenModelConfig,
  WritingPolicySnapshot,
  WritingRequest,
  WritingSource,
  WritingSourceBundle,
} from './contracts/writingSource';
import {
  runWritingKernel,
  type WritingKernelExecution,
} from './unifiedWritingKernel';
import type { WritingKernelTrace } from './contracts/frozenWritingContext';

export type { StageInfo } from '../pipelineRunner';

function defaultModel(input?: {
  contextWindow?: number;
  maxOutputTokens?: number;
}): FrozenModelConfig {
  return {
    configId: null,
    provider: 'runtime-selected',
    modelName: 'runtime-selected',
    contextWindow: Math.max(1024, input?.contextWindow || 8192),
    maxOutputTokens: Math.max(256, input?.maxOutputTokens || 1024),
  };
}

function defaultPolicy(): WritingPolicySnapshot {
  return {
    version: 1,
    reviewMode: 'runtime-selected',
    strictness: 'fail-closed',
    values: { source: 'writing-kernel' },
  };
}

function makeSource(input: {
  candidateId: string;
  kind: WritingSource['kind'];
  sourceId: string | number;
  revision: string;
  content: string;
  requirement: WritingSource['requirement'];
}): WritingSource {
  const content = String(input.content || '').trim();
  return {
    candidateId: input.candidateId,
    kind: input.kind,
    sourceId: input.sourceId,
    revision: input.revision,
    content,
    contentHash: writingSourceContentHash(content),
    requirement: input.requirement,
    activation: input.requirement === 'mandatory' ? 'system' : 'automatic',
  };
}

function makeContinuationSourceBundle(input: StartContinuationRunInput): WritingSourceBundle {
  const revision = `chapter:${input.chapterId}:${input.targetPosition}`;
  const seam = String(input.currentChapterContent || '').trim();
  const nonEmptySeam = seam || '续写边界由 Continuation Source Adapter 在上下文冻结前确认。';
  return {
    mandatory: [
      makeSource({
        candidateId: 'instruction:current',
        kind: 'instruction',
        sourceId: input.chapterId,
        revision,
        content: input.userInstruction,
        requirement: 'mandatory',
      }),
      makeSource({
        candidateId: 'canon:deferred-adapter',
        kind: 'canon',
        sourceId: input.projectId,
        revision,
        content: 'Canon 资料由 Continuation Source Adapter 在 Freeze 前装载。',
        requirement: 'mandatory',
      }),
      makeSource({
        candidateId: 'source-boundary:current-chapter',
        kind: 'source_boundary',
        sourceId: input.chapterId,
        revision,
        content: `chapterId=${input.chapterId}; targetPosition=${input.targetPosition}; boundaryRevision=${revision}`,
        requirement: 'mandatory',
      }),
      makeSource({
        candidateId: `seam:${input.chapterId}`,
        kind: 'seam',
        sourceId: input.chapterId,
        revision,
        content: nonEmptySeam,
        requirement: 'mandatory',
      }),
    ],
    preferred: [],
    optional: [],
  };
}

/**
 * The durable pipeline freezes the authoritative source bundle before its
 * stage driver starts. The public entry also builds a small facade request so
 * the driver can be invoked through the one Kernel API; that facade has its
 * own pre-freeze trace and must never replace the durable source decision.
 *
 * Only post-Freeze events cross this bridge. The durable trace keeps its own
 * source/context fingerprints and counters, so a facade placeholder cannot
 * create source drift or a false context-loss signal.
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
      'Writing Kernel trace persistence blocked: facade trace has no completed Freeze',
    );
  }
  const postFreezeEvents = completed.events.slice(lastFreezeIndex + 1);
  if (postFreezeEvents.length === 0) {
    throw new Error(
      'Writing Kernel trace persistence blocked: facade trace has no post-Freeze events',
    );
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
 * The durable pipeline owns the first Freeze snapshot. Once its post-Freeze
 * driver returns, append the Kernel events to that exact snapshot instead of
 * replacing its real context-plan/allocation fingerprints with a facade-only
 * request. A failed write is fatal: a completed run without its trace is not
 * an acceptable green result.
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

function makeOutlineRequest(input: {
  taskId: string;
  chapter: Chapter;
  generationTraceId: string;
}): WritingRequest {
  const chapter = input.chapter;
  const bundle = adaptOutlineWritingSources({
    projectId: chapter.project_id,
    chapter,
    context: {
      presetText: '大纲创作资料由 Writing Source Adapter 统一装载。',
      storyMemoryText: '',
      characterText: '',
      noteText: '',
      worldbookText: '',
      episodicMemoryText: '',
      recentBridgeText: '',
      outlineText: chapter.synopsis || chapter.title || '推进本章大纲目标。',
      outlineFingerprint: writingSourceContentHash(
        chapter.synopsis || chapter.title || 'outline',
      ),
      outlineIds: [chapter.id],
      outlineComplete: true,
    },
    userInstruction: chapter.synopsis || chapter.title || '完成本章写作。',
  });
  return {
    writingRunId: `wr_outline_${input.taskId}`,
    generationTraceId: input.generationTraceId,
    projectId: chapter.project_id,
    chapterId: chapter.id,
    scenario: 'outline',
    instruction: {
      title: chapter.title || '',
      synopsis: chapter.synopsis || '',
      userInstruction: chapter.synopsis || chapter.title || '完成本章写作。',
      currentContent: chapter.content || '',
      targetPosition: chapter.position,
    },
    sourceBundle: bundle.bundle,
    model: defaultModel(),
    policy: defaultPolicy(),
  };
}

function makeContinuationRequest(
  input: StartContinuationRunInput,
): WritingRequest {
  return {
    writingRunId: `wr_continuation_${v4()}`,
    generationTraceId: `gt_${v4()}`,
    projectId: input.projectId,
    chapterId: input.chapterId,
    scenario: 'continuation',
    instruction: {
      title: `Continuation chapter ${input.targetPosition}`,
      synopsis: input.userInstruction,
      userInstruction: input.userInstruction,
      currentContent: input.currentChapterContent,
      targetPosition: input.targetPosition,
    },
    sourceBundle: makeContinuationSourceBundle(input),
    model: defaultModel({
      contextWindow: input.modelContextLimit,
      maxOutputTokens: input.maxOutputTokens,
    }),
    policy: defaultPolicy(),
  };
}

export function createOutlineWritingKernelExecution(input: {
  taskId: string;
  chapter: Chapter;
  onStageUpdate?: (info: StageInfo | string) => void;
  options?: PipelineRunOptions;
}): { request: WritingRequest; execution: WritingKernelExecution<void> } {
  const request = makeOutlineRequest({
    taskId: input.taskId,
    chapter: input.chapter,
    generationTraceId: input.options?.generationTraceId || `gt_${v4()}`,
  });
  return {
    request,
    execution: {
      execute: async ({ emitStage, frozenContext }) => {
        emitStage('draft', 'started');
        await runChapterPipeline(input.taskId, input.chapter, input.onStageUpdate, {
          ...(input.options || {}),
          generationTraceId: frozenContext.generationTraceId,
        });
        for (const stage of ['draft', 'review', 'audit', 'factCheck', 'revision', 'proof', 'finalValidate', 'persist', 'postWritingUpdate'] as const) {
          emitStage(stage, 'completed');
        }
      },
      persistTrace: trace => persistWritingKernelTraceForTask(input.taskId, trace),
    },
  };
}

export function createOutlineResumeWritingKernelExecution(input: {
  taskId: string;
  chapter: Chapter;
  onStageUpdate?: (info: StageInfo | string) => void;
  options?: PipelineRunOptions;
}): { request: WritingRequest; execution: WritingKernelExecution<void> } {
  const request = makeOutlineRequest({
    taskId: input.taskId,
    chapter: input.chapter,
    generationTraceId: input.options?.generationTraceId || `gt_${v4()}`,
  });
  return {
    request,
    execution: {
      execute: async ({ emitStage, frozenContext }) => {
        emitStage('draft', 'started');
        await resumePipeline(input.taskId, input.chapter, input.onStageUpdate, {
          ...(input.options || {}),
          generationTraceId: frozenContext.generationTraceId,
        });
        emitStage('postWritingUpdate', 'completed');
      },
      persistTrace: trace => persistWritingKernelTraceForTask(input.taskId, trace),
    },
  };
}

export function createFreeformWritingKernelExecution(input: {
  taskId: string;
  projectId: number;
  documentText: string;
  steerText: string;
}): { request: WritingRequest; execution: WritingKernelExecution<void> } {
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
  const request = makeOutlineRequest({
    taskId: input.taskId,
    chapter: pseudoChapter,
    generationTraceId: `gt_${v4()}`,
  });
  return {
    request,
    execution: {
      execute: async ({ emitStage, frozenContext }) => {
        emitStage('draft', 'started');
        await runFreeformPipeline(
          input.taskId,
          input.projectId,
          input.documentText,
          input.steerText,
          undefined,
          { generationTraceId: frozenContext.generationTraceId },
        );
        emitStage('finalValidate', 'completed');
        emitStage('persist', 'completed');
        emitStage('postWritingUpdate', 'completed');
      },
      persistTrace: trace => persistWritingKernelTraceForTask(input.taskId, trace),
    },
  };
}

export function createContinuationWritingKernelExecution(
  input: StartContinuationRunInput,
): { request: WritingRequest; execution: WritingKernelExecution<Awaited<ReturnType<typeof startContinuationRun>>> } {
  const request = makeContinuationRequest(input);
  return {
    request,
    execution: {
      execute: async ({ emitStage }) => {
        emitStage('draft', 'started');
        const run = await startContinuationRun(input);
        for (const stage of ['draft', 'review', 'audit', 'factCheck', 'revision', 'proof', 'finalValidate', 'persist', 'postWritingUpdate'] as const) {
          emitStage(stage, 'completed');
        }
        return run;
      },
    },
  };
}

/** Compatibility-shaped entry for background/batch callers; still routes
 * through the single Kernel entry and keeps the old callback signature out of
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

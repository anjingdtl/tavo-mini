import type { Chapter } from '../../types/novel';
import { v4 } from '../uuidBridge';
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

import type { FrozenWritingContext, WritingKernelStage, WritingKernelTrace } from './contracts/frozenWritingContext';
import type { WritingRequest } from './contracts/writingSource';
import { buildFrozenWritingContext } from './context/buildFrozenWritingContext';
import {
  appendWritingKernelStageEvent,
  createWritingKernelTrace,
} from './trace/writingTrace';

export interface WritingKernelExecutionInput {
  frozenContext: FrozenWritingContext;
  trace: WritingKernelTrace;
  emitStage: (stage: WritingKernelStage, status: 'started' | 'completed' | 'blocked', detail?: string) => void;
}

export interface WritingKernelExecution<TResult = unknown> {
  execute: (input: WritingKernelExecutionInput) => Promise<TResult>;
  /** Persist the final trace after the post-Freeze driver completes. */
  persistTrace?: (trace: WritingKernelTrace) => Promise<void>;
}

export interface WritingKernelResult<TResult = unknown> {
  result: TResult;
  request: WritingRequest;
  frozenContext: FrozenWritingContext;
  trace: WritingKernelTrace;
}

/** Build the persisted pre-freeze trace when an existing durable executor
 * owns the subsequent Draft/Review/Persist loop. */
export function buildWritingKernelFreezeTrace(input: {
  request: WritingRequest;
}): { frozenContext: FrozenWritingContext; trace: WritingKernelTrace } {
  const frozenContext = buildFrozenWritingContext(input.request);
  let trace = createWritingKernelTrace({
    request: input.request,
    frozenContext,
  });
  for (const stage of ['collect', 'normalize', 'plan', 'allocate', 'render', 'freeze'] as const) {
    trace = appendWritingKernelStageEvent(trace, stage, 'completed');
  }
  return { frozenContext, trace };
}

/**
 * The one production writing entry. Scenario-specific work is supplied as a
 * pre-freeze Driver; the Kernel itself consumes only the frozen contract.
 */
export async function runWritingKernel<TResult>(input: {
  request: WritingRequest;
  execution: WritingKernelExecution<TResult>;
}): Promise<WritingKernelResult<TResult>> {
  const prepared = buildWritingKernelFreezeTrace({ request: input.request });
  const frozenContext = prepared.frozenContext;
  let trace = prepared.trace;
  const emitStage = (
    stage: WritingKernelStage,
    status: 'started' | 'completed' | 'blocked',
    detail?: string,
  ) => {
    trace = appendWritingKernelStageEvent(trace, stage, status, detail);
  };
  const result = await input.execution.execute({
    frozenContext,
    trace,
    emitStage,
  });
  if (input.execution.persistTrace) {
    await input.execution.persistTrace(trace);
  }
  return { result, request: input.request, frozenContext, trace };
}

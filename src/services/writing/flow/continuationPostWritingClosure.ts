import type { WritingKernelTrace } from '../contracts/frozenWritingContext';
import { appendWritingKernelStageEvent } from '../trace/writingTrace';
import type { WritingPersistedEvent } from './writingPersistedEvent';
import { assertWritingPersistedEvent } from './writingPersistedEvent';
import type { WritingLlmCallRecord } from '../observability/writingChapterObservability';

/**
 * Close the same Kernel trace used by Outline after a Continuation chapter is
 * durably finalized. State extraction and Story Memory are outbox work, so
 * this marker records the durable handoff without creating another stage
 * runner or another writer.
 */
export function appendContinuationPostWritingClosure(input: {
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
    'WritingPersistedEvent → Story Memory queued',
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

/**
 * Add the persisted event and its PostWriting marker to a Continuation
 * snapshot. The operation is idempotent for retries of the same finalized
 * revision and fails closed if a different revision tries to reuse the
 * already-closed snapshot.
 */
export function closeContinuationPostWritingSnapshot(input: {
  snapshot: Record<string, any>;
  persistedEvent: WritingPersistedEvent;
  durationMs: number;
}): Record<string, any> {
  assertWritingPersistedEvent(input.persistedEvent);
  const existingEvent = input.snapshot.writingPersistedEvent as
    | WritingPersistedEvent
    | undefined;
  if (existingEvent) {
    assertWritingPersistedEvent(existingEvent);
    if (
      existingEvent.finalBodyFingerprint !==
        input.persistedEvent.finalBodyFingerprint ||
      existingEvent.chapterId !== input.persistedEvent.chapterId
    ) {
      throw new Error(
        'WRITING_POST_WRITING_REVISION_DRIFT: Continuation snapshot already belongs to another finalized revision',
      );
    }
  }

  const trace = input.snapshot.writingKernelTrace as
    | WritingKernelTrace
    | undefined;
  if (!trace) {
    throw new Error(
      'WRITING_POST_WRITING_TRACE_MISSING: Continuation snapshot has no durable Kernel trace',
    );
  }

  input.snapshot.writingKernelTrace = appendContinuationPostWritingClosure({
    trace,
    durationMs: input.durationMs,
  });
  input.snapshot.writingPersistedEvent = input.persistedEvent;
  return input.snapshot;
}

/** Add a completed asynchronous PostWriting auxiliary call to the durable
 * trace. The Kernel's paid-stage counters stay unchanged; the call is kept in
 * the separate PostWriting counters and token ledger. */
export function appendContinuationPostWritingObservability(input: {
  trace: WritingKernelTrace;
  kind: 'story_memory' | 'state_extraction';
  durationMs: number;
  blockingMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  physicalRequestCount?: number;
}): WritingKernelTrace {
  const observability = input.trace.observability;
  if (!observability) return input.trace;
  const durationMs = Math.max(0, Number(input.durationMs) || 0);
  const inputTokens = Math.max(0, Number(input.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(input.outputTokens) || 0);
  const physicalRequestCount = Math.max(
    0,
    Number(input.physicalRequestCount) ||
      (inputTokens || outputTokens ? 1 : 0),
  );
  const blockingMs = Math.max(0, Number(input.blockingMs) || 0);
  const call: WritingLlmCallRecord = {
    kind: 'post_writing_auxiliary',
    stage: input.kind,
    inputTokens,
    outputTokens,
    physicalRequestCount,
    protocolFallbackCount: 0,
    promptCacheHitTokens: null,
    promptCacheMissTokens: null,
    durationMs,
  };
  const postWriting = observability.postWriting;
  return {
    ...input.trace,
    observability: {
      ...observability,
      llm: {
        ...observability.llm,
        physicalRequestCount:
          observability.llm.physicalRequestCount + physicalRequestCount,
        postWritingAuxiliaryCallCount:
          observability.llm.postWritingAuxiliaryCallCount + 1,
        inputTokens: observability.llm.inputTokens + inputTokens,
        outputTokens: observability.llm.outputTokens + outputTokens,
        calls: [...observability.llm.calls, call],
      },
      postWriting: {
        ...postWriting,
        storyMemoryUpdateMs:
          postWriting.storyMemoryUpdateMs +
          (input.kind === 'story_memory' ? durationMs : 0),
        stateExtractionMs:
          postWriting.stateExtractionMs +
          (input.kind === 'state_extraction' ? durationMs : 0),
        postWritingBlockingMs: postWriting.postWritingBlockingMs + blockingMs,
        postWritingAuxiliaryCallCount:
          postWriting.postWritingAuxiliaryCallCount + 1,
        postWritingAuxiliaryInputTokens:
          postWriting.postWritingAuxiliaryInputTokens + inputTokens,
        postWritingAuxiliaryOutputTokens:
          postWriting.postWritingAuxiliaryOutputTokens + outputTokens,
      },
    },
  };
}

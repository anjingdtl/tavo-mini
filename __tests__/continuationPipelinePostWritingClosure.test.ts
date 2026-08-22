import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import {
  appendContinuationPostWritingClosure,
  closeContinuationPostWritingSnapshot,
} from '../src/services/writing/flow/continuationPostWritingClosure';
import { buildWritingPersistedEvent } from '../src/services/writing/flow/writingPersistedEvent';
import { emptyWritingChapterObservability } from '../src/services/writing/observability/writingChapterObservability';
import { continuationRequest } from './helpers/oneShotFixtures';

describe('Continuation unified Kernel PostWriting closure', () => {
  test('records the durable handoff once and is idempotent', () => {
    const { trace: frozenTrace, frozenContext } = buildWritingKernelFreezeTrace({
      request: continuationRequest({ pipelineTopologyVersion: 'compact_standard' }),
    });
    const trace = {
      ...frozenTrace,
      observability: emptyWritingChapterObservability({
        generationTraceId: frozenTrace.generationTraceId,
        freezeFingerprint: frozenContext.freezeFingerprint,
        scenario: 'continuation',
      }),
    };
    const persistedEvent = buildWritingPersistedEvent({
      generationTraceId: trace.generationTraceId,
      freezeFingerprint: frozenContext.freezeFingerprint,
      projectId: 27,
      chapterId: 288,
      chapterPosition: 12,
      finalBody: 'final continuation body',
      executionProfile: 'standard',
      scenario: 'continuation',
    });
    const first = closeContinuationPostWritingSnapshot({
      snapshot: { writingKernelTrace: trace },
      persistedEvent,
      durationMs: 21,
    });

    expect(first.writingPersistedEvent).toEqual(persistedEvent);
    expect(first.writingKernelTrace.events.at(-1)).toMatchObject({
      stage: 'postWritingUpdate',
      status: 'completed',
    });
    expect(first.writingKernelTrace.observability?.postWriting.storyMemoryUpdateMs).toBe(21);

    const repeated = appendContinuationPostWritingClosure({
      trace: first.writingKernelTrace,
      durationMs: 99,
    });
    expect(
      repeated.events.filter(
        event => event.stage === 'postWritingUpdate',
      ),
    ).toHaveLength(1);
    expect(repeated.observability?.postWriting.storyMemoryUpdateMs).toBe(21);
  });

  test('fails closed when a finalized Continuation snapshot has no Kernel trace', () => {
    const persistedEvent = buildWritingPersistedEvent({
      generationTraceId: 'gt_missing-trace',
      freezeFingerprint: 'freeze-missing-trace',
      projectId: 27,
      chapterId: 288,
      chapterPosition: 12,
      finalBody: 'final continuation body',
      scenario: 'continuation',
    });

    expect(() =>
      closeContinuationPostWritingSnapshot({
        snapshot: {},
        persistedEvent,
        durationMs: 0,
      }),
    ).toThrow('WRITING_POST_WRITING_TRACE_MISSING');
  });
});

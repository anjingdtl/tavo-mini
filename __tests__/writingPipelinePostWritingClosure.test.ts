import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { emptyWritingChapterObservability } from '../src/services/writing/observability/writingChapterObservability';
import {
  appendOutlinePostWritingClosure,
} from '../src/services/writing/flow/outlinePostWritingClosure';
import {
  shouldReserveOutlineStageAttempt,
} from '../src/services/writing/execution/runOutlineSharedWriterAction';
import { outlineRequest } from './helpers/oneShotFixtures';

describe('Outline Pipeline PostWriting closure', () => {
  test('conditional Revision skip reserves no physical stage attempt', async () => {
    const { frozenContext } = buildWritingKernelFreezeTrace({
      request: outlineRequest({ pipelineTopologyVersion: 'compact_standard' }),
    });
    const adapter = {
      binding: 'outline-pipeline-tasks' as const,
      loadExisting: async (stage: string) =>
        stage === 'qa'
          ? {
              stage: 'qa' as const,
              body: JSON.stringify({
                schemaVersion: 1,
                verdict: 'pass',
                findings: [],
              }),
              structured: { verdict: 'pass', findings: [] },
            }
          : null,
      persistStageArtifact: async () => undefined,
    };

    await expect(
      shouldReserveOutlineStageAttempt({
        stage: 'revision',
        frozenContext,
        adapter,
      }),
    ).resolves.toBe(false);
    await expect(
      shouldReserveOutlineStageAttempt({
        stage: 'draft',
        frozenContext,
        adapter,
      }),
    ).resolves.toBe(true);
  });

  test('PostWriting closure appends once and records local timing', () => {
    const { trace, frozenContext } = buildWritingKernelFreezeTrace({
      request: outlineRequest({ pipelineTopologyVersion: 'compact_standard' }),
    });
    const withObservability = {
      ...trace,
      observability: emptyWritingChapterObservability({
        generationTraceId: trace.generationTraceId,
        freezeFingerprint: frozenContext.freezeFingerprint,
        scenario: 'outline',
      }),
    };

    const closed = appendOutlinePostWritingClosure({
      trace: withObservability,
      durationMs: 17,
    });
    expect(closed.events.at(-1)).toMatchObject({
      stage: 'postWritingUpdate',
      status: 'completed',
    });
    expect(closed.observability?.postWriting.storyMemoryUpdateMs).toBe(17);
    expect(closed.observability?.postWriting.postWritingBlockingMs).toBe(17);

    const repeated = appendOutlinePostWritingClosure({
      trace: closed,
      durationMs: 99,
    });
    expect(
      repeated.events.filter(event => event.stage === 'postWritingUpdate'),
    ).toHaveLength(1);
    expect(repeated.observability?.postWriting.storyMemoryUpdateMs).toBe(17);
  });
});

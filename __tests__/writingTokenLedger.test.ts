import { mergeWritingTokenLedger } from '../src/services/writing/observability/writingTokenLedger';

describe('durable Writing LLM token ledger', () => {
  test('persists logical, formatter, physical, fallback, retry and per-stage tokens', () => {
    const ledger = mergeWritingTokenLedger('{}', {
      version: 1,
      generationTraceId: 'gt_test',
      freezeFingerprint: 'freeze_test',
      scenario: 'continuation',
      executionProfile: 'standard',
      chapterE2EMs: 1,
      context: {} as any,
      stages: [
        {
          stage: 'draft',
          status: 'completed',
          logicalStageCallCount: 1,
          formatterCallCount: 0,
          physicalRequestCount: 1,
          protocolFallbackCount: 0,
          inputTokens: 100,
          outputTokens: 200,
          stageQueuedMs: 0,
          stageExecutionMs: 0,
          stageDependencyWaitMs: 0,
          stagePersistMs: 0,
          projectedTokens: 0,
          frozenContextTokens: 0,
          artifactTokens: 0,
        },
        {
          stage: 'qa',
          status: 'completed',
          logicalStageCallCount: 1,
          formatterCallCount: 1,
          physicalRequestCount: 2,
          protocolFallbackCount: 1,
          inputTokens: 300,
          outputTokens: 400,
          stageQueuedMs: 0,
          stageExecutionMs: 0,
          stageDependencyWaitMs: 0,
          stagePersistMs: 0,
          projectedTokens: 0,
          frozenContextTokens: 0,
          artifactTokens: 0,
        },
      ],
      llm: {
        logicalStageCallCount: 2,
        formatterCallCount: 1,
        physicalRequestCount: 3,
        protocolFallbackCount: 1,
        chapterWritingPaidCallCount: 3,
        postWritingAuxiliaryCallCount: 0,
        inputTokens: 400,
        outputTokens: 600,
        promptCacheHitTokens: null,
        promptCacheMissTokens: null,
        calls: [],
      },
      postWriting: {
        storyMemoryUpdateMs: 0,
        stateExtractionMs: 0,
        postWritingBlockingMs: 0,
        postWritingAuxiliaryCallCount: 0,
        postWritingAuxiliaryInputTokens: 0,
        postWritingAuxiliaryOutputTokens: 0,
      },
    });

    expect(ledger.logicalStageCallCount).toBe(2);
    expect(ledger.formatterCallCount).toBe(1);
    expect(ledger.physicalRequestCount).toBe(3);
    expect(ledger.protocolFallbackCount).toBe(1);
    expect(ledger.primaryRetryCount).toBe(0);
    expect(ledger.totalTokens).toBe(1000);
    expect(ledger.stages.qa).toMatchObject({
      logicalStageCallCount: 1,
      formatterCallCount: 1,
      physicalRequestCount: 2,
      protocolFallbackCount: 1,
      primaryRetryCount: 0,
      inputTokens: 300,
      outputTokens: 400,
      totalTokens: 700,
    });
  });
});

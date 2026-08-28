/**
 * Phase III-C v2 Red Tests.
 *
 * These tests describe the safe Request Boundary contract before the C1
 * implementation exists. They intentionally exercise receipts produced by
 * the mature shared writer so C1 cannot change prompts, budgets, or topology
 * while adding runtime observability.
 */
import { compileSharedWritingPrompt } from '../src/services/writing/prompt/sharedPromptCompiler';
import {
  buildWritingRequestReceipt,
} from '../src/services/writing/contracts/writingRequestReceipt';
import { executeSharedWriterStage } from '../src/services/writing/stages/writerCore';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { shouldAutoRetryFailure } from '../src/services/llm/requestPolicy';
import { openAICompatibleProvider } from '../src/services/llm/openAICompatibleProvider';
import { outlineRequest } from './helpers/oneShotFixtures';

function makeStageInput(values: Record<string, unknown> = {}) {
  const { frozenContext, trace } = buildWritingKernelFreezeTrace({
    request: outlineRequest({
      pipelineTopologyVersion: 'compact_standard',
      qualityProfile: 'standard',
      targetChapterChars: 500,
      ...values,
    }),
  });
  return {
    frozenContext,
    trace,
    stageInput: {
      frozenContext,
      artifacts: {},
      requirements: frozenContext.requirements,
      stagePolicy: frozenContext.stagePolicy,
      trace,
      modelConfig: {
        configId: frozenContext.model.configId,
        name: frozenContext.model.name || 'cfg',
        providerType: frozenContext.model.provider,
        url: frozenContext.model.url || '',
        modelName: frozenContext.model.modelName,
        contextWindow: frozenContext.model.contextWindow,
        maxOutputTokens: frozenContext.model.maxOutputTokens,
      },
    } as any,
  };
}

describe('Phase III-C v2 runtime observability Red Tests', () => {
  test('receipt exposes safe request-boundary metadata without raw prompt/body', async () => {
    const { frozenContext, trace, stageInput } = makeStageInput();
    const compiled = compileSharedWritingPrompt({
      stage: 'draft',
      frozenContext,
      artifacts: {},
      requirements: frozenContext.requirements,
      stagePolicy: frozenContext.stagePolicy,
    });
    const built = buildWritingRequestReceipt({
      generationTraceId: frozenContext.generationTraceId,
      stage: 'draft',
      frozenContext,
      compiled,
      thinking: { type: 'enabled' },
      reasoningEffort: 'high',
    }) as any;
    expect(built.writingRunId).toBe(frozenContext.writingRunId);
    expect(built.scenario).toBe('outline');
    expect(built.llmConfigId).toBe(frozenContext.model.configId);
    expect(built.providerAdapterId).toBeTruthy();
    expect(built.configuredContextWindow).toBe(
      frozenContext.model.contextWindow,
    );
    expect(built.completionCapability).toBe(
      frozenContext.model.maxOutputTokens,
    );
    expect(built.wireMaxTokens).toBe(compiled.maxTokens);
    expect(built.targetChars).toBe(500);
    expect(built.failureClass).toBeNull();
    expect(built.requestMayHaveExecuted).toBe(false);

    stageInput.callStage = async () => ({
      text: '完整正文。',
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      finishReason: 'stop',
    });
    const artifact = await executeSharedWriterStage({
      stage: 'draft',
      stageInput,
    });
    const receipt = artifact.requestReceipts?.[0] as any;
    expect(receipt.writingRunId).toBe(trace.writingRunId);
    expect(receipt.actualPromptTokens).toBe(10);
    expect(receipt.providerRequestId).toBeNull();
    const serialized = JSON.stringify(receipt);
    expect(receipt.messages).toBeUndefined();
    expect(receipt.prompt).toBeUndefined();
    expect(receipt.rawPrompt).toBeUndefined();
    expect(receipt.rawBody).toBeUndefined();
    expect(serialized).not.toContain('完成本章写作指令');
  });

  test('provider usage absence stays null instead of becoming fabricated zeroes', async () => {
    const { stageInput } = makeStageInput({ qualityProfile: 'fast' });
    stageInput.callStage = async () => ({
      text: '没有 usage 的成功响应。',
      finishReason: 'stop',
    });
    const artifact = await executeSharedWriterStage({
      stage: 'draft',
      stageInput,
    });
    expect(artifact.requestReceipts?.[0].usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      reasoningTokens: null,
      visibleOutputTokens: null,
    });
  });

  test('outcome_unknown remains explicit and preserves execution uncertainty', async () => {
    const { stageInput } = makeStageInput();
    stageInput.callStage = async () => {
      throw Object.assign(new Error('provider watchdog timeout'), {
        failureClass: 'outcome_unknown',
        code: 'total_timeout',
        providerRequestId: 'provider-request-1',
        requestMayHaveExecuted: true,
        physicalRequestCount: 1,
      });
    };
    await expect(
      executeSharedWriterStage({ stage: 'draft', stageInput }),
    ).rejects.toMatchObject({
      requestReceipts: [
        expect.objectContaining({
          outcome: 'outcome_unknown',
          failureClass: 'outcome_unknown',
          requestMayHaveExecuted: true,
          providerRequestId: 'provider-request-1',
        }),
      ],
    });
  });

  test('request lifecycle separates queue, provider, parse, persist, and total time', async () => {
    const { stageInput } = makeStageInput();
    stageInput.callStage = async () => ({
      text: '带生命周期数据的响应。',
      inputTokens: 20,
      outputTokens: 8,
      totalTokens: 28,
      finishReason: 'stop',
      metrics: {
        startedAt: 100,
        queueWaitMs: 7,
        providerElapsedMs: 40,
        parseMs: 3,
        totalMs: 50,
      },
    });
    const artifact = await executeSharedWriterStage({
      stage: 'draft',
      stageInput,
    });
    const timings = (artifact.requestReceipts?.[0] as any).timings;
    expect(timings).toEqual(
      expect.objectContaining({
        queueWaitMs: 7,
        providerElapsedMs: 40,
        parseMs: 3,
        persistMs: expect.any(Number),
        totalMs: 50,
      }),
    );
    expect(timings.queueWaitMs).not.toBe(timings.providerElapsedMs);
  });

  test('physical request accounting stays based on actual dispatches', async () => {
    const { stageInput } = makeStageInput();
    stageInput.callStage = async () => ({
      text: '协议回退后的响应。',
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
      finishReason: 'stop',
      physicalRequestCount: 2,
      protocolFallbackCount: 1,
    });
    const artifact = await executeSharedWriterStage({
      stage: 'draft',
      stageInput,
    });
    expect(artifact.requestReceipts?.[0].physicalRequestCount).toBe(2);
    expect(artifact.requestReceipts?.[0].protocolFallbackCount).toBe(1);
  });

  test('outcome_unknown never enters automatic retry policy', () => {
    expect(
      shouldAutoRetryFailure({ failureClass: 'outcome_unknown', attemptNo: 1 }),
    ).toBe(false);
  });

  test('provider boundary returns separated lifecycle metrics and correlation id', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'x-request-id' ? 'provider-request-2' : null,
      },
      json: async () => ({
        choices: [{ message: { content: 'Provider 正文' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 31,
          completion_tokens: 9,
          total_tokens: 40,
        },
      }),
    }));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;
    try {
      const result = await openAICompatibleProvider.generate(
        [{ role: 'user', content: 'safe boundary probe' }],
        {
          max_tokens: 128,
          taskId: 'phase3-c1-provider-boundary',
          scenario: 'pipeline_draft',
          requestConfig: {
            provider_type: 'openai_compatible',
            api_key: 'test-only-boundary-credential',
            model_name: 'boundary-fixture',
            url: 'https://api.example.com/v1/chat/completions',
            context_window: 8192,
            max_output_tokens: 1024,
          },
        },
      );
      expect(result.providerRequestId).toBe('provider-request-2');
      expect(result.metrics).toEqual(
        expect.objectContaining({
          queueWaitMs: expect.any(Number),
          providerElapsedMs: expect.any(Number),
          parseMs: expect.any(Number),
          totalMs: expect.any(Number),
          requestSentAt: expect.any(Number),
          responseReceivedAt: expect.any(Number),
          parseCompletedAt: expect.any(Number),
        }),
      );
      expect(result.metrics?.totalMs).toBeGreaterThanOrEqual(
        (result.metrics?.queueWaitMs || 0) +
          (result.metrics?.providerElapsedMs || 0) +
          (result.metrics?.parseMs || 0),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

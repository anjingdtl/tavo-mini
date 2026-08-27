/**
 * Red contract for physical request accounting.
 *
 * One logical Writer stage may contain a provider protocol fallback. The
 * reconstructable receipt and the artifact usage ledger must retain that
 * physical count instead of collapsing it to one logical call.
 */
import { executeSharedWriterStage } from '../src/services/writing/stages/writerCore';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { callWritingStageLLM } from '../src/services/writing/stages/stageLlmCall';
import * as llm from '../src/services/llm';
import { continuationRequest } from './helpers/oneShotFixtures';

describe('physical Writer request accounting', () => {
  test('receipt and artifact usage preserve protocol-fallback physical calls', async () => {
    const { frozenContext, trace } = buildWritingKernelFreezeTrace({
      request: continuationRequest({
        pipelineTopologyVersion: 'compact_standard',
        qualityProfile: 'standard',
      }),
    });

    const artifact = await executeSharedWriterStage({
      stage: 'draft',
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
        callStage: async () =>
          ({
            text: 'protocol fallback 后的 Draft 正文。',
            inputTokens: 120,
            outputTokens: 80,
            totalTokens: 200,
            finishReason: 'stop',
            physicalRequestCount: 2,
            protocolFallbackCount: 1,
          }) as any,
      },
    });

    expect(artifact.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 80,
      totalTokens: 200,
      physicalRequestCount: 2,
      protocolFallbackCount: 1,
    });
    expect(artifact.requestReceipts).toHaveLength(1);
    expect(artifact.requestReceipts?.[0]).toMatchObject({
      outcome: 'succeeded',
      finishReason: 'stop',
      physicalRequestCount: 2,
      protocolFallbackCount: 1,
    });
  });

  test('failed transport preserves already-dispatched physical calls', async () => {
    const transport = jest
      .spyOn(llm, 'callLLMResult')
      .mockImplementation(async (_messages, _maxTokens, config) => {
        await config?.physicalRequestHooks?.beforeRequest?.({ kind: 'primary' });
        await config?.physicalRequestHooks?.beforeRequest?.({
          kind: 'protocol_fallback',
        });
        throw new Error('fallback transport failed');
      });
    try {
      await expect(
        callWritingStageLLM(
          [{ role: 'user', content: 'test' }],
          128,
          {
            provider_type: 'openai_compatible',
            api_key: 'redacted',
            model_name: 'test',
            url: 'https://example.invalid/v1/chat/completions',
          } as any,
        ),
      ).rejects.toMatchObject({
        physicalRequestCount: 2,
        protocolFallbackCount: 1,
      });
    } finally {
      transport.mockRestore();
    }
  });
});

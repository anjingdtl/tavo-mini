import {
  resolveProviderCapability,
} from '../src/services/llm/providerCapabilities';
import {
  openAICompatibleProvider,
} from '../src/services/llm/openAICompatibleProvider';
import { compileKernelStageReasoning } from '../src/services/writing/contracts/stageReasoning';
import { mapGenerationQualityProfile } from '../src/services/writing/contracts/generationQualityProfile';

const BIGMODEL_CONFIG = {
  provider_type: 'openai_compatible' as const,
  provider_adapter_id: 'open.bigmodel.cn-v4',
  model_name: 'GLM-5.3-Flash',
  url: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
  api_key: 'test-key',
  context_window: 1_000_000,
  max_output_tokens: 200_000,
};

describe('Phase III-C C6 provider-aware reasoning policy', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('declares BigModel reasoning capabilities and the documented tier mapping', () => {
    const capability = resolveProviderCapability(BIGMODEL_CONFIG);

    expect(capability).toMatchObject({
      adapterId: 'open.bigmodel.cn-v4',
      supportsThinking: 'supported',
      supportsReasoningEffort: 'supported',
      reasoningEffortMapping: {
        low: 'low',
        medium: 'high',
        high: 'high',
        max: 'max',
      },
      reportsReasoningTokens: 'supported',
      completionUsageSemantics: 'completion_tokens_includes_reasoning',
      providerWireMaxOutput: 131_072,
    });
  });

  it('does not grant reasoning capability to an unregistered model-name variant', () => {
    const capability = resolveProviderCapability({
      ...BIGMODEL_CONFIG,
      model_name: 'GLM-5.3-Flash-preview',
    });

    expect(capability.supportsThinking).toBe('unknown');
    expect(capability.supportsReasoningEffort).toBe('unknown');
    expect(capability.reasoningEffortMapping).toBeNull();
  });

  it.each([
    ['fast', 'low'],
    ['standard', 'high'],
    ['quality', 'max'],
  ] as const)('keeps UI quality %s frozen as real %s effort with Thinking enabled', (quality, effort) => {
    const mapped = mapGenerationQualityProfile(quality);
    const frozen = compileKernelStageReasoning({
      scenario: 'continuation',
      modelName: BIGMODEL_CONFIG.model_name,
      requestedEffort: mapped.reasoningEffort,
      continuationThinking: { type: 'enabled' },
    });

    expect(mapped.reasoningEffort).toBe(effort);
    expect(frozen.draft).toMatchObject({
      thinking: { type: 'enabled' },
      reasoningEffort: effort,
    });
    expect(frozen.qa).toMatchObject({
      thinking: { type: 'enabled' },
      reasoningEffort: effort,
    });
  });

  it('sends the mapped effort on the single physical request and records split usage', async () => {
    const fetchMock = jest.fn(async (..._args: any[]) => ({
      ok: true,
      headers: { get: () => null },
      json: async () => ({
        choices: [
          {
            message: { content: '{"ok":true}' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          completion_tokens_details: { reasoning_tokens: 12 },
        },
      }),
    }));
    globalThis.fetch = fetchMock as any;

    const result = await openAICompatibleProvider.generate(
      [{ role: 'user', content: 'Return JSON.' }],
      {
        responseFormat: 'json_object',
        thinking: { type: 'enabled' },
        reasoningEffort: 'medium',
        requestConfig: BIGMODEL_CONFIG,
      },
    );

    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(request.thinking).toEqual({ type: 'enabled' });
    expect(request.reasoning_effort).toBe('high');
    expect(result.reasoningEffortWire).toBe('high');
    expect(result.reasoningEffortSupport).toBe('supported');
    expect(result.reasoningTokens).toBe(12);
    expect(result.visibleOutputTokens).toBe(8);
  });

  it('does not fake effort support for an unknown gateway and never disables Thinking', async () => {
    const genericConfig = {
      ...BIGMODEL_CONFIG,
      provider_adapter_id: null,
      url: 'https://gateway.example.com/v1/chat/completions',
    };
    const capability = resolveProviderCapability(genericConfig);
    expect(capability.supportsReasoningEffort).toBe('unknown');
    expect(capability.reasoningEffortMapping).toBeNull();

    const fetchMock = jest.fn(async (..._args: any[]) => ({
      ok: true,
      headers: { get: () => null },
      json: async () => ({
        choices: [{ message: { content: '正文' }, finish_reason: 'stop' }],
      }),
    }));
    globalThis.fetch = fetchMock as any;

    const result = await openAICompatibleProvider.generate(
      [{ role: 'user', content: '写一段' }],
      {
        thinking: { type: 'enabled' },
        reasoningEffort: 'high',
        requestConfig: genericConfig,
      },
    );

    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(request.thinking).toEqual({ type: 'enabled' });
    expect(request).not.toHaveProperty('reasoning_effort');
    expect(result.reasoningEffortWire).toBeNull();
    expect(result.reasoningEffortSupport).toBe('unknown');
  });
});

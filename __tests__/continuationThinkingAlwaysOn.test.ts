import {
  freezeContinuationThinking,
  freezeV5ModelConfig,
} from '../src/services/continuation/generation/continuationV5Models';
import { buildContinuationKernelFrozenModel } from '../src/services/writing/scenario/continuationRunPreparation';
import { compileKernelStageReasoning } from '../src/services/writing/contracts/stageReasoning';
import { freezeWritingModelConfig } from '../src/services/writing/contracts/freezeModelConfig';
import { openAICompatibleProvider } from '../src/services/llm/openAICompatibleProvider';

const DEEPSEEK_CONFIG = {
  id: 3,
  name: 'Deepseek',
  provider_type: 'openai_compatible' as const,
  api_key: 'test-key',
  model_name: 'deepseek-v4-flash',
  url: 'https://api.deepseek.com/v1/chat/completions',
  context_window: 100_000,
  max_output_tokens: 20_000,
  thinking: { type: 'disabled' as const },
};

describe('DeepSeek V4 writing Thinking Always On contract', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps enabled thinking across the frozen and shared-kernel contracts', () => {
    const frozen = freezeV5ModelConfig(DEEPSEEK_CONFIG);
    const kernelModel = buildContinuationKernelFrozenModel({
      frozenModel: frozen,
    });
    const stageReasoning = compileKernelStageReasoning({
      scenario: 'continuation',
      modelName: frozen.modelName,
      requestedEffort: 'high',
      continuationThinking: frozen.thinking,
    });

    expect(freezeContinuationThinking('deepseek-v4-flash', { type: 'disabled' })).toEqual({
      type: 'enabled',
    });
    expect(frozen.thinking).toEqual({ type: 'enabled' });
    expect(kernelModel.thinking).toEqual({ type: 'enabled' });
    expect(stageReasoning.draft.thinking).toEqual({ type: 'enabled' });
    expect(stageReasoning.qa.thinking).toEqual({ type: 'enabled' });
    expect(stageReasoning.revision.thinking).toEqual({ type: 'enabled' });
  });

  it('normalizes a stale disabled stage snapshot at the continuation Freeze boundary', () => {
    const stageReasoning = compileKernelStageReasoning({
      scenario: 'continuation',
      modelName: 'deepseek-v4-flash',
      requestedEffort: 'high',
      continuationThinking: { type: 'disabled' },
      outlineStageReasoning: {
        draft: { thinking: 'disabled', effort: 'medium' },
        qa: { thinking: { type: 'disabled' }, effectiveTier: 'high' },
        revision: { thinking: 'disabled', effort: 'max' },
      },
    });

    expect(stageReasoning.draft).toEqual({
      thinking: { type: 'enabled' },
      reasoningEffort: 'medium',
    });
    expect(stageReasoning.qa).toEqual({
      thinking: { type: 'enabled' },
      reasoningEffort: 'high',
    });
    expect(stageReasoning.revision).toEqual({
      thinking: { type: 'enabled' },
      reasoningEffort: 'max',
    });
  });

  it('normalizes the shared outline FrozenWritingContext model as well', () => {
    const frozen = freezeWritingModelConfig({
      configId: DEEPSEEK_CONFIG.id,
      provider: DEEPSEEK_CONFIG.provider_type,
      modelName: DEEPSEEK_CONFIG.model_name,
      url: DEEPSEEK_CONFIG.url,
      contextWindow: DEEPSEEK_CONFIG.context_window,
      maxOutputTokens: DEEPSEEK_CONFIG.max_output_tokens,
      thinking: { type: 'disabled' },
      reasoningEffort: 'low',
    });

    expect(frozen.thinking).toEqual({ type: 'enabled' });
  });

  it('separates DeepSeek reasoning from final JSON content while thinking is enabled', async () => {
    const fetchMock = jest.fn(async (..._args: any[]) => ({
      ok: true,
      headers: { get: () => null },
      json: async () => ({
        choices: [
          {
            message: {
              reasoning_content: 'private reasoning',
              content: '{"decision":"clean"}',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 9,
          total_tokens: 21,
          completion_tokens_details: { reasoning_tokens: 4 },
        },
      }),
    }));
    globalThis.fetch = fetchMock as any;

    const result = await openAICompatibleProvider.generate(
      [{ role: 'user', content: 'Return the minimum JSON response.' }],
      {
        responseFormat: 'json_object',
        thinking: { type: 'enabled' },
        reasoningEffort: 'high',
        requestConfig: DEEPSEEK_CONFIG,
      },
    );

    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(request.thinking).toEqual({ type: 'enabled' });
    expect(request.reasoning_effort).toBe('high');
    expect(result.text).toBe('{"decision":"clean"}');
    expect(result.reasoningText).toBe('private reasoning');
    expect(result.emptyReason).toBeUndefined();
    expect(result.finishReason).toBe('stop');
    expect(result.visibleOutputTokens).toBe(5);
  });

  it('fails closed when Thinking returns reasoning only without final content', async () => {
    const fetchMock = jest.fn(async (..._args: any[]) => ({
      ok: true,
      headers: { get: () => null },
      json: async () => ({
        choices: [
          {
            message: { reasoning_content: 'private reasoning', content: null },
            finish_reason: 'length',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 20,
          total_tokens: 32,
        },
      }),
    }));
    globalThis.fetch = fetchMock as any;

    const result = await openAICompatibleProvider.generate(
      [{ role: 'user', content: 'Return the minimum JSON response.' }],
      {
        responseFormat: 'json_object',
        thinking: { type: 'enabled' },
        requestConfig: DEEPSEEK_CONFIG,
      },
    );

    expect(result.text).toBeNull();
    expect(result.reasoningText).toBe('private reasoning');
    expect(result.emptyReason).toBe('reasoning_only');
    expect(result.finishReason).toBe('length');
  });
});

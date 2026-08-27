import {
  resolveEffectiveMaxOutputTokens,
  resolveProviderOutputBudget,
} from '../src/services/llm/providerCapabilities';
import {
  resolveElasticStageOutputReservation,
} from '../src/services/contextAutoAllocator';
import { planAdaptiveBatching } from '../src/services/continuation/canon/adaptiveBatchPlanner';

const bigModelConfig = {
  provider_type: 'openai_compatible' as const,
  model_name: 'GLM-5.3-Flash',
  url: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
  max_output_tokens: 200_000,
};

describe('shared Provider output capability adapter', () => {
  it('translates BigModel logical output to the provider wire limit', () => {
    const resolved = resolveProviderOutputBudget({
      config: bigModelConfig,
      requestedMaxTokens: 200_000,
    });

    // This is the BigModel API contract, not a product/context budget.
    expect(resolved.wireMaxTokens).toBe(131_072);
    expect(resolved.providerLimit).toBe(131_072);
    expect(resolved.adapterId).toBe('open.bigmodel.cn-v4');
    expect(resolved.adapted).toBe(true);
  });

  it('does not truncate an unknown OpenAI-compatible gateway', () => {
    expect(
      resolveProviderOutputBudget({
        config: {
          ...bigModelConfig,
          url: 'https://gateway.example.com/v1/chat/completions',
        },
        requestedMaxTokens: 200_000,
      }).wireMaxTokens,
    ).toBe(200_000);
  });

  it('derives a missing logical output setting from the model context window', () => {
    expect(
      resolveProviderOutputBudget({
        config: {
          ...bigModelConfig,
          context_window: 100_000,
          max_output_tokens: null,
        },
      }).wireMaxTokens,
    ).toBe(20_000);
  });

  it('fails closed instead of manufacturing a fixed output budget', () => {
    expect(() =>
      resolveProviderOutputBudget({
        config: {
          ...bigModelConfig,
          max_output_tokens: null,
        },
      }),
    ).toThrow(/输出预算未解析/);
  });

  it('feeds the same adapter into elastic stage reservations', () => {
    expect(
      resolveElasticStageOutputReservation({
        contextWindow: 1_000_000,
        modelMaxOutputTokens: 200_000,
        providerType: bigModelConfig.provider_type,
        modelName: bigModelConfig.model_name,
        url: bigModelConfig.url,
      }),
    ).toBe(131_072);
  });

  it('uses the adapted output when Canon computes its input envelope', () => {
    const generic = planAdaptiveBatching({
      chapters: [],
      profile: 'deep',
      contextWindow: 200_000,
      maxOutputTokens: 150_000,
    });
    const bigModel = planAdaptiveBatching({
      chapters: [],
      profile: 'deep',
      contextWindow: 200_000,
      maxOutputTokens: 150_000,
      requestConfig: {
        ...bigModelConfig,
        max_output_tokens: 150_000,
      },
    });

    expect(generic.outputReserve).toBe(150_000);
    expect(bigModel.outputReserve).toBe(131_072);
    expect(bigModel.effectiveInputBudget).toBeGreaterThan(
      generic.effectiveInputBudget,
    );
    expect(
      resolveEffectiveMaxOutputTokens({
        providerType: bigModelConfig.provider_type,
        modelName: bigModelConfig.model_name,
        url: bigModelConfig.url,
        configuredMaxOutputTokens: 150_000,
      }),
    ).toBe(131_072);
  });
});

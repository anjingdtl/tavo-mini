import {
  planStoryMemoryRequest,
  resolveStoryMemoryOutputBudget,
  type FrozenStoryMemoryLLMConfig,
} from '../src/services/storyMemory/storyMemoryRequestBudget';

function capability(
  contextWindow: number,
  maxOutputTokens: number,
): FrozenStoryMemoryLLMConfig {
  return {
    configId: 7,
    providerType: 'openai_compatible',
    modelName: 'test-model',
    contextWindow,
    maxOutputTokens,
    requestConfig: {
      id: 7,
      provider_type: 'openai_compatible',
      api_key: 'test',
      model_name: 'test-model',
      url: 'https://example.test/v1/chat/completions',
      context_window: contextWindow,
      max_output_tokens: maxOutputTokens,
    },
  };
}

describe('Story Memory Budget V5 adapter', () => {
  it.each([
    [1_000_000, 200_000, 200_000],
    [1_000_000, 64_000, 64_000],
    [128_000, 32_000, 32_000],
    [128_000, 0, 25_600],
  ])(
    'preserves explicit capability and derives AUTO from context for %s/%s',
    (contextWindow, maxOutputTokens, expected) => {
      expect(
        resolveStoryMemoryOutputBudget({
          contextWindow,
          maxOutputTokens,
          legacyOutputTokens: 800,
          batchSize: 3,
        }),
      ).toBe(expected);
    },
  );

  it('does not let memoryPatchMaxTokens clamp a valid V5 capability', () => {
    const config = capability(1_000_000, 200_000);
    expect(
      planStoryMemoryRequest({
        config,
        legacyOutputTokens: 800,
        batchSize: 3,
        messages: [{ role: 'user', content: '正文' }],
      }).maxTokens,
    ).toBe(200_000);
  });

  it('re-estimates every request envelope independently', () => {
    const config = capability(1_000_000, 200_000);
    const primary = planStoryMemoryRequest({
      config,
      legacyOutputTokens: 1_200,
      batchSize: 3,
      messages: [{ role: 'user', content: '正文' }],
    });
    const repair = planStoryMemoryRequest({
      config,
      legacyOutputTokens: 1_200,
      batchSize: 3,
      messages: [
        { role: 'user', content: '正文' },
        { role: 'assistant', content: '{invalid json '.repeat(200) },
        { role: 'user', content: '请修复 JSON' },
      ],
    });
    expect(repair.estimatedInputTokens).toBeGreaterThan(
      primary.estimatedInputTokens,
    );
    expect(repair.maxTokens).toBe(primary.maxTokens);
    expect(primary.fits).toBe(true);
    expect(repair.fits).toBe(true);
  });

  it('marks a full prompt as preflight-infeasible without truncating it', () => {
    const plan = planStoryMemoryRequest({
      config: capability(128_000, 32_000),
      legacyOutputTokens: 1_200,
      batchSize: 3,
      messages: [{ role: 'user', content: '中'.repeat(110_000) }],
    });
    expect(plan.fits).toBe(false);
    expect(plan.strategy).toBe('preflight_split');
    expect(plan.messages[0].content).toHaveLength(110_000);
  });
});

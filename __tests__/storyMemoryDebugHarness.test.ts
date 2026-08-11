import type { LLMResult } from '../src/services/llm';
import {
  applyStoryMemoryDebugConfig,
  clearStoryMemoryDebugScenarioForTest,
  consumeStoryMemoryDebugScenario,
  injectStoryMemoryDebugResult,
  setStoryMemoryDebugScenarioForTest,
} from '../src/services/storyMemory/storyMemoryDebugHarness';
import { STORY_MEMORY_V2_REQUEST_KINDS } from '../src/services/storyMemory/storyMemoryProtocolVersion';
import type { FrozenStoryMemoryLLMConfig } from '../src/services/storyMemory/storyMemoryRequestBudget';

function result(text: string): LLMResult {
  return {
    text,
    inputTokens: 10,
    outputTokens: 10,
    totalTokens: 20,
    finishReason: 'stop',
  };
}

function config(): FrozenStoryMemoryLLMConfig {
  return {
    configId: 7,
    providerType: 'openai_compatible',
    modelName: 'debug-model',
    contextWindow: 131072,
    maxOutputTokens: 65536,
    requestConfig: {
      id: 7,
      provider_type: 'openai_compatible',
      api_key: 'test-only',
      model_name: 'debug-model',
      url: 'https://example.invalid/v1/chat/completions',
    },
  };
}

afterEach(() => {
  clearStoryMemoryDebugScenarioForTest();
});

describe('Story Memory Debug APK harness', () => {
  it('adds one invalid handle/evidence observation without replacing valid observations', () => {
    const original = result(
      JSON.stringify({
        chapters: [
          {
            chapter: 'CH01',
            observations: [
              {
                kind: 'character_new',
                key: 'N1',
                name: '新人物',
                evidence: ['Q001'],
              },
            ],
          },
        ],
      }),
    );
    const injected = injectStoryMemoryDebugResult(
      original,
      STORY_MEMORY_V2_REQUEST_KINDS.primary,
      'invalid_observation',
    );
    const payload = JSON.parse(injected.text || '{}');
    expect(payload.chapters[0].observations).toHaveLength(2);
    expect(payload.chapters[0].observations[0].evidence).toEqual(['Q001']);
    expect(payload.chapters[0].observations[1].ref).toBe('INVALID_HANDLE');
    expect(payload.chapters[0].observations[1].evidence).toEqual([
      'INVALID_ANCHOR',
    ]);
  });

  it('injects Formatter and Fresh Retry failures only at the intended stages', () => {
    const original = result('{"chapters":[]}');
    expect(
      injectStoryMemoryDebugResult(
        original,
        STORY_MEMORY_V2_REQUEST_KINDS.primary,
        'formatter',
      ).text,
    ).toBe('{"chapters":[');
    expect(
      injectStoryMemoryDebugResult(
        original,
        STORY_MEMORY_V2_REQUEST_KINDS.formatter,
        'formatter',
      ).text,
    ).toBe(original.text);
    expect(
      injectStoryMemoryDebugResult(
        original,
        STORY_MEMORY_V2_REQUEST_KINDS.primary,
        'fresh_retry',
      ).text,
    ).toBe('{"chapters":[');
    expect(
      injectStoryMemoryDebugResult(
        original,
        STORY_MEMORY_V2_REQUEST_KINDS.formatter,
        'fresh_retry',
      ).text,
    ).toBe('{"chapters":[');
    expect(
      injectStoryMemoryDebugResult(
        original,
        STORY_MEMORY_V2_REQUEST_KINDS.freshRetry,
        'fresh_retry',
      ).text,
    ).toBe(original.text);
  });

  it('overrides only the Debug 64K capability snapshot and preserves provider identity', () => {
    const original = config();
    const overridden = applyStoryMemoryDebugConfig(original, 'small_window_64k');
    expect(overridden.contextWindow).toBe(65536);
    expect(overridden.maxOutputTokens).toBe(32768);
    expect(overridden.requestConfig).toMatchObject({
      id: 7,
      model_name: 'debug-model',
      api_key: 'test-only',
      context_window: 65536,
      max_output_tokens: 32768,
    });
    expect(applyStoryMemoryDebugConfig(original, null)).toBe(original);
  });

  it('keeps the scenario seam bounded to the test override and does not synthesize a default', async () => {
    setStoryMemoryDebugScenarioForTest('formatter');
    await expect(consumeStoryMemoryDebugScenario()).resolves.toBe('formatter');
    clearStoryMemoryDebugScenarioForTest();
  });
});

import {
  resolveLLMConfigIdForContextSync,
} from '../src/data/repositories/llmConfigRepository';
import {
  deriveLLMCapabilityFromAutoWindow,
  resolveElasticStageOutputReservation,
} from '../src/services/contextAutoAllocator';

describe('resolveLLMConfigIdForContextSync', () => {
  const configs = [
    { id: 2, is_active: 0 },
    { id: 5, is_active: 1 },
    { id: 9, is_active: 0 },
  ];

  it('prefers the LLM config the user just came from', () => {
    expect(resolveLLMConfigIdForContextSync(configs, 9)).toBe(9);
  });

  it('falls back to the active config when no preferred id is given', () => {
    expect(resolveLLMConfigIdForContextSync(configs)).toBe(5);
    expect(resolveLLMConfigIdForContextSync(configs, 0)).toBe(5);
  });

  it('ignores a preferred id that is not in the list', () => {
    expect(resolveLLMConfigIdForContextSync(configs, 99)).toBe(5);
  });

  it('returns null when there is no saved config', () => {
    expect(resolveLLMConfigIdForContextSync([])).toBeNull();
  });
});

describe('deriveLLMCapabilityFromAutoWindow', () => {
  it('maps 1M context to the 200K elastic output ceiling', () => {
    expect(deriveLLMCapabilityFromAutoWindow(1_000_000)).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 200_000,
    });
  });

  it('keeps the same 80/20 envelope as stage reservations', () => {
    const capability = deriveLLMCapabilityFromAutoWindow(128_000);
    expect(capability).toEqual({
      contextWindow: 128_000,
      maxOutputTokens: 25_600,
    });
    expect(
      resolveElasticStageOutputReservation({
        contextWindow: capability.contextWindow,
        modelMaxOutputTokens: capability.maxOutputTokens,
      }),
    ).toBe(25_600);
  });
});

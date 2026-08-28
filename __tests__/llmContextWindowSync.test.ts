import {
  mergeDraftCapabilityFromPersisted,
  resolveLLMConfigIdForContextSync,
} from '../src/data/repositories/llmConfigRepository';
import {
  deriveLLMCapabilityFromAutoWindow,
  resolveContextAutoSimulationDefault,
  resolveElasticStageOutputReservation,
} from '../src/services/contextAutoAllocator';

describe('resolveLLMConfigIdForContextSync', () => {
  const configs = [
    { id: 2, is_active: 0 },
    { id: 5, is_active: 1 },
    { id: 9, is_active: 0 },
  ];

  it('accepts an explicit saved preferred id', () => {
    expect(resolveLLMConfigIdForContextSync(configs, 9)).toBe(9);
  });

  it('fails closed for missing / draft / unknown ids (no active fallback)', () => {
    expect(resolveLLMConfigIdForContextSync(configs)).toBeNull();
    expect(resolveLLMConfigIdForContextSync(configs, 0)).toBeNull();
    expect(resolveLLMConfigIdForContextSync(configs, 99)).toBeNull();
    expect(resolveLLMConfigIdForContextSync([])).toBeNull();
  });
});

describe('mergeDraftCapabilityFromPersisted', () => {
  it('refreshes capability for the same saved draft', () => {
    const current = {
      id: 5,
      name: 'A',
      context_window: 128_000,
      max_output_tokens: 16_000,
    };
    expect(
      mergeDraftCapabilityFromPersisted(current, {
        id: 5,
        context_window: 256_000,
        max_output_tokens: 32_000,
      }),
    ).toEqual({
      id: 5,
      name: 'A',
      context_window: 256_000,
      max_output_tokens: 32_000,
    });
  });

  it('does not steal another model when the draft is unsaved', () => {
    const draft = {
      id: 0,
      name: '新配置',
      context_window: 4096,
      max_output_tokens: 4000,
    };
    expect(
      mergeDraftCapabilityFromPersisted(draft, {
        id: 5,
        context_window: 1_000_000,
        max_output_tokens: 200_000,
      }),
    ).toBe(draft);
  });
});

describe('resolveContextAutoSimulationDefault', () => {
  const configs = [
    { id: 5, context_window: 128_000, is_active: 1 },
    { id: 9, context_window: 1_000_000, is_active: 0 },
  ];

  it('prefers the selected saved model capability over a legacy mirror value', () => {
    expect(
      resolveContextAutoSimulationDefault({
        savedInput: 512_000,
        preferredConfigId: 9,
        configs,
      }),
    ).toBe(1_000_000);
  });

  it('uses the active saved model capability when no model is explicitly selected', () => {
    expect(
      resolveContextAutoSimulationDefault({
        savedInput: 512_000,
        preferredConfigId: null,
        configs,
      }),
    ).toBe(128_000);
  });

  it('does not fall back to another model for an unsaved draft', () => {
    expect(
      resolveContextAutoSimulationDefault({
        savedInput: null,
        preferredConfigId: 0,
        configs,
        referenceContextWindow: 4096,
      }),
    ).toBe(4096);
  });
});

describe('deriveLLMCapabilityFromAutoWindow', () => {
  it('maps 1M simulation to the preview-only 200K elastic envelope', () => {
    expect(deriveLLMCapabilityFromAutoWindow(1_000_000)).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 200_000,
    });
  });

  it('keeps the same 80/20 envelope as stage reservations (preview only)', () => {
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

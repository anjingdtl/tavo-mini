import {
  decideWritingGovernorWire,
  getWritingGovernorProfileStore,
  markWritingGovernorProfileStoreHydrated,
  observeWritingGovernorResult,
  resetWritingGovernorProfileStore,
  resolveWritingGovernorShadow,
  shouldEnableWritingGovernorProduction,
} from '../src/services/writing/governor/writingGovernor';

const BASE_INPUT = {
  stage: 'draft',
  messages: [{ role: 'user' as const, content: 'cross-profile bootstrap' }],
  legacyWireMax: 131_072,
  contextWindow: 1_000_000,
  completionCapability: 200_000,
  providerWireCeiling: 131_072,
  providerAdapterId: 'open.bigmodel.cn-v4',
  modelName: 'GLM-5.3-Flash',
  targetChars: 500,
  outputContract: 'prose' as const,
  executionProfile: 'standard' as const,
  thinking: { type: 'enabled' as const },
  reasoningEffort: 'max' as const,
};

function input(qualityProfile: 'fast' | 'quality') {
  return { ...BASE_INPUT, qualityProfile };
}

describe('Phase III-C C3 bootstrap production readiness', () => {
  afterEach(() => {
    resetWritingGovernorProfileStore();
  });

  it('does not let a ready Quality profile enable a cold Fast profile', () => {
    const store = getWritingGovernorProfileStore();
    markWritingGovernorProfileStoreHydrated(true);

    let quality = resolveWritingGovernorShadow(input('quality'), store);
    for (let index = 0; index < 3; index += 1) {
      observeWritingGovernorResult(store, quality, {
        actualCompletionUsage: Math.max(
          1,
          Math.floor(quality.recommendedWireMax * 0.2),
        ),
        visibleOutput: 100,
        reasoningUsage: 100,
        finishReason: 'stop',
        latencyMs: 100,
        businessResultValid: true,
        failureClass: null,
      });
      quality = resolveWritingGovernorShadow(input('quality'), store);
    }

    expect(quality.productionReady).toBe(true);

    const fast = resolveWritingGovernorShadow(input('fast'), store);
    expect(fast.profileSampleCount).toBe(0);
    expect(fast.productionReady).toBe(false);

    const enabled = shouldEnableWritingGovernorProduction('draft', fast);
    expect(enabled).toBe(false);

    const decision = decideWritingGovernorWire(fast, enabled);
    expect(decision.enabled).toBe(false);
    expect(decision.wireMax).toBeNull();
  });
});

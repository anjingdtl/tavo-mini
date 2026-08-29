import {
  WRITING_GOVERNOR_VERSION,
  completeWritingGovernorShadow,
  createWritingGovernorProfileStore,
  getWritingGovernorProductionStatus,
  isWritingGovernorProductionReady,
  markWritingGovernorProfileStoreHydrated,
  observeWritingGovernorResult,
  parseWritingGovernorProfiles,
  readWritingGovernorProfile,
  resetWritingGovernorProfileStore,
  resolveWritingGovernorShadow,
  serializeWritingGovernorProfiles,
  shouldEnableWritingGovernorProduction,
} from '../src/services/writing/governor/writingGovernor';

const BASE_INPUT = {
  stage: 'draft',
  messages: [
    { role: 'system' as const, content: '只输出完整正文。' },
    { role: 'user' as const, content: '生成一个安全的章节。' },
  ],
  legacyWireMax: 131_072,
  contextWindow: 1_000_000,
  completionCapability: 200_000,
  providerWireCeiling: 131_072,
  providerAdapterId: 'open.bigmodel.cn-v4',
  modelName: 'GLM-5.3-Flash',
  targetChars: 500,
  outputContract: 'prose' as const,
  qualityProfile: 'quality' as const,
  executionProfile: 'standard' as const,
  thinking: { type: 'enabled' as const },
  reasoningEffort: 'max' as const,
};

function input(overrides: Record<string, unknown> = {}) {
  return { ...BASE_INPUT, ...overrides };
}

function recordCompleteStop(
  store: ReturnType<typeof createWritingGovernorProfileStore>,
  shadow: ReturnType<typeof resolveWritingGovernorShadow>,
  usage = Math.max(1, Math.floor(shadow.recommendedWireMax * 0.5)),
) {
  observeWritingGovernorResult(store, shadow, {
    actualCompletionUsage: usage,
    visibleOutput: Math.max(1, Math.floor(usage * 0.2)),
    reasoningUsage: Math.max(0, Math.floor(usage * 0.8)),
    finishReason: 'stop',
    latencyMs: 100,
    businessResultValid: true,
    failureClass: null,
  });
}

describe('Phase III-C correction: Safe Warm Start / Production Readiness', () => {
  afterEach(() => {
    resetWritingGovernorProfileStore();
  });

  it('does not equate hydrated with ready and gives an empty profile a safe bootstrap', () => {
    const store = createWritingGovernorProfileStore();
    markWritingGovernorProfileStoreHydrated(true);

    const shadow = resolveWritingGovernorShadow(input(), store);

    expect(getWritingGovernorProductionStatus(store).hydrated).toBe(true);
    expect(isWritingGovernorProductionReady(store)).toBe(false);
    expect(shadow.productionState).toBe('BOOTSTRAP_SAFE');
    expect(shadow.productionReady).toBe(false);
    expect(shadow.recommendedSoftBudget).toBeGreaterThan(2_899);
    expect(shadow.recommendedSoftBudget).toBeLessThan(131_072);
  });

  it('projects bootstrap demand from current target and prompt instead of a fixed token table', () => {
    const small = resolveWritingGovernorShadow(input({ targetChars: 500 }));
    const large = resolveWritingGovernorShadow(
      input({
        targetChars: 3_000,
        messages: [
          { role: 'system' as const, content: '只输出完整正文。' },
          { role: 'user' as const, content: '更长的上下文。'.repeat(100) },
        ],
      }),
    );

    expect(large.visibleDemand).toBeGreaterThan(small.visibleDemand);
    expect(large.reasoningEnvelope).toBeGreaterThan(small.reasoningEnvelope);
    expect(large.recommendedSoftBudget).toBeGreaterThan(
      small.recommendedSoftBudget,
    );
  });

  it('keeps a 1M context from linearly inflating the output soft budget', () => {
    const narrow = resolveWritingGovernorShadow(
      input({ contextWindow: 128_000 }),
    );
    const wide = resolveWritingGovernorShadow(
      input({ contextWindow: 1_000_000 }),
    );

    expect(wide.recommendedSoftBudget).toBeLessThan(
      narrow.recommendedSoftBudget * 2,
    );
    expect(wide.contextSafetyReserve).toBeGreaterThan(
      narrow.contextSafetyReserve,
    );
  });

  it('uses historical successful reasoning as a local bootstrap signal', () => {
    const store = createWritingGovernorProfileStore();
    const cold = resolveWritingGovernorShadow(input(), store);
    observeWritingGovernorResult(store, cold, {
      actualCompletionUsage: 8_011,
      visibleOutput: 660,
      reasoningUsage: 7_351,
      finishReason: 'stop',
      latencyMs: 100,
      businessResultValid: true,
      failureClass: null,
    });

    const next = resolveWritingGovernorShadow(input(), store);
    const profile = readWritingGovernorProfile(store, cold.profileKey);
    const lowStore = createWritingGovernorProfileStore();
    const lowCold = resolveWritingGovernorShadow(input(), lowStore);
    observeWritingGovernorResult(lowStore, lowCold, {
      actualCompletionUsage: 120,
      visibleOutput: 20,
      reasoningUsage: 100,
      finishReason: 'stop',
      latencyMs: 100,
      businessResultValid: true,
      failureClass: null,
    });
    const lowNext = resolveWritingGovernorShadow(input(), lowStore);

    expect(next.reasoningEnvelope).toBeGreaterThan(lowNext.reasoningEnvelope);
    expect(next.localProfileWeight).toBeGreaterThan(0);
    expect(profile?.reasoningSampleCount).toBe(1);
    expect(profile?.completeStopCount).toBe(1);
  });

  it('treats length as a censored lower bound, not an exact reasoning sample', () => {
    const store = createWritingGovernorProfileStore();
    const cold = resolveWritingGovernorShadow(input(), store);

    const tripped = completeWritingGovernorShadow(
      cold,
      {
        actualCompletionUsage: cold.recommendedWireMax,
        visibleOutput: 21,
        reasoningUsage: Math.max(0, cold.recommendedWireMax - 21),
        finishReason: 'length',
        latencyMs: 100,
        businessResultValid: false,
        failureClass: null,
      },
      store,
    );
    const profile = readWritingGovernorProfile(store, cold.profileKey);

    expect(tripped.productionState).toBe('TRIPPED');
    expect(profile?.lengthSignalCount).toBe(1);
    expect(profile?.completeStopCount).toBe(0);
    expect(profile?.reasoningSampleCount).toBe(0);
  });

  it('makes length a circuit breaker and raises the next envelope immediately', () => {
    const store = createWritingGovernorProfileStore();
    const cold = resolveWritingGovernorShadow(input(), store);
    observeWritingGovernorResult(store, cold, {
      actualCompletionUsage: cold.recommendedWireMax,
      visibleOutput: 21,
      reasoningUsage: Math.max(0, cold.recommendedWireMax - 21),
      finishReason: 'length',
      latencyMs: 100,
      businessResultValid: false,
    });

    const next = resolveWritingGovernorShadow(input(), store);

    expect(next.productionState).toBe('TRIPPED');
    expect(next.recommendedSoftBudget).toBeGreaterThan(
      cold.recommendedSoftBudget,
    );
  });

  it('treats length without provider usage as a censored trip with no exact sample', () => {
    const store = createWritingGovernorProfileStore();
    const cold = resolveWritingGovernorShadow(input(), store);

    observeWritingGovernorResult(store, cold, {
      actualCompletionUsage: null,
      visibleOutput: null,
      reasoningUsage: null,
      finishReason: 'length',
      latencyMs: null,
      businessResultValid: false,
      failureClass: null,
    });

    const profile = readWritingGovernorProfile(store, cold.profileKey);
    const next = resolveWritingGovernorShadow(input(), store);

    expect(next.productionState).toBe('TRIPPED');
    expect(profile?.knownResultCount).toBe(1);
    expect(profile?.lengthSignalCount).toBe(1);
    expect(profile?.completeStopCount).toBe(0);
    expect(profile?.reasoningSampleCount).toBe(0);
  });

  it('requires recovery evidence after TRIPPED instead of immediately returning ACTIVE', () => {
    const store = createWritingGovernorProfileStore();
    let shadow = resolveWritingGovernorShadow(input(), store);
    for (let index = 0; index < 3; index += 1) {
      recordCompleteStop(store, shadow);
      shadow = resolveWritingGovernorShadow(input(), store);
    }
    observeWritingGovernorResult(store, shadow, {
      actualCompletionUsage: shadow.recommendedWireMax,
      visibleOutput: 21,
      reasoningUsage: Math.max(0, shadow.recommendedWireMax - 21),
      finishReason: 'length',
      latencyMs: 100,
      businessResultValid: false,
    });

    const afterTrip = resolveWritingGovernorShadow(input(), store);
    expect(afterTrip.productionState).toBe('TRIPPED');
    recordCompleteStop(store, afterTrip);
    const afterOneRecovery = resolveWritingGovernorShadow(input(), store);
    expect(afterOneRecovery.productionReady).toBe(false);
  });

  it('does not let an unsafe counterfactual success pass the production gate', () => {
    const store = createWritingGovernorProfileStore();
    const shadow = resolveWritingGovernorShadow(input(), store);
    observeWritingGovernorResult(store, shadow, {
      actualCompletionUsage: shadow.recommendedWireMax + 1,
      visibleOutput: 100,
      reasoningUsage: shadow.recommendedWireMax,
      finishReason: 'stop',
      latencyMs: 100,
      businessResultValid: true,
    });

    const next = resolveWritingGovernorShadow(input(), store);

    expect(next.counterfactualUtilization).toBeNull();
    expect(next.productionReady).toBe(false);
    expect(getWritingGovernorProductionStatus(store).counterfactualUnsafeCount).toBe(
      1,
    );
  });

  it('allows enough complete, exact, counterfactually safe history to become ACTIVE', () => {
    const store = createWritingGovernorProfileStore();
    let shadow = resolveWritingGovernorShadow(input(), store);
    for (let index = 0; index < 5; index += 1) {
      recordCompleteStop(store, shadow);
      shadow = resolveWritingGovernorShadow(input(), store);
    }

    expect(shadow.productionState).toBe('ACTIVE');
    expect(shadow.productionReady).toBe(true);
    expect(shadow.completeStopCount).toBe(5);
    expect(shadow.reasoningExactSampleCount).toBe(5);
    expect(shadow.counterfactualSafeCount).toBe(5);
  });

  it('only tightens after a consecutive healthy streak and does so slowly', () => {
    const store = createWritingGovernorProfileStore();
    let shadow = resolveWritingGovernorShadow(input(), store);
    const initial = readWritingGovernorProfile(store, shadow.profileKey);

    for (let index = 0; index < 3; index += 1) {
      recordCompleteStop(store, shadow, Math.max(1, Math.floor(shadow.recommendedWireMax * 0.2)));
      shadow = resolveWritingGovernorShadow(input(), store);
    }

    const tightened = readWritingGovernorProfile(store, shadow.profileKey);
    expect(initial?.recommendedScale ?? 1).toBe(1);
    expect(tightened?.completeStopCount).toBe(3);
    expect(tightened?.lowUtilizationCount).toBe(3);
    expect(tightened?.recommendedScale).toBeLessThan(1);
    expect(tightened?.recommendedScale).toBeGreaterThanOrEqual(0.75);
  });

  it('does not learn from unknown, network, or 5xx outcomes', () => {
    const store = createWritingGovernorProfileStore();
    const cold = resolveWritingGovernorShadow(input(), store);
    recordCompleteStop(store, cold, 1_000);
    const before = readWritingGovernorProfile(store, cold.profileKey);
    const next = resolveWritingGovernorShadow(input(), store);

    for (const failureClass of [
      'outcome_unknown',
      'network_error',
      'http_5xx',
    ]) {
      observeWritingGovernorResult(store, next, {
        actualCompletionUsage: 50_000,
        visibleOutput: 1,
        reasoningUsage: 49_999,
        finishReason: 'stop',
        latencyMs: 999_999,
        businessResultValid: true,
        failureClass,
      });
    }

    expect(readWritingGovernorProfile(store, cold.profileKey)).toEqual(before);
  });

  it('keeps Thinking required and uses no physical Governor call', async () => {
    markWritingGovernorProfileStoreHydrated(true);
    const store = createWritingGovernorProfileStore();
    const shadow = resolveWritingGovernorShadow(input(), store);
    expect(shadow.thinkingEnabled).toBe(true);

    const callStage = jest.fn(async () => ({
      text: '完整正文。',
      inputTokens: 12,
      outputTokens: 6,
      totalTokens: 18,
      visibleOutputTokens: 6,
      finishReason: 'stop',
    }));
    expect(callStage).toHaveBeenCalledTimes(0);
    expect(shouldEnableWritingGovernorProduction('draft')).toBe(true);
    expect(shouldEnableWritingGovernorProduction('qa')).toBe(false);
    expect(shouldEnableWritingGovernorProduction('revision')).toBe(false);
  });

  it('does not admit a legacy shadow-v2 profile into the production policy', () => {
    const shadow = resolveWritingGovernorShadow(input());
    const oldStore = createWritingGovernorProfileStore({
      [shadow.profileKey]: {
        version: 1,
        profileKey: shadow.profileKey,
        sampleCount: 99,
        knownResultCount: 99,
        lowUtilizationCount: 0,
        lengthSignalCount: 0,
        recommendedScale: 0.75,
        averageCompletionRatio: 0.1,
        averageLatencyMs: 1,
        reasoningSampleCount: 99,
        reasoningRatioEwma: 0.1,
        reasoningRatioHighWater: 0.1,
        reasoningPromptRatioEwma: 0.1,
        reasoningPromptRatioHighWater: 0.1,
        lastFinishReason: 'stop',
        updatedAt: Date.now(),
      } as any,
    });

    const isolated = resolveWritingGovernorShadow(input(), oldStore);
    expect(WRITING_GOVERNOR_VERSION).not.toBe('writing-governor-shadow-v2');
    expect(isolated.profileSampleCount).toBe(0);
    expect(isolated.productionState).toBe('BOOTSTRAP_SAFE');
  });

  it('round-trips the versioned aggregate while preserving a TRIPPED state', () => {
    const store = createWritingGovernorProfileStore();
    const cold = resolveWritingGovernorShadow(input(), store);
    observeWritingGovernorResult(store, cold, {
      actualCompletionUsage: null,
      visibleOutput: null,
      reasoningUsage: null,
      finishReason: 'length',
      latencyMs: null,
      businessResultValid: false,
      failureClass: null,
    });

    const serialized = serializeWritingGovernorProfiles(store);
    const restored = parseWritingGovernorProfiles(serialized);
    const profile = readWritingGovernorProfile(restored, cold.profileKey);
    const shadow = resolveWritingGovernorShadow(input(), restored);

    expect(JSON.parse(serialized).version).toBe(2);
    expect(serialized).not.toContain('生成一个安全的章节');
    expect(profile?.version).toBe(2);
    expect(profile?.productionState).toBe('TRIPPED');
    expect(profile?.reasoningSampleCount).toBe(0);
    expect(shadow.productionState).toBe('TRIPPED');
    expect(shadow.productionReady).toBe(false);
  });
});

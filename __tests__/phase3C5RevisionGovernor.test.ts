import {
  createWritingGovernorProfileStore,
  decideWritingGovernorWire,
  markWritingGovernorProfileStoreHydrated,
  observeWritingGovernorResult,
  readWritingGovernorProfile,
  resetWritingGovernorProfileStore,
  resolveWritingGovernorShadow,
  shouldEnableWritingGovernorProduction,
} from '../src/services/writing/governor/writingGovernor';

const BASE_INPUT = {
  stage: 'revision',
  messages: [
    { role: 'system' as const, content: '只输出完整修订合同。' },
    { role: 'user' as const, content: '保留已成立事实并修复已定位问题。' },
  ],
  legacyWireMax: 131_072,
  contextWindow: 1_000_000,
  completionCapability: 200_000,
  providerWireCeiling: 131_072,
  providerAdapterId: 'open.bigmodel.cn-v4',
  modelName: 'GLM-5.3-Flash',
  targetChars: 500,
  outputContract: 'json_envelope' as const,
  qualityProfile: 'standard' as const,
  executionProfile: 'standard' as const,
  thinking: { type: 'enabled' as const },
  reasoningEffort: 'high' as const,
};

function input(overrides: Record<string, unknown> = {}) {
  return { ...BASE_INPUT, ...overrides };
}

describe('Phase III-C C5 Revision Governor', () => {
  afterEach(() => {
    resetWritingGovernorProfileStore();
  });

  it('uses a Revision-specific exact prior and can safely warm-start its wire', () => {
    const store = createWritingGovernorProfileStore();
    markWritingGovernorProfileStoreHydrated(true);

    const revision = resolveWritingGovernorShadow(input(), store);
    const draft = resolveWritingGovernorShadow(
      { ...input(), stage: 'draft', outputContract: 'prose' },
      store,
    );
    const qa = resolveWritingGovernorShadow(
      { ...input(), stage: 'qa' },
      store,
    );

    expect(revision.profileKey).not.toBe(draft.profileKey);
    expect(revision.profileKey).not.toBe(qa.profileKey);
    expect(revision.bootstrapPriorMatch).toBe('exact_provider_model');
    expect(revision.bootstrapPriorSource).toContain('C4');
    expect(revision.productionReady).toBe(false);

    const enabled = shouldEnableWritingGovernorProduction('revision', revision);
    expect(enabled).toBe(true);
    const decision = decideWritingGovernorWire(revision, enabled);
    expect(decision.enabled).toBe(true);
    expect(decision.blocked).toBe(false);
    expect(decision.wireMax).toBeGreaterThanOrEqual(revision.demandFloor);
    expect(decision.wireMax).toBeLessThan(revision.legacyWireMax);
  });

  it('requires Revision-owned known stop evidence before leaving probation', () => {
    const store = createWritingGovernorProfileStore();
    markWritingGovernorProfileStoreHydrated(true);
    let shadow = resolveWritingGovernorShadow(input(), store);

    for (let index = 0; index < 3; index += 1) {
      observeWritingGovernorResult(store, shadow, {
        actualCompletionUsage: Math.max(1, Math.floor(shadow.recommendedWireMax * 0.45)),
        visibleOutput: 1_100,
        reasoningUsage: 6_500,
        finishReason: 'stop',
        latencyMs: 100,
        businessResultValid: true,
        failureClass: null,
      });
      shadow = resolveWritingGovernorShadow(input(), store);
    }

    expect(readWritingGovernorProfile(store, shadow.profileKey)?.completeStopCount).toBe(3);
    expect(shadow.productionReady).toBe(true);
    expect(shouldEnableWritingGovernorProduction('revision', shadow)).toBe(true);
  });

  it('keeps malformed, unknown, and length outcomes fail-closed and non-retryable', () => {
    const store = createWritingGovernorProfileStore();
    markWritingGovernorProfileStoreHydrated(true);
    const shadow = resolveWritingGovernorShadow(input(), store);

    observeWritingGovernorResult(store, shadow, {
      actualCompletionUsage: 4_000,
      visibleOutput: 0,
      reasoningUsage: null,
      finishReason: 'stop',
      latencyMs: 100,
      businessResultValid: false,
      failureClass: 'invalid_schema',
    });
    observeWritingGovernorResult(store, shadow, {
      actualCompletionUsage: null,
      visibleOutput: null,
      reasoningUsage: null,
      finishReason: null,
      latencyMs: 100,
      businessResultValid: false,
      failureClass: 'outcome_unknown',
    });
    expect(readWritingGovernorProfile(store, shadow.profileKey)).toBeNull();

    observeWritingGovernorResult(store, shadow, {
      actualCompletionUsage: shadow.recommendedWireMax,
      visibleOutput: 4,
      reasoningUsage: shadow.recommendedWireMax - 4,
      finishReason: 'length',
      latencyMs: 100,
      businessResultValid: false,
      failureClass: null,
    });
    const tripped = resolveWritingGovernorShadow(input(), store);
    expect(tripped.productionState).toBe('TRIPPED');
    expect(tripped.productionReady).toBe(false);
    expect(shouldEnableWritingGovernorProduction('revision', tripped)).toBe(false);
    expect(decideWritingGovernorWire(tripped, false).wireMax).toBeNull();
  });
});

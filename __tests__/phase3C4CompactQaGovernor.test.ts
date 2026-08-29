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
  stage: 'qa',
  messages: [{ role: 'user' as const, content: 'compact qa governor' }],
  legacyWireMax: 1_200,
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

describe('Phase III-C C4 Compact QA Governor', () => {
  afterEach(() => {
    resetWritingGovernorProfileStore();
  });

  it('uses a QA-specific safe warm start without inheriting Draft or generic production', () => {
    const store = createWritingGovernorProfileStore();
    markWritingGovernorProfileStoreHydrated(true);

    const qa = resolveWritingGovernorShadow(BASE_INPUT, store);
    const draft = resolveWritingGovernorShadow(
      {
        ...BASE_INPUT,
        stage: 'draft',
        outputContract: 'prose',
      },
      store,
    );
    const generic = resolveWritingGovernorShadow(
      {
        ...BASE_INPUT,
        providerAdapterId: 'unknown-adapter',
        modelName: 'unknown-model',
      },
      store,
    );

    expect(qa.profileKey).not.toBe(draft.profileKey);
    expect(qa.bootstrapPriorMatch).toBe('exact_provider_model');
    expect(qa.visibleDemand).toBeLessThan(qa.reasoningEnvelope);
    expect(qa.recommendedWireMax).toBeGreaterThan(BASE_INPUT.legacyWireMax);
    expect(shouldEnableWritingGovernorProduction('qa', qa)).toBe(true);
    expect(decideWritingGovernorWire(qa, true)).toEqual(
      expect.objectContaining({ enabled: true, blocked: false }),
    );
    expect(generic.bootstrapPriorMatch).toBe('generic_reasoning_model');
    expect(shouldEnableWritingGovernorProduction('qa', generic)).toBe(false);
    expect(decideWritingGovernorWire(generic, false).enabled).toBe(false);
  });

  it('requires QA-owned stop and counterfactual evidence before leaving probation', () => {
    const store = createWritingGovernorProfileStore();
    markWritingGovernorProfileStoreHydrated(true);
    let shadow = resolveWritingGovernorShadow(BASE_INPUT, store);

    observeWritingGovernorResult(store, shadow, {
      actualCompletionUsage: 2_000,
      visibleOutput: 80,
      reasoningUsage: 1_800,
      finishReason: 'stop',
      latencyMs: 100,
      businessResultValid: true,
      failureClass: null,
    });
    shadow = resolveWritingGovernorShadow(BASE_INPUT, store);
    expect(shadow.completeStopCount).toBe(1);
    expect(shadow.productionReady).toBe(false);

    for (let index = 0; index < 2; index += 1) {
      observeWritingGovernorResult(store, shadow, {
        actualCompletionUsage: 2_000,
        visibleOutput: 80,
        reasoningUsage: 1_800,
        finishReason: 'stop',
        latencyMs: 100,
        businessResultValid: true,
        failureClass: null,
      });
      shadow = resolveWritingGovernorShadow(BASE_INPUT, store);
    }

    const profile = readWritingGovernorProfile(store, shadow.profileKey);
    expect(profile?.completeStopCount).toBe(3);
    expect(shadow.productionReady).toBe(true);
    expect(shouldEnableWritingGovernorProduction('qa', shadow)).toBe(true);
  });

  it('does not learn malformed/unknown results and trips on length without exact reasoning', () => {
    const store = createWritingGovernorProfileStore();
    markWritingGovernorProfileStoreHydrated(true);
    const malformed = resolveWritingGovernorShadow(BASE_INPUT, store);

    observeWritingGovernorResult(store, malformed, {
      actualCompletionUsage: 1_200,
      visibleOutput: 0,
      reasoningUsage: null,
      finishReason: 'stop',
      latencyMs: 100,
      businessResultValid: false,
      failureClass: 'invalid_schema',
    });
    observeWritingGovernorResult(store, malformed, {
      actualCompletionUsage: null,
      visibleOutput: null,
      reasoningUsage: null,
      finishReason: null,
      latencyMs: 100,
      businessResultValid: false,
      failureClass: 'outcome_unknown',
    });
    expect(readWritingGovernorProfile(store, malformed.profileKey)).toBeNull();

    observeWritingGovernorResult(store, malformed, {
      actualCompletionUsage: 1_200,
      visibleOutput: 4,
      reasoningUsage: 1_196,
      finishReason: 'length',
      latencyMs: 100,
      businessResultValid: false,
      failureClass: null,
    });
    const tripped = resolveWritingGovernorShadow(BASE_INPUT, store);
    expect(tripped.productionState).toBe('TRIPPED');
    expect(tripped.reasoningExactSampleCount).toBe(0);
    expect(tripped.counterfactualSafeCount).toBe(0);
    expect(shouldEnableWritingGovernorProduction('qa', tripped)).toBe(false);
  });
});

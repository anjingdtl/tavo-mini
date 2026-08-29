/**
 * Phase III-C v2 C2 Red Tests.
 *
 * C2 must calculate a deterministic shadow recommendation at the final
 * Request Boundary without changing the legacy wire request or issuing a
 * second LLM call. The profile learner may retain aggregate usage/latency
 * only; unknown outcomes are deliberately not learnable samples.
 */
import { compileSharedWritingPrompt } from '../src/services/writing/prompt/sharedPromptCompiler';
import { executeSharedWriterStage } from '../src/services/writing/stages/writerCore';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { outlineRequest } from './helpers/oneShotFixtures';
import {
  createWritingGovernorProfileStore,
  observeWritingGovernorResult,
  readWritingGovernorProfile,
  resolveWritingGovernorShadow,
  serializeWritingGovernorProfiles,
} from '../src/services/writing/governor/writingGovernor';

function makeStageInput(values: Record<string, unknown> = {}) {
  const { frozenContext, trace } = buildWritingKernelFreezeTrace({
    request: outlineRequest({
      pipelineTopologyVersion: 'compact_standard',
      qualityProfile: 'standard',
      targetChapterChars: 500,
      ...values,
    }),
  });
  return {
    frozenContext,
    trace,
    stageInput: {
      frozenContext,
      artifacts: {},
      requirements: frozenContext.requirements,
      stagePolicy: frozenContext.stagePolicy,
      trace,
      modelConfig: {
        configId: frozenContext.model.configId,
        name: frozenContext.model.name || 'cfg',
        providerType: frozenContext.model.provider,
        providerAdapterId: frozenContext.model.providerAdapterId,
        url: frozenContext.model.url || '',
        modelName: frozenContext.model.modelName,
        contextWindow: frozenContext.model.contextWindow,
        maxOutputTokens: frozenContext.model.maxOutputTokens,
      },
    } as any,
  };
}

function shadowInput(overrides: Record<string, unknown> = {}) {
  return {
    stage: 'draft',
    messages: [
      { role: 'system' as const, content: '只输出完整正文。' },
      { role: 'user' as const, content: '生成一个安全的章节。' },
    ],
    legacyWireMax: 200_000,
    contextWindow: 1_000_000,
    completionCapability: 200_000,
    providerWireCeiling: 131_072,
    providerAdapterId: 'open.bigmodel.cn-v4',
    modelName: 'GLM-5.3-Flash',
    targetChars: 1_000,
    outputContract: 'prose' as const,
    qualityProfile: 'standard' as const,
    executionProfile: 'standard' as const,
    thinking: { type: 'enabled' as const },
    reasoningEffort: 'high' as const,
    ...overrides,
  };
}

describe('Phase III-C v2 C2 Governor Shadow Red Tests', () => {
  test('separates demand, soft budget, hard capability, and legacy wire value', () => {
    const shadow = resolveWritingGovernorShadow(shadowInput());

    expect(shadow.actualPromptTokens).toBeGreaterThan(0);
    expect(shadow.demandFloor).toBeGreaterThan(0);
    expect(shadow.recommendedSoftBudget).toBeGreaterThanOrEqual(
      shadow.demandFloor,
    );
    expect(shadow.hardCeiling).toBeLessThanOrEqual(131_072);
    expect(shadow.recommendedWireMax).toBeLessThanOrEqual(
      shadow.hardCeiling,
    );
    expect(shadow.recommendedWireMax).toBeLessThan(
      shadow.completionCapability,
    );
    expect(shadow.legacyWireMax).toBe(200_000);
    expect(shadow.profileKey).toMatch(/^[a-f0-9]{64}$/);
    expect(shadow.coldStart).toBe(true);
    expect(shadow.learned).toBe(false);
  });

  test('higher reasoning policy raises the reasoning envelope without a fixed absolute cap', () => {
    const low = resolveWritingGovernorShadow(
      shadowInput({ qualityProfile: 'fast', reasoningEffort: 'low' }),
    );
    const quality = resolveWritingGovernorShadow(
      shadowInput({ qualityProfile: 'quality', reasoningEffort: 'max' }),
    );

    expect(quality.reasoningEnvelope).toBeGreaterThan(low.reasoningEnvelope);
    expect(quality.demandFloor).toBeGreaterThan(low.demandFloor);
    expect(quality.recommendedSoftBudget).toBeGreaterThan(
      low.recommendedSoftBudget,
    );
  });

  test('context safety reserve cannot inflate output demand when the context window grows', () => {
    const narrow = resolveWritingGovernorShadow(
      shadowInput({
        contextWindow: 128_000,
        completionCapability: 1_000_000,
        providerWireCeiling: null,
      }),
    );
    const wide = resolveWritingGovernorShadow(
      shadowInput({
        contextWindow: 1_000_000,
        completionCapability: 1_000_000,
        providerWireCeiling: null,
      }),
    );

    // Neither recommendation is hard-ceiling bound, so this compares the
    // request demand itself rather than context capacity.
    expect(narrow.hardCeiling).toBeGreaterThan(narrow.recommendedSoftBudget);
    expect(wide.hardCeiling).toBeGreaterThan(wide.recommendedSoftBudget);
    expect(wide.recommendedSoftBudget).toBeLessThan(
      narrow.recommendedSoftBudget * 2,
    );
    expect((wide as any).contextSafetyReserve).toBeGreaterThan(
      (narrow as any).contextSafetyReserve,
    );
    expect((wide as any).outputSafetyReserve).toBeGreaterThan(0);
  });

  test('known high-reasoning results raise the next envelope for the same profile', () => {
    const store = createWritingGovernorProfileStore();
    const cold = resolveWritingGovernorShadow(shadowInput(), store);

    observeWritingGovernorResult(store, cold, {
      actualCompletionUsage: 8_011,
      visibleOutput: 660,
      reasoningUsage: 7_351,
      finishReason: 'stop',
      latencyMs: 100,
      businessResultValid: true,
    });

    const next = resolveWritingGovernorShadow(shadowInput(), store);
    const profile = readWritingGovernorProfile(store, cold.profileKey) as any;
    expect(next.reasoningEnvelope).toBeGreaterThan(cold.reasoningEnvelope);
    expect(profile.reasoningSampleCount).toBe(1);
    expect(profile.reasoningRatioEwma).toBeGreaterThan(1);
    expect(profile.reasoningRatioHighWater).toBeGreaterThan(
      profile.reasoningRatioEwma * 0.9,
    );
  });

  test('low-reasoning samples decay learned room slowly and target demand remains adaptive', () => {
    const store = createWritingGovernorProfileStore();
    const cold = resolveWritingGovernorShadow(shadowInput({ targetChars: 500 }), store);
    observeWritingGovernorResult(store, cold, {
      actualCompletionUsage: 8_011,
      visibleOutput: 660,
      reasoningUsage: 7_351,
      finishReason: 'stop',
      latencyMs: 100,
      businessResultValid: true,
    });
    const afterHigh = resolveWritingGovernorShadow(
      shadowInput({ targetChars: 500 }),
      store,
    );

    for (let i = 0; i < 5; i += 1) {
      observeWritingGovernorResult(store, afterHigh, {
        actualCompletionUsage: 700,
        visibleOutput: 600,
        reasoningUsage: 100,
        finishReason: 'stop',
        latencyMs: 100,
        businessResultValid: true,
      });
    }

    const afterLow = resolveWritingGovernorShadow(
      shadowInput({ targetChars: 500 }),
      store,
    );
    const largerTarget = resolveWritingGovernorShadow(
      shadowInput({ targetChars: 3_000 }),
      store,
    );
    expect(afterLow.reasoningEnvelope).toBeGreaterThan(cold.reasoningEnvelope);
    expect(afterLow.reasoningEnvelope).toBeGreaterThanOrEqual(
      Math.floor(afterHigh.reasoningEnvelope * 0.75),
    );
    expect(largerTarget.profileKey).toBe(afterLow.profileKey);
    expect(largerTarget.visibleDemand).toBeGreaterThan(afterLow.visibleDemand);
    expect(largerTarget.reasoningEnvelope).toBeGreaterThan(
      afterLow.reasoningEnvelope,
    );
  });

  test('unknown, network, and 5xx outcomes never change reasoning profile feedback', () => {
    const store = createWritingGovernorProfileStore();
    const cold = resolveWritingGovernorShadow(shadowInput(), store);
    observeWritingGovernorResult(store, cold, {
      actualCompletionUsage: 8_011,
      visibleOutput: 660,
      reasoningUsage: 7_351,
      finishReason: 'stop',
      latencyMs: 100,
      businessResultValid: true,
    });
    const before = readWritingGovernorProfile(store, cold.profileKey);
    const next = resolveWritingGovernorShadow(shadowInput(), store);

    for (const failureClass of ['outcome_unknown', 'network_error', 'http_5xx']) {
      observeWritingGovernorResult(store, next, {
        actualCompletionUsage: 8_011,
        visibleOutput: 660,
        reasoningUsage: 7_351,
        finishReason: 'stop',
        latencyMs: 999_999,
        businessResultValid: true,
        failureClass,
      });
    }

    expect(readWritingGovernorProfile(store, cold.profileKey)).toEqual(before);
  });

  test('500, 1000, and 3000 targets share a profile while demand follows the current target', () => {
    const store = createWritingGovernorProfileStore();
    const shadows = [500, 1_000, 3_000].map(targetChars =>
      resolveWritingGovernorShadow(
        shadowInput({ targetChars, thinking: { type: 'enabled' as const } }),
        store,
      ),
    );

    expect(new Set(shadows.map(shadow => shadow.profileKey)).size).toBe(1);
    expect(shadows[0].visibleDemand).toBeLessThan(shadows[1].visibleDemand);
    expect(shadows[1].visibleDemand).toBeLessThan(shadows[2].visibleDemand);
    expect(shadows.every(shadow => shadow.thinkingEnabled)).toBe(true);
  });

  test('only known complete results teach an isolated profile and unknown outcomes do not', () => {
    const store = createWritingGovernorProfileStore();
    const cold = resolveWritingGovernorShadow(shadowInput(), store);

    for (let i = 0; i < 4; i += 1) {
      observeWritingGovernorResult(
        store,
        cold,
        {
          actualCompletionUsage: 10,
          visibleOutput: 8,
          reasoningUsage: 2,
          finishReason: 'stop',
          latencyMs: 20,
          businessResultValid: true,
        },
      );
    }
    const learned = readWritingGovernorProfile(store, cold.profileKey);
    expect(learned?.sampleCount).toBe(4);
    expect(learned?.knownResultCount).toBe(4);

    const afterKnown = resolveWritingGovernorShadow(shadowInput(), store);
    expect(afterKnown.learned).toBe(true);
    expect(afterKnown.coldStart).toBe(false);
    expect(afterKnown.recommendedSoftBudget).toBeLessThan(
      cold.recommendedSoftBudget,
    );

    observeWritingGovernorResult(store, afterKnown, {
      actualCompletionUsage: null,
      visibleOutput: null,
      reasoningUsage: null,
      finishReason: null,
      latencyMs: 570_000,
      businessResultValid: false,
      failureClass: 'outcome_unknown',
    });
    const afterUnknown = readWritingGovernorProfile(store, cold.profileKey);
    expect(afterUnknown?.sampleCount).toBe(4);
    expect(afterUnknown?.knownResultCount).toBe(4);

    const serialized = serializeWritingGovernorProfiles(store);
    expect(serialized).not.toContain('只输出完整正文');
    expect(serialized).not.toContain('安全的章节');
  });

  test('shared writer records shadow values while sending the unchanged legacy request and making no extra call', async () => {
    const { stageInput } = makeStageInput({ qualityProfile: 'standard' });
    const compiled = compileSharedWritingPrompt({
      stage: 'draft',
      frozenContext: stageInput.frozenContext,
      artifacts: {},
      requirements: stageInput.frozenContext.requirements,
      stagePolicy: stageInput.frozenContext.stagePolicy,
    });
    const expectedLegacyWireMax = Math.min(
      compiled.maxTokens,
      Math.max(256, stageInput.modelConfig.maxOutputTokens || compiled.maxTokens),
    );
    const callStage = jest.fn(async (_input: any) => ({
      text: 'C2 shadow 正文。',
      inputTokens: 12,
      outputTokens: 6,
      totalTokens: 18,
      visibleOutputTokens: 6,
      finishReason: 'stop',
    }));
    stageInput.callStage = callStage;

    const artifact = await executeSharedWriterStage({
      stage: 'draft',
      stageInput,
    });
    const receipt = artifact.requestReceipts?.[0] as any;

    expect(callStage).toHaveBeenCalledTimes(1);
    expect(callStage.mock.calls[0][0].maxTokens).toBe(expectedLegacyWireMax);
    expect(receipt.governorShadow.legacyWireMax).toBe(expectedLegacyWireMax);
    expect(receipt.governorShadow.providerAdapterId).toBe(
      'openai-compatible-generic',
    );
    expect(receipt.governorShadow).toEqual(
      expect.objectContaining({
        mode: 'shadow',
        actualPromptTokens: expect.any(Number),
        demandFloor: expect.any(Number),
        recommendedSoftBudget: expect.any(Number),
        hardCeiling: expect.any(Number),
        recommendedWireMax: expect.any(Number),
        actualCompletionUsage: 6,
        visibleOutput: expect.any(Number),
        finishReason: 'stop',
      }),
    );
  });
});

/**
 * WP3: per-stage capacity + styleTokens budget planning (Spec §7.1).
 */
import {
  estimateTargetChapterTokens,
  resolveContinuationCategoryShares,
  planContinuationContextBudget,
  planStageCapacity,
  resolveContinuationWriterOutputBudget,
} from '../src/services/continuation/generation/continuationContextBudget';

describe('planStageCapacity', () => {
  it('computes an 80% effective window and 20% output guard', () => {
    const cap = planStageCapacity({
      llmConfigId: 3,
      contextWindow: 8192,
      maxOutputTokens: 2048,
      promptSkeletonTokens: 768,
    });
    expect(cap.llmConfigId).toBe(3);
    expect(cap.contextWindow).toBe(8192);
    expect(cap.maxOutputTokens).toBe(Math.floor(8192 * 0.2));
    expect(cap.promptSkeletonTokens).toBe(768);
    expect(cap.safetyTokens).toBeGreaterThan(0);
    expect(cap.effectiveWindow).toBe(Math.floor(8192 * 0.8));
    expect(cap.inputBudget).toBe(
      cap.effectiveWindow - cap.maxOutputTokens - cap.safetyTokens - 768,
    );
    expect(cap.inputBudget).toBeGreaterThan(256);
  });

  it('yields different budgets for different context windows', () => {
    const small = planStageCapacity({
      llmConfigId: 1,
      contextWindow: 8192,
      maxOutputTokens: 2048,
    });
    const large = planStageCapacity({
      llmConfigId: 2,
      contextWindow: 131_072,
      maxOutputTokens: 4096,
    });
    expect(large.inputBudget).toBeGreaterThan(small.inputBudget);
    // Does not force large stages down to the small window.
    expect(large.contextWindow).toBe(131_072);
    expect(small.contextWindow).toBe(8192);
  });

  it('does not take min of models — planner and writer stay independent', () => {
    const planner = planStageCapacity({
      llmConfigId: 10,
      contextWindow: 128_000,
      maxOutputTokens: 4096,
    });
    const writer = planStageCapacity({
      llmConfigId: 11,
      contextWindow: 8192,
      maxOutputTokens: 2048,
    });
    expect(planner.inputBudget).toBeGreaterThan(writer.inputBudget);
    expect(planner.llmConfigId).not.toBe(writer.llmConfigId);
  });
});

describe('planContinuationContextBudget styleTokens', () => {
  it('includes styleTokens as a share of inputBudget', () => {
    const plan = planContinuationContextBudget({
      modelContextLimit: 32_768,
      writerMaxOutputTokens: 2048,
    });
    expect(plan.styleTokens).toBeGreaterThan(0);
    expect(plan.styleTokens).toBeLessThan(plan.inputBudget);
  });

  it('keeps all category shares (incl. style) inside inputBudget', () => {
    for (const context of [8_192, 32_768, 131_072, 1_000_000]) {
      const plan = planContinuationContextBudget({
        modelContextLimit: context,
        writerMaxOutputTokens: 4_096,
      });
      const sum =
        plan.canonTokens +
        plan.supplementTokens +
        plan.sourceSeamTokens +
        plan.recentBridgeTokens +
        plan.storyMemoryTokens +
        plan.episodicTokens +
        plan.styleTokens;
      expect(sum).toBeLessThanOrEqual(plan.inputBudget);
    }
  });

  it('grows style budget with larger windows without a fixed absolute cap', () => {
    const small = planContinuationContextBudget({
      modelContextLimit: 8_192,
      writerMaxOutputTokens: 2_048,
    });
    const large = planContinuationContextBudget({
      modelContextLimit: 1_000_000,
      writerMaxOutputTokens: 4_096,
    });
    expect(large.styleTokens).toBeGreaterThan(small.styleTokens);
    expect(large.styleTokens).toBeLessThan(large.inputBudget);
  });
});

describe('resolveContinuationWriterOutputBudget', () => {
  it('converts Han-character demand into an elastic token demand signal', () => {
    expect(estimateTargetChapterTokens(3_000)).toBe(9_000);
  });

  it('derives Writer output from demand, configured ceiling, and 20% window cap', () => {
    const budget = resolveContinuationWriterOutputBudget({
      contextWindow: 131_072,
      targetChapterChars: 5_000,
      configuredMaxOutputTokens: 32_768,
    });
    expect(budget.initialOutputTokens).toBe(budget.requestedMaxTokens);
    expect(budget.retryOutputTokens).toBe(budget.requestedMaxTokens);
    expect(budget.requestedMaxTokens).toBeLessThanOrEqual(
      Math.floor(131_072 * 0.2),
    );
  });

  it('does not create a larger Writer retry request on a small window', () => {
    const budget = resolveContinuationWriterOutputBudget({
      contextWindow: 8_192,
      targetChapterChars: 3_000,
      configuredMaxOutputTokens: 16_384,
    });
    expect(budget.initialOutputTokens).toBe(budget.requestedMaxTokens);
    expect(budget.retryOutputTokens).toBe(budget.requestedMaxTokens);
    expect(budget.requestedMaxTokens).toBeLessThanOrEqual(
      Math.floor(8_192 * 0.2),
    );
  });

  it('keeps target demand as a minimum/pressure signal while using an elastic request ceiling', () => {
    const budget = resolveContinuationWriterOutputBudget({
      contextWindow: 1_000_000,
      targetChapterChars: 1_000,
      configuredMaxOutputTokens: 8_000,
    });

    expect(budget.desiredOutput).toBeLessThan(budget.requestedMaxTokens);
    expect(budget.requestedMaxTokens).toBe(8_000);
    expect(budget.requestedMaxTokens).toBeLessThanOrEqual(
      Math.floor(1_000_000 * 0.2),
    );
    expect(budget.minimumOutput).toBeLessThan(budget.requestedMaxTokens);
  });
});

describe('standard stage envelopes', () => {
  it.each([8_192, 32_768, 131_072, 1_000_000])(
    'keeps every stage inside 80%% effective and 20%% output limits at %i',
    contextWindow => {
      for (const configured of [null, 2_048, 32_768]) {
        const stage = planStageCapacity({
          llmConfigId: 1,
          contextWindow,
          maxOutputTokens: configured,
        });
        expect(stage.effectiveWindow).toBe(
          Math.floor(contextWindow * 0.8),
        );
        expect(stage.maxOutputTokens).toBeLessThanOrEqual(
          Math.floor(contextWindow * 0.2),
        );
        expect(stage.inputBudget + stage.maxOutputTokens + stage.safetyTokens + stage.promptSkeletonTokens).toBeLessThanOrEqual(
          stage.effectiveWindow,
        );
      }
    },
  );
});

describe('dynamic continuation proportions', () => {
  it('normalizes category shares and prioritizes seam/Canon under pressure', () => {
    const low = resolveContinuationCategoryShares({
      pressure: 0.05,
      declaredOutputRatio: 0.05,
      hasPrimaryAnchor: false,
    });
    const high = resolveContinuationCategoryShares({
      pressure: 0.9,
      declaredOutputRatio: 0.2,
      hasPrimaryAnchor: true,
    });
    expect(Object.values(low).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(Object.values(high).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(high.canon).toBeGreaterThan(low.canon);
    expect(high.primaryAnchor).toBeGreaterThan(low.primaryAnchor);
    expect(high.supplements).toBeLessThan(low.supplements);
  });

  it('deducts hard context before allocating soft categories', () => {
    const base = planContinuationContextBudget({
      modelContextLimit: 32_768,
      writerMaxOutputTokens: 2_048,
      targetChapterChars: 3_000,
    });
    const constrained = planContinuationContextBudget({
      modelContextLimit: 32_768,
      writerMaxOutputTokens: 2_048,
      targetChapterChars: 3_000,
      hardContextTokens: Math.floor(base.inputBudget * 0.2),
    });
    expect(constrained.residualContextBudget).toBeLessThan(
      base.residualContextBudget,
    );
    expect(constrained.canonTokens).toBeLessThan(base.canonTokens);
  });
});

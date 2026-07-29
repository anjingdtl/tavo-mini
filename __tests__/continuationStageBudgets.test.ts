/**
 * WP3: per-stage capacity + styleTokens budget planning (Spec §7.1).
 */
import {
  planContinuationContextBudget,
  planStageCapacity,
} from '../src/services/continuation/generation/continuationContextBudget';

describe('planStageCapacity', () => {
  it('computes inputBudget = window - maxOut - safety - skeleton', () => {
    const cap = planStageCapacity({
      llmConfigId: 3,
      contextWindow: 8192,
      maxOutputTokens: 2048,
      promptSkeletonTokens: 768,
    });
    expect(cap.llmConfigId).toBe(3);
    expect(cap.contextWindow).toBe(8192);
    expect(cap.maxOutputTokens).toBe(2048);
    expect(cap.promptSkeletonTokens).toBe(768);
    expect(cap.safetyTokens).toBeGreaterThanOrEqual(512);
    expect(cap.inputBudget).toBe(
      8192 - 2048 - cap.safetyTokens - 768,
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
    expect(plan.styleTokens).toBeLessThanOrEqual(
      Math.floor(plan.inputBudget * 0.1),
    );
    expect(plan.styleTokens).toBe(Math.floor(plan.inputBudget * 0.1));
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
    expect(large.styleTokens).toBe(Math.floor(large.inputBudget * 0.1));
    expect(large.styleTokens).toBeGreaterThan(16_000);
  });
});

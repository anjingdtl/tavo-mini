import { clipTextTailToTokenBudget, estimateTokens } from '../src/utils/tokenEstimator';
import { planContinuationContextBudget } from '../src/services/continuation/generation/continuationContextBudget';

describe('continuation long-context budget', () => {
  it('grows the continuity budgets with model context without becoming unbounded', () => {
    const small = planContinuationContextBudget({
      modelContextLimit: 8_192,
      writerMaxOutputTokens: 2_048,
    });
    const large = planContinuationContextBudget({
      modelContextLimit: 1_000_000,
      writerMaxOutputTokens: 4_096,
    });

    expect(large.sourceSeamTokens).toBeGreaterThan(small.sourceSeamTokens);
    expect(large.recentBridgeTokens).toBeGreaterThan(small.recentBridgeTokens);
    expect(large.storyMemoryTokens).toBeGreaterThan(small.storyMemoryTokens);
    expect(large.sourceSeamTokens).toBeLessThanOrEqual(96_000);
    expect(large.reservedOutputTokens).toBeLessThanOrEqual(16_384);
    expect(large.inputBudget).toBeGreaterThan(900_000);
  });

  it.each([8_192, 32_768, 131_072, 1_000_000])(
    'keeps category allocations inside the available input budget for %i tokens',
    context => {
      const plan = planContinuationContextBudget({
        modelContextLimit: context,
        writerMaxOutputTokens: 4_096,
      });
      expect(
        plan.canonTokens +
          plan.supplementTokens +
          plan.sourceSeamTokens +
          plan.recentBridgeTokens +
          plan.storyMemoryTokens +
          plan.episodicTokens,
      ).toBeLessThanOrEqual(plan.inputBudget);
    },
  );

  it('retains the source boundary tail rather than the opening of a chapter', () => {
    const text = '开场信息'.repeat(20) + '【真正的章末事件】林岚拔剑，城门开启。';
    const clipped = clipTextTailToTokenBudget(text, 18);
    expect(clipped).toContain('城门开启');
    expect(estimateTokens(clipped)).toBeLessThanOrEqual(18);
  });
});

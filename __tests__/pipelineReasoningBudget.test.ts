import {
  applyPipelineReasoningBudget,
  resolvePipelineReasoning,
  scalePipelineStageMaxTokens,
} from '../src/services/pipeline/reasoningPolicy';
import type { PipelineConfig } from '../src/types/pipeline';

const BASE: PipelineConfig = {
  pipelineMode: 'full',
  reasoningEffort: 'medium',
  draftPresetId: null,
  reviewPresetId: null,
  factCheckPresetId: null,
  proofPresetId: null,
  draftMaxTokens: 4000,
  reviewMaxTokens: 1500,
  factCheckMaxTokens: 1500,
  proofMaxTokens: 4000,
};

describe('V2 pipeline reasoning budget adaptation', () => {
  test('low < medium < high output reserves for every stage', () => {
    for (const [key, base] of [
      ['draftMaxTokens', BASE.draftMaxTokens],
      ['reviewMaxTokens', BASE.reviewMaxTokens],
      ['factCheckMaxTokens', BASE.factCheckMaxTokens],
      ['proofMaxTokens', BASE.proofMaxTokens],
    ] as const) {
      expect(scalePipelineStageMaxTokens(base, 'low')).toBeLessThan(base);
      expect(scalePipelineStageMaxTokens(base, 'medium')).toBe(base);
      expect(scalePipelineStageMaxTokens(base, 'high')).toBeGreaterThan(base);
      expect(
        applyPipelineReasoningBudget(BASE, 'high')[key],
      ).toBeGreaterThan(applyPipelineReasoningBudget(BASE, 'medium')[key]);
    }
  });

  test('adaptation preserves pipeline mode and preset bindings', () => {
    const high = applyPipelineReasoningBudget(BASE, 'high');
    expect(high.pipelineMode).toBe('full');
    expect(high.reasoningEffort).toBe('high');
    expect(high.draftPresetId).toBeNull();
    expect(high.proofPresetId).toBeNull();
  });

  test('historical V2 snapshots without a tier stay vendor-neutral', () => {
    expect(
      resolvePipelineReasoning(
        { outlineWorkflowVersion: 2, reasoningEffort: undefined },
        {
          provider_type: 'openai_compatible',
          model_name: 'deepseek-v4-flash',
          url: 'https://api.deepseek.com',
        },
      ),
    ).toEqual({ supported: false, historical: true });
  });
});

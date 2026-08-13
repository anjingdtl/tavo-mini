import {
  computeConstructionBudget,
  requiredMinOutput,
} from '../src/services/construction/budget';
import {
  modeScenario,
  modeTarget,
} from '../src/services/construction/targets';

describe('preset construction target contracts', () => {
  it('keeps preset independent and TXT modes first-class', () => {
    expect(modeTarget('preset_independent')).toBe('preset');
    expect(modeTarget('preset_from_text')).toBe('preset');
    expect(modeScenario('preset_independent')).toBe(
      'construction_preset_independent',
    );
    expect(modeScenario('preset_from_text')).toBe(
      'construction_preset_from_text',
    );
  });

  it.each(['compact', 'full', 'deep'] as const)(
    'allocates a distinct %s preset output target',
    detailLevel => {
      expect(requiredMinOutput('preset', undefined, detailLevel)).toBeGreaterThan(0);
      const budget = computeConstructionBudget({
        contextWindow: 32768,
        maxOutputTokens: 8192,
        reservePercent: 15,
        target: 'preset',
        detailLevel,
      });
      expect(budget.generatable).toBe(true);
      expect(budget.entryCount).toBeUndefined();
    },
  );
});

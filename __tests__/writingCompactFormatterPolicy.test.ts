import { allowsFormatterCallForStage } from '../src/services/writing/contracts/executionProfile';

describe('Compact Standard Formatter policy', () => {
  const compactStandard = {
    reviewMode: 'continuation-v5',
    values: { pipelineTopologyVersion: 'compact_standard' },
  };

  test('only ONE QA may use the bounded Formatter rescue', () => {
    expect(allowsFormatterCallForStage(compactStandard, 'draft')).toBe(false);
    expect(allowsFormatterCallForStage(compactStandard, 'qa')).toBe(true);
    expect(allowsFormatterCallForStage(compactStandard, 'revision')).toBe(false);
  });

  test('legacy Standard keeps its historical Formatter compatibility', () => {
    const legacyStandard = { reviewMode: 'continuation-v5', values: {} };
    expect(allowsFormatterCallForStage(legacyStandard, 'draft')).toBe(true);
    expect(allowsFormatterCallForStage(legacyStandard, 'revision')).toBe(true);
  });
});

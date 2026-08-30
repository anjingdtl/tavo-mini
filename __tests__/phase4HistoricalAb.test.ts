import {
  comparePhase4HistoricalAb,
  rateValue,
  type Phase4AbSnapshot,
} from '../src/services/writing/metrics/phase4HistoricalAb';

const historical: Phase4AbSnapshot = {
  label: 'historical_stable',
  firstPassAdoptable: { numerator: 8, denominator: 8 },
  realAndroidLlm: true,
};

const baseline: Phase4AbSnapshot = {
  label: 'phase4_baseline',
  firstPassAdoptable: null,
  realAndroidLlm: true,
  rates: {
    jsonFailure: { numerator: 0, denominator: 38 },
    contextBlock: null,
    length: { numerator: 5, denominator: 38 },
    outcomeUnknown: { numerator: 1, denominator: 38 },
  },
  physicalCalls: 38,
};

describe('Phase IV-6 historical A/B comparator', () => {
  test('does not manufacture a current First-Pass rate when real evidence is missing', () => {
    const result = comparePhase4HistoricalAb({
      historical,
      baseline,
      current: {
        label: 'phase4_current',
        firstPassAdoptable: null,
        realAndroidLlm: false,
      },
    });
    expect(result.status).toBe('hold');
    expect(result.reasons).toContain('current_real_first_pass_sample_missing');
  });

  test('accepts a current sample only when the primary rate clears history and secondary blockers improve', () => {
    const result = comparePhase4HistoricalAb({
      historical,
      baseline,
      current: {
        label: 'phase4_current',
        firstPassAdoptable: { numerator: 8, denominator: 8 },
        realAndroidLlm: true,
        rates: {
          jsonFailure: { numerator: 0, denominator: 8 },
          contextBlock: { numerator: 0, denominator: 8 },
          length: { numerator: 0, denominator: 8 },
          outcomeUnknown: { numerator: 0, denominator: 8 },
        },
        physicalCalls: 16,
      },
    });
    expect(result.status).toBe('go');
    expect(result.primaryRate).toBe(1);
    expect(result.improvedSecondaryMetrics).toContain('length');
  });

  test('rejects a current sample below historical First-Pass', () => {
    const result = comparePhase4HistoricalAb({
      historical,
      baseline,
      current: {
        label: 'phase4_current',
        firstPassAdoptable: { numerator: 7, denominator: 8 },
        realAndroidLlm: true,
        rates: {
          jsonFailure: { numerator: 0, denominator: 8 },
          contextBlock: { numerator: 0, denominator: 8 },
          length: { numerator: 0, denominator: 8 },
          outcomeUnknown: { numerator: 0, denominator: 8 },
        },
        physicalCalls: 16,
      },
    });
    expect(result.status).toBe('no-go');
    expect(result.reasons).toContain('current_first_pass_below_historical');
  });

  test('rateValue is fail-closed for an absent or invalid denominator', () => {
    expect(rateValue({ numerator: 1, denominator: 4 })).toBe(0.25);
    expect(rateValue(null)).toBeNull();
    expect(rateValue({ numerator: 1, denominator: 0 })).toBeNull();
  });
});

/**
 * Phase IV-6 comparison primitives.
 *
 * This module deliberately knows nothing about the database, provider or UI.
 * It only compares already-audited snapshots and returns HOLD when a real
 * current First-Pass sample is absent. That keeps historical evidence useful
 * without allowing a mock/contract run to masquerade as an E2E result.
 */

export interface Phase4Rate {
  numerator: number;
  denominator: number;
}

export type Phase4AbSnapshotLabel =
  | 'historical_stable'
  | 'phase4_baseline'
  | 'phase4_current';

export interface Phase4AbSnapshot {
  label: Phase4AbSnapshotLabel;
  firstPassAdoptable: Phase4Rate | null;
  realAndroidLlm: boolean;
  rates?: {
    jsonFailure?: Phase4Rate | null;
    contextBlock?: Phase4Rate | null;
    length?: Phase4Rate | null;
    outcomeUnknown?: Phase4Rate | null;
  };
  latency?: {
    p50Ms?: number | null;
    p95Ms?: number | null;
  };
  usage?: {
    inputP50?: number | null;
    outputP50?: number | null;
    reasoningP50?: number | null;
  };
  physicalCalls?: number | null;
}

export interface Phase4HistoricalAbComparison {
  status: 'go' | 'hold' | 'no-go';
  primaryRate: number | null;
  historicalPrimaryRate: number | null;
  improvedSecondaryMetrics: string[];
  regressedSecondaryMetrics: string[];
  reasons: string[];
}

/** Convert a counted rate to a fraction, returning null for unusable input. */
export function rateValue(rate: Phase4Rate | null | undefined): number | null {
  if (!rate) return null;
  const numerator = Number(rate.numerator);
  const denominator = Number(rate.denominator);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    !Number.isInteger(numerator) ||
    !Number.isInteger(denominator) ||
    numerator < 0 ||
    denominator <= 0 ||
    numerator > denominator
  ) {
    return null;
  }
  return numerator / denominator;
}

const SECONDARY_RATE_KEYS = [
  'jsonFailure',
  'contextBlock',
  'length',
  'outcomeUnknown',
] as const;

/**
 * Apply the Phase IV-6 decision rule to three evidence snapshots.
 *
 * GO requires: (1) real current Android LLM evidence, (2) current First-Pass
 * at least as high as the historical stable rate, (3) no known secondary
 * failure-rate regression against the C9 baseline, and (4) at least one
 * comparable secondary failure-rate improvement. Missing data is HOLD.
 */
export function comparePhase4HistoricalAb(input: {
  historical: Phase4AbSnapshot;
  baseline: Phase4AbSnapshot;
  current: Phase4AbSnapshot;
}): Phase4HistoricalAbComparison {
  const historicalPrimaryRate = rateValue(input.historical.firstPassAdoptable);
  const primaryRate = rateValue(input.current.firstPassAdoptable);
  const reasons: string[] = [];

  if (historicalPrimaryRate == null) {
    reasons.push('historical_first_pass_sample_missing');
  }
  if (!input.current.realAndroidLlm || primaryRate == null) {
    reasons.push('current_real_first_pass_sample_missing');
  }

  const improvedSecondaryMetrics: string[] = [];
  const regressedSecondaryMetrics: string[] = [];
  for (const key of SECONDARY_RATE_KEYS) {
    const baselineRate = rateValue(input.baseline.rates?.[key]);
    const currentRate = rateValue(input.current.rates?.[key]);
    if (baselineRate == null || currentRate == null) continue;
    if (currentRate < baselineRate) improvedSecondaryMetrics.push(key);
    if (currentRate > baselineRate) regressedSecondaryMetrics.push(key);
  }

  if (historicalPrimaryRate != null && primaryRate != null) {
    if (primaryRate < historicalPrimaryRate) {
      reasons.push('current_first_pass_below_historical');
    }
  }
  for (const key of regressedSecondaryMetrics) {
    reasons.push(`current_${key}_worse_than_baseline`);
  }
  if (
    input.current.realAndroidLlm &&
    primaryRate != null &&
    historicalPrimaryRate != null &&
    regressedSecondaryMetrics.length === 0 &&
    improvedSecondaryMetrics.length === 0
  ) {
    reasons.push('secondary_efficiency_improvement_missing');
  }

  if (reasons.includes('current_first_pass_below_historical')) {
    return {
      status: 'no-go',
      primaryRate,
      historicalPrimaryRate,
      improvedSecondaryMetrics,
      regressedSecondaryMetrics,
      reasons,
    };
  }
  if (regressedSecondaryMetrics.length > 0) {
    return {
      status: 'no-go',
      primaryRate,
      historicalPrimaryRate,
      improvedSecondaryMetrics,
      regressedSecondaryMetrics,
      reasons,
    };
  }
  if (reasons.length > 0) {
    return {
      status: 'hold',
      primaryRate,
      historicalPrimaryRate,
      improvedSecondaryMetrics,
      regressedSecondaryMetrics,
      reasons,
    };
  }
  if (improvedSecondaryMetrics.length === 0) {
    return {
      status: 'hold',
      primaryRate,
      historicalPrimaryRate,
      improvedSecondaryMetrics,
      regressedSecondaryMetrics,
      reasons: ['secondary_efficiency_improvement_missing'],
    };
  }
  return {
    status: 'go',
    primaryRate,
    historicalPrimaryRate,
    improvedSecondaryMetrics,
    regressedSecondaryMetrics,
    reasons: [],
  };
}

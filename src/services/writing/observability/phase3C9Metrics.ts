import { percentileTokens } from './writingChapterObservability';

/**
 * C9 observation-only aggregation.  This module never selects a provider,
 * changes a budget, writes SQLite, or dispatches an LLM request.
 */
export const PHASE3_C9_METRICS_VERSION = 1 as const;

export type Phase3C9CaseKind =
  | 'fast'
  | 'standard_clean'
  | 'standard_issue';

export interface Phase3C9ReceiptLike {
  kind: 'logical_stage' | 'formatter';
  stage: string;
  physicalRequestCount: number | null;
  protocolFallbackCount?: number | null;
  outcome?: string | null;
  finishReason?: string | null;
  failureClass?: string | null;
  failurePhase?: string | null;
  errorCode?: string | null;
  /** Explicit timeout signal; outcome_unknown alone is not a timeout label. */
  timeout?: boolean;
  wireMaxTokens?: number | null;
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    reasoningTokens?: number | null;
    visibleOutputTokens?: number | null;
  } | null;
  timings?: {
    queueWaitMs?: number | null;
    providerElapsedMs?: number | null;
    parseMs?: number | null;
    persistMs?: number | null;
    totalMs?: number | null;
  } | null;
}

export interface Phase3C9CaseObservation {
  id: string;
  kind: Phase3C9CaseKind;
  receipts: readonly Phase3C9ReceiptLike[];
  /** Physical post-writing calls are not represented by request receipts. */
  postWritingAuxiliaryPhysicalCalls?: number | null;
  /** Must be explicit; null means Governor call accounting is incomplete. */
  governorPhysicalCalls: number | null;
  /** Ledger-only calls, for example a durable outcome_unknown boundary. */
  unrepresentedPhysicalCalls?: number | null;
  unrepresentedRequestCount?: number | null;
  unrepresentedOutcomeUnknownRequestCount?: number | null;
}

export interface Phase3C9MetricsInput {
  cases: readonly Phase3C9CaseObservation[];
}

export interface Phase3C9Distribution {
  sampleCount: number;
  missingCount: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
}

export interface Phase3C9Rate {
  count: number;
  denominator: number;
  rate: number | null;
}

export interface Phase3C9Metrics {
  version: 1;
  sample: {
    caseCount: number;
    receiptCount: number;
    paidReceiptCount: number;
    paidRequestDenominator: number;
    missingPhysicalRequestCount: number;
    unrepresentedPhysicalCalls: number;
    unrepresentedRequestCount: number;
  };
  calls: {
    writerPhysicalCalls: number;
    totalPaidCalls: number;
    postWritingAuxiliaryPhysicalCalls: number;
    protocolFallbackCalls: number;
    governorPhysicalCalls: number | null;
  };
  latency: {
    queueWaitMs: Phase3C9Distribution;
    providerElapsedMs: Phase3C9Distribution;
    parseMs: Phase3C9Distribution;
    persistMs: Phase3C9Distribution;
    totalMs: Phase3C9Distribution;
  };
  usage: {
    inputTokens: Phase3C9Distribution;
    outputTokens: Phase3C9Distribution;
    reasoningTokens: Phase3C9Distribution;
    visibleOutputTokens: Phase3C9Distribution;
  };
  budgetUtilization: Phase3C9Distribution;
  rates: {
    timeout: Phase3C9Rate;
    outcomeUnknown: Phase3C9Rate;
    length: Phase3C9Rate;
    invalidFormat: Phase3C9Rate;
  };
  callBudgets: {
    limits: {
      fast: 1;
      standard_clean: 2;
      standard_issue: 3;
    };
    cases: Array<{
      id: string;
      kind: Phase3C9CaseKind;
      writerPhysicalCalls: number;
      maxWriterPhysicalCalls: 1 | 2 | 3;
      governorPhysicalCalls: number | null;
      writerBudgetPass: boolean;
      governorZero: boolean;
      gatePass: boolean;
    }>;
    allWriterBudgetsPass: boolean;
    governorPhysicalCallsAreZero: boolean;
    gatePass: boolean;
  };
  /** Output is deliberately scalar-only; prompt/body/response payloads never pass through. */
  privacy: {
    rawPayloadsIncluded: false;
    promptOrBodyIncluded: false;
  };
}

const CALL_LIMITS = {
  fast: 1,
  standard_clean: 2,
  standard_issue: 3,
} as const;

export function buildPhase3C9Metrics(
  input: Phase3C9MetricsInput,
): Phase3C9Metrics {
  const cases = [...(input.cases || [])];
  const receipts = cases.flatMap(item => [...item.receipts]);
  const receiptCounts = receipts.map(item => readNonNegative(item.physicalRequestCount));
  const paidReceipts = receipts.filter(
    (_, index) => (receiptCounts[index] ?? 0) > 0,
  );
  const missingPhysicalRequestCount = receiptCounts.filter(
    value => value === null,
  ).length;
  const unrepresentedPhysicalCalls = sumOptionalCount(
    cases.map(item => item.unrepresentedPhysicalCalls),
  );
  const unrepresentedRequestCount = sumOptionalCount(
    cases.map(item => item.unrepresentedRequestCount),
  );
  const paidRequestDenominator =
    paidReceipts.length + unrepresentedRequestCount;
  const postWritingAuxiliaryPhysicalCalls = sumOptionalCount(
    cases.map(item => item.postWritingAuxiliaryPhysicalCalls),
  );
  const writerPhysicalCalls =
    sum(receiptCounts) + unrepresentedPhysicalCalls;
  const governorPhysicalCalls = sumNullableCounts(
    cases.map(item => item.governorPhysicalCalls),
  );

  const distributions = {
    queueWaitMs: summarize(
      paidReceipts.map(item => readNonNegative(item.timings?.queueWaitMs)),
      paidRequestDenominator,
    ),
    providerElapsedMs: summarize(
      paidReceipts.map(item =>
        readNonNegative(item.timings?.providerElapsedMs),
      ),
      paidRequestDenominator,
    ),
    parseMs: summarize(
      paidReceipts.map(item => readNonNegative(item.timings?.parseMs)),
      paidRequestDenominator,
    ),
    persistMs: summarize(
      paidReceipts.map(item => readNonNegative(item.timings?.persistMs)),
      paidRequestDenominator,
    ),
    totalMs: summarize(
      paidReceipts.map(item => readNonNegative(item.timings?.totalMs)),
      paidRequestDenominator,
    ),
  };
  const usage = {
    inputTokens: summarize(
      paidReceipts.map(item => readNonNegative(item.usage?.inputTokens)),
      paidRequestDenominator,
    ),
    outputTokens: summarize(
      paidReceipts.map(item => readNonNegative(item.usage?.outputTokens)),
      paidRequestDenominator,
    ),
    reasoningTokens: summarize(
      paidReceipts.map(item => readNonNegative(item.usage?.reasoningTokens)),
      paidRequestDenominator,
    ),
    visibleOutputTokens: summarize(
      paidReceipts.map(item =>
        readNonNegative(item.usage?.visibleOutputTokens),
      ),
      paidRequestDenominator,
    ),
  };
  const budgetUtilization = summarize(
    paidReceipts.map(item => {
      const outputTokens = readNonNegative(item.usage?.outputTokens);
      const wireMaxTokens = readNonNegative(item.wireMaxTokens);
      if (outputTokens === null || wireMaxTokens === null || wireMaxTokens <= 0) {
        return null;
      }
      return outputTokens / wireMaxTokens;
    }),
    paidRequestDenominator,
  );

  const timeoutCount = paidReceipts.filter(isExplicitTimeout).length;
  const outcomeUnknownCount =
    paidReceipts.filter(isOutcomeUnknown).length +
    sumOptionalCount(
      cases.map(item => item.unrepresentedOutcomeUnknownRequestCount),
    );
  const lengthCount = paidReceipts.filter(
    item => String(item.finishReason || '').toLowerCase() === 'length',
  ).length;
  const invalidFormatCount = paidReceipts.filter(
    item =>
      String(item.failureClass || '').toLowerCase() === 'response_invalid' ||
      String(item.failurePhase || '').toLowerCase() === 'parse',
  ).length;

  const caseMetrics = cases.map(item => {
    const caseWriterPhysicalCalls =
      sum(item.receipts.map(receipt => readNonNegative(receipt.physicalRequestCount))) +
      readCount(item.unrepresentedPhysicalCalls);
    const governorPhysicalCallsForCase = readNullableCount(
      item.governorPhysicalCalls,
    );
    const writerBudgetPass = caseWriterPhysicalCalls <= CALL_LIMITS[item.kind];
    const governorZero = governorPhysicalCallsForCase === 0;
    return {
      id: item.id,
      kind: item.kind,
      writerPhysicalCalls: caseWriterPhysicalCalls,
      maxWriterPhysicalCalls: CALL_LIMITS[item.kind],
      governorPhysicalCalls: governorPhysicalCallsForCase,
      writerBudgetPass,
      governorZero,
      gatePass: writerBudgetPass && governorZero,
    };
  });
  const allWriterBudgetsPass =
    caseMetrics.length > 0 && caseMetrics.every(item => item.writerBudgetPass);
  const governorPhysicalCallsAreZero =
    caseMetrics.length > 0 && caseMetrics.every(item => item.governorZero);

  return {
    version: PHASE3_C9_METRICS_VERSION,
    sample: {
      caseCount: cases.length,
      receiptCount: receipts.length,
      paidReceiptCount: paidReceipts.length,
      paidRequestDenominator,
      missingPhysicalRequestCount,
      unrepresentedPhysicalCalls,
      unrepresentedRequestCount,
    },
    calls: {
      writerPhysicalCalls,
      totalPaidCalls:
        writerPhysicalCalls + postWritingAuxiliaryPhysicalCalls,
      postWritingAuxiliaryPhysicalCalls,
      protocolFallbackCalls: sum(
        receipts.map(item => readNonNegative(item.protocolFallbackCount)),
      ),
      governorPhysicalCalls,
    },
    latency: distributions,
    usage,
    budgetUtilization,
    rates: {
      timeout: makeRate(timeoutCount, paidRequestDenominator),
      outcomeUnknown: makeRate(outcomeUnknownCount, paidRequestDenominator),
      length: makeRate(lengthCount, paidRequestDenominator),
      invalidFormat: makeRate(invalidFormatCount, paidRequestDenominator),
    },
    callBudgets: {
      limits: CALL_LIMITS,
      cases: caseMetrics,
      allWriterBudgetsPass,
      governorPhysicalCallsAreZero,
      gatePass:
        allWriterBudgetsPass &&
        governorPhysicalCallsAreZero &&
        missingPhysicalRequestCount === 0,
    },
    privacy: {
      rawPayloadsIncluded: false,
      promptOrBodyIncluded: false,
    },
  };
}

function summarize(
  values: Array<number | null>,
  denominator: number,
): Phase3C9Distribution {
  const clean = values.filter((value): value is number => value !== null);
  const mean =
    clean.length > 0
      ? roundMetric(
          clean.reduce((total, value) => total + value, 0) / clean.length,
        )
      : null;
  return {
    sampleCount: clean.length,
    missingCount: Math.max(0, denominator - clean.length),
    mean,
    p50: roundNullableMetric(percentileTokens(clean, 50)),
    p95: roundNullableMetric(percentileTokens(clean, 95)),
  };
}

function makeRate(count: number, denominator: number): Phase3C9Rate {
  return {
    count,
    denominator,
    rate: denominator > 0 ? roundMetric(count / denominator) : null,
  };
}

function isOutcomeUnknown(receipt: Phase3C9ReceiptLike): boolean {
  return (
    String(receipt.outcome || '').toLowerCase() === 'outcome_unknown' ||
    String(receipt.failureClass || '').toLowerCase() === 'outcome_unknown' ||
    String(receipt.failurePhase || '').toLowerCase() === 'outcome_unknown'
  );
}

function isExplicitTimeout(receipt: Phase3C9ReceiptLike): boolean {
  const errorCode = String(receipt.errorCode || '').toLowerCase();
  return (
    receipt.timeout === true ||
    errorCode.includes('timeout') ||
    String(receipt.failureClass || '').toLowerCase() === 'timeout' ||
    String(receipt.failurePhase || '').toLowerCase() === 'timeout'
  );
}

function readNonNegative(value: unknown): number | null {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function readNullableCount(value: unknown): number | null {
  return readNonNegative(value);
}

function readCount(value: unknown): number {
  return readNonNegative(value) ?? 0;
}

function sum(values: Array<number | null>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function sumOptionalCount(values: Array<number | null | undefined>): number {
  return values.reduce<number>((total, value) => total + readCount(value), 0);
}

function sumNullableCounts(values: Array<number | null>): number | null {
  if (values.some(value => readNullableCount(value) === null)) return null;
  return sum(values);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

function roundNullableMetric(value: number | null): number | null {
  return value === null ? null : roundMetric(value);
}

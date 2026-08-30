/* eslint-env jest */

import {
  buildPhase3C9Metrics,
  type Phase3C9ReceiptLike,
} from '../src/services/writing/observability/phase3C9Metrics';

function receipt(
  overrides: Partial<Phase3C9ReceiptLike> = {},
): Phase3C9ReceiptLike {
  return {
    kind: 'logical_stage',
    stage: 'draft',
    physicalRequestCount: 1,
    protocolFallbackCount: 0,
    outcome: 'succeeded',
    finishReason: 'stop',
    failureClass: null,
    failurePhase: null,
    errorCode: null,
    wireMaxTokens: 1000,
    usage: {
      inputTokens: 100,
      outputTokens: 100,
      reasoningTokens: 80,
      visibleOutputTokens: 20,
    },
    timings: {
      queueWaitMs: 10,
      providerElapsedMs: 100,
      parseMs: 1,
      persistMs: 2,
      totalMs: 103,
    },
    ...overrides,
  };
}

describe('Phase III-C C9 cost, latency and stability metrics', () => {
  test('aggregates physical calls, distributions, rates and dynamic budget without payload leakage', () => {
    const input = {
      cases: [
        {
          id: 'fast-clean-1',
          kind: 'fast' as const,
          receipts: [
            receipt({
              usage: {
                inputTokens: 100,
                outputTokens: 100,
                reasoningTokens: 80,
                visibleOutputTokens: 20,
              },
              timings: {
                queueWaitMs: 10,
                providerElapsedMs: 100,
                parseMs: 1,
                persistMs: 2,
                totalMs: 103,
              },
              prompt: 'secret prompt must not escape',
              rawBody: 'secret body must not escape',
            } as any),
          ],
          postWritingAuxiliaryPhysicalCalls: 0,
          governorPhysicalCalls: 0,
        },
        {
          id: 'standard-clean-1',
          kind: 'standard_clean' as const,
          receipts: [
            receipt({
              stage: 'draft',
              usage: {
                inputTokens: 200,
                outputTokens: 200,
                reasoningTokens: 150,
                visibleOutputTokens: 50,
              },
              wireMaxTokens: 1000,
              timings: {
                queueWaitMs: 20,
                providerElapsedMs: 200,
                parseMs: 1,
                persistMs: 2,
                totalMs: 203,
              },
            }),
            receipt({
              stage: 'qa',
              outcome: 'outcome_unknown',
              failureClass: 'outcome_unknown',
              failurePhase: 'outcome_unknown',
              usage: null,
              timings: {
                queueWaitMs: null,
                providerElapsedMs: null,
                parseMs: null,
                persistMs: null,
                totalMs: null,
              },
            }),
          ],
          postWritingAuxiliaryPhysicalCalls: 2,
          governorPhysicalCalls: 0,
        },
        {
          id: 'standard-issue-1',
          kind: 'standard_issue' as const,
          receipts: [
            receipt({
              stage: 'draft',
              outcome: 'outcome_unknown',
              failureClass: 'outcome_unknown',
              failurePhase: 'outcome_unknown',
              errorCode: 'total_timeout',
              finishReason: null,
              usage: {
                inputTokens: 300,
                outputTokens: 300,
                reasoningTokens: 240,
                visibleOutputTokens: 60,
              },
              timings: {
                queueWaitMs: 30,
                providerElapsedMs: 300,
                parseMs: null,
                persistMs: null,
                totalMs: 300,
              },
            }),
            receipt({
              stage: 'qa',
              finishReason: 'length',
              usage: {
                inputTokens: 400,
                outputTokens: 400,
                reasoningTokens: 300,
                visibleOutputTokens: 100,
              },
              timings: {
                queueWaitMs: 40,
                providerElapsedMs: 400,
                parseMs: 1,
                persistMs: 2,
                totalMs: 403,
              },
              wireMaxTokens: 1000,
            }),
            receipt({
              stage: 'revision',
              kind: 'formatter',
              failureClass: 'response_invalid',
              failurePhase: 'parse',
              outcome: 'failed',
              usage: {
                inputTokens: 500,
                outputTokens: 500,
                reasoningTokens: 350,
                visibleOutputTokens: 150,
              },
              timings: {
                queueWaitMs: 50,
                providerElapsedMs: 500,
                parseMs: 1,
                persistMs: 2,
                totalMs: 503,
              },
              wireMaxTokens: 1000,
              protocolFallbackCount: 1,
            }),
          ],
          postWritingAuxiliaryPhysicalCalls: 0,
          governorPhysicalCalls: 0,
        },
      ],
    };

    const metrics = buildPhase3C9Metrics(input);

    expect(metrics.sample).toMatchObject({
      caseCount: 3,
      receiptCount: 6,
      paidReceiptCount: 6,
      paidRequestDenominator: 6,
    });
    expect(metrics.calls).toMatchObject({
      writerPhysicalCalls: 6,
      totalPaidCalls: 8,
      postWritingAuxiliaryPhysicalCalls: 2,
      protocolFallbackCalls: 1,
      governorPhysicalCalls: 0,
    });
    expect(metrics.latency.queueWaitMs).toMatchObject({
      sampleCount: 5,
      missingCount: 1,
      p50: 30,
      p95: 48,
    });
    expect(metrics.latency.providerElapsedMs).toMatchObject({
      sampleCount: 5,
      p50: 300,
      p95: 480,
    });
    expect(metrics.usage.inputTokens).toMatchObject({
      sampleCount: 5,
      missingCount: 1,
      p50: 300,
      p95: 480,
    });
    expect(metrics.budgetUtilization).toMatchObject({
      sampleCount: 5,
      missingCount: 1,
      mean: 0.3,
      p50: 0.3,
      p95: 0.48,
    });
    expect(metrics.rates).toMatchObject({
      timeout: { count: 1, denominator: 6, rate: 0.1667 },
      outcomeUnknown: { count: 2, denominator: 6, rate: 0.3333 },
      length: { count: 1, denominator: 6, rate: 0.1667 },
      invalidFormat: { count: 1, denominator: 6, rate: 0.1667 },
    });
    expect(metrics.callBudgets.allWriterBudgetsPass).toBe(true);
    expect(metrics.callBudgets.governorPhysicalCallsAreZero).toBe(true);
    expect(JSON.stringify(metrics)).not.toContain('secret prompt');
    expect(JSON.stringify(metrics)).not.toContain('secret body');
  });

  test('preserves ledger-only outcome_unknown calls and fails closed on call-budget violations', () => {
    const metrics = buildPhase3C9Metrics({
      cases: [
        {
          id: 'over-budget',
          kind: 'standard_clean',
          receipts: [
            receipt(),
            receipt({ stage: 'qa' }),
            receipt({ stage: 'revision' }),
          ],
          unrepresentedPhysicalCalls: 1,
          unrepresentedRequestCount: 1,
          unrepresentedOutcomeUnknownRequestCount: 1,
          postWritingAuxiliaryPhysicalCalls: 0,
          governorPhysicalCalls: 1,
        },
      ],
    });

    expect(metrics.calls).toMatchObject({
      writerPhysicalCalls: 4,
      totalPaidCalls: 4,
      governorPhysicalCalls: 1,
    });
    expect(metrics.sample.paidRequestDenominator).toBe(4);
    expect(metrics.rates.outcomeUnknown).toMatchObject({
      count: 1,
      denominator: 4,
      rate: 0.25,
    });
    expect(metrics.callBudgets.allWriterBudgetsPass).toBe(false);
    expect(metrics.callBudgets.governorPhysicalCallsAreZero).toBe(false);
    expect(metrics.callBudgets.gatePass).toBe(false);
  });
});

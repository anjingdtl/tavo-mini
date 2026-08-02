import {
  ContinuationV3RequestBudget,
  ContinuationV3BudgetExhaustedError,
  createV3AdditionalAttemptGuard,
} from '../src/services/continuation/generation/continuationV3RequestBudget';

describe('ContinuationV3RequestBudget (plan §2.4, §5.1)', () => {
  it('allows exactly 4 reservations then blocks the 5th', () => {
    const b = new ContinuationV3RequestBudget();
    expect(b.remaining).toBe(4);
    b.reserve({ stage: 'writer', attemptKind: 'initial' });
    b.reserve({ stage: 'initial_checker', attemptKind: 'initial' });
    b.reserve({ stage: 'integrated_reviser', attemptKind: 'initial' });
    b.reserve({ stage: 'final_checker', attemptKind: 'initial' });
    expect(b.used).toBe(4);
    expect(b.remaining).toBe(0);
    expect(() =>
      b.reserve({ stage: 'final_checker', attemptKind: 'initial' }),
    ).toThrow(ContinuationV3BudgetExhaustedError);
    expect(() =>
      b.reserve({ stage: 'final_checker', attemptKind: 'initial' }),
    ).toThrow(/4 次物理请求上限/);
  });

  it('counts transport retries and format fallbacks against the same cap', () => {
    const b = new ContinuationV3RequestBudget();
    b.reserve({ stage: 'writer', attemptKind: 'initial' });
    b.reserve({ stage: 'writer', attemptKind: 'transport_retry' });
    b.reserve({ stage: 'writer', attemptKind: 'format_fallback' });
    b.reserve({ stage: 'initial_checker', attemptKind: 'initial' });
    expect(b.used).toBe(4);
    expect(() =>
      b.reserve({ stage: 'initial_checker', attemptKind: 'format_fallback' }),
    ).toThrow(ContinuationV3BudgetExhaustedError);
  });

  it('resumes from a persisted state and does not reset the count', () => {
    const initial = {
      physicalRequestCount: 3,
      requests: [
        { ordinal: 1 as const, stage: 'writer' as const, attemptKind: 'initial' as const, reservedAt: 't1', outcome: 'succeeded' as const },
        { ordinal: 2 as const, stage: 'initial_checker' as const, attemptKind: 'initial' as const, reservedAt: 't2', outcome: 'succeeded' as const },
        { ordinal: 3 as const, stage: 'integrated_reviser' as const, attemptKind: 'initial' as const, reservedAt: 't3', outcome: 'reserved' as const },
      ],
    };
    const b = new ContinuationV3RequestBudget({ initial });
    expect(b.used).toBe(3);
    expect(b.remaining).toBe(1);
    // Only one more allowed
    b.reserve({ stage: 'final_checker', attemptKind: 'initial' });
    expect(() =>
      b.reserve({ stage: 'final_checker', attemptKind: 'initial' }),
    ).toThrow(ContinuationV3BudgetExhaustedError);
  });

  it('records success/failure with non-sensitive metrics only', () => {
    const b = new ContinuationV3RequestBudget();
    b.reserve({ stage: 'writer', attemptKind: 'initial' });
    b.recordSuccess('writer', {
      promptTokens: 1000,
      reasoningTokens: 500,
      completionTokens: 2000,
      finishReason: 'stop',
    });
    const snap = b.snapshot();
    expect(snap[0].outcome).toBe('succeeded');
    expect(snap[0].promptTokens).toBe(1000);
    expect(snap[0].reasoningTokens).toBe(500);
    // No prompt text / body / key fields exist on the metric
    expect((snap[0] as any).prompt).toBeUndefined();
    expect((snap[0] as any).text).toBeUndefined();
    expect((snap[0] as any).apiKey).toBeUndefined();
  });

  it('createV3AdditionalAttemptGuard throws when budget exhausted (5th fetch never happens)', () => {
    const b = new ContinuationV3RequestBudget();
    // Fill the budget
    for (let i = 0; i < 4; i += 1) {
      b.reserve({ stage: 'writer', attemptKind: 'initial' });
    }
    const guard = createV3AdditionalAttemptGuard(b, 'writer');
    expect(() => guard({ attemptKind: 'format_fallback' })).toThrow(
      ContinuationV3BudgetExhaustedError,
    );
  });

  it('createV3AdditionalAttemptGuard reserves a slot on format_fallback', () => {
    const b = new ContinuationV3RequestBudget();
    b.reserve({ stage: 'writer', attemptKind: 'initial' });
    const guard = createV3AdditionalAttemptGuard(b, 'writer');
    guard({ attemptKind: 'format_fallback' });
    expect(b.used).toBe(2);
    const snap = b.snapshot();
    expect(snap[1].attemptKind).toBe('format_fallback');
    expect(snap[1].stage).toBe('writer');
  });

  it('serializes to a persisted shape that round-trips', () => {
    const b = new ContinuationV3RequestBudget();
    b.reserve({ stage: 'writer', attemptKind: 'initial' });
    const persisted = b.toPersisted();
    expect(persisted.physicalRequestCount).toBe(1);
    expect(persisted.requests).toHaveLength(1);
    const restored = new ContinuationV3RequestBudget({ initial: persisted });
    expect(restored.used).toBe(1);
  });
});

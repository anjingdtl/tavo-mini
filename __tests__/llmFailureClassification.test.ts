/**
 * Phase 3: LLM failure classification + durable retry scheduling.
 * Covers doc §11/§12: safe_retry / outcome_unknown / rate_limit /
 * account_quota / config_error / context_error / content_filter / fatal,
 * Retry-After priority, 30s/2m/5m backoff with jitter, max 3 auto retries,
 * and timeout → outcome_unknown semantics (request may have executed).
 */
import {
  classifyLLMFailure,
  computeRetryBackoffMs,
  shouldAutoRetryFailure,
  toLLMRequestError,
  LLMRequestError,
  AUTO_RETRY_BACKOFF_MS,
  MAX_AUTO_RETRY_ATTEMPTS,
} from '../src/services/llm/requestPolicy';

describe('classifyLLMFailure', () => {
  it('classifies 429 and explicit rate limits as rate_limit', () => {
    expect(classifyLLMFailure({ httpStatus: 429 })).toBe('rate_limit');
    expect(
      classifyLLMFailure({ code: 'rate_limit_exceeded', message: 'slow down' }),
    ).toBe('rate_limit');
  });

  it('classifies 502/503/504 as safe_retry', () => {
    expect(classifyLLMFailure({ httpStatus: 502 })).toBe('safe_retry');
    expect(classifyLLMFailure({ httpStatus: 503 })).toBe('safe_retry');
    expect(classifyLLMFailure({ httpStatus: 504 })).toBe('safe_retry');
  });

  it('classifies quota / billing messages as account_quota', () => {
    expect(
      classifyLLMFailure({ code: 'insufficient_quota', message: 'top up' }),
    ).toBe('account_quota');
    expect(
      classifyLLMFailure({ message: 'your billing limit has been reached' }),
    ).toBe('account_quota');
    expect(
      classifyLLMFailure({ code: 'balance_not_enough' }),
    ).toBe('account_quota');
  });

  it('classifies invalid key / missing model as config_error', () => {
    expect(classifyLLMFailure({ httpStatus: 401 })).toBe('config_error');
    expect(classifyLLMFailure({ httpStatus: 403 })).toBe('config_error');
    expect(
      classifyLLMFailure({ httpStatus: 404, message: 'model not found' }),
    ).toBe('config_error');
  });

  it('classifies content policy rejections as content_filter', () => {
    expect(classifyLLMFailure({ code: 'content_filter' })).toBe('content_filter');
    expect(
      classifyLLMFailure({ message: 'content_policy_violation' }),
    ).toBe('content_filter');
  });

  it('falls back to fatal for unknown provider errors', () => {
    expect(classifyLLMFailure({ httpStatus: 418 })).toBe('fatal');
    expect(classifyLLMFailure({})).toBe('fatal');
  });
});

describe('computeRetryBackoffMs', () => {
  it('follows 30s → 2m → 5m with 10%~20% jitter', () => {
    for (let i = 1; i <= 3; i += 1) {
      const backoff = computeRetryBackoffMs(i);
      const base = AUTO_RETRY_BACKOFF_MS[i - 1];
      expect(backoff).toBeGreaterThanOrEqual(Math.floor(base * 0.1));
      expect(backoff).toBeLessThanOrEqual(Math.floor(base * 0.2) + 1);
    }
  });

  it('clamps beyond the schedule to the last slot', () => {
    expect(computeRetryBackoffMs(4)).toBeGreaterThanOrEqual(
      Math.floor(AUTO_RETRY_BACKOFF_MS[2] * 0.1),
    );
  });

  it('is deterministic for the same attempt no', () => {
    expect(computeRetryBackoffMs(1)).toBe(computeRetryBackoffMs(1));
    expect(computeRetryBackoffMs(2)).toBe(computeRetryBackoffMs(2));
  });
});

describe('shouldAutoRetryFailure', () => {
  it('allows safe_retry and rate_limit up to MAX attempts', () => {
    expect(
      shouldAutoRetryFailure({ failureClass: 'safe_retry', attemptNo: 1 }),
    ).toBe(true);
    expect(
      shouldAutoRetryFailure({
        failureClass: 'rate_limit',
        attemptNo: MAX_AUTO_RETRY_ATTEMPTS,
      }),
    ).toBe(true);
  });

  it('never auto-retries outcome_unknown / quota / config / fatal', () => {
    for (const cls of [
      'outcome_unknown',
      'account_quota',
      'config_error',
      'context_error',
      'content_filter',
      'fatal',
    ] as const) {
      expect(
        shouldAutoRetryFailure({ failureClass: cls, attemptNo: 1 }),
      ).toBe(false);
    }
  });

  it('stops after MAX_AUTO_RETRY_ATTEMPTS', () => {
    expect(
      shouldAutoRetryFailure({
        failureClass: 'safe_retry',
        attemptNo: MAX_AUTO_RETRY_ATTEMPTS + 1,
      }),
    ).toBe(false);
  });

  it('respects the persisted next_retry_at window', () => {
    const now = 1_000_000;
    expect(
      shouldAutoRetryFailure({
        failureClass: 'safe_retry',
        attemptNo: 1,
        now,
        nextRetryAt: now + 5_000,
      }),
    ).toBe(false);
    expect(
      shouldAutoRetryFailure({
        failureClass: 'safe_retry',
        attemptNo: 1,
        now,
        nextRetryAt: now,
      }),
    ).toBe(true);
  });
});

describe('toLLMRequestError classification (Phase 3)', () => {
  const timeoutController = {
    getAbortCode: () => undefined,
  } as any;

  it('maps connect_timeout to safe_retry (request NOT sent)', () => {
    const ctrl = { getAbortCode: () => 'connect_timeout' } as any;
    const err = toLLMRequestError(new Error('x'), ctrl, 'fallback');
    expect(err).toBeInstanceOf(LLMRequestError);
    expect(err.failureClass).toBe('safe_retry');
    expect(err.requestMayHaveExecuted).toBe(false);
  });

  it('maps total_timeout / idle_timeout to outcome_unknown (may have executed)', () => {
    for (const code of ['total_timeout', 'idle_timeout']) {
      const ctrl = { getAbortCode: () => code } as any;
      const err = toLLMRequestError(new Error('x'), ctrl, 'fallback');
      expect(err.failureClass).toBe('outcome_unknown');
      expect(err.requestMayHaveExecuted).toBe(true);
    }
  });

  it('maps post-send network errors to outcome_unknown', () => {
    const err = toLLMRequestError(
      new TypeError('Network request failed'),
      timeoutController,
      'fallback',
    );
    expect(err.failureClass).toBe('outcome_unknown');
    expect(err.requestMayHaveExecuted).toBe(true);
  });

  it('carries HTTP status, provider code, Retry-After and request id', () => {
    const raw = new Error('API 请求失败 (429, rate_limit): slow') as Error & {
      code?: string;
      status?: number;
      retryAfterMs?: number;
      providerRequestId?: string;
    };
    raw.code = 'rate_limit';
    raw.status = 429;
    raw.retryAfterMs = 12_000;
    raw.providerRequestId = 'req_abc';
    const err = toLLMRequestError(raw, timeoutController, 'fallback');
    expect(err.failureClass).toBe('rate_limit');
    expect(err.httpStatus).toBe(429);
    expect(err.providerCode).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(12_000);
    expect(err.providerRequestId).toBe('req_abc');
    expect(err.requestMayHaveExecuted).toBe(true);
  });

  it('classifies 503 through toLLMRequestError as safe_retry', () => {
    const raw = new Error('API 请求失败 (503, HTTP_503): busy') as Error & {
      code?: string;
      status?: number;
    };
    raw.code = 'HTTP_503';
    raw.status = 503;
    const err = toLLMRequestError(raw, timeoutController, 'fallback');
    expect(err.failureClass).toBe('safe_retry');
  });
});

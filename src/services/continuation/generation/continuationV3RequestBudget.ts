/**
 * V3 physical-request budget tracker (Implementation plan §2.4, §5.1).
 *
 * Single ownership of the 4-physical-fetch cap. Every real HTTP `fetch` — the
 * first fetch of a stage call, a transport retry, a 5xx retry, and a
 * response_format fallback — must reserve a slot here BEFORE the network call.
 * The 5th reservation throws `ContinuationV3BudgetExhaustedError`, so the 5th
 * fetch never happens.
 *
 * Reservation is persisted (plan §2.4: "计数预留要发生在 fetch 之前并持久化；
 * 进程在预留后、发出前崩溃时，恢复后保守视为已消耗"). The Runner passes a
 * `persist` callback so each reservation is written to `token_usage_json` before
 * the network call.
 */
import { MAX_CONTINUATION_V3_PHYSICAL_REQUESTS } from './continuationV3Types';
import type {
  ContinuationV3RequestMetric,
  V3AttemptKind,
  V3StageName,
} from './continuationV3Types';

export class ContinuationV3BudgetExhaustedError extends Error {
  readonly code = 'api_request_budget_exhausted';
  constructor(used: number, cap: number) {
    super(
      `本次续写已达到 ${cap} 次物理请求上限（已消耗 ${used} 次），不能再发起请求。修订未完成时本次 run 将失败，不会隐式发起第 ${cap + 1} 次请求。`,
    );
    this.name = 'ContinuationV3BudgetExhaustedError';
  }
}

export interface V3BudgetPersistedShape {
  physicalRequestCount: number;
  requests: ContinuationV3RequestMetric[];
}

export class ContinuationV3RequestBudget {
  private readonly metrics: ContinuationV3RequestMetric[] = [];
  private readonly cap: number;

  constructor(opts?: {
    initial?: V3BudgetPersistedShape;
    cap?: number;
  }) {
    this.cap = opts?.cap ?? MAX_CONTINUATION_V3_PHYSICAL_REQUESTS;
    if (opts?.initial) {
      for (const m of opts.initial.requests ?? []) this.metrics.push(m);
    }
  }

  /** Number of slots already reserved (and thus consumed). */
  get used(): number {
    return this.metrics.length;
  }

  /** Remaining slots before the cap blocks. */
  get remaining(): number {
    return Math.max(0, this.cap - this.used);
  }

  /**
   * Reserve one physical-request slot for `stage` / `attemptKind`. Throws
   * `ContinuationV3BudgetExhaustedError` if the cap is reached, so the caller
   * never issues the fetch. The reservation is returned so the Runner can
   * persist it before the network call.
   */
  reserve(input: {
    stage: V3StageName;
    attemptKind: V3AttemptKind;
    estimatedPromptTokens?: number;
    requestedMaxTokens?: number;
  }): ContinuationV3RequestMetric {
    if (this.metrics.length >= this.cap) {
      throw new ContinuationV3BudgetExhaustedError(this.metrics.length, this.cap);
    }
    const ordinal = (this.metrics.length + 1) as 1 | 2 | 3 | 4;
    const metric: ContinuationV3RequestMetric = {
      ordinal,
      stage: input.stage,
      attemptKind: input.attemptKind,
      reservedAt: new Date().toISOString(),
      outcome: 'reserved',
      ...(input.estimatedPromptTokens != null
        ? { estimatedPromptTokens: input.estimatedPromptTokens }
        : {}),
      ...(input.requestedMaxTokens != null
        ? { requestedMaxTokens: input.requestedMaxTokens }
        : {}),
    };
    this.metrics.push(metric);
    return metric;
  }

  /**
   * Mark the most recent reservation for `stage` as succeeded with usage data.
   * Non-sensitive metrics only (plan §4.3): no prompt text, body, key, or
   * provider full error.
   */
  recordSuccess(
    stage: V3StageName,
    data: {
      startedAt?: string;
      finishedAt?: string;
      durationMs?: number;
      promptTokens?: number;
      reasoningTokens?: number;
      completionTokens?: number;
      cacheHitTokens?: number;
      cacheMissTokens?: number;
      finishReason?: string | null;
      emptyReason?: string | null;
    },
  ): void {
    const metric = this.latestForStage(stage);
    if (!metric) return;
    Object.assign(metric, data, { outcome: 'succeeded' as const });
  }

  /** Mark the most recent reservation for `stage` as failed. */
  recordFailure(
    stage: V3StageName,
    data: { errorCode?: string; durationMs?: number },
  ): void {
    const metric = this.latestForStage(stage);
    if (!metric) return;
    Object.assign(metric, data, { outcome: 'failed' as const });
  }

  private latestForStage(stage: V3StageName): ContinuationV3RequestMetric | undefined {
    for (let i = this.metrics.length - 1; i >= 0; i -= 1) {
      if (this.metrics[i].stage === stage) return this.metrics[i];
    }
    return undefined;
  }

  /** Serialize for persistence into `token_usage_json`. */
  toPersisted(): V3BudgetPersistedShape {
    return {
      physicalRequestCount: this.metrics.length,
      requests: this.metrics.map(m => ({ ...m })),
    };
  }

  /** All reserved metrics (for telemetry/UI). */
  snapshot(): ContinuationV3RequestMetric[] {
    return this.metrics.map(m => ({ ...m }));
  }
}

/**
 * Build a `beforeAdditionalHttpAttempt` hook that reserves against the budget
 * before a Provider's internal extra fetch (format fallback / retry). Throwing
 * inside aborts the extra fetch.
 */
export function createV3AdditionalAttemptGuard(
  budget: ContinuationV3RequestBudget,
  stage: V3StageName,
) {
  return (meta: { attemptKind: 'format_fallback' | 'provider_retry' }) => {
    // The hook throws if the cap is reached, which propagates out of the
    // provider call and prevents the extra fetch.
    budget.reserve({ stage, attemptKind: meta.attemptKind });
  };
}

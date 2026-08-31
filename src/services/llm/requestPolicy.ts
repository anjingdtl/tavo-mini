import type {
  LLMFailurePhase,
  LLMOutputBudgetTrace,
  LLMProviderType,
  LLMRequestMetrics,
} from './types';

export type LLMErrorCode =
  | 'cancelled'
  | 'connect_timeout'
  | 'idle_timeout'
  | 'total_timeout'
  | 'network_error'
  | 'provider_error';

/**
 * Phase 3 failure classification (doc §11):
 *   safe_retry      — retryable without risk of duplicate billing
 *   outcome_unknown — request may have executed; NEVER auto-retry silently
 *   rate_limit      — 429 / explicit rate limit; Retry-After preferred
 *   account_quota   — insufficient_quota / billing limit / balance
 *   config_error    — model missing / invalid API key / bad URL
 *   context_error   — local Ready-compile failure (LLM call count 0)
 *   content_filter  — provider content policy rejection
 *   response_invalid — provider responded, but the business contract was
 *                      invalid (JSON/schema/channel); the response is known
 *                      and must never be mislabeled outcome_unknown
 *   fatal           — anything else
 */
export type LLMFailureClass =
  | 'safe_retry'
  | 'outcome_unknown'
  | 'rate_limit'
  | 'account_quota'
  | 'config_error'
  | 'context_error'
  | 'content_filter'
  | 'response_invalid'
  | 'fatal';

export interface LLMFailureMetadata {
  failureClass: LLMFailureClass;
  failurePhase?: LLMFailurePhase;
  httpStatus?: number;
  providerCode?: string;
  retryAfterMs?: number;
  providerRequestId?: string;
  requestMayHaveExecuted: boolean;
  metrics?: LLMRequestMetrics;
  outputBudget?: LLMOutputBudgetTrace;
}

function isFailurePhase(value: unknown): value is LLMFailurePhase {
  return [
    'queue',
    'provider',
    'network',
    'http',
    'generation',
    'parse',
    'persist',
    'outcome_unknown',
  ].includes(String(value));
}

/**
 * Resolve the request-boundary phase independently from retry/billing class.
 * This is deliberately evidence based: a request that crossed `requestSentAt`
 * is never downgraded to a safe pre-send network failure.
 */
export function classifyLLMFailurePhase(params: {
  code?: string | null;
  httpStatus?: number | null;
  message?: string | null;
  failureClass?: LLMFailureClass | string | null;
  metrics?:
    | Pick<
        LLMRequestMetrics,
        | 'queuedAt'
        | 'dispatchStartedAt'
        | 'requestSentAt'
        | 'responseReceivedAt'
        | 'parseCompletedAt'
      >
    | null;
  phaseHint?: LLMFailurePhase | null;
}): LLMFailurePhase {
  if (isFailurePhase(params.phaseHint)) return params.phaseHint;

  const code = String(params.code || '').toLowerCase();
  const message = String(params.message || '').toLowerCase();
  const status = Number(params.httpStatus) || 0;
  const metrics = params.metrics;

  if (String(params.failureClass || '').toLowerCase() === 'outcome_unknown') {
    return 'outcome_unknown';
  }

  if (
    metrics?.dispatchStartedAt == null &&
    (metrics?.queuedAt != null || code === 'cancelled')
  ) {
    return 'queue';
  }

  // A non-2xx response is an observed HTTP boundary. A 200 provider-body
  // error is marked with phaseHint by formatLLMError and handled as provider.
  if (status > 0 && status !== 200) return 'http';
  if (status === 200 && code === 'provider_error') return 'provider';

  // A response was received but parsing/normalisation did not complete.
  if (
    metrics?.responseReceivedAt != null &&
    metrics.parseCompletedAt == null
  ) {
    return 'parse';
  }

  // Client watchdog expiry after dispatch is deliberately conservative. The
  // provider may have accepted the request even if no response was observed.
  if (code === 'total_timeout' || code === 'idle_timeout') {
    return 'outcome_unknown';
  }

  if (
    code === 'network_error' ||
    code === 'connect_timeout' ||
    message.includes('network') ||
    message.includes('fetch failed')
  ) {
    return metrics?.requestSentAt != null ? 'outcome_unknown' : 'network';
  }

  if (
    metrics?.dispatchStartedAt == null &&
    (metrics?.queuedAt != null || code === 'cancelled')
  ) {
    return 'queue';
  }

  return 'provider';
}

export interface LLMTimeoutPolicy {
  totalTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export const LLM_TIMEOUTS = {
  connectionMs: 20_000,
  normalMs: 60_000,
  // Pipeline stages use this only as a last-resort client watchdog. A valid
  // response that arrives earlier is always accepted as-is. Long-form cloud
  // requests can spend several minutes queued or reasoning before returning;
  // keep the cutoff just below the ten-minute provider window so a slow but
  // valid request is not converted into an outcome-unknown duplicate hazard.
  chapterDraftMs: 570_000,
  // Canon extraction sends chapter context and asks for evidence-rich JSON.
  // Cloud providers can legitimately queue this longer than an ordinary chat.
  // DeepSeek keeps an accepted request connected for up to ten minutes before
  // inference starts. Canon batches may legitimately be large (up to 80% of
  // a configured 1M context), so let the client wait just below that window.
  canonAnalysisMs: 570_000,
  // 构建场景（世界书/角色卡）在「深度」档或条目较多时输出可达 10k+ Token，
  // 云端模型长输出常见 60-120 秒延迟，沿用章节草稿的 180 秒长超时。
  constructionMs: 180_000,
} as const;

export class LLMRequestError extends Error {
  readonly code: LLMErrorCode | string;
  readonly cause?: unknown;
  readonly failureClass: LLMFailureClass;
  readonly failurePhase: LLMFailurePhase;
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly retryAfterMs?: number;
  readonly providerRequestId?: string;
  readonly requestMayHaveExecuted: boolean;
  readonly metrics?: LLMRequestMetrics;
  readonly outputBudget?: LLMOutputBudgetTrace;

  constructor(
    message: string,
    code: LLMErrorCode | string,
    cause?: unknown,
    metadata?: Partial<LLMFailureMetadata>,
  ) {
    super(message);
    this.name = 'LLMRequestError';
    this.code = code;
    this.cause = cause;
    this.failureClass = metadata?.failureClass ?? 'fatal';
    this.failurePhase =
      metadata?.failurePhase ??
      classifyLLMFailurePhase({
        code,
        failureClass: this.failureClass,
        metrics: metadata?.metrics,
      });
    this.httpStatus = metadata?.httpStatus;
    this.providerCode = metadata?.providerCode;
    this.retryAfterMs = metadata?.retryAfterMs;
    this.providerRequestId = metadata?.providerRequestId;
    this.requestMayHaveExecuted = metadata?.requestMayHaveExecuted ?? true;
    this.metrics = metadata?.metrics;
    this.outputBudget = metadata?.outputBudget;
  }
}

/**
 * Phase 3: classify an LLM failure from code/status/message (doc §11).
 * Deterministic — same input yields the same class.
 */
export function classifyLLMFailure(params: {
  code?: string | null;
  httpStatus?: number | null;
  message?: string | null;
}): LLMFailureClass {
  const status = Number(params.httpStatus) || 0;
  const code = String(params.code || '').toLowerCase();
  const message = String(params.message || '').toLowerCase();

  // Account quota / billing gates (checked before generic 4xx).
  if (
    /insufficient_quota|billing[_ ]?limit|balance[_ ]?not[_ ]?enough|credit_exhausted|quota_exceeded|insufficient.*balance|out[_ ]?of[_ ]?quota/i.test(
      `${code} ${message}`,
    )
  ) {
    return 'account_quota';
  }

  // Explicit rate limiting.
  if (
    status === 429 ||
    /rate_limit|rate limit|too_many_requests/i.test(`${code} ${message}`)
  ) {
    return 'rate_limit';
  }

  // Content policy rejections.
  if (
    /content_filter|content_policy|safety_system|policy_violation/i.test(
      `${code} ${message}`,
    )
  ) {
    return 'content_filter';
  }

  // Configuration errors: bad key / missing model / bad endpoint.
  if (
    status === 401 ||
    status === 403 ||
    (status === 404 && /model|not_found/i.test(`${code} ${message}`)) ||
    status === 400
  ) {
    return 'config_error';
  }

  // Transient server-side / gateway errors.
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return 'safe_retry';
  }

  return 'fatal';
}

/**
 * Phase 3: retry backoff schedule (doc §12): 30s → 2m → 5m, plus 10~20%
 * jitter. Deterministic for a fixed now: the jitter uses the attempt no so
 * replays stay stable.
 */
export const AUTO_RETRY_BACKOFF_MS = [30_000, 120_000, 300_000] as const;
export const MAX_AUTO_RETRY_ATTEMPTS = 3;

export function computeRetryBackoffMs(attemptNo: number): number {
  const index = Math.max(
    0,
    Math.min(attemptNo - 1, AUTO_RETRY_BACKOFF_MS.length - 1),
  );
  const base = AUTO_RETRY_BACKOFF_MS[index];
  // 10%~20% jitter derived from a stable hash of attemptNo.
  const seed = Math.floor((attemptNo * 2654435761) % 1000000);
  const jitter = 0.1 + (seed % 1000) / 10000; // 0.10 ~ 0.20
  return Math.floor(base * jitter);
}

export function shouldAutoRetryFailure(params: {
  failureClass: LLMFailureClass;
  attemptNo: number;
  now?: number;
  nextRetryAt?: number | null;
}): boolean {
  if (
    params.failureClass !== 'safe_retry' &&
    params.failureClass !== 'rate_limit'
  ) {
    return false;
  }
  if (params.attemptNo > MAX_AUTO_RETRY_ATTEMPTS) {
    return false;
  }
  if (params.nextRetryAt != null && params.now != null) {
    return params.nextRetryAt <= params.now;
  }
  return true;
}

export function resolveLLMTimeoutPolicy(
  scenario = 'chat',
  _providerType: LLMProviderType = 'openai_compatible',
): LLMTimeoutPolicy {
  if (scenario === 'connection_test') {
    return { totalTimeoutMs: LLM_TIMEOUTS.connectionMs };
  }
  if (
    scenario === 'continuation_canon_analysis' ||
    scenario === 'continuation_style_analysis'
  ) {
    return { totalTimeoutMs: LLM_TIMEOUTS.canonAnalysisMs };
  }
  // 构建场景（construction_*）输出体量大、JSON 严格，单次/分批均走 180 秒。
  if (scenario.startsWith('construction_')) {
    return { totalTimeoutMs: LLM_TIMEOUTS.constructionMs };
  }
  if (
    scenario === 'chapter_draft' ||
    scenario === 'chapter_revision' ||
    scenario === 'batch_planner' ||
    scenario === 'pipeline_brief' ||
    // Continuation planner/writer/checker prompts can carry a large frozen
    // Canon/style bundle. They need the same long-running budget as chapter
    // drafting; otherwise `continuation_writer` falls through to the 60s
    // normal timeout even when the model is still processing a valid request.
    scenario.startsWith('continuation_') ||
    scenario.startsWith('story_memory_') ||
    // User revisions are single-shot thinking-enabled novel-prose calls with
    // the same latency profile as a pipeline stage. The 60s normal timeout
    // converts a slow-but-valid revision into an outcome-unknown abort, which
    // the one-physical-request revision contract must never risk.
    scenario.startsWith('user_revision_') ||
    scenario === 'pipeline_draft' ||
    scenario === 'pipeline_qa' ||
    scenario === 'pipeline_review' ||
    scenario === 'pipeline_factcheck' ||
    scenario === 'pipeline_proof'
  ) {
    return { totalTimeoutMs: LLM_TIMEOUTS.chapterDraftMs };
  }
  return { totalTimeoutMs: LLM_TIMEOUTS.normalMs };
}

export interface LLMTimeoutController {
  signal: AbortSignal;
  metrics: LLMRequestMetrics;
  /** Exposed so timeout errors can identify the client-side cutoff clearly. */
  totalTimeoutMs?: number;
  markProgress: (kind?: 'first_token' | 'progress') => void;
  getAbortCode: () => LLMErrorCode | undefined;
  dispose: () => void;
}

export function createLLMTimeoutController(options: {
  policy: LLMTimeoutPolicy;
  taskId?: string;
  externalSignal?: AbortSignal;
  onProgress?: (metrics: LLMRequestMetrics) => void;
  timeoutCode?: 'connect_timeout' | 'total_timeout';
}): LLMTimeoutController {
  const controller = new AbortController();
  const startedAt = Date.now();
  const metrics: LLMRequestMetrics = {
    taskId: options.taskId,
    startedAt,
    lastProgressAt: startedAt,
  };
  let abortCode: LLMErrorCode | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const abort = (code: LLMErrorCode) => {
    if (abortCode) return;
    abortCode = code;
    controller.abort();
  };

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (options.policy.idleTimeoutMs) {
      idleTimer = setTimeout(
        () => abort('idle_timeout'),
        options.policy.idleTimeoutMs,
      );
    }
  };

  const markProgress = (kind: 'first_token' | 'progress' = 'progress') => {
    const now = Date.now();
    metrics.lastProgressAt = now;
    if (kind === 'first_token' && metrics.firstTokenAt === undefined) {
      metrics.firstTokenAt = now;
    }
    options.onProgress?.({ ...metrics });
    resetIdleTimer();
  };

  const onExternalAbort = () => abort('cancelled');
  if (options.externalSignal?.aborted) onExternalAbort();
  else
    options.externalSignal?.addEventListener('abort', onExternalAbort, {
      once: true,
    });

  if (options.policy.totalTimeoutMs) {
    totalTimer = setTimeout(
      () => abort(options.timeoutCode || 'total_timeout'),
      options.policy.totalTimeoutMs,
    );
  }
  resetIdleTimer();

  return {
    signal: controller.signal,
    metrics,
    totalTimeoutMs: options.policy.totalTimeoutMs,
    markProgress,
    getAbortCode: () => abortCode,
    dispose: () => {
      if (totalTimer) clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      options.externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

export function toLLMRequestError(
  error: any,
  timeoutController: LLMTimeoutController,
  fallbackMessage: string,
  context?: {
    metrics?: LLMRequestMetrics | null;
    phaseHint?: LLMFailurePhase | null;
  },
): LLMRequestError {
  if (error instanceof LLMRequestError) return error;
  const metrics = context?.metrics ?? null;
  const errorPhase = isFailurePhase(error?.failurePhase)
    ? error.failurePhase
    : undefined;
  const phaseHint = context?.phaseHint ?? errorPhase;
  const timeoutCode = timeoutController.getAbortCode();
  if (timeoutCode) {
    const messages: Record<string, string> = {
      cancelled: '已取消',
      connect_timeout: '连接测试超时，请检查手机网络、API 地址和模型服务。',
      idle_timeout: '软件阻断：本地模型长时间没有输出，已主动停止本次生成。',
      total_timeout: `软件阻断：本地等待 LLM 响应超过 ${
        timeoutController.totalTimeoutMs
          ? Math.ceil(timeoutController.totalTimeoutMs / 1000)
          : '设定'
      } 秒，已主动终止本阶段；未收到完整回复。`,
    };
    // Phase 3 classification: connect_timeout happens before the request is
    // sent (safe retry); total/idle timeout means the request MAY have
    // executed server-side (outcome_unknown — never auto-retry blindly).
    const failurePhase = classifyLLMFailurePhase({
      code: timeoutCode,
      metrics,
      phaseHint,
    });
    const mayHaveExecuted =
      failurePhase === 'outcome_unknown' || timeoutCode !== 'connect_timeout';
    return new LLMRequestError(
      messages[timeoutCode] || fallbackMessage,
      timeoutCode,
      undefined,
      {
        failureClass: mayHaveExecuted ? 'outcome_unknown' : 'safe_retry',
        failurePhase,
        requestMayHaveExecuted: mayHaveExecuted,
        metrics: metrics ?? undefined,
      },
    );
  }
  if (error?.code === 'cancelled' || error?.name === 'AbortError') {
    const failurePhase = classifyLLMFailurePhase({
      code: 'cancelled',
      metrics,
      phaseHint,
    });
    return new LLMRequestError('已取消', 'cancelled', error, {
      failureClass: 'fatal',
      failurePhase,
      requestMayHaveExecuted: false,
      metrics: metrics ?? undefined,
    });
  }
  if (error?.status || String(error?.code || '').startsWith('HTTP_')) {
    const httpStatus = Number(error?.status) || undefined;
    const metadata: Partial<LLMFailureMetadata> = {
      httpStatus,
      providerCode: String(error?.code || ''),
      retryAfterMs: Number(error?.retryAfterMs) || undefined,
      providerRequestId: error?.providerRequestId || undefined,
      // 429/5xx = provider answered → request may have executed; treat as
      // outcome_unknown only for the transport-level codes, not HTTP errors.
      requestMayHaveExecuted: true,
      failureClass: classifyLLMFailure({
        code: error?.code,
        httpStatus,
        message: error?.message,
      }),
      failurePhase: classifyLLMFailurePhase({
        code: error?.code,
        httpStatus,
        message: error?.message,
        metrics,
        phaseHint,
      }),
      metrics: metrics ?? undefined,
    };
    return new LLMRequestError(
      error.message || fallbackMessage,
      'provider_error',
      error,
      metadata,
    );
  }
  if (
    error instanceof TypeError ||
    String(error?.message || '')
      .toLowerCase()
      .includes('network')
  ) {
    const failurePhase =
      metrics == null
        ? 'outcome_unknown'
        : classifyLLMFailurePhase({
            code: 'network_error',
            message: error?.message,
            metrics,
            phaseHint,
          });
    const mayHaveExecuted = failurePhase === 'outcome_unknown';
    return new LLMRequestError(
      error?.message || '网络请求失败，请检查网络连接。',
      'network_error',
      error,
      {
        // A network failure is retry-safe only when the request boundary
        // proves that no HTTP request was sent.
        failureClass: mayHaveExecuted ? 'outcome_unknown' : 'safe_retry',
        failurePhase,
        requestMayHaveExecuted: mayHaveExecuted,
        metrics: metrics ?? undefined,
      },
    );
  }
  if (
    metrics?.responseReceivedAt != null &&
    metrics.parseCompletedAt == null
  ) {
    return new LLMRequestError(
      error?.message || fallbackMessage,
      'provider_error',
      error,
      {
        failureClass: 'response_invalid',
        failurePhase: 'parse',
        requestMayHaveExecuted: true,
        metrics,
      },
    );
  }
  const failurePhase = classifyLLMFailurePhase({
    code: error?.code,
    message: error?.message,
    metrics,
    phaseHint,
  });
  return new LLMRequestError(
    error?.message || fallbackMessage,
    'provider_error',
    error,
    {
      failureClass: 'fatal',
      failurePhase,
      requestMayHaveExecuted: true,
      metrics: metrics ?? undefined,
    },
  );
}

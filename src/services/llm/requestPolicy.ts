import type { LLMProviderType, LLMRequestMetrics } from './types';

export type LLMErrorCode =
  | 'cancelled'
  | 'connect_timeout'
  | 'idle_timeout'
  | 'total_timeout'
  | 'network_error'
  | 'provider_error';

export interface LLMTimeoutPolicy {
  totalTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export const LLM_TIMEOUTS = {
  connectionMs: 20_000,
  normalMs: 60_000,
  chapterDraftMs: 180_000,
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

  constructor(message: string, code: LLMErrorCode | string, cause?: unknown) {
    super(message);
    this.name = 'LLMRequestError';
    this.code = code;
    this.cause = cause;
  }
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
    scenario.startsWith('story_memory_') ||
    scenario === 'pipeline_draft' ||
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
): LLMRequestError {
  const timeoutCode = timeoutController.getAbortCode();
  if (timeoutCode) {
    const messages: Record<string, string> = {
      cancelled: '已取消',
      connect_timeout: '连接测试超时，请检查手机网络、API 地址和模型服务。',
      idle_timeout: '本地模型长时间没有输出，已停止本次生成。',
      total_timeout: '请求超时，请检查网络或模型服务。',
    };
    return new LLMRequestError(
      messages[timeoutCode] || fallbackMessage,
      timeoutCode,
    );
  }
  if (error?.code === 'cancelled' || error?.name === 'AbortError') {
    return new LLMRequestError('已取消', 'cancelled', error);
  }
  if (error?.code === 'provider_error') return error;
  if (error?.status || String(error?.code || '').startsWith('HTTP_')) {
    return new LLMRequestError(
      error.message || fallbackMessage,
      'provider_error',
      error,
    );
  }
  if (
    error instanceof TypeError ||
    String(error?.message || '')
      .toLowerCase()
      .includes('network')
  ) {
    return new LLMRequestError(
      error?.message || '网络请求失败，请检查网络连接。',
      'network_error',
      error,
    );
  }
  return new LLMRequestError(
    error?.message || fallbackMessage,
    'provider_error',
    error,
  );
}

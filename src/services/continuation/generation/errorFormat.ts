/**
 * react-native-sqlite-storage and some native bridges reject with plain
 * objects `{ message, code }` rather than Error. String(err) becomes
 * "[object Object]" and hides the real failure.
 */
export function formatUnknownError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || 'Unknown Error';
  }
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const o = err as {
      message?: unknown;
      code?: unknown;
      sqlMessage?: unknown;
      error?: unknown;
    };
    const nested =
      o.error && typeof o.error === 'object'
        ? (o.error as { message?: unknown }).message
        : null;
    const msg =
      (typeof o.message === 'string' && o.message) ||
      (typeof o.sqlMessage === 'string' && o.sqlMessage) ||
      (typeof nested === 'string' && nested) ||
      null;
    if (msg) {
      return o.code != null && o.code !== '' && o.code !== 0
        ? `${msg} (code=${String(o.code)})`
        : msg;
    }
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}' && json !== 'null') return json;
    } catch {
      // fall through
    }
    return Object.prototype.toString.call(err);
  }
  if (err == null) return 'unknown';
  return String(err);
}

export function formatUnknownErrorCode(
  err: unknown,
  fallback = 'stage_failed',
): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (code != null && code !== '' && code !== 0) {
      return String(code);
    }
  }
  if (err instanceof Error && (err as any).code) {
    return String((err as any).code);
  }
  return fallback;
}

/** V5 Draft Writer parse-failure telemetry input (no sensitive fields). */
export interface V5DraftWriterDiagnosticsInput {
  rawText: string;
  result: {
    finishReason?: string | null;
    emptyReason?: string | null;
    completionTokens?: number | null;
  };
  /** Whether the LLM request asked for response_format: json_object. */
  jsonOutputRequested: boolean;
  /** Truncate stored field names so a runaway object never floods the row. */
  maxTopLevelKeys?: number;
}

/**
 * Collects ONLY non-sensitive diagnostics for a V5 Draft Writer parse failure.
 * Never stores the novel body, API key, request headers, or model secrets —
 * only opaque categorical fields, token counts, and the *names* of the
 * top-level JSON keys the model returned (values are dropped).
 */
export function buildV5DraftWriterDiagnostics(
  input: V5DraftWriterDiagnosticsInput,
): Record<string, unknown> {
  const maxKeys = Math.max(0, input.maxTopLevelKeys ?? 32);
  let topLevelKeys: string[] | null = null;
  let parseError: string | null = null;
  if (input.rawText.trim()) {
    try {
      const candidate = extractJsonObject(input.rawText);
      const parsed = candidate ? JSON.parse(candidate) : JSON.parse(input.rawText.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        topLevelKeys = Object.keys(parsed as Record<string, unknown>).slice(
          0,
          maxKeys,
        );
      }
    } catch (error) {
      parseError =
        error instanceof Error ? error.message : String(error);
    }
  }
  const diag: Record<string, unknown> = {
    schemaVersion: 1,
    emptyReason: input.result.emptyReason ?? null,
    finishReason: input.result.finishReason ?? null,
    completionTokens: input.result.completionTokens ?? null,
    jsonOutputRequested: Boolean(input.jsonOutputRequested),
    responseLength: input.rawText.length,
  };
  if (topLevelKeys != null) {
    diag.topLevelJsonKeys = topLevelKeys;
  }
  if (parseError != null) {
    diag.jsonParseError = parseError.slice(0, 200);
  }
  return diag;
}

/**
 * Extracts the first JSON object substring from a raw model response, mirroring
 * the stripModelJson tolerance for prose-wrapped JSON. Returns '' when nothing
 * parseable is found (caller then treats the whole text as non-JSON).
 */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return '';
  return text.slice(start, end + 1);
}

/** Empty-content error substring produced by sanitizeChapterContent(). */
const V5_EMPTY_CONTENT_FRAGMENT = 'content 不能为空';

/**
 * Translates an internal V5 Draft Writer empty-content error into a
 * user-actionable Chinese message. More specific upstream reasons (truncation,
 * content filter, reasoning-only, no choices, network/API failure) must be
 * surfaced unchanged by the caller before reaching this fallback.
 */
export function mapV5DraftWriterEmptyContentError(message: string): string {
  if (!message.includes(V5_EMPTY_CONTENT_FRAGMENT)) return message;
  return '模型返回了空正文。请重试；若反复出现，请检查模型是否支持 JSON 输出、提高输出 token，或更换模型。';
}

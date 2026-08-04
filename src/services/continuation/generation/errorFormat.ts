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

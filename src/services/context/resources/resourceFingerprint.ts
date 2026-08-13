import { sha256Hex } from '../../continuation/hashUtils';

/** Stable source fingerprint for freeze / cache invalidation / Preview. */
export function computeResourceSourceFingerprint(parts: {
  kind: string;
  id: number | string | null;
  semanticContent: string;
  compilerVersion: string;
}): string {
  const payload = [
    String(parts.kind || ''),
    String(parts.id ?? ''),
    parts.semanticContent,
    parts.compilerVersion,
  ].join('\u001f');
  return sha256Hex(payload);
}

export function stableJson(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return String(value);
}

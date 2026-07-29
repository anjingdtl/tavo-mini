import { sha256Hex } from '../hashUtils';

/**
 * JSON canonicalization used by both persistence and injection validation.
 * Object keys are sorted recursively; arrays retain order because most profile
 * arrays are ordered instructions. Sample references are normalized by the
 * caller because their order is set-like.
 */
export function stableJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(Object.is(value, -0) ? 0 : value) : 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function sortSampleRefs(sampleRefs: unknown[]): unknown[] {
  return sampleRefs
    .map((sample, index) => ({ sample, index }))
    .sort((a, b) => {
      const left = (a.sample || {}) as Record<string, unknown>;
      const right = (b.sample || {}) as Record<string, unknown>;
      const leftKey = [
        left.sampleKind ?? left.kind ?? '',
        left.sourceChapterId ?? left.chapterId ?? '',
        left.sourcePosition ?? left.position ?? '',
        left.charStart ?? left.start ?? '',
        left.charEnd ?? left.end ?? '',
        left.contentHash ?? left.hash ?? '',
      ].join('|');
      const rightKey = [
        right.sampleKind ?? right.kind ?? '',
        right.sourceChapterId ?? right.chapterId ?? '',
        right.sourcePosition ?? right.position ?? '',
        right.charStart ?? right.start ?? '',
        right.charEnd ?? right.end ?? '',
        right.contentHash ?? right.hash ?? '',
      ].join('|');
      return leftKey.localeCompare(rightKey) || a.index - b.index;
    })
    .map(item => item.sample);
}

export interface StyleProfileHashInput {
  profile: unknown;
  metrics: unknown;
  sampleRefs: unknown[];
  profileSchemaVersion: number;
  analyzerVersion: string;
  userOverrides?: unknown;
}

/** Hash every persisted profile component, including nested content. */
export function computeStyleProfileHash(input: StyleProfileHashInput): string {
  return sha256Hex(
    stableJson({
      analyzerVersion: input.analyzerVersion,
      metrics: input.metrics,
      profile: input.profile,
      profileSchemaVersion: input.profileSchemaVersion,
      sampleRefs: sortSampleRefs(input.sampleRefs),
      userOverrides: input.userOverrides ?? {},
    }),
  );
}

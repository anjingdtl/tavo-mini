import { sha256Hex } from '../../continuation/hashUtils';
import type { WritingSource, WritingSourceBundle } from './writingSource';

function canonicalize(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    if (input[key] !== undefined) output[key] = canonicalize(input[key]);
  }
  return output;
}

export function stableWritingJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function writingSourceContentHash(content: string): string {
  return sha256Hex(String(content ?? ''));
}

export interface WritingSourceFingerprint {
  candidateId: string;
  kind: WritingSource['kind'];
  sourceId: string | number | null;
  revision: string | null;
  contentHash: string;
  requirement: WritingSource['requirement'];
  activation: WritingSource['activation'];
}

export function fingerprintWritingSource(
  source: WritingSource,
): string {
  return sha256Hex(
    stableWritingJson({
      candidateId: source.candidateId,
      kind: source.kind,
      sourceId: source.sourceId,
      revision: source.revision,
      contentHash: source.contentHash,
      requirement: source.requirement,
      activation: source.activation,
    }),
  );
}

function flattenedFingerprintSources(
  bundle: WritingSourceBundle,
): WritingSourceFingerprint[] {
  return [...bundle.mandatory, ...bundle.preferred, ...bundle.optional]
    .map(source => ({
      candidateId: source.candidateId,
      kind: source.kind,
      sourceId: source.sourceId,
      revision: source.revision,
      contentHash: source.contentHash,
      requirement: source.requirement,
      activation: source.activation,
    }))
    .sort((a, b) =>
      `${a.candidateId}|${a.kind}`.localeCompare(`${b.candidateId}|${b.kind}`),
    );
}

export function fingerprintWritingSourceBundle(
  bundle: WritingSourceBundle,
): string {
  return sha256Hex(stableWritingJson(flattenedFingerprintSources(bundle)));
}

export function fingerprintWritingSourceBundleShape(
  bundle: WritingSourceBundle,
): WritingSourceFingerprint[] {
  return flattenedFingerprintSources(bundle);
}

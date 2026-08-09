import type {
  FinalWritingBriefV1,
  FinalWritingBriefV31,
  FinalWritingBriefV32,
} from './briefCompilerTypes';

/**
 * A V3 Proof failure that must remain visible to the user. The reconciler
 * persists this code on the Proof checkpoint so the pure state machine can
 * distinguish "retry Proof" from legacy degraded-finalization paths.
 */
export const FINAL_PROOF_RETRY_REQUIRED_ERROR_CODE =
  'FINAL_PROOF_RETRY_REQUIRED';

/**
 * Final V3's technical artifact validator intentionally does not judge prose
 * quality. This companion gate only checks the deterministic hard boundary
 * carried by Brief: content explicitly marked as not-yet-advancable must not
 * survive into the final body.
 */
export type FinalBriefComplianceCode = 'ok' | 'must_not_advance_detected';

export interface FinalBriefComplianceResult {
  valid: boolean;
  code: FinalBriefComplianceCode;
  matchedMarkers?: string[];
  details?: string;
}

function normalizeForMatch(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[\s\u3000\p{P}\p{S}]+/gu, '');
}

function addMarker(markers: Set<string>, value: string): void {
  const normalized = normalizeForMatch(value);
  if (normalized.length >= 2) markers.add(normalized);
}

function addQuotedMarkers(markers: Set<string>, text: string): void {
  const quotePattern = /[“「『"']([^”」』"']{2,})[”」』"']/g;
  for (const match of text.matchAll(quotePattern)) {
    const value = match[1].trim();
    addMarker(markers, value);
    const normalized = normalizeForMatch(value);
    // A quoted future-action phrase often has a more stable verb/object tail
    // than its surrounding prose (e.g. “将齿轮放回原处”). Keep that tail as
    // a local guard without treating every individual word as forbidden.
    if (normalized.length >= 4) {
      markers.add(normalized.slice(-4));
    }
  }
}

function addStructuredMarkers(markers: Set<string>, text: string): void {
  // Common outline nouns are the useful stable part of a natural-language
  // mustNotAdvance sentence. Keep the extraction deliberately narrow so a
  // normal word such as “章节” cannot turn into a false hard failure.
  for (const match of text.matchAll(/[A-Za-z0-9]+开头/g)) {
    addMarker(markers, match[0]);
  }
  for (const match of text.matchAll(/[\u4e00-\u9fff]{2,8}(?:档案|符号|空间|终点)/g)) {
    addMarker(markers, match[0]);
  }
}

function collectForbiddenMarkers(
  brief: FinalWritingBriefV1 | FinalWritingBriefV31 | FinalWritingBriefV32,
): Set<string> {
  const markers = new Set<string>();
  for (const item of brief.mustNotAdvance) {
    addQuotedMarkers(markers, item);
    addStructuredMarkers(markers, item);
  }
  return markers;
}

export function validateFinalBriefCompliance(params: {
  text: string;
  brief: FinalWritingBriefV1 | FinalWritingBriefV31 | FinalWritingBriefV32;
}): FinalBriefComplianceResult {
  const normalizedText = normalizeForMatch(params.text);
  const matchedMarkers = [...collectForbiddenMarkers(params.brief)].filter(
    marker => normalizedText.includes(marker),
  );
  if (matchedMarkers.length > 0) {
    return {
      valid: false,
      code: 'must_not_advance_detected',
      matchedMarkers: matchedMarkers.slice(0, 8),
      details: `正文仍包含 Brief 禁止提前推进的内容标记：${matchedMarkers
        .slice(0, 8)
        .join('、')}`,
    };
  }
  return { valid: true, code: 'ok' };
}

import type { LLMResult } from '../llm/types';
import { extractAuditJsonPayload } from '../pipelineAuditValidator';
import { sha256Hex } from '../continuation/hashUtils';

export type StructuredCandidateChannel =
  | 'content'
  | 'reasoning'
  | 'both_content_preferred'
  | 'both_reasoning_preferred';

export interface StructuredCandidate {
  channel: 'content' | 'reasoning';
  responseChannel: StructuredCandidateChannel;
  text: string;
  parsed: Record<string, unknown>;
  score: number;
  extracted: boolean;
  candidateChars: number;
  candidateHash: string;
  rootKeys: string[];
  truncatedLikely: boolean;
}

export interface StructuredCandidateSelection {
  candidate: StructuredCandidate | null;
  responseChannel: StructuredCandidateChannel | 'empty';
  rejected: Array<{ channel: 'content' | 'reasoning'; reason: string }>;
}

function nonEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseOne(
  channel: 'content' | 'reasoning',
  raw: string,
  expectedRootKeys: readonly string[],
  coverageKeys: readonly string[],
  findingKeys: readonly string[],
  allowSingleItemArray: boolean,
): { candidate: StructuredCandidate | null; rejection?: string } {
  const source = raw.trim();
  if (!source) return { candidate: null, rejection: 'empty_channel' };
  let extractionSource = source;
  // Some gateways serialize the complete message.content as a JSON string
  // (including escaped braces), so the generic balanced extractor quite
  // correctly sees no outer object. Decode that transport wrapper once.
  try {
    const decoded = JSON.parse(source);
    if (typeof decoded === 'string' && decoded.trim()) {
      extractionSource = decoded.trim();
    }
  } catch {
    // Continue with the original channel text.
  }
  const extracted = extractAuditJsonPayload(extractionSource);
  if (!extracted.jsonText) {
    return {
      candidate: null,
      rejection: extracted.truncatedLikely ? 'truncated_json' : 'invalid_json',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.jsonText);
    // A few compatible gateways double-encode json_object content. Unwrap
    // only a bounded JSON string, never arbitrary prose.
    for (let depth = 0; depth < 2 && typeof parsed === 'string'; depth += 1) {
      const nested = parsed.trim();
      if (!nested) break;
      parsed = JSON.parse(nested);
    }
  } catch {
    return { candidate: null, rejection: 'json_parse_failed' };
  }
  if (
    allowSingleItemArray &&
    Array.isArray(parsed) &&
    parsed.length === 1 &&
    parsed[0] &&
    typeof parsed[0] === 'object' &&
    !Array.isArray(parsed[0])
  ) {
    parsed = parsed[0];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { candidate: null, rejection: 'root_not_object' };
  }
  const value = parsed as Record<string, unknown>;
  const rootKeys = Object.keys(value).sort();
  const presentRootKeys = expectedRootKeys.filter(key =>
    Object.prototype.hasOwnProperty.call(value, key),
  ).length;
  const presentCoverageKeys = coverageKeys.filter(key => {
    const coverage = value.coverage;
    return (
      coverage &&
      typeof coverage === 'object' &&
      Array.isArray((coverage as Record<string, unknown>).checkedDimensions) &&
      ((coverage as Record<string, unknown>).checkedDimensions as unknown[]).some(
        item => String(item) === key,
      )
    );
  }).length;
  const findingCount = findingKeys.reduce((count, key) => {
    const items = value[key];
    return count + (Array.isArray(items) ? items.length : items ? 1 : 0);
  }, 0);
  const coverageCount = Array.isArray(value.coverage)
    ? value.coverage.length
    : presentCoverageKeys;
  const score =
    presentRootKeys * 10 +
    presentCoverageKeys * 8 +
    Math.min(findingCount, 30) * 2 +
    (typeof value.verdict === 'string' ? 6 : 0) +
    (typeof value.outlineAssessment === 'object' ? 4 : 0) +
    (coverageCount > 0 ? 2 : 0);
  return {
    candidate: {
      channel,
      responseChannel: channel,
      text: extracted.jsonText,
      parsed: value,
      score,
      extracted: extracted.jsonText !== source,
      candidateChars: extracted.jsonText.length,
      candidateHash: sha256Hex(extracted.jsonText).slice(0, 32),
      rootKeys,
      truncatedLikely: extracted.truncatedLikely,
    },
  };
}

/**
 * Select the most complete structured candidate from content/reasoning.
 *
 * Parsing is deliberately channel-neutral.  Business validators decide
 * whether the selected object is semantically legal; this helper only chooses
 * the best available JSON and records safe rejection metadata.
 */
export function selectStructuredCandidate(params: {
  result?: Pick<LLMResult, 'text' | 'reasoningText'>;
  content?: string | null;
  reasoning?: string | null;
  expectedRootKeys?: readonly string[];
  coverageKeys?: readonly string[];
  findingKeys?: readonly string[];
  /** Revision-only compatibility for a single object wrapped in an array. */
  allowSingleItemArray?: boolean;
}): StructuredCandidateSelection {
  const content = nonEmpty(params.content ?? params.result?.text);
  const reasoning = nonEmpty(params.reasoning ?? params.result?.reasoningText);
  const expectedRootKeys = params.expectedRootKeys || [];
  const coverageKeys = params.coverageKeys || [];
  const findingKeys = params.findingKeys || ['findings', 'corrections', 'instructions'];
  const candidates: StructuredCandidate[] = [];
  const rejected: Array<{
    channel: 'content' | 'reasoning';
    reason: string;
  }> = [];
  for (const [channel, raw] of [
    ['content', content],
    ['reasoning', reasoning],
  ] as const) {
    const parsed = parseOne(
      channel,
      raw,
      expectedRootKeys,
      coverageKeys,
      findingKeys,
      params.allowSingleItemArray === true,
    );
    if (parsed.candidate) candidates.push(parsed.candidate);
    else if (parsed.rejection) rejected.push({ channel, reason: parsed.rejection });
  }
  if (!candidates.length) {
    return { candidate: null, responseChannel: 'empty', rejected };
  }
  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.channel !== right.channel) {
      return left.channel === 'content' ? -1 : 1;
    }
    return right.candidateChars - left.candidateChars;
  });
  const selected = candidates[0];
  const both = candidates.length > 1;
  const responseChannel: StructuredCandidateChannel = both
    ? selected.channel === 'content'
      ? 'both_content_preferred'
      : 'both_reasoning_preferred'
    : selected.channel;
  selected.responseChannel = responseChannel;
  return { candidate: selected, responseChannel, rejected };
}

export function candidateResultFromSelection(
  result: LLMResult,
  selection: StructuredCandidateSelection,
): LLMResult {
  if (!selection.candidate) return result;
  return {
    ...result,
    text: selection.candidate.text,
    reasoningText: null,
  };
}

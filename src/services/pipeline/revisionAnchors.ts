/**
 * Outline pipeline V5-Lite — canonical draft + stable revision anchors.
 *
 * Pure, deterministic, 0 LLM. The same canonical draft always produces the
 * same hash, anchors, offsets and tagged rendering — required for resume
 * reconstruction (§5, §14.2) and fingerprint stability.
 */
import { sha256Hex } from '../continuation/hashUtils';
import type { PipelineRevisionAnchor } from '../../types/pipelineRevision';

/**
 * Over-length paragraph split ceiling (UTF-16 code units). First-version
 * heuristic inside the plan's 1200–1800 band; never depends on an LLM
 * tokenizer. Deterministic split points only.
 */
export const MAX_ANCHOR_TEXT_LENGTH = 1500;

/** Sentence-boundary code points where an over-length paragraph may split. */
const SENTENCE_ENDERS = new Set([
  '。',
  '！',
  '？',
  '…',
  '.',
  '!',
  '?',
  '；',
  ';',
]);

/**
 * Normalize a draft to its canonical form:
 *   CRLF → LF, lone CR → LF.
 * No Unicode normalization; body characters, punctuation and paragraph
 * content are never modified.
 */
export function canonicalizeDraft(draftText: string): string {
  return String(draftText ?? '').replace(/\r\n?/g, '\n');
}

/** sha256Hex(canonicalDraft) — the single draft identity for V2. */
export function computeDraftHash(canonicalDraft: string): string {
  return sha256Hex(canonicalDraft);
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

/**
 * Deterministically split one over-length paragraph into segments.
 * Prefers the LAST sentence boundary inside the window when it covers more
 * than half the window; otherwise hard-cuts at the window end. Both paths
 * are deterministic and never depend on tokenizers.
 */
function splitParagraphSegments(
  text: string,
  maxLength: number,
): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const windowEnd = Math.min(text.length, cursor + maxLength);
    if (windowEnd - cursor < maxLength) {
      segments.push({ start: cursor, end: windowEnd });
      break;
    }
    // Prefer the last sentence boundary strictly inside the window.
    let splitAt = -1;
    const minUseful = cursor + Math.floor(maxLength / 2);
    for (let i = windowEnd - 1; i > minUseful; i -= 1) {
      if (SENTENCE_ENDERS.has(text[i])) {
        splitAt = i + 1;
        break;
      }
    }
    if (splitAt < 0) {
      splitAt = windowEnd;
    }
    segments.push({ start: cursor, end: splitAt });
    cursor = splitAt;
  }
  return segments;
}

/**
 * Build stable anchors over the canonical draft.
 *
 * Rules (§5.4):
 *   1. natural paragraphs split by one or more blank lines;
 *   2. pure-whitespace paragraphs are skipped but their real offsets are
 *      preserved for later paragraphs;
 *   3. ordinary paragraphs get `draft-p-001`, `draft-p-002`, …;
 *   4. over-length paragraphs are deterministically split into
 *      `draft-p-001-s-001` segments;
 *   5. fully duplicated paragraphs still receive distinct ids;
 *   6. identical canonical drafts produce identical anchors/offsets/order.
 */
export function buildRevisionAnchors(
  canonicalDraft: string,
  maxAnchorLength: number = MAX_ANCHOR_TEXT_LENGTH,
): PipelineRevisionAnchor[] {
  const text = String(canonicalDraft ?? '');
  const anchors: PipelineRevisionAnchor[] = [];

  const blocks = text.split('\n');
  let paragraphIndex = 0;
  let cursor = 0;
  // Track how many non-empty paragraphs got an id so far.
  let paragraphCount = 0;

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const isBlank = block.trim().length === 0;
    // Blank block: consume its own length plus a following newline separator.
    if (isBlank) {
      cursor += block.length;
      if (i < blocks.length - 1) {
        cursor += 1;
      }
      continue;
    }
    const paraStart = cursor;
    const paraEnd = cursor + block.length;
    const para = text.substring(paraStart, paraEnd);
    paragraphCount += 1;

    if (para.length <= maxAnchorLength) {
      anchors.push({
        id: `draft-p-${pad3(paragraphCount)}`,
        start: paraStart,
        end: paraEnd,
        text: para,
        paragraphIndex,
        segmentIndex: 0,
      });
    } else {
      const segments = splitParagraphSegments(para, maxAnchorLength);
      segments.forEach((seg, segIndex) => {
        anchors.push({
          id: `draft-p-${pad3(paragraphCount)}-s-${pad3(segIndex + 1)}`,
          start: paraStart + seg.start,
          end: paraStart + seg.end,
          text: text.substring(paraStart + seg.start, paraStart + seg.end),
          paragraphIndex,
          segmentIndex: segIndex,
        });
      });
    }

    // Consume the paragraph plus its separator newline (if not last block).
    cursor = paraEnd;
    if (i < blocks.length - 1) {
      cursor += 1;
    }
    paragraphIndex += 1;
  }
  return anchors;
}

export interface TaggedDraft {
  /** Every non-blank paragraph rendered exactly once with its anchor id. */
  taggedText: string;
  anchors: PipelineRevisionAnchor[];
}

/**
 * Render the single-injection tagged draft for Review V2 / FactCheck V2
 * (§5.5): each non-blank paragraph appears EXACTLY once under its anchor
 * marker. Blank paragraphs are skipped but anchors keep real offsets.
 */
export function buildTaggedDraft(
  canonicalDraft: string,
  maxAnchorLength: number = MAX_ANCHOR_TEXT_LENGTH,
): TaggedDraft {
  const anchors = buildRevisionAnchors(canonicalDraft, maxAnchorLength);
  const lines: string[] = [];
  for (const anchor of anchors) {
    lines.push(`[${anchor.id}]`);
    lines.push(anchor.text);
    lines.push('');
  }
  return { taggedText: lines.join('\n').trimEnd(), anchors };
}

/**
 * Look up an anchor by id. Returns undefined when unknown (used by the
 * validator and the contract compiler to fail closed on invalid locations).
 */
export function findAnchorById(
  anchors: PipelineRevisionAnchor[],
  id: string | undefined | null,
): PipelineRevisionAnchor | undefined {
  if (!id) return undefined;
  return anchors.find(a => a.id === id);
}

/** Stable normalized JSON of the anchor list (resume fingerprint). */
export function serializeAnchors(anchors: PipelineRevisionAnchor[]): string {
  return JSON.stringify(
    anchors.map(a => ({
      id: a.id,
      start: a.start,
      end: a.end,
      paragraphIndex: a.paragraphIndex,
      segmentIndex: a.segmentIndex,
    })),
  );
}

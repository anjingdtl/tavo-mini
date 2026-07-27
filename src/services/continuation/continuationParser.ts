/**
 * Continuation chapter parser (Spec §11).
 *
 * Pure function: takes the normalized source text and returns chapter metadata
 * with UTF-16 offsets into that text. Heading detection is line-oriented and
 * versioned via {@link PARSER_VERSION}; bump the version whenever the rules
 * change (Spec §11.1).
 *
 * Heading patterns (Spec §11.1):
 *   - 第N章/节/回 where N is a CJK numeral or arabic (with optional zero pad)
 *   - 第N卷 / 卷N / 第N部 (volume markers — attached as volume_title, not
 *     emitted as bodyless phantom chapters)
 *   - Chapter N / CHAPTER N (English)
 *   - optional "正文 " prefix before a chapter marker is tolerated
 *
 * A marker only counts as a heading when it begins a line; mid-line mentions
 * like "第一章内容如下" in body text are rejected (Spec §11.1).
 */
import type {
  SourceChapterPosition,
  Utf16Offset,
} from '../../types/novel';
import { sha256Hex } from './hashUtils';

/** Bumped when detection rules change (Spec §11.1). */
export const PARSER_VERSION = 'v1';

export interface ParsedChapter {
  position: SourceChapterPosition;
  volumeTitle: string | null;
  detectedTitle: string;
  title: string;
  /** UTF-16 offset where the chapter line begins (title included). */
  sourceStartOffset: Utf16Offset;
  /** UTF-16 offset of the chapter body (after the title line). */
  contentStartOffset: Utf16Offset;
  /** UTF-16 exclusive offset where the chapter ends. */
  sourceEndOffset: Utf16Offset;
  charCount: number;
  paragraphCount: number;
  contentSha256: string;
  /** Set by preview edits (Spec §11.2); false on fresh parse. */
  isExcluded?: boolean;
  exclusionReason?: string | null;
}

export interface ParsedSource {
  chapters: ParsedChapter[];
  parserVersion: string;
  /** True when no headings were found and the whole text became one chapter. */
  fallbackUsed: boolean;
  warnings: string[];
}

// CJK numeral → int map for the leading run of a 第... marker.
const CJK_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** Parse a run of CJK numerals (一..九十九...) into an int. Returns NaN if invalid. */
function parseCjkNumber(s: string): number {
  if (s.length === 0) return NaN;
  if (s === '十') return 10;
  // Pattern like 十X, X十, X十Y, or pure-digit.
  const shiIndex = s.indexOf('十');
  if (shiIndex >= 0) {
    const tensPart = s.slice(0, shiIndex);
    const onesPart = s.slice(shiIndex + 1);
    const tens = tensPart.length === 0 ? 1 : CJK_DIGITS[tensPart];
    const ones = onesPart.length === 0 ? 0 : CJK_DIGITS[onesPart];
    if (
      (tensPart.length > 0 && tens === undefined) ||
      (onesPart.length > 0 && ones === undefined)
    ) {
      return NaN;
    }
    return tens * 10 + ones;
  }
  // Pure digit run (single char only supported here; multi-char CJK hundreds
  // are rare in novel titles).
  if (s.length === 1 && CJK_DIGITS[s] !== undefined) return CJK_DIGITS[s];
  return NaN;
}

/**
 * Heading matchers. Each returns the trailing title-suffix offset if the line
 * is a heading, or null otherwise. The line is matched with its leading
 * whitespace already stripped.
 */
type HeadingKind = 'chapter' | 'volume';

interface HeadingMatch {
  kind: HeadingKind;
  /** Numeric value parsed from the marker (for sanity), or NaN if unparsed. */
  number: number;
}

// 第N章/节/回 — N is CJK or arabic. Optional "正文 " prefix.
const CHAPTER_RE = /^(?:正文\s*)?第([0-9一二三四五六七八九十百千两零〇]+)[章节回](.*)$/;
// Chapter N / CHAPTER N (English).
const ENGLISH_CHAPTER_RE = /^Chapter\s+(\d+)\b(.*)$/i;
// Volume markers: 第N卷 / 卷N / 第N部.
const VOLUME_RE = /^(?:第([0-9一二三四五六七八九十百千两零〇]+)卷|卷([0-9一二三四五六七八九十百千两零〇]+))(?:.*)$/;

function matchHeading(line: string): HeadingMatch | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const cm = trimmed.match(CHAPTER_RE);
  if (cm) {
    const numStr = cm[1];
    const num = /^\d+$/.test(numStr)
      ? parseInt(numStr, 10)
      : parseCjkNumber(numStr);
    return { kind: 'chapter', number: num };
  }
  const em = trimmed.match(ENGLISH_CHAPTER_RE);
  if (em) {
    return { kind: 'chapter', number: parseInt(em[1], 10) };
  }
  const vm = trimmed.match(VOLUME_RE);
  if (vm) {
    const numStr = vm[1] ?? vm[2] ?? '';
    const num = /^\d+$/.test(numStr)
      ? parseInt(numStr, 10)
      : parseCjkNumber(numStr);
    return { kind: 'volume', number: num };
  }
  return null;
}

/** Count non-empty paragraphs in a body string. */
function countParagraphs(body: string): number {
  return body
    .split(/\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0).length;
}

/** Build a single whole-text fallback chapter (Spec §11.3). */
function buildFallback(text: string): ParsedSource {
  const title = '整篇（无标题）';
  const chapter: ParsedChapter = {
    position: 0 as SourceChapterPosition,
    volumeTitle: null,
    detectedTitle: title,
    title,
    sourceStartOffset: 0 as Utf16Offset,
    contentStartOffset: 0 as Utf16Offset,
    sourceEndOffset: text.length as Utf16Offset,
    charCount: text.length,
    paragraphCount: countParagraphs(text),
    contentSha256: sha256Hex(text),
  };
  return {
    chapters: [chapter],
    parserVersion: PARSER_VERSION,
    fallbackUsed: true,
    warnings: ['未检测到章节标题，整篇作为单一章节。可手动拆分或选择按字数切分。'],
  };
}

/**
 * Parse normalized source text into chapter metadata (Spec §11.1).
 *
 * Implementation: scan line-by-line, recording the UTF-16 offset where each
 * line starts. When a chapter heading is found, close the previous chapter at
 * the heading's start offset and open a new one. Volume headings update the
 * "current volume" context without producing a chapter.
 */
export function parseSourceChapters(text: string): ParsedSource {
  if (text.length === 0) {
    return {
      chapters: [],
      parserVersion: PARSER_VERSION,
      fallbackUsed: false,
      warnings: ['原文为空。'],
    };
  }

  // Pre-compute each line's start offset for O(n) scanning.
  const lines: { text: string; startOffset: number }[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    lines.push({ text: line, startOffset: offset });
    offset += line.length + 1; // +1 for the '\n'
  }

  const chapters: ParsedChapter[] = [];
  let currentVolume: string | null = null;
  let openStart: { lineIdx: number; headingLine: string } | null = null;
  const warnings: string[] = [];

  const closeChapter = (endLineIdxExclusive: number) => {
    if (!openStart) return;
    const startLine = lines[openStart.lineIdx];
    const headingText = openStart.headingLine;
    // content_start_offset = start of the line AFTER the heading line.
    const contentStartLineIdx = openStart.lineIdx + 1;
    const contentStartOffset =
      contentStartLineIdx < lines.length
        ? lines[contentStartLineIdx].startOffset
        : (startLine.startOffset + headingText.length + 1);
    // source_end_offset = start offset of endLineIdxExclusive (i.e. the next
    // heading), or text.length for the final chapter.
    const sourceEndOffset =
      endLineIdxExclusive < lines.length
        ? lines[endLineIdxExclusive].startOffset
        : text.length;
    const body = text.slice(contentStartOffset, sourceEndOffset);
    chapters.push({
      position: chapters.length as SourceChapterPosition,
      volumeTitle: currentVolume,
      detectedTitle: headingText.trim(),
      title: headingText.trim(),
      sourceStartOffset: startLine.startOffset as Utf16Offset,
      contentStartOffset: contentStartOffset as Utf16Offset,
      sourceEndOffset: sourceEndOffset as Utf16Offset,
      charCount: sourceEndOffset - startLine.startOffset,
      paragraphCount: countParagraphs(body),
      contentSha256: sha256Hex(body),
    });
    openStart = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].text;
    const match = matchHeading(line);
    if (!match) continue;
    if (match.kind === 'volume') {
      // Volume headings become the current volume context for the following
      // chapters; they do not produce a bodyless chapter themselves (Spec §11.1).
      currentVolume = line.trim();
      continue;
    }
    // chapter heading: close the previous chapter, open a new one.
    if (openStart) {
      closeChapter(i);
    }
    openStart = { lineIdx: i, headingLine: line };
  }
  // Close the final chapter at end-of-text.
  closeChapter(lines.length);

  if (chapters.length === 0) {
    return buildFallback(text);
  }
  if (chapters.length === 1 && warnings.length === 0) {
    // Single chapter from a single heading is fine, no warning.
  }
  return {
    chapters,
    parserVersion: PARSER_VERSION,
    fallbackUsed: false,
    warnings,
  };
}

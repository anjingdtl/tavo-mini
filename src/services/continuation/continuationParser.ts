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
import { Sha256Stream, sha256Hex } from './hashUtils';

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

/**
 * Streaming chapter parser (Spec §11, streaming variant).
 *
 * The one-shot {@link parseSourceChapters} splits the whole normalized text on
 * `\n` and slices each chapter body out of memory. The streaming variant is fed
 * complete lines one at a time and emits a finished chapter whenever the next
 * heading arrives, so memory stays O(current chapter) instead of O(whole text).
 *
 * The caller is responsible for:
 *   - splitting decoded/normalized chunks into lines (handling a trailing
 *     partial line across chunk boundaries) and tracking each line's UTF-16
 *     start offset into the normalized text;
 *   - feeding the whole-text hash/paragraph count into {@link finalize} so a
 *     no-heading fallback chapter can be built without re-reading the text.
 */
export interface StreamingChapterParser {
  /**
   * Feed one complete line (no trailing newline). `lineStartOffset` is the
   * UTF-16 offset of the first character of this line within the normalized
   * text. Returns any chapters that closed as a result of this line being a
   * heading (0 or 1 elements).
   */
  pushLine(line: string, lineStartOffset: number): ParsedChapter[];
  /**
   * Feed a body line without joining its pieces into one giant JS string.
   * Import uses this for pathological files containing a very long line.
   */
  pushBodyLineChunks(
    parts: readonly string[],
    lineStartOffset: number,
    lineLength: number,
  ): ParsedChapter[];
  /**
   * Finalize the parse. Closes the trailing chapter and, if no headings were
   * ever found, builds a fallback chapter from the caller-supplied whole-text
   * hash and paragraph count.
   */
  finalize(opts: {
    /** SHA-256 of the entire normalized text (for the fallback chapter). */
    fallbackSha256: string;
    /** Paragraph count of the entire normalized text (for the fallback chapter). */
    fallbackParagraphCount: number;
    /** Total UTF-16 length of the normalized text (chapter end offsets). */
    totalCharCount: number;
  }): { chapters: ParsedChapter[]; fallbackUsed: boolean; warnings: string[] };
}

export function createStreamingChapterParser(): StreamingChapterParser {
  let currentVolume: string | null = null;
  let openStart: { startOffset: number; headingLine: string } | null = null;
  let nextPosition = 0;
  let sawAnyHeading = false;

  // Per-chapter body accumulators: a streaming hash + online paragraph count.
  let bodyHasher: Sha256Stream | null = null;
  let bodyParagraphCount = 0;
  // Tracks the content_start_offset of the currently-open chapter (the offset
  // of the first body line after the heading). Null until the first body line.
  let openContentStartOffset: number | null = null;
  // The body hash must reproduce text.slice(contentStart, sourceEnd) exactly.
  // Each body line contributes its content plus a trailing '\n' ONLY when that
  // '\n' falls before the chapter's sourceEndOffset (one-shot slice is exclusive
  // of sourceEnd). We buffer one line and resolve its separator against the
  // chapter end offset when the next line or finalize arrives.
  let pendingBodyLine: { contentEndOffset: number } | null = null;

  // Flush the buffered line. `chapterEndOffset` is the sourceEndOffset of the
  // chapter being closed; the line's trailing '\n' is included iff it sits at
  // contentEndOffset < chapterEndOffset (i.e. inside the body slice).
  const flushPendingBodyLine = (chapterEndOffset: number) => {
    if (pendingBodyLine === null || bodyHasher === null) return;
    if (pendingBodyLine.contentEndOffset < chapterEndOffset) {
      bodyHasher.updateString('\n');
    }
    pendingBodyLine = null;
  };

  const closeChapter = (endOffset: number): ParsedChapter | null => {
    if (!openStart || bodyHasher === null) return null;
    flushPendingBodyLine(endOffset);
    const sourceStartOffset = openStart.startOffset;
    // content_start_offset = start of the line AFTER the heading line. We track
    // it when the first body line arrives (see pushLine); fall back to just
    // after the heading if the chapter has no body.
    const contentStartOffset =
      openContentStartOffset ?? sourceStartOffset + openStart.headingLine.length + 1;
    const sourceEndOffset = endOffset;
    const charCount = sourceEndOffset - sourceStartOffset;
    const chapter: ParsedChapter = {
      position: nextPosition as SourceChapterPosition,
      volumeTitle: currentVolume,
      detectedTitle: openStart.headingLine.trim(),
      title: openStart.headingLine.trim(),
      sourceStartOffset: sourceStartOffset as Utf16Offset,
      contentStartOffset: contentStartOffset as Utf16Offset,
      sourceEndOffset: sourceEndOffset as Utf16Offset,
      charCount,
      paragraphCount: bodyParagraphCount,
      contentSha256: bodyHasher.digest(),
    };
    nextPosition += 1;
    openStart = null;
    bodyHasher = null;
    bodyParagraphCount = 0;
    openContentStartOffset = null;
    pendingBodyLine = null;
    return chapter;
  };

  const pushLine = (line: string, lineStartOffset: number): ParsedChapter[] => {
    const match = matchHeading(line);
    if (match) {
      if (match.kind === 'volume') {
        currentVolume = line.trim();
        // A volume line does not close the current chapter, but it sits inside
        // the chapter's body slice (one-shot computes body via text.slice over
        // offsets, so any line between two chapter headings — including volume
        // markers — is part of the body). Feed it to the body hash + paragraph
        // counter just like an ordinary body line.
        if (openStart && bodyHasher) {
          if (openContentStartOffset === null) {
            openContentStartOffset = lineStartOffset;
          }
          flushPendingBodyLine(lineStartOffset);
          bodyHasher.updateString(line);
          pendingBodyLine = {
            contentEndOffset: lineStartOffset + line.length,
          };
          // one-shot countParagraphs = body.split(/\n+/).filter(non-empty).length,
          // which counts each non-blank line as its own paragraph (every line is
          // '\n'-separated). Blank/whitespace-only lines do not count.
          if (line.trim().length > 0) bodyParagraphCount += 1;
        }
        return [];
      }
      // Chapter heading: close the previous chapter at this heading's offset.
      sawAnyHeading = true;
      const closed: ParsedChapter[] = [];
      if (openStart) {
        const c = closeChapter(lineStartOffset);
        if (c) closed.push(c);
      }
      openStart = { startOffset: lineStartOffset, headingLine: line };
      bodyHasher = new Sha256Stream();
      bodyParagraphCount = 0;
      openContentStartOffset = null;
      pendingBodyLine = null;
      return closed;
    }
    // Body line of the currently-open chapter. Update the body hash + paragraph
    // counter. If no chapter is open yet, the line belongs to the pre-first-
    // heading preamble and is ignored (matches one-shot, which only records
    // chapters starting at the first heading).
    if (openStart && bodyHasher) {
      if (openContentStartOffset === null) {
        openContentStartOffset = lineStartOffset;
      }
      // Flush the previously-buffered line: the new line starts at lineStartOffset,
      // which is strictly past the buffered line's contentEndOffset, so its '\n'
      // separator is inside the body and must be hashed.
      flushPendingBodyLine(lineStartOffset);
      bodyHasher.updateString(line);
      pendingBodyLine = {
        contentEndOffset: lineStartOffset + line.length,
      };
      // Each non-blank line is one paragraph (see note in the volume branch).
      if (line.trim().length > 0) bodyParagraphCount += 1;
    }
    return [];
  };

  const pushBodyLineChunks = (
    parts: readonly string[],
    lineStartOffset: number,
    lineLength: number,
  ): ParsedChapter[] => {
    // A line this large cannot be a useful chapter marker under the parser's
    // line-oriented rules. Hash its pieces as they arrive instead of forcing
    // the import pipeline to allocate one contiguous string for the line.
    if (openStart && bodyHasher) {
      if (openContentStartOffset === null) {
        openContentStartOffset = lineStartOffset;
      }
      flushPendingBodyLine(lineStartOffset);
      for (const part of parts) {
        bodyHasher.updateString(part);
      }
      pendingBodyLine = {contentEndOffset: lineStartOffset + lineLength};
      if (parts.some(part => part.trim().length > 0)) {
        bodyParagraphCount += 1;
      }
    }
    return [];
  };

  const finalize = (opts: {
    fallbackSha256: string;
    fallbackParagraphCount: number;
    totalCharCount: number;
  }): { chapters: ParsedChapter[]; fallbackUsed: boolean; warnings: string[] } => {
    if (!sawAnyHeading) {
      // No headings anywhere → whole-text fallback (Spec §11.3).
      const title = '整篇（无标题）';
      const fallback: ParsedChapter = {
        position: 0 as SourceChapterPosition,
        volumeTitle: null,
        detectedTitle: title,
        title,
        sourceStartOffset: 0 as Utf16Offset,
        contentStartOffset: 0 as Utf16Offset,
        sourceEndOffset: opts.totalCharCount as Utf16Offset,
        charCount: opts.totalCharCount,
        paragraphCount: opts.fallbackParagraphCount,
        contentSha256: opts.fallbackSha256,
      };
      return {
        chapters: [fallback],
        fallbackUsed: true,
        warnings: ['未检测到章节标题，整篇作为单一章节。可手动拆分或选择按字数切分。'],
      };
    }
    // Close the trailing chapter at end-of-text, if any is still open. The
    // flushPendingBodyLine call inside closeChapter decides whether the final
    // line's trailing '\n' belongs to the body by comparing its contentEndOffset
    // against totalCharCount (one-shot slice is exclusive of totalCharCount).
    const closed: ParsedChapter[] = [];
    if (openStart) {
      const c = closeChapter(opts.totalCharCount);
      if (c) closed.push(c);
    }
    return {
      chapters: closed,
      fallbackUsed: false,
      warnings: [],
    };
  };

  return { pushLine, pushBodyLineChunks, finalize };
}

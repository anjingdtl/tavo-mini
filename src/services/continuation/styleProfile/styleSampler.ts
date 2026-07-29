/**
 * Deterministic stratified sampler for style analysis (Spec §5.4).
 *
 * Sampling MUST be deterministic and reproducible: the seed is the source
 * fingerprint, so resuming a paused/retried run produces byte-identical sample
 * references. Output is ONLY {@link StyleSampleRef} references — never long
 * original passages for copy (invariant §2: the DB holds no new long-text
 * copy; evidence is re-read via the bounded source reader and hash-verified).
 *
 * The 8 stratification kinds (Spec §5.4): opening, middle, boundary, dialogue,
 * action, emotion, description, transition. Each chapter can yield at most a
 * small number of refs per kind, and every ref is clipped to the bounded
 * chapter's range (which the bounded reader already clipped to the boundary).
 */
import type {
  BoundedSourceChapter,
} from '../types';
import type { SourceChapterPosition, Utf16Offset } from '../../../types/novel';
import { sha256Hex } from '../hashUtils';
import type { SampleKind } from './styleStatistics';

/** Re-export the sample-kind union under the sampler's domain name. */
export type { SampleKind };

/**
 * A reference to a bounded source span chosen as a style sample (Spec §5.4).
 * Offsets are UTF-16 code units relative to the chapter's body start
 * (`range.start`). The DB stores ONLY this reference, never the passage; the
 * Context/Checker re-reads via the bounded source reader and verifies the hash.
 */
export interface StyleSampleRef {
  sourceChapterId: number;
  sourcePosition: SourceChapterPosition;
  /** UTF-16 offset of the span start, relative to the book (matches the
   * bounded chapter's `range.start` frame). */
  charStart: Utf16Offset;
  /** UTF-16 offset of the span end (exclusive). */
  charEnd: Utf16Offset;
  /** SHA-256 hex of the referenced passage. Re-verified on every re-read. */
  contentHash: string;
  sampleKind: SampleKind;
}

/** Target span length per sample, in UTF-16 code units (Spec §5.4: a passage
 * big enough to judge style, small enough to fit many into one LLM call). */
const SAMPLE_TARGET_CHARS = 240;
/** Hard floor so a sample is meaningful even in a very short chapter. */
const SAMPLE_MIN_CHARS = 40;
/** Max samples per kind per chapter to avoid over-weighting one chapter. */
const MAX_PER_KIND_PER_CHAPTER = 2;

/**
 * xmur3 string hash → unsigned 32-bit seed. Deterministic across runs and
 * platforms (no Math.random, no Date). Used to seed the PRNG.
 */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/**
 * Mulberry32 PRNG: fast, deterministic, good distribution. Returns a function
 * producing floats in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Create a deterministic [0,1) RNG seeded by the source fingerprint string. */
export function createSeededRng(seed: string): () => number {
  const seedFn = xmur3(seed);
  return mulberry32(seedFn());
}

/** Quote characters used to detect dialogue spans (must match styleStatistics). */
const QUOTE_OPEN = new Set(['“', '「', '『', '"']);
const QUOTE_CLOSE = new Set(['”', '」', '』', '"']);

// Lexical cues for kind detection (kept local to the sampler; the statistics
// module uses its own broader lists).
const DIALOGUE_CUE = [...QUOTE_OPEN];
const ACTION_CUES = ['走', '跑', '跳', '抓', '挥', '推', '拉', '打', '踢', '冲', '扑', '拔'];
const EMOTION_CUES = [
  '心想',
  '觉得',
  '感到',
  '担心',
  '害怕',
  '愤怒',
  '悲伤',
  '笑',
  '哭',
  '怒',
  '惊',
];
const DESCRIPTION_CUES = [
  '阳光',
  '风',
  '雨',
  '雪',
  '天空',
  '山',
  '树',
  '街道',
  '房间',
  '气味',
  '声音',
  '光线',
];
const TRANSITION_CUES = [
  '随后',
  '不久',
  '第二天',
  '几天后',
  '数日后',
  '这时',
  '此时',
  '与此同时',
  '转眼',
  '后来',
  '翌日',
];

function anyPresent(text: string, cues: readonly string[]): boolean {
  return cues.some(c => text.includes(c));
}

interface ParagraphSlice {
  /** Index into the chapter's full content where this paragraph starts. */
  start: number;
  /** Exclusive end index. */
  end: number;
  text: string;
}

function splitParagraphSlices(content: string): ParagraphSlice[] {
  const out: ParagraphSlice[] = [];
  let start = 0;
  for (let i = 0; i <= content.length; i += 1) {
    if (i === content.length || content[i] === '\n') {
      const seg = content.slice(start, i).trim();
      if (seg.length > 0) {
        out.push({ start, end: i, text: seg });
      }
      start = i + 1;
    }
  }
  return out;
}

/** Find paragraph indices whose text matches a given kind classifier. */
function paragraphsMatchingKind(
  paras: ParagraphSlice[],
  kind: SampleKind,
): ParagraphSlice[] {
  switch (kind) {
    case 'dialogue':
      return paras.filter(p => anyPresent(p.text, DIALOGUE_CUE));
    case 'action':
      return paras.filter(p => anyPresent(p.text, ACTION_CUES));
    case 'emotion':
      return paras.filter(p => anyPresent(p.text, EMOTION_CUES));
    case 'description':
      return paras.filter(p => anyPresent(p.text, DESCRIPTION_CUES));
    case 'transition':
      return paras.filter(p =>
        TRANSITION_CUES.some(c => p.text.startsWith(c)),
      );
    default:
      return paras;
  }
}

/**
 * Build a sample ref from a paragraph slice of the SAME chapter, clipped to
 * SAMPLE_TARGET_CHARS and never exceeding the chapter's bounded range. The
 * slice MUST originate from `chapter.content` (its `start`/`end` are local to
 * that content). Offsets are translated to book-frame UTF-16 offsets using the
 * chapter's `range.start`.
 */
function buildRef(
  chapter: BoundedSourceChapter,
  slice: ParagraphSlice,
  kind: SampleKind,
): StyleSampleRef | null {
  const contentLen = chapter.content.length;
  if (contentLen === 0) return null;
  // Clamp the local start to a valid index inside this chapter's content.
  const localStart = Math.max(0, Math.min(slice.start, contentLen - 1));
  const sliceLen = slice.end - slice.start;
  let len = Math.min(sliceLen, SAMPLE_TARGET_CHARS);
  if (len < SAMPLE_MIN_CHARS) {
    // Extend forward up to the minimum so the sample is meaningful, but never
    // past the chapter's (already boundary-clipped) content.
    const available = contentLen - localStart;
    len = Math.min(SAMPLE_MIN_CHARS, available);
  }
  if (len <= 0) return null;
  let localEnd = localStart + len;
  if (localEnd > contentLen) localEnd = contentLen;
  const passage = chapter.content.slice(localStart, localEnd);
  if (passage.trim().length === 0) return null;

  const bookStart = chapter.range.start + localStart;
  const bookEnd = chapter.range.start + localEnd;
  return {
    sourceChapterId: chapter.id,
    sourcePosition: chapter.position,
    charStart: bookStart as Utf16Offset,
    charEnd: bookEnd as Utf16Offset,
    contentHash: sha256Hex(passage),
    sampleKind: kind,
  };
}

/**
 * Deterministically stratified sample for style analysis (Spec §5.4).
 *
 * @param chapters bounded source chapters (already clipped to the boundary).
 * @param seed source fingerprint string — same seed always yields the same
 *   refs, making pause/resume/retry reproducible.
 * @returns deduplicated {@link StyleSampleRef}s covering the 8 kinds. Only
 *   references are returned; no long passage text is stored.
 */
export function sampleForStyleAnalysis(
  chapters: BoundedSourceChapter[],
  seed: string,
): StyleSampleRef[] {
  if (chapters.length === 0) return [];
  const rng = createSeededRng(seed);
  const refs: StyleSampleRef[] = [];
  const seenHashes = new Set<string>();
  const n = chapters.length;

  // Helper: deterministic index pick within [0, length). rng() is in [0,1), so
  // Math.floor(rng() * length) already lands in [0, length); no modulo needed.
  const pickIndex = (length: number): number =>
    length === 0 ? 0 : Math.floor(rng() * length);

  /**
   * Build a positional-stratum ref from a deterministic character window inside
   * the chapter. Unlike {@link buildRef} (paragraph-aligned, used by lexical
   * strata), this samples an arbitrary UTF-16 window so it can produce a ref
   * even when every paragraph is already labelled with a lexical kind. The
   * window length is SAMPLE_TARGET_CHARS (or the whole chapter if shorter).
   */
  const buildWindowRef = (
    chapter: BoundedSourceChapter,
    kind: SampleKind,
  ): StyleSampleRef | null => {
    const contentLen = chapter.content.length;
    if (contentLen === 0) return null;
    const len = Math.min(SAMPLE_TARGET_CHARS, contentLen);
    const maxStart = contentLen - len;
    // Deterministic start offset within [0, maxStart].
    const localStart =
      maxStart <= 0 ? 0 : Math.floor(rng() * (maxStart + 1));
    const passage = chapter.content.slice(localStart, localStart + len);
    if (passage.trim().length === 0) return null;
    const bookStart = chapter.range.start + localStart;
    const bookEnd = chapter.range.start + localStart + len;
    return {
      sourceChapterId: chapter.id,
      sourcePosition: chapter.position,
      charStart: bookStart as Utf16Offset,
      charEnd: bookEnd as Utf16Offset,
      contentHash: sha256Hex(passage),
      sampleKind: kind,
    };
  };

  // ---- Positional strata: opening / middle / boundary ----
  // opening: chapters in the first ~20% of the bounded range.
  const openingEnd = Math.max(1, Math.ceil(n * 0.2));
  // boundary: the last bounded chapter (already clipped to the boundary by
  // the reader) plus optionally the one before it.
  const boundaryStart = Math.max(0, n - 2);

  /**
   * Positional strata sample by a deterministic character window inside a
   * chapter (not paragraph-aligned), so they remain independent of the lexical
   * strata that claim whole paragraphs. This guarantees the positional kinds
   * (opening/middle/boundary) can always materialise a ref even when every
   * paragraph in a chapter was already labelled with a lexical kind.
   */
  const collectPositional = (
    pool: BoundedSourceChapter[],
    kind: SampleKind,
    count: number,
  ): void => {
    if (pool.length === 0) return;
    let added = 0;
    let guard = 0;
    while (added < count && guard < pool.length * 6) {
      const chapter = pool[pickIndex(pool.length)];
      const ref = buildWindowRef(chapter, kind);
      if (ref && !seenHashes.has(ref.contentHash)) {
        seenHashes.add(ref.contentHash);
        refs.push(ref);
        added += 1;
      }
      guard += 1;
    }
  };

  // ---- Lexical strata run FIRST: kind-specific passages (dialogue / action /
  // emotion / description / transition) are scarcer, so they get priority for
  // their own kind label. The generic positional strata then fill in without
  // stealing these passages (the per-passage contentHash dedup prevents a
  // double label on the same span).
  const lexicalKinds: SampleKind[] = [
    'dialogue',
    'action',
    'emotion',
    'description',
    'transition',
  ];
  for (const kind of lexicalKinds) {
    // Iterate chapters in a deterministic but shuffled order (Fisher-Yates over
    // indices using the same rng) so a single early chapter doesn't dominate.
    const order = chapters.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let addedForKind = 0;
    for (const idx of order) {
      if (addedForKind >= 4) break; // cap total per lexical kind across book
      const chapter = chapters[idx];
      const perChapterCount = refs.filter(
        r => r.sourceChapterId === chapter.id && r.sampleKind === kind,
      ).length;
      if (perChapterCount >= MAX_PER_KIND_PER_CHAPTER) continue;

      const paras = splitParagraphSlices(chapter.content);
      const matching = paragraphsMatchingKind(paras, kind);
      if (matching.length === 0) continue;
      // Deterministically shuffle the matching paragraphs and take the first
      // unclaimed one, so a paragraph already claimed by another kind does not
      // starve this kind when other matching paragraphs exist in the chapter.
      const shuffledMatching = [...matching];
      for (let p = shuffledMatching.length - 1; p > 0; p -= 1) {
        const q = Math.floor(rng() * (p + 1));
        [shuffledMatching[p], shuffledMatching[q]] = [shuffledMatching[q], shuffledMatching[p]];
      }
      for (const slice of shuffledMatching) {
        if (addedForKind >= 4) break;
        const ref = buildRef(chapter, slice, kind);
        if (ref && !seenHashes.has(ref.contentHash)) {
          seenHashes.add(ref.contentHash);
          refs.push(ref);
          addedForKind += 1;
        }
      }
    }
  }

  // ---- Positional strata: opening / middle / boundary (fill remaining slots).
  collectPositional(chapters.slice(0, openingEnd), 'opening', 2);
  const middlePool =
    boundaryStart > openingEnd
      ? chapters.slice(openingEnd, boundaryStart)
      : chapters;
  collectPositional(middlePool, 'middle', 2);
  collectPositional(chapters.slice(boundaryStart), 'boundary', 2);

  return refs;
}

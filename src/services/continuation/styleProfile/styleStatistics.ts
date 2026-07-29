/**
 * Full local style statistics over ALL bounded chapters (Spec §5.3).
 *
 * No LLM calls here — this produces the objective whole-book overview stored as
 * `metrics_json`, fed to the analyzer LLM and later used by the Checker for
 * explainable drift. The implementation is Chinese-punctuation-aware and
 * UTF-16-correct: sentence splitting uses CJK terminal punctuation (。！？…）
 * plus ASCII `.!?`, and offsets/lengths are measured in UTF-16 code units so
 * they line up with the bounded source reader's offsets (Spec §5.3).
 *
 * Invariants honoured:
 *  - Reads only the supplied {@link BoundedSourceChapter}s, which the bounded
 *    source reader has already physically clipped to the boundary. We never
 *    re-fetch source text here.
 *  - Never returns future source: the chapters array already excludes it.
 */
import type { BoundedSourceChapter } from '../types';

/** Sample bucket name shared with the sampler (Spec §5.4). */
export type SampleKind =
  | 'opening'
  | 'middle'
  | 'boundary'
  | 'dialogue'
  | 'action'
  | 'emotion'
  | 'description'
  | 'transition';

/** Histogram helper: count occurrences per discrete value. */
type Histogram = Record<string, number>;

/** Distribution summary for a numeric measurement. */
export interface Distribution {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  /** Approximate p25 / p75 for "typical range" reporting. */
  p25: number;
  p75: number;
}

/**
 * Full metrics object persisted as `metrics_json` (Spec §5.3). All numeric
 * fields are measured in UTF-16 code units to match the source reader.
 */
export interface StyleMetrics {
  schemaVersion: 2;
  chapterCount: number;
  totalChars: number;
  sentenceLength: Distribution;
  /** Sentence-length bucket histogram for shape inspection (short/medium/long). */
  sentenceLengthBuckets: Histogram;
  paragraphLength: Distribution;
  dialogue: {
    /** 0..1 share of total chars inside quotation marks. */
    ratio: number;
    turnCount: number;
    /** Distribution of consecutive dialogue turns per run. */
    turnRunDistribution: Distribution;
  };
  punctuation: {
    /** Per-character counts of terminal/sentence-breaking punctuation. */
    sentenceBreaking: Histogram;
    /** Per-character counts of frequent internal punctuation. */
    frequent: Histogram;
    /** 0..1 ratio of exclamation/question marks among terminal marks. */
    emotionalTerminalRatio: number;
  };
  person: {
    firstPersonSignals: number;
    thirdPersonSignals: number;
    /** 0..1 estimated first-person share (0 when no signals). */
    firstPersonRatio: number;
  };
  /** Approximate 0..1 ratios of four functional text kinds. */
  functionalRatios: {
    psychological: number;
    action: number;
    environment: number;
    expository: number;
  };
  chapterSignals: {
    /** Signals of chapter-opening patterns (e.g. scene/setting openers). */
    opening: Histogram;
    /** Signals of chapter-ending patterns (e.g. hook / cliffhanger). */
    ending: Histogram;
    /** Signals of scene-transition markers between paragraphs. */
    transition: Histogram;
  };
}

const EMPTY_DISTRIBUTION: Distribution = {
  count: 0,
  min: 0,
  max: 0,
  mean: 0,
  median: 0,
  p25: 0,
  p75: 0,
};

// CJK + ASCII terminal punctuation. The ellipsis … may appear as a single
// char (U+2026) or as the repeated … character; both are handled.
const TERMINAL_PUNCTUATION = new Set([
  '。',
  '！',
  '？',
  '.',
  '!',
  '?',
  '…',
]);
const EMOTIONAL_TERMINAL = new Set(['！', '!', '？', '?']);
// Common internal CJK / ASCII punctuation worth counting.
const INTERNAL_PUNCTUATION = new Set([
  '，',
  ',',
  '、',
  '；',
  ';',
  '：',
  ':',
  '——',
  '……',
  '"',
  '"',
  '"',
  '\'',
  '\'',
  '「',
  '」',
  '『',
  '』',
  '（',
  '）',
  '(',
  ')',
  '《',
  '》',
]);
const QUOTE_OPEN = new Set(['“', '「', '『', '"']);
const QUOTE_CLOSE = new Set(['”', '」', '』', '"']);

// First-person Chinese pronouns (and the common 我). Third-person markers.
const FIRST_PERSON_TOKENS = ['我', '咱们', '我们', '俺', '鄙人', '本人'];
const THIRD_PERSON_TOKENS = ['他', '她', '它', '他们', '她们', '它们', '祂'];

// Functional-text lexical cues. Very approximate — these seed the ratio
// estimation that the LLM then refines into operational instructions.
const PSYCHOLOGICAL_CUES = [
  '心想',
  '想道',
  '暗想',
  '觉得',
  '感到',
  '心想',
  '知道',
  '明白',
  '担心',
  '害怕',
  '回忆',
  '记得',
];
const ACTION_CUES = [
  '走',
  '跑',
  '跳',
  '抓',
  '挥',
  '推',
  '拉',
  '打',
  '踢',
  '冲',
  '扑',
  '拔',
];
const ENVIRONMENT_CUES = [
  '天空',
  '阳光',
  '风',
  '雨',
  '雪',
  '树',
  '山',
  '街道',
  '房间',
  '气味',
  '声音',
  '光线',
];
const EXPOSITORY_CUES = [
  '因为',
  '所以',
  '因此',
  '也就是说',
  '换句话说',
  '简单来说',
  '据',
  '根据',
  '原本',
  '本来',
  '据说',
];

// Transition signals: time/scene jumps that often start a paragraph.
const TRANSITION_CUES = [
  '随后',
  '不久',
  '第二天',
  '几天后',
  '数日后',
  '一夜过去',
  '这时',
  '此时',
  '与此同时',
  '转眼',
  '后来',
  '翌日',
];

function emptyHistogram(): Histogram {
  return {};
}

function bump(hist: Histogram, key: string, by = 1): void {
  hist[key] = (hist[key] ?? 0) + by;
}

function computeDistribution(samples: number[]): Distribution {
  if (samples.length === 0) return { ...EMPTY_DISTRIBUTION };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const pick = (q: number): number => {
    if (sorted.length === 1) return sorted[0];
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.floor(q * (sorted.length - 1))),
    );
    return sorted[idx];
  };
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    median: pick(0.5),
    p25: pick(0.25),
    p75: pick(0.75),
  };
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor(q * (sortedAsc.length - 1))),
  );
  return sortedAsc[idx];
}

/**
 * Split text into sentences using CJK + ASCII terminal punctuation. Returns
 * the sentences (without the terminal mark) plus their lengths in UTF-16
 * units. Pure: no mutation, no allocation of the original (we only slice).
 */
function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (TERMINAL_PUNCTUATION.has(ch)) {
      // Collapse a run of terminal punctuation (e.g. 。。。, ？！, ……) so it
      // ends one sentence instead of producing empty fragments. Each terminal
      // char is still counted individually in the punctuation histogram; this
      // only affects sentence-boundary detection.
      let end = i + 1;
      while (end < text.length && TERMINAL_PUNCTUATION.has(text[end])) {
        end += 1;
      }
      const segment = text.slice(start, end).trim();
      if (segment.length > 0) sentences.push(segment);
      start = end;
      i = end;
    } else {
      i += 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail.length > 0) sentences.push(tail);
  return sentences;
}

function splitParagraphs(text: string): string[] {
  // Paragraphs are split on one or more newlines. We keep this simple and
  // robust: any \n (optionally with \r) starts a new paragraph.
  return text
    .split(/\r?\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function sumCueOccurrences(text: string, cues: readonly string[]): number {
  let total = 0;
  for (const cue of cues) {
    total += countOccurrences(text, cue);
  }
  return total;
}

/**
 * Compute the dialogue ratio and turn-run distribution. A "turn" is one quoted
 * span; a "run" is a maximal sequence of turns with no narrative paragraph
 * between them. We approximate "inside quotation marks" by scanning for paired
 * open/close quote characters (UTF-16 aware).
 */
function computeDialogue(text: string): {
  ratio: number;
  turnCount: number;
  turnRunDistribution: Distribution;
} {
  let inQuote = false;
  let quotedChars = 0;
  let turnCount = 0;
  let openIdx = -1;
  // First pass: count quoted chars + turns.
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (QUOTE_OPEN.has(ch) && !inQuote) {
      inQuote = true;
      openIdx = i;
    } else if (QUOTE_CLOSE.has(ch) && inQuote) {
      inQuote = false;
      if (openIdx >= 0) {
        quotedChars += i - openIdx + 1;
        turnCount += 1;
      }
      openIdx = -1;
    }
  }
  const totalChars = text.length;
  const ratio = totalChars === 0 ? 0 : quotedChars / totalChars;

  // Turn-run distribution: scan paragraphs, count consecutive dialogue
  // paragraphs, then reset when a non-dialogue paragraph appears.
  const runs: number[] = [];
  let currentRun = 0;
  for (const para of splitParagraphs(text)) {
    const hasQuote =
      [...QUOTE_OPEN].some(q => para.includes(q)) ||
      [...QUOTE_CLOSE].some(q => para.includes(q));
    if (hasQuote) {
      currentRun += 1;
    } else {
      if (currentRun > 0) runs.push(currentRun);
      currentRun = 0;
    }
  }
  if (currentRun > 0) runs.push(currentRun);

  return {
    ratio,
    turnCount,
    turnRunDistribution: computeDistribution(runs),
  };
}

/**
 * Detect chapter opening / ending / transition signals from the first and last
 * paragraphs of each chapter, plus paragraph-leading transition cues.
 */
function computeChapterSignals(
  chapters: BoundedSourceChapter[],
): {
  opening: Histogram;
  ending: Histogram;
  transition: Histogram;
} {
  const opening = emptyHistogram();
  const ending = emptyHistogram();
  const transition = emptyHistogram();

  for (const ch of chapters) {
    const paras = splitParagraphs(ch.content);
    if (paras.length === 0) continue;
    const firstPara = paras[0];
    const lastPara = paras[paras.length - 1];

    // Opening signal: does the chapter open with setting/environment, dialogue,
    // or action? Very rough classifier by leading cue.
    if (ENVIRONMENT_CUES.some(c => firstPara.includes(c))) {
      bump(opening, 'environment');
    }
    if ([...QUOTE_OPEN].some(q => firstPara.includes(q))) {
      bump(opening, 'dialogue');
    }
    if (ACTION_CUES.some(c => firstPara.includes(c))) {
      bump(opening, 'action');
    }
    if (!opening['environment'] && !opening['dialogue'] && !opening['action']) {
      bump(opening, 'narrative');
    }

    // Ending signal: hook / cliffhanger / ellipsis / question at the very end.
    const trimmedEnd = lastPara.trimEnd();
    if (trimmedEnd.endsWith('…') || trimmedEnd.endsWith('……')) {
      bump(ending, 'ellipsis_hook');
    } else if (trimmedEnd.endsWith('？') || trimmedEnd.endsWith('?')) {
      bump(ending, 'question_hook');
    } else if (trimmedEnd.endsWith('！') || trimmedEnd.endsWith('!')) {
      bump(ending, 'exclamation_hook');
    } else {
      bump(ending, 'closed');
    }

    // Transition signals: count paragraphs that begin with a transition cue.
    for (const para of paras) {
      for (const cue of TRANSITION_CUES) {
        if (para.startsWith(cue)) {
          bump(transition, cue);
          break;
        }
      }
    }
  }
  return { opening, ending, transition };
}

/**
 * Bucket a sentence length into a coarse shape label for the histogram.
 * Buckets are in UTF-16 code units, tuned for Chinese prose.
 */
function sentenceLengthBucket(len: number): string {
  if (len <= 10) return 'short(<=10)';
  if (len <= 20) return 'medium(11-20)';
  if (len <= 35) return 'long(21-35)';
  return 'very_long(>35)';
}

/**
 * Compute full local style metrics over ALL bounded chapters (Spec §5.3).
 *
 * @param chapters bounded source chapters (already clipped to the boundary by
 *   the bounded source reader — never pass unbounded source here).
 */
export function computeStyleMetrics(
  chapters: BoundedSourceChapter[],
): StyleMetrics {
  const sentenceLengths: number[] = [];
  const paragraphLengths: number[] = [];
  const sentenceLengthBuckets = emptyHistogram();
  const sentenceBreaking = emptyHistogram();
  const frequent = emptyHistogram();
  let emotionalTerminalCount = 0;
  let totalTerminalCount = 0;
  let firstPersonSignals = 0;
  let thirdPersonSignals = 0;
  let psychologicalHits = 0;
  let actionHits = 0;
  let environmentHits = 0;
  let expositoryHits = 0;
  let totalChars = 0;

  for (const ch of chapters) {
    const content = ch.content;
    totalChars += content.length;

    // Sentences (CJK-aware).
    const sentences = splitSentences(content);
    for (const s of sentences) {
      sentenceLengths.push(s.length);
      bump(sentenceLengthBuckets, sentenceLengthBucket(s.length));
    }

    // Paragraphs.
    for (const p of splitParagraphs(content)) {
      paragraphLengths.push(p.length);
    }

    // Terminal punctuation counts.
    for (let i = 0; i < content.length; i += 1) {
      const ch = content[i];
      if (TERMINAL_PUNCTUATION.has(ch)) {
        bump(sentenceBreaking, ch);
        totalTerminalCount += 1;
        if (EMOTIONAL_TERMINAL.has(ch)) emotionalTerminalCount += 1;
      }
      if (INTERNAL_PUNCTUATION.has(ch)) {
        bump(frequent, ch);
      }
    }

    // Person signals.
    firstPersonSignals += sumCueOccurrences(content, FIRST_PERSON_TOKENS);
    thirdPersonSignals += sumCueOccurrences(content, THIRD_PERSON_TOKENS);

    // Functional-text approximate hits.
    psychologicalHits += sumCueOccurrences(content, PSYCHOLOGICAL_CUES);
    actionHits += sumCueOccurrences(content, ACTION_CUES);
    environmentHits += sumCueOccurrences(content, ENVIRONMENT_CUES);
    expositoryHits += sumCueOccurrences(content, EXPOSITORY_CUES);
  }

  // Dialogue is computed on the whole text to keep turn-run detection global.
  let dialogueRatio = 0;
  let turnCount = 0;
  let turnRunDistribution: Distribution = EMPTY_DISTRIBUTION;
  if (totalChars > 0) {
    const fullText = chapters.map(c => c.content).join('\n');
    const d = computeDialogue(fullText);
    dialogueRatio = d.ratio;
    turnCount = d.turnCount;
    turnRunDistribution = d.turnRunDistribution;
  }

  const personTotal = firstPersonSignals + thirdPersonSignals;
  const functionalTotal =
    psychologicalHits + actionHits + environmentHits + expositoryHits;

  const chapterSignals = computeChapterSignals(chapters);

  return {
    schemaVersion: 2,
    chapterCount: chapters.length,
    totalChars,
    sentenceLength: computeDistribution(sentenceLengths),
    sentenceLengthBuckets,
    paragraphLength: computeDistribution(paragraphLengths),
    dialogue: {
      ratio: dialogueRatio,
      turnCount,
      turnRunDistribution,
    },
    punctuation: {
      sentenceBreaking,
      frequent,
      emotionalTerminalRatio:
        totalTerminalCount === 0 ? 0 : emotionalTerminalCount / totalTerminalCount,
    },
    person: {
      firstPersonSignals,
      thirdPersonSignals,
      firstPersonRatio: personTotal === 0 ? 0 : firstPersonSignals / personTotal,
    },
    functionalRatios: {
      psychological: ratioOrZero(psychologicalHits, functionalTotal),
      action: ratioOrZero(actionHits, functionalTotal),
      environment: ratioOrZero(environmentHits, functionalTotal),
      expository: ratioOrZero(expositoryHits, functionalTotal),
    },
    chapterSignals,
  };
}

function ratioOrZero(numer: number, denom: number): number {
  return denom === 0 ? 0 : numer / denom;
}

// Re-export quantile for potential checker use; keeps the API surface explicit.
export { quantile };

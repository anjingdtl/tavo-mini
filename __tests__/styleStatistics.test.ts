import {
  computeStyleMetrics,
} from '../src/services/continuation/styleProfile/styleStatistics';
import type { BoundedSourceChapter } from '../src/services/continuation/types';
import {
  asSourcePosition,
  asUtf16Offset,
} from '../src/services/continuation/continuationSourceRepository';

function makeChapter(
  id: number,
  position: number,
  content: string,
  opts: { clipped?: boolean; startOffset?: number } = {},
): BoundedSourceChapter {
  const start = opts.startOffset ?? 0;
  return {
    id,
    sourceId: 1,
    position: asSourcePosition(position),
    title: `第${position + 1}章`,
    content,
    range: {
      start: asUtf16Offset(start),
      end: asUtf16Offset(start + content.length),
    },
    clippedByBoundary: opts.clipped ?? false,
  };
}

describe('computeStyleMetrics', () => {
  it('covers all bounded chapters and reports the count + total chars', () => {
    const chapters = [
      makeChapter(1, 0, '他走了过去。风吹过。'),
      makeChapter(2, 1, '她笑了一下，转身离开。'),
    ];
    const m = computeStyleMetrics(chapters);
    expect(m.chapterCount).toBe(2);
    expect(m.totalChars).toBe(
      '他走了过去。风吹过。'.length + '她笑了一下，转身离开。'.length,
    );
  });

  it('splits Chinese sentences on 。 and produces a sentence-length distribution', () => {
    const m = computeStyleMetrics([
      makeChapter(1, 0, '短句。这稍微长一点的句子。最后这一句是最长的句子了。'),
    ]);
    // Three sentences: "短句。" (3), "这稍微长一点的句子。" (10), "最后这一句是最长的句子了。" (13)
    expect(m.sentenceLength.count).toBe(3);
    expect(m.sentenceLength.min).toBe(3);
    expect(m.sentenceLength.max).toBe(13);
    expect(m.sentenceLength.mean).toBeCloseTo((3 + 10 + 13) / 3, 5);
  });

  it('counts exclamation/question marks as emotional terminals', () => {
    const m = computeStyleMetrics([
      makeChapter(1, 0, '他来了。快跑！为什么？不行。'),
    ]);
    // Terminals: 。！？。  -> emotional = ！？ = 2 of 4
    expect(m.punctuation.emotionalTerminalRatio).toBeCloseTo(0.5, 5);
    expect(m.punctuation.sentenceBreaking['！']).toBe(1);
    expect(m.punctuation.sentenceBreaking['？']).toBe(1);
  });

  it('handles ellipsis as terminal punctuation', () => {
    const m = computeStyleMetrics([
      makeChapter(1, 0, '他沉默了……然后开口。'),
    ]);
    expect(m.sentenceLength.count).toBe(2);
    expect(m.punctuation.sentenceBreaking['…']).toBeGreaterThanOrEqual(1);
  });

  it('computes dialogue ratio from quoted spans', () => {
    const content = `"你来了。"他说。"嗯。"她答。
随后他离开了。`;
    const m = computeStyleMetrics([makeChapter(1, 0, content)]);
    expect(m.dialogue.turnCount).toBe(2);
    expect(m.dialogue.ratio).toBeGreaterThan(0);
  });

  it('detects first vs third person signals', () => {
    const m = computeStyleMetrics([
      makeChapter(1, 0, '我走过去。他看着我。我点了点头。'),
    ]);
    expect(m.person.firstPersonSignals).toBeGreaterThanOrEqual(2);
    expect(m.person.thirdPersonSignals).toBeGreaterThanOrEqual(1);
    expect(m.person.firstPersonRatio).toBeGreaterThan(0.5);
  });

  it('produces approximate functional ratios that sum to 1 when cues are present', () => {
    const m = computeStyleMetrics([
      makeChapter(
        1,
        0,
        '他心想不妙，转身就跑。阳光照在街道上。因为下雨，路很滑。',
      ),
    ]);
    const sum =
      m.functionalRatios.psychological +
      m.functionalRatios.action +
      m.functionalRatios.environment +
      m.functionalRatios.expository;
    expect(sum).toBeCloseTo(1, 5);
  });

  it('returns zero ratios (not NaN) for empty chapters', () => {
    const m = computeStyleMetrics([]);
    expect(m.chapterCount).toBe(0);
    expect(m.totalChars).toBe(0);
    expect(Number.isNaN(m.punctuation.emotionalTerminalRatio)).toBe(false);
    expect(Number.isNaN(m.person.firstPersonRatio)).toBe(false);
    expect(Number.isNaN(m.functionalRatios.action)).toBe(false);
    expect(m.dialogue.ratio).toBe(0);
  });

  it('classifies chapter-ending hook signals', () => {
    const m = computeStyleMetrics([
      makeChapter(1, 0, '一切归于平静……'),
      makeChapter(2, 1, '他真的死了吗？'),
      makeChapter(3, 2, '一切结束了。'),
    ]);
    expect(m.chapterSignals.ending['ellipsis_hook']).toBeGreaterThanOrEqual(1);
    expect(m.chapterSignals.ending['question_hook']).toBeGreaterThanOrEqual(1);
    expect(m.chapterSignals.ending['closed']).toBeGreaterThanOrEqual(1);
  });

  it('honours physical boundary clipping: only the supplied (clipped) text is measured', () => {
    // Simulate the bounded reader having clipped a long chapter at the boundary.
    const full = '前半部分内容。'.padEnd(20, '字') + '这部分在边界之后。';
    const clippedContent = full.slice(0, 20); // exactly what the reader returns
    const m = computeStyleMetrics([
      makeChapter(1, 0, clippedContent, { clipped: true }),
    ]);
    expect(m.totalChars).toBe(clippedContent.length);
    // The future-source sentence must not contribute any metrics.
    expect(m.sentenceLength.max).toBeLessThanOrEqual(clippedContent.length);
  });

  it('produces paragraph-length distribution from newlines', () => {
    const content = '第一段在这里。\n\n第二段比较短。\n\n第三段。';
    const m = computeStyleMetrics([makeChapter(1, 0, content)]);
    expect(m.paragraphLength.count).toBe(3);
    expect(m.paragraphLength.min).toBeLessThan(m.paragraphLength.max);
  });

  it('records internal punctuation frequency (comma-heavy vs dash-heavy)', () => {
    const m = computeStyleMetrics([
      makeChapter(1, 0, '他，她，它，来了。'),
    ]);
    expect(m.punctuation.frequent['，']).toBe(3);
  });
});

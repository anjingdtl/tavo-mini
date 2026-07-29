import {
  sampleForStyleAnalysis,
  createSeededRng,
  type StyleSampleRef,
} from '../src/services/continuation/styleProfile/styleSampler';
import type { BoundedSourceChapter } from '../src/services/continuation/types';
import {
  asSourcePosition,
  asUtf16Offset,
} from '../src/services/continuation/continuationSourceRepository';
import { sha256Hex } from '../src/services/continuation/hashUtils';

function makeChapter(
  id: number,
  position: number,
  content: string,
  startOffset = 0,
): BoundedSourceChapter {
  return {
    id,
    sourceId: 1,
    position: asSourcePosition(position),
    title: `第${position + 1}章`,
    content,
    range: {
      start: asUtf16Offset(startOffset),
      end: asUtf16Offset(startOffset + content.length),
    },
    clippedByBoundary: false,
  };
}

const SEED = 'source-1|v3|abc123|boundary-500';

// Build a realistic bounded corpus where each lexical kind is present.
function buildCorpus(): BoundedSourceChapter[] {
  const chapters: BoundedSourceChapter[] = [];
  let offset = 0;
  const make = (id: number, content: string) => {
    const ch = makeChapter(id, id, content, offset);
    offset += content.length + 1;
    return ch;
  };
  // opening-ish chapter: several distinct environment/opening paragraphs.
  chapters.push(
    make(
      0,
      [
        '阳光洒在青云镇的街道上，空气中弥漫着花香。',
        '少年推开木门，走出门外，深吸一口气。',
        '街道两旁的店铺陆续开门，这是个寻常的清晨。',
      ].join('\n'),
    ),
  );
  // dialogue + emotion heavy: multiple dialogue turns with interior feeling.
  chapters.push(
    make(
      1,
      [
        `"你来啦。"她轻声笑道，眼里带着期待。`,
        `"嗯。"他答道，心里感到一阵莫名的紧张。`,
        `"为什么不来找我？"她问，担心地皱起眉。`,
        `他沉默片刻，感到一阵愧疚涌上心头。`,
      ].join('\n'),
    ),
  );
  // action heavy: several distinct action beats.
  chapters.push(
    make(
      2,
      [
        '他猛地拔剑，一步冲上前去。',
        '一剑挥出，剑风凌厉，对方连退两步。',
        '对方反手一掌推来，他侧身闪过，回身便是一脚。',
      ].join('\n'),
    ),
  );
  // description heavy: multiple environment paragraphs.
  chapters.push(
    make(
      3,
      [
        '远处的群山被皑皑白雪覆盖，在阳光下闪着冷光。',
        '天空灰蒙蒙的，乌云低低地压在头顶。',
        '北风呼啸着卷起地上的落叶，空气中透着寒意。',
      ].join('\n'),
    ),
  );
  // transition + middle: several scene/time transitions.
  chapters.push(
    make(
      4,
      [
        '第二天清晨，他们再次踏上山路。',
        '随后不久，天色骤变，乌云翻涌而来。',
        '数日后，队伍终于抵达了边关的城寨。',
      ].join('\n'),
    ),
  );
  // boundary chapter (last): a few closing paragraphs.
  chapters.push(
    make(
      5,
      [
        '一切仿佛都要结束了。',
        '他独自站在原地，回忆如潮水般涌来。',
        '等待着那个早已注定的结局。',
      ].join('\n'),
    ),
  );
  return chapters;
}

describe('sampleForStyleAnalysis', () => {
  it('is deterministic: same seed + corpus yields byte-identical refs', () => {
    const corpus = buildCorpus();
    const a = sampleForStyleAnalysis(corpus, SEED);
    const b = sampleForStyleAnalysis(corpus, SEED);
    expect(a).toEqual(b);
  });

  it('different seeds produce different sample sets (seed actually drives RNG)', () => {
    const corpus = buildCorpus();
    const a = sampleForStyleAnalysis(corpus, SEED);
    const b = sampleForStyleAnalysis(corpus, 'different-seed|xyz');
    // At least the ordering or selection should differ.
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });

  it('createSeededRng is deterministic for a given seed', () => {
    const r1 = createSeededRng(SEED);
    const r2 = createSeededRng(SEED);
    const seq1 = Array.from({ length: 5 }, () => r1());
    const seq2 = Array.from({ length: 5 }, () => r2());
    expect(seq1).toEqual(seq2);
    // And stays in [0,1).
    for (const v of seq1) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('covers all 8 sampleKinds when the corpus is rich enough', () => {
    const corpus = buildCorpus();
    const refs = sampleForStyleAnalysis(corpus, SEED);
    const kinds = new Set(refs.map(r => r.sampleKind));
    const expected: StyleSampleRef['sampleKind'][] = [
      'opening',
      'middle',
      'boundary',
      'dialogue',
      'action',
      'emotion',
      'description',
      'transition',
    ];
    const missing = expected.filter(k => !kinds.has(k));
    expect(missing).toEqual([]);
  });

  it('never stores long passage text: refs contain only offsets + hash', () => {
    const corpus = buildCorpus();
    const refs = sampleForStyleAnalysis(corpus, SEED);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) {
      // A StyleSampleRef must not carry a passage / content / text field.
      expect(r).not.toHaveProperty('content');
      expect(r).not.toHaveProperty('text');
      expect(r).not.toHaveProperty('passage');
      // Required fields present.
      expect(typeof r.sourceChapterId).toBe('number');
      expect(typeof r.charStart).toBe('number');
      expect(typeof r.charEnd).toBe('number');
      expect(typeof r.contentHash).toBe('string');
      expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('no sample crosses its chapter boundary (charEnd <= chapter range.end)', () => {
    const corpus = buildCorpus();
    const refs = sampleForStyleAnalysis(corpus, SEED);
    for (const r of refs) {
      const chapter = corpus.find(c => c.id === r.sourceChapterId);
      expect(chapter).toBeDefined();
      // charStart/charEnd are book-frame offsets; must lie inside the chapter.
      expect(r.charStart).toBeGreaterThanOrEqual(chapter!.range.start);
      expect(r.charEnd).toBeLessThanOrEqual(chapter!.range.end);
      expect(r.charEnd).toBeGreaterThan(r.charStart);
    }
  });

  it('the contentHash matches the referenced passage (recomputable)', () => {
    const corpus = buildCorpus();
    const refs = sampleForStyleAnalysis(corpus, SEED);
    for (const r of refs) {
      const chapter = corpus.find(c => c.id === r.sourceChapterId)!;
      const localStart = r.charStart - chapter.range.start;
      const localEnd = r.charEnd - chapter.range.start;
      const passage = chapter.content.slice(localStart, localEnd);
      expect(sha256Hex(passage)).toBe(r.contentHash);
    }
  });

  it('respects physical boundary clipping: refs only cover supplied (clipped) text', () => {
    // Simulate a chapter the bounded reader clipped mid-way: the content here
    // is the clipped prefix; the "future" suffix is simply not present.
    const clipped = makeChapter(
      9,
      9,
      '他走过去。风吹过。阳光很好。这是边界前的内容。',
    );
    const refs = sampleForStyleAnalysis([clipped], SEED);
    for (const r of refs) {
      expect(r.charEnd).toBeLessThanOrEqual(clipped.range.end);
    }
  });

  it('returns an empty array for empty input without throwing', () => {
    expect(sampleForStyleAnalysis([], SEED)).toEqual([]);
  });

  it('handles a single short chapter gracefully (no crash, no invalid refs)', () => {
    const refs = sampleForStyleAnalysis(
      [makeChapter(0, 0, '短。')],
      SEED,
    );
    for (const r of refs) {
      expect(r.charEnd).toBeGreaterThan(r.charStart);
      expect(r.charEnd - r.charStart).toBeGreaterThanOrEqual(1);
    }
  });
});

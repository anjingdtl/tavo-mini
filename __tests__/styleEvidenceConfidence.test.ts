import { resolveStyleEvidenceConfidence } from '../src/services/continuation/styleProfile/styleEvidenceConfidence';
import {
  asSourcePosition,
  asUtf16Offset,
} from '../src/services/continuation/continuationSourceRepository';
import type { BoundedSourceChapter } from '../src/services/continuation/types';
import type { StyleSampleRef } from '../src/services/continuation/styleProfile/styleSampler';

function chapter(id: number, length: number): BoundedSourceChapter {
  const content = '原著正文。'.repeat(Math.ceil(length / 5)).slice(0, length);
  return {
    id,
    sourceId: 1,
    position: asSourcePosition(id),
    title: `第${id + 1}章`,
    content,
    range: { start: asUtf16Offset(0), end: asUtf16Offset(content.length) },
    clippedByBoundary: false,
  };
}

const kinds: StyleSampleRef['sampleKind'][] = [
  'opening',
  'middle',
  'boundary',
  'dialogue',
  'action',
  'emotion',
  'description',
  'transition',
];

describe('resolveStyleEvidenceConfidence', () => {
  it('raises a low model self-rating when a large, stratified corpus supports the profile', () => {
    const chapters = [
      chapter(1, 700_000),
      chapter(2, 700_000),
      chapter(3, 700_000),
    ];
    const refs = kinds.map((sampleKind, i) => ({
      sourceChapterId: (i % 3) + 1,
      sourcePosition: asSourcePosition(i % 3),
      charStart: asUtf16Offset(i * 400),
      charEnd: asUtf16Offset(i * 400 + 400),
      contentHash: `${i}`.padStart(64, '0'),
      sampleKind,
    }));

    expect(
      resolveStyleEvidenceConfidence({
        modelConfidence: 0.2,
        chapters,
        sampleRefs: refs,
      }),
    ).toBeGreaterThanOrEqual(0.8);
  });

  it('does not turn a tiny, poorly sampled excerpt into a high-confidence profile', () => {
    expect(
      resolveStyleEvidenceConfidence({
        modelConfidence: 0.1,
        chapters: [chapter(1, 120)],
        sampleRefs: [
          {
            sourceChapterId: 1,
            sourcePosition: asSourcePosition(0),
            charStart: asUtf16Offset(0),
            charEnd: asUtf16Offset(80),
            contentHash: 'a'.repeat(64),
            sampleKind: 'opening',
          },
        ],
      }),
    ).toBeLessThan(0.5);
  });
});

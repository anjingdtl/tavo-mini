/**
 * Evidence-based confidence for an original-style profile.
 *
 * The model's own `confidence` is useful as a weak signal, but it must not be
 * the sole source of the value shown to a writer: models often lower it merely
 * because a TXT was parsed into few logical chapters, even when a large,
 * well-stratified corpus was supplied. This score measures the support actually
 * provided to the analysis: bounded source volume, sample material, sampled
 * scene strata and coverage of available chapters.
 */
import type { BoundedSourceChapter } from '../types';
import type { StyleSampleRef } from './styleSampler';

const FULL_CORPUS_CHARS = 80_000;
const FULL_SAMPLE_CHARS = 2_800;
const STYLE_KIND_COUNT = 8;
const MAX_CONFIDENCE = 0.95;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function resolveStyleEvidenceConfidence(input: {
  modelConfidence: number;
  chapters: readonly BoundedSourceChapter[];
  sampleRefs: readonly StyleSampleRef[];
}): number {
  const totalSourceChars = input.chapters.reduce(
    (sum, chapter) => sum + chapter.content.length,
    0,
  );
  const totalSampleChars = input.sampleRefs.reduce(
    (sum, ref) =>
      sum + Math.max(0, Number(ref.charEnd) - Number(ref.charStart)),
    0,
  );
  const sampledChapterCount = new Set(
    input.sampleRefs.map(ref => ref.sourceChapterId),
  ).size;
  const sampledKindCount = new Set(input.sampleRefs.map(ref => ref.sampleKind))
    .size;

  const corpusScore = clamp01(totalSourceChars / FULL_CORPUS_CHARS);
  const sampleScore = clamp01(totalSampleChars / FULL_SAMPLE_CHARS);
  const kindScore = clamp01(sampledKindCount / STYLE_KIND_COUNT);
  // A single, large chapter can still be sampled across its full span; for a
  // multi-chapter book require samples from up to three distinct chapters.
  const requiredChapterSpread = Math.min(3, Math.max(1, input.chapters.length));
  const chapterSpreadScore = clamp01(
    sampledChapterCount / requiredChapterSpread,
  );

  const evidenceConfidence = Math.min(
    MAX_CONFIDENCE,
    0.1 +
      corpusScore * 0.35 +
      sampleScore * 0.2 +
      kindScore * 0.15 +
      chapterSpreadScore * 0.2,
  );
  const modelConfidence = clamp01(input.modelConfidence);
  return Math.max(modelConfidence, evidenceConfidence);
}

import {
  DEFAULT_REPAIR_COMPLETENESS_POLICY,
  evaluateRepairCompleteness,
  splitNaturalParagraphs,
} from '../src/services/continuation/generation/repairCompletenessPolicy';

describe('Repair completeness policy', () => {
  test('thresholds are centralized and independent of user target length', () => {
    expect(DEFAULT_REPAIR_COMPLETENESS_POLICY.minCandidateToWriterHanRatio).toBe(
      0.45,
    );
    expect(
      DEFAULT_REPAIR_COMPLETENESS_POLICY.minUnaffectedParagraphRetentionRatio,
    ).toBe(0.55);
  });

  test('splits natural paragraphs', () => {
    const ranges = splitNaturalParagraphs('甲段。\n\n乙段。\n丙段。');
    expect(ranges.length).toBe(3);
  });

  test('rejects fragment and accepts minimal full-chapter rewrite', () => {
    const paragraphs = Array.from(
      { length: 10 },
      (_, i) => `自然段${i}包含足够长度的叙述正文用于锚点检测。`,
    );
    const writerText = paragraphs.join('\n');
    const fragment = evaluateRepairCompleteness({
      writerText,
      candidateText: paragraphs[4],
      targetedSpans: [
        {
          generatedStart: writerText.indexOf(paragraphs[4]),
          generatedEnd:
            writerText.indexOf(paragraphs[4]) + paragraphs[4].length,
          generatedExcerpt: paragraphs[4],
        },
      ],
    });
    expect(fragment.passed).toBe(false);

    const full = paragraphs
      .map((p, i) => (i === 4 ? '目标段已按事实最小修订。' : p))
      .join('\n');
    const ok = evaluateRepairCompleteness({
      writerText,
      candidateText: full,
      targetedSpans: [
        {
          generatedStart: writerText.indexOf(paragraphs[4]),
          generatedEnd:
            writerText.indexOf(paragraphs[4]) + paragraphs[4].length,
          generatedExcerpt: paragraphs[4],
        },
      ],
    });
    expect(ok.passed).toBe(true);
    expect(ok.metrics.openingAnchorRetained).toBe(true);
    expect(ok.metrics.endingAnchorRetained).toBe(true);
    expect(ok.minimalInterventionPassed).toBe(true);
  });

  test('lengthExpansionMode treats all Writer paragraphs as targeted', () => {
    const paragraphs = Array.from(
      { length: 8 },
      (_, i) => `扩写前自然段${i}包含足够长度的叙述正文。`,
    );
    const writerText = paragraphs.join('\n');
    // Fully rewrite every paragraph (common deepen-expand pattern) — fails
    // minimal intervention without lengthExpansionMode.
    const expanded = Array.from(
      { length: 8 },
      (_, i) =>
        `深化后段落${i}补充动作过程、人物反应与冲突升级的完整叙述内容。`,
    ).join('\n');
    const withoutFlag = evaluateRepairCompleteness({
      writerText,
      candidateText: expanded,
      targetedSpans: [],
    });
    expect(withoutFlag.minimalInterventionPassed).toBe(false);

    const withFlag = evaluateRepairCompleteness({
      writerText,
      candidateText: expanded,
      targetedSpans: [],
      lengthExpansionMode: true,
    });
    expect(withFlag.minimalInterventionPassed).toBe(true);
    expect(withFlag.metrics.targetedWriterParagraphCount).toBe(
      paragraphs.length,
    );
    // Still retains opening/ending anchors when content is long enough; ratio
    // floors remain independent of the expansion targeting flag.
    expect(withFlag.metrics.writerHan).toBeGreaterThan(0);
  });
});

/**
 * C1 Red/contract tests.
 *
 * The long-horizon report is evidence-only: it must preserve the distinction
 * between a missing observation and a zero, and it must expose every chapter
 * and matrix field required by the Phase III-C plan.
 */
import * as fs from 'fs';
import * as path from 'path';

const collectorPath = path.resolve(
  __dirname,
  '..',
  'scripts',
  'qa',
  'collect-phase3-c-baseline.js',
);

const REQUIRED_CHAPTER_FIELDS = [
  'chapterIndex',
  'generationTraceId',
  'qualityProfile',
  'writerPhysicalCalls',
  'totalPaidLlmCalls',
  'draftTokens',
  'qaTokens',
  'revisionTokens',
  'plannerCalls',
  'observerCalls',
  'storyMemoryCalls',
  'contextInputTokens',
  'finalCharCount',
  'storyMemorySize',
  'dbPayloadSize',
  'finalFingerprint',
  'finalBodyProposalFingerprint',
  'seamFingerprint',
  'canonBoundary',
  'stateProposalCount',
  'retryFallback',
  'latencyMs',
] as const;

function completeChapter(index: number): any {
  return {
    chapterIndex: index,
    generationTraceId: `gt-c1-${index}`,
    qualityProfile: 'quality',
    writerPhysicalCalls: 5,
    totalPaidLlmCalls: 7,
    draftTokens: { input: 100, output: 80, total: 180 },
    qaTokens: { input: 90, output: 30, total: 120 },
    revisionTokens: { input: 110, output: 60, total: 170 },
    plannerCalls: index === 1 ? 1 : 0,
    observerCalls: 0,
    storyMemoryCalls: 1,
    contextInputTokens: 900,
    finalCharCount: 2400,
    storyMemorySize: {
      estimatedTokens: 120,
      payloadBytes: 480,
      throughChapterPosition: index,
    },
    dbPayloadSize: { bytes: 12000 },
    finalFingerprint: 'a'.repeat(64),
    finalBodyProposalFingerprint: 'a'.repeat(64),
    seamFingerprint: 'b'.repeat(64),
    canonBoundary: { status: 'not_applicable' },
    stateProposalCount: 0,
    retryFallback: { retryCount: 0, fallbackCount: 0 },
    latencyMs: 1200,
    status: 'completed',
    evidence: { source: 'device-db', missing: [] },
  };
}

describe('Phase III-C C1 long-horizon baseline contract', () => {
  test('collector exposes the required matrix and chapter evidence contract', () => {
    expect(fs.existsSync(collectorPath)).toBe(true);
    // Deliberately loaded after the existence assertion so the initial Red
    // run reports the missing implementation as the actionable failure.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const collector = require(collectorPath);
    expect(typeof collector.buildLongHorizonBaselineReport).toBe('function');
    expect(typeof collector.validateLongHorizonBaselineReport).toBe('function');

    const report = collector.buildLongHorizonBaselineReport({
      exactHead: '1d42a827',
      project: { id: 9001, name: 'C1 real baseline' },
      database: { path: 'device-db.sqlite', bytes: 12345 },
      batches: [
        {
          id: 'batch-c1',
          projectId: 9001,
          status: 'completed',
          chapterCount: 5,
          completedCount: 5,
          usedLlmCalls: 36,
          usedInputTokens: 5000,
          usedOutputTokens: 2000,
        },
      ],
      chapters: Array.from({ length: 100 }, (_, offset) =>
        completeChapter(offset + 1),
      ),
      targetCounts: [5, 20, 50, 100],
      realLlmEvidence: {
        mode: 'android-existing-config',
        modelName: 'GLM-5.3-Flash',
        proof: ['ui-real-llm-test-result.xml'],
      },
    });

    expect(report.schema).toBe(
      'shinewriter.phase3-c.long-horizon-baseline.v1',
    );
    expect(report.matrix.map((item: any) => item.targetChapterCount)).toEqual([
      5, 20, 50, 100,
    ]);
    expect(report.matrix.every((item: any) => item.status === 'PASS')).toBe(
      true,
    );
    for (const chapter of report.chapters) {
      for (const field of REQUIRED_CHAPTER_FIELDS) {
        expect(Object.prototype.hasOwnProperty.call(chapter, field)).toBe(true);
      }
    }
    expect(collector.validateLongHorizonBaselineReport(report)).toEqual({
      ok: true,
      errors: [],
    });
  });

  test('missing evidence is fail-closed and is not converted to zero', () => {
    expect(fs.existsSync(collectorPath)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const collector = require(collectorPath);
    const chapter = completeChapter(1);
    chapter.writerPhysicalCalls = null;
    chapter.evidence = {
      source: 'device-db',
      missing: ['writerPhysicalCalls:observability_missing'],
    };
    const report = collector.buildLongHorizonBaselineReport({
      exactHead: '1d42a827',
      project: { id: 9001, name: 'C1 real baseline' },
      database: { path: 'device-db.sqlite', bytes: 12345 },
      batches: [],
      chapters: [chapter],
      targetCounts: [5, 20, 50, 100],
      realLlmEvidence: {
        mode: 'android-existing-config',
        modelName: 'GLM-5.3-Flash',
        proof: ['ui-real-llm-test-result.xml'],
      },
    });
    expect(report.chapters[0].writerPhysicalCalls).toBeNull();
    expect(report.matrix[0].status).toBe('NO-GO');
    expect(collector.validateLongHorizonBaselineReport(report).ok).toBe(false);
  });
});

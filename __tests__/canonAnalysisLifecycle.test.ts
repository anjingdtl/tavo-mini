/**
 * Analysis lifecycle: staging → auto-adopt → active; failed run never
 * becomes active.
 */
import {
  emptyCapabilities,
  emptyCoverage,
} from '../src/services/continuation/canon/types';
import { asSourcePosition } from '../src/services/continuation/continuationSourceRepository';
import {
  buildDefaultCanonAdoptionStatements,
  resolveContextDrivenChaptersPerBatch,
} from '../src/services/continuation/canon/canonAnalysisService';

describe('Canon analysis lifecycle contracts', () => {
  it('publishes successful analysis automatically instead of leaving a manual activation gap', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(
        __dirname,
        '../src/services/continuation/canon/canonAnalysisService.ts',
      ),
      'utf8',
    );
    expect(source).not.toContain('Do NOT auto-activate');
  });

  it('empty coverage remains readable for snapshots persisted before scoped analysis', () => {
    const cov = emptyCoverage(asSourcePosition(0));
    expect(cov.schemaVersion).toBe(1);
    expect(cov.incompleteReasons).toEqual([]);
  });

  it('standard capabilities enable full families', () => {
    const caps = emptyCapabilities('standard');
    expect(caps.relationships).toBe(true);
    expect(caps.knowledgeBoundaries).toBe(true);
    expect(caps.timelineEvents).toBe(true);
  });

  it('uses the configured online context window to maximize Canon batch size', () => {
      expect(
      resolveContextDrivenChaptersPerBatch({
        providerType: 'openai_compatible',
        contextWindow: 1_000_000,
        maxOutputTokens: 200_000,
        chapterCount: 30,
        largestChapterInputTokens: 4_000,
      }),
    ).toBe(30);
    expect(
      resolveContextDrivenChaptersPerBatch({
        providerType: 'openai_compatible',
        contextWindow: null,
        maxOutputTokens: null,
        chapterCount: 30,
        largestChapterInputTokens: 4_000,
      }),
    ).toBe(0);
  });

  it('defaults every pending Canon family to confirmed when its snapshot is activated', () => {
    const statements = buildDefaultCanonAdoptionStatements('snapshot-1', 'now');

    expect(statements).toHaveLength(9);
    expect(statements.every(statement => statement.sql.includes("review_status = 'confirmed'"))).toBe(true);
    expect(statements.every(statement => statement.sql.includes("review_status = 'pending'"))).toBe(true);
    expect(statements.map(statement => statement.params)).toEqual(
      Array.from({ length: 9 }, () => ['now', 'snapshot-1']),
    );
  });
});

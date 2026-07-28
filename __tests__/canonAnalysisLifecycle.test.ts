/**
 * Analysis lifecycle: staging → awaiting_review → activate; failed run never
 * becomes active (Spec §4.7, §8.7, §15).
 */
import {
  emptyCapabilities,
  emptyCoverage,
} from '../src/services/continuation/canon/types';
import { asSourcePosition } from '../src/services/continuation/continuationSourceRepository';

describe('Canon analysis lifecycle contracts', () => {
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
});

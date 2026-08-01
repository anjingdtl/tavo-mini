/**
 * IMP-006 regression: parse-complete Alert "取消" leaves job in awaiting_review;
 * cold start must not rewrite that to interrupted, and UI must detect both.
 */
import { isAwaitingReviewJob } from '../src/services/continuation/continuationImportService';

describe('isAwaitingReviewJob (IMP-006)', () => {
  it('detects true awaiting_review state', () => {
    expect(
      isAwaitingReviewJob({ state: 'awaiting_review', stage: 'awaiting_review' }),
    ).toBe(true);
  });

  it('detects legacy cold-start mis-mark (interrupted + stage awaiting_review)', () => {
    expect(
      isAwaitingReviewJob({ state: 'interrupted', stage: 'awaiting_review' }),
    ).toBe(true);
  });

  it('does not treat mid-pipeline interrupt as awaiting review', () => {
    expect(isAwaitingReviewJob({ state: 'interrupted', stage: 'decoding' })).toBe(
      false,
    );
  });

  it('does not treat completed jobs', () => {
    expect(isAwaitingReviewJob({ state: 'completed', stage: 'activating' })).toBe(
      false,
    );
  });
});

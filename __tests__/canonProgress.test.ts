/**
 * Overall Canon progress must include post-extraction stages so extraction
 * 2/2 never paints as 100% while style validation is still running.
 */
import {
  CANON_POST_EXTRACTION_STEP_COUNT,
  computeCanonOverallProgress,
  computeCanonProgressCurrent,
  computeCanonProgressTotal,
  completedPostExtractionSteps,
} from '../src/services/continuation/canon/canonProgress';

describe('canon overall progress', () => {
  it('adds fixed post-extraction steps to work-item total', () => {
    expect(computeCanonProgressTotal(2)).toBe(2 + CANON_POST_EXTRACTION_STEP_COUNT);
    expect(computeCanonProgressTotal(0)).toBe(CANON_POST_EXTRACTION_STEP_COUNT);
  });

  it('stays in extraction band until every work item is complete', () => {
    expect(
      computeCanonProgressCurrent({
        completedWorkItems: 1,
        workItemCount: 2,
        stage: 'chapter_extraction',
        state: 'running',
      }),
    ).toBe(1);
    // Even if stage advances early, incomplete work items pin progress.
    expect(
      computeCanonProgressCurrent({
        completedWorkItems: 1,
        workItemCount: 2,
        stage: 'style_analysis',
        state: 'running',
      }),
    ).toBe(1);
  });

  it('does not report 100% when extraction is done but style still runs', () => {
    const extractionDone = computeCanonOverallProgress({
      completedWorkItems: 2,
      workItemCount: 2,
      stage: 'chapter_extraction',
      state: 'running',
    });
    // Extraction finished but no post step completed yet → still not 100%.
    expect(extractionDone.current).toBe(2);
    expect(extractionDone.total).toBe(2 + CANON_POST_EXTRACTION_STEP_COUNT);
    expect(extractionDone.percent).toBeLessThan(100);

    const styleRunning = computeCanonOverallProgress({
      completedWorkItems: 2,
      workItemCount: 2,
      stage: 'style_analysis',
      state: 'running',
    });
    expect(styleRunning.current).toBe(2 + 2); // evidence + finalizing done
    expect(styleRunning.percent).toBeLessThan(100);

    const styleValidating = computeCanonOverallProgress({
      completedWorkItems: 2,
      workItemCount: 2,
      stage: 'style_validation',
      state: 'running',
    });
    expect(styleValidating.current).toBe(2 + 3);
    expect(styleValidating.percent).toBeLessThan(100);

    const completed = computeCanonOverallProgress({
      completedWorkItems: 2,
      workItemCount: 2,
      stage: 'style_validation',
      state: 'completed',
    });
    expect(completed.current).toBe(completed.total);
    expect(completed.percent).toBe(100);
  });

  it('maps stages to completed post steps without counting the in-flight unit', () => {
    expect(
      completedPostExtractionSteps({
        stage: 'evidence_validation',
        state: 'running',
      }),
    ).toBe(0);
    expect(
      completedPostExtractionSteps({ stage: 'finalizing', state: 'running' }),
    ).toBe(1);
    expect(
      completedPostExtractionSteps({
        stage: 'style_analysis',
        state: 'running',
      }),
    ).toBe(2);
    expect(
      completedPostExtractionSteps({
        stage: 'style_validation',
        state: 'running',
      }),
    ).toBe(3);
  });
});

import {
  summarizePhase4ContinuousRun,
  type ContinuousChapterRunEvidence,
} from '../src/services/writing/metrics/phase4ContinuousHarness';

const chapter = (
  chapterNo: number,
  overrides: Partial<ContinuousChapterRunEvidence> = {},
): ContinuousChapterRunEvidence => ({
  chapterNo,
  firstPass: true,
  physicalCalls: 2,
  governorPhysicalCalls: 0,
  contextTokenCount: 12000,
  contextBudgetTokenCount: 100000,
  resumed: true,
  duplicateCalls: 0,
  dbIntegrity: 'ok',
  crashCount: 0,
  anrCount: 0,
  ...overrides,
});

const chapters = (count: number): ContinuousChapterRunEvidence[] =>
  Array.from({ length: count }, (_, index) => chapter(index + 1));

describe('Phase IV continuous 5/10 chapter harness', () => {
  it('holds when the deterministic run has no real Android LLM sample', () => {
    const result = summarizePhase4ContinuousRun({
      chapters: chapters(5),
      expectedChapterCount: 5,
      realAndroidLlm: false,
    });

    expect(result.status).toBe('hold');
    expect(result.firstPassRate).toBe(1);
    expect(result.firstPassDenominator).toBe(5);
    expect(result.reasons).toContain('real_android_llm_sample_missing');
  });

  it('passes a complete safe real 10-chapter run', () => {
    const result = summarizePhase4ContinuousRun({
      chapters: chapters(10),
      expectedChapterCount: 10,
      realAndroidLlm: true,
    });

    expect(result.status).toBe('pass');
    expect(result.chapterCount).toBe(10);
    expect(result.firstPassCount).toBe(10);
    expect(result.firstPassRate).toBe(1);
    expect(result.totalPhysicalCalls).toBe(20);
    expect(result.governorPhysicalCalls).toBe(0);
    expect(result.duplicateCalls).toBe(0);
    expect(result.resumePass).toBe(true);
    expect(result.dbIntegrity).toBe('ok');
    expect(result.contextWithinBudget).toBe(true);
  });

  it('rejects any Governor physical call', () => {
    const result = summarizePhase4ContinuousRun({
      chapters: chapters(5).map((item, index) =>
        index === 2 ? { ...item, governorPhysicalCalls: 1 } : item,
      ),
      expectedChapterCount: 5,
      realAndroidLlm: true,
    });

    expect(result.status).toBe('no-go');
    expect(result.reasons).toContain('governor_physical_call_detected');
  });

  it('rejects Context overflow before treating the run as adoptable', () => {
    const result = summarizePhase4ContinuousRun({
      chapters: chapters(5).map((item, index) =>
        index === 4
          ? { ...item, contextTokenCount: item.contextBudgetTokenCount + 1 }
          : item,
      ),
      expectedChapterCount: 5,
      realAndroidLlm: true,
    });

    expect(result.status).toBe('no-go');
    expect(result.contextWithinBudget).toBe(false);
    expect(result.reasons).toContain('context_budget_exceeded');
  });

  it('fails closed when the requested continuous-run size is incomplete', () => {
    const result = summarizePhase4ContinuousRun({
      chapters: chapters(5),
      expectedChapterCount: 10,
      realAndroidLlm: true,
    });

    expect(result.status).toBe('no-go');
    expect(result.reasons).toContain('chapter_count_mismatch');
  });
});

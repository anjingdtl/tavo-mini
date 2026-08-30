export type ContinuousRunStatus = 'pass' | 'hold' | 'no-go';

export interface ContinuousChapterRunEvidence {
  chapterNo: number;
  firstPass: boolean;
  physicalCalls: number;
  governorPhysicalCalls: number;
  contextTokenCount: number;
  contextBudgetTokenCount: number;
  resumed: boolean;
  duplicateCalls: number;
  dbIntegrity: 'ok' | 'failed';
  crashCount: number;
  anrCount: number;
}

export interface ContinuousRunSummary {
  expectedChapterCount: number;
  chapterCount: number;
  firstPassCount: number;
  firstPassDenominator: number;
  firstPassRate: number;
  totalPhysicalCalls: number;
  governorPhysicalCalls: number;
  duplicateCalls: number;
  maxContextTokenCount: number;
  contextWithinBudget: boolean;
  resumePass: boolean;
  dbIntegrity: 'ok' | 'failed';
  crashCount: number;
  anrCount: number;
  status: ContinuousRunStatus;
  reasons: string[];
}

const isNonNegativeInteger = (value: number): boolean =>
  Number.isInteger(value) && value >= 0;

const addReason = (reasons: Set<string>, reason: string): void => {
  reasons.add(reason);
};

export const summarizePhase4ContinuousRun = (input: {
  chapters: readonly ContinuousChapterRunEvidence[];
  expectedChapterCount: number;
  realAndroidLlm: boolean;
}): ContinuousRunSummary => {
  const chapters = input.chapters;
  const reasons = new Set<string>();
  const chapterCount = chapters.length;
  const firstPassCount = chapters.filter((item) => item.firstPass).length;
  const firstPassDenominator = chapterCount;
  const firstPassRate = firstPassDenominator > 0 ? firstPassCount / firstPassDenominator : 0;
  const totalPhysicalCalls = chapters.reduce(
    (total, item) => total + (isNonNegativeInteger(item.physicalCalls) ? item.physicalCalls : 0),
    0,
  );
  const governorPhysicalCalls = chapters.reduce(
    (total, item) =>
      total + (isNonNegativeInteger(item.governorPhysicalCalls) ? item.governorPhysicalCalls : 0),
    0,
  );
  const duplicateCalls = chapters.reduce(
    (total, item) => total + (isNonNegativeInteger(item.duplicateCalls) ? item.duplicateCalls : 0),
    0,
  );
  const maxContextTokenCount = chapters.reduce(
    (maximum, item) =>
      Math.max(maximum, Number.isFinite(item.contextTokenCount) ? item.contextTokenCount : 0),
    0,
  );
  const contextWithinBudget = chapters.every(
    (item) =>
      isNonNegativeInteger(item.contextTokenCount) &&
      isNonNegativeInteger(item.contextBudgetTokenCount) &&
      item.contextTokenCount <= item.contextBudgetTokenCount,
  );
  const resumePass = chapters.every((item) => item.resumed === true);
  const dbIntegrity = chapters.every((item) => item.dbIntegrity === 'ok') ? 'ok' : 'failed';
  const crashCount = chapters.reduce(
    (total, item) => total + (isNonNegativeInteger(item.crashCount) ? item.crashCount : 0),
    0,
  );
  const anrCount = chapters.reduce(
    (total, item) => total + (isNonNegativeInteger(item.anrCount) ? item.anrCount : 0),
    0,
  );

  if (!isNonNegativeInteger(input.expectedChapterCount) || input.expectedChapterCount === 0) {
    addReason(reasons, 'invalid_expected_chapter_count');
  } else if (chapterCount !== input.expectedChapterCount) {
    addReason(reasons, 'chapter_count_mismatch');
  }

  const chapterNumbers = chapters.map((item) => item.chapterNo);
  const hasUniqueChapterNumbers = new Set(chapterNumbers).size === chapterNumbers.length;
  const hasValidChapterNumbers = chapters.every(
    (item) => Number.isInteger(item.chapterNo) && item.chapterNo > 0,
  );
  if (!hasUniqueChapterNumbers || !hasValidChapterNumbers) {
    addReason(reasons, 'chapter_identity_invalid');
  }

  if (
    chapters.some(
      (item) =>
        !isNonNegativeInteger(item.physicalCalls) || item.physicalCalls === 0,
    )
  ) {
    addReason(reasons, 'physical_call_missing_or_invalid');
  }
  if (
    chapters.some(
      (item) =>
        !isNonNegativeInteger(item.governorPhysicalCalls) || item.governorPhysicalCalls > 0,
    )
  ) {
    addReason(reasons, 'governor_physical_call_detected');
  }
  if (
    chapters.some(
      (item) => !isNonNegativeInteger(item.duplicateCalls) || item.duplicateCalls > 0,
    )
  ) {
    addReason(reasons, 'duplicate_call_detected');
  }
  if (!contextWithinBudget) {
    addReason(reasons, 'context_budget_exceeded');
  }
  if (!resumePass) {
    addReason(reasons, 'resume_idempotency_failed');
  }
  if (dbIntegrity !== 'ok') {
    addReason(reasons, 'db_integrity_failed');
  }
  if (crashCount > 0) {
    addReason(reasons, 'crash_detected');
  }
  if (anrCount > 0) {
    addReason(reasons, 'anr_detected');
  }
  if (firstPassCount !== input.expectedChapterCount) {
    addReason(reasons, 'first_pass_not_complete');
  }
  if (input.realAndroidLlm !== true) {
    addReason(reasons, 'real_android_llm_sample_missing');
  }

  const onlyMissingRealSample =
    reasons.size === 1 && reasons.has('real_android_llm_sample_missing');
  const status: ContinuousRunStatus =
    onlyMissingRealSample ? 'hold' : reasons.size === 0 ? 'pass' : 'no-go';

  return {
    expectedChapterCount: input.expectedChapterCount,
    chapterCount,
    firstPassCount,
    firstPassDenominator,
    firstPassRate,
    totalPhysicalCalls,
    governorPhysicalCalls,
    duplicateCalls,
    maxContextTokenCount,
    contextWithinBudget,
    resumePass,
    dbIntegrity,
    crashCount,
    anrCount,
    status,
    reasons: [...reasons],
  };
};

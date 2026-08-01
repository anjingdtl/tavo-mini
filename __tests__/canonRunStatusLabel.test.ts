/**
 * S2 fix (spec §2): the overview screen used to read only work-item state and
 * permanently showed "正在汇总结果" once a run reached awaiting_review. The
 * label is now derived from run.state × run.stage via a pure function.
 */
import {
  runActivityDetail,
  runStatusLabel,
} from '../src/screens/continuation/canon/runStatusLabel';
import type { AnalysisRun, AnalysisWorkItem } from '../src/services/continuation/canon';

function makeRun(
  state: AnalysisRun['state'],
  stage: AnalysisRun['stage'] = 'finalizing',
): AnalysisRun {
  return {
    id: 'run-1',
    projectId: 1,
    sourceId: 1,
    sourceVersion: 1,
    sourceSha256: 'hash',
    parserVersion: 'p',
    normalizationVersion: 'n',
    boundaryChapterId: 1,
    boundaryPosition: 0 as never,
    boundaryCharOffsetExclusive: 0 as never,
    canonSnapshotId: 'snap',
    profile: 'standard',
    modelConfigId: 1,
    state,
    stage,
    progressCurrent: 0,
    progressTotal: 4,
    extractionVersion: 'v1',
    checkpointJson: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '',
    updatedAt: '',
    completedAt: null,
  };
}

const allCompleted: AnalysisWorkItem[] = [
  {
    runId: 'run-1',
    batchIndex: 0,
    materialType: 'character_state',
    state: 'completed',
    attemptCount: 1,
    resultJson: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '',
    updatedAt: '',
    completedAt: '',
  },
];

describe('runStatusLabel (S2 fix)', () => {
  it('returns 排队等待中 for queued', () => {
    expect(runStatusLabel(makeRun('queued'), allCompleted)).toBe('排队等待中');
  });

  it('returns 正在处理 Canon 请求组 for running + chapter_extraction', () => {
    expect(
      runStatusLabel(makeRun('running', 'chapter_extraction'), allCompleted),
    ).toBe('正在处理 Canon 请求组');
  });

  it('returns 正在校验原文证据 for running + evidence_validation', () => {
    expect(
      runStatusLabel(makeRun('running', 'evidence_validation'), allCompleted),
    ).toBe('正在校验原文证据');
  });

  it('returns 正在分析原著写作风格 for running + style_analysis', () => {
    expect(
      runStatusLabel(makeRun('running', 'style_analysis'), allCompleted),
    ).toBe('正在分析原著写作风格');
  });

  it('returns 正在校验风格画像 for running + style_validation', () => {
    expect(
      runStatusLabel(makeRun('running', 'style_validation'), allCompleted),
    ).toBe('正在校验风格画像');
  });

  it('returns 正在汇总结果 for running + finalizing', () => {
    expect(
      runStatusLabel(makeRun('running', 'finalizing'), allCompleted),
    ).toBe('正在汇总结果');
  });

  it('makes finalizing activity observable even when work-item progress is 100%', () => {
    const run = makeRun('running', 'finalizing');
    run.updatedAt = '2026-08-01T10:00:00.000Z';
    expect(runActivityDetail(run, Date.parse('2026-08-01T10:00:03.000Z'))).toContain(
      '模型请求已完成',
    );
    expect(runActivityDetail(run, Date.parse('2026-08-01T10:00:03.000Z'))).toContain(
      '最近活动：刚刚',
    );
  });


  it('returns a same-page activation prompt for awaiting_review', () => {
    expect(
      runStatusLabel(makeRun('awaiting_review'), allCompleted),
    ).toBe('分析完成，可在此审核并激活');
  });

  it('returns 已暂停，可继续 for paused', () => {
    expect(runStatusLabel(makeRun('paused'), allCompleted)).toBe('已暂停，可继续');
  });

  it('returns 分析失败 for failed', () => {
    expect(runStatusLabel(makeRun('failed'), allCompleted)).toBe('分析失败');
  });

  it('returns 已取消，可从断点继续 for cancelled', () => {
    expect(runStatusLabel(makeRun('cancelled'), allCompleted)).toBe(
      '已取消，可从断点继续',
    );
  });

  it('falls back to 正在汇总结果 when running stage is not a known canon stage', () => {
    // Stages like snapshot/entity_resolution/indexing are not user-facing
    // progress stages; default to the most accurate neutral label.
    expect(
      runStatusLabel(makeRun('running', 'snapshot'), allCompleted),
    ).toBe('正在汇总结果');
  });
});

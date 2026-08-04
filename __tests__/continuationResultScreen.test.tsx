import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      colors: {
        accent: '#439EA6',
        danger: '#C94F45',
        textPrimary: '#1D2B28',
        textSecondary: '#52615D',
        textMuted: '#72807C',
        card: '#FFFFFF',
        border: '#D7F1F4',
      },
    },
  }),
}));

jest.mock('../src/services/continuation/generation', () => ({
  abandonRun: jest.fn(async () => undefined),
  adoptArtifactAsDraft: jest.fn(async () => ({ contentHash: 'hash' })),
  confirmPlanAndContinue: jest.fn(),
  getArtifactForRun: jest.fn(async () => null),
  getLatestArtifact: jest.fn(async () => ({ id: 'artifact-1', content: '续写正文' })),
  getLatestArtifactForStage: jest.fn(async () => null),
  getLatestEligibleArtifact: jest.fn(async () => ({ id: 'artifact-1', stage: 'writer', content: '续写正文' })),
  getPlan: jest.fn(async () => null),
  getRunById: jest.fn(async () => ({
    id: 'run-1',
    state: 'awaiting_user',
    stage: 'awaiting_user',
    workflowVersion: 2,
    canonSnapshotId: 'snapshot-1234567890',
    canonRevision: 1,
    contextTraceJson: null,
    tokenUsageJson: JSON.stringify({
      workflowVersion: 2,
      stages: { repair: { requestCount: 1 } },
    }),
  })),
  listChecksForArtifact: jest.fn(async () => [] as any[]),
  listStageResults: jest.fn(async () => [] as any[]),
  repairContinuationArtifactOnce: jest.fn(async () => undefined),
  resumeInterruptedRun: jest.fn(),
  summarizeTrace: jest.fn(),
}));

import { ContinuationResultScreen } from '../src/screens/continuation/ContinuationResultScreen';
import {
  adoptArtifactAsDraft,
  getArtifactForRun,
  getLatestArtifact,
  getLatestArtifactForStage,
  getLatestEligibleArtifact,
  getRunById,
  listChecksForArtifact,
  listStageResults,
  repairContinuationArtifactOnce,
} from '../src/services/continuation/generation';

const mockListChecksForArtifact = listChecksForArtifact as jest.Mock;
const mockGetLatestArtifact = getLatestArtifact as jest.Mock;
const mockGetArtifactForRun = getArtifactForRun as jest.Mock;
const mockGetLatestArtifactForStage = getLatestArtifactForStage as jest.Mock;
const mockGetLatestEligibleArtifact = getLatestEligibleArtifact as jest.Mock;
const mockGetRunById = getRunById as jest.Mock;
const mockAdoptArtifactAsDraft = adoptArtifactAsDraft as jest.Mock;
const mockRepairContinuationArtifactOnce = repairContinuationArtifactOnce as jest.Mock;
const mockListStageResults = listStageResults as jest.Mock;

describe('ContinuationResultScreen adoption decision', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRunById.mockResolvedValue({
      id: 'run-1',
      state: 'awaiting_user',
      stage: 'awaiting_user',
      workflowVersion: 2,
      canonSnapshotId: 'snapshot-1234567890',
      canonRevision: 1,
      contextTraceJson: null,
      tokenUsageJson: JSON.stringify({
        workflowVersion: 2,
        stages: { repair: { requestCount: 1 } },
      }),
    });
    mockGetLatestArtifact.mockResolvedValue({ id: 'artifact-1', content: '续写正文' });
    mockGetLatestEligibleArtifact.mockResolvedValue({ id: 'artifact-1', stage: 'writer', content: '续写正文' });
    mockGetArtifactForRun.mockResolvedValue(null);
    mockListChecksForArtifact.mockResolvedValue([]);
    mockListStageResults.mockResolvedValue([]);
  });

  it('makes an automatic repair explicit and states that adoption uses the repaired artifact', async () => {
    mockGetLatestArtifact.mockResolvedValue({
      id: 'artifact-2',
      stage: 'repair',
      repairRound: 1,
      content: '修复后的正文',
    });
    const { getByText, queryByText } = render(
      <ContinuationResultScreen runId="run-1" onClose={jest.fn()} />,
    );

    await waitFor(() => expect(getByText('一致性修复 · 成功 (1 轮)')).toBeTruthy());
    expect(getByText(/已自动修复 1 轮/)).toBeTruthy();
    expect(queryByText('采纳将写入此版本。')).toBeNull();
    fireEvent.press(getByText('一致性修复 · 成功 (1 轮)'));
    expect(getByText('已根据 blocking / error 检查项生成修复版候选正文；已完成本地复核，未进行第二次 LLM 复检；采纳将写入此版本。')).toBeTruthy();
  });

  it('uses the same collapsed stage cards and discard-then-adopt controls as the pipeline result', async () => {
    const onClose = jest.fn();
    const { getAllByRole, getByText, queryByText } = render(
      <ContinuationResultScreen runId="run-1" onClose={onClose} />,
    );

    await waitFor(() => expect(getByText('正文 · 成功 (4 字)')).toBeTruthy());
    expect(queryByText('续写正文')).toBeNull();
    expect(queryByText('调用与预算遥测')).toBeNull();
    fireEvent.press(getByText('正文 · 成功 (4 字)'));
    expect(getByText('续写正文')).toBeTruthy();
    await waitFor(() => expect(getByText('采纳')).toBeTruthy());
    expect(getByText('放弃')).toBeTruthy();
    expect(queryByText('采纳为草稿')).toBeNull();
    const labels = getAllByRole('button').map(button => button.props.accessibilityLabel);
    expect(labels).not.toContain('采纳为草稿');
  });

  it('offers explicit risk adoption or one additional Repair after a local overlap failure', async () => {
    mockGetLatestArtifact.mockResolvedValue({
      id: 'artifact-2',
      stage: 'repair',
      repairRound: 1,
      content: '接缝重复候选',
    });
    mockListChecksForArtifact.mockResolvedValue([
      {
        id: 1,
        severity: 'error',
        category: 'style',
        subtype: 'source_overlap',
        resolutionStatus: 'open',
        description: '与原著接缝存在大段重合',
        evidenceIds: [],
      },
    ] as any);
    const { getByText, queryByText } = render(
      <ContinuationResultScreen runId="run-1" onClose={jest.fn()} />,
    );

    await waitFor(() => expect(getByText('本地复核仍有待处理问题')).toBeTruthy());
    expect(getByText('放弃并返回')).toBeTruthy();
    expect(getByText('采纳错误候选（风险自负）')).toBeTruthy();
    expect(getByText('额外修正一次（增加 1 次 LLM）')).toBeTruthy();
    expect(getByText(/本地确定性命中（连续原文）/)).toBeTruthy();
    expect(queryByText('无证据(推测)')).toBeNull();
    expect(queryByText('接缝重复候选')).toBeNull();
    expect(queryByText('重新生成')).toBeNull();

    fireEvent.press(getByText('额外修正一次（增加 1 次 LLM）'));
    await waitFor(() => expect(mockRepairContinuationArtifactOnce).toHaveBeenCalledWith('run-1'));

    fireEvent.press(getByText('采纳错误候选（风险自负）'));
    await waitFor(() =>
      expect(mockAdoptArtifactAsDraft).toHaveBeenCalledWith({
        runId: 'run-1',
        forceOverwrite: undefined,
        allowOpenChecks: true,
      }),
    );
  });

  it('shows a rejected V4 Repair candidate for read-only audit without making it adoptable', async () => {
    mockGetRunById.mockResolvedValue({
      id: 'run-1',
      state: 'awaiting_user',
      stage: 'awaiting_user',
      workflowVersion: 4,
      canonSnapshotId: 'snapshot-1234567890',
      canonRevision: 1,
      contextTraceJson: null,
      tokenUsageJson: JSON.stringify({ workflowVersion: 4, stages: {} }),
    });
    mockGetLatestEligibleArtifact.mockResolvedValue({
      id: 'writer-1',
      stage: 'writer',
      content: 'Writer 可采纳正文',
    });
    mockGetArtifactForRun.mockResolvedValue({
      id: 'repair-1',
      stage: 'repair',
      eligibilityStatus: 'rejected',
      rejectionCode: 'local_final_gate_failed',
      content: 'Repair 候选正文',
    });
    const stage = (input: Record<string, unknown>) => ({
      requestCount: 1,
      inputTokens: 10,
      outputTokens: 10,
      startedAt: null,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      artifactId: null,
      outputJson: null,
      ...input,
    });
    mockListStageResults.mockResolvedValue([
      stage({ stage: 'writer', status: 'success', artifactId: 'writer-1' }),
      stage({ stage: 'checker', status: 'success', artifactId: 'writer-1' }),
      stage({ stage: 'control', status: 'success', artifactId: 'writer-1' }),
      stage({
        stage: 'repair',
        status: 'success',
        artifactId: 'repair-1',
        outputJson: JSON.stringify({
          appliedCheckerIssueIds: [],
          appliedControlSuggestionIds: [],
          failureDiagnostics: {
            currentCandidateSource: 'Writer',
            repairStatus: { attempted: true, returned: true, rejected: true },
            primaryRejectionCode: 'repair_control_finding_unapplied',
            unappliedIssueDetails: [
              {
                source: 'style_control',
                id: 'style_1',
                subtype: 'padding',
                description: '注水句未改写',
                generatedExcerpt: '模板化原句',
              },
            ],
            complianceFailures: [
              {
                subtype: 'repair_control_finding_unapplied',
                severity: 'blocking',
                description: '未回填 Control finding',
              },
            ],
          },
        }),
      }),
      stage({
        stage: 'local_verify',
        status: 'failed',
        outputJson: JSON.stringify({
          passed: false,
          checkSubtypes: ['repair_control_finding_unapplied'],
          currentCandidateSource: 'Writer',
        }),
      }),
    ]);

    const { getAllByText, getByText, queryByText } = render(
      <ContinuationResultScreen runId="run-1" onClose={jest.fn()} />,
    );

    await waitFor(() => expect(getByText('Repair 被本地门禁拒绝')).toBeTruthy());
    expect(getByText('查看被拒 Repair 候选')).toBeTruthy();
    expect(getByText('采纳当前 eligible 候选（风险自负）')).toBeTruthy();
    expect(queryByText('Repair 候选正文')).toBeNull();
    fireEvent.press(getByText(/Repair · 成功/));
    expect(
      getAllByText(/Repair 已返回候选正文，但未通过完整性、协议或安全检查。当前展示和默认可采纳的是 Writer 初稿。被拒 Repair 仅供审计。/).length,
    ).toBeGreaterThan(0);
    expect(getByText(/style_1（style_control\/padding）/)).toBeTruthy();
    expect(getByText(/repair_control_finding_unapplied \[blocking\]/)).toBeTruthy();
    fireEvent.press(getByText('查看被拒 Repair 候选'));
    expect(getByText('Repair 候选正文')).toBeTruthy();
  });

  it('does not block adoption for a V4 chapter length warning', async () => {
    mockGetRunById.mockResolvedValue({
      id: 'run-1',
      state: 'awaiting_user',
      stage: 'awaiting_user',
      workflowVersion: 4,
      canonSnapshotId: 'snapshot-1234567890',
      canonRevision: 1,
      contextTraceJson: null,
      tokenUsageJson: JSON.stringify({ workflowVersion: 4, stages: {} }),
    });
    mockGetLatestEligibleArtifact.mockResolvedValue({
      id: 'writer-1',
      stage: 'writer',
      content: 'Writer 正文',
    });
    mockListChecksForArtifact.mockResolvedValue([
      {
        id: 1,
        severity: 'error',
        category: 'style',
        subtype: 'chapter_length_under_target',
        resolutionStatus: 'open',
        description: '篇幅偏短',
        evidenceIds: [],
      },
    ] as any);
    const stage = (input: Record<string, unknown>) => ({
      requestCount: 0,
      inputTokens: null,
      outputTokens: null,
      startedAt: null,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      artifactId: 'writer-1',
      outputJson: null,
      ...input,
    });
    mockListStageResults.mockResolvedValue([
      stage({ stage: 'writer', status: 'success' }),
      stage({
        stage: 'checker',
        status: 'success',
        outputJson: JSON.stringify({ issues: [] }),
      }),
      stage({
        stage: 'control',
        status: 'success',
        outputJson: JSON.stringify({
          currentHan: 10,
          targetHan: 3000,
          styleIssues: [],
          styleWarnings: [],
        }),
      }),
      stage({ stage: 'repair', status: 'skipped', errorCode: 'skipped_no_actionable_revision' }),
      stage({
        stage: 'local_verify',
        status: 'success',
        outputJson: JSON.stringify({
          passed: true,
          checkSubtypes: [
            'chapter_length_under_target',
            'repair_length_expansion_below_floor',
          ],
        }),
      }),
    ]);
    const { getByText, queryByText } = render(
      <ContinuationResultScreen runId="run-1" onClose={jest.fn()} />,
    );
    await waitFor(() => expect(getByText('V4 终稿已待采纳')).toBeTruthy());
    expect(queryByText('默认候选仍有待人工确认问题')).toBeNull();
    fireEvent.press(getByText(/Control · 成功/));
    expect(getByText(/篇幅偏差仅供参考，未因此触发自动 Repair。/)).toBeTruthy();
  });

  it('shows V5 V1/V2/V3 row titles with tokens and Han count, without bodies', async () => {
    mockGetRunById.mockResolvedValue({
      id: 'run-v5',
      state: 'awaiting_user',
      stage: 'awaiting_user',
      workflowVersion: 5,
      canonSnapshotId: 'snapshot-1234567890',
      canonRevision: 1,
      contextTraceJson: null,
      settingsSnapshotJson: JSON.stringify({
        values: { targetChapterChars: 3000 },
      }),
      tokenUsageJson: JSON.stringify({
        workflowVersion: 5,
        physicalRequestCount: 5,
      }),
    });
    const draftBody = '初稿正文若干汉字在此展示。';
    const revisionBody = '修订稿正文比初稿更长一些的汉字内容。';
    const finalBody = '最终稿正文用于采纳的完整汉字内容在此。';
    mockGetLatestEligibleArtifact.mockResolvedValue({
      id: 'final-1',
      stage: 'final',
      content: finalBody,
      eligibilityStatus: 'eligible',
    });
    mockGetLatestArtifactForStage.mockImplementation(async (_runId, stage) => {
      if (stage === 'draft') {
        return { id: 'draft-1', stage: 'draft', content: draftBody };
      }
      if (stage === 'revision_1') {
        return { id: 'rev-1', stage: 'revision_1', content: revisionBody };
      }
      if (stage === 'final') {
        return {
          id: 'final-1',
          stage: 'final',
          content: finalBody,
          eligibilityStatus: 'eligible',
        };
      }
      return null;
    });
    mockListStageResults.mockResolvedValue([
      {
        stage: 'draft_writer',
        status: 'success',
        requestCount: 1,
        inputTokens: 100,
        outputTokens: 200,
        outputJson: null,
        errorCode: null,
        errorMessage: null,
      },
      {
        stage: 'revision_writer',
        status: 'success',
        requestCount: 1,
        inputTokens: 300,
        outputTokens: 400,
        outputJson: null,
        errorCode: null,
        errorMessage: null,
      },
      {
        stage: 'final_reviser',
        status: 'success',
        requestCount: 1,
        inputTokens: 500,
        outputTokens: 600,
        outputJson: null,
        errorCode: null,
        errorMessage: null,
      },
    ] as any);

    const { getByText, queryByText } = render(
      <ContinuationResultScreen runId="run-v5" onClose={jest.fn()} />,
    );

    await waitFor(() =>
      expect(getByText(/V1 · 生成 Tokens 200 · 汉字/)).toBeTruthy(),
    );
    expect(getByText(/V2 · 生成 Tokens 400 · 汉字/)).toBeTruthy();
    expect(getByText(/V3 · 生成 Tokens 600 · 汉字/)).toBeTruthy();
    // Bodies are intentionally not shown on the result screen — they add no
    // value for the user and rendering 3000+ chars x3 caused scroll jank.
    expect(queryByText(draftBody)).toBeNull();
    expect(queryByText(revisionBody)).toBeNull();
    expect(queryByText(finalBody)).toBeNull();
    // No old multi-stage audit rows
    expect(queryByText(/Narrative Architect/)).toBeNull();
    expect(queryByText(/Adversarial Auditor/)).toBeNull();
    expect(queryByText(/Final Artifact Validator/)).toBeNull();
    // Adoption controls remain available
    expect(getByText('采纳')).toBeTruthy();
    expect(getByText('放弃')).toBeTruthy();
  });
});

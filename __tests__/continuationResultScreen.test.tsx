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
  getLatestArtifact: jest.fn(async () => ({ id: 'artifact-1', content: '续写正文' })),
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
  repairContinuationArtifactOnce: jest.fn(async () => undefined),
  resumeInterruptedRun: jest.fn(),
  summarizeTrace: jest.fn(),
}));

import { ContinuationResultScreen } from '../src/screens/continuation/ContinuationResultScreen';
import {
  adoptArtifactAsDraft,
  getLatestArtifact,
  listChecksForArtifact,
  repairContinuationArtifactOnce,
} from '../src/services/continuation/generation';

const mockListChecksForArtifact = listChecksForArtifact as jest.Mock;
const mockGetLatestArtifact = getLatestArtifact as jest.Mock;
const mockAdoptArtifactAsDraft = adoptArtifactAsDraft as jest.Mock;
const mockRepairContinuationArtifactOnce = repairContinuationArtifactOnce as jest.Mock;

describe('ContinuationResultScreen adoption decision', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLatestArtifact.mockResolvedValue({ id: 'artifact-1', content: '续写正文' });
    mockListChecksForArtifact.mockResolvedValue([]);
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
});

describe('ContinuationResultScreen V3 quality-first (plan §9.1, §9.2)', () => {
  const mockGetRunById = require('../src/services/continuation/generation')
    .getRunById as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLatestArtifact.mockResolvedValue({
      id: 'artifact-v3',
      content: '续写正文',
    });
    mockListChecksForArtifact.mockResolvedValue([]);
    mockGetRunById.mockResolvedValue({
      id: 'run-v3',
      state: 'awaiting_user',
      stage: 'awaiting_user',
      workflowVersion: 3,
      canonSnapshotId: 'snap',
      canonRevision: 1,
      contextTraceJson: null,
      tokenUsageJson: JSON.stringify({
        workflowVersion: 3,
        physicalRequestCount: 2,
        maxPhysicalRequests: 4,
        requests: [
          { ordinal: 1, stage: 'writer', attemptKind: 'initial', outcome: 'succeeded', promptTokens: 100, completionTokens: 200 },
          { ordinal: 2, stage: 'initial_checker', attemptKind: 'initial', outcome: 'succeeded', promptTokens: 50, completionTokens: 10 },
        ],
        stages: {
          localInitialGate: {
            stage: 'local_initial_gate',
            lengthStatus: 'within',
            actualHanCharacters: 3000,
            duplicateStatus: 'within',
            hardBlockingSubtypes: [],
            outcome: 'passed',
          },
        },
      }),
    });
  });

  it('renders V3 physical-request telemetry and DeepSeek Thinking label', async () => {
    const { getByText } = render(
      <ContinuationResultScreen runId="run-v3" onClose={jest.fn()} />,
    );
    await waitFor(() =>
      expect(getByText(/V3 质量优先 · 物理请求 2\/4/)).toBeTruthy(),
    );
    expect(getByText(/DeepSeek V4 Thinking\/high 四阶段/)).toBeTruthy();
  });

  it('does NOT show the V2 risk-adoption button for a clean V3 run', async () => {
    const { queryByText, getByText } = render(
      <ContinuationResultScreen runId="run-v3" onClose={jest.fn()} />,
    );
    await waitFor(() => expect(getByText('采纳')).toBeTruthy());
    expect(queryByText('采纳错误候选（风险自负）')).toBeNull();
    expect(queryByText('额外修正一次（增加 1 次 LLM）')).toBeNull();
  });

  it('shows V3 quality-gate-failed guidance for a failed V3 run', async () => {
    mockGetRunById.mockResolvedValue({
      id: 'run-v3-fail',
      state: 'failed',
      stage: 'awaiting_user',
      workflowVersion: 3,
      errorCode: 'v3_quality_gate_failed',
      errorMessage: 'V3 最终质量门禁未通过',
      canonSnapshotId: 'snap',
      canonRevision: 1,
      contextTraceJson: null,
      tokenUsageJson: JSON.stringify({ workflowVersion: 3, physicalRequestCount: 4, stages: {} }),
    });
    const { getByText } = render(
      <ContinuationResultScreen runId="run-v3-fail" onClose={jest.fn()} />,
    );
    await waitFor(() => expect(getByText('生成失败')).toBeTruthy());
    expect(
      getByText(/V3 质量优先工作流未通过最终质量门禁/),
    ).toBeTruthy();
  });
});

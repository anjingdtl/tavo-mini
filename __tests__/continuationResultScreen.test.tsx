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
    canonSnapshotId: 'snapshot-1234567890',
    canonRevision: 1,
    contextTraceJson: null,
  })),
  listChecksForArtifact: jest.fn(async () => [] as any[]),
  resumeInterruptedRun: jest.fn(),
  summarizeTrace: jest.fn(),
}));

import { ContinuationResultScreen } from '../src/screens/continuation/ContinuationResultScreen';
import {
  getLatestArtifact,
  listChecksForArtifact,
} from '../src/services/continuation/generation';

const mockListChecksForArtifact = listChecksForArtifact as jest.Mock;
const mockGetLatestArtifact = getLatestArtifact as jest.Mock;

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
    expect(getByText('已根据 blocking / error 检查项生成修复版候选正文；采纳将写入此版本。')).toBeTruthy();
  });

  it('uses the same collapsed stage cards and discard-then-adopt controls as the pipeline result', async () => {
    const onClose = jest.fn();
    const { getAllByRole, getByText, queryByText } = render(
      <ContinuationResultScreen runId="run-1" onClose={onClose} />,
    );

    await waitFor(() => expect(getByText('正文 · 成功 (4 字)')).toBeTruthy());
    expect(queryByText('续写正文')).toBeNull();
    fireEvent.press(getByText('正文 · 成功 (4 字)'));
    expect(getByText('续写正文')).toBeTruthy();
    await waitFor(() => expect(getByText('采纳')).toBeTruthy());
    expect(getByText('放弃')).toBeTruthy();
    expect(queryByText('采纳为草稿')).toBeNull();
    const labels = getAllByRole('button').map(button => button.props.accessibilityLabel);
    expect(labels).not.toContain('采纳为草稿');
  });

  it('blocks direct adoption after a source-overlap error', async () => {
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

    await waitFor(() => expect(getByText('检测到接缝大段重复')).toBeTruthy());
    expect(getByText('放弃并返回')).toBeTruthy();
    expect(queryByText('重新生成')).toBeNull();
    expect(queryByText('采纳')).toBeNull();
  });
});

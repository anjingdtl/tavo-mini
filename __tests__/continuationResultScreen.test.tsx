import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

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
import { listChecksForArtifact } from '../src/services/continuation/generation';

const mockListChecksForArtifact = listChecksForArtifact as jest.Mock;

describe('ContinuationResultScreen adoption decision', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListChecksForArtifact.mockResolvedValue([]);
  });

  it('uses the same discard-then-adopt labels as the pipeline result', async () => {
    const onClose = jest.fn();
    const { getAllByRole, getByText, queryByText } = render(
      <ContinuationResultScreen runId="run-1" onClose={onClose} />,
    );

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
    expect(getByText('重新生成')).toBeTruthy();
    expect(getByText('放弃')).toBeTruthy();
    expect(queryByText('采纳')).toBeNull();
  });
});

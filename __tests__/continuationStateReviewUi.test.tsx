/**
 * P1-C UI tests (fix-plan §4): proposal confirm/reject screen, sync status
 * card, and result-screen state branches. Uses @testing-library/react-native
 * with the generation barrel mocked so no SQLite/LLM is touched.
 */
import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';
import { Alert } from 'react-native';

// --- mocks ---------------------------------------------------------------
const projectState: { currentProject: any } = {
  currentProject: { id: 1, name: '续写项目', mode: 'continuation' },
};
jest.mock('../src/store/projectStore', () => ({
  useProjectStore: () => projectState,
}));

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      mode: 'light',
      colors: {
        accent: '#439EA6',
        accentSoft: '#B0E0E3',
        background: '#D7F1F4',
        textPrimary: '#111',
        textSecondary: '#444',
        textMuted: '#888',
        border: '#ccc',
        danger: '#c00',
      },
    },
  }),
}));

jest.mock('@react-navigation/native', () => {
  const { useEffect } = require('react');
  return {
    useFocusEffect: (cb: any) => {
      useEffect(() => {
        if (typeof cb === 'function') cb();
      }, [cb]);
    },
  };
});

// Generation barrel mock — controllable per-test via resetState.
const generationState: {
  proposals: any[];
  outboxSummary: any;
  failedOutbox: any[];
} = {
  proposals: [],
  outboxSummary: { pendingCount: 0, failedCount: 0, lastError: null, lastFailedDedupeKey: null },
  failedOutbox: [],
};

const mockConfirmProposal = jest.fn(async (..._a: any[]) => ({ eventId: 'ce_1' }));
const mockConfirmAllProposals = jest.fn(async (..._a: any[]) => ({
  confirmedCount: 0,
  failedProposalIds: [],
}));
const mockRejectProposal = jest.fn(async (..._a: any[]) => undefined);
const mockListProposals = jest.fn(async (..._a: any[]) => generationState.proposals);
const mockGetOutboxSummary = jest.fn(async (..._a: any[]) => generationState.outboxSummary);
const mockListOutboxForProject = jest.fn(async (..._a: any[]) => generationState.failedOutbox);
const mockRetryContinuationOutbox = jest.fn(async (..._a: any[]) => true);
const mockRetryFailedContinuationOutbox = jest.fn(async (..._a: any[]) => 1);
const mockProcessContinuationOutbox = jest.fn(async (..._a: any[]) => ({ processed: 0, failed: 0 }));

jest.mock('../src/services/continuation/generation', () => ({
  confirmProposal: (...a: any[]) => mockConfirmProposal(...a),
  confirmAllProposals: (...a: any[]) => mockConfirmAllProposals(...a),
  rejectProposal: (...a: any[]) => mockRejectProposal(...a),
  listProposals: (...a: any[]) => mockListProposals(...a),
  getOutboxSummary: (...a: any[]) => mockGetOutboxSummary(...a),
  listOutboxForProject: (...a: any[]) => mockListOutboxForProject(...a),
  retryContinuationOutbox: (...a: any[]) => mockRetryContinuationOutbox(...a),
  retryFailedContinuationOutbox: (...a: any[]) => mockRetryFailedContinuationOutbox(...a),
  processContinuationOutbox: (...a: any[]) => mockProcessContinuationOutbox(...a),
  countPendingMajorProposals: jest.fn(async () => 0),
}));

import { ContinuationStateReviewScreen } from '../src/screens/continuation/ContinuationStateReviewScreen';
import { ContinuationSyncStatus } from '../src/components/ContinuationSyncStatus';

describe('P1-C ContinuationStateReviewScreen (fix-plan §4.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    generationState.proposals = [];
  });

  it('lists pending proposals with type, summary and subject', async () => {
    generationState.proposals = [
      {
        id: 'cp_1',
        proposalType: 'character_state',
        subjectRefType: 'canon_character',
        subjectRefId: '7',
        payloadJson: JSON.stringify({ summary: '林逸负伤' }),
        evidenceStart: 10,
        evidenceEnd: 20,
      },
      {
        id: 'cp_2',
        proposalType: 'new_character',
        subjectRefType: null,
        subjectRefId: null,
        payloadJson: JSON.stringify({ name: '阿九' }),
        evidenceStart: 30,
        evidenceEnd: 40,
      },
    ];
    const { getByText } = render(
      <ContinuationStateReviewScreen onClose={jest.fn()} />,
    );
    await waitFor(() => {
      expect(getByText('人物状态')).toBeTruthy();
      expect(getByText('林逸负伤')).toBeTruthy();
      expect(getByText('新人物')).toBeTruthy();
      expect(getByText('关联：canon_character#7')).toBeTruthy();
    });
  });

  it('confirm button calls confirmProposal and reloads', async () => {
    generationState.proposals = [
      {
        id: 'cp_1',
        proposalType: 'character_state',
        subjectRefType: null,
        subjectRefId: null,
        payloadJson: JSON.stringify({ summary: '状态A' }),
        evidenceStart: 0,
        evidenceEnd: 5,
      },
    ];
    const { getByText } = render(
      <ContinuationStateReviewScreen onClose={jest.fn()} />,
    );
    await waitFor(() => expect(getByText('状态A')).toBeTruthy());
    fireEvent.press(getByText('确认'));
    await waitFor(() => expect(mockConfirmProposal).toHaveBeenCalledWith({ proposalId: 'cp_1' }));
  });

  it('batch confirm button confirms all currently loaded proposals', async () => {
    generationState.proposals = [
      {
        id: 'cp_1',
        proposalType: 'character_state',
        subjectRefType: null,
        subjectRefId: null,
        payloadJson: JSON.stringify({ summary: '状态A' }),
        evidenceStart: 0,
        evidenceEnd: 5,
      },
      {
        id: 'cp_2',
        proposalType: 'plot_advance',
        subjectRefType: null,
        subjectRefId: null,
        payloadJson: JSON.stringify({ summary: '推进B' }),
        evidenceStart: 6,
        evidenceEnd: 10,
      },
    ];
    const { getByText } = render(
      <ContinuationStateReviewScreen onClose={jest.fn()} />,
    );
    await waitFor(() => expect(getByText('全部确认（2）')).toBeTruthy());
    fireEvent.press(getByText('全部确认（2）'));
    await waitFor(() =>
      expect(mockConfirmAllProposals).toHaveBeenCalledWith({
        projectId: 1,
        proposalIds: ['cp_1', 'cp_2'],
      }),
    );
  });

  it('reject button opens confirmation alert and rejects on confirm', async () => {
    generationState.proposals = [
      {
        id: 'cp_2',
        proposalType: 'plot_advance',
        subjectRefType: null,
        subjectRefId: null,
        payloadJson: JSON.stringify({ summary: '推进' }),
        evidenceStart: 0,
        evidenceEnd: 5,
      },
    ];
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      // Press the destructive "拒绝" button.
      const rejectBtn = (buttons as any[]).find((b: any) => b.style === 'destructive');
      rejectBtn?.onPress?.();
    });
    const { getByText } = render(
      <ContinuationStateReviewScreen onClose={jest.fn()} />,
    );
    await waitFor(() => expect(getByText('推进')).toBeTruthy());
    fireEvent.press(getByText('拒绝'));
    await waitFor(() => expect(mockRejectProposal).toHaveBeenCalledWith('cp_2', undefined));
    alertSpy.mockRestore();
  });

  it('shows empty state when there are no pending proposals', async () => {
    generationState.proposals = [];
    const { getByText } = render(
      <ContinuationStateReviewScreen onClose={jest.fn()} />,
    );
    await waitFor(() => {
      expect(getByText('暂无待确认状态')).toBeTruthy();
    });
  });

  it('note toggle reveals a decision note input forwarded to confirmProposal', async () => {
    generationState.proposals = [
      {
        id: 'cp_3',
        proposalType: 'relationship_change',
        subjectRefType: null,
        subjectRefId: null,
        payloadJson: JSON.stringify({ summary: '关系' }),
        evidenceStart: 0,
        evidenceEnd: 5,
      },
    ];
    const { getByText, getByPlaceholderText } = render(
      <ContinuationStateReviewScreen onClose={jest.fn()} />,
    );
    await waitFor(() => expect(getByText('关系')).toBeTruthy());
    fireEvent.press(getByText('备注'));
    const input = getByPlaceholderText('决策备注（可选）');
    fireEvent.changeText(input, '审核通过');
    fireEvent.press(getByText('确认'));
    await waitFor(() =>
      expect(mockConfirmProposal).toHaveBeenCalledWith({
        proposalId: 'cp_3',
        decisionNote: '审核通过',
      }),
    );
  });
});

describe('P1-C ContinuationSyncStatus (fix-plan §4.3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    generationState.outboxSummary = {
      pendingCount: 0,
      failedCount: 0,
      lastError: null,
      lastFailedDedupeKey: null,
    };
    generationState.failedOutbox = [];
  });

  it('is hidden when there is nothing pending or failed', async () => {
    const { toJSON } = render(<ContinuationSyncStatus projectId={1} />);
    // Component returns null when both counts are 0 and not loading.
    await waitFor(() => {
      expect(toJSON()).toBeNull();
    });
  });

  it('shows failed count, last error and retry buttons', async () => {
    generationState.outboxSummary = {
      pendingCount: 1,
      failedCount: 2,
      lastError: '网络错误',
      lastFailedDedupeKey: 'extract_state:10:abc',
    };
    generationState.failedOutbox = [
      {
        id: 'co_1',
        operation: 'extract_state',
        dedupeKey: 'extract_state:10:abc',
        lastError: '网络错误',
        state: 'failed',
      },
    ];
    const { getByText } = render(<ContinuationSyncStatus projectId={1} />);
    await waitFor(() => {
      expect(getByText('待处理 1')).toBeTruthy();
      expect(getByText('失败 2')).toBeTruthy();
      expect(getByText('网络错误')).toBeTruthy();
      expect(getByText('全部重试')).toBeTruthy();
    });
  });

  it('single retry calls retryContinuationOutbox and triggers the worker', async () => {
    generationState.outboxSummary = {
      pendingCount: 0,
      failedCount: 1,
      lastError: '失败',
      lastFailedDedupeKey: 'extract_state:10:x',
    };
    generationState.failedOutbox = [
      {
        id: 'co_1',
        operation: 'extract_state',
        dedupeKey: 'extract_state:10:x',
        lastError: '失败',
        state: 'failed',
      },
    ];
    const { getAllByText } = render(<ContinuationSyncStatus projectId={1} />);
    await waitFor(() => expect(getAllByText('重试').length).toBeGreaterThan(0));
    fireEvent.press(getAllByText('重试')[0]);
    await waitFor(() => expect(mockRetryContinuationOutbox).toHaveBeenCalledWith('co_1'));
    // worker triggered as acceleration
    expect(mockProcessContinuationOutbox).toHaveBeenCalled();
  });

  it('batch retry calls retryFailedContinuationOutbox', async () => {
    generationState.outboxSummary = {
      pendingCount: 0,
      failedCount: 3,
      lastError: '失败',
      lastFailedDedupeKey: 'extract_state:10:x',
    };
    generationState.failedOutbox = [];
    const { getByText } = render(<ContinuationSyncStatus projectId={1} />);
    await waitFor(() => expect(getByText('全部重试')).toBeTruthy());
    fireEvent.press(getByText('全部重试'));
    await waitFor(() => expect(mockRetryFailedContinuationOutbox).toHaveBeenCalledWith(1));
  });
});

import React, { useState } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';

const mockLoadCandidateBase = jest.fn();

jest.mock('../src/services/database', () => ({
  getChapterById: jest.fn(),
}));

jest.mock('../src/services/writing/userRevision', () => {
  class MockUserRevisionError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }

  return {
    UserRevisionError: MockUserRevisionError,
    applyUserRevisionPreview: jest.fn(),
    applyUserRevisionPreviewToCandidate: jest.fn(),
    createTargetedRevisionPreview: jest.fn(),
    createWholeChapterRewritePreview: jest.fn(),
    discardUserRevisionPreview: jest.fn(),
    loadUserRevisionCandidateBase: (...args: unknown[]) =>
      mockLoadCandidateBase(...args),
    loadUserRevisionFrozenTruth: jest.fn(),
  };
});

jest.mock('../src/services/continuation/generation/continuationV5Contracts', () => ({
  hashContent: jest.fn(() => 'candidate-hash'),
}));

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      colors: {
        surface: '#fff',
        card: '#fff',
        border: '#ddd',
        textPrimary: '#111',
        textSecondary: '#666',
        textMuted: '#999',
        accent: '#668866',
        accentSoft: '#ddeedd',
        danger: '#aa3333',
      },
    },
  }),
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

import { UserRevisionModal } from '../src/components/UserRevisionModal';

const chapter = {
  id: 8,
  project_id: 9,
  title: '第八章',
  synopsis: '',
  content: '',
  status: 'draft' as const,
  position: 8,
  summary_json: null,
  created_at: '2026-09-12T00:00:00.000Z',
  updated_at: '2026-09-12T00:00:00.000Z',
};

const candidateBase = {
  baseBody: '候选正文：他推门而入，雨声在身后合拢。',
  baseBodyFingerprint: 'candidate-hash',
  candidateRef: {
    kind: 'pipeline_task' as const,
    taskId: 'task-1',
    projectId: 9,
    chapterId: 8,
  },
  frozenTruth: {} as any,
};

function CandidateModalHarness() {
  const [, setTick] = useState(0);

  return (
    <>
      <UserRevisionModal
        visible
        kind="targeted_revision"
        chapter={chapter}
        scenario="outline"
        selectionStart={0}
        selectionEnd={0}
        candidate={{
          candidateRef: {
            kind: 'pipeline_task',
            taskId: 'task-1',
            projectId: 9,
            chapterId: 8,
          },
          scenario: 'outline',
        }}
        onClose={jest.fn()}
        onApplied={jest.fn()}
      />
      <Pressable testID="rerender-parent" onPress={() => setTick(value => value + 1)}>
        <Text>rerender</Text>
      </Pressable>
    </>
  );
}

describe('UserRevisionModal candidate selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadCandidateBase.mockResolvedValue(candidateBase);
  });

  it('keeps a valid range through focus, transient collapse, and parent rerender', async () => {
    const { findByTestId, getByTestId, getByText } = render(
      <CandidateModalHarness />,
    );
    const selectionBox = await findByTestId('candidate-revision-selection-box');

    await act(async () => {
      fireEvent(selectionBox, 'selectionChange', {
        nativeEvent: { selection: { start: 3, end: 8 } },
      });
    });
    expect(getByText(/3\.\.8/)).toBeTruthy();

    fireEvent(selectionBox, 'selectionChange', {
      nativeEvent: { selection: { start: 0, end: 0 } },
    });
    fireEvent(getByTestId('user-revision-instruction'), 'focus');
    fireEvent.changeText(getByTestId('user-revision-instruction'), 'keep tone');
    expect(getByText(/3\.\.8/)).toBeTruthy();

    fireEvent.press(getByTestId('rerender-parent'));
    await waitFor(() => expect(getByText(/3\.\.8/)).toBeTruthy());
    expect(mockLoadCandidateBase).toHaveBeenCalledTimes(1);
  });
});

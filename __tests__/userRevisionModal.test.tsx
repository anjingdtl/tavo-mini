import React, { useState } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

const mockLoadCandidateBase = jest.fn();
const mockCreateTargetedRevisionPreview = jest.fn();

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
    createTargetedRevisionPreview: (...args: unknown[]) =>
      mockCreateTargetedRevisionPreview(...args),
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

const longCandidateBase = {
  ...candidateBase,
  baseBody: Array.from(
    { length: 80 },
    (_, index) => `第${index + 1}段：候选正文用于验证长文定位、选区稳定和预览生成。`,
  ).join('\n'),
};

function responderEvent(locationY: number) {
  return {
    nativeEvent: { locationY },
    touchHistory: {
      touchBank: [
        {
          touchActive: true,
          currentTimeStamp: 1,
          currentPageX: 0,
          currentPageY: locationY,
          previousPageX: 0,
          previousPageY: locationY,
        },
      ],
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: 1,
    },
  };
}

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
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockLoadCandidateBase.mockResolvedValue(candidateBase);
    mockCreateTargetedRevisionPreview.mockResolvedValue({
      kind: 'targeted_revision',
      state: 'pending',
      receipt: { physicalRequestCount: 1 },
      selection: { selectionStart: 3, selectionEnd: 8 },
      baseBody: candidateBase.baseBody,
      candidateBody: candidateBase.baseBody,
      candidateRef: candidateBase.candidateRef,
    });
  });

  it('hides the scrollbar when the candidate fits in the viewport', async () => {
    const { findByTestId, queryByTestId } = render(<CandidateModalHarness />);
    const scrollView = await findByTestId('candidate-revision-scroll-view');

    fireEvent(scrollView, 'layout', {
      nativeEvent: { layout: { width: 320, height: 160, x: 0, y: 0 } },
    });
    fireEvent(scrollView, 'contentSizeChange', 320, 160);

    expect(queryByTestId('candidate-revision-scrollbar')).toBeNull();
  });

  it('maps long-body scrolling and keeps the selected range through drag, focus, and rerender', async () => {
    mockLoadCandidateBase.mockResolvedValue(longCandidateBase);
    mockCreateTargetedRevisionPreview.mockResolvedValue({
      kind: 'targeted_revision',
      state: 'pending',
      receipt: { physicalRequestCount: 1 },
      selection: { selectionStart: 3, selectionEnd: 8 },
      baseBody: longCandidateBase.baseBody,
      candidateBody: longCandidateBase.baseBody,
      candidateRef: longCandidateBase.candidateRef,
    });
    const scrollToSpy = jest.spyOn(ScrollView.prototype, 'scrollTo');
    const { findByTestId, getByTestId, getByText } = render(
      <CandidateModalHarness />,
    );
    const selectionBox = await findByTestId('candidate-revision-selection-box');
    const scrollView = getByTestId('candidate-revision-scroll-view');
    fireEvent(scrollView, 'layout', {
      nativeEvent: { layout: { width: 320, height: 260, x: 0, y: 0 } },
    });
    fireEvent(scrollView, 'contentSizeChange', 320, 1800);
    const scrollbar = await findByTestId('candidate-revision-scrollbar');
    expect(scrollbar.props.accessibilityValue).toMatchObject({
      min: 0,
      max: 1540,
      now: 0,
    });

    await act(async () => {
      fireEvent(selectionBox, 'selectionChange', {
        nativeEvent: { selection: { start: 3, end: 8 } },
      });
    });
    expect(getByText(/3\.\.8/)).toBeTruthy();

    fireEvent.scroll(scrollView, {
      nativeEvent: {
        contentOffset: { x: 0, y: 770 },
        contentSize: { width: 320, height: 1800 },
        layoutMeasurement: { width: 320, height: 260 },
      },
    });
    expect(scrollbar.props.accessibilityValue.now).toBe(770);
    const thumb = getByTestId('candidate-revision-scrollbar-thumb');
    expect(StyleSheet.flatten(thumb.props.style).top).toBeCloseTo(111, 0);

    fireEvent(scrollbar, 'responderGrant', responderEvent(240));
    fireEvent(scrollbar, 'responderRelease', responderEvent(240));
    expect(scrollbar.props.accessibilityValue.now).toBeGreaterThan(1500);
    const latestThumb = getByTestId('candidate-revision-scrollbar-thumb');
    const latestThumbStyle = StyleSheet.flatten(latestThumb.props.style);
    const latestThumbHeight = latestThumbStyle.height;
    const expectedDragOffset =
      ((130 - latestThumbHeight / 2) / (260 - latestThumbHeight)) * 1540;
    fireEvent(
      scrollbar,
      'responderGrant',
      responderEvent(latestThumbStyle.top + latestThumbHeight / 2),
    );
    fireEvent(scrollbar, 'responderMove', responderEvent(130));
    expect(scrollbar.props.accessibilityValue.now).toBeCloseTo(
      expectedDragOffset,
      2,
    );
    expect(scrollToSpy).toHaveBeenCalledWith(
      expect.objectContaining({ animated: false, y: expect.any(Number) }),
    );

    fireEvent(selectionBox, 'selectionChange', {
      nativeEvent: { selection: { start: 0, end: 0 } },
    });
    fireEvent(getByTestId('user-revision-instruction'), 'focus');
    fireEvent.changeText(getByTestId('user-revision-instruction'), 'keep tone');
    expect(getByText(/3\.\.8/)).toBeTruthy();

    fireEvent.press(getByTestId('rerender-parent'));
    await waitFor(() => expect(getByText(/3\.\.8/)).toBeTruthy());
    expect(mockLoadCandidateBase).toHaveBeenCalledTimes(1);

    fireEvent.press(getByTestId('user-revision-generate'));
    await waitFor(() =>
      expect(mockCreateTargetedRevisionPreview).toHaveBeenCalledWith(
        expect.objectContaining({ selectionStart: 3, selectionEnd: 8 }),
      ),
    );
  });
});

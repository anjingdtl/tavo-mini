import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

const mockGetDrafts = jest.fn();
const mockRemoveDraft = jest.fn();
const mockClearDrafts = jest.fn();
const mockUpdateChapter = jest.fn();
const mockSetFreeformDocument = jest.fn();
const mockGetChapterById = jest.fn();
const mockCreateRevision = jest.fn();

jest.mock('../src/services/draftService', () => ({
  getDrafts: (...args: any[]) => mockGetDrafts(...args),
  removeDraft: (...args: any[]) => mockRemoveDraft(...args),
  clearDrafts: (...args: any[]) => mockClearDrafts(...args),
}));

jest.mock('../src/services/database', () => ({
  getChapterById: (...args: any[]) => mockGetChapterById(...args),
  updateChapter: (...args: any[]) => mockUpdateChapter(...args),
  setFreeformDocument: (...args: any[]) => mockSetFreeformDocument(...args),
}));

jest.mock('../src/services/revisionService', () => ({
  createRevision: (...args: any[]) => mockCreateRevision(...args),
}));

import { DraftPreviewScreen } from '../src/screens/DraftPreviewScreen';

const sampleDrafts = [
  {
    id: 1,
    projectId: 10,
    targetType: 'chapter' as const,
    targetId: 100,
    source: 'pipeline' as const,
    content: '草稿内容一号',
    tokenCount: 1234,
    createdAt: '2026-06-14T08:00:00.000Z',
    status: 'pending' as const,
  },
  {
    id: 2,
    projectId: 10,
    targetType: 'chapter' as const,
    targetId: 100,
    source: 'continuation' as const,
    content: '草稿内容二号',
    tokenCount: 2345,
    createdAt: '2026-06-14T08:30:00.000Z',
    status: 'pending' as const,
  },
];

describe('DraftPreviewScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDrafts.mockResolvedValue(sampleDrafts);
    mockGetChapterById.mockResolvedValue({ id: 100, content: '原文内容' });
    mockCreateRevision.mockResolvedValue(undefined);
    mockUpdateChapter.mockResolvedValue(undefined);
    mockRemoveDraft.mockResolvedValue(undefined);
    mockClearDrafts.mockResolvedValue(undefined);
  });

  // Flush any pending async state updates left over from useEffect microtasks
  // (e.g. the `.finally(() => setLoading(false))` in the initial `load()` call,
  // or the `setAdopting(null)` in `runAdopt`'s `finally`). Without this hook,
  // those setStates would land in a microtask fired *after* `findBy*` / `act`
  // has returned, which triggers the React 19 "not wrapped in act" warning.
  afterEach(async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  });

  it('renders adopt and delete buttons for each draft', async () => {
    const onClose = jest.fn();
    const { findAllByText } = render(
      <DraftPreviewScreen
        targetType="chapter"
        targetId={100}
        projectId={10}
        onClose={onClose}
      />,
    );
    const adopts = await findAllByText('采纳');
    const deletes = await findAllByText('删除');
    expect(adopts.length).toBe(2);
    expect(deletes.length).toBe(2);
  });

  it('does not render adopt-all or clear-all buttons when list is empty', async () => {
    mockGetDrafts.mockResolvedValue([]);
    const onClose = jest.fn();
    const { queryByText, findByText } = render(
      <DraftPreviewScreen
        targetType="chapter"
        targetId={100}
        projectId={10}
        onClose={onClose}
      />,
    );
    await findByText('暂无草稿');
    expect(queryByText('全部采纳')).toBeNull();
    expect(queryByText('清空草稿')).toBeNull();
  });

  it('runs adopt only once when adopt button is triple-tapped quickly', async () => {
    let resolveAdopt: () => void = () => {};
    mockUpdateChapter.mockImplementation(
      () => new Promise<void>((resolve) => { resolveAdopt = resolve; }),
    );

    const onClose = jest.fn();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(((_title, _msg, buttons) => {
      const adoptBtn = (buttons as any[]).find((b) => b.text === '采纳');
      adoptBtn.onPress();
    }) as any);

    const { findAllByText } = render(
      <DraftPreviewScreen
        targetType="chapter"
        targetId={100}
        projectId={10}
        onClose={onClose}
      />,
    );

    const adopts = await findAllByText('采纳');
    // Three rapid taps on the first adopt button. Wrap in act so the
    // resulting async setState calls (Alert → runAdopt → setAdopting) are
    // tracked and don't emit "not wrapped in act(...)" warnings.
    await act(async () => {
      fireEvent.press(adopts[0]);
      fireEvent.press(adopts[0]);
      fireEvent.press(adopts[0]);
    });

    // Allow microtasks to flush.
    await act(async () => {
      await Promise.resolve();
    });

    // updateChapter must have been called exactly once because the adopt lock rejects the rest.
    expect(mockUpdateChapter).toHaveBeenCalledTimes(1);

    alertSpy.mockRestore();
    resolveAdopt();
  });

  it('shows inline error message instead of Alert on failure', async () => {
    mockUpdateChapter.mockRejectedValue(new Error('写库炸了'));

    const onClose = jest.fn();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(((_title, _msg, buttons) => {
      const adoptBtn = (buttons as any[]).find((b) => b.text === '采纳');
      adoptBtn.onPress();
    }) as any);

    const { findAllByText, findByText } = render(
      <DraftPreviewScreen
        targetType="chapter"
        targetId={100}
        projectId={10}
        onClose={onClose}
      />,
    );

    const adopts = await findAllByText('采纳');
    // Wrap in act so Alert → runAdopt → setAdopting / setErrorMessage are tracked.
    await act(async () => {
      fireEvent.press(adopts[0]);
    });

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('采纳确认', expect.any(String), expect.any(Array));
    });
    // The error feedback must come from inline text, not from a second Alert.
    await findByText('写库炸了');
    const errorAlertCalls = alertSpy.mock.calls.filter(
      (call) => call[0] === '采纳失败' || call[0] === '删除失败' || call[0] === '清空失败',
    );
    expect(errorAlertCalls.length).toBe(0);

    alertSpy.mockRestore();
  });

  it('does not throw when component unmounts during adopt', async () => {
    let resolveAdopt: () => void = () => {};
    mockUpdateChapter.mockImplementation(
      () => new Promise<void>((resolve) => { resolveAdopt = resolve; }),
    );

    const onClose = jest.fn();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(((_title, _msg, buttons) => {
      const adoptBtn = (buttons as any[]).find((b) => b.text === '采纳');
      adoptBtn.onPress();
    }) as any);

    const { findAllByText, unmount } = render(
      <DraftPreviewScreen
        targetType="chapter"
        targetId={100}
        projectId={10}
        onClose={onClose}
      />,
    );

    const adopts = await findAllByText('采纳');
    // Wrap in act so Alert → runAdopt → setAdopting is tracked.
    await act(async () => {
      fireEvent.press(adopts[0]);
    });

    // Unmount before adopt resolves.
    unmount();
    resolveAdopt();

    // Wait a tick to let any rejected setState propagate.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    alertSpy.mockRestore();
    // The test passing without throwing is the assertion.
  });
});

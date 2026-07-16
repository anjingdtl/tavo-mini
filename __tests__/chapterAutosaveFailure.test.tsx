/* eslint-env jest */

import { act, renderHook } from '@testing-library/react-native';
import { useState } from 'react';
import * as db from '../src/services/database';
import { useChapterAutoSave } from '../src/screens/chapter-editor/hooks/useChapterAutoSave';
import type { Chapter } from '../src/types/novel';

jest.mock('../src/services/database', () => ({
  updateChapter: jest.fn(),
}));

const updateChapter = db.updateChapter as jest.MockedFunction<
  typeof db.updateChapter
>;

const chapter: Chapter = {
  id: 1,
  project_id: 10,
  title: '第一章',
  synopsis: '',
  content: '旧正文',
  status: 'draft',
  position: 1,
  summary_json: null,
  memory_summary: '',
  memory_summary_tokens: 0,
  created_at: '2026-07-16T00:00:00.000Z',
  updated_at: '2026-07-16T00:00:00.000Z',
};

function useAutosaveHarness() {
  const [currentChapter, setCurrentChapter] = useState<Chapter | null>(chapter);
  const autosave = useChapterAutoSave(currentChapter, setCurrentChapter);
  return { ...autosave, currentChapter };
}

describe('chapter autosave failure propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects flush and preserves pending content when updateChapter fails', async () => {
    const writeError = new Error('disk full');
    updateChapter.mockRejectedValueOnce(writeError);
    const { result } = renderHook(() => useAutosaveHarness());

    act(() => {
      result.current.changeField('content', '未保存的新正文');
    });

    await act(async () => {
      await expect(result.current.autoSaveRef.current.flush()).rejects.toBe(
        writeError,
      );
    });

    expect(result.current.saveStatus).toBe('failed');
    expect(result.current.saveError).toBe(writeError);
    expect(result.current.autoSaveRef.current.pending()).toBe(true);
    expect(updateChapter).toHaveBeenCalledWith(1, {
      content: '未保存的新正文',
    });
  });

  it('retries the preserved pending content and becomes saved', async () => {
    updateChapter
      .mockRejectedValueOnce(new Error('temporary write failure'))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useAutosaveHarness());

    act(() => {
      result.current.changeField('content', '可重试正文');
    });

    await act(async () => {
      await expect(result.current.autoSaveRef.current.flush()).rejects.toThrow(
        'temporary write failure',
      );
    });

    await act(async () => {
      await result.current.autoSaveRef.current.flush();
    });

    expect(updateChapter).toHaveBeenCalledTimes(2);
    expect(updateChapter).toHaveBeenLastCalledWith(1, {
      content: '可重试正文',
    });
    expect(result.current.saveStatus).toBe('saved');
    expect(result.current.autoSaveRef.current.pending()).toBe(false);
  });
});

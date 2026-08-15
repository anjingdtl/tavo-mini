/** Stability Phase II — V7 frozen resource semantic fallback red coverage. */
jest.mock('../src/services/database', () => ({
  getProjectNoteConfig: jest.fn(async () => ({ mode: 'retrieval', retrievalTopK: 5 })),
  getCharactersByProject: jest.fn(async () => []),
  getWorldbookEntriesByProject: jest.fn(async () => []),
  getNotesByProject: jest.fn(async () => [{ id: 21, title: '冻结笔记' }]),
  getNotesContentByIds: jest.fn(async () => ({ 21: '当前章 继续写 冻结正文' })),
  getNoteStyleProfile: jest.fn(async () => null),
}));

jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(async () => {
    throw new Error('semantic helper unavailable');
  }),
}));

import { captureResourceSourceSnapshot } from '../src/services/context/resources/resourceSourceSnapshot';
import * as db from '../src/services/database';

beforeEach(() => {
  jest.clearAllMocks();
});

test('V7 frozen retrieval fallback is surfaced as a resource warning', async () => {
  const snapshot = await captureResourceSourceSnapshot(7, {
    includeResources: true,
    noteQuery: {
      chapterTitle: '当前章',
      chapterSynopsis: '当前概要',
      previousEnding: '',
      userPrompt: '继续写',
    },
  });

  expect(snapshot.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'NOTE_RETRIEVAL_FAILED' }),
    ]),
  );
});

test('V7 frozen style analysis fallback is surfaced as a resource warning', async () => {
  (db.getProjectNoteConfig as jest.Mock).mockResolvedValue({ mode: 'style' });

  const snapshot = await captureResourceSourceSnapshot(7, {
    includeResources: true,
  });

  expect(snapshot.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'NOTE_STYLE_ANALYSIS_FAILED',
        sourceId: 21,
      }),
    ]),
  );
});

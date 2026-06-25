/* eslint-env jest */

jest.mock('../src/services/database', () => ({
  getProjectNoteConfig: jest.fn(async () => ({ enabledNoteIds: [1, 2] })),
  getNotesByProject: jest.fn(async () => []),
  getAllNotes: jest.fn(async () => [{ id: 1, title: '笔记A' }, { id: 2, title: '笔记B' }]),
  getNoteContentById: jest.fn(async (id: number) => `笔记${id}的内容包含关键词雨夜`),
}));
jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(async () => ({
    text: '{"selected":[{"noteId":1,"noteTitle":"笔记A","fragment":"雨夜片段","relevance":"相关"}]}',
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
  })),
}));

import { retrieveNoteFragments, clearRetrievalCache } from '../src/services/noteRetriever';
import { callLLMResult } from '../src/services/llm';

beforeEach(() => {
  jest.clearAllMocks();
  clearRetrievalCache();
});

test('retrieveNoteFragments returns LLM selected fragments', async () => {
  const result = await retrieveNoteFragments(
    1,
    {
      chapterTitle: '雨夜',
      chapterSynopsis: '主角在雨夜行走',
      previousEnding: '天黑了',
      userPrompt: '继续写',
    },
    5,
  );
  expect(result).toHaveLength(1);
  expect(result[0].noteId).toBe(1);
  expect(result[0].fragment).toBe('雨夜片段');
});

test('retrieveNoteFragments caches result for same query (different userPrompt hits cache)', async () => {
  const query = {
    chapterTitle: '雨夜',
    chapterSynopsis: '概要',
    previousEnding: '结尾',
    userPrompt: '指令A',
  };
  await retrieveNoteFragments(1, query, 5);
  await retrieveNoteFragments(1, { ...query, userPrompt: '指令B' }, 5);
  expect(callLLMResult).toHaveBeenCalledTimes(1);
});

test('retrieveNoteFragments falls back to keyword prefilter on LLM error', async () => {
  (callLLMResult as jest.Mock).mockRejectedValueOnce(new Error('LLM error'));
  const result = await retrieveNoteFragments(
    1,
    {
      chapterTitle: '雨夜',
      chapterSynopsis: '概要',
      previousEnding: '结尾',
      userPrompt: '指令',
    },
    5,
  );
  expect(result.length).toBeGreaterThan(0);
  expect(result[0].relevance).toContain('回退');
});

test('retrieveNoteFragments returns empty when LLM returns non-JSON (extractJSON yields empty selection)', async () => {
  (callLLMResult as jest.Mock).mockResolvedValueOnce({
    text: 'not valid json at all',
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
  });
  const result = await retrieveNoteFragments(
    1,
    {
      chapterTitle: '雨夜',
      chapterSynopsis: '概要',
      previousEnding: '结尾',
      userPrompt: '指令',
    },
    5,
  );
  // extractJSON 返回 null → fallback '{"selected":[]}' → 空数组（不注入笔记，不阻塞生成）
  expect(result).toEqual([]);
});

test('clearRetrievalCache removes entries for a specific project', async () => {
  await retrieveNoteFragments(
    1,
    { chapterTitle: '雨夜', chapterSynopsis: '概要', previousEnding: '结尾', userPrompt: '指令' },
    5,
  );
  clearRetrievalCache(1);
  await retrieveNoteFragments(
    1,
    { chapterTitle: '雨夜', chapterSynopsis: '概要', previousEnding: '结尾', userPrompt: '指令' },
    5,
  );
  expect(callLLMResult).toHaveBeenCalledTimes(2);
});

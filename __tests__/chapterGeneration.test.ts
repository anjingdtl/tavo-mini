/* eslint-env jest */

import { createChapterGenerationRequest } from '../src/services/chapterGeneration';

const baseChapter = {
  id: 1,
  project_id: 1,
  position: 0,
  title: '第一章',
  synopsis: '',
  content: '',
  status: 'planned',
  summary_json: null,
  created_at: '',
  updated_at: '',
} as any;

test('empty chapters ask the model to create prose instead of continuing a placeholder', () => {
  const request = createChapterGenerationRequest(baseChapter);

  expect(request.userPrompt).toContain('从零开始创作');
  expect(request.userPrompt).toContain('当前章节正文为空');
  expect(request.userPrompt).toContain('不要输出“（空）”');
});

test('non-empty chapters keep the existing tail as continuation context', () => {
  const request = createChapterGenerationRequest({
    ...baseChapter,
    content: '雨夜里，钟楼终于响了。',
  });

  expect(request.userPrompt).toContain('请继续创作章节');
  expect(request.userPrompt).toContain('雨夜里，钟楼终于响了。');
});

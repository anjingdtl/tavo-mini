import type { Chapter } from '../types/novel';

export type ChapterGenerationMode = 'continue' | 'revision';

export interface ChapterGenerationRequest {
  mode: ChapterGenerationMode;
  scenario: 'chapter_continue' | 'chapter_revision';
  userPrompt: string;
}

export function createChapterGenerationRequest(chapter: Chapter): ChapterGenerationRequest {
  if (chapter.status === 'revision') {
    return {
      mode: 'revision',
      scenario: 'chapter_revision',
      userPrompt: [
        `请修订章节「${chapter.title}」。`,
        `章节概要：${chapter.synopsis || '无'}`,
        '',
        '以下是当前正文：',
        chapter.content || '（空）',
        '',
        '要求：输出完整修订稿，直接给出修订后的正文；保留已有剧情事实，优化连贯性、节奏、语气和细节，不要输出分析、标题或修改说明。',
      ].join('\n'),
    };
  }

  return {
    mode: 'continue',
    scenario: 'chapter_continue',
    userPrompt: [
      `请继续创作章节「${chapter.title}」。`,
      `章节概要：${chapter.synopsis || '无'}`,
      '',
      '当前正文如下：',
      chapter.content || '（空）',
      '',
      '要求：延续已建立的语气和情节，不重复前文，只输出新增正文。',
    ].join('\n'),
  };
}

import type { Chapter } from '../types/novel';

export type ChapterGenerationMode = 'continue' | 'revision';

export interface ChapterGenerationRequest {
  mode: ChapterGenerationMode;
  scenario: 'chapter_continue' | 'chapter_revision';
  userPrompt: string;
}

export function createChapterGenerationRequest(
  chapter: Chapter,
  options: { includeExistingContent?: boolean } = {},
): ChapterGenerationRequest {
  const hasContent = !!chapter.content?.trim();
  const includeExistingContent = options.includeExistingContent !== false;

  if (chapter.status === 'revision') {
    const revisionPrompt = [
      `请修订章节「${chapter.title}」。`,
      `章节概要：${chapter.synopsis || '无'}`,
      '',
      ...(includeExistingContent
        ? ['以下是当前正文：', chapter.content || '（空）', '']
        : ['当前正文由流水线 Draft 编译器作为独立正文块注入，不要在本提示中重复正文。', '']),
      '要求：输出完整修订稿，直接给出修订后的正文；保留已有剧情事实，优化连贯性、节奏、语气和细节，不要输出分析、标题或修改说明。',
    ];
    return {
      mode: 'revision',
      scenario: 'chapter_revision',
      userPrompt: revisionPrompt.join('\n'),
    };
  }

  if (!hasContent) {
    return {
      mode: 'continue',
      scenario: 'chapter_continue',
      userPrompt: [
        `请从零开始创作章节「${chapter.title}」。`,
        `章节概要：${chapter.synopsis || '无'}`,
        '',
        '当前章节正文为空。请根据标题、概要和上下文直接写出本章开篇正文，建立场景、人物行动和情绪推进。',
        '',
        '硬性要求：只输出小说正文；不要输出“（空）”、标题、解释、分析、提纲、占位符或道歉说明。',
      ].join('\n'),
    };
  }

  const continuationPrompt = [
    `请继续创作章节「${chapter.title}」。`,
    `章节概要：${chapter.synopsis || '无'}`,
    '',
    ...(includeExistingContent
      ? ['当前正文如下：', chapter.content, '']
      : ['当前正文由流水线 Draft 编译器作为独立正文块注入，不要在本提示中重复正文。', '']),
    '要求：延续已建立的语气和情节，不重复前文，只输出新增正文。',
  ];
  return {
    mode: 'continue',
    scenario: 'chapter_continue',
    userPrompt: continuationPrompt.join('\n'),
  };
}

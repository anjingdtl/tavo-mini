import type { Chapter } from '../../types/novel';
import { canonicalStringify } from './storyMemoryFingerprint';
import { createEmptyChapterMemoryPatch } from './storyMemoryDefaults';
import type { StoryMemoryState } from './storyMemoryTypes';

export const STORY_MEMORY_SYSTEM_PROMPT = `你是小说连续性记录器，不是小说作者。

任务：只提取“本章明确发生并会影响后续连续性”的变化。
你不得续写、猜测、补全、评价或美化。
你不得输出完整故事摘要，只能输出指定的增量 JSON。
所有事实必须来自当前章节正文。
每个更新必须提供一段可在正文中找到的简短原文 evidenceQuote。
已有实体必须使用输入中给出的精确 ID。
新实体只能使用 new_char_*、new_rel_*、new_thread_* 等临时引用。
未发生变化的字段不要输出；范式要求的数组无变化时输出空数组。
无法确认时保留为空数组，不得猜测。
只输出一个 JSON 对象，不要输出 Markdown、解释或代码围栏。`;

function compactState(state: StoryMemoryState): string {
  return canonicalStringify({
    throughChapterPosition: state.throughChapterPosition,
    characters: Object.values(state.characters).map(character => ({
      id: character.id,
      canonicalName: character.canonicalName,
      aliases: character.aliases,
      currentState: character.currentState,
      status: character.status,
    })),
    relationships: Object.values(state.relationships),
    mainline: state.mainline,
  });
}

export function buildStoryMemoryPatchMessages(
  chapter: Chapter,
  state: StoryMemoryState,
): Array<{ role: 'system' | 'user'; content: string }> {
  const schema = createEmptyChapterMemoryPatch({
    chapterId: chapter.id,
    chapterPosition: chapter.position,
    title: chapter.title,
  });
  return [
    { role: 'system', content: STORY_MEMORY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        '【上一版已验证故事状态】',
        compactState(state),
        '',
        '【当前章节】',
        `ID：${chapter.id}`,
        `位置：${chapter.position}`,
        `标题：${chapter.title}`,
        `概要：${chapter.synopsis || '无'}`,
        `正文：\n${chapter.content}`,
        '',
        '【严格输出范式】',
        canonicalStringify(schema),
      ].join('\n'),
    },
  ];
}

export function buildStoryMemoryRepairMessages(
  originalMessages: Array<{ role: 'system' | 'user'; content: string }>,
  invalidOutput: string,
  validationError: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return [
    ...originalMessages,
    { role: 'assistant', content: invalidOutput },
    {
      role: 'user',
      content: `上一个 JSON 无效：${validationError}\n只修复结构、引用和证据问题。不要重新创作或增加事实，只输出修复后的 JSON 对象。`,
    },
  ];
}

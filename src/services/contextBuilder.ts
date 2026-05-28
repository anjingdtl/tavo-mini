import * as db from './database';
import { processMacros } from './macroReplace';
import type { Chapter, ChapterSummary, ContextConfig, Preset } from '../types/novel';
import type { ChatMessage } from './llm';

const DEFAULT_SYSTEM_PROMPT =
  '你是一位经验丰富的中文小说作者。请根据既有设定、人物状态、章节概要和前文内容，继续创作自然、连贯、有画面感的中文小说。';

export async function buildContext(
  currentChapter: Chapter,
  config: ContextConfig,
  projectId: number,
  preset?: Preset | string,
): Promise<ChatMessage[]> {
  const systemPrompt = typeof preset === 'string' ? preset : buildPresetPrompt(preset);
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt || DEFAULT_SYSTEM_PROMPT }];

  if (config.includeResources && config.resourceBudget > 0) {
    const resourceText = await buildResourceContext(projectId, config.resourceBudget);
    if (resourceText) {
      messages.push({ role: 'user', content: `以下是故事设定资料：\n\n${resourceText}` });
      messages.push({ role: 'assistant', content: '我已了解故事设定，会在后续创作中保持一致。' });
    }
  }

  const summaryText = await buildPreviousSummaryContext(projectId, currentChapter.position, 3000);
  if (summaryText) {
    messages.push({ role: 'user', content: `以下是前文摘要：\n\n${summaryText}` });
    messages.push({ role: 'assistant', content: '我会参考前文摘要延续剧情。' });
  }

  const prevContent = await getPreviousContent(currentChapter, config);
  if (prevContent) {
    const processed = await processMacros(prevContent, {
      projectId,
      chapterTitle: currentChapter.title,
      chapterSynopsis: currentChapter.synopsis,
    });
    messages.push({ role: 'user', content: `以下是前文正文：\n\n${processed}` });
    messages.push({ role: 'assistant', content: '我已了解前文，现在继续创作。' });
  }

  if (currentChapter.synopsis) {
    messages.push({
      role: 'user',
      content: `当前章节「${currentChapter.title}」概要：${currentChapter.synopsis}`,
    });
  }

  return messages;
}

function buildPresetPrompt(preset?: Preset): string {
  if (!preset) return DEFAULT_SYSTEM_PROMPT;
  const parts = [preset.system_prompt || DEFAULT_SYSTEM_PROMPT];
  if (preset.writing_style) parts.push(`写作风格：${preset.writing_style}`);
  if (preset.extra_instructions) parts.push(`附加要求：${preset.extra_instructions}`);
  return parts.join('\n\n');
}

async function buildResourceContext(projectId: number, budget: number): Promise<string> {
  const parts: string[] = [];
  let remaining = budget;
  const addPart = (title: string, text: string) => {
    if (!text || remaining <= 0) return;
    const clipped = text.slice(0, remaining);
    parts.push(`${title}：\n${clipped}`);
    remaining -= clipped.length;
  };

  const characters = await db.getCharactersByProject(projectId);
  const characterText = characters
    .map((character: any) => {
      const data = safeJson(character.data_json);
      const card = data.data || data;
      return [`角色「${character.name}」`, card.description && `描述：${card.description}`, card.personality && `性格：${card.personality}`]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
  addPart('人物设定', characterText);

  const worldbook = await db.getWorldbookEntriesByProject(projectId);
  const worldText = worldbook
    .filter((entry: any) => entry.enabled)
    .map((entry: any) => `关键词「${entry.keyword_primary}」：${entry.content}`)
    .join('\n');
  addPart('世界书', worldText);

  const notes = await db.getNotesByProject(projectId);
  const noteText = notes.map((note) => `笔记「${note.title || '无标题'}」：${note.content}`).join('\n\n');
  addPart('项目笔记', noteText);

  return parts.join('\n\n');
}

async function getPreviousContent(currentChapter: Chapter, config: ContextConfig): Promise<string> {
  const chapters = await db.getChaptersByProject(currentChapter.project_id);
  const previous = chapters.filter((chapter) => chapter.position < currentChapter.position && chapter.content);

  if (config.strategy === 'full') {
    return previous.map((chapter) => chapter.content).join('\n\n');
  }

  if (config.strategy === 'custom') {
    const end = config.customRangeEnd === -1 ? chapters.length : config.customRangeEnd;
    return previous
      .filter((chapter) => chapter.position >= config.customRangeStart && chapter.position < end)
      .map((chapter) => chapter.content)
      .join('\n\n');
  }

  let text = '';
  for (let index = previous.length - 1; index >= 0; index--) {
    const next = `${previous[index].content}\n\n${text}`;
    if (next.length > config.slidingWindowSize) break;
    text = next;
  }
  return text.slice(0, config.slidingWindowSize);
}

async function buildPreviousSummaryContext(projectId: number, beforePosition: number, budget: number): Promise<string> {
  const chapters = await db.getChaptersByProject(projectId);
  return buildSummaryContext(
    chapters.filter((chapter) => chapter.position < beforePosition),
    budget,
  );
}

export function buildSummaryContext(chapters: Chapter[], budget: number): string {
  let remaining = budget;
  const summaries: string[] = [];

  for (const chapter of chapters) {
    if (remaining <= 0) break;
    const summary = chapter.summary_json as ChapterSummary | null;
    if (!summary?.brief) continue;
    let entry = `第 ${chapter.position + 1} 章「${chapter.title}」：${summary.brief}`;
    if (summary.plotPoints?.length) entry += `\n情节：${summary.plotPoints.join('；')}`;
    if (summary.characterStates?.length) entry += `\n人物：${summary.characterStates.join('；')}`;
    entry = entry.slice(0, remaining);
    summaries.push(entry);
    remaining -= entry.length;
  }

  return summaries.join('\n\n');
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

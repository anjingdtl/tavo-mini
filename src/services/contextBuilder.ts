import * as db from './database';
import { processMacros } from './macroReplace';
import { clipTextToTokenBudget, estimateTokens } from '../utils/tokenEstimator';
import type { Chapter, ChapterSummary, ContextConfig, Preset } from '../types/novel';
import type { ChatMessage } from './llm';

const DEFAULT_SYSTEM_PROMPT =
  '你是一位经验丰富的中文小说作者。请根据既有设定、人物状态、章节概要和前文内容，继续创作自然、连贯、有画面感的中文小说。';

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'chapter',
  'return',
  '以下',
  '当前',
  '章节',
  '概要',
  '一个',
  '以及',
  '他们',
  '她们',
]);

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

  const chapters = await db.getChaptersByProject(projectId);
  const memoryText = buildMemoryContext(
    chapters.filter((chapter) => chapter.position < currentChapter.position),
    currentChapter,
    config.memoryTopK ?? 10,
    config.summaryBudgetTokens ?? 20000,
  );
  if (memoryText) {
    messages.push({ role: 'user', content: `以下是历史记忆摘要：\n\n${memoryText}` });
    messages.push({ role: 'assistant', content: '我会参考历史记忆延续剧情。' });
  }

  const prevContent = await getPreviousContent(currentChapter, config, chapters);
  if (prevContent) {
    const processed = await processMacros(prevContent, {
      projectId,
      chapterTitle: currentChapter.title,
      chapterSynopsis: currentChapter.synopsis,
    });
    messages.push({ role: 'user', content: `以下是最近前文正文：\n\n${processed}` });
    messages.push({ role: 'assistant', content: '我已了解最近前文，现在继续创作。' });
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
  const addPart = (title: string, text: string, maxTokens?: number) => {
    if (!text || remaining <= 0) return;
    const clipped = clipTextToTokenBudget(text, Math.min(remaining, maxTokens || remaining));
    if (!clipped) return;
    parts.push(`${title}：\n${clipped}`);
    remaining -= estimateTokens(clipped);
  };

  const characters = await db.getCharactersByProject(projectId);
  const characterText = characters
    .map((character: any) => {
      const data = safeJson(character.data_json);
      const card = data.data || data;
      const text = [
        `角色「${character.name}」`,
        card.description && `描述：${card.description}`,
        card.personality && `性格：${card.personality}`,
        card.mes_example && `对话示例：${card.mes_example}`,
      ]
        .filter(Boolean)
        .join('\n');
      return clipTextToTokenBudget(text, Number(character.max_tokens || 50000));
    })
    .join('\n\n');
  addPart('人物设定', characterText);

  const worldbook = await db.getWorldbookEntriesByProject(projectId);
  const collectionUsage = new Map<number, number>();
  const worldLines: string[] = [];
  for (const entry of worldbook.filter((item: any) => item.enabled && item.collection_enabled !== 0)) {
    const collectionId = Number(entry.collection_id || 0);
    const collectionBudget = Number(entry.collection_max_tokens || 50000);
    const used = collectionUsage.get(collectionId) || 0;
    const remainingForCollection = Math.max(0, collectionBudget - used);
    if (remainingForCollection <= 0) continue;
    const body = clipTextToTokenBudget(entry.content || '', Math.min(Number(entry.max_tokens || 2000), remainingForCollection));
    if (!body) continue;
    collectionUsage.set(collectionId, used + estimateTokens(body));
    worldLines.push(`关键词「${entry.keyword_primary}」：${body}`);
  }
  const worldText = worldLines.join('\n');
  addPart('世界书', worldText);

  const notes = await db.getNotesByProject(projectId);
  const noteText = notes
    .map((note) => `笔记「${note.title || '无标题'}」：${clipTextToTokenBudget(note.content, note.max_tokens || 30000)}`)
    .join('\n\n');
  addPart('项目笔记', noteText);

  return parts.join('\n\n');
}

async function getPreviousContent(
  currentChapter: Chapter,
  config: ContextConfig,
  chapters = [] as Chapter[],
): Promise<string> {
  const allChapters = chapters.length ? chapters : await db.getChaptersByProject(currentChapter.project_id);
  const previous = allChapters
    .filter((chapter) => chapter.position < currentChapter.position && chapter.content)
    .sort((a, b) => a.position - b.position);

  const recentCount = Math.max(1, config.recentChapterCount ?? 3);
  const recent = previous.slice(-recentCount);
  const text = recent.map((chapter) => chapter.content).join('\n\n');
  return clipTextToTokenBudget(text, config.slidingWindowSize || 50000);
}

export function buildMemoryContext(
  previousChapters: Chapter[],
  currentChapter: Chapter,
  topK: number,
  budgetTokens: number,
): string {
  const docs = previousChapters
    .map((chapter) => ({
      chapter,
      text: String((chapter as any).memory_summary || ''),
    }))
    .filter((item) => item.text.trim());

  if (docs.length === 0 || topK <= 0 || budgetTokens <= 0) return '';

  const idf = buildIdf(docs.map((doc) => doc.text));
  const query = `${currentChapter.title}\n${currentChapter.synopsis}\n${currentChapter.content?.slice(0, 500) || ''}`;
  const queryVector = vectorize(query, idf);
  const scored = docs
    .map((doc) => ({
      ...doc,
      score: cosineSimilarity(queryVector, vectorize(doc.text, idf)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const lines: string[] = [];
  let remaining = budgetTokens;
  for (const item of scored) {
    const line = `第 ${item.chapter.position + 1} 章「${item.chapter.title}」摘要：${item.text}`;
    const clipped = clipTextToTokenBudget(line, remaining);
    if (!clipped) break;
    lines.push(clipped);
    remaining -= estimateTokens(clipped);
  }

  return lines.join('\n');
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
    entry = clipTextToTokenBudget(entry, remaining);
    summaries.push(entry);
    remaining -= estimateTokens(entry);
  }

  return summaries.join('\n\n');
}

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^\u4e00-\u9fffa-z0-9_\s]/gi, ' ')
    .split(/\s+/)
    .flatMap((token) => {
      if (/^[\u4e00-\u9fff]+$/.test(token)) return Array.from(token);
      return token;
    })
    .filter((token) => token.length >= 1 && !STOP_WORDS.has(token));
}

function buildIdf(docs: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(tokenize(doc))) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log((docs.length + 1) / (count + 1)) + 1);
  }
  return idf;
}

function vectorize(text: string, idf: Map<string, number>): Map<string, number> {
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
  const maxTf = Math.max(1, ...tf.values());
  const vector = new Map<string, number>();
  for (const [term, count] of tf) {
    vector.set(term, (count / maxTf) * (idf.get(term) || 1));
  }
  return vector;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [key, value] of a) {
    normA += value * value;
    dot += value * (b.get(key) || 0);
  }
  for (const value of b.values()) normB += value * value;
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

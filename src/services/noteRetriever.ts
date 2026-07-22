import * as db from './database';
import { callLLMResult } from './llm';
import { extractJSON } from '../utils/jsonExtractor';

export interface RetrievalQuery {
  chapterTitle: string;
  chapterSynopsis: string;
  previousEnding: string;
  userPrompt: string;
}

export interface RetrievedNoteFragment {
  noteId: number;
  noteTitle: string;
  fragment: string;
  relevance: string;
}

const MAX_CACHE_SIZE = 32;
const cache = new Map<string, RetrievedNoteFragment[]>();

function buildCacheKey(
  projectId: number,
  query: RetrievalQuery,
  fragmentChars: number,
  noteIds: number[],
): string {
  return `${projectId}|${fragmentChars}|${noteIds.join(',')}|${query.chapterTitle}|${query.chapterSynopsis}|${query.previousEnding}|${query.userPrompt}`;
}

export function clearRetrievalCache(projectId?: number): void {
  if (projectId === undefined) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${projectId}|`)) {
      cache.delete(key);
    }
  }
}

function tokenize(text: string): string[] {
  const words = text
    .replace(/[\s，。、！？；：""''（）【】《》\-—…,.!?;:"'()]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
  // 中文没有空格时，整句不能直接作为关键词。补充 2～6 字切片，
  // 使“主角在雨夜抵达钟楼”能命中笔记中的“雨夜”或“钟楼”。
  const chineseTerms: string[] = [];
  for (const word of words) {
    if (!/^[\u4e00-\u9fff]+$/.test(word)) continue;
    for (let length = 2; length <= Math.min(6, word.length); length += 1) {
      for (let start = 0; start <= word.length - length; start += 1)
        chineseTerms.push(word.slice(start, start + length));
    }
  }
  return Array.from(new Set([...words, ...chineseTerms]));
}

function extractContextWindow(
  content: string,
  keyword: string,
  radius = 500,
): string {
  // 大小写敏感修复：query 与 note 内容大小写不一致时（如英文专有名词）漏匹配
  const lowerContent = content.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const idx = lowerContent.indexOf(lowerKeyword);
  if (idx === -1) return '';
  const start = Math.max(0, idx - radius);
  const end = Math.min(content.length, idx + keyword.length + radius);
  return content.slice(start, end);
}

interface PrefilterResult {
  noteId: number;
  noteTitle: string;
  fragments: string[];
}

async function prefilterNotes(
  noteIds: number[],
  query: RetrievalQuery,
  fragmentChars: number,
): Promise<PrefilterResult[]> {
  const queryText = `${query.chapterTitle} ${query.chapterSynopsis} ${query.previousEnding} ${query.userPrompt}`;
  const keywords = Array.from(new Set(tokenize(queryText)));
  const results: PrefilterResult[] = [];

  const allNotes = await db.getAllNotes();
  for (const noteId of noteIds) {
    const note = allNotes.find((n: any) => n.id === noteId);
    if (!note) continue;
    const content = await db.getNoteContentById(noteId);
    const title = note.title || '无标题';
    const fragments: string[] = [];
    for (const kw of keywords) {
      const radius = Math.max(0, Math.floor((fragmentChars - kw.length) / 2));
      const ctx = extractContextWindow(content, kw, radius);
      if (ctx) fragments.push(ctx);
    }
    if (fragments.length > 0) {
      results.push({
        noteId,
        noteTitle: title,
        fragments: fragments.slice(0, 3),
      });
    }
  }
  return results;
}

// 缓存检索时固定向 LLM 请求较大数量，避免不同 topK 请求间缓存无法复用：
// 首次 topK=3 时 LLM 只返回 3 条并缓存，后续 topK=5 时 cached.slice(0,5)
// 仍只能拿到 3 条。这里固定请求 LIMIT_FOR_CACHE 条，缓存完整结果，读取时再 slice。
const LIMIT_FOR_CACHE = 10;

export async function retrieveNoteFragments(
  projectId: number,
  query: RetrievalQuery,
  topK: number,
): Promise<RetrievedNoteFragment[]> {
  const config = await db.getProjectNoteConfig(projectId);
  const fragmentChars = Math.min(
    4000,
    Math.max(200, Number(config?.retrievalFragmentChars) || 1000),
  );
  const projectNotes = await db.getNotesByProject(projectId);
  const eligibleIds = projectNotes.map((note: any) => Number(note.id));
  const eligibleSet = new Set(eligibleIds);
  const configuredIds = Array.isArray(config?.enabledNoteIds)
    ? config.enabledNoteIds.map(Number)
    : [];
  const noteIds =
    configuredIds.length > 0
      ? configuredIds.filter((id: number) => eligibleSet.has(id))
      : eligibleIds;
  if (noteIds.length === 0) return [];

  // 参与名单是缓存身份的一部分，切换项目开关或选择笔记后不能复用旧结果。
  const cacheKey = buildCacheKey(projectId, query, fragmentChars, noteIds);
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached.slice(0, topK);
  }

  const candidates = await prefilterNotes(noteIds, query, fragmentChars);
  if (candidates.length === 0) return [];

  const fragmentText = candidates
    .map(c =>
      c.fragments
        .map((f, i) => `[笔记${c.noteId}「${c.noteTitle}」片段${i + 1}] ${f}`)
        .join('\n'),
    )
    .join('\n\n');

  const systemPrompt = `你是写作素材检索助手。根据当前章节的生成需求，从提供的笔记片段中选择最相关、最值得引用的片段。只返回 JSON，不要解释。`;
  const userPrompt = `当前章节标题：${query.chapterTitle}
章节概要：${query.chapterSynopsis}
前文结尾：${query.previousEnding}
本次生成指令：${query.userPrompt}

可选笔记片段：
${fragmentText}

返回格式：{"selected":[{"noteId":1,"noteTitle":"标题","fragment":"原文片段","relevance":"相关性说明"}]}
最多返回 ${LIMIT_FOR_CACHE} 条。`;

  let fragments: RetrievedNoteFragment[];
  try {
    const result = await callLLMResult(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      2000,
      { scenario: 'note_retrieve', temperature: 0.3, projectId },
    );
    const jsonStr = extractJSON(result.text || '') || '{"selected":[]}';
    const parsed = JSON.parse(jsonStr);
    fragments = (parsed.selected || []).map((item: any) => ({
      noteId: Number(item.noteId),
      noteTitle: String(item.noteTitle || ''),
      fragment: String(item.fragment || '').slice(0, fragmentChars),
      relevance: String(item.relevance || ''),
    }));
  } catch {
    // 回退到关键词预筛结果
    fragments = candidates.slice(0, topK).map(c => ({
      noteId: c.noteId,
      noteTitle: c.noteTitle,
      fragment: c.fragments[0] || '',
      relevance: '关键词匹配回退',
    }));
  }

  // LRU 淘汰
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(cacheKey, fragments);
  return fragments.slice(0, topK);
}

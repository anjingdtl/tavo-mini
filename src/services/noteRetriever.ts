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

function buildCacheKey(projectId: number, query: RetrievalQuery): string {
  // 不含 userPrompt：同一章节的多次生成（pipeline 四阶段）复用同一次检索
  return `${projectId}|${query.chapterTitle}|${query.chapterSynopsis}|${query.previousEnding}`;
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
  return text
    .replace(/[\s，。、！？；：""''（）【】《》\-—…,.!?;:"'()]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function extractContextWindow(content: string, keyword: string, radius = 500): string {
  const idx = content.indexOf(keyword);
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
): Promise<PrefilterResult[]> {
  const queryText = `${query.chapterTitle} ${query.chapterSynopsis} ${query.userPrompt}`;
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
      const ctx = extractContextWindow(content, kw);
      if (ctx) fragments.push(ctx);
    }
    if (fragments.length > 0) {
      results.push({ noteId, noteTitle: title, fragments: fragments.slice(0, 3) });
    }
  }
  return results;
}

export async function retrieveNoteFragments(
  projectId: number,
  query: RetrievalQuery,
  topK: number,
): Promise<RetrievedNoteFragment[]> {
  const cacheKey = buildCacheKey(projectId, query);
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached.slice(0, topK);
  }

  const config = await db.getProjectNoteConfig(projectId);
  let noteIds: number[] = [];
  if (config && config.enabledNoteIds.length > 0) {
    noteIds = config.enabledNoteIds;
  } else {
    const projectNotes = await db.getNotesByProject(projectId);
    noteIds = projectNotes.map((n: any) => n.id);
  }
  if (noteIds.length === 0) return [];

  const candidates = await prefilterNotes(noteIds, query);
  if (candidates.length === 0) return [];

  const fragmentText = candidates
    .map((c) => c.fragments.map((f, i) => `[笔记${c.noteId}「${c.noteTitle}」片段${i + 1}] ${f}`).join('\n'))
    .join('\n\n');

  const systemPrompt = `你是写作素材检索助手。根据当前章节的生成需求，从提供的笔记片段中选择最相关、最值得引用的片段。只返回 JSON，不要解释。`;
  const userPrompt = `当前章节标题：${query.chapterTitle}
章节概要：${query.chapterSynopsis}
前文结尾：${query.previousEnding}
本次生成指令：${query.userPrompt}

可选笔记片段：
${fragmentText}

返回格式：{"selected":[{"noteId":1,"noteTitle":"标题","fragment":"原文片段","relevance":"相关性说明"}]}
最多返回 ${topK} 条。`;

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
      fragment: String(item.fragment || ''),
      relevance: String(item.relevance || ''),
    }));
  } catch {
    // 回退到关键词预筛结果
    fragments = candidates.slice(0, topK).map((c) => ({
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

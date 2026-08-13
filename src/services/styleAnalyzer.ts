import * as db from './database';
import { callLLMResult } from './llm';
import {
  buildStyleProfileText,
  parseStyleProfileJson,
  type StyleProfile,
} from './noteSemantics';

export {
  buildStyleProfileText,
  DEFAULT_STYLE_WEIGHTS,
  mergeStyleProfiles,
  normalizeStyleWeights,
  parseStyleProfileJson,
  resolveStyleWeights,
} from './noteSemantics';
export type { StyleElements, StyleProfile, StyleWeights } from './noteSemantics';

const ANALYZE_SYSTEM_PROMPT = `你是文学风格分析专家。分析以下文本的写作风格，从五个维度提取特征：句式结构、语气与情感倾向、常用词汇与搭配、角色设定（叙述视角/口吻/身份）、叙事节奏。每个维度给出具体、可操作的描述，便于另一作者据此仿写。

只返回 JSON，格式如下：
{"sentence_structure":"...","tone_emotion":"...","vocabulary":"...","character_voice":"...","narrative_rhythm":"..."}`;

// 分析单条笔记，结果缓存到 note_style_profiles
export async function analyzeNoteStyle(noteId: number): Promise<StyleProfile> {
  const content = await db.getNoteContentById(noteId);
  // 空内容校验修复：空串发往 LLM 返回噪声，parseProfileJson 解析出空 elements
  // 污染 note_style_profiles 缓存
  if (!content || !content.trim()) {
    throw new Error('笔记内容为空，无法分析风格。');
  }
  const sourceHash = await db.computeNoteSourceHash(content);
  return analyzeNoteStyleFromContent(noteId, content, sourceHash);
}

/**
 * Analyze an already-loaded body.  Snapshot capture uses this overload so a
 * cache miss never causes the analyzer to re-read a live Note after the
 * frozen body has been selected.
 */
export async function analyzeNoteStyleFromContent(
  noteId: number,
  content: string,
  sourceHash?: string,
): Promise<StyleProfile> {
  if (!content || !content.trim()) {
    throw new Error('笔记内容为空，无法分析风格。');
  }
  const resolvedSourceHash =
    sourceHash ?? (await db.computeNoteSourceHash(content));

  const result = await callLLMResult(
    [
      { role: 'system', content: ANALYZE_SYSTEM_PROMPT },
      { role: 'user', content: content.slice(0, 50000) },
    ],
    2000,
    { scenario: 'style_analyze', temperature: 0.4 },
  );

  const profileJson = parseStyleProfileJson(result.text || '');
  const profileText = buildStyleProfileText(profileJson);
  await db.setNoteStyleProfile(
    noteId,
    profileText,
    JSON.stringify(profileJson),
    resolvedSourceHash,
  );
  return { profileText, profileJson, sourceHash: resolvedSourceHash };
}

// 读取缓存（含 hash 校验），若失效则自动重新分析
export async function getOrAnalyzeNoteStyle(noteId: number): Promise<StyleProfile> {
  const cached = await db.getNoteStyleProfile(noteId);
  const content = await db.getNoteContentById(noteId);
  const currentHash = await db.computeNoteSourceHash(content);

  if (cached && cached.sourceHash === currentHash && cached.profileText) {
    return {
      profileText: cached.profileText,
      profileJson: parseStyleProfileJson(cached.profileJson),
      sourceHash: cached.sourceHash,
    };
  }

  return analyzeNoteStyle(noteId);
}

// 批量分析多条笔记
export async function analyzeNotesStyle(noteIds: number[]): Promise<StyleProfile[]> {
  return Promise.all(noteIds.map(id => analyzeNoteStyle(id)));
}

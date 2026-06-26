import * as db from './database';
import { callLLMResult } from './llm';
import { extractJSON } from '../utils/jsonExtractor';

export interface StyleElements {
  sentence_structure: string;
  tone_emotion: string;
  vocabulary: string;
  character_voice: string;
  narrative_rhythm: string;
}

export interface StyleProfile {
  profileText: string;
  profileJson: StyleElements;
  sourceHash: string;
}

export type StyleWeights = Record<
  'sentence_structure' | 'tone_emotion' | 'vocabulary' | 'character_voice' | 'narrative_rhythm',
  number
>;

export const DEFAULT_STYLE_WEIGHTS: StyleWeights = {
  sentence_structure: 2,
  tone_emotion: 2,
  vocabulary: 1,
  character_voice: 2,
  narrative_rhythm: 2,
};

const ANALYZE_SYSTEM_PROMPT = `你是文学风格分析专家。分析以下文本的写作风格，从五个维度提取特征：句式结构、语气与情感倾向、常用词汇与搭配、角色设定（叙述视角/口吻/身份）、叙事节奏。每个维度给出具体、可操作的描述，便于另一作者据此仿写。

只返回 JSON，格式如下：
{"sentence_structure":"...","tone_emotion":"...","vocabulary":"...","character_voice":"...","narrative_rhythm":"..."}`;

const EMPTY_ELEMENTS: StyleElements = {
  sentence_structure: '',
  tone_emotion: '',
  vocabulary: '',
  character_voice: '',
  narrative_rhythm: '',
};

function parseProfileJson(text: string): StyleElements {
  const jsonStr = extractJSON(text) || '{}';
  try {
    const parsed = JSON.parse(jsonStr);
    return {
      sentence_structure: String(parsed.sentence_structure || ''),
      tone_emotion: String(parsed.tone_emotion || ''),
      vocabulary: String(parsed.vocabulary || ''),
      character_voice: String(parsed.character_voice || ''),
      narrative_rhythm: String(parsed.narrative_rhythm || ''),
    };
  } catch {
    return { ...EMPTY_ELEMENTS };
  }
}

const DIMENSION_LABELS: Record<keyof StyleElements, string> = {
  sentence_structure: '句式结构',
  tone_emotion: '语气与情感',
  vocabulary: '常用词汇与搭配',
  character_voice: '角色设定（叙述视角/口吻/身份）',
  narrative_rhythm: '叙事节奏',
};

function buildProfileText(elements: StyleElements): string {
  const parts: string[] = [];
  for (const key of Object.keys(DIMENSION_LABELS) as (keyof StyleElements)[]) {
    const val = elements[key];
    if (val && val.trim()) {
      parts.push(`【${DIMENSION_LABELS[key]}】${val.trim()}`);
    }
  }
  return parts.join('\n');
}

// 分析单条笔记，结果缓存到 note_style_profiles
export async function analyzeNoteStyle(noteId: number): Promise<StyleProfile> {
  const content = await db.getNoteContentById(noteId);
  // 空内容校验修复：空串发往 LLM 返回噪声，parseProfileJson 解析出空 elements
  // 污染 note_style_profiles 缓存
  if (!content || !content.trim()) {
    throw new Error('笔记内容为空，无法分析风格。');
  }
  const sourceHash = await db.computeNoteSourceHash(content);

  const result = await callLLMResult(
    [
      { role: 'system', content: ANALYZE_SYSTEM_PROMPT },
      { role: 'user', content: content.slice(0, 50000) },
    ],
    2000,
    { scenario: 'style_analyze', temperature: 0.4 },
  );

  const profileJson = parseProfileJson(result.text || '');
  const profileText = buildProfileText(profileJson);
  await db.setNoteStyleProfile(noteId, profileText, JSON.stringify(profileJson), sourceHash);
  return { profileText, profileJson, sourceHash };
}

// 读取缓存（含 hash 校验），若失效则自动重新分析
export async function getOrAnalyzeNoteStyle(noteId: number): Promise<StyleProfile> {
  const cached = await db.getNoteStyleProfile(noteId);
  const content = await db.getNoteContentById(noteId);
  const currentHash = await db.computeNoteSourceHash(content);

  if (cached && cached.sourceHash === currentHash && cached.profileText) {
    return {
      profileText: cached.profileText,
      profileJson: parseProfileJson(cached.profileJson),
      sourceHash: cached.sourceHash,
    };
  }

  return analyzeNoteStyle(noteId);
}

// 批量分析多条笔记
export async function analyzeNotesStyle(noteIds: number[]): Promise<StyleProfile[]> {
  return Promise.all(noteIds.map((id) => analyzeNoteStyle(id)));
}

const WEIGHT_LABELS: Record<number, string> = {
  0: '忽略',
  1: '适当参考',
  2: '遵循',
  3: '严格遵循',
};

// 聚合多条笔记的画像为"联合风格画像"（跨文档联合参考仿写）
export function mergeStyleProfiles(profiles: StyleProfile[], weights: StyleWeights): string {
  const dimensionMap: Record<keyof StyleWeights, string[]> = {
    sentence_structure: [],
    tone_emotion: [],
    vocabulary: [],
    character_voice: [],
    narrative_rhythm: [],
  };

  for (const profile of profiles) {
    for (const key of Object.keys(dimensionMap) as (keyof StyleWeights)[]) {
      const val = profile.profileJson[key];
      if (val && val.trim()) {
        dimensionMap[key].push(val.trim());
      }
    }
  }

  const parts: string[] = [];
  for (const key of Object.keys(dimensionMap) as (keyof StyleWeights)[]) {
    const weight = weights[key] ?? 0;
    if (weight === 0) continue;
    const values = dimensionMap[key];
    if (values.length === 0) continue;
    const instruction = WEIGHT_LABELS[weight] || '遵循';
    parts.push(`【${DIMENSION_LABELS[key]}】（${instruction}）${values.join(' / ')}`);
  }

  return parts.join('\n');
}

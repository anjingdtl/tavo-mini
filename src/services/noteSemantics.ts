import { extractJSON } from '../utils/jsonExtractor';

/**
 * Pure Note semantics shared by the legacy V6 path and the V7 frozen path.
 *
 * This module deliberately has no database, repository, LLM, or React
 * dependency.  The legacy services use it after loading live rows; V7 uses
 * the same functions after loading a ResourceSourceSnapshot.
 */

export const NOTE_STYLE_DIMENSIONS = [
  'sentence_structure',
  'tone_emotion',
  'vocabulary',
  'character_voice',
  'narrative_rhythm',
] as const;

export type NoteStyleDimension = (typeof NOTE_STYLE_DIMENSIONS)[number];

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

export type StyleWeights = Record<NoteStyleDimension, number>;

export const DEFAULT_STYLE_WEIGHTS: StyleWeights = {
  sentence_structure: 2,
  tone_emotion: 2,
  vocabulary: 1,
  character_voice: 2,
  narrative_rhythm: 2,
};

const STYLE_DIMENSION_LABELS: Record<NoteStyleDimension, string> = {
  sentence_structure: '句式结构',
  tone_emotion: '语气与情感',
  vocabulary: '常用词汇与搭配',
  character_voice: '角色设定（叙述视角/口吻/身份）',
  narrative_rhythm: '叙事节奏',
};

const STYLE_WEIGHT_LABELS: Record<number, string> = {
  0: '忽略',
  1: '适当参考',
  2: '遵循',
  3: '严格遵循',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Normalize a persisted profile exactly as the legacy analyzer did. */
export function parseStyleProfileJson(input: unknown): StyleElements {
  const jsonText =
    typeof input === 'string'
      ? extractJSON(input) || '{}'
      : JSON.stringify(input || {});
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = {};
  }
  const record = asRecord(parsed);
  return {
    sentence_structure: String(record.sentence_structure || ''),
    tone_emotion: String(record.tone_emotion || ''),
    vocabulary: String(record.vocabulary || ''),
    character_voice: String(record.character_voice || ''),
    narrative_rhythm: String(record.narrative_rhythm || ''),
  };
}

export function buildStyleProfileText(elements: StyleElements): string {
  return NOTE_STYLE_DIMENSIONS.map(key => {
    const value = elements[key];
    return value && value.trim()
      ? `【${STYLE_DIMENSION_LABELS[key]}】${value.trim()}`
      : '';
  })
    .filter(Boolean)
    .join('\n');
}

/** Keep the repository's permissive finite-number normalization. */
export function normalizeStyleWeights(value: unknown): Record<string, number> {
  const record = asRecord(value);
  const normalized: Record<string, number> = {};
  for (const [key, weight] of Object.entries(record)) {
    if (typeof weight === 'number' && Number.isFinite(weight)) {
      normalized[key] = weight;
    }
  }
  return normalized;
}

export function resolveStyleWeights(value: unknown): StyleWeights {
  return {
    ...DEFAULT_STYLE_WEIGHTS,
    ...normalizeStyleWeights(value),
  } as StyleWeights;
}

/**
 * Legacy V6 joint-profile merge.  Weight 0 omits a dimension; weights 1–3
 * change the instruction strength and all other finite values retain the
 * legacy generic "遵循" label.
 */
export function mergeStyleProfiles(
  profiles: StyleProfile[],
  weights: StyleWeights | Record<string, number>,
): string {
  const dimensionMap: Record<NoteStyleDimension, string[]> = {
    sentence_structure: [],
    tone_emotion: [],
    vocabulary: [],
    character_voice: [],
    narrative_rhythm: [],
  };

  for (const profile of profiles) {
    for (const key of NOTE_STYLE_DIMENSIONS) {
      const value = profile.profileJson[key];
      if (value && value.trim()) dimensionMap[key].push(value.trim());
    }
  }

  return NOTE_STYLE_DIMENSIONS.map(key => {
    const weight = weights[key] ?? 0;
    if (weight === 0 || dimensionMap[key].length === 0) return '';
    const instruction = STYLE_WEIGHT_LABELS[weight] || '遵循';
    return `【${STYLE_DIMENSION_LABELS[key]}】（${instruction}）${dimensionMap[
      key
    ].join(' / ')}`;
  })
    .filter(Boolean)
    .join('\n');
}

/** Same non-cryptographic source hash used by note_style_profiles. */
export function computeNoteSourceHash(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    const char = content.charCodeAt(index);
    hash = (hash << 5) - hash + char;
    hash &= hash;
  }
  return (
    Math.abs(hash).toString(16).padStart(8, '0') +
    '_' +
    content.length.toString(16)
  );
}

export interface NoteRetrievalQuery {
  chapterTitle: string;
  chapterSynopsis: string;
  previousEnding: string;
  userPrompt: string;
}

export interface FrozenNoteCorpusEntry {
  noteId: number;
  noteTitle: string;
  content: string;
}

export interface NotePrefilterResult {
  noteId: number;
  noteTitle: string;
  fragments: string[];
  matchedTerms: string[];
  score: number;
}

export interface RetrievedNoteFragment {
  noteId: number;
  noteTitle: string;
  fragment: string;
  relevance: string;
  /** Deterministic prefilter score used only for V7 item allocation. */
  retrievalScore?: number;
}

export const NOTE_RETRIEVAL_LIMIT_FOR_CACHE = 10;

function tokenize(text: string): string[] {
  const words = text
    .replace(/[\s，。、！？；：""''（）【】《》\-—…,.!?;:"'()]/g, ' ')
    .split(/\s+/)
    .filter(term => term.length >= 2);
  const chineseTerms: string[] = [];
  for (const word of words) {
    if (!/^[\u4e00-\u9fff]+$/.test(word)) continue;
    for (let length = 2; length <= Math.min(6, word.length); length += 1) {
      for (let start = 0; start <= word.length - length; start += 1) {
        chineseTerms.push(word.slice(start, start + length));
      }
    }
  }
  return Array.from(new Set([...words, ...chineseTerms]));
}

function countOccurrences(text: string, term: string): number {
  const source = text.toLocaleLowerCase();
  const needle = term.toLocaleLowerCase();
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= source.length) {
    const index = source.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + Math.max(1, needle.length);
  }
  return count;
}

export function extractNoteContextWindow(
  content: string,
  keyword: string,
  radius = 500,
): string {
  const lowerContent = content.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const index = lowerContent.indexOf(lowerKeyword);
  if (index === -1) return '';
  const start = Math.max(0, index - radius);
  const end = Math.min(content.length, index + keyword.length + radius);
  return content.slice(start, end);
}

export function normalizeRetrievalFragmentChars(value: unknown): number {
  const parsed = Number(value);
  return Math.min(
    4000,
    Math.max(200, parsed || 1000),
  );
}

export function filterFrozenNoteCorpus(
  notes: FrozenNoteCorpusEntry[],
  enabledNoteIds?: number[],
): FrozenNoteCorpusEntry[] {
  const ids = Array.isArray(enabledNoteIds)
    ? enabledNoteIds.map(Number).filter(Number.isSafeInteger)
    : [];
  if (ids.length === 0) return notes;
  const enabled = new Set(ids);
  return notes.filter(note => enabled.has(note.noteId));
}

/**
 * The legacy Note Retriever's deterministic candidate phase.  It is shared
 * by V6 live retrieval and V7 frozen retrieval; no scoring-based re-ranking
 * or full-body replacement happens here.
 */
export function prefilterFrozenNoteFragments(
  corpus: FrozenNoteCorpusEntry[],
  query: NoteRetrievalQuery,
  fragmentChars: number,
): NotePrefilterResult[] {
  const queryText = `${query.chapterTitle} ${query.chapterSynopsis} ${query.previousEnding} ${query.userPrompt}`;
  const keywords = tokenize(queryText);
  const results: NotePrefilterResult[] = [];

  for (const note of corpus) {
    if (!note.content) continue;
    const fragments: string[] = [];
    for (const keyword of keywords) {
      const radius = Math.max(
        0,
        Math.floor((fragmentChars - keyword.length) / 2),
      );
      const context = extractNoteContextWindow(note.content, keyword, radius);
      if (context) fragments.push(context);
    }
    if (fragments.length === 0) continue;
    const matchedTerms = keywords.filter(keyword =>
      countOccurrences(note.content, keyword) > 0,
    );
    const hits = matchedTerms.reduce(
      (sum, keyword) => sum + countOccurrences(note.content, keyword),
      0,
    );
    results.push({
      noteId: note.noteId,
      noteTitle: note.noteTitle,
      fragments: fragments.slice(0, 3),
      matchedTerms,
      score: Math.min(1, hits / Math.max(1, keywords.length)),
    });
  }
  return results;
}

export function fallbackToFrozenNoteCandidates(
  candidates: NotePrefilterResult[],
  topK: number,
): RetrievedNoteFragment[] {
  return candidates.slice(0, topK).map(candidate => ({
    noteId: candidate.noteId,
    noteTitle: candidate.noteTitle,
    fragment: candidate.fragments[0] || '',
    relevance: '关键词匹配回退',
    retrievalScore: candidate.score,
  }));
}

/**
 * Validate model output against the exact candidate windows.  This preserves
 * the legacy anti-hallucination rule for both live and frozen corpora.
 */
export function validateFrozenNoteFragments(
  selected: unknown,
  candidates: NotePrefilterResult[],
  fragmentChars: number,
): RetrievedNoteFragment[] {
  if (!Array.isArray(selected)) return [];
  const candidateById = new Map(candidates.map(item => [item.noteId, item]));
  const seenIds = new Set<number>();
  const valid: RetrievedNoteFragment[] = [];
  for (const item of selected) {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const noteId = Number(record.noteId);
    const candidate = candidateById.get(noteId);
    if (!candidate || seenIds.has(noteId)) continue;
    const requestedFragment = String(record.fragment || '').trim();
    const sourceFragment = candidate.fragments.find(fragment =>
      requestedFragment ? fragment.includes(requestedFragment) : false,
    );
    if (!sourceFragment) continue;
    seenIds.add(noteId);
    valid.push({
      noteId,
      noteTitle: candidate.noteTitle,
      fragment: requestedFragment.slice(0, fragmentChars),
      relevance: String(record.relevance || ''),
      retrievalScore: candidate.score,
    });
  }
  return valid;
}

export function buildNoteRetrievalMessages(
  query: NoteRetrievalQuery,
  candidates: NotePrefilterResult[],
): Array<{ role: 'system' | 'user'; content: string }> {
  const fragmentText = candidates
    .map(candidate =>
      candidate.fragments
        .map(
          (fragment, index) =>
            `[笔记${candidate.noteId}「${candidate.noteTitle}」片段${index + 1}] ${fragment}`,
        )
        .join('\n'),
    )
    .join('\n\n');
  const systemPrompt =
    '你是写作素材检索助手。根据当前章节的生成需求，从提供的笔记片段中选择最相关、最值得引用的片段。只返回 JSON，不要解释。';
  const userPrompt = `当前章节标题：${query.chapterTitle}
章节概要：${query.chapterSynopsis}
前文结尾：${query.previousEnding}
本次生成指令：${query.userPrompt}

可选笔记片段：
${fragmentText}

返回格式：{"selected":[{"noteId":1,"noteTitle":"标题","fragment":"原文片段","relevance":"相关性说明"}]}
最多返回 ${NOTE_RETRIEVAL_LIMIT_FOR_CACHE} 条。`;
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

export function noteRetrievalQueryFingerprint(query: NoteRetrievalQuery): string {
  return [
    query.chapterTitle,
    query.chapterSynopsis,
    query.previousEnding,
    query.userPrompt,
  ].join('\u001f');
}

export function sameNoteRetrievalQuery(
  left: NoteRetrievalQuery,
  right: NoteRetrievalQuery,
): boolean {
  return noteRetrievalQueryFingerprint(left) === noteRetrievalQueryFingerprint(right);
}

/** Numeric annotation for the allocator; it never chooses or reorders notes. */
export function scoreFrozenNoteCandidate(candidate: NotePrefilterResult): number {
  return candidate.score;
}

/**
 * Episodic memory retrieval helpers (V2.5.8+).
 * Pure functions only — no DB access, no Story Memory rebuild, no message assembly.
 */

import type { Chapter } from '../types/novel';
import {
  clipTextToTokenBudget,
  estimateTokens,
} from '../utils/tokenEstimator';
import type { StoryMemoryState } from './storyMemory/storyMemoryTypes';

/** Feature flag: set false to restore legacy TF-IDF Top-K only. */
export const EPISODIC_RETRIEVAL_V2_ENABLED = true;

export const CHARACTER_NAME_BOOST = 0.22;
export const CHARACTER_ALIAS_BOOST = 0.12;
export const OBJECT_OR_THREAD_BOOST = 0.1;
export const CHARACTER_PAIR_BOOST = 0.28;

export const MAX_CHARACTER_BOOST = 0.44;
export const MAX_ALIAS_BOOST = 0.24;
export const MAX_OBJECT_THREAD_BOOST = 0.2;

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

const MIN_OBJECT_THREAD_TERM_LENGTH = 2;

export interface EpisodicRetrievalQueryInput {
  currentChapter: Chapter;
  previousChapter?: Chapter | null;
  retrievalUserPrompt?: string;
}

export interface MemoryRetrievalOptions {
  queryText?: string;
  storyState?: StoryMemoryState | null;
}

export interface StoryRetrievalTerms {
  canonicalCharacterNames: string[];
  aliases: string[];
  objectTerms: string[];
  threadTerms: string[];
  /** alias → one or more canonical names (shared aliases keep all owners) */
  aliasToCanonicalNames: Record<string, string[]>;
  /** aliases owned by more than one character; never auto-activate */
  ambiguousAliases: string[];
}

export interface ActiveStoryTerms {
  canonicalCharacterNames: string[];
  aliases: string[];
  objectTerms: string[];
  threadTerms: string[];
  /** Active characters by canonical name (deduped) */
  activeCharacterNames: string[];
  /** Unambiguous alias hits that map to a single canonical name */
  aliasHits: Array<{ alias: string; canonicalName: string }>;
}

export interface ScoredMemoryCandidate {
  chapter: Chapter;
  text: string;
  cosineScore: number;
  entityBoost: number;
  pairBoost: number;
  finalScore: number;
  matchedCharacters: string[];
  matchedObjects: string[];
  matchedThreads: string[];
}

export interface EpisodicRetrievalOptions {
  queryText: string;
  storyState?: StoryMemoryState | null;
  topK: number;
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = String(raw || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function includesInsensitive(haystack: string, needle: string): boolean {
  if (!needle) return false;
  if (!/[a-zA-Z]/.test(needle)) {
    return haystack.includes(needle);
  }
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function buildEpisodicRetrievalQuery(
  input: EpisodicRetrievalQueryInput,
): string {
  const { currentChapter, previousChapter, retrievalUserPrompt } = input;
  return [
    currentChapter.title,
    currentChapter.synopsis,
    retrievalUserPrompt,
    currentChapter.content?.slice(0, 800),
    previousChapter?.content?.slice(-800),
  ]
    .filter(Boolean)
    .join('\n');
}

export function resolvePreviousChapterForQuery(
  previousChapters: Chapter[],
  currentChapter: Chapter,
): Chapter | null {
  const candidates = previousChapters
    .filter(
      chapter =>
        chapter.position < currentChapter.position &&
        Boolean(chapter.content && String(chapter.content).trim()),
    )
    .sort((a, b) => b.position - a.position);
  return candidates[0] ?? null;
}

function tokenizeChineseRun(run: string): string[] {
  const chars = Array.from(run);
  const tokens: string[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    tokens.push(chars[index]);
    if (index + 1 < chars.length) {
      tokens.push(chars[index] + chars[index + 1]);
    }
    if (index + 2 < chars.length) {
      tokens.push(chars[index] + chars[index + 1] + chars[index + 2]);
    }
  }
  return tokens;
}

/**
 * Chinese unigram + bigram + trigram; keep English/number/_ tokens intact.
 */
export function tokenizeForMemoryRetrieval(text: string): string[] {
  const normalized = (text || '')
    .toLowerCase()
    .replace(/[^\u4e00-\u9fffa-z0-9_\s]/gi, ' ');

  const tokens: string[] = [];
  const runPattern = /[\u4e00-\u9fff]+|[a-z0-9_]+/g;
  let match: RegExpExecArray | null;
  while ((match = runPattern.exec(normalized)) !== null) {
    const run = match[0];
    if (/^[\u4e00-\u9fff]+$/.test(run)) {
      tokens.push(...tokenizeChineseRun(run));
    } else if (run.length >= 1) {
      tokens.push(run);
    }
  }
  return tokens.filter(token => token.length >= 1 && !STOP_WORDS.has(token));
}

export function collectStoryRetrievalTerms(
  state?: StoryMemoryState | null,
): StoryRetrievalTerms {
  const empty: StoryRetrievalTerms = {
    canonicalCharacterNames: [],
    aliases: [],
    objectTerms: [],
    threadTerms: [],
    aliasToCanonicalNames: {},
    ambiguousAliases: [],
  };
  if (!state) return empty;

  try {
    const canonicalCharacterNames: string[] = [];
    const aliases: string[] = [];
    const objectTerms: string[] = [];
    const threadTerms: string[] = [];
    const aliasOwners = new Map<string, string[]>();

    for (const character of Object.values(state.characters || {})) {
      const name = String(character.canonicalName || '').trim();
      if (name) canonicalCharacterNames.push(name);
      for (const alias of character.aliases || []) {
        const a = String(alias || '').trim();
        if (!a || !name) continue;
        aliases.push(a);
        const owners = aliasOwners.get(a) || [];
        if (!owners.includes(name)) {
          owners.push(name);
          aliasOwners.set(a, owners);
        }
      }
      for (const item of character.currentState?.possessions || []) {
        const term = String(item || '').trim();
        if (term.length >= MIN_OBJECT_THREAD_TERM_LENGTH) {
          objectTerms.push(term);
        }
      }
    }

    for (const thread of Object.values(state.mainline?.openThreads || {})) {
      const title = String(thread.title || '').trim();
      if (title.length >= MIN_OBJECT_THREAD_TERM_LENGTH) {
        threadTerms.push(title);
      }
    }
    for (const foreshadow of Object.values(state.mainline?.foreshadowing || {})) {
      const setup = String(foreshadow.setup || '').trim();
      if (setup.length >= MIN_OBJECT_THREAD_TERM_LENGTH) {
        threadTerms.push(setup);
      }
    }

    const aliasToCanonicalNames: Record<string, string[]> = {};
    const ambiguousAliases: string[] = [];
    for (const [alias, owners] of aliasOwners) {
      aliasToCanonicalNames[alias] = owners;
      if (owners.length > 1) {
        ambiguousAliases.push(alias);
      }
    }

    return {
      canonicalCharacterNames: uniqueNonEmpty(canonicalCharacterNames),
      aliases: uniqueNonEmpty(aliases),
      objectTerms: uniqueNonEmpty(objectTerms),
      threadTerms: uniqueNonEmpty(threadTerms),
      aliasToCanonicalNames,
      ambiguousAliases,
    };
  } catch {
    return empty;
  }
}

export function findActiveStoryTerms(
  queryText: string,
  terms: StoryRetrievalTerms,
): ActiveStoryTerms {
  const query = queryText || '';
  const ambiguous = new Set(terms.ambiguousAliases || []);
  const canonicalCharacterNames = terms.canonicalCharacterNames.filter(name =>
    includesInsensitive(query, name),
  );
  const aliasHits: Array<{ alias: string; canonicalName: string }> = [];
  const aliases: string[] = [];
  for (const alias of terms.aliases) {
    if (!includesInsensitive(query, alias)) continue;
    // Shared titles like 队长/师父 must not auto-activate any character.
    if (ambiguous.has(alias)) continue;
    const owners = terms.aliasToCanonicalNames[alias] || [];
    if (owners.length !== 1) continue;
    aliases.push(alias);
    aliasHits.push({ alias, canonicalName: owners[0] });
  }
  const objectTerms = terms.objectTerms.filter(term =>
    includesInsensitive(query, term),
  );
  const threadTerms = terms.threadTerms.filter(term =>
    includesInsensitive(query, term),
  );

  const activeCharacterNames = uniqueNonEmpty([
    ...canonicalCharacterNames,
    ...aliasHits.map(hit => hit.canonicalName),
  ]);

  return {
    canonicalCharacterNames,
    aliases,
    objectTerms,
    threadTerms,
    activeCharacterNames,
    aliasHits,
  };
}

function clampBoost(value: number, max: number): number {
  return Math.min(value, max);
}

/** Optional precomputed entity terms to avoid duplicate collect/find per retrieval. */
export interface PrecomputedStoryScoringTerms {
  storyTerms: StoryRetrievalTerms;
  activeTerms: ActiveStoryTerms;
}

export function scoreMemoryCandidates(
  docs: Array<{ chapter: Chapter; text: string }>,
  queryText: string,
  idf: Map<string, number>,
  storyState?: StoryMemoryState | null,
  cosineFn?: (
    queryVector: Map<string, number>,
    docVector: Map<string, number>,
  ) => number,
  vectorizeFn?: (text: string, idf: Map<string, number>) => Map<string, number>,
  /**
   * When provided (e.g. by contextBuilder), reuse terms already collected for
   * this retrieval. Callers that omit this keep the previous one-shot behavior.
   */
  precomputed?: PrecomputedStoryScoringTerms | null,
): ScoredMemoryCandidate[] {
  const terms =
    precomputed?.storyTerms ?? collectStoryRetrievalTerms(storyState);
  const active =
    precomputed?.activeTerms ?? findActiveStoryTerms(queryText, terms);

  const vectorize =
    vectorizeFn ||
    ((text: string, table: Map<string, number>) =>
      defaultVectorize(text, table));
  const cosine =
    cosineFn ||
    ((a: Map<string, number>, b: Map<string, number>) =>
      defaultCosineSimilarity(a, b));

  const trimmedQuery = (queryText || '').trim();
  const queryVector = trimmedQuery
    ? vectorize(trimmedQuery, idf)
    : new Map<string, number>();

  const scored = docs.map(doc => {
    const cosineScore =
      queryVector.size === 0
        ? 0
        : cosine(queryVector, vectorize(doc.text, idf));

    let characterNameBoost = 0;
    let aliasBoost = 0;
    let objectThreadBoost = 0;
    let pairBoost = 0;
    const matchedCharacters: string[] = [];
    const matchedObjects: string[] = [];
    const matchedThreads: string[] = [];

    const charactersCounted = new Set<string>();

    for (const name of active.canonicalCharacterNames) {
      if (!includesInsensitive(doc.text, name)) continue;
      if (charactersCounted.has(name)) continue;
      charactersCounted.add(name);
      characterNameBoost += CHARACTER_NAME_BOOST;
      matchedCharacters.push(name);
    }

    for (const hit of active.aliasHits) {
      if (charactersCounted.has(hit.canonicalName)) {
        // Name already counted as primary reward for this character.
        continue;
      }
      const docHasAliasOrName =
        includesInsensitive(doc.text, hit.alias) ||
        includesInsensitive(doc.text, hit.canonicalName);
      if (!docHasAliasOrName) continue;
      charactersCounted.add(hit.canonicalName);
      aliasBoost += CHARACTER_ALIAS_BOOST;
      matchedCharacters.push(hit.canonicalName);
    }

    for (const term of active.objectTerms) {
      if (!includesInsensitive(doc.text, term)) continue;
      objectThreadBoost += OBJECT_OR_THREAD_BOOST;
      matchedObjects.push(term);
    }
    for (const term of active.threadTerms) {
      if (!includesInsensitive(doc.text, term)) continue;
      objectThreadBoost += OBJECT_OR_THREAD_BOOST;
      matchedThreads.push(term);
    }

    if (active.activeCharacterNames.length >= 2) {
      const present = active.activeCharacterNames.filter(name =>
        includesInsensitive(doc.text, name),
      );
      // Also count aliases present in doc as their canonical.
      for (const hit of active.aliasHits) {
        if (
          includesInsensitive(doc.text, hit.alias) &&
          !present.includes(hit.canonicalName)
        ) {
          present.push(hit.canonicalName);
        }
      }
      if (uniqueNonEmpty(present).length >= 2) {
        pairBoost = CHARACTER_PAIR_BOOST;
      }
    }

    characterNameBoost = clampBoost(characterNameBoost, MAX_CHARACTER_BOOST);
    aliasBoost = clampBoost(aliasBoost, MAX_ALIAS_BOOST);
    objectThreadBoost = clampBoost(objectThreadBoost, MAX_OBJECT_THREAD_BOOST);

    const entityBoost = characterNameBoost + aliasBoost + objectThreadBoost;
    const finalScore = cosineScore + entityBoost + pairBoost;

    return {
      chapter: doc.chapter,
      text: doc.text,
      cosineScore,
      entityBoost,
      pairBoost,
      finalScore,
      matchedCharacters: uniqueNonEmpty(matchedCharacters),
      matchedObjects: uniqueNonEmpty(matchedObjects),
      matchedThreads: uniqueNonEmpty(matchedThreads),
    };
  });

  scored.sort(compareScoredCandidates);
  return scored;
}

export function compareScoredCandidates(
  a: ScoredMemoryCandidate,
  b: ScoredMemoryCandidate,
): number {
  if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
  if (b.cosineScore !== a.cosineScore) return b.cosineScore - a.cosineScore;
  if (b.chapter.position !== a.chapter.position) {
    return b.chapter.position - a.chapter.position;
  }
  return a.chapter.id - b.chapter.id;
}

function candidateMentionsActiveCharacter(
  candidate: ScoredMemoryCandidate,
  active: ActiveStoryTerms,
): boolean {
  if (active.activeCharacterNames.length === 0) return false;
  for (const name of active.activeCharacterNames) {
    if (includesInsensitive(candidate.text, name)) return true;
  }
  for (const hit of active.aliasHits) {
    if (includesInsensitive(candidate.text, hit.alias)) return true;
  }
  return false;
}

function activeCharacterCountInCandidate(
  candidate: ScoredMemoryCandidate,
  active: ActiveStoryTerms,
): number {
  const present = new Set<string>();
  for (const name of active.activeCharacterNames) {
    if (includesInsensitive(candidate.text, name)) present.add(name);
  }
  for (const hit of active.aliasHits) {
    if (includesInsensitive(candidate.text, hit.alias)) {
      present.add(hit.canonicalName);
    }
  }
  return present.size;
}

/**
 * Hybrid Top-K: semantic + character history + recent chapters.
 */
export function selectMemoryCandidates(
  candidates: ScoredMemoryCandidate[],
  activeTerms: ActiveStoryTerms,
  topK: number,
): ScoredMemoryCandidate[] {
  if (topK <= 0 || candidates.length === 0) return [];

  const byId = new Map<number, ScoredMemoryCandidate>();
  for (const item of candidates) {
    byId.set(item.chapter.id, item);
  }
  const all = Array.from(byId.values());

  const selected: ScoredMemoryCandidate[] = [];
  const selectedIds = new Set<number>();

  const pushUnique = (item: ScoredMemoryCandidate | undefined) => {
    if (!item || selectedIds.has(item.chapter.id)) return false;
    if (selected.length >= topK) return false;
    selected.push(item);
    selectedIds.add(item.chapter.id);
    return true;
  };

  const recentOrdered = [...all].sort((a, b) => {
    if (b.chapter.position !== a.chapter.position) {
      return b.chapter.position - a.chapter.position;
    }
    return a.chapter.id - b.chapter.id;
  });

  if (topK < 5) {
    const byScore = [...all].sort(compareScoredCandidates);
    // Always keep at least one recent valid summary.
    if (recentOrdered[0]) pushUnique(recentOrdered[0]);
    for (const item of byScore) {
      pushUnique(item);
      if (selected.length >= topK) break;
    }
    return selected.slice(0, topK);
  }

  const semanticQuota = Math.max(1, Math.floor(topK * 0.6));
  const characterQuota = Math.max(1, Math.floor(topK * 0.2));
  const recentQuota = Math.max(1, topK - semanticQuota - characterQuota);

  // Semantic bucket
  const semanticPool = [...all]
    .filter(item => item.finalScore > 0)
    .sort(compareScoredCandidates);
  let semanticTaken = 0;
  for (const item of semanticPool) {
    if (semanticTaken >= semanticQuota) break;
    if (pushUnique(item)) semanticTaken += 1;
  }

  // Character bucket
  const characterPool = all
    .filter(item => candidateMentionsActiveCharacter(item, activeTerms))
    .sort((a, b) => {
      const aPair = activeCharacterCountInCandidate(a, activeTerms) >= 2 ? 1 : 0;
      const bPair = activeCharacterCountInCandidate(b, activeTerms) >= 2 ? 1 : 0;
      if (bPair !== aPair) return bPair - aPair;
      const aCount = activeCharacterCountInCandidate(a, activeTerms);
      const bCount = activeCharacterCountInCandidate(b, activeTerms);
      if (bCount !== aCount) return bCount - aCount;
      if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
      return b.chapter.position - a.chapter.position;
    });
  let characterTaken = 0;
  for (const item of characterPool) {
    if (characterTaken >= characterQuota) break;
    if (pushUnique(item)) characterTaken += 1;
  }

  // Recent bucket
  let recentTaken = 0;
  for (const item of recentOrdered) {
    if (recentTaken >= recentQuota) break;
    if (pushUnique(item)) recentTaken += 1;
  }

  // Fill remaining by finalScore
  const remaining = [...all].sort(compareScoredCandidates);
  for (const item of remaining) {
    if (selected.length >= topK) break;
    pushUnique(item);
  }

  return selected.slice(0, topK);
}

/** Display order: story chronology (position ascending). */
export function orderCandidatesForDisplay(
  selected: ScoredMemoryCandidate[],
): ScoredMemoryCandidate[] {
  return [...selected].sort((a, b) => {
    if (a.chapter.position !== b.chapter.position) {
      return a.chapter.position - b.chapter.position;
    }
    return a.chapter.id - b.chapter.id;
  });
}

/** Chapter prefix counted in the token budget (must stay complete in output). */
export function formatMemoryCandidatePrefix(
  chapter: Pick<Chapter, 'position' | 'title'>,
): string {
  return `第 ${chapter.position + 1} 章「${chapter.title}」摘要：`;
}

/** Full memory line used for token accounting and final injection. */
export function formatMemoryCandidateLine(
  candidate: Pick<ScoredMemoryCandidate, 'chapter' | 'text'>,
): string {
  return `${formatMemoryCandidatePrefix(candidate.chapter)}${candidate.text}`;
}

/**
 * Keep hybrid Top-K priority order for budget decisions.
 * Do not chronological-sort before budgeting — early low-score lines must not
 * crowd out higher-priority later interactions.
 *
 * Rules:
 * 1. Fit whole line → keep
 * 2. Too long for remaining → skip and try later (often shorter) candidates
 * 3. Never break on first overflow
 * 4. If nothing kept yet, allow truncating the body *after* a complete prefix
 * 5. If even the complete prefix cannot fit, skip (may yield empty result)
 * 6. Total tokens of formatted lines never exceed budget
 *    (prefix is always deducted before body truncation; never re-add unbudgeted prefix)
 */
export function selectCandidatesWithinTokenBudget(
  selectedByPriority: ScoredMemoryCandidate[],
  budgetTokens: number,
): ScoredMemoryCandidate[] {
  if (budgetTokens <= 0 || selectedByPriority.length === 0) return [];

  const kept: ScoredMemoryCandidate[] = [];
  let remaining = budgetTokens;

  for (const candidate of selectedByPriority) {
    if (remaining <= 0) break;
    const line = formatMemoryCandidateLine(candidate);
    const cost = estimateTokens(line);
    if (cost <= remaining) {
      kept.push(candidate);
      remaining -= cost;
      continue;
    }
    // Overflow: if nothing selected yet, truncate body after a full prefix.
    if (kept.length === 0) {
      const prefix = formatMemoryCandidatePrefix(candidate.chapter);
      const prefixCost = estimateTokens(prefix);
      // Cannot emit a valid line without the complete prefix.
      if (prefixCost > remaining) {
        continue;
      }
      const bodyBudget = remaining - prefixCost;
      let textPart =
        bodyBudget <= 0
          ? ''
          : clipTextToTokenBudget(candidate.text, bodyBudget);

      // Guard non-additive token edge cases on prefix+body join.
      let finalCost = estimateTokens(`${prefix}${textPart}`);
      if (finalCost > remaining && textPart) {
        const chars = Array.from(textPart);
        while (chars.length > 0 && finalCost > remaining) {
          chars.pop();
          textPart = chars.join('');
          finalCost = estimateTokens(`${prefix}${textPart}`);
        }
      }
      if (finalCost > remaining) {
        continue;
      }

      kept.push({
        ...candidate,
        text: textPart,
      });
      remaining -= finalCost;
      continue;
    }
    // Skip over-long middle candidates; try later ones that may still fit.
  }

  return kept;
}

function defaultVectorize(
  text: string,
  idf: Map<string, number>,
): Map<string, number> {
  const tokens = tokenizeForMemoryRetrieval(text);
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
  const maxTf = Math.max(1, ...Array.from(tf.values()));
  const vector = new Map<string, number>();
  for (const [term, count] of tf) {
    vector.set(term, (count / maxTf) * (idf.get(term) || 1));
  }
  return vector;
}

function defaultCosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
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

export function buildIdfFromTexts(docs: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(tokenizeForMemoryRetrieval(doc))) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log((docs.length + 1) / (count + 1)) + 1);
  }
  return idf;
}

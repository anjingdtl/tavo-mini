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
export let EPISODIC_RETRIEVAL_V2_ENABLED = true;

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

/** Unified ownership for canonical names + aliases (shared normalized namespace). */
export interface CharacterTermOwner {
  characterId: string;
  canonicalName: string;
  term: string;
  normalizedTerm: string;
  type: 'canonical' | 'alias';
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
  /**
   * normalizedTerm → owners. Same normalized form for ASCII case variants
   * (Captain/captain) and for canonical vs alias collisions.
   */
  termOwnersByNormalized: Record<string, CharacterTermOwner[]>;
  /** Normalized terms owned by more than one characterId (never auto-activate). */
  ambiguousNormalizedTerms: string[];
  /** Flat owner rows for longest-match activation. */
  characterTermOwners: CharacterTermOwner[];
}

export interface ActiveStoryTerms {
  canonicalCharacterNames: string[];
  aliases: string[];
  objectTerms: string[];
  threadTerms: string[];
  /** Active characters by canonical name (display / debug; derived from ids) */
  activeCharacterNames: string[];
  /** Active characters by characterId (activation / dedup / pair boost) */
  activeCharacterIds: string[];
  /** Unambiguous alias hits that map to a single character */
  aliasHits: Array<{
    alias: string;
    canonicalName: string;
    characterId: string;
  }>;
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

/** ASCII letters lowercased; non-ASCII (e.g. CJK) kept as-is. */
export function normalizeCharacterTerm(term: string): string {
  const value = String(term || '').trim();
  if (!value) return '';
  return value.replace(/[A-Za-z]+/g, segment => segment.toLowerCase());
}

function findTermOccurrences(
  haystack: string,
  term: string,
): Array<{ start: number; end: number }> {
  if (!term || !haystack) return [];
  const occurrences: Array<{ start: number; end: number }> = [];
  const hasAscii = /[a-zA-Z]/.test(term);
  if (!hasAscii) {
    let from = 0;
    while (from <= haystack.length) {
      const index = haystack.indexOf(term, from);
      if (index < 0) break;
      occurrences.push({ start: index, end: index + term.length });
      from = index + 1;
    }
    return occurrences;
  }
  const lowerHay = haystack.toLowerCase();
  const lowerTerm = term.toLowerCase();
  let from = 0;
  while (from <= lowerHay.length) {
    const index = lowerHay.indexOf(lowerTerm, from);
    if (index < 0) break;
    occurrences.push({ start: index, end: index + term.length });
    from = index + 1;
  }
  return occurrences;
}

function rangesOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end && b.start < a.end;
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
    termOwnersByNormalized: {},
    ambiguousNormalizedTerms: [],
    characterTermOwners: [],
  };
  if (!state) return empty;

  try {
    const canonicalCharacterNames: string[] = [];
    const aliases: string[] = [];
    const objectTerms: string[] = [];
    const threadTerms: string[] = [];
    const characterTermOwners: CharacterTermOwner[] = [];
    const termOwnersByNormalized: Record<string, CharacterTermOwner[]> = {};
    // Display-oriented alias map (raw alias string → canonical names).
    const aliasOwners = new Map<string, string[]>();

    for (const character of Object.values(state.characters || {})) {
      const characterId = String(character.id || '').trim();
      const name = String(character.canonicalName || '').trim();
      if (!characterId) continue;

      if (name) {
        canonicalCharacterNames.push(name);
        const normalizedTerm = normalizeCharacterTerm(name);
        if (normalizedTerm) {
          const owner: CharacterTermOwner = {
            characterId,
            canonicalName: name,
            term: name,
            normalizedTerm,
            type: 'canonical',
          };
          characterTermOwners.push(owner);
          const bucket = termOwnersByNormalized[normalizedTerm] || [];
          bucket.push(owner);
          termOwnersByNormalized[normalizedTerm] = bucket;
        }
      }

      for (const alias of character.aliases || []) {
        const a = String(alias || '').trim();
        if (!a) continue;
        aliases.push(a);
        if (name) {
          const owners = aliasOwners.get(a) || [];
          if (!owners.includes(name)) {
            owners.push(name);
            aliasOwners.set(a, owners);
          }
        }
        const normalizedTerm = normalizeCharacterTerm(a);
        if (!normalizedTerm) continue;
        const owner: CharacterTermOwner = {
          characterId,
          canonicalName: name || characterId,
          term: a,
          normalizedTerm,
          type: 'alias',
        };
        characterTermOwners.push(owner);
        const bucket = termOwnersByNormalized[normalizedTerm] || [];
        bucket.push(owner);
        termOwnersByNormalized[normalizedTerm] = bucket;
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

    // Collapse ownership by characterId per normalized term; multi-id → ambiguous.
    const ambiguousNormalizedTerms: string[] = [];
    for (const [normalized, owners] of Object.entries(termOwnersByNormalized)) {
      const uniqueIds = uniqueNonEmpty(owners.map(o => o.characterId));
      if (uniqueIds.length > 1) {
        ambiguousNormalizedTerms.push(normalized);
      }
      // Also treat multi-owner raw aliases as ambiguous (legacy field).
      if (uniqueIds.length > 1) {
        for (const owner of owners) {
          if (owner.type === 'alias' && !ambiguousAliases.includes(owner.term)) {
            ambiguousAliases.push(owner.term);
          }
        }
      }
    }

    // Promote canonical↔alias collisions into aliasToCanonicalNames for debug/tests.
    for (const [_normalized, owners] of Object.entries(termOwnersByNormalized)) {
      const uniqueIds = uniqueNonEmpty(owners.map(o => o.characterId));
      if (uniqueIds.length <= 1) continue;
      const names = uniqueNonEmpty(owners.map(o => o.canonicalName));
      for (const owner of owners) {
        if (owner.type !== 'alias') continue;
        const existing = aliasToCanonicalNames[owner.term] || [];
        for (const n of names) {
          if (!existing.includes(n)) existing.push(n);
        }
        aliasToCanonicalNames[owner.term] = existing;
        if (existing.length > 1 && !ambiguousAliases.includes(owner.term)) {
          ambiguousAliases.push(owner.term);
        }
      }
      // Case-variant aliases share normalized form; expose all raw terms as ambiguous.
      const aliasTerms = uniqueNonEmpty(
        owners.filter(o => o.type === 'alias').map(o => o.term),
      );
      if (aliasTerms.length >= 1 && uniqueIds.length > 1) {
        for (const term of aliasTerms) {
          if (!ambiguousAliases.includes(term)) ambiguousAliases.push(term);
        }
      }
      // Same normalized alias owned by multiple characters (Captain / captain).
      if (
        uniqueIds.length > 1 &&
        owners.every(o => o.type === 'alias' || o.type === 'canonical')
      ) {
        const onlyAliases = owners.filter(o => o.type === 'alias');
        if (onlyAliases.length >= 2 || uniqueIds.length > 1) {
          for (const owner of owners) {
            if (owner.type === 'alias') {
              aliasToCanonicalNames[owner.term] = uniqueNonEmpty(
                owners.map(o => o.canonicalName),
              );
              if (!ambiguousAliases.includes(owner.term)) {
                ambiguousAliases.push(owner.term);
              }
            }
          }
        }
      }
    }

    return {
      canonicalCharacterNames: uniqueNonEmpty(canonicalCharacterNames),
      aliases: uniqueNonEmpty(aliases),
      objectTerms: uniqueNonEmpty(objectTerms),
      threadTerms: uniqueNonEmpty(threadTerms),
      aliasToCanonicalNames,
      ambiguousAliases: uniqueNonEmpty(ambiguousAliases),
      termOwnersByNormalized,
      ambiguousNormalizedTerms: uniqueNonEmpty(ambiguousNormalizedTerms),
      characterTermOwners,
    };
  } catch {
    return empty;
  }
}

/**
 * Activate characters from query using the unified term namespace:
 * longest-match first, ambiguous multi-owner terms never auto-activate,
 * substring spans already claimed by a longer term do not activate another character.
 */
export function findActiveStoryTerms(
  queryText: string,
  terms: StoryRetrievalTerms,
): ActiveStoryTerms {
  const query = queryText || '';
  const ambiguousNormalized = new Set(terms.ambiguousNormalizedTerms || []);
  // Fallback when older fixtures omit the new fields.
  if (
    (!terms.characterTermOwners || terms.characterTermOwners.length === 0) &&
    terms.canonicalCharacterNames.length + terms.aliases.length > 0
  ) {
    return findActiveStoryTermsLegacy(query, terms);
  }

  // One representative owner per (normalizedTerm, characterId) for matching.
  const uniqueTermCandidates = new Map<
    string,
    { owner: CharacterTermOwner; displayTerm: string }
  >();
  for (const owner of terms.characterTermOwners || []) {
    if (ambiguousNormalized.has(owner.normalizedTerm)) continue;
    const ownersForTerm = terms.termOwnersByNormalized?.[owner.normalizedTerm] || [
      owner,
    ];
    const uniqueIds = uniqueNonEmpty(ownersForTerm.map(o => o.characterId));
    if (uniqueIds.length !== 1) continue;
    const key = `${owner.normalizedTerm}::${owner.characterId}`;
    const existing = uniqueTermCandidates.get(key);
    // Prefer longer surface form (canonical often equals; pick longest term).
    if (!existing || owner.term.length > existing.displayTerm.length) {
      uniqueTermCandidates.set(key, { owner, displayTerm: owner.term });
    }
  }

  const candidates = Array.from(uniqueTermCandidates.values()).sort((a, b) => {
    if (b.displayTerm.length !== a.displayTerm.length) {
      return b.displayTerm.length - a.displayTerm.length;
    }
    // Prefer canonical over alias when same length.
    if (a.owner.type !== b.owner.type) {
      return a.owner.type === 'canonical' ? -1 : 1;
    }
    return a.displayTerm.localeCompare(b.displayTerm);
  });

  const claimedSpans: Array<{ start: number; end: number }> = [];
  const activeById = new Map<
    string,
    { canonicalName: string; via: 'canonical' | 'alias'; term: string }
  >();
  const canonicalCharacterNames: string[] = [];
  const aliases: string[] = [];
  const aliasHits: Array<{
    alias: string;
    canonicalName: string;
    characterId: string;
  }> = [];

  for (const { owner, displayTerm } of candidates) {
    const occurrences = findTermOccurrences(query, displayTerm);
    if (occurrences.length === 0) continue;
    const free = occurrences.filter(
      span => !claimedSpans.some(claimed => rangesOverlap(claimed, span)),
    );
    if (free.length === 0) continue;
    for (const span of free) claimedSpans.push(span);

    if (!activeById.has(owner.characterId)) {
      activeById.set(owner.characterId, {
        canonicalName: owner.canonicalName,
        via: owner.type,
        term: displayTerm,
      });
      if (owner.type === 'canonical') {
        canonicalCharacterNames.push(owner.canonicalName);
      } else {
        aliases.push(displayTerm);
        aliasHits.push({
          alias: displayTerm,
          canonicalName: owner.canonicalName,
          characterId: owner.characterId,
        });
      }
    } else if (owner.type === 'alias') {
      // Extra alias evidence for already-active character (display only).
      if (!aliases.includes(displayTerm)) aliases.push(displayTerm);
    } else if (
      owner.type === 'canonical' &&
      !canonicalCharacterNames.includes(owner.canonicalName)
    ) {
      canonicalCharacterNames.push(owner.canonicalName);
    }
  }

  const objectTerms = terms.objectTerms.filter(term =>
    includesInsensitive(query, term),
  );
  const threadTerms = terms.threadTerms.filter(term =>
    includesInsensitive(query, term),
  );

  const activeCharacterIds = Array.from(activeById.keys());
  const activeCharacterNames = uniqueNonEmpty(
    activeCharacterIds.map(id => activeById.get(id)!.canonicalName),
  );

  return {
    canonicalCharacterNames: uniqueNonEmpty(canonicalCharacterNames),
    aliases: uniqueNonEmpty(aliases),
    objectTerms,
    threadTerms,
    activeCharacterNames,
    activeCharacterIds,
    aliasHits,
  };
}

/** Pre-namespace fallback for incomplete term bags (tests / old callers). */
function findActiveStoryTermsLegacy(
  query: string,
  terms: StoryRetrievalTerms,
): ActiveStoryTerms {
  const ambiguous = new Set(terms.ambiguousAliases || []);
  const canonicalCharacterNames = terms.canonicalCharacterNames.filter(name =>
    includesInsensitive(query, name),
  );
  const aliasHits: Array<{
    alias: string;
    canonicalName: string;
    characterId: string;
  }> = [];
  const aliases: string[] = [];
  for (const alias of terms.aliases) {
    if (!includesInsensitive(query, alias)) continue;
    if (ambiguous.has(alias)) continue;
    const owners = terms.aliasToCanonicalNames[alias] || [];
    if (owners.length !== 1) continue;
    aliases.push(alias);
    aliasHits.push({
      alias,
      canonicalName: owners[0],
      characterId: owners[0],
    });
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
    activeCharacterIds: activeCharacterNames,
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

    // Dedup rewards by characterId (not bare display-name string).
    const charactersCounted = new Set<string>();
    const idToCanonical = buildActiveIdToCanonical(active);

    for (const id of active.activeCharacterIds) {
      if (charactersCounted.has(id)) continue;
      const canonicalName = idToCanonical.get(id) || id;
      const activatedViaCanonical = active.canonicalCharacterNames.includes(
        canonicalName,
      );
      const aliasHit = active.aliasHits.find(h => h.characterId === id);
      const docHasCanonical = includesInsensitive(doc.text, canonicalName);
      const docHasAlias = Boolean(
        aliasHit && includesInsensitive(doc.text, aliasHit.alias),
      );
      if (!docHasCanonical && !docHasAlias) continue;
      charactersCounted.add(id);
      if (activatedViaCanonical && docHasCanonical) {
        characterNameBoost += CHARACTER_NAME_BOOST;
      } else {
        aliasBoost += CHARACTER_ALIAS_BOOST;
      }
      matchedCharacters.push(canonicalName);
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

    if (active.activeCharacterIds.length >= 2) {
      const presentIds = active.activeCharacterIds.filter(id => {
        const canonicalName = idToCanonical.get(id) || id;
        if (includesInsensitive(doc.text, canonicalName)) return true;
        const aliasHit = active.aliasHits.find(h => h.characterId === id);
        return Boolean(
          aliasHit && includesInsensitive(doc.text, aliasHit.alias),
        );
      });
      if (uniqueNonEmpty(presentIds).length >= 2) {
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

function buildActiveIdToCanonical(
  active: ActiveStoryTerms,
): Map<string, string> {
  const map = new Map<string, string>();
  const ids = active.activeCharacterIds || [];
  const names = active.activeCharacterNames || [];
  if (ids.length === names.length) {
    ids.forEach((id, index) => map.set(id, names[index]));
  } else {
    ids.forEach((id, index) => {
      map.set(id, names[index] || names[0] || id);
    });
  }
  for (const hit of active.aliasHits || []) {
    if (hit.characterId) map.set(hit.characterId, hit.canonicalName);
  }
  // When names were used as pseudo-ids (legacy), keep identity.
  for (const name of names) {
    if (!map.has(name)) map.set(name, name);
  }
  return map;
}

function candidateMentionsActiveCharacter(
  candidate: ScoredMemoryCandidate,
  active: ActiveStoryTerms,
): boolean {
  const ids = active.activeCharacterIds || [];
  if (ids.length === 0 && active.activeCharacterNames.length === 0) {
    return false;
  }
  const idToCanonical = buildActiveIdToCanonical(active);
  for (const id of ids.length ? ids : active.activeCharacterNames) {
    const name = idToCanonical.get(id) || id;
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
  const ids = active.activeCharacterIds || [];
  const idToCanonical = buildActiveIdToCanonical(active);
  for (const id of ids.length ? ids : active.activeCharacterNames) {
    const name = idToCanonical.get(id) || id;
    if (includesInsensitive(candidate.text, name)) present.add(id);
  }
  for (const hit of active.aliasHits) {
    if (includesInsensitive(candidate.text, hit.alias)) {
      present.add(hit.characterId || hit.canonicalName);
    }
  }
  return present.size;
}

/**
 * Hybrid Top-K: semantic + character history + recent chapters.
 *
 * topK < 5: pick by finalScore first; ensure recent is present by replacing
 * the lowest-score pick when missing. topK === 1 prefers highest score unless
 * all scores are 0 (empty / zero-signal query) → recent chapter.
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
    const allZero = byScore.every(item => item.finalScore === 0);
    const recent = recentOrdered[0];

    if (topK === 1) {
      if (allZero && recent) return [recent];
      return byScore.slice(0, 1);
    }

    // Score-first Top-K, then guarantee one recent when missing.
    const picked = byScore.slice(0, topK);
    if (recent && !picked.some(item => item.chapter.id === recent.chapter.id)) {
      // Replace lowest-score pick (last in score-desc order).
      picked[picked.length - 1] = recent;
    }
    // Budget priority still favors higher scores.
    return [...picked].sort(compareScoredCandidates).slice(0, topK);
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

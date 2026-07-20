/**
 * Single production entry for character mentions in free text.
 * Used by query activation, candidate summary scoring, and Story Memory relevance.
 *
 * Rules:
 * - ASCII lowercased; CJK kept as-is
 * - canonical + alias share one namespace
 * - multi-characterId terms are ambiguous and never activate
 * - longest unique terms first; claimed spans block shorter overlaps
 * - identity is characterId; surface forms are display only
 * - no edit distance, no remote API
 */

import type {
  CharacterTermOwner,
  StoryRetrievalTerms,
} from '../episodicMemoryRetriever';

export interface CharacterMention {
  characterId: string;
  canonicalName: string;
  matchedTerm: string;
  normalizedTerm: string;
  type: 'canonical' | 'alias';
  start: number;
  end: number;
}

export interface CharacterMentionResolution {
  characterIds: string[];
  mentions: CharacterMention[];
  canonicalNameByCharacterId: Record<string, string>;
  ambiguousTermsEncountered: string[];
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

/**
 * Resolve which characters appear in `text` using Story Retrieval Terms.
 * Safe on any input: parse failures return empty resolution.
 */
export function resolveCharacterMentionsInText(
  text: string,
  terms: StoryRetrievalTerms,
): CharacterMentionResolution {
  const empty: CharacterMentionResolution = {
    characterIds: [],
    mentions: [],
    canonicalNameByCharacterId: {},
    ambiguousTermsEncountered: [],
  };

  try {
    const haystack = text || '';
    if (!haystack) return empty;

    const ambiguousNormalized = new Set(terms.ambiguousNormalizedTerms || []);
    const ambiguousEncountered = new Set<string>();

    // Track ambiguous terms that appear in text (for tests / debug).
    for (const normalized of ambiguousNormalized) {
      const owners = terms.termOwnersByNormalized?.[normalized] || [];
      const surface =
        owners.find(o => o.term)?.term ||
        owners[0]?.normalizedTerm ||
        normalized;
      if (surface && findTermOccurrences(haystack, surface).length > 0) {
        ambiguousEncountered.add(surface);
      }
    }

    // Legacy fixtures without characterTermOwners: best-effort from flat lists.
    const owners: CharacterTermOwner[] =
      terms.characterTermOwners && terms.characterTermOwners.length > 0
        ? terms.characterTermOwners
        : buildOwnersFromLegacyTerms(terms);

    if (owners.length === 0) {
      return {
        ...empty,
        ambiguousTermsEncountered: Array.from(ambiguousEncountered),
      };
    }

    // One representative surface per (normalizedTerm, characterId).
    const uniqueTermCandidates = new Map<
      string,
      { owner: CharacterTermOwner; displayTerm: string }
    >();
    for (const owner of owners) {
      if (!owner.normalizedTerm || !owner.characterId) continue;
      if (ambiguousNormalized.has(owner.normalizedTerm)) continue;
      const ownersForTerm =
        terms.termOwnersByNormalized?.[owner.normalizedTerm] || [owner];
      const uniqueIds = uniqueNonEmpty(ownersForTerm.map(o => o.characterId));
      if (uniqueIds.length !== 1) continue;
      const key = `${owner.normalizedTerm}::${owner.characterId}`;
      const existing = uniqueTermCandidates.get(key);
      if (!existing || owner.term.length > existing.displayTerm.length) {
        uniqueTermCandidates.set(key, { owner, displayTerm: owner.term });
      }
    }

    const candidates = Array.from(uniqueTermCandidates.values()).sort(
      (a, b) => {
        if (b.displayTerm.length !== a.displayTerm.length) {
          return b.displayTerm.length - a.displayTerm.length;
        }
        if (a.owner.type !== b.owner.type) {
          return a.owner.type === 'canonical' ? -1 : 1;
        }
        return a.displayTerm.localeCompare(b.displayTerm);
      },
    );

    const claimedSpans: Array<{ start: number; end: number }> = [];
    const firstById = new Map<
      string,
      {
        canonicalName: string;
        type: 'canonical' | 'alias';
        matchedTerm: string;
      }
    >();
    const mentions: CharacterMention[] = [];

    for (const { owner, displayTerm } of candidates) {
      const occurrences = findTermOccurrences(haystack, displayTerm);
      if (occurrences.length === 0) continue;
      const free = occurrences.filter(
        span => !claimedSpans.some(claimed => rangesOverlap(claimed, span)),
      );
      if (free.length === 0) continue;
      for (const span of free) {
        claimedSpans.push(span);
        mentions.push({
          characterId: owner.characterId,
          canonicalName: owner.canonicalName,
          matchedTerm: displayTerm,
          normalizedTerm: owner.normalizedTerm,
          type: owner.type,
          start: span.start,
          end: span.end,
        });
      }
      if (!firstById.has(owner.characterId)) {
        firstById.set(owner.characterId, {
          canonicalName: owner.canonicalName,
          type: owner.type,
          matchedTerm: displayTerm,
        });
      }
    }

    const characterIds = Array.from(firstById.keys());
    const canonicalNameByCharacterId: Record<string, string> = {};
    for (const [id, info] of firstById) {
      canonicalNameByCharacterId[id] = info.canonicalName;
    }

    return {
      characterIds,
      mentions,
      canonicalNameByCharacterId,
      ambiguousTermsEncountered: Array.from(ambiguousEncountered),
    };
  } catch {
    return empty;
  }
}

/** Minimal owners when only legacy flat name/alias lists exist. */
function buildOwnersFromLegacyTerms(
  terms: StoryRetrievalTerms,
): CharacterTermOwner[] {
  const owners: CharacterTermOwner[] = [];
  const ambiguous = new Set(terms.ambiguousAliases || []);
  for (const name of terms.canonicalCharacterNames || []) {
    const n = String(name || '').trim();
    if (!n) continue;
    owners.push({
      characterId: n,
      canonicalName: n,
      term: n,
      normalizedTerm: n.replace(/[A-Za-z]+/g, s => s.toLowerCase()),
      type: 'canonical',
    });
  }
  for (const alias of terms.aliases || []) {
    const a = String(alias || '').trim();
    if (!a || ambiguous.has(a)) continue;
    const canonOwners = terms.aliasToCanonicalNames?.[a] || [];
    if (canonOwners.length !== 1) continue;
    owners.push({
      characterId: canonOwners[0],
      canonicalName: canonOwners[0],
      term: a,
      normalizedTerm: a.replace(/[A-Za-z]+/g, s => s.toLowerCase()),
      type: 'alias',
    });
  }
  return owners;
}

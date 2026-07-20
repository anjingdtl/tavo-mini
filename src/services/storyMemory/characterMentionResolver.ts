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

/**
 * Unified scan entry (V2.5.13+): unique terms and ambiguous terms share one
 * longest-match pass. Ambiguous entries claim spans but never activate.
 */
export interface CharacterTermScanEntry {
  normalizedTerm: string;
  displayTerm: string;
  owners: CharacterTermOwner[];
  ambiguous: boolean;
  length: number;
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

    // Build one scan entry per (normalizedTerm, representative owner).
    // - Unique normalized terms: single entry, ambiguous=false.
    // - Ambiguous normalized terms: single entry, ambiguous=true (claims spans,
    //   never activates). Representative displayTerm is the longest surface.
    const scanEntriesByNormalized = new Map<string, CharacterTermScanEntry>();
    for (const owner of owners) {
      if (!owner.normalizedTerm || !owner.characterId) continue;
      const ownersForTerm =
        terms.termOwnersByNormalized?.[owner.normalizedTerm] || [owner];
      const uniqueIds = uniqueNonEmpty(ownersForTerm.map(o => o.characterId));
      const isAmbiguous =
        ambiguousNormalized.has(owner.normalizedTerm) || uniqueIds.length > 1;

      const existing = scanEntriesByNormalized.get(owner.normalizedTerm);
      if (existing) {
        // Keep the longest display surface for the same normalized bucket.
        if (owner.term.length > existing.displayTerm.length) {
          existing.displayTerm = owner.term;
          existing.length = owner.term.length;
        }
        // Merge owner (dedupe by characterId+type+term).
        const alreadyHave = existing.owners.some(
          o =>
            o.characterId === owner.characterId &&
            o.type === owner.type &&
            o.term === owner.term,
        );
        if (!alreadyHave) existing.owners.push(owner);
        continue;
      }

      scanEntriesByNormalized.set(owner.normalizedTerm, {
        normalizedTerm: owner.normalizedTerm,
        displayTerm: owner.term,
        owners: [owner],
        ambiguous: isAmbiguous,
        length: owner.term.length,
      });
    }

    // Sort: longest displayTerm first; among unambiguous entries of equal length,
    // canonical before alias (stable); then by normalizedTerm / displayTerm.
    const scanEntries = Array.from(scanEntriesByNormalized.values()).sort(
      (a, b) => {
        if (b.length !== a.length) return b.length - a.length;
        if (!a.ambiguous && !b.ambiguous) {
          const aType = a.owners[0]?.type;
          const bType = b.owners[0]?.type;
          if (aType !== bType) return aType === 'canonical' ? -1 : 1;
        }
        if (a.normalizedTerm !== b.normalizedTerm) {
          return a.normalizedTerm < b.normalizedTerm ? -1 : 1;
        }
        return a.displayTerm < b.displayTerm ? -1 : 1;
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

    for (const entry of scanEntries) {
      const occurrences = findTermOccurrences(haystack, entry.displayTerm);
      if (occurrences.length === 0) continue;
      const free = occurrences.filter(
        span => !claimedSpans.some(claimed => rangesOverlap(claimed, span)),
      );
      if (free.length === 0) continue;

      if (entry.ambiguous) {
        // Ambiguous terms claim spans but never activate characters.
        for (const span of free) {
          claimedSpans.push(span);
        }
        ambiguousEncountered.add(entry.displayTerm);
        continue;
      }

      // Unique term: activate its single characterId.
      const owner = entry.owners[0];
      if (!owner) continue;
      for (const span of free) {
        claimedSpans.push(span);
        mentions.push({
          characterId: owner.characterId,
          canonicalName: owner.canonicalName,
          matchedTerm: entry.displayTerm,
          normalizedTerm: entry.normalizedTerm,
          type: owner.type,
          start: span.start,
          end: span.end,
        });
      }
      if (!firstById.has(owner.characterId)) {
        firstById.set(owner.characterId, {
          canonicalName: owner.canonicalName,
          type: owner.type,
          matchedTerm: entry.displayTerm,
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

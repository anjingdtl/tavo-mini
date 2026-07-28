/**
 * Character alias normalization + longest-match helpers (Spec §6.7, §8.3).
 */
export function normalizeAlias(alias: string): string {
  return alias
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000·•・\.。,，、'"`~!@#$%^&*()（）【】\[\]{}]/g, '');
}

/**
 * Builds the unambiguous part of a snapshot-wide character-name catalogue.
 * A spelling that points to two different people is deliberately omitted: the
 * materializer must create/review a distinct record instead of silently
 * attaching relationships, experiences or timeline events to the wrong one.
 */
export function buildUniqueCharacterNameIndex(
  entries: Array<{ characterId: number; name: string }>,
): Map<string, number> {
  const candidates = new Map<string, Set<number>>();
  for (const entry of entries) {
    const normalized = normalizeAlias(entry.name);
    if (!normalized) continue;
    const ids = candidates.get(normalized) ?? new Set<number>();
    ids.add(entry.characterId);
    candidates.set(normalized, ids);
  }

  const unique = new Map<string, number>();
  for (const [normalized, ids] of candidates) {
    if (ids.size === 1) unique.set(normalized, [...ids][0]);
  }
  return unique;
}

/**
 * Longest-match alias resolution against a catalog. Ambiguous exact ties keep
 * multiple candidates; does not use naive includes as final identity.
 */
export function longestMatchAliases(
  text: string,
  catalog: Array<{ id: number; name: string; normalized: string }>,
): Array<{
  text: string;
  start: number;
  end: number;
  matches: Array<{ id: number; name: string }>;
}> {
  const sorted = [...catalog].sort(
    (a, b) => b.normalized.length - a.normalized.length,
  );
  const occupied = new Array(text.length).fill(false);
  const hits: Array<{
    text: string;
    start: number;
    end: number;
    matches: Array<{ id: number; name: string }>;
  }> = [];

  for (const item of sorted) {
    if (!item.name) continue;
    let from = 0;
    while (from < text.length) {
      const idx = text.indexOf(item.name, from);
      if (idx < 0) break;
      const end = idx + item.name.length;
      let blocked = false;
      for (let i = idx; i < end; i++) {
        if (occupied[i]) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        for (let i = idx; i < end; i++) occupied[i] = true;
        const sameSpan = catalog.filter(c => c.name === item.name);
        hits.push({
          text: item.name,
          start: idx,
          end,
          matches: sameSpan.map(c => ({ id: c.id, name: c.name })),
        });
      }
      from = idx + 1;
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

/** Detect ambiguous honorifics like 队长 overlapping shorter 长. */
export function isAmbiguousShortAlias(
  shortAlias: string,
  longerAlias: string,
): boolean {
  if (!shortAlias || !longerAlias) return false;
  if (shortAlias.length >= longerAlias.length) return false;
  return longerAlias.includes(shortAlias);
}

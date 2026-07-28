import {
  buildUniqueCharacterNameIndex,
  isAmbiguousShortAlias,
  longestMatchAliases,
  normalizeAlias,
} from '../src/services/continuation/canon/canonEntityResolver';

describe('Canon entity resolver (Spec §17.4)', () => {
  it('normalizes aliases', () => {
    expect(normalizeAlias(' 老 林 ')).toBe('老林');
    expect(normalizeAlias('林·凡')).toBe('林凡');
  });

  it('prefers longest match over short honorifics', () => {
    const hits = longestMatchAliases('队长说，长也很忙', [
      { id: 1, name: '队长', normalized: '队长' },
      { id: 2, name: '长', normalized: '长' },
    ]);
    expect(hits.some(h => h.text === '队长')).toBe(true);
    // short 长 should not occupy the same span as 队长's 长
    const shortHits = hits.filter(h => h.text === '长');
    for (const h of shortHits) {
      expect(h.start).toBeGreaterThan(0);
    }
  });

  it('keeps same-name multi-id as multi-match ambiguity', () => {
    const hits = longestMatchAliases('林凡来了', [
      { id: 1, name: '林凡', normalized: '林凡' },
      { id: 2, name: '林凡', normalized: '林凡' },
    ]);
    expect(hits[0].matches).toHaveLength(2);
  });

  it('detects short alias nested in longer title', () => {
    expect(isAmbiguousShortAlias('林', '老林')).toBe(true);
    expect(isAmbiguousShortAlias('老林', '林')).toBe(false);
  });

  it('uses one stable character id for canonical names and unique aliases, but never guesses ambiguous aliases', () => {
    const index = buildUniqueCharacterNameIndex([
      { characterId: 1, name: '林凡' },
      { characterId: 1, name: '林师兄' },
      { characterId: 2, name: '苏婉' },
      { characterId: 2, name: '师兄' },
      { characterId: 3, name: '师兄' },
    ]);

    expect(index.get(normalizeAlias('林凡'))).toBe(1);
    expect(index.get(normalizeAlias('林师兄'))).toBe(1);
    expect(index.has(normalizeAlias('师兄'))).toBe(false);
  });
});

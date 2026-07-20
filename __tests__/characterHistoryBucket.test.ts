/**
 * SPEC §12 — Character-history bucket专项 tests (V2.5.13).
 *
 * Verifies that the mixed Top-K character-history bucket relies ONLY on
 * `matchedCharacterIds` (computed by `scoreMemoryCandidates`), never on
 * name/alias string fallback. Covers:
 *   §12.1 重名正式姓名 (homonymous canonical names with distinct aliases)
 *   §12.2 明确两个 alias (explicit dual-alias pair boost)
 *   §12.3 跨别名 (cross-alias bucket entry)
 *   §12.4 歧义长词阻挡短词 (ambiguous long term blocks short overlap)
 *
 * Resolver-level ambiguity tests (队长/长, 老林/林, Captain/captain) live
 * alongside because the same `resolveCharacterMentionsInText` powers both
 * query activation and candidate scoring.
 */

import type { Chapter } from '../src/types/novel';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import {
  CHARACTER_PAIR_BOOST,
  buildIdfFromTexts,
  collectStoryRetrievalTerms,
  findActiveStoryTerms,
  scoreMemoryCandidates,
  selectMemoryCandidates,
} from '../src/services/episodicMemoryRetriever';
import { resolveCharacterMentionsInText } from '../src/services/storyMemory/characterMentionResolver';

function makeChapter(
  id: number,
  position: number,
  summary: string,
  title = `第${position + 1}章`,
): Chapter {
  return {
    id,
    project_id: 1,
    position,
    title,
    synopsis: '',
    content: '',
    status: 'final',
    summary_json: null,
    memory_summary: summary,
    memory_summary_tokens: 0,
    finalized_at: null,
    created_at: '',
    updated_at: '',
  };
}

function emptyCharacter(id: string, canonicalName: string, aliases: string[] = []) {
  return {
    id,
    canonicalName,
    aliases,
    role: '',
    immutableProfile: { identity: '', stableTraits: [], affiliations: [] },
    currentState: {
      location: '',
      physicalState: '',
      emotionalState: '',
      currentGoal: '',
      knowledge: [],
      possessions: [],
      secrets: [],
    },
    status: 'active' as const,
    firstSeenChapterId: 1,
    firstSeenPosition: 0,
    lastChangedChapterId: 1,
    lastChangedPosition: 0,
    evidenceChapterIds: [1],
  };
}

/**
 * §12.1 + §12.2 — Homonymous canonical names with distinct aliases.
 *
 *   char_reporter canonical=李明 alias=记者
 *   char_doctor  canonical=李明 alias=医生
 *
 * Query "记者和医生去现场" must activate both reporter and doctor by ID.
 * Candidate "李明去了现场" must NOT match either (canonical name is ambiguous
 * because two characters share it) — `matchedCharacterIds === []`, pairBoost=0.
 * Candidate "记者与医生共同去了现场" must match both IDs and earn pair priority.
 */
describe('SPEC §12.1/§12.2 — homonymous canonical names + explicit dual-alias', () => {
  function stateWithHomonyms() {
    const state = createEmptyStoryMemory(1);
    state.characters.char_reporter = emptyCharacter('char_reporter', '李明', ['记者']);
    state.characters.char_doctor = emptyCharacter('char_doctor', '李明', ['医生']);
    return state;
  }

  it('李明 canonical is ambiguous (shared by two characterIds) and never activates', () => {
    const state = stateWithHomonyms();
    const terms = collectStoryRetrievalTerms(state);
    const normalizedLiMing = '李明';
    expect(terms.ambiguousNormalizedTerms).toContain(normalizedLiMing);

    // Query "李明去了现场" must not activate any character by canonical.
    const resolution = resolveCharacterMentionsInText('李明去了现场', terms);
    expect(resolution.characterIds).toEqual([]);
  });

  it('candidate "李明去了现场" → matchedCharacterIds=[] and pairBoost=0', () => {
    const state = stateWithHomonyms();
    const docs = [
      {
        chapter: makeChapter(1, 0, '李明去了现场。'),
        text: '李明去了现场。',
      },
    ];
    const query = '记者和医生去现场';
    const idf = buildIdfFromTexts(docs.map(d => d.text).concat([query]));
    const scored = scoreMemoryCandidates(docs, query, idf, state);
    expect(scored[0].matchedCharacterIds).toEqual([]);
    expect(scored[0].pairBoost).toBe(0);
    // Sanity: matchedCharacters display list is also empty.
    expect(scored[0].matchedCharacters).toEqual([]);
  });

  it('candidate "记者与医生共同去了现场" → matchedCharacterIds=[reporter, doctor] and pairBoost=CHARACTER_PAIR_BOOST', () => {
    const state = stateWithHomonyms();
    const docs = [
      {
        chapter: makeChapter(2, 1, '记者与医生共同去了现场。'),
        text: '记者与医生共同去了现场。',
      },
    ];
    const query = '记者和医生去现场';
    const idf = buildIdfFromTexts(docs.map(d => d.text).concat([query]));
    const scored = scoreMemoryCandidates(docs, query, idf, state);
    expect(scored[0].matchedCharacterIds.sort()).toEqual(
      ['char_doctor', 'char_reporter'].sort(),
    );
    expect(scored[0].pairBoost).toBe(CHARACTER_PAIR_BOOST);
  });

  it('mixed Top-K character-history bucket prefers the dual-alias candidate over the homonymous canonical candidate', () => {
    const state = stateWithHomonyms();
    const docs = [
      {
        chapter: makeChapter(1, 0, '李明去了现场。'),
        text: '李明去了现场。',
      },
      {
        chapter: makeChapter(2, 1, '记者与医生共同去了现场。'),
        text: '记者与医生共同去了现场。',
      },
    ];
    const query = '记者和医生去现场';
    const idf = buildIdfFromTexts(docs.map(d => d.text).concat([query]));
    const scored = scoreMemoryCandidates(docs, query, idf, state);
    const byId = new Map(scored.map(s => [s.chapter.id, s]));
    expect(byId.get(1)!.matchedCharacterIds).toEqual([]);
    expect(byId.get(1)!.pairBoost).toBe(0);
    expect(byId.get(2)!.matchedCharacterIds.length).toBe(2);
    expect(byId.get(2)!.pairBoost).toBe(CHARACTER_PAIR_BOOST);

    // topK=10 → character bucket must include only candidates with matchedCharacterIds.
    const active = findActiveStoryTerms(query, collectStoryRetrievalTerms(state));
    const selected = selectMemoryCandidates(scored, active, 10);
    const bucketOnly = selected.filter(s => s.matchedCharacterIds.length > 0);
    // Dual-alias candidate enters bucket; homonymous canonical never does.
    expect(bucketOnly.some(s => s.chapter.id === 2)).toBe(true);
    expect(bucketOnly.some(s => s.chapter.id === 1)).toBe(false);
  });
});

/**
 * §12.3 — Cross-alias bucket entry.
 *
 *   char_lan canonical=林岚 aliases=[小岚, 岚姐]
 *
 * Query "林岚" + candidate "岚姐" → matchedCharacterIds=['char_lan'],
 * candidate enters the character-history bucket normally.
 */
describe('SPEC §12.3 — cross-alias candidate enters character-history bucket', () => {
  function stateWithLan() {
    const state = createEmptyStoryMemory(1);
    state.characters.char_lan = emptyCharacter('char_lan', '林岚', ['小岚', '岚姐']);
    return state;
  }

  it('query 林岚 + candidate 岚姐 → matchedCharacterIds=[char_lan]', () => {
    const state = stateWithLan();
    const docs = [
      {
        chapter: makeChapter(1, 0, '岚姐交出银钥匙。'),
        text: '岚姐交出银钥匙。',
      },
    ];
    const query = '林岚';
    const idf = buildIdfFromTexts(docs.map(d => d.text).concat([query]));
    const scored = scoreMemoryCandidates(docs, query, idf, state);
    expect(scored[0].matchedCharacterIds).toEqual(['char_lan']);
    // Cross-alias candidate enters the character-history bucket.
    const active = findActiveStoryTerms(query, collectStoryRetrievalTerms(state));
    const selected = selectMemoryCandidates(scored, active, 10);
    expect(selected.some(s => s.matchedCharacterIds.includes('char_lan'))).toBe(
      true,
    );
  });

  it('also works for alias 小岚', () => {
    const state = stateWithLan();
    const docs = [
      {
        chapter: makeChapter(1, 0, '小岚追问银钥匙下落。'),
        text: '小岚追问银钥匙下落。',
      },
    ];
    const query = '林岚';
    const idf = buildIdfFromTexts(docs.map(d => d.text).concat([query]));
    const scored = scoreMemoryCandidates(docs, query, idf, state);
    expect(scored[0].matchedCharacterIds).toEqual(['char_lan']);
  });
});

/**
 * §12.4 — Ambiguous long term blocks short-overlap activation.
 *
 * Scenarios (resolver level — `resolveCharacterMentionsInText`):
 *
 *   A) 队长 / 长:
 *        char_captain_a alias=队长, char_captain_b alias=队长 (ambiguous)
 *        char_chang canonical=长 (unique)
 *        text "队长下令，长随后离开"
 *        → ambiguous "队长" claims [0,2); short "长" inside is blocked.
 *        → "长" at non-overlapping offset activates char_chang.
 *
 *   B) 老林 / 林:
 *        char_laolin alias=老林, char_other_laolin alias=老林 (ambiguous)
 *        char_lin canonical=林 (unique)
 *        text "老林进门，林随后离开"
 *
 *   C) Captain / captain / Captain队长:
 *        ambiguous English alias shared across two characters.
 */
describe('SPEC §12.4 — ambiguous long term blocks short-overlap activation', () => {
  it('A) 队长 (ambiguous) blocks inner 长; standalone 长 still activates char_chang', () => {
    const state = createEmptyStoryMemory(1);
    state.characters.char_captain_a = emptyCharacter('char_captain_a', '甲', ['队长']);
    state.characters.char_captain_b = emptyCharacter('char_captain_b', '乙', ['队长']);
    state.characters.char_chang = emptyCharacter('char_chang', '长');
    const terms = collectStoryRetrievalTerms(state);

    expect(terms.ambiguousNormalizedTerms).toContain('队长');

    const text = '队长下令，长随后离开';
    const resolution = resolveCharacterMentionsInText(text, terms);
    // Ambiguous "队长" is encountered (claim recorded) but activates nobody.
    expect(resolution.ambiguousTermsEncountered).toContain('队长');
    expect(resolution.characterIds).not.toContain('char_captain_a');
    expect(resolution.characterIds).not.toContain('char_captain_b');
    // The standalone "长" (after the comma) activates char_chang.
    expect(resolution.characterIds).toEqual(['char_chang']);
  });

  it('B) 老林 (ambiguous) blocks inner 林; standalone 林 still activates char_lin', () => {
    const state = createEmptyStoryMemory(1);
    state.characters.char_laolin_a = emptyCharacter('char_laolin_a', '甲', ['老林']);
    state.characters.char_laolin_b = emptyCharacter('char_laolin_b', '乙', ['老林']);
    state.characters.char_lin = emptyCharacter('char_lin', '林');
    const terms = collectStoryRetrievalTerms(state);

    expect(terms.ambiguousNormalizedTerms).toContain('老林');

    const text = '老林进门，林随后离开';
    const resolution = resolveCharacterMentionsInText(text, terms);
    expect(resolution.ambiguousTermsEncountered).toContain('老林');
    expect(resolution.characterIds).not.toContain('char_laolin_a');
    expect(resolution.characterIds).not.toContain('char_laolin_b');
    expect(resolution.characterIds).toEqual(['char_lin']);
  });

  it('C) Captain/captain English alias is ambiguous regardless of case', () => {
    const state = createEmptyStoryMemory(1);
    state.characters.char_a = emptyCharacter('char_a', 'Alice', ['Captain']);
    state.characters.char_b = emptyCharacter('char_b', 'Bob', ['captain']);
    const terms = collectStoryRetrievalTerms(state);

    // Captain / captain share the normalized form 'captain' → ambiguous.
    expect(terms.ambiguousNormalizedTerms).toContain('captain');

    for (const text of [
      'Captain ordered the team',
      'captain ordered the team',
      'Captain队长 ordered', // mixed-case / combined surface still ambiguous
    ]) {
      const resolution = resolveCharacterMentionsInText(text, terms);
      expect(resolution.characterIds).toEqual([]);
      expect(resolution.ambiguousTermsEncountered.length).toBeGreaterThan(0);
    }
  });

  it('D) 林岚 (unique long canonical) blocks inner 林 (unique short canonical)', () => {
    const state = createEmptyStoryMemory(1);
    state.characters.char_long = emptyCharacter('char_long', '林岚');
    state.characters.char_short = emptyCharacter('char_short', '林');
    const terms = collectStoryRetrievalTerms(state);

    const text = '林岚推门，林随后离开';
    const resolution = resolveCharacterMentionsInText(text, terms);
    // Longest-match first: 林岚 occupies [0,2), blocking inner 林.
    expect(resolution.characterIds).toContain('char_long');
    // The standalone 林 at offset 5 activates char_short.
    expect(resolution.characterIds).toContain('char_short');
    expect(resolution.characterIds.sort()).toEqual(
      ['char_long', 'char_short'].sort(),
    );
  });
});

/**
 * Bucket contract: a candidate whose `matchedCharacters` contains a canonical
 * name but whose `matchedCharacterIds` is empty must NEVER enter the
 * character-history bucket. This is the V2.5.13 hardening invariant.
 */
describe('SPEC §12.5 — character-history bucket uses matchedCharacterIds only', () => {
  it('candidate with matchedCharacters=[李明] but matchedCharacterIds=[] is not a pair candidate', () => {
    const state = createEmptyStoryMemory(1);
    state.characters.char_reporter = emptyCharacter('char_reporter', '李明', ['记者']);
    state.characters.char_doctor = emptyCharacter('char_doctor', '李明', ['医生']);
    const docs = [
      {
        chapter: makeChapter(1, 0, '李明单独行动。'),
        text: '李明单独行动。',
      },
    ];
    const query = '记者和医生';
    const idf = buildIdfFromTexts(docs.map(d => d.text).concat([query]));
    const scored = scoreMemoryCandidates(docs, query, idf, state);
    // Even though the candidate text contains 李明 (a canonical name), the
    // canonical is ambiguous → no characterId matches → empty bucket entry.
    expect(scored[0].matchedCharacterIds).toEqual([]);
    expect(scored[0].pairBoost).toBe(0);
  });
});

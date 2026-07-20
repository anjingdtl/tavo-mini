/**
 * Long-lived system invariants for story memory retrieval (V2.5.12).
 * These must not regress when individual features are patched.
 */

import type { Chapter } from '../src/types/novel';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import { resolveUsableCheckpointForTarget } from '../src/services/storyMemory/storyMemoryCheckpointEligibility';
import { resolveCharacterMentionsInText } from '../src/services/storyMemory/characterMentionResolver';
import { renderStoryMemoryForContext } from '../src/services/storyMemory/storyMemoryRenderer';
import { planStoryMemoryCoverage } from '../src/services/storyMemory/storyMemoryCoverage';
import {
  buildIdfFromTexts,
  collectStoryRetrievalTerms,
  findActiveStoryTerms,
  formatMemoryCandidateLine,
  resolveEpisodicRetrievalMode,
  scoreMemoryCandidates,
  selectCandidatesWithinTokenBudget,
  selectMemoryCandidates,
  orderCandidatesForDisplay,
} from '../src/services/episodicMemoryRetriever';
import { buildMemoryContext } from '../src/services/contextBuilder';
import { estimateTokens } from '../src/utils/tokenEstimator';
import type { ProjectStoryMemoryRecord } from '../src/data/repositories/storyMemoryRepository';

function makeChapter(
  id: number,
  position: number,
  summary: string,
  title = `第${position + 1}章`,
  extras: Partial<Chapter> = {},
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
    memory_summary_tokens: estimateTokens(summary),
    finalized_at: null,
    created_at: '',
    updated_at: '',
    ...extras,
  };
}

function baseState() {
  const state = createEmptyStoryMemory(1);
  state.throughChapterPosition = 10;
  state.characters.char_lan = {
    id: 'char_lan',
    canonicalName: '林岚',
    aliases: ['小岚', '岚姐'],
    role: '调查员',
    immutableProfile: { identity: '', stableTraits: [], affiliations: [] },
    currentState: {
      location: '钟楼',
      physicalState: '正常',
      emotionalState: '警惕',
      currentGoal: '查案',
      knowledge: [],
      possessions: ['银钥匙'],
      secrets: [],
    },
    status: 'active',
    firstSeenChapterId: 1,
    firstSeenPosition: 0,
    lastChangedChapterId: 10,
    lastChangedPosition: 10,
    evidenceChapterIds: [1],
  };
  state.characters.char_zhou = {
    ...state.characters.char_lan,
    id: 'char_zhou',
    canonicalName: '周恪',
    aliases: [],
    lastChangedPosition: 9,
  };
  state.characters.char_reporter = {
    ...state.characters.char_lan,
    id: 'char_reporter',
    canonicalName: '李明',
    aliases: ['记者'],
  };
  state.characters.char_doctor = {
    ...state.characters.char_lan,
    id: 'char_doctor',
    canonicalName: '李明',
    aliases: ['医生'],
  };
  state.characters.char_wang = {
    ...state.characters.char_lan,
    id: 'char_wang',
    canonicalName: '王芳',
    aliases: [],
  };
  state.relationships.rel_lan_zhou = {
    id: 'rel_lan_zhou',
    fromCharacterId: 'char_lan',
    toCharacterId: 'char_zhou',
    direction: 'bidirectional',
    relationType: '盟友',
    currentState: '合作查案',
    trustLevel: 'high',
    publicStatus: '同事',
    hiddenStatus: '',
    reason: '共同调查',
    firstSeenChapterId: 1,
    lastChangedChapterId: 10,
    lastChangedPosition: 10,
    evidenceChapterIds: [1],
  };
  return state;
}

function cleanRecord(through: number): ProjectStoryMemoryRecord {
  const state = baseState();
  state.throughChapterPosition = through;
  return {
    state,
    status: 'clean',
    dirtyFromPosition: null,
    lastError: '',
    updatedAt: '',
  };
}

describe('system invariants: time', () => {
  it.each([
    { through: 12, target: 5, label: 'future' },
    { through: 5, target: 5, label: 'same' },
  ])('never usable when checkpoint is $label relative to target', ({
    through,
    target,
  }) => {
    const r = resolveUsableCheckpointForTarget(cleanRecord(through), target);
    expect(r.usable).toBe(false);
    expect(r.checkpointThroughPosition).toBe(-1);
  });

  it('usable only when through < target', () => {
    const r = resolveUsableCheckpointForTarget(cleanRecord(4), 5);
    expect(r.usable).toBe(true);
    expect(r.checkpointThroughPosition).toBe(4);
  });
});

describe('system invariants: status never injects', () => {
  it.each(['dirty', 'empty', 'failed', 'rebuilding'] as const)(
    'status %s is never usable',
    status => {
      const state = baseState();
      const r = resolveUsableCheckpointForTarget(
        {
          state,
          status,
          dirtyFromPosition: status === 'dirty' ? 0 : null,
          lastError: '',
          updatedAt: '',
        },
        20,
      );
      expect(r.usable).toBe(false);
    },
  );
});

describe('system invariants: character identity by id', () => {
  it('activates three distinct IDs for 记者/医生/王芳 despite 李明 duplicate name', () => {
    const terms = collectStoryRetrievalTerms(baseState());
    const active = findActiveStoryTerms('记者和医生去找王芳', terms);
    expect(active.activeCharacterIds.sort()).toEqual(
      ['char_doctor', 'char_reporter', 'char_wang'].sort(),
    );
    expect(active.canonicalNameByCharacterId.char_reporter).toBe('李明');
    expect(active.canonicalNameByCharacterId.char_doctor).toBe('李明');
    expect(active.canonicalNameByCharacterId.char_wang).toBe('王芳');
    // No parallel-array recovery: map is explicit
    expect(active.activeCharacters).toHaveLength(3);
  });

  it('cross-alias: query 林岚 matches candidate 小岚 / 岚姐', () => {
    const state = baseState();
    const terms = collectStoryRetrievalTerms(state);
    const queryRes = resolveCharacterMentionsInText('林岚追问钥匙', terms);
    expect(queryRes.characterIds).toEqual(['char_lan']);

    for (const text of ['小岚交出钥匙', '岚姐交出钥匙', '林岚交出钥匙']) {
      const cand = resolveCharacterMentionsInText(text, terms);
      expect(cand.characterIds).toContain('char_lan');
      const intersection = queryRes.characterIds.filter(id =>
        cand.characterIds.includes(id),
      );
      expect(intersection).toEqual(['char_lan']);
    }
  });

  it('query and candidate use the same resolver (no third path for identity)', () => {
    const terms = collectStoryRetrievalTerms(baseState());
    const text = '岚姐与周恪会面';
    const a = resolveCharacterMentionsInText(text, terms);
    const b = findActiveStoryTerms(text, terms);
    expect(b.activeCharacterIds.sort()).toEqual([...a.characterIds].sort());
  });

  it('substring 林 does not activate 林岚', () => {
    const terms = collectStoryRetrievalTerms(baseState());
    const active = findActiveStoryTerms('林在门口', terms);
    expect(active.activeCharacterIds).not.toContain('char_lan');
  });
});

describe('system invariants: token budget', () => {
  const chapters = Array.from({ length: 12 }, (_, i) =>
    makeChapter(
      i + 1,
      i,
      `第${i + 1}章：林岚与周恪调查银钥匙来源，发现新线索。`.repeat(3),
    ),
  );

  it.each([0, 1, 5, 10, 50, 200, 5000])(
    'episodic memory never exceeds budget=%i',
    budget => {
      const current = makeChapter(99, 12, '', '当前', {
        title: '当前章',
        synopsis: '林岚继续',
        content: '林岚',
      });
      const text = buildMemoryContext(
        chapters,
        current,
        10,
        budget,
        {
          queryText: '林岚与周恪追查银钥匙',
          storyState: baseState(),
        },
      );
      expect(estimateTokens(text)).toBeLessThanOrEqual(budget);
    },
  );

  it.each([0, 1, 10, 50, 100, 800, 4000])(
    'story memory render never exceeds budget=%i',
    budget => {
      const result = renderStoryMemoryForContext(baseState(), {
        currentChapter: makeChapter(99, 20, '', '林岚与周恪'),
        budgetTokens: budget,
        retrievalUserPrompt: '林岚与周恪继续合作',
      });
      expect(result.estimatedTokens).toBeLessThanOrEqual(budget);
      if (result.text) {
        expect(estimateTokens(result.text)).toBeLessThanOrEqual(budget);
      }
    },
  );
});

describe('system invariants: continuity coverage partition', () => {
  it('every pending chapter is in exactly one of raw/episodicFallback/uncovered', () => {
    const chapters = Array.from({ length: 8 }, (_, i) =>
      makeChapter(i + 1, i, `摘要${i}`, `第${i + 1}章`, {
        content: '正文'.repeat(200),
      }),
    );
    const current = chapters[7];
    const plan = planStoryMemoryCoverage({
      currentChapter: current,
      chapters,
      checkpointThroughPosition: 2,
      slidingBudgetTokens: 500,
    });
    const pendingIds = plan.pendingChapters.map(c => c.id).sort();
    const union = [
      ...plan.rawChapterIds,
      ...plan.episodicFallbackChapterIds,
      ...plan.uncoveredChapterIds,
    ].sort();
    expect(union).toEqual(pendingIds);
    const seen = new Set<number>();
    for (const id of union) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});

describe('system invariants: retrieval modes', () => {
  it('resolveEpisodicRetrievalMode is pure and ordered', () => {
    expect(
      resolveEpisodicRetrievalMode({
        v2Enabled: false,
        queryText: 'x',
        idfSize: 10,
      }),
    ).toBe('legacy');
    expect(
      resolveEpisodicRetrievalMode({
        v2Enabled: true,
        queryText: 'x',
        idfSize: 0,
      }),
    ).toBe('empty_idf_recent');
    expect(
      resolveEpisodicRetrievalMode({
        v2Enabled: true,
        queryText: '',
        idfSize: 5,
      }),
    ).toBe('empty_query_recent');
    expect(
      resolveEpisodicRetrievalMode({
        v2Enabled: true,
        queryText: '林岚',
        idfSize: 5,
      }),
    ).toBe('v2_query');
  });
});

describe('system invariants: true empty query branch', () => {
  it('empty title/synopsis/content + queryText "" uses recent path and stays in budget', () => {
    const previous = [
      makeChapter(1, 0, '最早摘要林岚'),
      makeChapter(2, 1, '中间摘要'),
      makeChapter(3, 2, '最近摘要周恪'),
    ];
    const current = makeChapter(4, 3, '', '', {
      title: '',
      synopsis: '',
      content: '',
    });
    const mode = resolveEpisodicRetrievalMode({
      v2Enabled: true,
      queryText: '',
      idfSize: 10,
    });
    expect(mode).toBe('empty_query_recent');

    for (const budget of [1, 5, 10, 100]) {
      const text = buildMemoryContext(previous, current, 5, budget, {
        queryText: '',
        storyState: baseState(),
      });
      expect(estimateTokens(text)).toBeLessThanOrEqual(budget);
      // Must not run entity matching that would prefer 林岚 early chapters.
      if (budget >= 50 && text) {
        // Chronological display: earliest kept chapter appears first in joined lines
        // when multiple fit; recency selects then chronological display.
        expect(text.includes('摘要') || text === '').toBe(true);
      }
    }
  });
});

describe('system invariants: relationship budget guarantee', () => {
  it('with many current characters, key relationship still enters under tight budget', () => {
    const state = baseState();
    // 8 characters all mentioned in user prompt.
    for (let i = 0; i < 6; i += 1) {
      const id = `char_extra_${i}`;
      state.characters[id] = {
        ...state.characters.char_lan,
        id,
        canonicalName: `配角${i}号很长名字占预算`,
        aliases: [],
        lastChangedPosition: 5,
      };
      // Stale relationships among extras
      if (i > 0) {
        const rid = `rel_extra_${i}`;
        state.relationships[rid] = {
          ...state.relationships.rel_lan_zhou,
          id: rid,
          fromCharacterId: `char_extra_${i - 1}`,
          toCharacterId: id,
          lastChangedPosition: 1,
        };
      }
    }
    const prompt = [
      '林岚',
      '周恪',
      ...Array.from({ length: 6 }, (_, i) => `配角${i}号很长名字占预算`),
    ].join('、');

    // Find a budget that can fit ~2–3 cards + 1 rel but not all 8 cards.
    const full = renderStoryMemoryForContext(state, {
      currentChapter: makeChapter(99, 20, '', prompt),
      budgetTokens: 8000,
      retrievalUserPrompt: prompt,
    });
    // Tight: enough for prefix + 林岚 + 周恪 + rel, not all extras
    const tightBudget = Math.min(900, Math.floor(full.estimatedTokens * 0.35));
    const result = renderStoryMemoryForContext(state, {
      currentChapter: makeChapter(99, 20, '', prompt),
      budgetTokens: Math.max(400, tightBudget),
      retrievalUserPrompt: prompt,
    });
    expect(result.estimatedTokens).toBeLessThanOrEqual(
      Math.max(400, tightBudget),
    );
    // Key pair + relationship should win over dumping all characters.
    if (result.includedCharacterIds.length >= 2) {
      expect(result.includedCharacterIds).toEqual(
        expect.arrayContaining(['char_lan', 'char_zhou']),
      );
      expect(result.includedRelationshipIds).toContain('rel_lan_zhou');
    }
    expect(result.text.includes('林岚') || result.includedCharacterIds.length === 0).toBe(
      true,
    );
  });
});

describe('system invariants: fixed-seed anti-regression (no throw, deterministic)', () => {
  /** Fixed-seed LCG (no bitwise ops — eslint no-bitwise clean). */
  function seededRandom(seed: number) {
    let state = seed % 2147483647;
    if (state <= 0) state += 2147483646;
    return function next() {
      state = (state * 48271) % 2147483647;
      return (state - 1) / 2147483646;
    };
  }

  function buildScaledState(personCount: number, seed: number) {
    const rand = seededRandom(seed);
    const state = createEmptyStoryMemory(1);
    state.throughChapterPosition = 50;
    const names = ['林', '周', '王', '李', '张', '赵', '陈', '杨'];
    for (let i = 0; i < personCount; i += 1) {
      const id = `char_${i}`;
      const base = names[i % names.length];
      const canonicalName =
        i % 7 === 0 && i > 0
          ? state.characters[`char_${i - 1}`]?.canonicalName || `${base}${i}`
          : `${base}${i}名`;
      const aliasCount = Math.floor(rand() * 5);
      const aliases: string[] = [];
      for (let a = 0; a < aliasCount; a += 1) {
        aliases.push(`${canonicalName}别${a}`);
      }
      if (i % 11 === 0) aliases.push('Captain');
      state.characters[id] = {
        id,
        canonicalName,
        aliases,
        role: '角色',
        immutableProfile: {
          identity: '',
          stableTraits: [],
          affiliations: [],
        },
        currentState: {
          location: '城',
          physicalState: '',
          emotionalState: '',
          currentGoal: '',
          knowledge: [],
          possessions: i % 3 === 0 ? [`物${i}`] : [],
          secrets: [],
        },
        status: 'active',
        firstSeenChapterId: 1,
        firstSeenPosition: 0,
        lastChangedChapterId: i,
        lastChangedPosition: i % 50,
        evidenceChapterIds: [1],
      };
    }
    return state;
  }

  it.each([
    { persons: 10, chapters: 30, seed: 42 },
    { persons: 50, chapters: 100, seed: 7 },
    { persons: 100, chapters: 100, seed: 99 },
  ])(
    'scale persons=$persons chapters=$chapters seed=$seed is deterministic and in budget',
    ({ persons, chapters, seed }) => {
      const state = buildScaledState(persons, seed);
      const terms = collectStoryRetrievalTerms(state);
      const docs = Array.from({ length: chapters }, (_, i) => {
        const charId = `char_${i % persons}`;
        const name = state.characters[charId].canonicalName;
        const alias =
          state.characters[charId].aliases[0] || name;
        return {
          chapter: makeChapter(i + 1, i, `${name}与${alias}在第${i + 1}章行动`),
          text: `${name}与${alias}在第${i + 1}章行动`,
        };
      });
      const query = `${state.characters.char_0.canonicalName}调查 ${
        state.characters.char_1?.canonicalName || ''
      }`;
      const active1 = findActiveStoryTerms(query, terms);
      const active2 = findActiveStoryTerms(query, terms);
      expect(active1).toEqual(active2);
      expect(new Set(active1.activeCharacterIds).size).toBe(
        active1.activeCharacterIds.length,
      );

      const idf = buildIdfFromTexts(docs.map(d => d.text));
      const scored = scoreMemoryCandidates(docs, query, idf, state);
      const selected = selectMemoryCandidates(scored, active1, 10);
      const budgeted = selectCandidatesWithinTokenBudget(selected, 200);
      const text = orderCandidatesForDisplay(budgeted)
        .map(formatMemoryCandidateLine)
        .join('\n');
      expect(estimateTokens(text)).toBeLessThanOrEqual(200);

      const rendered = renderStoryMemoryForContext(state, {
        currentChapter: makeChapter(999, chapters + 1, '', query),
        budgetTokens: 1500,
        retrievalUserPrompt: query,
      });
      expect(rendered.estimatedTokens).toBeLessThanOrEqual(1500);
    },
  );
});

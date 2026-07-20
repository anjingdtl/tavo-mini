/**
 * Episodic retrieval V2: tokenizer, entity scoring, hybrid Top-K.
 */

import type { Chapter } from '../src/types/novel';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import {
  CHARACTER_PAIR_BOOST,
  buildEpisodicRetrievalQuery,
  buildIdfFromTexts,
  collectStoryRetrievalTerms,
  findActiveStoryTerms,
  formatMemoryCandidateLine,
  formatMemoryCandidatePrefix,
  orderCandidatesForDisplay,
  scoreMemoryCandidates,
  selectCandidatesWithinTokenBudget,
  selectMemoryCandidates,
  tokenizeForMemoryRetrieval,
  type ScoredMemoryCandidate,
} from '../src/services/episodicMemoryRetriever';
import * as episodicMemoryRetriever from '../src/services/episodicMemoryRetriever';
import { estimateTokens } from '../src/utils/tokenEstimator';
import { buildMemoryContext } from '../src/services/contextBuilder';

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
    memory_summary_tokens: estimateTokens(summary),
    finalized_at: null,
    created_at: '',
    updated_at: '',
  };
}

function storyStateWithEntities() {
  const state = createEmptyStoryMemory(1);
  state.characters.char_lan = {
    id: 'char_lan',
    canonicalName: '林岚',
    aliases: ['小岚'],
    role: '调查员',
    immutableProfile: {
      identity: '',
      stableTraits: [],
      affiliations: [],
    },
    currentState: {
      location: '',
      physicalState: '',
      emotionalState: '',
      currentGoal: '',
      knowledge: [],
      possessions: ['银钥匙'],
      secrets: [],
    },
    status: 'active',
    firstSeenChapterId: 1,
    firstSeenPosition: 0,
    lastChangedChapterId: 1,
    lastChangedPosition: 0,
    evidenceChapterIds: [1],
  };
  state.characters.char_zhou = {
    ...state.characters.char_lan,
    id: 'char_zhou',
    canonicalName: '周恪',
    aliases: [],
    currentState: {
      ...state.characters.char_lan.currentState,
      possessions: [],
    },
  };
  state.characters.char_bai = {
    ...state.characters.char_lan,
    id: 'char_bai',
    canonicalName: '白薇',
    aliases: [],
    currentState: {
      ...state.characters.char_lan.currentState,
      possessions: [],
    },
  };
  state.mainline.openThreads.thread_key = {
    id: 'thread_key',
    title: '银钥匙来源',
    description: '追查钥匙出处',
    ownerCharacterIds: ['char_lan'],
    priority: 'high',
    openedChapterId: 1,
    lastChangedChapterId: 1,
    deadlineOrTrigger: '',
    evidenceChapterIds: [1],
  };
  state.mainline.foreshadowing.fs_1 = {
    id: 'fs_1',
    setup: '钟楼暗门',
    expectedPayoff: '档案室',
    status: 'open',
    openedChapterId: 1,
    lastChangedChapterId: 1,
    evidenceChapterIds: [1],
  };
  return state;
}

describe('tokenizeForMemoryRetrieval', () => {
  it('emits unigram, bigram, and trigram for Chinese runs', () => {
    const tokens = tokenizeForMemoryRetrieval('林岚发现银钥匙');
    for (const expected of [
      '林',
      '林岚',
      '发现',
      '银钥',
      '钥匙',
      '银钥匙',
    ]) {
      expect(tokens).toContain(expected);
    }
  });

  it('keeps English words and numbers intact and drops punctuation', () => {
    const tokens = tokenizeForMemoryRetrieval('Hello World 123！测试');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
    expect(tokens).toContain('123');
    expect(tokens).not.toContain('！');
    expect(tokens.some(t => t.includes('!'))).toBe(false);
  });

  it('filters stop words and returns empty for blank input', () => {
    expect(tokenizeForMemoryRetrieval('')).toEqual([]);
    expect(tokenizeForMemoryRetrieval('the and 章节')).not.toContain('the');
    expect(tokenizeForMemoryRetrieval('the and 章节')).not.toContain('章节');
  });

  it('stays linear for long Chinese runs (no quadratic explosion)', () => {
    const long = '甲'.repeat(200);
    const tokens = tokenizeForMemoryRetrieval(long);
    // unigrams + bigrams + trigrams ≈ 200 + 199 + 198
    expect(tokens.length).toBeLessThanOrEqual(200 + 199 + 198);
    expect(tokens.length).toBeGreaterThan(500);
  });
});

describe('buildEpisodicRetrievalQuery', () => {
  it('includes title, synopsis, user prompt, content head, and previous tail', () => {
    const current = makeChapter(30, 29, '', '夜探档案馆');
    current.synopsis = '林岚与周恪再次交锋';
    current.content = '';
    const previous = makeChapter(29, 28, '', '上一章');
    // Longer than the 800-char tail window so only the ending is queried.
    previous.content = `HEAD_ONLY_MARKER_${'中'.repeat(900)}白薇将钥匙收入外套`;

    const query = buildEpisodicRetrievalQuery({
      currentChapter: current,
      previousChapter: previous,
      retrievalUserPrompt: '写林岚追问周恪银钥匙的去向',
    });

    expect(query).toContain('夜探档案馆');
    expect(query).toContain('林岚');
    expect(query).toContain('周恪');
    expect(query).toContain('银钥匙');
    expect(query).toContain('白薇');
    expect(query).toContain('白薇将钥匙收入外套');
    expect(previous.content.length).toBeGreaterThan(800);
    expect(query).not.toContain('HEAD_ONLY_MARKER');
  });

  it('does not embed the entire previous chapter body', () => {
    const current = makeChapter(2, 1, '');
    const previous = makeChapter(1, 0, '');
    previous.content = `UNIQUE_HEAD_MARKER_${'Z'.repeat(900)}_TAIL_MARKER_ONLY`;
    const query = buildEpisodicRetrievalQuery({
      currentChapter: current,
      previousChapter: previous,
    });
    expect(query).toContain('TAIL_MARKER_ONLY');
    expect(query.length).toBeLessThan(previous.content.length);
    expect(query).not.toContain('UNIQUE_HEAD_MARKER');
  });
});

describe('entity scoring and pair boost', () => {
  it('ranks the multi-character promise scene highest', () => {
    const docs = [
      {
        chapter: makeChapter(1, 0, '林岚发现钟楼暗门。'),
        text: '林岚发现钟楼暗门。',
      },
      {
        chapter: makeChapter(2, 1, '周恪曾答应林岚隐瞒银钥匙的来源。'),
        text: '周恪曾答应林岚隐瞒银钥匙的来源。',
      },
      {
        chapter: makeChapter(3, 2, '白薇调查档案馆。'),
        text: '白薇调查档案馆。',
      },
    ];
    const query = '林岚追问周恪银钥匙的承诺';
    const idf = buildIdfFromTexts(docs.map(d => d.text).concat([query]));
    const scored = scoreMemoryCandidates(
      docs,
      query,
      idf,
      storyStateWithEntities(),
    );
    const byId = Object.fromEntries(
      scored.map(item => [item.chapter.id, item]),
    );
    expect(byId[2].finalScore).toBeGreaterThan(byId[1].finalScore);
    expect(byId[2].finalScore).toBeGreaterThan(byId[3].finalScore);
    expect(byId[2].matchedCharacters).toEqual(
      expect.arrayContaining(['林岚', '周恪']),
    );
    expect(byId[2].matchedObjects).toContain('银钥匙');
    expect(byId[2].pairBoost).toBe(CHARACTER_PAIR_BOOST);
  });

  it('collects terms safely when story state is missing', () => {
    const terms = collectStoryRetrievalTerms(null);
    expect(terms.canonicalCharacterNames).toEqual([]);
    expect(terms.aliasToCanonicalNames).toEqual({});
    expect(terms.ambiguousAliases).toEqual([]);
    const active = findActiveStoryTerms('林岚', terms);
    expect(active.activeCharacterNames).toEqual([]);
  });
});

describe('ambiguous shared aliases', () => {
  function stateWithSharedCaptainAlias() {
    const state = createEmptyStoryMemory(3);
    for (const [id, name, aliases] of [
      ['char_lan', '林岚', ['队长']],
      ['char_zhou', '周恪', ['队长']],
      ['char_bai', '白薇', ['小薇']],
    ] as const) {
      state.characters[id] = {
        id,
        canonicalName: name,
        aliases: [...aliases],
        role: '',
        immutableProfile: {
          identity: '',
          stableTraits: [],
          affiliations: [],
        },
        currentState: {
          location: '',
          physicalState: '',
          emotionalState: '',
          currentGoal: '',
          knowledge: [],
          possessions: [],
          secrets: [],
        },
        status: 'active',
        firstSeenChapterId: 1,
        firstSeenPosition: 0,
        lastChangedChapterId: 1,
        lastChangedPosition: 0,
        evidenceChapterIds: [1],
      };
    }
    return state;
  }

  it('does not activate either character for an ambiguous alias alone', () => {
    const terms = collectStoryRetrievalTerms(stateWithSharedCaptainAlias());
    expect(terms.ambiguousAliases).toContain('队长');
    expect(terms.aliasToCanonicalNames['队长']).toEqual(
      expect.arrayContaining(['林岚', '周恪']),
    );
    expect(terms.aliasToCanonicalNames['小薇']).toEqual(['白薇']);

    const active = findActiveStoryTerms('队长下令调查', terms);
    expect(active.activeCharacterNames).not.toContain('林岚');
    expect(active.activeCharacterNames).not.toContain('周恪');
    expect(active.aliasHits).toEqual([]);
    expect(active.canonicalCharacterNames).toEqual([]);
  });

  it('activates only the canonical name when it appears with the shared alias', () => {
    const terms = collectStoryRetrievalTerms(stateWithSharedCaptainAlias());
    const active = findActiveStoryTerms('林岚队长下令调查', terms);
    expect(active.activeCharacterNames).toEqual(['林岚']);
    expect(active.activeCharacterNames).not.toContain('周恪');
  });

  it('still activates unique aliases and never fabricates pair boost from ambiguity', () => {
    const terms = collectStoryRetrievalTerms(stateWithSharedCaptainAlias());
    const unique = findActiveStoryTerms('小薇调查', terms);
    expect(unique.activeCharacterNames).toEqual(['白薇']);
    expect(unique.activeCharacterIds).toEqual(['char_bai']);
    expect(unique.aliasHits).toEqual([
      { alias: '小薇', canonicalName: '白薇', characterId: 'char_bai' },
    ]);

    const docs = [
      {
        chapter: makeChapter(1, 0, '林岚在会议室部署调查。'),
        text: '林岚在会议室部署调查。',
      },
      {
        chapter: makeChapter(2, 1, '周恪在现场执行命令。'),
        text: '周恪在现场执行命令。',
      },
    ];
    const query = '队长下令调查';
    const idf = buildIdfFromTexts(docs.map(d => d.text).concat([query]));
    const scored = scoreMemoryCandidates(
      docs,
      query,
      idf,
      stateWithSharedCaptainAlias(),
    );
    expect(scored.every(item => item.pairBoost === 0)).toBe(true);
    expect(scored.every(item => item.matchedCharacters.length === 0)).toBe(
      true,
    );
  });
});

describe('token budget selects by priority then displays chronologically', () => {
  function scored(
    id: number,
    position: number,
    text: string,
    finalScore: number,
    title?: string,
  ): ScoredMemoryCandidate {
    return {
      chapter: makeChapter(id, position, text, title),
      text,
      cosineScore: finalScore,
      entityBoost: 0,
      pairBoost: 0,
      finalScore,
      matchedCharacters: [],
      matchedObjects: [],
      matchedThreads: [],
    };
  }

  it('keeps high-priority later chapters when early long low-score would exhaust budget', () => {
    const longEarly =
      '无关风景与路途描写。'.repeat(40) +
      '早期次要摘要，细节冗长但无关键承诺。';
    const promise =
      '周恪答应林岚不告诉白薇银钥匙来源，双方立下保密承诺。';
    const recent = '白薇暗示自己知道钥匙来源。';

    const a = scored(1, 0, longEarly, 0.1, '早期冗长');
    const b = scored(2, 14, promise, 0.95, '关键承诺');
    const c = scored(3, 28, recent, 0.55, '近期');

    // Priority order: B, C, A (hybrid Top-K order, not chronology).
    const byPriority = [b, c, a];
    const lineB = formatMemoryCandidateLine(b);
    const lineC = formatMemoryCandidateLine(c);
    const budget =
      estimateTokens(lineB) + estimateTokens(lineC) + 5; // room for B+C only

    const kept = selectCandidatesWithinTokenBudget(byPriority, budget);
    const ids = kept.map(item => item.chapter.id);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
    expect(ids).not.toContain(1);

    const ordered = orderCandidatesForDisplay(kept);
    expect(ordered.map(item => item.chapter.position)).toEqual([14, 28]);

    const total = kept.reduce(
      (sum, item) => sum + estimateTokens(formatMemoryCandidateLine(item)),
      0,
    );
    expect(total).toBeLessThanOrEqual(budget);
  });

  it('skips an over-long middle candidate and keeps a later shorter one', () => {
    const shortHigh = scored(1, 5, '林岚追问周恪银钥匙承诺。', 1.0);
    const longMiddle = scored(
      2,
      10,
      '无关填充文本。'.repeat(80),
      0.8,
    );
    const shortLater = scored(3, 20, '白薇试探周恪。', 0.7);
    const budget =
      estimateTokens(formatMemoryCandidateLine(shortHigh)) +
      estimateTokens(formatMemoryCandidateLine(shortLater)) +
      2;
    const kept = selectCandidatesWithinTokenBudget(
      [shortHigh, longMiddle, shortLater],
      budget,
    );
    expect(kept.map(k => k.chapter.id)).toEqual([1, 3]);
  });

  it('truncates the highest-priority candidate when it alone exceeds budget', () => {
    const huge = scored(
      9,
      3,
      '关键承诺与钥匙转交细节。'.repeat(30),
      1.0,
    );
    const tinyBudget = 40;
    expect(estimateTokens(formatMemoryCandidateLine(huge))).toBeGreaterThan(
      tinyBudget,
    );
    const kept = selectCandidatesWithinTokenBudget([huge], tinyBudget);
    expect(kept).toHaveLength(1);
    expect(estimateTokens(formatMemoryCandidateLine(kept[0]))).toBeLessThanOrEqual(
      tinyBudget,
    );
    expect(kept[0].text.length).toBeLessThan(huge.text.length);
  });

  it('buildMemoryContext prefers high-score later interaction over early long filler under tight budget', () => {
    const longEarly = '档案馆日常描写与天气。'.repeat(35);
    const chapters = [
      makeChapter(1, 0, longEarly, '早期'),
      makeChapter(
        2,
        14,
        '周恪答应林岚不告诉白薇银钥匙来源，立下保密承诺。',
        '承诺',
      ),
      makeChapter(3, 28, '白薇暗示知道钥匙来源。', '近期'),
    ];
    const query = '林岚追问周恪银钥匙的保密承诺';
    const linePromise = formatMemoryCandidateLine({
      chapter: chapters[1],
      text: String(chapters[1].memory_summary),
    });
    const lineRecent = formatMemoryCandidateLine({
      chapter: chapters[2],
      text: String(chapters[2].memory_summary),
    });
    const budget =
      estimateTokens(linePromise) + estimateTokens(lineRecent) + 8;
    const text = buildMemoryContext(
      chapters,
      makeChapter(99, 29, '', '当前'),
      10,
      budget,
      { queryText: query, storyState: storyStateWithEntities() },
    );
    expect(text).toContain('保密承诺');
    expect(text).toContain('白薇暗示');
    // Early long filler must not crowd out the promise chapter.
    expect(text).not.toContain('档案馆日常描写');
    expect(estimateTokens(text)).toBeLessThanOrEqual(budget);
    // Chronological display among kept lines.
    const idxPromise = text.indexOf('第 15 章');
    const idxRecent = text.indexOf('第 29 章');
    expect(idxPromise).toBeGreaterThanOrEqual(0);
    expect(idxRecent).toBeGreaterThan(idxPromise);
  });

  it('tiny budgets 1/5/10 never exceed and return empty when below full prefix cost', () => {
    const candidate = scored(
      1,
      0,
      '林岚与周恪关于银钥匙的保密承诺细节。'.repeat(5),
      1.0,
      '承诺章',
    );
    const prefix = formatMemoryCandidatePrefix(candidate.chapter);
    const prefixCost = estimateTokens(prefix);
    expect(prefixCost).toBeGreaterThan(10);

    for (const budget of [1, 5, 10]) {
      const kept = selectCandidatesWithinTokenBudget([candidate], budget);
      expect(kept).toEqual([]);
      const memoryText = kept
        .map(item => formatMemoryCandidateLine(item))
        .join('\n');
      expect(estimateTokens(memoryText)).toBeLessThanOrEqual(budget);
      // Empty string estimates as 0.
      expect(memoryText).toBe('');
    }
  });

  it('returns empty when budget is strictly less than full prefix tokens', () => {
    const candidate = scored(2, 4, '周恪隐瞒银钥匙来源。', 0.9, '短标题');
    const prefixCost = estimateTokens(
      formatMemoryCandidatePrefix(candidate.chapter),
    );
    const budget = Math.max(1, prefixCost - 1);
    const kept = selectCandidatesWithinTokenBudget([candidate], budget);
    expect(kept).toEqual([]);
  });

  it('fits prefix plus a short body when budget is exactly large enough', () => {
    const body = '林岚追问。';
    const candidate = scored(3, 1, body, 1.0, '夜');
    const fullLine = formatMemoryCandidateLine(candidate);
    const fullCost = estimateTokens(fullLine);
    const prefixCost = estimateTokens(
      formatMemoryCandidatePrefix(candidate.chapter),
    );
    // Budget between prefix and full line forces first-candidate body truncation,
    // or equals fullCost when body is already short enough.
    const budget =
      prefixCost + Math.max(1, Math.min(3, fullCost - prefixCost));
    expect(budget).toBeGreaterThanOrEqual(prefixCost);
    expect(budget).toBeLessThanOrEqual(fullCost);

    const kept = selectCandidatesWithinTokenBudget([candidate], budget);
    expect(kept).toHaveLength(1);
    const line = formatMemoryCandidateLine(kept[0]);
    expect(line.startsWith(formatMemoryCandidatePrefix(candidate.chapter))).toBe(
      true,
    );
    expect(estimateTokens(line)).toBeLessThanOrEqual(budget);
    // Complete prefix retained (no partial-prefix reassembly bug).
    expect(line).toContain('摘要：');
    if (budget < fullCost) {
      expect(kept[0].text.length).toBeLessThan(body.length);
    }
  });

  it('truncates first overlong candidate body after complete prefix under mid budget', () => {
    const body = '关键承诺与钥匙转交细节。'.repeat(40);
    const candidate = scored(9, 3, body, 1.0, '超长摘要');
    const prefix = formatMemoryCandidatePrefix(candidate.chapter);
    const prefixCost = estimateTokens(prefix);
    const fullCost = estimateTokens(formatMemoryCandidateLine(candidate));
    const budget = prefixCost + 25;
    expect(fullCost).toBeGreaterThan(budget);
    expect(budget).toBeGreaterThan(prefixCost);

    const kept = selectCandidatesWithinTokenBudget([candidate], budget);
    expect(kept).toHaveLength(1);
    const line = formatMemoryCandidateLine(kept[0]);
    expect(line.startsWith(prefix)).toBe(true);
    expect(kept[0].text.length).toBeLessThan(body.length);
    expect(kept[0].text.length).toBeGreaterThan(0);
    expect(estimateTokens(line)).toBeLessThanOrEqual(budget);
  });

  it('final formatted memory text never exceeds budgetTokens after truncation', () => {
    const candidates = [
      scored(1, 0, '早期填充描写。'.repeat(20), 0.4, '早期'),
      scored(
        2,
        14,
        '周恪答应林岚不告诉白薇银钥匙来源，立下保密承诺。'.repeat(8),
        0.95,
        '承诺',
      ),
      scored(3, 28, '白薇暗示知道钥匙来源。', 0.55, '近期'),
    ];
    for (const budget of [1, 5, 10, 30, 60, 120]) {
      const kept = selectCandidatesWithinTokenBudget(
        [candidates[1], candidates[2], candidates[0]],
        budget,
      );
      const memoryText = kept
        .map(item => formatMemoryCandidateLine(item))
        .join('\n');
      expect(estimateTokens(memoryText)).toBeLessThanOrEqual(budget);
    }
  });
});

describe('precomputed story scoring terms', () => {
  it('precomputed path matches legacy scoreMemoryCandidates results exactly', () => {
    const docs = [
      {
        chapter: makeChapter(1, 0, '林岚发现钟楼暗门。'),
        text: '林岚发现钟楼暗门。',
      },
      {
        chapter: makeChapter(2, 1, '周恪曾答应林岚隐瞒银钥匙的来源。'),
        text: '周恪曾答应林岚隐瞒银钥匙的来源。',
      },
      {
        chapter: makeChapter(3, 2, '白薇调查档案馆。'),
        text: '白薇调查档案馆。',
      },
    ];
    const query = '林岚追问周恪银钥匙的承诺';
    const idf = buildIdfFromTexts(docs.map(d => d.text).concat([query]));
    const state = storyStateWithEntities();
    const storyTerms = collectStoryRetrievalTerms(state);
    const activeTerms = findActiveStoryTerms(query, storyTerms);

    const legacy = scoreMemoryCandidates(docs, query, idf, state);
    const precomputed = scoreMemoryCandidates(
      docs,
      query,
      idf,
      state,
      undefined,
      undefined,
      { storyTerms, activeTerms },
    );
    expect(precomputed).toEqual(legacy);

    // Precomputed must not depend on re-reading storyState.
    const withNullState = scoreMemoryCandidates(
      docs,
      query,
      idf,
      null,
      undefined,
      undefined,
      { storyTerms, activeTerms },
    );
    expect(withNullState).toEqual(legacy);
  });

  it('null story memory still scores without entity boosts', () => {
    const docs = [
      {
        chapter: makeChapter(1, 0, '林岚发现暗门。'),
        text: '林岚发现暗门。',
      },
    ];
    const query = '林岚银钥匙';
    const idf = buildIdfFromTexts(docs.map(d => d.text).concat([query]));
    const emptyTerms = collectStoryRetrievalTerms(null);
    const emptyActive = findActiveStoryTerms(query, emptyTerms);
    const scored = scoreMemoryCandidates(
      docs,
      query,
      idf,
      null,
      undefined,
      undefined,
      { storyTerms: emptyTerms, activeTerms: emptyActive },
    );
    expect(scored[0].entityBoost).toBe(0);
    expect(scored[0].pairBoost).toBe(0);
    expect(scored[0].matchedCharacters).toEqual([]);
  });

  it('buildMemoryContext collects story retrieval terms only once per build', () => {
    const spy = jest.spyOn(
      episodicMemoryRetriever,
      'collectStoryRetrievalTerms',
    );
    const chapters = [
      makeChapter(1, 0, '林岚在钟楼发现暗门。', '一'),
      makeChapter(2, 1, '周恪答应林岚隐瞒银钥匙来源。', '二'),
      makeChapter(3, 2, '白薇调查档案馆。', '三'),
    ];
    const text = buildMemoryContext(
      chapters,
      makeChapter(99, 3, '', '当前'),
      10,
      2000,
      {
        queryText: '林岚追问周恪银钥匙的承诺',
        storyState: storyStateWithEntities(),
      },
    );
    expect(text.length).toBeGreaterThan(0);
    // contextBuilder should collect once and pass precomputed into scorer.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('hybrid Top-K selection', () => {
  it('mixes semantic, character history, and recent chapters for topK=10', () => {
    const chapters: Chapter[] = [];
    // 6 mainline-similar
    for (let i = 0; i < 6; i += 1) {
      chapters.push(
        makeChapter(
          100 + i,
          i,
          `档案馆调查主线推进第${i + 1}次，档案室线索。`,
          `主线${i + 1}`,
        ),
      );
    }
    // 3 early character history
    chapters.push(
      makeChapter(201, 10, '林岚与周恪在旧巷交换情报。', '人物史1'),
    );
    chapters.push(
      makeChapter(202, 11, '周恪向林岚承诺保密银钥匙。', '人物史2'),
    );
    chapters.push(
      makeChapter(203, 12, '林岚独自回忆周恪的承诺。', '人物史3'),
    );
    // 3 recent
    for (let i = 0; i < 3; i += 1) {
      chapters.push(
        makeChapter(
          300 + i,
          40 + i,
          `最近章节日常${i + 1}，天气与路程。`,
          `最近${i + 1}`,
        ),
      );
    }
    // filler
    for (let i = 0; i < 8; i += 1) {
      chapters.push(
        makeChapter(400 + i, 20 + i, `无关风景描写${i + 1}。`, `无关${i + 1}`),
      );
    }

    const query = '林岚追问周恪银钥匙与档案馆';
    const docs = chapters.map(c => ({
      chapter: c,
      text: String(c.memory_summary),
    }));
    const idf = buildIdfFromTexts(docs.map(d => d.text).concat([query]));
    const scored = scoreMemoryCandidates(
      docs,
      query,
      idf,
      storyStateWithEntities(),
    );
    const active = findActiveStoryTerms(
      query,
      collectStoryRetrievalTerms(storyStateWithEntities()),
    );
    const selected = selectMemoryCandidates(scored, active, 10);
    const ids = selected.map(s => s.chapter.id);
    expect(selected.length).toBeLessThanOrEqual(10);
    expect(new Set(ids).size).toBe(ids.length);

    const hasCharacterHistory = selected.some(s =>
      [201, 202, 203].includes(s.chapter.id),
    );
    const hasRecent = selected.some(s => s.chapter.position >= 40);
    const hasSemantic = selected.some(
      s => s.finalScore > 0 && s.chapter.position < 10,
    );
    expect(hasCharacterHistory).toBe(true);
    expect(hasRecent).toBe(true);
    expect(hasSemantic).toBe(true);

    const ordered = orderCandidatesForDisplay(selected);
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i].chapter.position).toBeGreaterThanOrEqual(
        ordered[i - 1].chapter.position,
      );
    }

    const memoryText = buildMemoryContext(
      chapters,
      makeChapter(999, 50, '', '当前'),
      10,
      500,
      { queryText: query, storyState: storyStateWithEntities() },
    );
    expect(estimateTokens(memoryText)).toBeLessThanOrEqual(500);
    expect(memoryText).toMatch(/第 \d+ 章/);
  });

  it('falls back safely on low-information queries', () => {
    const chapters = [
      makeChapter(1, 0, '最早无关摘要。'),
      makeChapter(2, 1, '中间无关摘要。'),
      makeChapter(3, 2, '最近有效摘要。'),
    ];
    const current = makeChapter(4, 3, '');
    current.title = '夜';
    current.synopsis = '';
    current.content = '';
    const text = buildMemoryContext(chapters, current, 2, 2000, {
      queryText: '夜',
      storyState: null,
    });
    expect(text).toContain('最近有效摘要');
    expect(text).not.toMatch(/最早无关摘要[\s\S]*最近有效摘要[\s\S]*中间/);
  });
});

describe('unified character term namespace', () => {
  it('does not activate both when A canonical and B alias share 林岚', () => {
    const state = createEmptyStoryMemory(1);
    state.characters.char_a = {
      id: 'char_a',
      canonicalName: '林岚',
      aliases: [],
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
      status: 'active',
      firstSeenChapterId: 1,
      firstSeenPosition: 0,
      lastChangedChapterId: 1,
      lastChangedPosition: 0,
      evidenceChapterIds: [1],
    };
    state.characters.char_b = {
      ...state.characters.char_a,
      id: 'char_b',
      canonicalName: '白薇',
      aliases: ['林岚'],
    };
    const terms = collectStoryRetrievalTerms(state);
    expect(terms.ambiguousNormalizedTerms).toContain(
      episodicMemoryRetriever.normalizeCharacterTerm('林岚'),
    );
    const active = findActiveStoryTerms('林岚出现了', terms);
    expect(active.activeCharacterIds).not.toContain('char_a');
    expect(active.activeCharacterIds).not.toContain('char_b');
    expect(active.activeCharacterNames).not.toContain('林岚');
  });

  it('treats Captain/captain as the same ambiguous English alias', () => {
    const state = createEmptyStoryMemory(1);
    for (const [id, name, alias] of [
      ['char_a', 'Alice', 'Captain'],
      ['char_b', 'Bob', 'captain'],
    ] as const) {
      state.characters[id] = {
        id,
        canonicalName: name,
        aliases: [alias],
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
        status: 'active',
        firstSeenChapterId: 1,
        firstSeenPosition: 0,
        lastChangedChapterId: 1,
        lastChangedPosition: 0,
        evidenceChapterIds: [1],
      };
    }
    const terms = collectStoryRetrievalTerms(state);
    expect(terms.ambiguousNormalizedTerms).toContain('captain');
    const active = findActiveStoryTerms('Captain ordered the team', terms);
    expect(active.activeCharacterIds).toEqual([]);
    expect(active.activeCharacterNames).toEqual([]);
  });

  it('prefers longer name 林岚 over substring 林', () => {
    const state = createEmptyStoryMemory(1);
    state.characters.char_short = {
      id: 'char_short',
      canonicalName: '林',
      aliases: [],
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
      status: 'active',
      firstSeenChapterId: 1,
      firstSeenPosition: 0,
      lastChangedChapterId: 1,
      lastChangedPosition: 0,
      evidenceChapterIds: [1],
    };
    state.characters.char_long = {
      ...state.characters.char_short,
      id: 'char_long',
      canonicalName: '林岚',
    };
    const terms = collectStoryRetrievalTerms(state);
    const active = findActiveStoryTerms('林岚推开暗门', terms);
    expect(active.activeCharacterIds).toEqual(['char_long']);
    expect(active.activeCharacterNames).toEqual(['林岚']);
    expect(active.activeCharacterIds).not.toContain('char_short');
  });
});

describe('selectMemoryCandidates topK < 5 score-first', () => {
  function scored(
    id: number,
    position: number,
    text: string,
    finalScore: number,
  ): ScoredMemoryCandidate {
    return {
      chapter: makeChapter(id, position, text),
      text,
      cosineScore: finalScore,
      entityBoost: 0,
      pairBoost: 0,
      finalScore,
      matchedCharacters: [],
      matchedObjects: [],
      matchedThreads: [],
    };
  }

  const emptyActive = findActiveStoryTerms(
    '',
    collectStoryRetrievalTerms(null),
  );

  it.each([1, 2, 3, 4])(
    'topK=%s prefers high-score early chapter over long low-score recent',
    topK => {
      const longRecent =
        '无关风景与路途描写。'.repeat(30) + '最近章节冗长低相关摘要。';
      const promise =
        '周恪答应林岚不告诉白薇银钥匙来源，双方立下保密承诺。';
      const candidates = [
        scored(1, 5, promise, 0.95),
        scored(2, 10, '次要线索推进。', 0.4),
        scored(3, 20, '白薇路过档案馆。', 0.35),
        scored(4, 28, longRecent, 0.05),
      ];
      const selected = selectMemoryCandidates(candidates, emptyActive, topK);
      expect(selected.length).toBeLessThanOrEqual(topK);
      // Highest score chapter must be present for topK>=1 when scores are nonzero.
      expect(selected.map(s => s.chapter.id)).toContain(1);
      if (topK === 1) {
        expect(selected[0].chapter.id).toBe(1);
      }
      // Budget priority: first item should be highest score among selected.
      expect(selected[0].finalScore).toBeGreaterThanOrEqual(
        selected[selected.length - 1].finalScore,
      );
    },
  );

  it('topK=1 picks recent only when all scores are 0', () => {
    const candidates = [
      scored(1, 0, '早期零分摘要。', 0),
      scored(2, 5, '中间零分摘要。', 0),
      scored(3, 10, '最近零分摘要。', 0),
    ];
    const selected = selectMemoryCandidates(candidates, emptyActive, 1);
    expect(selected).toHaveLength(1);
    expect(selected[0].chapter.id).toBe(3);
  });

  it('topK=3 replaces lowest with recent when recent missing from score top', () => {
    const candidates = [
      scored(1, 0, '高分历史承诺。', 0.9),
      scored(2, 1, '次高分历史。', 0.8),
      scored(3, 2, '第三高分。', 0.7),
      scored(4, 20, '最近但低分。', 0.1),
    ];
    const selected = selectMemoryCandidates(candidates, emptyActive, 3);
    expect(selected.map(s => s.chapter.id)).toContain(4);
    expect(selected.map(s => s.chapter.id)).toContain(1);
    expect(selected).toHaveLength(3);
    // Highest score still first for budget priority.
    expect(selected[0].chapter.id).toBe(1);
  });

  it('tight budget keeps high-score promise over long recent after topK=3', () => {
    const longRecent = '无关填充文本。'.repeat(40);
    const promise = '周恪答应林岚不告诉白薇银钥匙来源，立下保密承诺。';
    const candidates = [
      scored(1, 5, promise, 0.95),
      scored(2, 10, '次要。', 0.5),
      scored(3, 28, longRecent, 0.05),
    ];
    const selected = selectMemoryCandidates(candidates, emptyActive, 3);
    const budget =
      estimateTokens(formatMemoryCandidateLine(candidates[0])) + 10;
    const kept = selectCandidatesWithinTokenBudget(selected, budget);
    const text = kept.map(formatMemoryCandidateLine).join('\n');
    expect(text).toContain('保密承诺');
    expect(estimateTokens(text)).toBeLessThanOrEqual(budget);
  });
});

describe('empty-query and legacy budget paths via buildMemoryContext', () => {
  it('empty query with tiny budgets 1/5/10 never exceeds and may be empty', () => {
    const chapters = [
      makeChapter(
        1,
        0,
        '林岚与周恪关于银钥匙的保密承诺细节。'.repeat(5),
        '承诺章',
      ),
      makeChapter(2, 1, '最近有效摘要。', '最近'),
    ];
    for (const budget of [1, 5, 10]) {
      const text = buildMemoryContext(
        chapters,
        makeChapter(9, 2, '', '当前'),
        5,
        budget,
        { queryText: '   ', storyState: null },
      );
      expect(estimateTokens(text)).toBeLessThanOrEqual(budget);
    }
  });

  it('legacy path (V2 disabled) still respects tiny budgets', () => {
    const original = episodicMemoryRetriever.EPISODIC_RETRIEVAL_V2_ENABLED;
    // Mutable binding used by contextBuilder via namespace import.
    (episodicMemoryRetriever as { EPISODIC_RETRIEVAL_V2_ENABLED: boolean })
      .EPISODIC_RETRIEVAL_V2_ENABLED = false;
    try {
      const chapters = [
        makeChapter(
          1,
          0,
          '林岚与周恪关于银钥匙的保密承诺细节。'.repeat(5),
          '长摘要',
        ),
      ];
      for (const budget of [1, 5, 10]) {
        const text = buildMemoryContext(
          chapters,
          makeChapter(9, 1, '', '当前'),
          5,
          budget,
          { queryText: '林岚银钥匙', storyState: null },
        );
        expect(estimateTokens(text)).toBeLessThanOrEqual(budget);
      }
    } finally {
      (episodicMemoryRetriever as { EPISODIC_RETRIEVAL_V2_ENABLED: boolean })
        .EPISODIC_RETRIEVAL_V2_ENABLED = original;
    }
  });

  it('empty IDF falls back to recent valid summaries within budget', () => {
    const { buildMemoryContextWithIdf } = require('../src/services/contextBuilder');
    const chapters = [
      makeChapter(1, 0, '。。。！！！'),
      makeChapter(2, 1, 'the and 章节'),
      makeChapter(3, 2, '最近有效摘要：林岚找到银钥匙。'),
    ];
    const emptyIdf = new Map<string, number>();
    const text = buildMemoryContextWithIdf(
      chapters,
      makeChapter(9, 3, '', '当前'),
      emptyIdf,
      5,
      2000,
      { queryText: '任意', storyState: null },
    );
    expect(text).toContain('最近有效摘要');
    expect(estimateTokens(text)).toBeLessThanOrEqual(2000);

    for (const budget of [1, 5, 10]) {
      const tiny = buildMemoryContextWithIdf(
        chapters,
        makeChapter(9, 3, '', '当前'),
        emptyIdf,
        5,
        budget,
      );
      expect(estimateTokens(tiny)).toBeLessThanOrEqual(budget);
    }
  });
});

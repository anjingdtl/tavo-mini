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
  orderCandidatesForDisplay,
  scoreMemoryCandidates,
  selectCandidatesWithinTokenBudget,
  selectMemoryCandidates,
  tokenizeForMemoryRetrieval,
  type ScoredMemoryCandidate,
} from '../src/services/episodicMemoryRetriever';
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
    expect(unique.aliasHits).toEqual([
      { alias: '小薇', canonicalName: '白薇' },
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

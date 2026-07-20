/**
 * Fixed 30-chapter character-interaction recall + scale performance checks.
 */

import type { Chapter } from '../src/types/novel';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import {
  buildEpisodicRetrievalQuery,
  buildIdfFromTexts,
  collectStoryRetrievalTerms,
  findActiveStoryTerms,
  formatMemoryCandidateLine,
  orderCandidatesForDisplay,
  scoreMemoryCandidates,
  selectCandidatesWithinTokenBudget,
  selectMemoryCandidates,
} from '../src/services/episodicMemoryRetriever';
import { buildMemoryContext, buildMemoryContextWithIdf } from '../src/services/contextBuilder';
import { estimateTokens } from '../src/utils/tokenEstimator';
import {
  computeMemorySummarySignature,
  getCachedIdf,
  setCachedIdf,
} from '../src/utils/idfCache';

function chapter(
  position: number,
  summary: string,
  extras: Partial<Chapter> = {},
): Chapter {
  return {
    id: position + 1,
    project_id: 9,
    position,
    title: `第${position + 1}章`,
    synopsis: '',
    content: extras.content ?? `正文${position + 1}`,
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

function interactionStoryState() {
  const state = createEmptyStoryMemory(9);
  for (const [id, name, possessions] of [
    ['char_lan', '林岚', ['银钥匙']],
    ['char_zhou', '周恪', []],
    ['char_bai', '白薇', []],
  ] as const) {
    state.characters[id] = {
      id,
      canonicalName: name,
      aliases: name === '林岚' ? ['小岚'] : [],
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
        possessions: [...possessions],
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
  state.mainline.openThreads.t1 = {
    id: 't1',
    title: '银钥匙来源',
    description: '钥匙从何而来',
    ownerCharacterIds: ['char_lan'],
    priority: 'critical',
    openedChapterId: 3,
    lastChangedChapterId: 15,
    deadlineOrTrigger: '',
    evidenceChapterIds: [3, 8, 15],
  };
  return state;
}

function buildThirtyChapterCorpus(): Chapter[] {
  const chapters: Chapter[] = [];
  for (let p = 0; p < 30; p += 1) {
    let summary = `第${p + 1}章日常推进，天气与路程描写。`;
    if (p === 2) {
      summary =
        '林岚把银钥匙交给周恪，要求他妥善保管，不得示人。';
    } else if (p === 7) {
      summary =
        '周恪答应林岚不告诉白薇银钥匙的来源，二人立下保密承诺。';
    } else if (p === 14) {
      summary =
        '周恪把银钥匙交给白薇，声称只是临时保管，未提林岚约定。';
    } else if (p === 28) {
      summary =
        '白薇暗示自己知道钥匙来源，言语之间试探周恪。';
    } else if (p % 5 === 0) {
      summary = `档案馆主线调查进度节点${p + 1}，档案室灰尘与编号。`;
    }
    chapters.push(chapter(p, summary));
  }
  return chapters;
}

describe('long story recall regression (30 chapters)', () => {
  it('recalls key interaction chapters for the ch30 query', () => {
    const previous = buildThirtyChapterCorpus().filter(c => c.position < 29);
    const current = chapter(29, '', {
      title: '夜探档案馆',
      synopsis: '林岚与周恪再次交锋',
      content: '',
    });
    const prevChapter = previous[previous.length - 1];
    const query = buildEpisodicRetrievalQuery({
      currentChapter: current,
      previousChapter: prevChapter,
      retrievalUserPrompt: '林岚再次追问周恪银钥匙和保密承诺',
    });

    const docs = previous
      .map(c => ({ chapter: c, text: String(c.memory_summary) }))
      .filter(d => d.text.trim());
    const idf = buildIdfFromTexts(docs.map(d => d.text).concat([query]));
    const state = interactionStoryState();
    const scored = scoreMemoryCandidates(docs, query, idf, state);
    const active = findActiveStoryTerms(
      query,
      collectStoryRetrievalTerms(state),
    );
    const selected = selectMemoryCandidates(scored, active, 10);
    const positions = selected.map(s => s.chapter.position);

    // SPEC: must include chapters 3, 8, 15 (0-based 2,7,14) and 29 or recent.
    expect(positions).toEqual(expect.arrayContaining([2, 7, 14]));
    expect(
      positions.some(p => p === 28 || p >= 25),
    ).toBe(true);

    // Interaction chapters should outrank pure filler among top scores.
    const byPos = Object.fromEntries(
      scored.map(s => [s.chapter.position, s.finalScore]),
    );
    expect(byPos[7]).toBeGreaterThan(byPos[0]);
    expect(byPos[14]).toBeGreaterThan(byPos[1]);

    const memoryText = buildMemoryContext(previous, current, 10, 20000, {
      queryText: query,
      storyState: state,
    });
    expect(memoryText).toContain('第 3 章');
    expect(memoryText).toContain('第 8 章');
    expect(memoryText).toContain('第 15 章');

    // Display order is chronological.
    const ordered = orderCandidatesForDisplay(selected);
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i].chapter.position).toBeGreaterThanOrEqual(
        ordered[i - 1].chapter.position,
      );
    }
  });

  it('keeps key interaction chapters under a tight token budget (priority-first)', () => {
    const previous = buildThirtyChapterCorpus().filter(c => c.position < 29);
    const current = chapter(29, '', {
      title: '夜探档案馆',
      synopsis: '林岚与周恪再次交锋',
      content: '',
    });
    const query = buildEpisodicRetrievalQuery({
      currentChapter: current,
      previousChapter: previous[previous.length - 1],
      retrievalUserPrompt: '林岚再次追问周恪银钥匙和保密承诺',
    });
    const docs = previous
      .map(c => ({ chapter: c, text: String(c.memory_summary) }))
      .filter(d => d.text.trim());
    const idf = buildIdfFromTexts(docs.map(d => d.text).concat([query]));
    const state = interactionStoryState();
    const scored = scoreMemoryCandidates(docs, query, idf, state);
    const active = findActiveStoryTerms(
      query,
      collectStoryRetrievalTerms(state),
    );
    const selected = selectMemoryCandidates(scored, active, 10);

    // Budget that would fail if chronology-first kept early fillers.
    const interaction = selected.filter(s =>
      [2, 7, 14].includes(s.chapter.position),
    );
    expect(interaction.length).toBeGreaterThanOrEqual(2);
    const tightBudget =
      interaction
        .slice(0, 2)
        .reduce(
          (sum, item) => sum + estimateTokens(formatMemoryCandidateLine(item)),
          0,
        ) + 20;

    const budgeted = selectCandidatesWithinTokenBudget(selected, tightBudget);
    const positions = budgeted.map(s => s.chapter.position);
    // At least one critical interaction must survive; early filler must not monopolize.
    expect(positions.some(p => [2, 7, 14].includes(p))).toBe(true);
    const total = budgeted.reduce(
      (sum, item) => sum + estimateTokens(formatMemoryCandidateLine(item)),
      0,
    );
    expect(total).toBeLessThanOrEqual(tightBudget);

    const ordered = orderCandidatesForDisplay(budgeted);
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i].chapter.position).toBeGreaterThanOrEqual(
        ordered[i - 1].chapter.position,
      );
    }

    const memoryText = buildMemoryContext(previous, current, 10, tightBudget, {
      queryText: query,
      storyState: state,
    });
    expect(estimateTokens(memoryText)).toBeLessThanOrEqual(tightBudget);
    expect(
      memoryText.includes('银钥匙') ||
        memoryText.includes('保密') ||
        memoryText.includes('周恪'),
    ).toBe(true);
  });
});

describe('episodic retrieval performance scale', () => {
  function corpus(n: number): Chapter[] {
    return Array.from({ length: n }, (_, p) =>
      chapter(
        p,
        `第${p + 1}章摘要：${'剧情人物物品线索'.repeat(20)}编号${p + 1}。林岚周恪白薇银钥匙。`,
      ),
    );
  }

  function measure(n: number) {
    const chapters = corpus(n);
    const docs = chapters.map(c => ({
      chapter: c,
      text: String(c.memory_summary),
    }));
    const query = '林岚追问周恪银钥匙的承诺与白薇';
    const state = interactionStoryState();

    const t0 = Date.now();
    const idf = buildIdfFromTexts(docs.map(d => d.text));
    const idfBuildMs = Date.now() - t0;

    const sig = computeMemorySummarySignature(chapters);
    setCachedIdf(9000 + n, sig, idf);
    const t1 = Date.now();
    const cached = getCachedIdf(9000 + n, sig);
    expect(cached).toBe(idf);
    const t2 = Date.now();

    const scored = scoreMemoryCandidates(docs, query, idf, state);
    const t3 = Date.now();
    const active = findActiveStoryTerms(
      query,
      collectStoryRetrievalTerms(state),
    );
    const selected = selectMemoryCandidates(scored, active, 10);
    const t4 = Date.now();
    const budgeted = selectCandidatesWithinTokenBudget(selected, 20000);
    const t5 = Date.now();
    const text = buildMemoryContextWithIdf(
      chapters,
      chapter(n, '', { title: '当前', content: '' }),
      idf,
      10,
      20000,
      { queryText: query, storyState: state },
    );
    return {
      n,
      idfBuildMs,
      cacheHitMs: t2 - t1,
      scoreMs: t3 - t2,
      selectMs: t4 - t3,
      budgetMs: t5 - t4,
      totalRecallMs: Date.now() - t2,
      tokens: estimateTokens(text),
      selected: selected.length,
      budgeted: budgeted.length,
    };
  }

  it('stays responsive for 30 / 100 / 300 chapters with cache', () => {
    const r30 = measure(30);
    const r100 = measure(100);
    const r300 = measure(300);

    // Soft budgets: CI machines vary; catch accidental O(N^2) explosions.
    expect(r30.totalRecallMs).toBeLessThan(500);
    expect(r100.totalRecallMs).toBeLessThan(1500);
    expect(r300.totalRecallMs).toBeLessThan(4000);
    expect(r100.cacheHitMs).toBeLessThan(50);
    expect(r300.tokens).toBeLessThanOrEqual(20000);
    expect(r30.selected).toBeLessThanOrEqual(10);

    // Complexity sanity: 300-chapter scoring should not be orders of magnitude worse than linear.
    // Allow generous noise but fail if clearly quadratic blow-up.
    if (r30.scoreMs > 0) {
      expect(r300.scoreMs / r30.scoreMs).toBeLessThan(50);
    }
  });
});

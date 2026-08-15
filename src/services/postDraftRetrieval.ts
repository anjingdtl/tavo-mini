/**
 * Post-draft secondary local retrieval (SPEC §10).
 *
 * After the draft is generated, the model may have written entities that were
 * NOT in the original retrieval query. Full-mode audit rebuild must re-score
 * only within the frozen candidate pool captured at task start — never re-read
 * live project data.
 *
 * Hard guarantees (SPEC §10.3):
 * - No remote LLM call;
 * - No database write, no Story Memory update, no Checkpoint re-run;
 * - Must not retrieve future chapters (position >= current chapter);
 * - On any failure, fall back to the original snapshot unchanged.
 *
 * Capture (`captureFrozenAuditCandidates`) may read DB once at task start.
 * Rebuild (`buildPostDraftAuditContextFromFrozen`) is pure over frozen data.
 */
import * as db from './database';
import { resolveStoryStateForRetrieval } from './contextBuilder';
import {
  buildEpisodicRetrievalQuery,
  collectStoryRetrievalTerms,
  findActiveStoryTerms,
  resolvePreviousChapterForQuery,
  scoreMemoryCandidates,
  selectMemoryCandidates,
  selectCandidatesWithinTokenBudget,
  orderCandidatesForDisplay,
  formatMemoryCandidateLine,
  tokenizeForMemoryRetrieval,
} from './episodicMemoryRetriever';
import {
  excludeRawFromEpisodicCandidates,
} from './storyMemory/storyMemoryCoverage';
import {
  prepareStoryMemoryForGeneration,
} from './storyMemory/storyMemoryPrepare';
import { clipTextToTokenBudget } from '../utils/tokenEstimator';
import type { Chapter, ContextConfig } from '../types/novel';
import type { PipelineContextSnapshot } from '../types/pipelineContext';
import type {
  FrozenAuditCandidates,
  FrozenCharacterCandidate,
  FrozenChapterCandidate,
  FrozenWorldbookCandidate,
} from '../types/pipelineFrozen';

export interface PostDraftRetrievalResult {
  snapshot: PipelineContextSnapshot;
  /** Number of NEW episodic hits found via the draft (not in original). */
  episodicHitsAdded: number;
  /** Number of NEW worldbook lines activated via the draft. */
  worldbookHitsAdded: number;
  /** Number of NEW character cards activated via the draft. */
  characterHitsAdded: number;
  /** True when the retrieval fell back to the original snapshot. */
  fellBack: boolean;
  /** Diagnostic reason when fellBack is true. */
  fallbackReason?: string;
}

/**
 * Capture the full-mode audit candidate pool at task start.
 * This is the only place allowed to read live repositories for audit candidates.
 */
export async function captureFrozenAuditCandidates(
  chapter: Chapter,
  projectId: number,
  contextConfig: ContextConfig,
  options: { contextBudgetVersion?: number } = {},
): Promise<FrozenAuditCandidates> {
  // Stability Phase 5 — empty pools must carry an observable reason (plan §9).
  const captureWarnings: string[] = [];
  let chapters: Chapter[] = [];
  try {
    chapters = await db.getChaptersByProject(projectId);
  } catch (error) {
    captureWarnings.push(
      `章节读取失败，情节记忆候选池为空：${(error as Error)?.message || error}`,
    );
    chapters = [];
  }

  let rawChapterIds: number[] = [];
  let storyStateText = '';
  try {
    const prepared = await prepareStoryMemoryForGeneration(
      projectId,
      chapter,
      contextConfig,
      {
        mode: 'preview',
        contextBudgetVersion: options.contextBudgetVersion,
      },
    );
    rawChapterIds = prepared?.coverage?.rawChapterIds || [];
    const state = resolveStoryStateForRetrieval(prepared);
    if (state && typeof state === 'object') {
      try {
        storyStateText = JSON.stringify(state).slice(0, 20000);
      } catch {
        storyStateText = '';
      }
    }
  } catch (error) {
    captureWarnings.push(
      `故事记忆预检失败，原始章节排除表为空：${(error as Error)?.message || error}`,
    );
    rawChapterIds = [];
  }

  const previousChaptersAll = chapters.filter(c => c.position < chapter.position);
  const episodicPool = excludeRawFromEpisodicCandidates(
    previousChaptersAll,
    rawChapterIds,
  ).filter(c => c.position < chapter.position);

  const episodicCandidates: FrozenChapterCandidate[] = episodicPool.map(c => ({
    id: c.id,
    position: c.position,
    title: c.title || '',
    memory_summary: String((c as any).memory_summary || ''),
  }));

  const characterCandidates: FrozenCharacterCandidate[] = [];
  try {
    const characters = (await db.getCharactersByProject(projectId)) as any[];
    for (const character of characters) {
      const data = safeJsonLocal(character.data_json);
      const card = data.data || data;
      const charName = character.name || card.name || '未命名角色';
      const text = [
        `角色「${charName}」`,
        card.system_prompt && `角色系统提示：${card.system_prompt}`,
        card.description && `描述：${card.description}`,
        card.personality && `性格：${card.personality}`,
        card.scenario && `场景：${card.scenario}`,
        card.first_mes && `开场消息：${card.first_mes}`,
        card.mes_example && `对话示例：${card.mes_example}`,
        card.post_history_instructions &&
          `后置指令：${card.post_history_instructions}`,
      ]
        .filter(Boolean)
        .join('\n');
      characterCandidates.push({
        id: Number(character.id) || 0,
        name: charName,
        cardText: text,
      });
    }
  } catch (error) {
    captureWarnings.push(
      `角色候选池捕获失败，审核将缺少角色对照：${(error as Error)?.message || error}`,
    );
  }

  const worldbookCandidates: FrozenWorldbookCandidate[] = [];
  try {
    const entries = ((await db.getWorldbookEntriesByProject(projectId)) as any[])
      .slice()
      .sort(
        (a, b) =>
          Number(a.position || 0) - Number(b.position || 0) ||
          Number(a.id || 0) - Number(b.id || 0),
      );
    for (const entry of entries) {
      const primary = normalizeKeysLocal(
        entry.keyword_primary ?? entry.key ?? entry.keys ?? entry.keyword,
      );
      const secondary = normalizeKeysLocal(
        entry.keyword_secondary ?? entry.keysecondary ?? entry.secondary_keys,
      );
      worldbookCandidates.push({
        id: Number(entry.id) || null,
        keywords: primary,
        secondaryKeywords: secondary,
        content: String(entry.content || ''),
        constant: entry.constant === 1 || entry.constant === true,
        position: Number(entry.position || 0),
      });
    }
  } catch (error) {
    captureWarnings.push(
      `世界书候选池捕获失败，审核将缺少世界书对照：${(error as Error)?.message || error}`,
    );
  }

  return {
    episodicCandidates,
    characterCandidates,
    worldbookCandidates,
    contextConfig: {
      strategy: contextConfig.strategy,
      slidingWindowSize: contextConfig.slidingWindowSize,
      customRangeStart: contextConfig.customRangeStart,
      customRangeEnd: contextConfig.customRangeEnd,
      resourceBudget: contextConfig.resourceBudget,
      includeResources: contextConfig.includeResources,
      summaryBudgetTokens: contextConfig.summaryBudgetTokens,
      storyStateBudgetTokens: contextConfig.storyStateBudgetTokens,
      episodicMemoryBudgetTokens: contextConfig.episodicMemoryBudgetTokens,
      memoryTopK: contextConfig.memoryTopK,
      worldbookRecursive: contextConfig.worldbookRecursive,
    },
    chapterPosition: chapter.position,
    chapterTitle: chapter.title || '',
    chapterSynopsis: chapter.synopsis || '',
    rawChapterIds,
    storyStateText,
    captureWarnings: captureWarnings.length > 0 ? captureWarnings : undefined,
    createdAt: Date.now(),
  };
}

/**
 * Pure post-draft audit rebuild from frozen candidates only.
 * Does not touch SQLite / live repositories.
 */
export function buildPostDraftAuditContextFromFrozen(
  original: PipelineContextSnapshot,
  draftText: string,
  frozen: FrozenAuditCandidates,
): PostDraftRetrievalResult {
  const noop = (reason: string): PostDraftRetrievalResult => ({
    snapshot: original,
    episodicHitsAdded: 0,
    worldbookHitsAdded: 0,
    characterHitsAdded: 0,
    fellBack: true,
    fallbackReason: reason,
  });

  if (!draftText || !draftText.trim()) return noop('empty draft');
  if (!frozen) return noop('missing frozen candidates');

  try {
    const episodicResult = runFrozenEpisodicRetrieval(
      original,
      draftText,
      frozen,
    );
    const worldbookResult = runFrozenWorldbookRetrieval(
      original,
      draftText,
      frozen,
    );
    const characterResult = runFrozenCharacterRetrieval(
      original,
      draftText,
      frozen,
    );

    const snapshot: PipelineContextSnapshot = {
      ...original,
      episodicMemoryText: episodicResult.text,
      worldbookText: worldbookResult.text,
      characterText: characterResult.text,
    };

    return {
      snapshot,
      episodicHitsAdded: episodicResult.added,
      worldbookHitsAdded: worldbookResult.added,
      characterHitsAdded: characterResult.added,
      fellBack: false,
    };
  } catch (error: any) {
    return noop(
      error?.message ? String(error.message) : 'frozen post-draft retrieval error',
    );
  }
}

function safeJsonLocal(text: string): any {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

function normalizeKeysLocal(raw: any): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map(k => String(k || '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[,，;；|]/)
      .map(k => k.trim())
      .filter(Boolean);
  }
  return [];
}

function includesKeyLocal(text: string, key: string): boolean {
  if (!key) return false;
  return text.toLowerCase().includes(key.toLowerCase());
}

function runFrozenEpisodicRetrieval(
  original: PipelineContextSnapshot,
  draftText: string,
  frozen: FrozenAuditCandidates,
): { text: string; added: number } {
  const config = frozen.contextConfig;
  const chaptersLike = frozen.episodicCandidates.map(c => ({
    id: c.id,
    position: c.position,
    title: c.title,
    memory_summary: c.memory_summary,
  }));
  if (chaptersLike.length === 0) {
    return { text: original.episodicMemoryText, added: 0 };
  }

  const previousForQuery = resolvePreviousChapterForQuery(
    chaptersLike as any,
    {
      id: 0,
      project_id: 0,
      position: frozen.chapterPosition,
      title: frozen.chapterTitle,
      synopsis: frozen.chapterSynopsis,
      content: '',
      status: 'draft',
      summary_json: null,
      created_at: '',
      updated_at: '',
    },
  );
  const baseQuery = buildEpisodicRetrievalQuery({
    currentChapter: {
      id: 0,
      project_id: 0,
      position: frozen.chapterPosition,
      title: frozen.chapterTitle,
      synopsis: frozen.chapterSynopsis,
      content: '',
      status: 'draft',
      summary_json: null,
      created_at: '',
      updated_at: '',
    },
    previousChapter: previousForQuery,
    retrievalUserPrompt: original.retrievalUserPrompt,
  });
  const draftQuery = `${baseQuery}\n${draftText.slice(0, 4000)}`;

  const docs = chaptersLike
    .map(c => ({
      chapter: c as any,
      text: String(c.memory_summary || ''),
    }))
    .filter(item => item.text.trim());
  if (docs.length === 0) {
    return { text: original.episodicMemoryText, added: 0 };
  }

  const idf = buildIdfLocal(docs.map(d => d.text));
  if (!idf || idf.size === 0) {
    return { text: original.episodicMemoryText, added: 0 };
  }

  let storyState: any = null;
  if (frozen.storyStateText) {
    try {
      storyState = JSON.parse(frozen.storyStateText);
    } catch {
      storyState = null;
    }
  }
  const storyTerms = collectStoryRetrievalTerms(storyState);
  const active = findActiveStoryTerms(draftQuery, storyTerms);
  const scored = scoreMemoryCandidates(
    docs,
    draftQuery,
    idf,
    storyState,
    defaultCosine,
    defaultVectorize.bind(null, idf),
    { storyTerms, activeTerms: active },
  );
  const topK = config.memoryTopK ?? 10;
  const budgetTokens =
    config.episodicMemoryBudgetTokens ?? config.summaryBudgetTokens ?? 20000;
  const draftSelected = selectMemoryCandidates(scored, active, topK);
  const originalChapterIds = extractChapterIdsFromEpisodicText(
    original.episodicMemoryText,
    chaptersLike as any,
  );
  const addedCount = draftSelected.filter(
    item => !originalChapterIds.has(item.chapter.id),
  ).length;
  const budgeted = selectCandidatesWithinTokenBudget(draftSelected, budgetTokens);
  const draftTextOut = orderCandidatesForDisplay(budgeted)
    .map(item => formatMemoryCandidateLine(item))
    .join('\n');
  const merged = mergeEpisodicTextPreservingOriginal(
    draftTextOut,
    original.episodicMemoryText,
  );
  return { text: merged, added: addedCount };
}

function runFrozenWorldbookRetrieval(
  original: PipelineContextSnapshot,
  draftText: string,
  frozen: FrozenAuditCandidates,
): { text: string; added: number } {
  const config = frozen.contextConfig;
  const budget =
    config.resourceBudget && config.resourceBudget > 0
      ? Math.max(0, budgetForWorldbook(config.resourceBudget))
      : 2000;
  if (budget <= 0) return { text: original.worldbookText, added: 0 };

  const haystack = `${frozen.chapterTitle}\n${frozen.chapterSynopsis}\n${draftText}`;
  const recursive = config.worldbookRecursive !== false;
  const activated = new Map<number | null, FrozenWorldbookCandidate>();

  const tryActivate = (scan: string) => {
    for (const entry of frozen.worldbookCandidates) {
      if (activated.has(entry.id)) continue;
      if (entry.constant) {
        activated.set(entry.id, entry);
        continue;
      }
      if (entry.keywords.length === 0) {
        activated.set(entry.id, entry);
        continue;
      }
      const primaryHit = entry.keywords.some(k => includesKeyLocal(scan, k));
      if (!primaryHit) continue;
      if (entry.secondaryKeywords.length === 0) {
        activated.set(entry.id, entry);
        continue;
      }
      if (entry.secondaryKeywords.some(k => includesKeyLocal(scan, k))) {
        activated.set(entry.id, entry);
      } else {
        activated.set(entry.id, entry);
      }
    }
  };

  tryActivate(haystack);
  if (recursive && activated.size > 0) {
    tryActivate(
      `${haystack}\n\n${Array.from(activated.values())
        .map(e => e.content)
        .join('\n')}`,
    );
  }
  if (activated.size === 0 && frozen.worldbookCandidates.length > 0) {
    for (const entry of frozen.worldbookCandidates) {
      activated.set(entry.id, entry);
    }
  }

  const lines: string[] = [];
  let remaining = budget;
  for (const entry of activated.values()) {
    if (remaining <= 0) break;
    const label = entry.keywords[0] || '';
    const body = entry.content || '';
    const line = label ? `关键词「${label}」：${body}` : body;
    const clipped = clipTextToTokenBudget(line, remaining);
    if (!clipped) continue;
    lines.push(clipped);
    remaining -= Math.max(1, Math.ceil(clipped.length / 2));
  }

  const originalLines = (original.worldbookText || '')
    .split('\n')
    .filter(Boolean);
  const originalBodies = new Set(
    originalLines.map(line => stripWorldbookPrefix(line)),
  );
  const draftLines = lines.filter(Boolean);
  const addedLines = draftLines.filter(
    line => !originalBodies.has(stripWorldbookPrefix(line)),
  );
  if (addedLines.length === 0) {
    return { text: original.worldbookText, added: 0 };
  }
  return {
    text: [...originalLines, ...addedLines].join('\n'),
    added: addedLines.length,
  };
}

function runFrozenCharacterRetrieval(
  original: PipelineContextSnapshot,
  draftText: string,
  frozen: FrozenAuditCandidates,
): { text: string; added: number } {
  const config = frozen.contextConfig;
  const budget =
    config.resourceBudget && config.resourceBudget > 0
      ? Math.floor(config.resourceBudget * 0.35)
      : 1500;
  if (budget <= 0) return { text: original.characterText, added: 0 };

  const draftLower = draftText.toLowerCase();
  const originalNames = extractCharacterNames(original.characterText);
  const seenNames = new Set(originalNames);
  const addedBlocks: string[] = [];
  let added = 0;
  for (const candidate of frozen.characterCandidates) {
    if (seenNames.has(candidate.name)) continue;
    if (!draftLower.includes(candidate.name.toLowerCase())) continue;
    addedBlocks.push(candidate.cardText);
    seenNames.add(candidate.name);
    added += 1;
  }
  if (addedBlocks.length === 0) {
    return { text: original.characterText, added: 0 };
  }
  const addedText = clipTextToTokenBudget(
    addedBlocks.join('\n\n'),
    Math.max(256, Math.floor(budget * 0.5)),
  );
  const keptOriginal = original.characterText || '';
  const merged = keptOriginal ? `${keptOriginal}\n\n${addedText}` : addedText;
  return { text: merged, added };
}

/* ----------------------------- shared pure helpers ----------------------------- */

function buildIdfLocal(docs: string[]): Map<string, number> {
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

function defaultVectorize(idf: Map<string, number>, text: string): Map<string, number> {
  const tokens = tokenizeForMemoryRetrieval(text);
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
  const maxTf = Math.max(1, ...tf.values());
  const vector = new Map<string, number>();
  for (const [term, count] of tf) {
    vector.set(term, (count / maxTf) * (idf.get(term) || 1));
  }
  return vector;
}

function defaultCosine(a: Map<string, number>, b: Map<string, number>): number {
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

/**
 * Identify chapter ids whose "第 N 章「title」摘要：" prefix appears in the
 * original episodic text. Used to count genuinely new draft-driven hits.
 */
function extractChapterIdsFromEpisodicText(
  episodicText: string,
  chapters: Chapter[],
): Set<number> {
  const ids = new Set<number>();
  if (!episodicText) return ids;
  for (const c of chapters) {
    const prefix = `第 ${c.position + 1} 章`;
    if (episodicText.includes(prefix)) {
      ids.add(c.id);
    }
  }
  return ids;
}

/**
 * Append any original episodic lines whose chapter was NOT re-selected by the
 * draft-driven pass, so we keep coverage the draft already saw without losing
 * draft-driven additions. Lines are deduped by their "第 N 章「title」摘要："
 * prefix — if the draft-driven text already covers that chapter, the original
 * line is dropped; otherwise the original line (and its continuation lines) is
 * preserved.
 */
function mergeEpisodicTextPreservingOriginal(
  draftEpisodicText: string,
  originalEpisodicText: string,
): string {
  if (!originalEpisodicText) return draftEpisodicText;
  if (!draftEpisodicText) return originalEpisodicText;

  const originalLines = originalEpisodicText.split('\n').filter(Boolean);
  const preserved: string[] = [];
  let keepCurrent = false;
  for (const line of originalLines) {
    const isChapterPrefix = /^第\s+\d+\s+章/.test(line);
    if (isChapterPrefix) {
      // Dedupe by the chapter-prefix portion (everything before "摘要：").
      const prefix = line.split('摘要：')[0];
      keepCurrent = !draftEpisodicText.includes(prefix);
    }
    if (keepCurrent) preserved.push(line);
  }

  if (preserved.length === 0) return draftEpisodicText;
  return `${draftEpisodicText}\n${preserved.join('\n')}`;
}

function budgetForWorldbook(resourceBudget: number): number {
  // Mirror buildResourceContext's worldbook share: budget - 35% char - 20% note.
  const characterBudget = Math.floor(resourceBudget * 0.35);
  const noteBudget = Math.floor(resourceBudget * 0.2);
  return Math.max(0, resourceBudget - characterBudget - noteBudget);
}

function stripWorldbookPrefix(line: string): string {
  // Lines look like "关键词「x」：body" or just "body".
  const idx = line.indexOf('：');
  return idx >= 0 ? line.slice(idx + 1) : line;
}

function extractCharacterNames(text: string): string[] {
  if (!text) return [];
  const names: string[] = [];
  const re = /角色「([^」]+)」/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    names.push(m[1]);
  }
  return names;
}

/**
 * Re-build the draft context snapshot by calling buildContext, then run
 * post-draft retrieval on top. Exposed for tests and for callers that want a
 * one-shot "draft snapshot + post-draft audit snapshot" pipeline.
 */
// Re-export so callers / tests can inspect the pure helpers if needed.
export const __debug = {
  extractChapterIdsFromEpisodicText,
  mergeEpisodicTextPreservingOriginal,
  stripWorldbookPrefix,
  extractCharacterNames,
};

/**
 * Post-draft secondary local retrieval (SPEC §10).
 *
 * After the draft is generated, the model may have written entities (an old
 * character, a place, an object, a "first time" / "again" expression) that
 * were NOT in the original retrieval query. This module re-runs the EXISTING
 * local retrievers using the draft as an additional signal and merges the new
 * hits into a {@link PipelineContextSnapshot}.
 *
 * Hard guarantees (SPEC §10.3):
 * - No remote LLM call;
 * - No database write, no Story Memory update, no Checkpoint re-run;
 * - Must not retrieve future chapters (position >= current chapter);
 * - On any failure, fall back to the original snapshot unchanged;
 * - Must never block the pipeline — caller wraps in try/catch too.
 *
 * Merge / dedupe (SPEC §10.4):
 * - Episodic hits: original ∪ draft-driven, deduped by chapter id, recent-first;
 * - Worldbook hits: original lines ∪ draft-activated lines, deduped by content;
 * - Character cards: original ∪ draft-activated, deduped by character id/name.
 *
 * This module is read-only relative to the DB and never imports anything that
 * mutates state. It only reuses pure retrievers + read-only DB helpers.
 */
import * as db from './database';
import {
  buildContext,
  buildWorldbookContext,
  buildCharacterContext,
  resolveStoryStateForRetrieval,
} from './contextBuilder';
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
 * Build a {@link PipelineContextSnapshot} enriched with draft-driven local
 * retrieval. Never throws; on error returns the original snapshot with
 * fellBack=true.
 */
export async function buildPostDraftAuditContext(
  original: PipelineContextSnapshot,
  draftText: string,
  projectId: number,
  chapter: Chapter,
  contextConfig: ContextConfig,
): Promise<PostDraftRetrievalResult> {
  const noop = (reason: string): PostDraftRetrievalResult => ({
    snapshot: original,
    episodicHitsAdded: 0,
    worldbookHitsAdded: 0,
    characterHitsAdded: 0,
    fellBack: true,
    fallbackReason: reason,
  });

  if (!draftText || !draftText.trim()) return noop('empty draft');
  if (!chapter || typeof chapter.position !== 'number') {
    return noop('invalid chapter');
  }

  try {
    const [
      episodicResult,
      worldbookResult,
      characterResult,
    ] = await Promise.all([
      runPostDraftEpisodicRetrieval(original, draftText, projectId, chapter, contextConfig),
      runPostDraftWorldbookRetrieval(original, draftText, projectId, chapter, contextConfig),
      runPostDraftCharacterRetrieval(original, draftText, projectId, chapter, contextConfig),
    ]);

    const snapshot: PipelineContextSnapshot = {
      ...original,
      episodicMemoryText: episodicResult.text,
      worldbookText: worldbookResult.text,
      characterText: characterResult.text,
      // storyMemoryText / presetText / noteText / recentBridgeText /
      // currentInstructionText / retrievalUserPrompt are unchanged: SPEC §10
      // forbids re-running the checkpoint and forbids touching Story Memory.
    };

    return {
      snapshot,
      episodicHitsAdded: episodicResult.added,
      worldbookHitsAdded: worldbookResult.added,
      characterHitsAdded: characterResult.added,
      fellBack: false,
    };
  } catch (error: any) {
    return noop(error?.message ? String(error.message) : 'post-draft retrieval error');
  }
}

/* ----------------------------- episodic ----------------------------- */

/**
 * Re-run the episodic TF-IDF retrieval using the draft as an additional query
 * signal, then merge with the original snapshot's episodic text. Never pulls
 * chapters at position >= current chapter (no future leakage).
 */
async function runPostDraftEpisodicRetrieval(
  original: PipelineContextSnapshot,
  draftText: string,
  projectId: number,
  chapter: Chapter,
  config: ContextConfig,
): Promise<{ text: string; added: number }> {
  // Read chapters fresh (read-only). We must never modify them.
  let chapters: Chapter[] = [];
  try {
    chapters = await db.getChaptersByProject(projectId);
  } catch {
    return { text: original.episodicMemoryText, added: 0 };
  }

  // We reuse prepare() ONLY to resolve the same usable Story Memory snapshot
  // the draft saw (entity boosts / eligibility). We pass mode 'preview' so it
  // never spends LLM tokens and never rebuilds the checkpoint.
  let prepared: Awaited<ReturnType<typeof prepareStoryMemoryForGeneration>> | null = null;
  try {
    prepared = await prepareStoryMemoryForGeneration(projectId, chapter, config, {
      mode: 'preview',
    });
  } catch {
    prepared = null;
  }

  const coverage = prepared?.coverage;
  const rawChapterIds = coverage?.rawChapterIds || [];
  const previousChaptersAll = chapters.filter(c => c.position < chapter.position);
  // Exclude raw bridge chapters (same rule as buildContext) AND any future/same.
  const episodicCandidates = excludeRawFromEpisodicCandidates(
    previousChaptersAll,
    rawChapterIds,
  ).filter(c => c.position < chapter.position);

  if (episodicCandidates.length === 0) {
    return { text: original.episodicMemoryText, added: 0 };
  }

  // Build an augmented query: original retrieval query + the fresh draft text.
  // The draft carries the actual entities the model wrote, which is exactly
  // what we want to detect (old character / place / "first time").
  const previousForQuery = resolvePreviousChapterForQuery(previousChaptersAll, chapter);
  const baseQuery = buildEpisodicRetrievalQuery({
    currentChapter: chapter,
    previousChapter: previousForQuery,
    retrievalUserPrompt: original.retrievalUserPrompt,
  });
  const draftQuery = `${baseQuery}\n${draftText.slice(0, 4000)}`;

  const docs = episodicCandidates
    .map(c => ({ chapter: c, text: String((c as any).memory_summary || '') }))
    .filter(item => item.text.trim());
  if (docs.length === 0) {
    return { text: original.episodicMemoryText, added: 0 };
  }

  // Build IDF over candidates (mirror buildContext's path).
  const idf = buildIdfLocal(docs.map(d => d.text));
  if (!idf || idf.size === 0) {
    return { text: original.episodicMemoryText, added: 0 };
  }

  const storyStateForRetrieval = resolveStoryStateForRetrieval(prepared);
  const storyTerms = collectStoryRetrievalTerms(storyStateForRetrieval ?? null);
  const active = findActiveStoryTerms(draftQuery, storyTerms);
  const scored = scoreMemoryCandidates(
    docs,
    draftQuery,
    idf,
    storyStateForRetrieval ?? null,
    defaultCosine,
    defaultVectorize.bind(null, idf),
    { storyTerms, activeTerms: active },
  );
  const topK = config.memoryTopK ?? 10;
  const budgetTokens =
    config.episodicMemoryBudgetTokens ?? config.summaryBudgetTokens ?? 20000;

  // Merge: take the draft-driven selection, then fill from original-text
  // chapters that were not selected. Dedupe by chapter id (handled inside the
  // merge helper via chapter-prefix matching).
  const draftSelected = selectMemoryCandidates(scored, active, topK);

  // For "added" accounting: identify which selected chapters were NOT in the
  // original episodic text. We detect by chapter id mention in the prefix
  // pattern "第 N 章「title」摘要" — the same format buildContext emits.
  const originalChapterIds = extractChapterIdsFromEpisodicText(
    original.episodicMemoryText,
    chapters,
  );
  const addedCount = draftSelected.filter(
    item => !originalChapterIds.has(item.chapter.id),
  ).length;

  // Original chapters not re-selected: preserve their existing line so we do
  // not lose information that was already injected into the draft.
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

/* ----------------------------- worldbook ----------------------------- */

async function runPostDraftWorldbookRetrieval(
  original: PipelineContextSnapshot,
  draftText: string,
  projectId: number,
  chapter: Chapter,
  config: ContextConfig,
): Promise<{ text: string; added: number }> {
  try {
    // Activate worldbook using the draft text as an additional haystack.
    const budget =
      config.resourceBudget && config.resourceBudget > 0
        ? Math.max(
            0,
            budgetForWorldbook(config.resourceBudget),
          )
        : 2000;
    if (budget <= 0) return { text: original.worldbookText, added: 0 };

    // Use the draft text (plus original scan context) to find newly-relevant
    // entries. buildWorldbookContext is pure (read-only DB inside).
    const draftScan = `${chapter.title || ''}\n${chapter.synopsis || ''}\n${draftText}`;
    const result = await buildWorldbookContext(
      projectId,
      budget,
      draftScan,
      config.worldbookRecursive !== false,
    );

    // Merge: keep original worldbook lines, append draft-activated lines whose
    // body (after the "关键词「x」：" prefix) is not already present.
    const originalLines = (original.worldbookText || '')
      .split('\n')
      .filter(Boolean);
    const originalBodies = new Set(
      originalLines.map(line => stripWorldbookPrefix(line)),
    );
    const draftLines = (result.text || '').split('\n').filter(Boolean);
    const addedLines = draftLines.filter(
      line => !originalBodies.has(stripWorldbookPrefix(line)),
    );

    if (addedLines.length === 0) {
      return { text: original.worldbookText, added: 0 };
    }

    const merged = [...originalLines, ...addedLines].join('\n');
    return { text: merged, added: addedLines.length };
  } catch {
    return { text: original.worldbookText, added: 0 };
  }
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

/* ----------------------------- characters ----------------------------- */

async function runPostDraftCharacterRetrieval(
  original: PipelineContextSnapshot,
  draftText: string,
  projectId: number,
  _chapter: Chapter,
  config: ContextConfig,
): Promise<{ text: string; added: number }> {
  try {
    const budget =
      config.resourceBudget && config.resourceBudget > 0
        ? Math.floor(config.resourceBudget * 0.35)
        : 1500;
    if (budget <= 0) return { text: original.characterText, added: 0 };

    // Fetch characters and activate those whose canonical name / alias appears
    // in the draft. buildCharacterContext returns all characters clipped to
    // budget; we then filter to those mentioned in the draft and merge with the
    // original snapshot's character text.
    const allChars = await buildCharacterContext(projectId, budget);
    const draftLower = draftText.toLowerCase();
    const charBlocks = splitCharacterBlocks(allChars.text);
    const originalNames = extractCharacterNames(original.characterText);

    let added = 0;
    const keptOriginal = original.characterText || '';
    const addedBlocks: string[] = [];
    const seenNames = new Set(originalNames);

    for (const block of charBlocks) {
      const name = extractCharacterNameFromBlock(block);
      if (!name) continue;
      if (seenNames.has(name)) continue;
      // Mention check: name appears in draft (case-insensitive).
      if (!draftLower.includes(name.toLowerCase())) continue;
      addedBlocks.push(block);
      seenNames.add(name);
      added += 1;
    }

    if (addedBlocks.length === 0) {
      return { text: original.characterText, added: 0 };
    }

    // Clip the newly added blocks to the remaining budget so we don't blow the
    // proof/factcheck context.
    const addedText = clipTextToTokenBudget(
      addedBlocks.join('\n\n'),
      Math.max(256, Math.floor(budget * 0.5)),
    );
    const merged = keptOriginal
      ? `${keptOriginal}\n\n${addedText}`
      : addedText;
    return { text: merged, added };
  } catch {
    return { text: original.characterText, added: 0 };
  }
}

function splitCharacterBlocks(text: string): string[] {
  if (!text) return [];
  // Blocks are separated by blank lines and start with "角色「name」".
  return text.split(/\n\n+/).filter(block => block.includes('角色「'));
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

function extractCharacterNameFromBlock(block: string): string | null {
  const m = block.match(/角色「([^」]+)」/);
  return m ? m[1] : null;
}

/**
 * Re-build the draft context snapshot by calling buildContext, then run
 * post-draft retrieval on top. Exposed for tests and for callers that want a
 * one-shot "draft snapshot + post-draft audit snapshot" pipeline.
 */
export async function buildSnapshotWithPostDraftRetrieval(
  chapter: Chapter,
  config: ContextConfig,
  projectId: number,
  preset: Parameters<typeof buildContext>[3],
  options: Parameters<typeof buildContext>[4],
  draftText: string,
): Promise<{
  baseSnapshot: PipelineContextSnapshot;
  auditSnapshot: PipelineContextSnapshot;
  retrieval: PostDraftRetrievalResult;
}> {
  const built = await buildContext(chapter, config, projectId, preset, options);
  const baseSnapshot = built.pipelineContext;
  const retrieval = await buildPostDraftAuditContext(
    baseSnapshot,
    draftText,
    projectId,
    chapter,
    config,
  );
  return {
    baseSnapshot,
    auditSnapshot: retrieval.snapshot,
    retrieval,
  };
}

// Re-export so callers / tests can inspect the pure helpers if needed.
export const __debug = {
  extractChapterIdsFromEpisodicText,
  mergeEpisodicTextPreservingOriginal,
  stripWorldbookPrefix,
  extractCharacterNames,
};

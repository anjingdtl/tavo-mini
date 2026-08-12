/**
 * Resource Context Candidate Collectors (Plan §6).
 *
 * Reads the FULL activated content of characters / notes / worldbook WITHOUT
 * pre-clipping. Each entry becomes a `ResourceContextCandidate` whose
 * `actualTokens` is the real content size; the V3 item allocator then decides
 * how much of each candidate to keep.
 *
 * Candidate-first pipeline (Plan §6.1):
 *   read full content → build Candidate → estimate actualTokens
 *     → Item Allocator → final clip/render
 *
 * Reuses the existing activation logic from `contextBuilder` (constant /
 * primary / primary+secondary / recursive / project-fallback) so V3 never
 * silently diverges from V2 keyword behavior. The activation reason mapping
 * feeds `policy.resourceItems.activationWeights` for relevance scoring.
 */

import * as db from '../database';
import { clipTextTailToTokenBudget, estimateTokens } from '../../utils/tokenEstimator';
import {
  getOrAnalyzeNoteStyle,
  mergeStyleProfiles,
  DEFAULT_STYLE_WEIGHTS,
  type StyleWeights,
} from '../styleAnalyzer';
import { retrieveNoteFragments, type RetrievalQuery } from '../noteRetriever';
import type { Chapter } from '../../types/novel';
import type { ResourceActivationReason } from '../contextAutomationPolicy';

export interface ResourceContextCandidate {
  id: string;
  sourceKind: 'character' | 'note' | 'worldbook';
  sourceId: number | null;
  title: string;
  /** Full unclipped content body. */
  content: string;
  /** Real content size in tokens (estimated once, never re-tokenized). */
  actualTokens: number;
  /** User explicitly picked this resource (Plan §7 selectionBoost). */
  explicitSelected: boolean;
  /** Whether activation logic turned this candidate on. */
  activated: boolean;
  activationReason?: ResourceActivationReason;
  /** Stable input order; deterministic tie-break only. */
  sourceOrder: number;
  /** Optional legacy max_tokens (manual mode respects; V3 ignores). */
  legacyMaxTokens?: number;
  /** Optional retrieval score in [0,1] from note retrieval mode. */
  retrievalScore?: number;
}

export interface CandidateCollectionResult {
  candidates: ResourceContextCandidate[];
  /** True total content size across activated candidates. */
  totalActualTokens: number;
}

export interface CollectCandidatesOptions {
  retrievalUserPrompt?: string;
  chapterTitle?: string;
  chapterSynopsis?: string;
  recursiveWorldbook?: boolean;
  /** Cap number of candidates to avoid pathological N. Default unlimited. */
  maxCandidatesPerKind?: number;
}

const ACTIVATION_REASON_MAP: Record<string, ResourceActivationReason> = {
  常驻: 'constant',
  主关键词命中: 'primary_hit',
  '主+次关键词命中': 'primary_secondary_hit',
  递归命中: 'recursive_hit',
  项目启用兜底: 'project_fallback',
};

function safeJson(text: string): any {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

function includesKey(text: string, key: string): boolean {
  return text.toLocaleLowerCase().includes(key.toLocaleLowerCase());
}

function normalizeKeys(raw: any): string[] {
  if (Array.isArray(raw)) {
    return raw.map(String).map(item => item.trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[,，\n]/)
      .map(item => item.trim())
      .filter(Boolean);
  }
  return [];
}

function formatCharacterCard(character: any): { text: string; name: string } {
  const data = safeJson(character.data_json);
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
    card.post_history_instructions && `后置指令：${card.post_history_instructions}`,
  ]
    .filter(Boolean)
    .join('\n');
  return { text, name: charName };
}

/**
 * Character candidates: every character that belongs to the project is
 * activated and explicitly selected (the user added them).
 *
 * No `remaining` decrement, no per-item max_tokens clipping — the V3 item
 * allocator handles that downstream.
 */
export async function collectCharacterCandidates(
  projectId: number,
  options: CollectCandidatesOptions = {},
): Promise<CandidateCollectionResult> {
  const characters = (await db.getCharactersByProject(projectId)) as any[];
  const cap = options.maxCandidatesPerKind ?? characters.length;
  const candidates: ResourceContextCandidate[] = characters
    .slice(0, cap)
    .map((character, idx) => {
      const { text, name } = formatCharacterCard(character);
      return {
        id: `character:${character.id ?? idx}`,
        sourceKind: 'character' as const,
        sourceId: Number(character.id) || null,
        title: name,
        content: text,
        actualTokens: estimateTokens(text),
        explicitSelected: true,
        activated: true,
        activationReason: 'explicit' as ResourceActivationReason,
        sourceOrder: idx,
        legacyMaxTokens: Number(character.max_tokens ?? undefined),
      };
    });
  const totalActualTokens = candidates.reduce(
    (sum, c) => sum + c.actualTokens,
    0,
  );
  return { candidates, totalActualTokens };
}

/**
 * Note candidates — mode-aware dispatch matching `buildNoteContext`:
 *   - style: merged style profile → ONE candidate
 *   - retrieval: each retrieved fragment → one candidate with retrievalScore
 *   - original / none: each enabled note → one candidate
 */
export async function collectNoteCandidates(
  projectId: number,
  scanText: string,
  options: CollectCandidatesOptions = {},
): Promise<CandidateCollectionResult> {
  let config: any = null;
  try {
    config = await db.getProjectNoteConfig(projectId);
  } catch {
    config = null;
  }
  const mode = config?.mode || 'none';
  if (mode === 'style') {
    return collectStyleNoteCandidates(projectId, config);
  }
  if (mode === 'retrieval') {
    return collectRetrievalNoteCandidates(
      projectId,
      scanText,
      config,
      options.chapterTitle || '',
      options.chapterSynopsis || '',
      options.retrievalUserPrompt || '',
    );
  }
  return collectOriginalNoteCandidates(projectId, options);
}

async function collectStyleNoteCandidates(
  projectId: number,
  config: any,
): Promise<CandidateCollectionResult> {
  try {
    const projectNotes = await db.getNotesByProject(projectId);
    const eligibleIds = projectNotes.map((note: any) => Number(note.id));
    const eligibleSet = new Set(eligibleIds);
    const configuredIds: number[] = Array.isArray(config?.enabledNoteIds)
      ? config.enabledNoteIds.map(Number)
      : [];
    const noteIds =
      configuredIds.length > 0
        ? configuredIds.filter(id => eligibleSet.has(id))
        : eligibleIds;
    if (noteIds.length === 0) {
      return { candidates: [], totalActualTokens: 0 };
    }
    const settled = await Promise.allSettled(
      noteIds.map((id: number) => getOrAnalyzeNoteStyle(id)),
    );
    const profiles = settled
      .filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof getOrAnalyzeNoteStyle>>> =>
          r.status === 'fulfilled',
      )
      .map(r => r.value)
      .filter(
        p => p && p.profileJson && Object.keys(p.profileJson).length > 0,
      );
    const weights: StyleWeights = {
      ...DEFAULT_STYLE_WEIGHTS,
      ...(config?.styleWeights || {}),
    };
    const mergedText = mergeStyleProfiles(profiles, weights);
    if (!mergedText) {
      return { candidates: [], totalActualTokens: 0 };
    }
    const content = `以下是本次写作必须遵循的风格画像，请严格按照对应权重的维度进行仿写：\n${mergedText}`;
    const candidate: ResourceContextCandidate = {
      id: 'note:style-profile',
      sourceKind: 'note',
      sourceId: null,
      title: '风格画像（仿写）',
      content,
      actualTokens: estimateTokens(content),
      explicitSelected: true,
      activated: true,
      activationReason: 'explicit',
      sourceOrder: 0,
    };
    return { candidates: [candidate], totalActualTokens: candidate.actualTokens };
  } catch {
    return collectOriginalNoteCandidates(projectId, {});
  }
}

async function collectRetrievalNoteCandidates(
  projectId: number,
  _scanText: string,
  config: any,
  chapterTitle: string,
  chapterSynopsis: string,
  userPrompt: string,
): Promise<CandidateCollectionResult> {
  try {
    const topK = config?.retrievalTopK ?? 5;
    const query: RetrievalQuery = {
      chapterTitle,
      chapterSynopsis,
      previousEnding: _scanText.slice(-500),
      userPrompt,
    };
    const fragments = await retrieveNoteFragments(projectId, query, topK);
    const candidates: ResourceContextCandidate[] = fragments.map((f, idx) => {
      const content = `[笔记「${f.noteTitle}」] ${f.fragment}`;
      return {
        id: `note:retrieval:${f.noteId ?? idx}`,
        sourceKind: 'note',
        sourceId: f.noteId ?? null,
        title: f.noteTitle,
        content,
        actualTokens: estimateTokens(content),
        explicitSelected: false,
        activated: true,
        activationReason: 'primary_hit',
        sourceOrder: idx,
      };
    });
    const totalActualTokens = candidates.reduce(
      (sum, c) => sum + c.actualTokens,
      0,
    );
    return { candidates, totalActualTokens };
  } catch {
    return { candidates: [], totalActualTokens: 0 };
  }
}

async function collectOriginalNoteCandidates(
  projectId: number,
  _options: CollectCandidatesOptions,
): Promise<CandidateCollectionResult> {
  const notes = await db.getNotesByProject(projectId);
  if (notes.length === 0) {
    return { candidates: [], totalActualTokens: 0 };
  }
  // Bulk fetch all note contents — avoids N+1 round-trips for large projects.
  let contents: Record<number, string> = {};
  try {
    contents = await db.getNotesContentByIds(notes.map(n => Number(n.id)));
  } catch {
    contents = {};
  }
  const candidates: ResourceContextCandidate[] = notes.map((note, idx) => {
    const content = contents[Number(note.id)] ?? '';
    const noteTitle = note.title || '无标题';
    const text = `笔记「${noteTitle}」：${content}`;
    return {
      id: `note:${note.id ?? idx}`,
      sourceKind: 'note',
      sourceId: Number(note.id) || null,
      title: noteTitle,
      content: text,
      actualTokens: estimateTokens(text),
      explicitSelected: true,
      activated: true,
      activationReason: 'explicit',
      sourceOrder: idx,
      legacyMaxTokens: Number(note.max_tokens ?? undefined),
    };
  });
  const totalActualTokens = candidates.reduce(
    (sum, c) => sum + c.actualTokens,
    0,
  );
  return { candidates, totalActualTokens };
}

/**
 * Worldbook candidates — preserves the exact activation cascade from
 * `buildWorldbookContext`:
 *   1. scan pass (primary keyword / primary+secondary / constant)
 *   2. optional recursive pass over activated content
 *   3. project-fallback when no entry hit and entries exist
 *
 * Each activated entry becomes ONE candidate with no pre-clipping. Constant
 * entries are flagged explicit; fallback entries get the lowest relevance.
 */
export async function collectWorldbookCandidates(
  projectId: number,
  scanText: string,
  recursive = true,
): Promise<CandidateCollectionResult> {
  const entries = ((await db.getWorldbookEntriesByProject(projectId)) as any[]).sort(
    (a, b) =>
      Number(a.position || 0) - Number(b.position || 0) ||
      Number(a.id || 0) - Number(b.id || 0),
  );
  if (entries.length === 0) {
    return { candidates: [], totalActualTokens: 0 };
  }

  const activated = new Map<number | null, any>();
  const activationReason = new Map<number | null, string>();

  const determineReason = (entry: any, haystack: string): string => {
    if (entry.constant === 1 || entry.constant === true) return '常驻';
    const primaryKeys = normalizeKeys(
      entry.keyword_primary ?? entry.key ?? entry.keys ?? entry.keyword,
    );
    if (primaryKeys.length === 0) return '常驻';
    const primaryHit = primaryKeys.some(key => includesKey(haystack, key));
    if (!primaryHit) return '';
    const secondaryKeys = normalizeKeys(
      entry.keyword_secondary ?? entry.keysecondary ?? entry.secondary_keys,
    );
    if (secondaryKeys.length === 0) return '主关键词命中';
    const secondaryHit = secondaryKeys.some(key => includesKey(haystack, key));
    return secondaryHit ? '主+次关键词命中' : '主关键词命中';
  };

  const activatePass = (haystack: string, isRecursive = false) => {
    for (const entry of entries) {
      const id = Number(entry.id) || null;
      if (activated.has(id)) continue;
      const reason = determineReason(entry, haystack);
      if (reason) {
        activated.set(id, entry);
        activationReason.set(id, isRecursive ? '递归命中' : reason);
      }
    }
  };

  activatePass(scanText);
  if (recursive && activated.size > 0) {
    activatePass(
      `${scanText}\n\n${Array.from(activated.values())
        .map(entry => entry.content || '')
        .join('\n')}`,
      true,
    );
  }
  // Project-fallback: user enabled worldbook but no entry hit. Inject all
  // entries at the lowest relevance so the writer still sees the setting.
  if (activated.size === 0) {
    for (const entry of entries) {
      const id = Number(entry.id) || null;
      if (activated.has(id)) continue;
      activated.set(id, entry);
      activationReason.set(id, '项目启用兜底');
    }
  }

  const candidates: ResourceContextCandidate[] = [];
  let sourceOrder = 0;
  for (const [idKey, entry] of activated) {
    const reasonZh = activationReason.get(idKey) || '主关键词命中';
    const reasonEnum: ResourceActivationReason =
      ACTIVATION_REASON_MAP[reasonZh] ?? 'primary_hit';
    const entryContent = String(entry.content || '');
    const label = normalizeKeys(
      entry.keyword_primary ?? entry.key ?? entry.keys ?? entry.keyword,
    )[0];
    const content = label ? `关键词「${label}」：${entryContent}` : entryContent;
    candidates.push({
      id: `worldbook:${entry.id ?? sourceOrder}`,
      sourceKind: 'worldbook',
      sourceId: Number(entry.id) || idKey,
      title: label || `条目#${entry.id}`,
      content,
      actualTokens: estimateTokens(content),
      explicitSelected: reasonEnum === 'constant',
      activated: true,
      activationReason: reasonEnum,
      sourceOrder,
      legacyMaxTokens: Number(entry.max_tokens ?? undefined),
    });
    sourceOrder += 1;
  }
  const totalActualTokens = candidates.reduce(
    (sum, c) => sum + c.actualTokens,
    0,
  );
  return { candidates, totalActualTokens };
}

/**
 * Convenience aggregator: runs all three collectors in parallel and returns
 * the merged candidate list + per-kind demand sums. `scanText` is the worldbook
 * activation haystack (title + synopsis + content + retrieval prompt + sliding
 * window preview), built by the caller (`contextBuilder`).
 */
export async function collectAllResourceCandidates(
  projectId: number,
  scanText: string,
  currentChapter: Chapter | undefined,
  options: CollectCandidatesOptions = {},
): Promise<{
  character: CandidateCollectionResult;
  note: CandidateCollectionResult;
  worldbook: CandidateCollectionResult;
  candidates: ResourceContextCandidate[];
  totalActualTokens: number;
}> {
  const [character, note, worldbook] = await Promise.all([
    collectCharacterCandidates(projectId, options),
    collectNoteCandidates(projectId, scanText, {
      ...options,
      chapterTitle: currentChapter?.title,
      chapterSynopsis: currentChapter?.synopsis,
    }),
    collectWorldbookCandidates(
      projectId,
      scanText,
      options.recursiveWorldbook !== false,
    ),
  ]);
  const candidates = [
    ...character.candidates,
    ...note.candidates,
    ...worldbook.candidates,
  ];
  const totalActualTokens =
    character.totalActualTokens +
    note.totalActualTokens +
    worldbook.totalActualTokens;
  return { character, note, worldbook, candidates, totalActualTokens };
}

/**
 * Render a candidate to its final injected text, clipped to the allocator
 * grant. Returns the rendered line + whether clipping happened.
 *
 * The label prefix matches the V2 builder format so prompt byte stability is
 * preserved across V2/V3 for identical allocation outcomes.
 */
export function renderCandidateToText(
  candidate: ResourceContextCandidate,
  grantedTokens: number,
): { text: string; clipped: boolean } {
  if (grantedTokens <= 0) return { text: '', clipped: candidate.actualTokens > 0 };
  if (grantedTokens >= candidate.actualTokens) {
    return { text: candidate.content, clipped: false };
  }
  // Token-safe tail-biased clip (Closure Plan §12). The previous implementation
  // sliced by char-length ratio, which cannot guarantee
  // `estimateTokens(rendered) <= grant` for mixed CJK/ASCII/emoji content.
  // `clipTextTailToTokenBudget` shares the exact cost model of `estimateTokens`
  // (it stops as soon as the next unit would exceed the budget), so the hard
  // invariant holds by construction while still keeping the most recent tail.
  const text = clipTextTailToTokenBudget(candidate.content, grantedTokens);
  return { text, clipped: true };
}

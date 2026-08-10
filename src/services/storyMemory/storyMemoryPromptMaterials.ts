/**
 * Story Memory prompt materials (governance plan §5 / §6).
 *
 * Decomposes the previously monolithic Story Memory checkpoint prompt into
 * named, tiered modules so the input side can finally be driven by the
 * project's elastic allocator instead of a single hard
 * `contextWindow - output - 256` envelope.
 *
 * Tiering (治理方案 §5.4):
 *   - Mandatory:    system protocol, schema/contract, range, chapter ids,
 *                    current-batch full chapter bodies, repair instruction,
 *                    full lightweight character roster.
 *   - PreferredHigh: currentArc, currentObjective, activeConflicts,
 *                    openThreads, foreshadowing, batch-relevant character rich
 *                    state + relationships.
 *   - PreferredLow:  recent timelineAnchors, recentCompletedBeats,
 *                    recentResolvedThreads, non-relevant character state,
 *                    non-relevant relationships.
 *   - Optional:      archiveDigest, old/non-pinned timeline, closed history.
 *
 * Fast path invariant (§5.6): when every module fits the elastic budget, the
 * re-assembled messages are byte-identical to the legacy
 * `buildStoryMemoryCheckpointMessages` builder, so existing prompt semantics
 * and model behavior are preserved.
 *
 * Relevance (§5.5): a deterministic resolver marks characters/relationships as
 * "relevant" when their canonicalName or alias appears in the current batch
 * body. No extra LLM call is made.
 *
 * Forbidden (§5.8): this module never string-slices JSON. Each module is
 * clipped as a whole text block via `clipTextToTokenBudget`. The current-batch
 * chapter bodies are Mandatory and therefore never clipped.
 */
import type { Chapter } from '../../types/novel';
import type { StoryMemoryState, StoryRelationship } from './storyMemoryTypes';
import { canonicalStringify } from './storyMemoryFingerprint';
import {
  BATCH_ITEM_CONTRACT,
  MAINLINE_EXTRACTION_USER_BLOCK,
  STORY_MEMORY_CHECKPOINT_SYSTEM_PROMPT,
  createEmptyBatchPatch,
  orderedBatchSchemaForPrompt,
  promptStringify,
} from './storyMemoryPrompts';

export type StoryMemoryPromptTier =
  | 'mandatory'
  | 'preferred_high'
  | 'preferred_low'
  | 'optional';

export interface StoryMemoryPromptModule {
  id: string;
  /** Re-assembled prompt text for this module. */
  text: string;
  tier: StoryMemoryPromptTier;
  /** Allocator priority weight (higher = allocated earlier). */
  priority: number;
  /** Retrieval relevance in [0,1] (higher = kept longer when shrinking). */
  relevance: number;
  /** Higher shrinkPriority = clipped later during final-window shrink. */
  shrinkPriority: number;
  /** Higher burstPriority = borrows burst earlier when the soft pool is full. */
  burstPriority: number;
}

export interface StoryMemoryCheckpointMaterials {
  /** Ordered modules, system first. */
  modules: StoryMemoryPromptModule[];
  /** Chapter range summary string for diagnostics. */
  rangeLabel: string;
  /** Relevant character ids resolved from the current batch body. */
  relevantCharacterIds: Set<string>;
  /** Whether any batch-relevant character was found. */
  hasRelevantCharacters: boolean;
  /** Optional repair instruction block prepended to the user content. */
  repairInstruction: string;
}

/**
 * Render the lightweight roster block (always Mandatory). This is a strict
 * subset of the legacy `characterExtractionUserBlock`: the full
 * canonicalName/alias list so the model never recreates known characters.
 */
function renderRosterBlock(state: StoryMemoryState): string {
  const characters = Object.values(state.characters);
  const names = characters
    .map(character => character.canonicalName)
    .filter(Boolean)
    .sort();
  return [
    '【已知人物名册——禁止把下列人物再放入 newCharacters】',
    names.length
      ? names.map(name => `- ${name}`).join('\n')
      : '- （空，开篇检查点：所有具名出场人物都应进入 newCharacters）',
    '',
    '【人物抽取检查清单】',
    '1. 扫读本批/本章全部姓名与明确称呼。',
    '2. 不在名册中的具名角色 → newCharacters（每人一条，tempRef 唯一）。',
    '3. 已在名册中且本章有位置/目标/物品/关系等变化 → characterUpdates。',
    '4. 新出现的人物关系 → newRelationships 或 relationshipUpdates。',
    '5. 程序会保留上一检查点全部旧人物；你不需要也不能删除旧人物，但必须补全新人物。',
  ].join('\n');
}

/**
 * Deterministic relevant-character resolver (governance §5.5).
 * A character is relevant if its canonicalName or any alias appears as a
 * substring in the concatenated batch body. Pure local — no LLM call.
 */
export function resolveRelevantCharacterIds(
  state: StoryMemoryState,
  batchBody: string,
): Set<string> {
  const relevant = new Set<string>();
  if (!batchBody) return relevant;
  for (const character of Object.values(state.characters)) {
    const terms = [character.canonicalName, ...(character.aliases || [])]
      .map(t => String(t || '').trim())
      .filter(t => t.length >= 2);
    if (terms.some(term => batchBody.includes(term))) {
      relevant.add(character.id);
    }
  }
  return relevant;
}

interface StoryMainlineView {
  currentArc: unknown;
  currentObjective: unknown;
  activeConflicts: unknown;
  openThreads: unknown;
  foreshadowing: unknown;
  timelineAnchors: unknown;
  recentCompletedBeats: unknown[];
  recentResolvedThreads: unknown[];
  archiveDigest: unknown;
}

/**
 * Build the Preferred High mainline block: the open/active mainline state
 * that governs continuity. This is the high-priority slice of the previous
 * StoryMemoryState, separated from archive/old-timeline (Optional).
 */
function renderPreferredHighMainline(state: StoryMemoryState): string {
  const mainline = state.mainline;
  return canonicalStringify({
    currentArc: mainline.currentArc,
    currentObjective: mainline.currentObjective,
    activeConflicts: mainline.activeConflicts,
    openThreads: mainline.openThreads,
    foreshadowing: mainline.foreshadowing,
  });
}

/**
 * Build the Preferred Low mainline block: recent resolved/closed items and
 * timeline. These are continuity-useful but lower priority than active state.
 */
function renderPreferredLowMainline(state: StoryMemoryState): string {
  const mainline = state.mainline;
  return canonicalStringify({
    recentCompletedBeats: mainline.recentCompletedBeats.slice(-8),
    recentResolvedThreads: mainline.recentResolvedThreads.slice(-8),
    timelineAnchors: mainline.timelineAnchors,
  });
}

/**
 * Build the Optional archive block: long-running history digest.
 */
function renderOptionalArchive(state: StoryMemoryState): string {
  const digest = state.mainline.archiveDigest;
  return digest ? String(digest).slice(0, 800) : '';
}

/**
 * Render relevant character rich state (Preferred High) — only characters that
 * appear in the current batch body get their full rich state in the prompt.
 */
function renderRelevantCharacters(
  state: StoryMemoryState,
  relevantIds: Set<string>,
): string {
  if (relevantIds.size === 0) return '';
  const characters = Object.values(state.characters).filter(character =>
    relevantIds.has(character.id),
  );
  if (characters.length === 0) return '';
  return canonicalStringify(
    characters.map(character => ({
      id: character.id,
      canonicalName: character.canonicalName,
      aliases: character.aliases,
      role: character.role,
      status: character.status,
      currentState: character.currentState,
    })),
  );
}

/**
 * Render non-relevant character lightweight state (Preferred Low) — id/name
 * only so the model still knows they exist, without their full rich state.
 */
function renderNonRelevantCharacters(
  state: StoryMemoryState,
  relevantIds: Set<string>,
): string {
  const characters = Object.values(state.characters).filter(
    character => !relevantIds.has(character.id),
  );
  if (characters.length === 0) return '';
  return canonicalStringify(
    characters.map(character => ({
      id: character.id,
      canonicalName: character.canonicalName,
      status: character.status,
    })),
  );
}

function relationshipsFor(
  relationships: StoryRelationship[],
  relevantIds: Set<string>,
): StoryRelationship[] {
  return relationships.filter(
    rel =>
      relevantIds.has(rel.fromCharacterId) || relevantIds.has(rel.toCharacterId),
  );
}

function renderRelevantRelationships(
  state: StoryMemoryState,
  relevantIds: Set<string>,
): string {
  if (relevantIds.size === 0) return '';
  const rels = relationshipsFor(
    Object.values(state.relationships),
    relevantIds,
  );
  if (rels.length === 0) return '';
  return canonicalStringify(
    rels.map(rel => ({
      id: rel.id,
      fromCharacterId: rel.fromCharacterId,
      toCharacterId: rel.toCharacterId,
      direction: rel.direction,
      relationType: rel.relationType,
      currentState: rel.currentState,
      trustLevel: rel.trustLevel,
    })),
  );
}

function renderNonRelevantRelationships(
  state: StoryMemoryState,
  relevantIds: Set<string>,
): string {
  const rels = Object.values(state.relationships).filter(
    rel =>
      !relevantIds.has(rel.fromCharacterId) &&
      !relevantIds.has(rel.toCharacterId),
  );
  if (rels.length === 0) return '';
  return canonicalStringify(
    rels.map(rel => ({
      id: rel.id,
      fromCharacterId: rel.fromCharacterId,
      toCharacterId: rel.toCharacterId,
      relationType: rel.relationType,
    })),
  );
}

/**
 * Build the full set of tiered prompt modules for one Story Memory checkpoint
 * batch. The modules, when concatenated in order, reproduce the legacy
 * `buildStoryMemoryCheckpointMessages` user content (plus a separately
 * delivered system module and an optional repair-instruction module).
 */
export function buildStoryMemoryCheckpointMaterials(
  chapters: Chapter[],
  state: StoryMemoryState,
  options: { repairInstruction?: string } = {},
): StoryMemoryCheckpointMaterials {
  const ordered = [...chapters].sort((a, b) => a.position - b.position);
  const schema = createEmptyBatchPatch(ordered);
  const batchBody = ordered.map(c => c.content || '').join('\n');
  const relevantIds = resolveRelevantCharacterIds(state, batchBody);

  const chapterBlocks = ordered
    .map(chapter =>
      [
        `--- 章节 ---`,
        `ID：${chapter.id}`,
        `位置：${chapter.position}`,
        `标题：${chapter.title}`,
        `概要：${chapter.synopsis || '无'}`,
        `正文：\n${chapter.content}`,
      ].join('\n'),
    )
    .join('\n\n');

  const rangeLabel = `共 ${ordered.length} 章，position ${
    ordered[0].position
  }～${ordered[ordered.length - 1].position}。须抽取本批全部具名新人物。`;

  const schemaText = promptStringify(orderedBatchSchemaForPrompt(schema));
  const reminders =
    '【chapterSummaries 检索摘要提醒】每章 brief/events 须写清谁对谁做了什么；承诺、欺骗、冲突、合作、救援、拒绝、背叛；物品获得/失去/使用/转交；信息得知/误解/隐瞒/泄露；关系变化原因；未解决线索/秘密/误会/矛盾。禁止“二人/他们/双方/有人”等模糊代词。';

  const rosterBlock = renderRosterBlock(state);
  const preferredHighMainline = renderPreferredHighMainline(state);
  const preferredLowMainline = renderPreferredLowMainline(state);
  const optionalArchive = renderOptionalArchive(state);
  const relevantChars = renderRelevantCharacters(state, relevantIds);
  const nonRelevantChars = renderNonRelevantCharacters(state, relevantIds);
  const relevantRels = renderRelevantRelationships(state, relevantIds);
  const nonRelevantRels = renderNonRelevantRelationships(state, relevantIds);

  const modules: StoryMemoryPromptModule[] = [];

  // --- Mandatory (never clipped) -----------------------------------------
  modules.push({
    id: 'system_protocol',
    text: STORY_MEMORY_CHECKPOINT_SYSTEM_PROMPT,
    tier: 'mandatory',
    priority: 10,
    relevance: 1,
    shrinkPriority: 10,
    burstPriority: 10,
  });
  if (options.repairInstruction) {
    modules.push({
      id: 'repair_instruction',
      text: options.repairInstruction,
      tier: 'mandatory',
      priority: 10,
      relevance: 1,
      shrinkPriority: 10,
      burstPriority: 10,
    });
  }
  modules.push({
    id: 'range_block',
    text: `【本批次范围】${rangeLabel}`,
    tier: 'mandatory',
    priority: 10,
    relevance: 1,
    shrinkPriority: 10,
    burstPriority: 10,
  });
  modules.push({
    id: 'chapter_bodies',
    text: ['【本批次章节（按 position 升序）】', chapterBlocks].join('\n'),
    tier: 'mandatory',
    priority: 10,
    relevance: 1,
    shrinkPriority: 10,
    burstPriority: 10,
  });
  modules.push({
    id: 'schema_contract',
    text: [
      MAINLINE_EXTRACTION_USER_BLOCK,
      '',
      '【严格输出范式——字段顺序即填写优先级】',
      schemaText,
      '',
      BATCH_ITEM_CONTRACT,
      '',
      reminders,
    ].join('\n'),
    tier: 'mandatory',
    priority: 10,
    relevance: 1,
    shrinkPriority: 10,
    burstPriority: 10,
  });
  modules.push({
    id: 'roster',
    text: rosterBlock,
    tier: 'mandatory',
    priority: 9,
    relevance: 1,
    shrinkPriority: 9,
    burstPriority: 9,
  });

  // --- Preferred High ----------------------------------------------------
  const stateHeader = '【上一检查点已验证故事状态】';
  if (preferredHighMainline && preferredHighMainline !== '{}') {
    modules.push({
      id: 'preferred_high_mainline',
      text: [stateHeader, preferredHighMainline].join('\n'),
      tier: 'preferred_high',
      priority: 8,
      relevance: 0.95,
      shrinkPriority: 8,
      burstPriority: 7,
    });
  }
  if (relevantChars) {
    modules.push({
      id: 'relevant_characters',
      text: ['【本批相关人物当前状态】', relevantChars].join('\n'),
      tier: 'preferred_high',
      priority: 8,
      relevance: 0.9,
      shrinkPriority: 8,
      burstPriority: 6,
    });
  }
  if (relevantRels) {
    modules.push({
      id: 'relevant_relationships',
      text: ['【本批相关人物关系】', relevantRels].join('\n'),
      tier: 'preferred_high',
      priority: 7,
      relevance: 0.85,
      shrinkPriority: 7,
      burstPriority: 5,
    });
  }

  // --- Preferred Low -----------------------------------------------------
  if (preferredLowMainline) {
    modules.push({
      id: 'preferred_low_mainline',
      text: ['【近期已闭合/时间线状态】', preferredLowMainline].join('\n'),
      tier: 'preferred_low',
      priority: 5,
      relevance: 0.55,
      shrinkPriority: 4,
      burstPriority: 2,
    });
  }
  if (nonRelevantChars) {
    modules.push({
      id: 'non_relevant_characters',
      text: ['【其他已知人物（轻量）】', nonRelevantChars].join('\n'),
      tier: 'preferred_low',
      priority: 4,
      relevance: 0.45,
      shrinkPriority: 3,
      burstPriority: 1,
    });
  }
  if (nonRelevantRels) {
    modules.push({
      id: 'non_relevant_relationships',
      text: ['【其他已知关系（轻量）】', nonRelevantRels].join('\n'),
      tier: 'preferred_low',
      priority: 3,
      relevance: 0.4,
      shrinkPriority: 2,
      burstPriority: 1,
    });
  }

  // --- Optional ----------------------------------------------------------
  if (optionalArchive) {
    modules.push({
      id: 'archive_digest',
      text: ['【历史归档摘要】', optionalArchive].join('\n'),
      tier: 'optional',
      priority: 2,
      relevance: 0.3,
      shrinkPriority: 1,
      burstPriority: 0,
    });
  }

  return {
    modules,
    rangeLabel,
    relevantCharacterIds: relevantIds,
    hasRelevantCharacters: relevantIds.size > 0,
    repairInstruction: options.repairInstruction || '',
  };
}

/**
 * Re-assemble the system + user ChatMessage[] from the (possibly clipped)
 * module texts. The first module whose id starts with `system_` becomes the
 * system message; everything else becomes the user content joined by blank
 * lines, mirroring the legacy builder's structure.
 */
export function buildMessagesFromMaterials(
  materials: StoryMemoryCheckpointMaterials,
  clippedTexts: ReadonlyMap<string, string>,
): Array<{ role: 'system' | 'user'; content: string }> {
  let systemContent = '';
  const userParts: string[] = [];
  for (const module of materials.modules) {
    const text = clippedTexts.get(module.id) ?? '';
    if (!text) continue;
    if (module.id === 'system_protocol') {
      systemContent = text;
    } else if (module.id === 'repair_instruction') {
      // Repair instruction leads the user content (after it is built into
      // the caller's repair messages, this stays the first user block).
      userParts.unshift(text);
    } else {
      userParts.push(text);
    }
  }
  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userParts.join('\n\n') },
  ];
}

/** Stable field order is shared from storyMemoryPrompts.orderedBatchSchemaForPrompt. */

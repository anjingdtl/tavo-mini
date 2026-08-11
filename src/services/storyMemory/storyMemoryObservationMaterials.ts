import type { Chapter } from '../../types/novel';
import { estimateTokens } from '../../utils/tokenEstimator';
import type { StoryMemoryState } from './storyMemoryTypes';
import type { StoryMemoryEvidenceEnvelope } from './storyMemoryEvidenceAnchors';
import type { StoryMemoryEntityHandleEnvelope } from './storyMemoryEntityHandles';
import {
  STORY_MEMORY_V2_LEGACY_BOOTSTRAP_NOTE,
  STORY_MEMORY_V2_OBSERVER_CONTRACT,
  STORY_MEMORY_V2_OBSERVER_SYSTEM_PROMPT,
} from './storyMemoryObservationPrompts';

export type StoryMemoryObservationPromptTier =
  | 'mandatory'
  | 'preferred_high'
  | 'preferred_low'
  | 'optional';

export interface StoryMemoryObservationPromptModule {
  id: string;
  text: string;
  tier: StoryMemoryObservationPromptTier;
  priority: number;
  relevance: number;
  shrinkPriority: number;
  burstPriority: number;
  itemKind: string;
}

export interface StoryMemoryObservationMaterials {
  modules: StoryMemoryObservationPromptModule[];
  handles: StoryMemoryEntityHandleEnvelope;
  evidence: StoryMemoryEvidenceEnvelope;
  rangeLabel: string;
  relevantCharacterIds: Set<string>;
  includedChapterHandles: string[];
  legacyBootstrap: boolean;
  materialCounts: {
    mandatory: number;
    preferredHigh: number;
    preferredLow: number;
    optional: number;
  };
}

function clean(value: string | undefined | null): string {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function addModule(
  modules: StoryMemoryObservationPromptModule[],
  input: Omit<StoryMemoryObservationPromptModule, 'id'> & { id: string },
): void {
  if (!input.text.trim()) return;
  modules.push(input);
}

function relevantCharacters(
  state: StoryMemoryState,
  chapters: Chapter[],
): Set<string> {
  const body = chapters.map(chapter => chapter.content || '').join('\n');
  const result = new Set<string>();
  for (const character of Object.values(state.characters)) {
    const terms = [character.canonicalName, ...character.aliases]
      .map(clean)
      .filter(term => term.length >= 2);
    if (terms.some(term => body.includes(term))) result.add(character.id);
  }
  return result;
}

function keywordMatches(text: string, body: string): boolean {
  const keywords = clean(text)
    .split(/[\s，。！？、；：,.!?;:（）()「」“”"'\u005b\u005d]+/u)
    .filter(keyword => Array.from(keyword).length >= 2);
  return keywords.some(keyword => body.includes(keyword));
}

function renderAnchoredChapter(
  chapter: Chapter,
  handles: StoryMemoryEntityHandleEnvelope,
  evidence: StoryMemoryEvidenceEnvelope,
): string {
  const chapterHandle = handles.chapterHandleById.get(chapter.id) || `CH${chapter.position + 1}`;
  const anchors = evidence.anchors.filter(anchor => anchor.chapterId === chapter.id);
  const lines = anchors.map(anchor => `${anchor.id} ${anchor.text}`);
  return [
    `【${chapterHandle}｜第${chapter.position + 1}章｜${clean(chapter.title)}】`,
    clean(chapter.synopsis) ? `概要：${clean(chapter.synopsis)}` : '',
    lines.length ? lines.join('\n') : '正文：无可用连续片段',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderCharacterRoster(
  state: StoryMemoryState,
  handles: StoryMemoryEntityHandleEnvelope,
): string[] {
  const lines = Object.values(state.characters)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(character => {
      const handle = handles.reverseCharacter.get(character.id) || '';
      return `${handle} | ${clean(character.canonicalName)} | aliases=${character.aliases.map(clean).filter(Boolean).join('/') || '-'} | status=${character.status}`;
    });
  return lines.length ? lines : ['（暂无已知人物）'];
}

function renderRichCharacter(
  state: StoryMemoryState,
  characterId: string,
  handles: StoryMemoryEntityHandleEnvelope,
): string {
  const character = state.characters[characterId];
  if (!character) return '';
  const handle = handles.reverseCharacter.get(characterId) || '';
  const current = character.currentState;
  return `${handle} | ${clean(character.canonicalName)} | role=${clean(character.role) || '-'} | location=${clean(current.location) || '-'} | physical=${clean(current.physicalState) || '-'} | emotional=${clean(current.emotionalState) || '-'} | goal=${clean(current.currentGoal) || '-'} | knowledge=${current.knowledge.map(clean).join('/') || '-'} | possessions=${current.possessions.map(clean).join('/') || '-'} | secrets=${current.secrets.map(clean).join('/') || '-'}`;
}

function renderRelationship(
  relationship: StoryMemoryState['relationships'][string],
  handles: StoryMemoryEntityHandleEnvelope,
): string {
  const handle = handles.reverseRelationship.get(relationship.id) || '';
  const from = handles.reverseCharacter.get(relationship.fromCharacterId) || '?';
  const to = handles.reverseCharacter.get(relationship.toCharacterId) || '?';
  return `${handle} | ${from}↔${to} | ${clean(relationship.relationType) || '-'} | state=${clean(relationship.currentState) || '-'} | trust=${relationship.trustLevel}`;
}

const MAINLINE_FIELD_CHAR_LIMIT = 240;

function boundField(value: string, limit = MAINLINE_FIELD_CHAR_LIMIT): string {
  const cleaned = clean(value);
  if (Array.from(cleaned).length <= limit) return cleaned;
  return Array.from(cleaned).slice(0, limit).join('') + '…';
}

function renderCurrentArc(state: StoryMemoryState): string {
  const arc = state.mainline.currentArc;
  if (!arc) return 'A01 | none';
  return `A01 | ${boundField(arc.name, 80) || 'none'} | ${boundField(arc.summary, 160) || 'none'}`;
}

function renderCurrentObjective(state: StoryMemoryState): string {
  return `OBJECTIVE | ${boundField(state.mainline.currentObjective, 160) || 'none'}`;
}

function conflictRelevance(
  conflict: StoryMemoryState['mainline']['activeConflicts'][string],
  body: string,
  relevantIds: ReadonlySet<string>,
): number {
  let score = 0.4;
  if (conflict.parties.some(id => relevantIds.has(id))) score += 0.35;
  if (keywordMatches(`${conflict.title} ${conflict.state}`, body)) score += 0.2;
  return Math.min(1, score);
}

function threadRelevance(
  thread: StoryMemoryState['mainline']['openThreads'][string],
  body: string,
  relevantIds: ReadonlySet<string>,
): number {
  let score = 0.35;
  if (thread.ownerCharacterIds.some(id => relevantIds.has(id))) score += 0.3;
  if (keywordMatches(`${thread.title} ${thread.description}`, body)) score += 0.2;
  if (thread.priority === 'critical') score += 0.15;
  else if (thread.priority === 'high') score += 0.1;
  return Math.min(1, score);
}

function foreshadowRelevance(
  item: StoryMemoryState['mainline']['foreshadowing'][string],
  body: string,
): number {
  let score = 0.3;
  if (keywordMatches(`${item.setup} ${item.expectedPayoff}`, body)) score += 0.35;
  if (item.status === 'open' || item.status === 'partially_paid') score += 0.15;
  return Math.min(1, score);
}

/**
 * Pack complete items without half-item clipping. Oversized candidates are
 * skipped so later smaller items can still fill remaining budget.
 */
export function packWholeItems<T>(
  items: T[],
  tokenBudget: number,
  render: (item: T) => string,
): T[] {
  const budget = Math.max(0, Math.floor(Number(tokenBudget) || 0));
  if (budget <= 0) return [];
  const packed: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = estimateTokens(render(item));
    if (used + cost > budget) continue;
    packed.push(item);
    used += cost;
  }
  return packed;
}

export interface PackWholeItemsResult<T> {
  included: T[];
  skippedTooLarge: T[];
  remainingBudget: number;
}

export function packWholeItemsWithDiagnostics<T>(
  items: T[],
  tokenBudget: number,
  render: (item: T) => string,
): PackWholeItemsResult<T> {
  const budget = Math.max(0, Math.floor(Number(tokenBudget) || 0));
  if (budget <= 0) {
    return { included: [], skippedTooLarge: [...items], remainingBudget: 0 };
  }
  const included: T[] = [];
  const skippedTooLarge: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = estimateTokens(render(item));
    if (used + cost > budget) {
      if (cost > budget - used) skippedTooLarge.push(item);
      continue;
    }
    included.push(item);
    used += cost;
  }
  return {
    included,
    skippedTooLarge,
    remainingBudget: Math.max(0, budget - used),
  };
}

export function buildStoryMemoryObservationMaterials(
  chapters: Chapter[],
  state: StoryMemoryState,
  handles: StoryMemoryEntityHandleEnvelope,
  evidence: StoryMemoryEvidenceEnvelope,
  options: { legacyBootstrap?: boolean } = {},
): StoryMemoryObservationMaterials {
  const ordered = [...chapters].sort((left, right) => left.position - right.position);
  const body = ordered.map(chapter => chapter.content || '').join('\n');
  const relevantIds = relevantCharacters(state, ordered);
  const modules: StoryMemoryObservationPromptModule[] = [];
  const mandatory = {
    tier: 'mandatory' as const,
    priority: 10,
    relevance: 1,
    shrinkPriority: 10,
    burstPriority: 10,
  };
  addModule(modules, {
    id: 'v2_system_protocol',
    text: STORY_MEMORY_V2_OBSERVER_SYSTEM_PROMPT,
    itemKind: 'protocol',
    ...mandatory,
  });
  addModule(modules, {
    id: 'v2_output_contract',
    text: STORY_MEMORY_V2_OBSERVER_CONTRACT,
    itemKind: 'contract',
    ...mandatory,
  });
  if (options.legacyBootstrap) {
    addModule(modules, {
      id: 'v2_legacy_bootstrap_note',
      text: STORY_MEMORY_V2_LEGACY_BOOTSTRAP_NOTE,
      itemKind: 'legacy_note',
      ...mandatory,
    });
  }
  addModule(modules, {
    id: 'v2_range',
    text: `【本批次范围】${ordered.length} 章，position ${ordered[0]?.position ?? '-'}～${ordered.at(-1)?.position ?? '-'}。`,
    itemKind: 'range',
    ...mandatory,
  });
  addModule(modules, {
    id: 'v2_chapter_handles',
    text: [
      '【章节 handles】',
      ...handles.chapters.map(chapter => `${chapter.handle} | position=${chapter.position} | title=${clean(chapter.title)}`),
    ].join('\n'),
    itemKind: 'chapter_handles',
    ...mandatory,
  });
  for (const chapter of ordered) {
    addModule(modules, {
      id: `v2_chapter_${chapter.id}`,
      text: renderAnchoredChapter(chapter, handles, evidence),
      itemKind: 'chapter_body',
      ...mandatory,
    });
  }
  const roster = renderCharacterRoster(state, handles);
  roster.forEach((line, index) => {
    addModule(modules, {
      id: `v2_roster_${index + 1}`,
      text: index === 0 ? `【人物名册】\n${line}` : line,
      itemKind: 'roster_item',
      tier: 'mandatory',
      priority: 9,
      relevance: 1,
      shrinkPriority: 9,
      burstPriority: 9,
    });
  });

  // Arc / Objective stay mandatory so long novels never drop the active spine.
  addModule(modules, {
    id: 'v2_current_arc',
    text: `【当前剧情弧】\n${renderCurrentArc(state)}`,
    itemKind: 'current_arc',
    ...mandatory,
    priority: 9,
    shrinkPriority: 9,
    burstPriority: 9,
  });
  addModule(modules, {
    id: 'v2_current_objective',
    text: `【当前目标】\n${renderCurrentObjective(state)}`,
    itemKind: 'current_objective',
    ...mandatory,
    priority: 9,
    shrinkPriority: 9,
    burstPriority: 9,
  });
  Object.values(state.mainline.activeConflicts)
    .sort((left, right) => left.id.localeCompare(right.id))
    .forEach(conflict => {
      const handle = handles.reverseConflict.get(conflict.id) || '';
      const parties = conflict.parties
        .map(id => handles.reverseCharacter.get(id) || '?')
        .join(',');
      addModule(modules, {
        id: `v2_conflict_${conflict.id}`,
        text: `【活跃冲突】\n${handle} | ${boundField(conflict.title, 80)} | state=${boundField(conflict.state, 80)} | stakes=${boundField(conflict.stakes, 80)} | parties=${parties || '-'}`,
        itemKind: 'conflict_item',
        tier: 'preferred_high',
        priority: 8,
        relevance: conflictRelevance(conflict, body, relevantIds),
        shrinkPriority: 7,
        burstPriority: 6,
      });
    });
  Object.values(state.mainline.openThreads)
    .sort((left, right) => left.id.localeCompare(right.id))
    .forEach(thread => {
      const handle = handles.reverseThread.get(thread.id) || '';
      const owners = thread.ownerCharacterIds
        .map(id => handles.reverseCharacter.get(id) || '?')
        .join(',');
      addModule(modules, {
        id: `v2_thread_${thread.id}`,
        text: `【开放线索】\n${handle} | ${boundField(thread.title, 80)} | ${boundField(thread.description, 160)} | priority=${thread.priority} | owners=${owners || '-'}`,
        itemKind: 'thread_item',
        tier: 'preferred_high',
        priority: 8,
        relevance: threadRelevance(thread, body, relevantIds),
        shrinkPriority: 7,
        burstPriority: 6,
      });
    });
  Object.values(state.mainline.foreshadowing)
    .filter(item => item.status === 'open' || item.status === 'partially_paid')
    .sort((left, right) => left.id.localeCompare(right.id))
    .forEach(item => {
      const handle = handles.reverseForeshadowing.get(item.id) || '';
      addModule(modules, {
        id: `v2_foreshadow_${item.id}`,
        text: `【伏笔】\n${handle} | setup=${boundField(item.setup, 120)} | payoff=${boundField(item.expectedPayoff, 120)} | status=${item.status}`,
        itemKind: 'foreshadow_item',
        tier: 'preferred_high',
        priority: 7,
        relevance: foreshadowRelevance(item, body),
        shrinkPriority: 6,
        burstPriority: 5,
      });
    });
  [...relevantIds]
    .sort()
    .forEach(characterId => {
      addModule(modules, {
        id: `v2_rich_character_${characterId}`,
        text: `【相关人物状态】\n${renderRichCharacter(state, characterId, handles)}`,
        itemKind: 'rich_character',
        tier: 'preferred_high',
        priority: 8,
        relevance: 0.95,
        shrinkPriority: 8,
        burstPriority: 7,
      });
    });
  Object.values(state.relationships)
    .filter(item => relevantIds.has(item.fromCharacterId) || relevantIds.has(item.toCharacterId))
    .sort((left, right) => left.id.localeCompare(right.id))
    .forEach(relationship => {
      addModule(modules, {
        id: `v2_relationship_${relationship.id}`,
        text: `【相关关系】\n${renderRelationship(relationship, handles)}`,
        itemKind: 'relationship',
        tier: 'preferred_high',
        priority: 7,
        relevance: 0.9,
        shrinkPriority: 7,
        burstPriority: 6,
      });
    });

  state.mainline.timelineAnchors &&
    Object.values(state.mainline.timelineAnchors)
      .slice(-8)
      .forEach((item, index) => {
        addModule(modules, {
          id: `v2_timeline_${item.id}`,
          text: `【近期时间线】\n${index + 1}. ${clean(item.label)} | ${clean(item.timeDescription)} | ${clean(item.event)}`,
          itemKind: 'recent_timeline',
          tier: 'preferred_low',
          priority: 5,
          relevance: keywordMatches(`${item.label} ${item.event}`, body) ? 0.8 : 0.45,
          shrinkPriority: 4,
          burstPriority: 2,
        });
      });
  state.mainline.recentResolvedThreads.slice(-8).forEach((item, index) => {
    addModule(modules, {
      id: `v2_resolved_thread_${item.id}`,
      text: `【近期已解决线索】\n${index + 1}. ${clean(item.title)} | ${clean(item.resolution)}`,
      itemKind: 'recent_resolved',
      tier: 'preferred_low',
      priority: 4,
      relevance: keywordMatches(`${item.title} ${item.resolution}`, body) ? 0.75 : 0.35,
      shrinkPriority: 3,
      burstPriority: 1,
    });
  });
  if (state.mainline.archiveDigest.trim()) {
    addModule(modules, {
      id: 'v2_archive_digest',
      text: `【历史归档摘要】\n${clean(state.mainline.archiveDigest).slice(0, 1600)}`,
      itemKind: 'archive',
      tier: 'optional',
      priority: 2,
      relevance: 0.3,
      shrinkPriority: 1,
      burstPriority: 0,
    });
  }
  return {
    modules,
    handles,
    evidence,
    rangeLabel: `${ordered.length} 章，position ${ordered[0]?.position ?? '-'}～${ordered.at(-1)?.position ?? '-'}`,
    relevantCharacterIds: relevantIds,
    includedChapterHandles: handles.chapters.map(chapter => chapter.handle),
    legacyBootstrap: Boolean(options.legacyBootstrap),
    materialCounts: {
      mandatory: modules.filter(module => module.tier === 'mandatory').length,
      preferredHigh: modules.filter(module => module.tier === 'preferred_high').length,
      preferredLow: modules.filter(module => module.tier === 'preferred_low').length,
      optional: modules.filter(module => module.tier === 'optional').length,
    },
  };
}

export function buildMessagesFromObservationMaterials(
  materials: StoryMemoryObservationMaterials,
  includedModuleIds?: ReadonlySet<string>,
): Array<{ role: 'system' | 'user'; content: string }> {
  const included = (module: StoryMemoryObservationPromptModule) =>
    !includedModuleIds || includedModuleIds.has(module.id);
  const system = materials.modules.find(
    module => module.id === 'v2_system_protocol' && included(module),
  )?.text || STORY_MEMORY_V2_OBSERVER_SYSTEM_PROMPT;
  const user = materials.modules
    .filter(module => module.id !== 'v2_system_protocol' && included(module))
    .map(module => module.text)
    .filter(Boolean)
    .join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

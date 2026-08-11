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

function renderActiveMainline(
  state: StoryMemoryState,
  handles: StoryMemoryEntityHandleEnvelope,
): string {
  const mainline = state.mainline;
  const lines: string[] = [];
  if (mainline.currentArc) {
    lines.push(`A01 | ${clean(mainline.currentArc.name)} | ${clean(mainline.currentArc.summary)}`);
  } else {
    lines.push('A01 | （当前无剧情弧）');
  }
  lines.push(`OBJECTIVE | ${clean(mainline.currentObjective) || '（无当前目标）'}`);
  Object.values(mainline.activeConflicts)
    .sort((left, right) => left.id.localeCompare(right.id))
    .forEach(conflict => {
      const handle = handles.reverseConflict.get(conflict.id) || '';
      const parties = conflict.parties
        .map(id => handles.reverseCharacter.get(id) || '?')
        .join(',');
      lines.push(`${handle} | ${clean(conflict.title)} | state=${clean(conflict.state)} | stakes=${clean(conflict.stakes)} | parties=${parties || '-'}`);
    });
  Object.values(mainline.openThreads)
    .sort((left, right) => left.id.localeCompare(right.id))
    .forEach(thread => {
      const handle = handles.reverseThread.get(thread.id) || '';
      const owners = thread.ownerCharacterIds
        .map(id => handles.reverseCharacter.get(id) || '?')
        .join(',');
      lines.push(`${handle} | ${clean(thread.title)} | ${clean(thread.description)} | priority=${thread.priority} | owners=${owners || '-'}`);
    });
  Object.values(mainline.foreshadowing)
    .sort((left, right) => left.id.localeCompare(right.id))
    .forEach(item => {
      const handle = handles.reverseForeshadowing.get(item.id) || '';
      lines.push(`${handle} | setup=${clean(item.setup)} | payoff=${clean(item.expectedPayoff)} | status=${item.status}`);
    });
  return lines.join('\n');
}

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
    if (used + cost > budget) break;
    packed.push(item);
    used += cost;
  }
  return packed;
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

  addModule(modules, {
    id: 'v2_active_mainline',
    text: `【当前主线与热状态】\n${renderActiveMainline(state, handles)}`,
    itemKind: 'active_mainline',
    tier: 'preferred_high',
    priority: 9,
    relevance: 1,
    shrinkPriority: 9,
    burstPriority: 8,
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

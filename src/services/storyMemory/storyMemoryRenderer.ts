import type { Chapter } from '../../types/novel';
import {
  clipTextToTokenBudget,
  estimateTokens,
} from '../../utils/tokenEstimator';
import {
  collectStoryRetrievalTerms,
  findActiveStoryTerms,
} from '../episodicMemoryRetriever';
import { resolveCharacterMentionsInText } from './characterMentionResolver';
import type { StoryMemoryState } from './storyMemoryTypes';

export interface RenderStoryMemoryResult {
  text: string;
  estimatedTokens: number;
  clipped: boolean;
  includedCharacterIds: string[];
  includedRelationshipIds: string[];
}

export interface RenderStoryMemoryOptions {
  currentChapter: Chapter;
  budgetTokens: number;
  /** User writing instruction for this generation turn (optional). */
  retrievalUserPrompt?: string;
}

const list = (values: string[]) => values.filter(Boolean).join('、') || '无';

/** Display label: 林岚[char_lan]; fall back to raw id when missing. */
export function characterLabel(
  state: StoryMemoryState,
  characterId: string,
): string {
  const character = state.characters?.[characterId];
  const name = character?.canonicalName?.trim();
  if (name) return `${name}[${characterId}]`;
  return characterId;
}

const THREAD_PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

interface SelectableLine {
  id: string;
  line: string;
  kind: 'character' | 'relationship' | 'mainline';
}

interface RelationshipBundle {
  relationshipId: string;
  requiredCharacterIds: string[];
  relationshipLine: string;
  priority: number;
  lastChangedPosition: number;
}

/**
 * Build scan text for relevance: title + synopsis + content head + user prompt.
 */
export function buildStoryMemoryScanText(
  currentChapter: Chapter,
  retrievalUserPrompt?: string,
): string {
  return [
    currentChapter.title,
    currentChapter.synopsis,
    currentChapter.content?.slice(0, 2000),
    retrievalUserPrompt,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Resolve currently relevant character IDs via the shared mention resolver
 * (same rules as Episodic query + candidate scoring).
 */
export function resolveRelevantCharacterIds(
  state: StoryMemoryState,
  scanText: string,
): Set<string> {
  const terms = collectStoryRetrievalTerms(state);
  const resolution = resolveCharacterMentionsInText(scanText, terms);
  // Keep ActiveStoryTerms path available for object/thread callers; IDs from resolver.
  if (resolution.characterIds.length > 0) {
    return new Set(resolution.characterIds);
  }
  // Empty resolution still may use findActiveStoryTerms for legacy fixtures.
  const active = findActiveStoryTerms(scanText, terms);
  return new Set(active.activeCharacterIds || []);
}

function buildPrefix(state: StoryMemoryState): string {
  const throughLabel =
    state.throughChapterPosition >= 0
      ? `第 ${state.throughChapterPosition + 1} 章`
      : '开篇前';
  return `以下是截至${throughLabel}整理并验证的长期故事状态。\n${throughLabel}之后的近期正文可能包含更新；若两者冲突，以章节位置更晚的近期正文为准。\n除非近期正文或当前写作要求明确改变，否则不得违背该长期状态。\n\n【故事全局状态｜截至${throughLabel}】`;
}

function characterLine(
  state: StoryMemoryState,
  characterId: string,
): string | null {
  const item = state.characters?.[characterId];
  if (!item) return null;
  return `- [${item.id}] ${item.canonicalName}（别名：${list(item.aliases)}）：${item.role || '身份未知'}；位置：${item.currentState.location || '未知'}；身体/情绪：${item.currentState.physicalState || '未知'}/${item.currentState.emotionalState || '未知'}；目标：${item.currentState.currentGoal || '无'}；已知：${list(item.currentState.knowledge)}；持有：${list(item.currentState.possessions)}；秘密：${list(item.currentState.secrets)}；状态：${item.status}`;
}

function relationshipLine(
  state: StoryMemoryState,
  relId: string,
): string | null {
  const item = state.relationships?.[relId];
  if (!item) return null;
  return `- [${item.id}] ${characterLabel(state, item.fromCharacterId)} ${item.direction === 'bidirectional' ? '↔' : '→'} ${characterLabel(state, item.toCharacterId)}：${item.relationType}；${item.currentState}；信任：${item.trustLevel}；公开：${item.publicStatus || '无'}；隐藏：${item.hiddenStatus || '无'}；原因：${item.reason || '无'}`;
}

function assembleMainlineCandidates(state: StoryMemoryState): SelectableLine[] {
  const mainline = state.mainline;
  const items: SelectableLine[] = [];

  if (mainline.currentArc) {
    items.push({
      id: `arc:${mainline.currentArc.id}`,
      kind: 'mainline',
      line: `- 当前剧情弧：[${mainline.currentArc.id}] ${mainline.currentArc.name}：${mainline.currentArc.summary}`,
    });
  } else {
    items.push({
      id: 'arc:none',
      kind: 'mainline',
      line: '- 当前剧情弧：无',
    });
  }

  items.push({
    id: 'objective',
    kind: 'mainline',
    line: `- 当前目标：${mainline.currentObjective || '无'}`,
  });

  const conflicts = Object.values(mainline.activeConflicts || {});
  if (conflicts.length === 0) {
    items.push({
      id: 'conflict:none',
      kind: 'mainline',
      line: '- 活跃冲突：无',
    });
  } else {
    for (const item of conflicts) {
      items.push({
        id: `conflict:${item.id}`,
        kind: 'mainline',
        line: `- 活跃冲突：[${item.id}] ${item.title}：${item.state}（代价：${item.stakes}）`,
      });
    }
  }

  const threads = Object.values(mainline.openThreads || {}).sort(
    (a, b) =>
      (THREAD_PRIORITY_RANK[a.priority] ?? 9) -
      (THREAD_PRIORITY_RANK[b.priority] ?? 9),
  );
  if (threads.length === 0) {
    items.push({
      id: 'thread:none',
      kind: 'mainline',
      line: '- 未解决线索：无',
    });
  } else {
    for (const item of threads) {
      items.push({
        id: `thread:${item.id}`,
        kind: 'mainline',
        line: `- 未解决线索：[${item.id}] ${item.title}：${item.description}`,
      });
    }
  }

  const foreshadow = Object.values(mainline.foreshadowing || {}).filter(
    item => item.status !== 'paid',
  );
  if (foreshadow.length === 0) {
    items.push({
      id: 'foreshadow:none',
      kind: 'mainline',
      line: '- 未兑现伏笔：无',
    });
  } else {
    for (const item of foreshadow) {
      items.push({
        id: `foreshadow:${item.id}`,
        kind: 'mainline',
        line: `- 未兑现伏笔：[${item.id}] ${item.setup}→${item.expectedPayoff}`,
      });
    }
  }

  const anchors = Object.values(mainline.timelineAnchors || {}).filter(
    item => item.pinned,
  );
  if (anchors.length === 0) {
    items.push({
      id: 'anchor:none',
      kind: 'mainline',
      line: '- 关键时间锚点：无',
    });
  } else {
    for (const item of anchors) {
      items.push({
        id: `anchor:${item.id}`,
        kind: 'mainline',
        line: `- 关键时间锚点：[${item.id}] ${item.timeDescription}：${item.event}`,
      });
    }
  }

  const beats = mainline.recentCompletedBeats || [];
  if (beats.length === 0) {
    items.push({
      id: 'beat:none',
      kind: 'mainline',
      line: '- 最近完成节点：无',
    });
  } else {
    for (const item of beats) {
      items.push({
        id: `beat:${item.id}`,
        kind: 'mainline',
        line: `- 最近完成节点：${item.summary}`,
      });
    }
  }

  return items;
}

function renderFromSelection(
  prefix: string,
  selectedCharacters: SelectableLine[],
  selectedRelationships: SelectableLine[],
  selectedMainline: SelectableLine[],
): string {
  return [
    prefix,
    '',
    '一、登场人物',
    ...(selectedCharacters.length
      ? selectedCharacters.map(item => item.line)
      : ['无']),
    '',
    '二、人物关系',
    ...(selectedRelationships.length
      ? selectedRelationships.map(item => item.line)
      : ['无']),
    '',
    '三、故事主线',
    ...(selectedMainline.length
      ? selectedMainline.map(item => item.line)
      : ['无']),
  ].join('\n');
}

function relationshipPriority(
  fromId: string,
  toId: string,
  relevantIds: Set<string>,
): number {
  const both = relevantIds.has(fromId) && relevantIds.has(toId);
  if (both) return 2;
  if (relevantIds.has(fromId) || relevantIds.has(toId)) return 1;
  return 0;
}

/**
 * Hard token-capped Story Memory renderer.
 *
 * Budget priority (relationship-first for current relevant pairs):
 *   1. Highest-priority relationship's both character cards
 *   2. That relationship line
 *   3. Next high-priority relationships (missing cards + line as atomic bundle)
 *   4. Remaining current-relevant characters
 *   5. Other recently-changed characters
 *   6. Other relationships
 *   7. Mainline entries
 *
 * Never dumps all current characters before relationships.
 * Final text never exceeds budgetTokens.
 */
export function renderStoryMemoryForContext(
  state: StoryMemoryState,
  options: RenderStoryMemoryOptions,
): RenderStoryMemoryResult {
  const budgetTokens = Math.max(0, options.budgetTokens);
  const emptyResult = (): RenderStoryMemoryResult => ({
    text: '',
    estimatedTokens: 0,
    clipped: true,
    includedCharacterIds: [],
    includedRelationshipIds: [],
  });

  if (budgetTokens <= 0) return emptyResult();

  const scan = buildStoryMemoryScanText(
    options.currentChapter,
    options.retrievalUserPrompt,
  );
  const relevantIds = resolveRelevantCharacterIds(state, scan);
  const prefix = buildPrefix(state);

  // If even the prefix cannot fit, return a safe truncated prefix (or empty).
  if (estimateTokens(prefix) > budgetTokens) {
    const safe = clipTextToTokenBudget(prefix, budgetTokens);
    const tokens = estimateTokens(safe);
    if (tokens > budgetTokens || !safe) {
      return emptyResult();
    }
    return {
      text: safe,
      estimatedTokens: tokens,
      clipped: true,
      includedCharacterIds: [],
      includedRelationshipIds: [],
    };
  }

  const allCharacters = Object.values(state.characters || {});
  const allRelationships = Object.values(state.relationships || {});

  const highPriorityBundles: RelationshipBundle[] = allRelationships
    .map(r => {
      const line = relationshipLine(state, r.id);
      if (!line) return null;
      const priority = relationshipPriority(
        r.fromCharacterId,
        r.toCharacterId,
        relevantIds,
      );
      return {
        relationshipId: r.id,
        requiredCharacterIds: [r.fromCharacterId, r.toCharacterId],
        relationshipLine: line,
        priority,
        lastChangedPosition: r.lastChangedPosition,
      } as RelationshipBundle;
    })
    .filter((b): b is RelationshipBundle => b != null && b.priority >= 1)
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (b.lastChangedPosition !== a.lastChangedPosition) {
        return b.lastChangedPosition - a.lastChangedPosition;
      }
      return a.relationshipId.localeCompare(b.relationshipId);
    });

  const highPriorityRelIds = new Set(
    highPriorityBundles.map(b => b.relationshipId),
  );

  const relevantCharacters = allCharacters
    .filter(c => relevantIds.has(c.id))
    .sort(
      (a, b) =>
        b.lastChangedPosition - a.lastChangedPosition ||
        a.id.localeCompare(b.id),
    );
  const otherCharacters = allCharacters
    .filter(c => !relevantIds.has(c.id))
    .sort(
      (a, b) =>
        b.lastChangedPosition - a.lastChangedPosition ||
        a.id.localeCompare(b.id),
    );

  const otherRels = allRelationships
    .filter(r => !highPriorityRelIds.has(r.id))
    .sort((a, b) => {
      const scoreDiff =
        relationshipPriority(b.fromCharacterId, b.toCharacterId, relevantIds) -
        relationshipPriority(a.fromCharacterId, a.toCharacterId, relevantIds);
      if (scoreDiff !== 0) return scoreDiff;
      if (b.lastChangedPosition !== a.lastChangedPosition) {
        return b.lastChangedPosition - a.lastChangedPosition;
      }
      return a.id.localeCompare(b.id);
    });

  const mainlineCandidates = assembleMainlineCandidates(state);

  const selectedCharacters: SelectableLine[] = [];
  const selectedRelationships: SelectableLine[] = [];
  const selectedMainline: SelectableLine[] = [];
  const includedCharIds = new Set<string>();
  const includedRelIds = new Set<string>();
  let clipped = false;

  const currentText = () =>
    renderFromSelection(
      prefix,
      selectedCharacters,
      selectedRelationships,
      selectedMainline,
    );

  const tryAdd = (bucket: SelectableLine[], item: SelectableLine): boolean => {
    bucket.push(item);
    if (estimateTokens(currentText()) > budgetTokens) {
      bucket.pop();
      clipped = true;
      return false;
    }
    return true;
  };

  /**
   * Atomic relationship bundle: missing character cards + relationship line.
   * Only commit if the whole bundle fits; otherwise roll back entirely.
   */
  const tryAddRelationshipBundle = (bundle: RelationshipBundle): boolean => {
    if (includedRelIds.has(bundle.relationshipId)) return true;

    const charSnapshots: SelectableLine[] = [];
    for (const charId of bundle.requiredCharacterIds) {
      if (includedCharIds.has(charId)) continue;
      const line = characterLine(state, charId);
      if (!line) continue;
      charSnapshots.push({ id: charId, line, kind: 'character' });
    }
    const relItem: SelectableLine = {
      id: bundle.relationshipId,
      line: bundle.relationshipLine,
      kind: 'relationship',
    };

    for (const c of charSnapshots) selectedCharacters.push(c);
    selectedRelationships.push(relItem);

    if (estimateTokens(currentText()) > budgetTokens) {
      // Roll back entire bundle.
      for (let i = 0; i < charSnapshots.length; i += 1) {
        selectedCharacters.pop();
      }
      selectedRelationships.pop();
      clipped = true;
      return false;
    }

    for (const c of charSnapshots) includedCharIds.add(c.id);
    includedRelIds.add(bundle.relationshipId);
    return true;
  };

  // Skeleton with empty sections (prefix + headers + 「无」×3) must fit first.
  if (estimateTokens(currentText()) > budgetTokens) {
    const minimal = currentText();
    const safe = clipTextToTokenBudget(minimal, budgetTokens);
    const tokens = estimateTokens(safe);
    if (!safe || tokens > budgetTokens) return emptyResult();
    return {
      text: safe,
      estimatedTokens: tokens,
      clipped: true,
      includedCharacterIds: [],
      includedRelationshipIds: [],
    };
  }

  // 1–4) High-priority relationship bundles (both-relevant first, then one-side).
  // Do NOT add all current characters before relationships.
  for (const bundle of highPriorityBundles) {
    tryAddRelationshipBundle(bundle);
  }

  // 5) Remaining current-relevant characters not already pulled by bundles.
  for (const character of relevantCharacters) {
    if (includedCharIds.has(character.id)) continue;
    const line = characterLine(state, character.id);
    if (!line) continue;
    if (
      tryAdd(selectedCharacters, {
        id: character.id,
        line,
        kind: 'character',
      })
    ) {
      includedCharIds.add(character.id);
    }
  }

  // 6) Other recently-changed characters
  for (const character of otherCharacters) {
    if (includedCharIds.has(character.id)) continue;
    const line = characterLine(state, character.id);
    if (!line) continue;
    if (
      tryAdd(selectedCharacters, {
        id: character.id,
        line,
        kind: 'character',
      })
    ) {
      includedCharIds.add(character.id);
    }
  }

  // 7) Other relationships
  for (const rel of otherRels) {
    if (includedRelIds.has(rel.id)) continue;
    const line = relationshipLine(state, rel.id);
    if (!line) continue;
    if (
      tryAdd(selectedRelationships, {
        id: rel.id,
        line,
        kind: 'relationship',
      })
    ) {
      includedRelIds.add(rel.id);
    }
  }

  // 8) Mainline items one-by-one
  for (const item of mainlineCandidates) {
    tryAdd(selectedMainline, item);
  }

  let text = currentText();
  let estimated = estimateTokens(text);

  // Hard guard: never exceed budget (non-additive edge / join surprises).
  if (estimated > budgetTokens) {
    clipped = true;
    text = clipTextToTokenBudget(text, budgetTokens);
    estimated = estimateTokens(text);
    if (estimated > budgetTokens) {
      return emptyResult();
    }
  }

  return {
    text,
    estimatedTokens: estimated,
    clipped,
    includedCharacterIds: selectedCharacters.map(item => item.id),
    includedRelationshipIds: selectedRelationships.map(item => item.id),
  };
}

import type {
  ResourceDetailActivationReason,
  ResourceDetailCandidate,
} from './resourceAwarenessTypes';
import { listCharacterNames } from './characterAwarenessCompiler';

const CHARACTER_REASON_SCORE: Record<string, number> = {
  pov: 0.99,
  title_synopsis_hit: 0.98,
  user_prompt_hit: 0.97,
  current_body_hit: 0.9,
  previous_chapter_hit: 0.84,
  story_memory_hit: 0.76,
  outline_hit: 0.74,
  relation_neighbor: 0.58,
  episodic_hit: 0.55,
  project_enabled: 0.18,
  explicit: 0.8,
};

const WORLDBOOK_REASON_SCORE: Record<string, number> = {
  primary_secondary_hit: 0.98,
  constant: 0.82,
  primary_hit: 0.88,
  entity_hit: 0.86,
  recursive_hit: 0.72,
  story_memory_hit: 0.74,
  episodic_hit: 0.7,
  project_fallback: 0.12,
  explicit: 0.8,
};

export interface CharacterScoreHaystack {
  title: string;
  synopsis: string;
  currentBody: string;
  userPrompt: string;
  previousChapter: string;
  storyMemory: string;
  outline: string;
  episodic: string;
  povNames?: string[];
}

function includesAny(haystack: string, terms: string[]): boolean {
  const text = haystack.toLocaleLowerCase();
  return terms.some(term => {
    const key = term.toLocaleLowerCase().trim();
    return key.length > 0 && text.includes(key);
  });
}

export function scoreCharacterActivation(
  rawSource: unknown,
  haystack: CharacterScoreHaystack,
): { reason: ResourceDetailActivationReason; relevance: number } {
  const names = listCharacterNames(rawSource);
  const pov = (haystack.povNames || []).map(name => name.toLocaleLowerCase());
  const isPov = names.some(name => pov.includes(name.toLocaleLowerCase()));
  if (isPov) return { reason: 'pov', relevance: CHARACTER_REASON_SCORE.pov };
  if (includesAny(`${haystack.title}\n${haystack.synopsis}`, names)) {
    return {
      reason: 'title_synopsis_hit',
      relevance: CHARACTER_REASON_SCORE.title_synopsis_hit,
    };
  }
  if (includesAny(haystack.userPrompt, names)) {
    return {
      reason: 'user_prompt_hit',
      relevance: CHARACTER_REASON_SCORE.user_prompt_hit,
    };
  }
  if (includesAny(haystack.currentBody, names)) {
    return {
      reason: 'current_body_hit',
      relevance: CHARACTER_REASON_SCORE.current_body_hit,
    };
  }
  if (includesAny(haystack.previousChapter, names)) {
    return {
      reason: 'previous_chapter_hit',
      relevance: CHARACTER_REASON_SCORE.previous_chapter_hit,
    };
  }
  if (includesAny(haystack.storyMemory, names)) {
    return {
      reason: 'story_memory_hit',
      relevance: CHARACTER_REASON_SCORE.story_memory_hit,
    };
  }
  if (includesAny(haystack.outline, names)) {
    return { reason: 'outline_hit', relevance: CHARACTER_REASON_SCORE.outline_hit };
  }
  if (includesAny(haystack.episodic, names)) {
    return {
      reason: 'episodic_hit',
      relevance: CHARACTER_REASON_SCORE.episodic_hit,
    };
  }
  return {
    reason: 'project_enabled',
    relevance: CHARACTER_REASON_SCORE.project_enabled,
  };
}

export function scoreWorldbookActivation(
  reason: ResourceDetailActivationReason,
): number {
  return WORLDBOOK_REASON_SCORE[reason] ?? 0.2;
}

export function applyRelationNeighborBoost(
  details: ResourceDetailCandidate[],
  relationHintsByCharacterId: Map<number, string[]>,
  nameByCharacterId: Map<number, string[]>,
): ResourceDetailCandidate[] {
  const high = details.filter(
    item =>
      item.sourceKind === 'character' &&
      item.relevance >= 0.74 &&
      item.sourceId != null,
  );
  if (high.length === 0) return details;
  const boosted = new Set<number>();
  for (const item of high) {
    const hints = relationHintsByCharacterId.get(Number(item.sourceId)) || [];
    for (const [id, names] of nameByCharacterId) {
      if (id === Number(item.sourceId)) continue;
      if (hints.some(hint => includesAny(hint, names) || includesAny(names.join(' '), [hint]))) {
        boosted.add(id);
      }
    }
  }
  return details.map(item => {
    if (
      item.sourceKind !== 'character' ||
      item.sourceId == null ||
      !boosted.has(Number(item.sourceId)) ||
      item.relevance >= 0.74
    ) {
      return item;
    }
    const next = Math.max(item.relevance, CHARACTER_REASON_SCORE.relation_neighbor);
    return {
      ...item,
      relevance: next,
      relationBoost: next - item.relevance,
      activationReason:
        item.activationReason === 'project_enabled'
          ? 'relation_neighbor'
          : item.activationReason,
    };
  });
}

export function compareDetailCandidates(
  left: ResourceDetailCandidate,
  right: ResourceDetailCandidate,
): number {
  if (right.relevance !== left.relevance) return right.relevance - left.relevance;
  if (left.actualTokens !== right.actualTokens) {
    return left.actualTokens - right.actualTokens;
  }
  return left.sourceOrder - right.sourceOrder;
}

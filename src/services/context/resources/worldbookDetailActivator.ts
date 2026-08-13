import { estimateTokens } from '../../../utils/tokenEstimator';
import {
  listWorldbookKeywords,
  parseWorldbookSourcePayload,
} from './worldbookAwarenessCompiler';
import { wrapAsNovelData } from './characterDetailRenderer';
import type {
  ResourceDetailActivationReason,
  ResourceDetailCandidate,
} from './resourceAwarenessTypes';

function includesKey(text: string, key: string): boolean {
  if (!key) return false;
  return text.toLocaleLowerCase().includes(key.toLocaleLowerCase());
}

export interface WorldbookActivationHaystack {
  title: string;
  synopsis: string;
  currentBody: string;
  userPrompt: string;
  previousChapters: string;
  storyMemory: string;
  outline: string;
  episodic: string;
  activatedDetailText: string;
}

export function haystackToScanText(haystack: WorldbookActivationHaystack): string {
  return [
    haystack.title,
    haystack.synopsis,
    haystack.currentBody,
    haystack.userPrompt,
    haystack.previousChapters,
    haystack.storyMemory,
    haystack.outline,
    haystack.episodic,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function activateWorldbookDetail(
  rawSource: unknown,
  haystack: WorldbookActivationHaystack,
  options: {
    sourceOrder: number;
    sourceFingerprint?: string;
    recursive?: boolean;
  },
): {
  candidate: Omit<ResourceDetailCandidate, 'relevance' | 'explicitSelected'> | null;
  reason: ResourceDetailActivationReason | null;
} {
  const entry = parseWorldbookSourcePayload(rawSource);
  const keywords = listWorldbookKeywords(rawSource);
  const primary = keywords.slice(0, Math.max(1, Math.ceil(keywords.length / 2)));
  const secondary = keywords.slice(primary.length);
  const scan = haystackToScanText(haystack);

  let reason: ResourceDetailActivationReason | null = null;
  const primaryHit = primary.some(key => includesKey(scan, key));
  const secondaryHit = secondary.some(key => includesKey(scan, key));
  const entityHit = keywords.some(key =>
    includesKey(`${haystack.title}\n${haystack.synopsis}\n${haystack.userPrompt}\n${haystack.currentBody}`, key),
  );
  const storyHit = keywords.some(key =>
    includesKey(`${haystack.storyMemory}\n${haystack.episodic}`, key),
  );
  const recursiveHit =
    options.recursive !== false &&
    keywords.some(key => includesKey(haystack.activatedDetailText, key));

  if (primaryHit && secondaryHit) reason = 'primary_secondary_hit';
  else if (entry.constant && entityHit) reason = 'constant';
  else if (primaryHit) reason = 'primary_hit';
  else if (entityHit) reason = 'entity_hit';
  else if (recursiveHit) reason = 'recursive_hit';
  else if (storyHit) reason = 'story_memory_hit';
  else if (entry.constant) reason = 'constant';

  if (!reason) {
    return { candidate: null, reason: null };
  }

  const core = [
    entry.title && `【${entry.title}】`,
    entry.category && `分类：${entry.category}`,
    entry.content,
  ]
    .filter(Boolean)
    .join('\n');
  const content = wrapAsNovelData(core);
  const candidate: Omit<ResourceDetailCandidate, 'relevance' | 'explicitSelected'> = {
    id: `worldbook-detail:${entry.id}`,
    sourceKind: 'worldbook',
    sourceId: entry.id,
    title: entry.title,
    content,
    actualTokens: estimateTokens(content),
    activationReason: reason,
    sourceOrder: options.sourceOrder,
    sourceFingerprint: options.sourceFingerprint,
    clipTiers: [
      wrapAsNovelData([entry.title && `【${entry.title}】`, entry.content].filter(Boolean).join('\n')),
      content,
    ],
  };
  return { candidate, reason };
}

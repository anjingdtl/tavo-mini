import { clipTextToTokenBudget, estimateTokens } from '../../../utils/tokenEstimator';
import { clipCharacterDetailToBudget } from './characterDetailRenderer';
import type {
  FrozenResourceAwarenessItem,
  FrozenResourceDetailItem,
  GlobalAwarenessCandidate,
  ResourceDetailCandidate,
  ResourceSelectionTraceItem,
} from './resourceAwarenessTypes';

export function freezeAwarenessItems(
  items: GlobalAwarenessCandidate[],
): FrozenResourceAwarenessItem[] {
  return items.map(item => ({
    id: item.id,
    sourceKind: item.sourceKind,
    sourceId: item.sourceId,
    title: item.title,
    content: item.content,
    sourceFingerprint: item.sourceFingerprint,
    compilerVersion: item.compilerVersion,
    constraintClasses: item.constraintClasses,
    fallbackMode: item.fallbackMode,
    estimatedTokens: item.actualTokens,
    legacyCharacterFallback: item.legacyCharacterFallback,
  }));
}

export function allocateAndFreezeDetails(
  details: ResourceDetailCandidate[],
  grants: ReadonlyMap<string, number>,
): FrozenResourceDetailItem[] {
  return details.map(item => {
    const grant = grants.get(item.id) ?? 0;
    const rendered = renderDetailToGrant(item, grant);
    return {
      id: item.id,
      sourceKind: item.sourceKind,
      sourceId: item.sourceId,
      title: item.title,
      content: rendered.text,
      actualTokens: item.actualTokens,
      allocatedTokens: grant,
      activationReason: item.activationReason,
      sourceFingerprint: item.sourceFingerprint,
      clipped: rendered.clipped,
      relevance: item.relevance,
    };
  });
}

export function renderDetailToGrant(
  item: ResourceDetailCandidate,
  grant: number,
): { text: string; clipped: boolean } {
  if (grant <= 0) return { text: '', clipped: item.actualTokens > 0 };
  if (item.sourceKind === 'character') {
    return clipCharacterDetailToBudget(item, grant);
  }
  if (grant >= item.actualTokens) {
    return { text: item.content, clipped: false };
  }
  if (item.clipTiers && item.clipTiers.length > 0) {
    for (const tier of item.clipTiers) {
      if (estimateTokens(tier) <= grant) {
        return { text: tier, clipped: true };
      }
    }
  }
  return {
    text: clipTextToTokenBudget(item.content, grant),
    clipped: true,
  };
}

export function buildResourceSelectionTrace(input: {
  awareness: GlobalAwarenessCandidate[];
  details: ResourceDetailCandidate[];
  frozenDetails: FrozenResourceDetailItem[];
  includeResources: boolean;
  warnings?: string[];
}): ResourceSelectionTraceItem[] {
  if (!input.includeResources) {
    return [
      {
        id: 'resources:disabled',
        sourceKind: 'note',
        title: '资料上下文',
        mode: 'disabled',
        status: 'DISABLED',
        included: false,
        clipped: false,
        demandTokens: 0,
        allocatedTokens: 0,
        warning: '资料上下文已关闭：角色 / 世界书 / 笔记不会进入本次任务。预设仍生效。',
      },
    ];
  }
  const detailById = new Map(input.frozenDetails.map(item => [item.id, item]));
  const traces: ResourceSelectionTraceItem[] = input.awareness.map(item => {
    const detailId =
      item.sourceKind === 'character'
        ? `character-detail:${item.sourceId}`
        : `worldbook-detail:${item.sourceId}`;
    const detail = detailById.get(detailId);
    const detailAllocated = detail?.allocatedTokens || 0;
    const status =
      detailAllocated <= 0
        ? 'AWARENESS_ONLY'
        : detail?.clipped
          ? 'DETAIL_CLIPPED'
          : 'DETAIL_FULL';
    return {
      id: item.id,
      sourceKind: item.sourceKind,
      title: item.title,
      mode: 'global_awareness',
      status,
      included: true,
      clipped: false,
      demandTokens: item.actualTokens,
      allocatedTokens: item.actualTokens,
      activationReason: 'global_awareness',
      sourceFingerprint: item.sourceFingerprint,
      compilerVersion: item.compilerVersion,
    };
  });
  for (const item of input.details) {
    const frozen = detailById.get(item.id);
    traces.push({
      id: item.id,
      sourceKind: item.sourceKind,
      title: item.title,
      mode: 'detail',
      status:
        !frozen || frozen.allocatedTokens <= 0
          ? 'AWARENESS_ONLY'
          : frozen.clipped
            ? 'DETAIL_CLIPPED'
            : 'DETAIL_FULL',
      included: !!frozen && frozen.allocatedTokens > 0,
      clipped: !!frozen?.clipped,
      demandTokens: item.actualTokens,
      allocatedTokens: frozen?.allocatedTokens || 0,
      activationReason: item.activationReason,
      sourceFingerprint: item.sourceFingerprint,
    });
  }
  return traces;
}

export function projectCharacterText(
  awarenessText: string,
  detailItems: FrozenResourceDetailItem[],
): string {
  const details = detailItems
    .filter(item => item.sourceKind === 'character' && item.content)
    .map(item => item.content);
  return [awarenessText, ...details].filter(Boolean).join('\n\n');
}

export function projectWorldbookText(
  awarenessText: string,
  detailItems: FrozenResourceDetailItem[],
): string {
  const details = detailItems
    .filter(item => item.sourceKind === 'worldbook' && item.content)
    .map(item => item.content);
  return [awarenessText, ...details].filter(Boolean).join('\n\n');
}

export function projectNoteText(detailItems: FrozenResourceDetailItem[]): string {
  return detailItems
    .filter(item => item.sourceKind === 'note' && item.content)
    .map(item => item.content)
    .join('\n\n');
}

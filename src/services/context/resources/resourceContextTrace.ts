import type { ContextTraceItem } from '../../../types/contextTrace';
import type {
  FrozenPresetContext,
  FrozenResourceDetailItem,
  GlobalAwarenessCandidate,
  ResourceSelectionTraceItem,
} from './resourceAwarenessTypes';

export function buildPhase2ContextTrace(input: {
  preset: FrozenPresetContext;
  awareness: GlobalAwarenessCandidate[];
  details: FrozenResourceDetailItem[];
  selection: ResourceSelectionTraceItem[];
  includeResources: boolean;
  styleNotePresent?: boolean;
}): ContextTraceItem[] {
  const items: ContextTraceItem[] = [
    {
      kind: 'preset',
      sourceId: input.preset.presetId ?? null,
      title: input.preset.presetName,
      reason:
        input.preset.presetSource === 'default_runtime_baseline'
          ? '默认小说写作基线（未显式选择作家风格）'
          : `用户选择的作家风格｜fingerprint ${input.preset.sourceFingerprint.slice(0, 12)}`,
      estimatedTokens: input.preset.combinedText.length
        ? input.selection.find(item => item.mode === 'preset')?.allocatedTokens ||
          0
        : 0,
      included: true,
      clipped: false,
      preview: input.preset.combinedText.slice(0, 500),
      resourcePreviewStatus: 'DETAIL_FULL',
      sourceFingerprint: input.preset.sourceFingerprint,
    },
  ];

  if (input.styleNotePresent) {
    items[0].reason += '｜风格画像笔记仅作补充，不得覆盖本作家风格';
  }

  if (!input.includeResources) {
    items.push({
      kind: 'character',
      sourceId: null,
      title: '资料上下文已关闭',
      reason: '用户关闭了角色 / 世界书 / 笔记；全局感知未生成。作家风格仍生效。',
      estimatedTokens: 0,
      included: false,
      clipped: false,
      preview: '',
      empty: true,
      resourcePreviewStatus: 'DISABLED',
    });
    return items;
  }

  for (const item of input.awareness) {
    const selection = input.selection.find(row => row.id === item.id);
    items.push({
      kind: item.sourceKind,
      sourceId: item.sourceId,
      title: item.title,
      reason: item.legacyCharacterFallback
        ? '全局感知｜legacy_character_fallback'
        : `全局感知｜${item.fallbackMode}`,
      estimatedTokens: item.actualTokens,
      included: true,
      clipped: false,
      preview: item.content.slice(0, 500),
      demandTokens: item.actualTokens,
      allocatedTokens: item.actualTokens,
      resourcePreviewStatus: selection?.status || 'AWARENESS_ONLY',
      sourceFingerprint: item.sourceFingerprint,
      awarenessMode: 'global_awareness',
    });
  }

  for (const item of input.details) {
    items.push({
      kind: item.sourceKind,
      sourceId: item.sourceId,
      title: `${item.title}（详情）`,
      reason: item.allocatedTokens > 0
        ? `详情展开｜${item.activationReason}`
        : item.sourceKind === 'note'
          ? `详情未展开，未进入本次注入｜${item.activationReason}`
          : `详情未展开，全局感知已保留｜${item.activationReason}`,
      estimatedTokens: item.allocatedTokens || item.actualTokens,
      included: item.allocatedTokens > 0,
      clipped: item.clipped,
      preview: (item.content || '').slice(0, 500),
      demandTokens: item.actualTokens,
      allocatedTokens: item.allocatedTokens,
      resourcePreviewStatus:
        item.allocatedTokens <= 0
          ? item.sourceKind === 'note'
            ? 'NOT_SELECTED'
            : 'AWARENESS_ONLY'
          : item.clipped
            ? 'DETAIL_CLIPPED'
            : 'DETAIL_FULL',
      sourceFingerprint: item.sourceFingerprint,
      awarenessMode: 'detail',
    });
  }
  for (const item of input.selection.filter(row => row.mode === 'error')) {
    if (!item.warning) continue;
    items.push({
      kind: 'note',
      sourceId: item.sourceId ?? null,
      title: item.title,
      reason: `资料警告｜${item.warningCode || item.activationReason || 'unknown'}`,
      estimatedTokens: 0,
      included: false,
      clipped: false,
      preview: item.warning,
      empty: true,
      resourcePreviewStatus: 'ERROR',
      warning: item.warning,
      warningCode: item.warningCode,
      warningAction: item.warningAction,
    });
  }
  return items;
}

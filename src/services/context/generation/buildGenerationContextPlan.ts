import { estimateTokens } from '../../../utils/tokenEstimator';
import { sha256Hex } from '../../continuation/hashUtils';
import type {
  GenerationBudgetDemand,
  GenerationContextPlan,
  GenerationMaterialCandidate,
  NormalizedGenerationMaterials,
} from './generationContracts';

function safeJson(value: unknown): Record<string, any> {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function legacyCharacterContent(raw: any): string {
  const data = safeJson(raw.data_json);
  const card = data.data || data;
  const name = raw.name || card.name || '未命名角色';
  return [
    `角色「${name}」`,
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
}

function legacyResourceCandidates(
  normalized: NormalizedGenerationMaterials,
): GenerationMaterialCandidate[] {
  const sources = normalized.resourceSources;
  if (!sources) return [];
  const candidates: GenerationMaterialCandidate[] = [];
  const push = (candidate: GenerationMaterialCandidate) => {
    if (!candidates.some(item => item.candidateId === candidate.candidateId)) {
      candidates.push(candidate);
    }
  };
  (sources.characters || []).forEach((raw: any, index) => {
    const content = legacyCharacterContent(raw);
    push(
      toCandidate(
        {
          candidateId: `character:${raw.id ?? index}`,
          sourceType: 'character',
          sourceId: raw.id ?? null,
          content,
          activation: 'explicit',
          requirement: 'preferred',
          selected: Boolean(content),
          selectedReason: content ? 'project_character' : null,
          priority: 7,
          relevance: 1,
          selectionBoost: 1,
          demandTokens: estimateTokens(content),
        },
        candidates.length,
      ),
    );
  });
  if (String((sources.noteConfig as any)?.mode || 'none') !== 'none') {
    (sources.notes || []).forEach((raw: any, index) => {
      const content = `笔记「${raw.title || '无标题'}」：${
        sources.noteContents?.[Number(raw.id)] || ''
      }`;
      push(
        toCandidate(
          {
            candidateId: `note:${raw.id ?? index}`,
            sourceType: 'note',
            sourceId: raw.id ?? null,
            content,
            activation: 'automatic',
            requirement: 'optional',
            selected: Boolean(content.trim()),
            selectedReason: content.trim() ? 'note_mode_enabled' : null,
            priority: 4,
            relevance: 0.7,
            selectionBoost: 1,
            demandTokens: estimateTokens(content),
          },
          candidates.length,
        ),
      );
    });
  }
  (sources.worldbookEntries || []).forEach((raw: any, index) => {
    const content = String(raw.content || '');
    push(
      toCandidate(
        {
          candidateId: `worldbook:${raw.id ?? index}`,
          sourceType: 'worldbook',
          sourceId: raw.id ?? null,
          content,
          activation: raw.constant ? 'explicit' : 'automatic',
          requirement: raw.constant ? 'preferred' : 'optional',
          selected: Boolean(content),
          selectedReason: content ? 'source_captured' : null,
          priority: raw.constant ? 8 : 3,
          relevance: raw.constant ? 1 : 0.6,
          selectionBoost: raw.constant ? 1.5 : 1,
          demandTokens: estimateTokens(content),
        },
        candidates.length,
      ),
    );
  });
  return candidates;
}

function preparedResourceCandidates(
  normalized: NormalizedGenerationMaterials,
): GenerationMaterialCandidate[] {
  const preparation = normalized.resourcePreparation;
  const candidates: GenerationMaterialCandidate[] = [];
  const push = (candidate: GenerationMaterialCandidate) => {
    if (!candidates.some(item => item.candidateId === candidate.candidateId)) {
      candidates.push(candidate);
    }
  };
  preparation?.v3ResourceCandidates?.forEach((raw, index) => {
    push(
      toCandidate(
        {
          candidateId: raw.id,
          sourceType: raw.sourceKind,
          sourceId: raw.sourceId,
          content: raw.content,
          activation: raw.explicitSelected ? 'explicit' : 'automatic',
          requirement: raw.explicitSelected ? 'preferred' : 'optional',
          selected: raw.activated,
          selectedReason: raw.activationReason || (raw.activated ? 'activated' : null),
          rejectedReason: raw.activated ? null : 'not_activated',
          relevance: raw.retrievalScore ?? (raw.activated ? 1 : 0),
          priority: raw.explicitSelected ? 7 : 3,
          selectionBoost: raw.explicitSelected ? 1.5 : 1,
          demandTokens: raw.actualTokens,
        },
        index,
      ),
    );
  });
  preparation?.v7Resources?.awareness.forEach((raw, index) => {
    push(
      toCandidate(
        {
          candidateId: raw.id,
          sourceType: raw.sourceKind,
          sourceId: raw.sourceId,
          content: raw.content,
          activation: 'mandatory',
          requirement: 'mandatory',
          selected: true,
          selectedReason: raw.fallbackMode || 'protected_awareness',
          priority: 10,
          relevance: 1,
          selectionBoost: 1,
          demandTokens: raw.actualTokens,
        },
        index,
      ),
    );
  });
  preparation?.v7Resources?.details.forEach((raw, index) => {
    push(
      toCandidate(
        {
          candidateId: raw.id,
          sourceType: raw.sourceKind,
          sourceId: raw.sourceId,
          content: raw.content,
          activation: raw.explicitSelected ? 'explicit' : 'automatic',
          requirement: raw.explicitSelected ? 'preferred' : 'optional',
          selected: true,
          selectedReason: raw.activationReason || 'detail_activated',
          relevance: raw.relevance,
          priority: raw.explicitSelected ? 8 : 4,
          selectionBoost: raw.explicitSelected ? 1.5 : 1,
          demandTokens: raw.actualTokens,
        },
        index,
      ),
    );
  });
  return candidates;
}

function contentHash(text: string): string {
  return sha256Hex(text);
}

function toCandidate(
  candidate: Partial<GenerationMaterialCandidate> & {
    candidateId: string;
    sourceType: GenerationMaterialCandidate['sourceType'];
    content?: string;
  },
  sourceOrder: number,
): GenerationMaterialCandidate {
  const content = String(candidate.content ?? '');
  const selected = Boolean(candidate.selected ?? content);
  return {
    candidateId: candidate.candidateId,
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId ?? null,
    sourceRevision: candidate.sourceRevision ?? null,
    contentHash: candidate.contentHash || contentHash(content),
    activation: candidate.activation ?? 'automatic',
    selected,
    selectedReason:
      candidate.selectedReason ?? (selected ? 'content_available' : null),
    rejectedReason: candidate.rejectedReason ?? null,
    requirement: candidate.requirement ?? 'optional',
    relevance: candidate.relevance ?? null,
    priority: candidate.priority ?? null,
    selectionBoost: candidate.selectionBoost ?? null,
    demandTokens: Math.max(
      0,
      Math.floor(Number(candidate.demandTokens) || estimateTokens(content)),
    ),
    content,
    sourceOrder,
  };
}

function addDemand(candidate: GenerationMaterialCandidate): GenerationBudgetDemand {
  const demandTokens = Math.max(0, Math.floor(candidate.demandTokens));
  const requirement = candidate.requirement;
  return {
    candidateId: candidate.candidateId,
    demandTokens,
    minTokens: requirement === 'mandatory' ? demandTokens : 0,
    targetTokens: demandTokens,
    maxTokens: demandTokens,
    priority: Math.max(0, Number(candidate.priority ?? 1) || 0),
    relevance: Math.min(1, Math.max(0, Number(candidate.relevance ?? 1) || 0)),
    requirement,
    selectionBoost: Math.max(0.01, Number(candidate.selectionBoost ?? 1) || 1),
  };
}

/**
 * Build is the pure decision stage. It converts normalized source facts into
 * an explicit candidate set and demand plan; it never clips text or calls a
 * budget allocator.
 */
export function buildGenerationContextPlan(input: {
  normalized: NormalizedGenerationMaterials;
}): GenerationContextPlan {
  const { normalized } = input;
  const candidates: GenerationMaterialCandidate[] = [];
  const push = (candidate: GenerationMaterialCandidate) => {
    if (!candidates.some(existing => existing.candidateId === candidate.candidateId)) {
      candidates.push(candidate);
    }
  };

  const outlineText = String(normalized.preOutlineContext?.text || '');
  if (outlineText) {
    push(
      toCandidate(
        {
          candidateId: 'outline:project',
          sourceType: 'outline',
          sourceId: normalized.projectId,
          content: outlineText,
          activation: 'mandatory',
          requirement: 'mandatory',
          selected: true,
          selectedReason: 'outline_is_mandatory',
          demandTokens: normalized.preOutlineContext.estimatedTokens,
          priority: 10,
          relevance: 1,
        },
        candidates.length,
      ),
    );
  }

  const presetText =
    typeof normalized.preset === 'string'
      ? normalized.preset
      : normalized.preset
        ? [
            (normalized.preset as any).system_prompt,
            (normalized.preset as any).writing_style &&
              `写作风格：${(normalized.preset as any).writing_style}`,
            (normalized.preset as any).extra_instructions &&
              `附加要求：${(normalized.preset as any).extra_instructions}`,
          ]
            .filter(Boolean)
            .join('\n\n')
        : '';
  if (presetText) {
    push(
      toCandidate(
        {
          candidateId: 'preset:system',
          sourceType: 'preset',
          sourceId: typeof normalized.preset === 'string' ? null : (normalized.preset as any).id ?? null,
          content: presetText,
          activation: 'system',
          requirement: 'mandatory',
          selected: true,
          selectedReason: 'system_prompt',
          priority: 10,
          relevance: 1,
        },
        candidates.length,
      ),
    );
  }

  const storyMemoryText = String(normalized.storyMemoryText || '');
  if (storyMemoryText) {
    push(
      toCandidate(
        {
          candidateId: `story_memory:${normalized.projectId}`,
          sourceType: 'story_memory',
          sourceId: normalized.projectId,
          content: storyMemoryText,
          activation: 'automatic',
          requirement: 'preferred',
          demandTokens: estimateTokens(storyMemoryText),
          priority: 8,
          relevance: 0.9,
        },
        candidates.length,
      ),
    );
  }

  [
    ...legacyResourceCandidates(normalized),
    ...preparedResourceCandidates(normalized),
    ...normalized.resourceCandidates,
  ].forEach(candidate => push({ ...candidate }));
  normalized.episodicCandidates.forEach(chapter => {
    const content = String(chapter.memory_summary || chapter.content || '');
    push(
      toCandidate(
        {
          candidateId: `episodic_memory:${chapter.id ?? chapter.position}`,
          sourceType: 'episodic_memory',
          sourceId: chapter.id ?? chapter.position,
          sourceRevision: String(chapter.updated_at ?? ''),
          content,
          activation: 'automatic',
          requirement: 'optional',
          demandTokens: estimateTokens(content),
          priority: 4,
          relevance: 0.7,
        },
        candidates.length,
      ),
    );
  });

  const instruction = `${normalized.currentChapter.title || ''}\n${
    normalized.currentChapter.synopsis || ''
  }`;
  push(
    toCandidate(
      {
        candidateId: `chapter:current:${normalized.currentChapter.id ?? normalized.currentChapter.position}`,
        sourceType: 'chapter',
        sourceId: normalized.currentChapter.id ?? normalized.currentChapter.position,
        content: instruction,
        activation: 'system',
        requirement: 'mandatory',
        selected: true,
        selectedReason: 'current_instruction',
        priority: 10,
        relevance: 1,
      },
      candidates.length,
    ),
  );

  const rejectedCandidates = [...normalized.rejectedCandidates];
  const demands = candidates.map(addDemand);
  return { version: 1, candidates, rejectedCandidates, demands };
}

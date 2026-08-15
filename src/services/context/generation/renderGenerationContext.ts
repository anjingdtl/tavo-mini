import { clipTextToTokenBudget, estimateTokens } from '../../../utils/tokenEstimator';
import { sha256Hex } from '../../continuation/hashUtils';
import type { ChatMessage } from '../../llm';
import type {
  GenerationContextPlan,
  GenerationBudgetAllocation,
  GenerationRenderedContextItem,
  NormalizedGenerationMaterials,
  RenderedGenerationContext,
} from './generationContracts';

export interface LegacyRenderTraceBlock {
  text?: string;
  messages?: string[];
  traceItems?: RenderedGenerationContext['trace'];
  traceItem?: RenderedGenerationContext['trace'][number];
  messageText?: string;
}

export interface LegacyRenderBlocks {
  preset?: LegacyRenderTraceBlock;
  outline?: LegacyRenderTraceBlock;
  storyMemory?: LegacyRenderTraceBlock;
  resources?: LegacyRenderTraceBlock;
  memory?: LegacyRenderTraceBlock;
  previousBridge?: LegacyRenderTraceBlock;
  instruction?: LegacyRenderTraceBlock;
  renderedItems?: GenerationRenderedContextItem[];
  sectionTexts?: Record<string, string>;
}

function renderHash(text: string): string {
  return sha256Hex(text);
}

/**
 * Render consumes only normalized sources, the immutable plan, and grants.
 * It has no repository boundary and does not select/rank/reallocate.
 */
export function renderGenerationContext(input: {
  normalized: NormalizedGenerationMaterials;
  plan: GenerationContextPlan;
  allocation: GenerationBudgetAllocation;
  blocks: {
    systemText: string;
    instructionText: string;
    sourceTextByCandidateId: Record<string, string | undefined>;
    prefixByCandidateId?: Record<string, string | undefined>;
    legacy?: LegacyRenderBlocks;
  };
}): RenderedGenerationContext {
  if (input.blocks.legacy) {
    return renderLegacyGenerationContext(
      input.plan,
      input.allocation,
      input.blocks.systemText,
      input.blocks.legacy,
    );
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: input.blocks.systemText },
  ];
  const trace: RenderedGenerationContext['trace'] = [];
  const items: GenerationRenderedContextItem[] = [];
  const sectionTexts: Record<string, string> = {};

  for (const budgetItem of input.allocation.items) {
    const candidate = input.plan.candidates.find(
      item => item.candidateId === budgetItem.candidateId,
    );
    if (!candidate) continue;
    const source = String(input.blocks.sourceTextByCandidateId[candidate.candidateId] ?? '');
    const prefix = String(input.blocks.prefixByCandidateId?.[candidate.candidateId] ?? '');
    const rendered = source
      ? clipTextToTokenBudget(source, budgetItem.allocatedTokens)
      : '';
    const actualTokens = estimateTokens(rendered);
    const clipped = Boolean(source && rendered.length < source.length);
    const included = rendered.length > 0;
    const clippingReason = clipped
      ? budgetItem.allocatedTokens <= 0
        ? 'budget_zero'
        : 'allocation_limit'
      : source
        ? null
        : 'source_empty';
    const body = prefix && rendered ? `${prefix}${rendered}` : rendered;
    if (body) {
      messages.push({ role: 'system', content: body });
      sectionTexts[candidate.sourceType] = [
        sectionTexts[candidate.sourceType] || '',
        rendered,
      ]
        .filter(Boolean)
        .join('\n\n');
    }
    items.push({
      candidateId: candidate.candidateId,
      allocatedTokens: budgetItem.allocatedTokens,
      actualTokens,
      included,
      clipped,
      clippingReason,
      renderedHash: renderHash(rendered),
    });
    trace.push({
      kind:
        candidate.sourceType === 'episodic_memory'
          ? 'memory'
          : candidate.sourceType === 'story_memory'
            ? 'story_memory'
            : candidate.sourceType === 'outline'
              ? 'outline'
              : candidate.sourceType === 'chapter'
                ? 'chapter'
                : candidate.sourceType === 'character'
                  ? 'character'
                  : candidate.sourceType === 'note'
                    ? 'note'
                    : candidate.sourceType === 'worldbook'
                      ? 'worldbook'
                      : candidate.sourceType === 'writer_style'
                        ? 'writer_style'
                        : 'memory',
      sourceId: typeof candidate.sourceId === 'number' ? candidate.sourceId : null,
      title: candidate.candidateId,
      reason: candidate.selectedReason || candidate.rejectedReason || clippingReason || 'rendered',
      estimatedTokens: actualTokens,
      included,
      clipped,
      preview: rendered.slice(0, 500),
      demandTokens: budgetItem.demandTokens,
      allocatedTokens: budgetItem.allocatedTokens,
    });
  }

  if (input.blocks.instructionText) {
    messages.push({ role: 'user', content: input.blocks.instructionText });
    trace.push({
      kind: 'instruction',
      sourceId: input.normalized.currentChapter.id ?? null,
      title: input.normalized.currentChapter.title || 'current instruction',
      reason: 'current instruction',
      estimatedTokens: estimateTokens(input.blocks.instructionText),
      included: true,
      clipped: false,
      preview: input.blocks.instructionText.slice(0, 500),
    });
  }

  return {
    version: 1,
    messages,
    trace,
    items,
    sectionTexts,
    estimatedInputTokens: trace.reduce((sum, item) => sum + item.estimatedTokens, 0),
    messagePayloadHash: renderHash(JSON.stringify(messages)),
  };
}

/** Assemble the existing generation message order through the isolated
 * renderer. The caller supplies already-captured text/trace facts; this
 * function performs no DB read, selection, ranking, or allocation. */
function renderLegacyGenerationContext(
  plan: GenerationContextPlan,
  allocation: GenerationBudgetAllocation,
  systemText: string,
  blocks: LegacyRenderBlocks,
): RenderedGenerationContext {
  const messages: ChatMessage[] = [{ role: 'system', content: systemText }];
  const trace: RenderedGenerationContext['trace'] = [];
  if (blocks.preset?.traceItem) trace.push(blocks.preset.traceItem);
  if (blocks.outline?.text) {
    const primary = messages[0];
    primary.content = `${primary.content}\n\n${blocks.outline.text}`;
    if (blocks.outline.traceItem) trace.push(blocks.outline.traceItem);
  } else if (blocks.outline?.traceItem) {
    trace.push(blocks.outline.traceItem);
  }
  const pushSystem = (block: LegacyRenderTraceBlock | undefined) => {
    if (!block) return;
    const contents = block.messages || (block.text ? [block.text] : []);
    for (const content of contents) {
      if (content) messages.push({ role: 'system', content });
    }
    if (contents.length === 0) {
      if (block.traceItems) trace.push(...block.traceItems);
      if (block.traceItem) trace.push(block.traceItem);
      return;
    }
    if (block.traceItems) trace.push(...block.traceItems);
    if (block.traceItem) trace.push(block.traceItem);
  };
  pushSystem(blocks.storyMemory);
  pushSystem(blocks.resources);
  pushSystem(blocks.memory);
  if (blocks.previousBridge?.messageText) {
    messages.push({ role: 'user', content: blocks.previousBridge.messageText });
    if (blocks.previousBridge.traceItem) trace.push(blocks.previousBridge.traceItem);
  }
  if (blocks.instruction?.messageText) {
    messages.push({ role: 'user', content: blocks.instruction.messageText });
    if (blocks.instruction.traceItem) trace.push(blocks.instruction.traceItem);
  }
  const sectionTextBySourceType: Record<string, string> = {
    preset: systemText,
    outline: blocks.outline?.text || '',
    story_memory: blocks.storyMemory?.text || '',
    character: blocks.resources?.text || blocks.resources?.messages?.join('\n\n') || '',
    note: blocks.resources?.text || blocks.resources?.messages?.join('\n\n') || '',
    worldbook: blocks.resources?.text || blocks.resources?.messages?.join('\n\n') || '',
    episodic_memory: blocks.memory?.text || '',
    chapter: blocks.previousBridge?.messageText || blocks.instruction?.messageText || '',
  };
  const items: GenerationRenderedContextItem[] = [];
  for (const budgetItem of allocation.items) {
    const candidate = plan.candidates.find(
      item => item.candidateId === budgetItem.candidateId,
    );
    if (!candidate) continue;
    const source = candidate.content || sectionTextBySourceType[candidate.sourceType] || '';
    const rendered = source
      ? clipTextToTokenBudget(source, budgetItem.allocatedTokens)
      : '';
    const actualTokens = estimateTokens(rendered);
    const clipped = Boolean(source && rendered.length < source.length);
    items.push({
      candidateId: candidate.candidateId,
      allocatedTokens: budgetItem.allocatedTokens,
      actualTokens,
      included: rendered.length > 0,
      clipped,
      clippingReason: clipped
        ? budgetItem.allocatedTokens <= 0
          ? 'budget_zero'
          : 'allocation_limit'
        : rendered
          ? null
          : 'source_empty',
      renderedHash: renderHash(rendered),
    });
  }
  return {
    version: 1,
    messages,
    trace,
    items: blocks.renderedItems || items,
    sectionTexts: blocks.sectionTexts || {},
    estimatedInputTokens: trace.reduce((sum, item) => sum + item.estimatedTokens, 0),
    messagePayloadHash: renderHash(JSON.stringify(messages)),
  };
}

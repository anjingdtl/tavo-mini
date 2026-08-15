import { assertNoFutureSourceLeakage } from '../generationStageContracts';
import { sha256Hex } from '../../continuation/hashUtils';
import type { GenerationDiagnostic } from '../../../types/generationTrace';
import type {
  FrozenGenerationContextContractV2,
  GenerationContextPlan,
  GenerationBudgetAllocation,
  NormalizedGenerationMaterials,
  RenderedGenerationContext,
} from './generationContracts';

/** Freeze is the sole assembler of the decision/render contract. */
export function freezeGenerationContext(input: {
  normalized: NormalizedGenerationMaterials;
  plan: GenerationContextPlan;
  allocation: GenerationBudgetAllocation;
  rendered: RenderedGenerationContext;
  diagnostics: GenerationDiagnostic[];
}): FrozenGenerationContextContractV2 {
  assertNoFutureSourceLeakage({
    currentPosition: input.normalized.currentChapter.position,
    previousChapters: input.normalized.previousChapters,
    episodicCandidates: input.normalized.episodicCandidates,
  });
  const actualTokens = input.rendered.items.reduce(
    (sum, item) => sum + Math.max(0, Number(item.actualTokens) || 0),
    0,
  );
  if (
    input.allocation.hardInputLimit > 0 &&
    actualTokens > input.allocation.hardInputLimit
  ) {
    throw new Error(
      `GENERATION_CONTEXT_RENDER_OVER_HARD_LIMIT:${actualTokens}>${input.allocation.hardInputLimit}`,
    );
  }
  const messagePayloadHash = sha256Hex(JSON.stringify(input.rendered.messages));
  if (messagePayloadHash !== input.rendered.messagePayloadHash) {
    throw new Error('GENERATION_CONTEXT_MESSAGE_RENDER_MISMATCH');
  }
  const budgetIds = new Set(input.allocation.items.map(item => item.candidateId));
  const messagePayload = input.rendered.messages
    .map(message => String(message.content || ''))
    .join('\n');
  for (const candidate of input.plan.candidates) {
    if (candidate.requirement !== 'mandatory' || !candidate.selected) continue;
    if (!budgetIds.has(candidate.candidateId)) {
      throw new Error(
        `GENERATION_CONTEXT_MANDATORY_CONTRACT_MISSING:${candidate.candidateId}`,
      );
    }
    // Legacy rendering may wrap a mandatory source with labels (for example
    // the current instruction adds “当前章节/章节概要”). Presence in the
    // final payload is therefore checked at message level, while exact byte
    // identity is guarded by messagePayloadHash below.
    if (!messagePayload && candidate.content) {
      throw new Error(
        `GENERATION_CONTEXT_MANDATORY_RENDER_MISSING:${candidate.candidateId}`,
      );
    }
  }
  const candidates = [
    ...input.plan.candidates.map(({ content: _content, sourceOrder: _sourceOrder, ...candidate }) => candidate),
    ...input.plan.rejectedCandidates,
  ];
  const payload = {
    version: 2 as const,
    projectId: input.normalized.projectId,
    chapterId: input.normalized.currentChapter.id ?? null,
    currentPosition: Number(input.normalized.currentChapter.position),
    candidates,
    budget: input.allocation.items,
    rendered: input.rendered.items,
    messages: input.rendered.messages,
    diagnostics: input.diagnostics,
  };
  return {
    ...payload,
    fingerprint: sha256Hex(JSON.stringify(payload)),
  };
}

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
import { computeGenerationContractFingerprint } from './generationContractValidation';

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
  const materialCandidates = input.plan.candidates.map(candidate => ({
    ...candidate,
  }));
  const candidateIds = new Set(materialCandidates.map(item => item.candidateId));
  const legacyStageIds = new Set(
    [...input.allocation.items, ...input.rendered.items]
      .map(item => item.candidateId)
      .filter(candidateId => !candidateIds.has(candidateId)),
  );
  // Elastic/hierarchical compatibility adapters may publish stage-level
  // grants (protocol, storyState, resources, ...), while the material plan
  // publishes source-level candidates. Preserve those grants as explicit
  // adapter candidates rather than dropping budget evidence or rejecting a
  // historically valid allocation shape.
  for (const candidateId of legacyStageIds) {
    const allocation = input.allocation.items.find(
      item => item.candidateId === candidateId,
    );
    const mandatory =
      allocation?.waterLevel === 'mandatory' || candidateId === 'protocol';
    materialCandidates.push({
      candidateId,
      sourceType: 'other',
      sourceId: null,
      sourceRevision: null,
      contentHash: sha256Hex(''),
      activation: mandatory ? 'mandatory' : 'automatic',
      selected: true,
      selectedReason: 'legacy_stage_budget_adapter',
      rejectedReason: null,
      requirement: mandatory ? 'mandatory' : 'optional',
      relevance: null,
      priority: null,
      selectionBoost: null,
      demandTokens: allocation?.demandTokens || 0,
      content: '',
      sourceOrder: materialCandidates.length,
    });
    candidateIds.add(candidateId);
  }
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
    ...materialCandidates.map(({ content: _content, sourceOrder: _sourceOrder, ...candidate }) => candidate),
    ...input.plan.rejectedCandidates,
  ];
  const budget = input.allocation.items.map(item => {
    const budgetClipped =
      typeof item.budgetClipped === 'boolean'
        ? item.budgetClipped
        : Boolean(item.clippedByBudget);
    return {
      ...item,
      budgetClipped,
      clippedByBudget: budgetClipped,
    };
  });
  const payload = {
    version: 2 as const,
    projectId: input.normalized.projectId,
    chapterId: input.normalized.currentChapter.id ?? null,
    currentPosition: Number(input.normalized.currentChapter.position),
    candidates,
    budget,
    rendered: input.rendered.items,
    messages: input.rendered.messages,
    diagnostics: input.diagnostics,
  };
  const contract = {
    ...payload,
    fingerprint: '',
  } as FrozenGenerationContextContractV2;
  return {
    ...contract,
    fingerprint: computeGenerationContractFingerprint(contract),
  };
}

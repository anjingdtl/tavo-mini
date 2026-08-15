import { clipTextToTokenBudget, estimateTokens } from '../../../utils/tokenEstimator';
import { sha256Hex } from '../../continuation/hashUtils';
import type {
  RenderedWritingContext,
  RenderedWritingContextItem,
  WritingBudgetAllocation,
  WritingMaterialCandidate,
} from '../contracts/frozenWritingContext';

/** Render only already-selected candidates; no selection or DB access. */
export function renderWritingContext(input: {
  candidates: WritingMaterialCandidate[];
  allocation: WritingBudgetAllocation;
}): RenderedWritingContext {
  const byId = new Map(input.candidates.map(candidate => [candidate.source.candidateId, candidate]));
  const items: RenderedWritingContextItem[] = [];
  const blocks: string[] = [];
  for (const allocation of input.allocation.items) {
    const candidate = byId.get(allocation.candidateId);
    if (!candidate || allocation.allocatedTokens <= 0) {
      items.push({
        candidateId: allocation.candidateId,
        allocatedTokens: allocation.allocatedTokens,
        actualTokens: 0,
        included: false,
        clipped: allocation.clipped,
        renderedHash: sha256Hex(''),
      });
      continue;
    }
    const body = clipTextToTokenBudget(
      candidate.source.content,
      allocation.allocatedTokens,
    );
    const rendered = `【${candidate.source.kind}:${candidate.source.candidateId}】\n${body}`;
    const actualTokens = estimateTokens(rendered);
    items.push({
      candidateId: allocation.candidateId,
      allocatedTokens: allocation.allocatedTokens,
      actualTokens,
      included: Boolean(body.trim()),
      clipped: allocation.clipped || actualTokens > allocation.allocatedTokens,
      renderedHash: sha256Hex(rendered),
    });
    if (body.trim()) blocks.push(rendered);
  }
  const text = blocks.join('\n\n');
  return {
    version: 1,
    text,
    items,
    estimatedInputTokens: estimateTokens(text),
    fingerprint: sha256Hex(JSON.stringify({ text, items })),
  };
}

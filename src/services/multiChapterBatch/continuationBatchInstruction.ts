/**
 * Continuation batch per-chapter instruction builder (doc §8, §11).
 *
 * P0 invariant — Future Plan Leakage = 0:
 * the instruction handed to startContinuationRun().userInstruction contains
 * ONLY the current chapter's plan projection (title / synopsis / keyBeats /
 * carryIn / carryOut / targetWords) plus the batch-level goal. Details of
 * later chapters (their titles, synopses, beats, carryOut) must never be
 * concatenated into this string. The unit test
 * `continuationBatchFutureLeakage.test.ts` enforces this by construction.
 */
import type { MultiChapterBatchRow } from '../../data/repositories/multiChapterBatchRepository';
import type { MultiChapterBatchItemRow } from '../../data/repositories/multiChapterBatchRepository';

export function parseItemKeyBeats(keyBeatsJson: string | null): string[] {
  try {
    const parsed = JSON.parse(keyBeatsJson || '[]');
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Build the single-chapter writing instruction for a continuation batch item.
 * Never receives the sibling items — the signature makes future-item leakage
 * structurally impossible.
 */
export function buildContinuationBatchChapterInstruction(
  batch: Pick<MultiChapterBatchRow, 'sourcePrompt' | 'writingMode'>,
  currentItem: Pick<
    MultiChapterBatchItemRow,
    'ordinal' | 'title' | 'synopsis' | 'keyBeatsJson' | 'carryIn' | 'carryOut' | 'targetWords'
  >,
): string {
  const beats = parseItemKeyBeats(currentItem.keyBeatsJson);
  const parts: string[] = [];
  if (batch.sourcePrompt) {
    parts.push(`【本批续写目标】\n${batch.sourcePrompt}`);
  }
  parts.push(`【本章标题】\n${currentItem.title || `第 ${currentItem.ordinal} 章`}`);
  if (currentItem.synopsis) {
    parts.push(`【本章梗概】\n${currentItem.synopsis}`);
  }
  if (beats.length > 0) {
    parts.push(`【必须发生】\n${beats.map(b => `- ${b}`).join('\n')}`);
  }
  if (currentItem.carryIn) {
    parts.push(`【承接前文】\n${currentItem.carryIn}`);
  }
  if (currentItem.carryOut) {
    parts.push(`【交给下一章】\n${currentItem.carryOut}`);
  }
  parts.push(`【目标字数】\n约 ${currentItem.targetWords} 字`);
  return parts.join('\n\n');
}

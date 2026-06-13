import type { GenerationDraft, DraftSource, DraftTargetType } from '../types/draft';
import {
  createGenerationDraft,
  getGenerationDrafts,
  deleteGenerationDraft,
  deleteGenerationDraftsByTarget,
} from './database';
import { estimateTokens } from '../utils/tokenEstimator';

export async function saveDraft(input: {
  projectId: number;
  targetType: DraftTargetType;
  targetId: number;
  content: string;
  source: DraftSource;
  pipelineTaskId?: string | null;
}): Promise<number> {
  const tokenCount = estimateTokens(input.content);
  return createGenerationDraft({
    projectId: input.projectId,
    targetType: input.targetType,
    targetId: input.targetId,
    content: input.content,
    source: input.source,
    pipelineTaskId: input.pipelineTaskId ?? null,
    tokenCount,
  });
}

export async function getDrafts(
  targetType: DraftTargetType,
  targetId: number,
): Promise<GenerationDraft[]> {
  return getGenerationDrafts(targetType, targetId);
}

export async function removeDraft(id: number): Promise<void> {
  return deleteGenerationDraft(id);
}

export async function clearDrafts(
  targetType: DraftTargetType,
  targetId: number,
): Promise<void> {
  return deleteGenerationDraftsByTarget(targetType, targetId);
}

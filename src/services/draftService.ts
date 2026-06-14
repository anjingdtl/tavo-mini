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
  // getGenerationDrafts returns raw rows with snake_case columns
  // (project_id, target_type, token_count, created_at, ...). The
  // GenerationDraft type contract is camelCase, so map explicitly. Without
  // this, the draft list crashed with
  // "Cannot read property 'toLocaleString' of undefined" because
  // item.tokenCount was undefined even though token_count was set in SQLite.
  const rows = await getGenerationDrafts(targetType, targetId);
  return rows.map((r: any) => ({
    id: r.id,
    projectId: r.project_id,
    targetType: r.target_type,
    targetId: r.target_id,
    content: r.content ?? '',
    source: r.source,
    pipelineTaskId: r.pipeline_task_id ?? null,
    tokenCount: typeof r.token_count === 'number' ? r.token_count : 0,
    createdAt: r.created_at,
  }));
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

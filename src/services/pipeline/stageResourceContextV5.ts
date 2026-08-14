/**
 * V5 stage context adapter. Writer Style text comes only from the frozen
 * snapshot; this module deliberately has no project/database seam.
 */
import type {
  FactCheckContext,
  PipelineContextSnapshot,
  ProofConstraints,
  ReviewContext,
} from '../../types/pipelineContext';
import type { FrozenWriterStyleProjection } from '../writerStyle/types';

function projection(
  snapshot: PipelineContextSnapshot,
  stage: 'draft' | 'review' | 'factCheck' | 'brief' | 'proof',
): FrozenWriterStyleProjection {
  const result = snapshot.writerStyleSnapshot?.stageProjections[stage];
  if (!result) {
    throw new Error('WRITER_STYLE_SOURCE_READ_FAILED：Snapshot V5 缺少冻结的 Stage Projection。');
  }
  return result;
}

function details(
  snapshot: PipelineContextSnapshot,
  kind: 'character' | 'worldbook' | 'note',
): string {
  return (snapshot.resourceDetailItems || [])
    .filter(item => item.sourceKind === kind && item.content)
    .map(item => item.content)
    .join('\n\n');
}

export function assertWriterStyleProjectionFits(
  snapshot: PipelineContextSnapshot,
  stage: 'draft' | 'review' | 'factCheck' | 'brief' | 'proof',
  hardInputLimit: number,
): void {
  const item = projection(snapshot, stage);
  if (item.estimatedTokens > hardInputLimit) {
    const error = new Error(
      `WRITER_STYLE_OVER_BUDGET：${stage} 作家风格需要 ${item.estimatedTokens} Token，但 Protected 输入上限为 ${hardInputLimit}。`,
    );
    (error as Error & { code?: string }).code = 'WRITER_STYLE_OVER_BUDGET';
    throw error;
  }
}

export function buildReviewContextFromSnapshotV5(
  snapshot: PipelineContextSnapshot,
): ReviewContext {
  return {
    presetText: projection(snapshot, 'review').text,
    characterText: details(snapshot, 'character'),
    worldbookText: details(snapshot, 'worldbook'),
    noteText: details(snapshot, 'note'),
    characterAwarenessText: snapshot.characterAwarenessText || '',
    worldbookAwarenessText: snapshot.worldbookAwarenessText || '',
    storyMemoryText: snapshot.storyMemoryText,
    episodicMemoryText: snapshot.episodicMemoryText,
    recentBridgeText: snapshot.recentBridgeText,
    currentInstructionText: snapshot.currentInstructionText,
    retrievalUserPrompt: snapshot.retrievalUserPrompt,
    outlineText: snapshot.outlineText,
    immediatePreviousChapterText: snapshot.immediatePreviousChapterText || '',
    immediatePreviousChapterEnding: snapshot.immediatePreviousChapterEnding || '',
    writerStyleProtectedTokens: projection(snapshot, 'review').estimatedTokens,
    writerStyleProjectionMode: projection(snapshot, 'review').mode,
  };
}

export function buildFactCheckContextFromSnapshotV5(
  snapshot: PipelineContextSnapshot,
): FactCheckContext {
  return {
    presetText: projection(snapshot, 'factCheck').text,
    currentInstructionText: snapshot.currentInstructionText,
    retrievalUserPrompt: snapshot.retrievalUserPrompt,
    recentBridgeText: snapshot.recentBridgeText,
    storyMemoryText: snapshot.storyMemoryText,
    episodicMemoryText: snapshot.episodicMemoryText,
    worldbookText: details(snapshot, 'worldbook'),
    characterText: details(snapshot, 'character'),
    noteText: details(snapshot, 'note'),
    outlineText: snapshot.outlineText,
    characterAwarenessText: snapshot.characterAwarenessText || '',
    worldbookAwarenessText: snapshot.worldbookAwarenessText || '',
    immediatePreviousChapterText: snapshot.immediatePreviousChapterText || '',
    immediatePreviousChapterEnding: snapshot.immediatePreviousChapterEnding || '',
    writerStyleProtectedTokens: projection(snapshot, 'factCheck').estimatedTokens,
    writerStyleProjectionMode: projection(snapshot, 'factCheck').mode,
  };
}

export function buildProofConstraintsFromSnapshotV5(
  snapshot: PipelineContextSnapshot,
): ProofConstraints {
  return {
    presetText: projection(snapshot, 'proof').text,
    currentInstructionText: snapshot.currentInstructionText,
    retrievalUserPrompt: snapshot.retrievalUserPrompt,
    relevantCharacterConstraints: details(snapshot, 'character'),
    relevantWorldRules: details(snapshot, 'worldbook'),
    currentStoryState: snapshot.storyMemoryText,
    episodicMemoryText: snapshot.episodicMemoryText,
    noteText: details(snapshot, 'note'),
    recentBridgeText: snapshot.recentBridgeText,
    outlineText: snapshot.outlineText,
    characterAwarenessText: snapshot.characterAwarenessText || '',
    worldbookAwarenessText: snapshot.worldbookAwarenessText || '',
    immediatePreviousChapterText: snapshot.immediatePreviousChapterText || '',
    immediatePreviousChapterEnding: snapshot.immediatePreviousChapterEnding || '',
    writerStyleProtectedTokens: projection(snapshot, 'proof').estimatedTokens,
    writerStyleProjectionMode: projection(snapshot, 'proof').mode,
  };
}

export function buildBriefResourceViewFromSnapshotV5(
  snapshot: PipelineContextSnapshot,
): {
  presetText: string;
  characterAwarenessText: string;
  worldbookAwarenessText: string;
  characterDetailText: string;
  worldbookDetailText: string;
} {
  return {
    presetText: projection(snapshot, 'brief').text,
    characterAwarenessText: snapshot.characterAwarenessText || '',
    worldbookAwarenessText: snapshot.worldbookAwarenessText || '',
    characterDetailText: details(snapshot, 'character'),
    worldbookDetailText: details(snapshot, 'worldbook'),
  };
}

/**
 * Snapshot V5 Brief must consume the frozen MINIMAL projection. Legacy
 * V3/V4 snapshots without a Writer Style freeze keep the previous Brief
 * compiler contract and return undefined.
 */
export function resolveFrozenBriefWriterStyleProjection(
  snapshot: PipelineContextSnapshot | null | undefined,
): FrozenWriterStyleProjection | undefined {
  if (!snapshot) return undefined;
  if (snapshot.snapshotVersion !== 5 && !snapshot.writerStyleSnapshot) {
    return undefined;
  }
  return projection(snapshot, 'brief');
}

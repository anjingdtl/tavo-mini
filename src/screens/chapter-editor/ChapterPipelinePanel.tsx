import React from 'react';
import {
  PipelineProgress,
  type ContinuationPipelineStage,
} from '../../components/PipelineProgress';
import type { PipelineStageName } from '../../types/pipeline';

export function ChapterPipelinePanel({
  currentStage,
  progressStartedAt,
  progressVisible,
  focusMode,
  queued = false,
  continuationStage,
}: {
  currentStage: PipelineStageName | 'idle';
  progressStartedAt: number;
  progressVisible: boolean;
  focusMode: boolean;
  queued?: boolean;
  continuationStage?: ContinuationPipelineStage | null;
}) {
  if (!progressVisible || focusMode) return null;
  return (
    <PipelineProgress
      stage={currentStage}
      startedAt={progressStartedAt}
      visible={progressVisible}
      queued={queued}
      continuationStage={continuationStage ?? undefined}
    />
  );
}

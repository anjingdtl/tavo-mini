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
  preparing = false,
  continuationStage,
}: {
  currentStage: PipelineStageName | 'idle';
  progressStartedAt: number;
  progressVisible: boolean;
  focusMode: boolean;
  queued?: boolean;
  preparing?: boolean;
  continuationStage?: ContinuationPipelineStage | null;
}) {
  if (!progressVisible || focusMode) return null;
  return (
    <PipelineProgress
      stage={currentStage}
      startedAt={progressStartedAt}
      visible={progressVisible}
      queued={queued}
      preparing={preparing}
      continuationStage={continuationStage ?? undefined}
    />
  );
}

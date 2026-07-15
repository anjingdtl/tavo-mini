import React from 'react';
import { PipelineProgress } from '../../components/PipelineProgress';
import type { PipelineStageName } from '../../types/pipeline';

export function ChapterPipelinePanel({
  currentStage,
  progressStartedAt,
  progressVisible,
  focusMode,
}: {
  currentStage: PipelineStageName | 'idle';
  progressStartedAt: number;
  progressVisible: boolean;
  focusMode: boolean;
}) {
  if (!progressVisible || focusMode) return null;
  return (
    <PipelineProgress
      stage={currentStage}
      startedAt={progressStartedAt}
      visible={progressVisible}
    />
  );
}

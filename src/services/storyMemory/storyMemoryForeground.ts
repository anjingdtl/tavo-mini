import { PipelineForeground } from '../../native/PipelineForegroundModule';

export function storyMemoryForegroundTaskId(projectId: number): string {
  return `story-memory:${projectId}`;
}

export async function startStoryMemoryForeground(
  projectId: number,
  stageLabel: string,
  progress: number,
): Promise<void> {
  await PipelineForeground.start(
    storyMemoryForegroundTaskId(projectId),
    'ShineWriter · 长期记忆',
    stageLabel,
    progress,
  );
}

export async function updateStoryMemoryForeground(
  projectId: number,
  stageLabel: string,
  progress: number,
): Promise<void> {
  await PipelineForeground.updateProgress(
    storyMemoryForegroundTaskId(projectId),
    stageLabel,
    progress,
  );
}

export async function stopStoryMemoryForeground(projectId: number): Promise<void> {
  await PipelineForeground.stop(storyMemoryForegroundTaskId(projectId));
}

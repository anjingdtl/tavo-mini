import * as db from './database';
import { runChapterPipeline } from './pipelineRunner';
import { generateMemorySummary } from './summaryGenerator';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import type { Chapter } from '../types/novel';

export interface BatchChapterPipelineOptions {
  projectId: number;
  count: number;
  outlineLines: string[];
  onProgress?: (message: string) => void;
  onProgressNumeric?: (current: number, total: number) => void;
}

export interface BatchChapterPipelineResult {
  completed: number;
  failed: number;
  taskIds: string[];
}

function parseOutlineTitle(line: string, index: number): string {
  const cleaned = line.replace(/^\d+[.、\s-]*/, '').trim();
  const title = cleaned.split(/[：:]/)[0]?.trim();
  return title || `第 ${index + 1} 章`;
}

async function ensureTargetChapters(projectId: number, count: number, outlineLines: string[]): Promise<Chapter[]> {
  let working = await db.getChaptersByProject(projectId);
  let nonFinal = working.filter((c) => c.status !== 'final');

  while (nonFinal.length < count) {
    const index = working.length;
    const line = outlineLines[index] || '';
    const id = await db.createChapter(projectId, index, parseOutlineTitle(line, index));
    if (line) await db.updateChapter(id, { synopsis: line });
    working = await db.getChaptersByProject(projectId);
    nonFinal = working.filter((c) => c.status !== 'final');
  }

  return nonFinal.slice(0, count);
}

export async function runBatchChapterPipeline({
  projectId,
  count,
  outlineLines,
  onProgress,
  onProgressNumeric,
}: BatchChapterPipelineOptions): Promise<BatchChapterPipelineResult> {
  const targetCount = Math.max(1, count);
  const targets = await ensureTargetChapters(projectId, targetCount, outlineLines);
  const result: BatchChapterPipelineResult = { completed: 0, failed: 0, taskIds: [] };

  for (let index = 0; index < targets.length; index++) {
    const chapter = targets[index];
    onProgress?.(`正在生成 ${index + 1}/${targets.length}：${chapter.title || `第 ${chapter.position + 1} 章`}`);
    onProgressNumeric?.(index + 1, targets.length);

    const freshChapter = (await db.getChapterById(chapter.id)) || chapter;
    const taskId = usePipelineTaskStore.getState().createTask('chapter', freshChapter.id);
    result.taskIds.push(taskId);

    try {
      await runChapterPipeline(taskId, freshChapter, onProgress);
      const finishedTask = usePipelineTaskStore.getState().tasks.find((task) => task.id === taskId);
      if (finishedTask?.status === 'completed' && finishedTask.finalText?.trim()) {
        await db.updateChapter(freshChapter.id, { content: finishedTask.finalText.trim(), status: 'draft' });
        result.completed++;
        try {
          await generateMemorySummary(freshChapter.id, 200);
        } catch {
          // Batch writing should continue even if one memory summary fails.
        }
        // Mark the task as resolved so the global completion prompt in
        // src/main/index.tsx does not pop a result modal for every single
        // chapter in the batch. The batch summary alert in OutlineEditor
        // is the canonical feedback for batch runs.
        usePipelineTaskStore.getState().resolveTask(taskId, 'accept');
      } else {
        result.failed++;
        usePipelineTaskStore.getState().resolveTask(taskId, 'reject');
      }
    } catch {
      result.failed++;
      usePipelineTaskStore.getState().resolveTask(taskId, 'reject');
    }
  }

  return result;
}

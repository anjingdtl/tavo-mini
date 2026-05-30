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
  while (working.length < count) {
    const index = working.length;
    const line = outlineLines[index] || '';
    const id = await db.createChapter(projectId, index, parseOutlineTitle(line, index));
    if (line) await db.updateChapter(id, { synopsis: line });
    working = await db.getChaptersByProject(projectId);
  }

  return working
    .filter((chapter) => chapter.status !== 'final')
    .slice(0, count);
}

export async function runBatchChapterPipeline({
  projectId,
  count,
  outlineLines,
  onProgress,
}: BatchChapterPipelineOptions): Promise<BatchChapterPipelineResult> {
  const targetCount = Math.max(1, count);
  const targets = await ensureTargetChapters(projectId, targetCount, outlineLines);
  const result: BatchChapterPipelineResult = { completed: 0, failed: 0, taskIds: [] };

  for (let index = 0; index < targets.length; index++) {
    const chapter = targets[index];
    onProgress?.(`正在生成 ${index + 1}/${targets.length}：${chapter.title || `第 ${chapter.position + 1} 章`}`);

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
      } else {
        result.failed++;
      }
    } catch {
      result.failed++;
    }
  }

  return result;
}

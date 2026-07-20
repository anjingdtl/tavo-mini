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

async function ensureTargetChapters(
  projectId: number,
  count: number,
  outlineLines: string[],
): Promise<Chapter[]> {
  let working = await db.getChaptersByProject(projectId);
  // 批量生成覆盖已有草稿修复：只挑选 content 为空的章节，避免覆盖用户已有草稿
  let emptyChapters = working.filter(
    c => c.status !== 'final' && !c.content?.trim(),
  );

  // 最大创建次数上限，防止 createChapter 返回无效 id 时死循环
  const maxAttempts = count * 2 + 5;
  let attempts = 0;

  while (emptyChapters.length < count && attempts < maxAttempts) {
    const beforeLength = working.length;
    const index = working.length;
    const line = outlineLines[index] || '';
    const id = await db.createChapter(
      projectId,
      index,
      parseOutlineTitle(line, index),
    );
    if (line) await db.updateChapter(id, { synopsis: line });
    working = await db.getChaptersByProject(projectId);
    // 章节数量未增长说明创建失败，跳出避免死循环
    if (working.length <= beforeLength) break;
    emptyChapters = working.filter(
      c => c.status !== 'final' && !c.content?.trim(),
    );
    attempts++;
  }

  return emptyChapters.slice(0, count);
}

export async function runBatchChapterPipeline({
  projectId,
  count,
  outlineLines,
  onProgress,
  onProgressNumeric,
}: BatchChapterPipelineOptions): Promise<BatchChapterPipelineResult> {
  const targetCount = Math.max(1, count);
  const targets = await ensureTargetChapters(
    projectId,
    targetCount,
    outlineLines,
  );
  const result: BatchChapterPipelineResult = {
    completed: 0,
    failed: 0,
    taskIds: [],
  };

  for (let index = 0; index < targets.length; index++) {
    const chapter = targets[index];
    onProgress?.(
      `正在生成 ${index + 1}/${targets.length}：${
        chapter.title || `第 ${chapter.position + 1} 章`
      }`,
    );
    onProgressNumeric?.(index + 1, targets.length);

    const freshChapter = (await db.getChapterById(chapter.id)) || chapter;
    const taskId = usePipelineTaskStore
      .getState()
      .createTask('chapter', freshChapter.id);
    result.taskIds.push(taskId);

    try {
      // onStageUpdate 可能传入 StageInfo 对象，适配为 onProgress 期望的 string
      await runChapterPipeline(
        taskId,
        freshChapter,
        onProgress
          ? info => onProgress(typeof info === 'string' ? info : info.label)
          : undefined,
        { queueClass: 'background', queuePriority: 'background' },
      );
      const finishedTask = usePipelineTaskStore
        .getState()
        .tasks.find(task => task.id === taskId);
      if (
        finishedTask?.status === 'completed' &&
        finishedTask.finalText?.trim()
      ) {
        await db.updateChapter(freshChapter.id, {
          content: finishedTask.finalText.trim(),
          status: 'draft',
        });
        result.completed++;
        try {
          await generateMemorySummary(freshChapter.id);
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

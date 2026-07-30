/**
 * 章节导航：找当前章节的下一章；没有则创建。
 *
 * 设计目标：从章节编辑器底部"下一章"按钮一键进入下一章编辑，
 * 避免"返回章节列表→点新建章节→再进编辑器"的多步操作。
 *
 * 大纲模式与 freeform 模式沿用 `OutlineEditor.addChapter` 的位置算法
 * （`chapters.length`），保持行为一致，不引入位置算法分叉。
 *
 * 续写模式按 Spec §11.4 用 `MAX(position) + 1`，标题从原著边界接续
 * （`numbering.getDefaultTitle(position)`），确保删除中间章节后仍不撞号。
 */
import * as db from './database';
import {
  getContinuationChapterNumbering,
  getNextContinuationChapterPosition,
} from './continuation/chapterNumbering/continuationChapterNumbering';
import type { ProjectMode } from '../types/novel';

/**
 * 找到当前章节的下一章；如果不存在，则按项目模式创建新章节并返回其 id。
 *
 * @param projectId 当前章节所属项目 id
 * @param currentChapterId 当前章节 id
 * @param mode 项目模式，决定位置算法与标题生成
 * @returns 下一章 id（已存在或新创建）
 */
export async function findOrCreateNextChapter(
  projectId: number,
  currentChapterId: number,
  mode: ProjectMode,
): Promise<number> {
  const chapters = await db.getChaptersByProject(projectId);
  // getChaptersByProject 已按 position ASC, id ASC 排序；index+1 即"下一章"
  const idx = chapters.findIndex(c => c.id === currentChapterId);

  // 存在后续章节：直接返回，不创建
  if (idx >= 0 && idx + 1 < chapters.length) {
    return chapters[idx + 1].id;
  }

  // 没有下一章 → 按模式创建
  if (mode === 'continuation') {
    // Spec §11.4：续写位置用 MAX(position)+1，不依赖 length，删除/导入不会撞号
    const position = await getNextContinuationChapterPosition(projectId);
    const numbering = await getContinuationChapterNumbering(projectId);
    return await db.createChapter(
      projectId,
      Number(position),
      numbering.getDefaultTitle(position),
    );
  }

  // outline / freeform：沿用 OutlineEditor.addChapter 的 chapters.length 算法
  return await db.createChapter(projectId, chapters.length);
}
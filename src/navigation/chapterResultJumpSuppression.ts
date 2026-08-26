// B3: 「编辑最终稿」从结果页直达章节编辑器时，抑制编辑器挂载期
// 「已完成待采纳任务 → 自动跳回结果页」的行为（useChapterPipeline 的
// initial terminal handler）。用户明确点了「编辑最终稿」，不应被自动
// 导航再拉回结果页。仅抑制挂载瞬间的 initial 跳转，运行期任务终态
// 变化仍照常跳结果页。
const suppressedChapterIds = new Map<number, number>();

const DEFAULT_TTL_MS = 60_000;

export function suppressAutoResultJumpForChapter(
  chapterId: number,
  ttlMs: number = DEFAULT_TTL_MS,
): void {
  suppressedChapterIds.set(chapterId, Date.now() + ttlMs);
}

export function isAutoResultJumpSuppressed(chapterId: number): boolean {
  const until = suppressedChapterIds.get(chapterId);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    suppressedChapterIds.delete(chapterId);
    return false;
  }
  return true;
}
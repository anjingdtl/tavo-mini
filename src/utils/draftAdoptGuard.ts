export function canStartAdopt(
  currentAdopting: number | null,
  _targetDraftId: number,
): boolean {
  // 全局锁：任意草稿采纳进行中时，不允许启动新的采纳，避免并发数据库写。
  if (currentAdopting == null) return true;
  if (currentAdopting === 0) return true;
  return false;
}

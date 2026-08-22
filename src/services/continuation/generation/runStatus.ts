import type {
  ContinuationGenerationRun,
  ContinuationRunState,
  ContinuationStageName,
} from './types';

/**
 * A continuation run remains actionable until the user adopts/abandons it or
 * the runner explicitly marks it cancelled.  In particular, awaiting_user,
 * interrupted, failed and outdated must stay visible so a cold-start or
 * review result cannot become an orphaned database row.
 */
export function isUnfinishedContinuationRun(
  run: Pick<ContinuationGenerationRun, 'state'>,
): boolean {
  return run.state !== 'completed' && run.state !== 'cancelled';
}

export const CONTINUATION_RUN_STATE_LABEL: Record<ContinuationRunState, string> = {
  queued: '排队中',
  running: '生成中',
  awaiting_user: '等待确认/采纳',
  awaiting_regeneration: '等待重新生成',
  completed: '已完成',
  failed: '生成失败',
  cancelled: '已取消',
  interrupted: '已中断（可继续）',
  outdated: '已过期',
};
export const CONTINUATION_STAGE_LABEL: Record<ContinuationStageName, string> = {
  context: '上下文构建',
  planner: '规划',
  writer: '正文生成',
  checker: '一致性检查',
  auditing: 'Checker/Control 并行审查',
  repair: '自动修复',
  local_verify: '本地 Final Gate',
  awaiting_user: '等待用户处理',
  draft_writer: '生成',
  narrative_architect: '生成',
  revision_writer: '修订',
  adversarial_auditor: '检查',
  final_reviser: '校验',
  final_validate: '校验',
  round1: '生成',
  round2: '检查与修订',
  round3: '校验与保存',
  round4: '校验',
};

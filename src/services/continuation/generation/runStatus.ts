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
  draft_writer: '生成初稿 V1',
  narrative_architect: '规划叙事架构 A1',
  revision_writer: '扩写修订 V2',
  adversarial_auditor: '审阅 V2 并生成润色任务',
  final_reviser: '润色终稿 V3',
  final_validate: '校验终稿',
  round1: 'V1 初稿与 A1 架构',
  round2: 'V2 修订与 C2 审阅',
  round3: 'V3 终稿润色',
  round4: 'V4 最终校验',
};

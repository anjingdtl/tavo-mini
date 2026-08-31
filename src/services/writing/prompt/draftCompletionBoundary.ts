/**
 * Provider-independent completion boundary for the one Shared Draft Writer.
 * This is a semantic stop rule, not a keyword blacklist or an output cap.
 */
export const DRAFT_COMPLETION_BOUNDARY = [
  '【当前章节完成边界】',
  '只完成当前章节这一个有限任务；本章目标与因果落点完成并形成自然结尾后立即停止。',
  '不要继续下一章、后续计划或计划之外的新任务。',
  '计划中的清单、步骤、核对项等结构只作为有限叙事材料，不要求逐项无限展开；不得重复已完成的核对、解释或动作来延长正文。',
].join('\n');

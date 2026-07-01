/**
 * 流水线阶段定义、推进顺序、进度百分比计算。
 * 抽出来便于 pipelineRunner、resumePipeline、UI 测试、设置页复用。
 *
 * V2.2.0 新增：本文件替代 pipelineRunner 中内联的 totalStages / pct 逻辑。
 */

export type PipelineStageName = 'draft' | 'review' | 'factCheck' | 'proof';

export const PIPELINE_STAGES: PipelineStageName[] = ['draft', 'review', 'factCheck', 'proof'];

export const STAGE_LABELS: Record<PipelineStageName | 'idle', string> = {
  idle: '准备中',
  draft: '草稿',
  review: '点评',
  factCheck: '事实核查',
  proof: '终审打磨',
};

/** 按 pipelineMode 返回阶段串；full 4 阶段、twoStage/conditional 3 阶段、noReview 1 阶段。 */
export function getPipelineStageOrder(mode: string): PipelineStageName[] {
  if (mode === 'noReview') return ['draft'];
  if (mode === 'twoStage') return ['draft', 'review', 'proof'];
  if (mode === 'conditional') return ['draft', 'factCheck', 'proof'];
  return ['draft', 'review', 'factCheck', 'proof'];
}

/** 当前阶段在进度条上的起点百分比 = floor(completed / total * 100)，上限 99。 */
export function getStageProgressPercent(mode: string, completedStages: number): number {
  const total = getPipelineStageOrder(mode).length;
  return Math.min(99, Math.round((completedStages / total) * 100));
}

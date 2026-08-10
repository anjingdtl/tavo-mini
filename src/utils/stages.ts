/**
 * 流水线阶段定义、推进顺序、进度百分比计算。
 * 抽出来便于 pipelineRunner、resumePipeline、UI 测试、设置页复用。
 *
 * V2.2.0 新增：本文件替代 pipelineRunner 中内联的 totalStages / pct 逻辑。
 */

export type PipelineStageName = 'draft' | 'review' | 'factCheck' | 'brief' | 'proof';

export const PIPELINE_STAGES: PipelineStageName[] = ['draft', 'review', 'factCheck', 'brief', 'proof'];

export const STAGE_LABELS: Record<PipelineStageName | 'idle', string> = {
  idle: '准备中',
  draft: '草稿',
  review: '点评',
  factCheck: '事实核查',
  brief: '终稿整理',
  proof: '终审打磨',
};

/** 按 pipelineMode 与冻结版本返回阶段串；当前协议始终使用完整 5 阶段。 */
export function getPipelineStageOrder(
  mode: string,
  versions?: {
    outlineWorkflowVersion?: number | null;
    contextBudgetVersion?: number | null;
  },
): PipelineStageName[] {
  const isStructured =
    [3, 4].includes(Number(versions?.outlineWorkflowVersion)) &&
    [3, 4, 5].includes(Number(versions?.contextBudgetVersion));
  const isCurrent =
    Number(versions?.outlineWorkflowVersion) === 4 &&
    Number(versions?.contextBudgetVersion) === 5;
  if (isCurrent) return ['draft', 'review', 'factCheck', 'brief', 'proof'];
  // Batch form modes map to single-chapter modes (see mapBatchModeToPipelineMode).
  if (mode === 'draft_only') return ['draft'];
  if (mode === 'fast') return isStructured ? ['draft', 'review', 'brief', 'proof'] : ['draft', 'review', 'proof'];
  if (mode === 'noReview') return ['draft'];
  if (mode === 'twoStage') return isStructured ? ['draft', 'review', 'brief', 'proof'] : ['draft', 'review', 'proof'];
  if (mode === 'conditional') return isStructured ? ['draft', 'factCheck', 'brief', 'proof'] : ['draft', 'factCheck', 'proof'];
  return isStructured ? ['draft', 'review', 'factCheck', 'brief', 'proof'] : ['draft', 'review', 'factCheck', 'proof'];
}

/** 当前阶段在进度条上的起点百分比 = floor(completed / total * 100)，上限 99。 */
export function getStageProgressPercent(
  mode: string,
  completedStages: number,
  versions?: {
    outlineWorkflowVersion?: number | null;
    contextBudgetVersion?: number | null;
  },
): number {
  const total = getPipelineStageOrder(mode, versions).length;
  return Math.min(99, Math.round((completedStages / total) * 100));
}

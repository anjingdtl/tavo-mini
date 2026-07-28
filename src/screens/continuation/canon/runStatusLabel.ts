/**
 * Pure status-label derivation for the Canon analysis overview (S2 fix,
 * spec §2).
 *
 * The overview previously derived its status line solely from work-item
 * state, which made it permanently show "正在汇总结果" once a run reached
 * `awaiting_review` (all work items completed). Centralising the label here
 * keeps the state × stage matrix in one testable place.
 */
import type {
  AnalysisRun,
  AnalysisWorkItem,
} from '../../../services/continuation/canon';

export function runStatusLabel(
  run: Pick<AnalysisRun, 'state' | 'stage'>,
  // Work items are accepted so future refinements (e.g. distinguishing
  // "queued items remain" from "all running") can use them without changing
  // the call sites. Not currently needed for the matrix below.
  _workItems?: AnalysisWorkItem[],
): string {
  switch (run.state) {
    case 'queued':
      return '排队等待中';
    case 'running':
      if (run.stage === 'chapter_extraction') {
        return '正在处理 Canon 请求组';
      }
      if (run.stage === 'evidence_validation') {
        return '正在校验原文证据';
      }
      // finalizing and any non-canon stage (snapshot/entity_resolution/etc.)
      // share the neutral "summarising" label.
      return '正在汇总结果';
    case 'awaiting_review':
      return '分析完成，等待审核激活';
    case 'paused':
      return '已暂停，可继续';
    case 'failed':
      return '分析失败';
    case 'cancelled':
      return '已取消，可从断点继续';
    case 'completed':
      return '分析完成，等待审核激活';
    case 'outdated':
      return '源已变更，分析已失效';
    default:
      return '正在汇总结果';
  }
}

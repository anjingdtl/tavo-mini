/**
 * 召回潜在数据：公共 API 协调层。
 *
 * 仅 re-export scanner 和 merger 的入口，供 UI 和 database.ts facade 调用。
 * 不在此处添加业务逻辑，保持 scanner/merger 可独立测试。
 */
export { scanRecallSources } from './recallScanner';
export { applyRecall } from './recallMerger';
export type {
  RecallTable,
  RecallScanReport,
  CurrentDbFinding,
  BackupSourceFinding,
  RecallSelection,
  RecallResult,
  RecallTableResult,
  RecallErrorCode,
} from './recallTypes';
export { RECALL_TABLES, RECALL_TABLE_DISPLAY, keyOf } from './recallTypes';

/**
 * 召回潜在数据功能的公共类型定义。
 *
 * 设计见 docs/superpowers/specs/2026-08-05-backup-center-data-recall-design.md
 */
import type { SchemaDriftReport } from '../../data/schema/schemaDriftInspector';
import type { SchemaRepairResult } from '../../data/schema/knownSchemaRepairs';
import type {
  UserDataRecallSnapshot,
  RecallMismatch,
} from '../../data/schema/userDataRecallSnapshot';

/** 备份解析结果的推断类型（ParsedBackup 在 backupService 内部未导出） */
export type ParsedBackupData = NonNullable<
  Awaited<
    ReturnType<
      typeof import('../backupService')['readAndValidateBackup']
    >
  >['parsed']
>;

/** 召回涉及的表清单 */
export const RECALL_TABLES = [
  'projects',
  'chapters',
  'fragments',
  'character_collections',
  'characters',
  'worldbook_collections',
  'worldbook_entries',
  'notes',
  'presets',
  'project_resources',
  'project_collection_settings',
] as const;

export type RecallTable = (typeof RECALL_TABLES)[number];

/** 每张表的主键/复合键列定义，用于 keyOf() 和 readExistingKeys() */
export const RECALL_KEY_COLUMNS: Record<RecallTable, readonly string[]> = {
  projects: ['id'],
  chapters: ['id'],
  fragments: ['id'],
  character_collections: ['id'],
  characters: ['id'],
  worldbook_collections: ['id'],
  worldbook_entries: ['id'],
  notes: ['id'],
  presets: ['id'],
  project_resources: ['project_id', 'resource_type', 'resource_id'],
  project_collection_settings: ['project_id', 'resource_type', 'collection_id'],
};

/** 表的中文展示名 + 是否关联表（关联表跟随主表勾选，不单独展示） */
export const RECALL_TABLE_DISPLAY: Record<
  RecallTable,
  { label: string; isLink: boolean }
> = {
  projects: { label: '项目', isLink: false },
  chapters: { label: '章节', isLink: false },
  fragments: { label: '片段', isLink: false },
  character_collections: { label: '角色合集', isLink: false },
  characters: { label: '角色卡', isLink: false },
  worldbook_collections: { label: '世界书合集', isLink: false },
  worldbook_entries: { label: '世界书条目', isLink: false },
  notes: { label: '笔记', isLink: false },
  presets: { label: '预设', isLink: false },
  project_resources: { label: '项目-资源关联', isLink: true },
  project_collection_settings: { label: '项目-合集设置', isLink: true },
};

/** 合并顺序：父表在前，子表/关联表在后（沿用 schemaManifest restoreOrder） */
export const RECALL_MERGE_ORDER: RecallTable[] = [
  'projects',
  'character_collections',
  'worldbook_collections',
  'presets',
  'characters',
  'worldbook_entries',
  'notes',
  'chapters',
  'fragments',
  'project_resources',
  'project_collection_settings',
];

export interface CurrentDbFinding {
  reachable: boolean;
  schemaDrift: SchemaDriftReport;
  rowCount: Record<RecallTable, number>;
  /** 当前库每张表的键集合（字符串化），用于和源做差集 */
  existingKeys: Record<RecallTable, string[]>;
}

export interface BackupSourceFinding {
  sourceId: 'schema-recovery' | 'backup-json';
  filePath: string;
  fileName: string;
  kind: string;
  createdAt: string;
  schemaVersion: number;
  appVersion: string;
  sizeBytes: number;
  valid: boolean;
  invalidReason?: string;
  rowCount: Record<RecallTable, number>;
  /** 当前库没有、源里有的行数（按主键差集） */
  recoverable: Record<RecallTable, number>;
}

export interface RecallScanReport {
  scannedAt: number;
  currentDb: CurrentDbFinding;
  sources: BackupSourceFinding[];
}

export interface RecallSelection {
  repairCurrentDbDrift: boolean;
  sourceFilePaths: string[];
}

export interface RecallTableResult {
  inserted: number;
  skipped: number;
}

export type RecallErrorCode =
  | 'RECOVERY_BACKUP_FAILED'
  | 'DB_OPEN_FAILED'
  | 'DRIFT_REPAIR_FAILED'
  | 'RECALL_MISMATCH'
  | 'SOURCE_INSERT_FAILED'
  | 'NO_SELECTION';

export interface RecallResult {
  status: 'success' | 'partial' | 'failed';
  recoveryBackupPath: string;
  beforeSnapshot: UserDataRecallSnapshot;
  afterSnapshot: UserDataRecallSnapshot;
  recallMismatch: RecallMismatch | null;
  driftRepairResult?: SchemaRepairResult;
  applied: Partial<Record<RecallTable, RecallTableResult>>;
  error?: { code: RecallErrorCode; message: string };
}

/** 把一行的键列拼成字符串，用于主键差集判定 */
export function keyOf(
  table: RecallTable,
  row: Record<string, any>,
): string {
  return RECALL_KEY_COLUMNS[table]
    .map(col => String(row[col] ?? ''))
    .join(':');
}

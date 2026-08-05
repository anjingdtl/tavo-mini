import RNFS from 'react-native-fs';
import type SQLite from 'react-native-sqlite-storage';
import appVersionJson from '../constants/version.json';
import { clearSecureLLMApiKey } from './secureStorage';
import { SCHEMA_VERSION } from './migrations';
import { SCHEMA_MANIFEST, type TableManifest } from './database/schemaManifest';
import { formatSchemaIssues, validateSchema } from './database/schemaValidator';
import { executeTransaction, type SqlStatement } from './database/transaction';
import { Sha256Stream } from './continuation/hashUtils';

const BACKUP_DIR = `${RNFS.ExternalDirectoryPath}/backups`;
const MAX_AUTOMATIC_BACKUPS = 3;
const MAX_MANUAL_BACKUPS = 10;
const MAX_PRE_RESTORE_BACKUPS = 3;
const MAX_SCHEMA_RECOVERY_BACKUPS = 5;

type BackupKind = 'automatic' | 'manual' | 'pre_restore' | 'pre_migration' | 'schema_recovery';

/**
 * These tables are the compatibility floor for v1/v2 backups. Newer tables
 * are optional when reading an older backup and are left untouched on restore.
 */
const CORE_TABLE_NAMES = new Set([
  'projects',
  'chapters',
  'fragments',
  'plotlines',
  'project_plotlines',
  'characters',
  'worldbook_collections',
  'worldbook_entries',
  'notes',
  'presets',
  'llm_config',
  'settings',
]);

const BACKUP_MANIFEST = SCHEMA_MANIFEST
  .filter(table => table.backup)
  .slice()
  .sort((a, b) => a.restoreOrder - b.restoreOrder);
const BACKUP_TABLE_NAMES = BACKUP_MANIFEST.map(table => table.name);
const BACKUP_TABLE_SET = new Set(BACKUP_TABLE_NAMES);
const TABLE_BY_NAME = new Map(BACKUP_MANIFEST.map(table => [table.name, table]));

// Delete order: child tables first, then parent tables.
const DELETE_ORDER = BACKUP_MANIFEST
  .slice()
  .sort((a, b) => b.restoreOrder - a.restoreOrder)
  .map(table => table.name);

// Insert order: parent tables first, then child tables.
const INSERT_ORDER = BACKUP_MANIFEST.map(table => table.name);

export interface BackupSummary {
  path: string;
  kind: BackupKind;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  size: number;
  valid: boolean;
}

export interface BackupValidation {
  valid: boolean;
  errors: string[];
  appVersion?: string;
  schemaVersion?: number;
  tableCount?: number;
  rowCount?: number;
  formatVersion?: number;
}

export interface LocalModelReference {
  id: string;
  filename: string;
  sha256: string;
  file_size: number;
  included: false;
}

export interface BackupExternalAsset {
  local_model_reference: LocalModelReference;
}

export interface RestoreResult {
  preRestoreBackupPath: string;
  /** Kept for compatibility with old callers; new backups never include local models. */
  missingLocalModels: LocalModelReference[];
  restoredTableCount: number;
  restoredRowCount: number;
}

export interface RestoreOptions {
  /** Used by tests and migration tooling; normal UI restores keep this true. */
  createPreRestoreBackup?: boolean;
  appVersion?: string;
  schemaVersion?: number;
}

/**
 * 备份创建过程中的进度通知。`percent` 为 0..100 的整数，`stage` 为人类可读的
 * 当前阶段描述。service 层会做整数节流（只有 percent 变化时才回调），UI 层
 * 可直接 setState 无需额外防抖。
 */
export interface BackupProgress {
  percent: number;
  stage: string;
}

export type BackupProgressCallback = (progress: BackupProgress) => void;

interface BackupMetaV3 {
  app_version: string;
  schema_version: number;
  created_at: string;
  kind: BackupKind;
  checksum_algorithm: 'sha256';
  checksum: string;
}

interface BackupV3 {
  format: 'shinewriter-backup';
  format_version: 3;
  meta: BackupMetaV3;
  tables: Record<string, Record<string, any>[]>;
  external_assets: BackupExternalAsset[];
}

interface ParsedBackup {
  formatVersion: 1 | 2 | 3;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  kind: BackupKind;
  tables: Record<string, Record<string, any>[]>;
  externalAssets: BackupExternalAsset[];
}

interface ReadValidationResult {
  parsed: ParsedBackup | null;
  validation: BackupValidation;
}

interface RestoreTableOptions { redactCredentials: boolean; }

function isPlainRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (normalized === 'api_key' || normalized === 'apikey') return true;
  if (normalized === 'password' || normalized.endsWith('_password')) return true;
  if (normalized === 'secret' || normalized.endsWith('_secret')) return true;
  if (normalized === 'authorization' || normalized === 'bearer') return true;
  if (normalized.includes('auth_header') || normalized.includes('authorization_header')) {
    return true;
  }
  if (normalized === 'token' || normalized.endsWith('_token')) return true;
  if (normalized === 'credential' || normalized.endsWith('_credentials')) return true;
  if (normalized.startsWith('webdav_') || normalized.startsWith('sync_')) return true;
  return false;
}

function sanitizeNestedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => sanitizeNestedValue(item));
  if (!isPlainRecord(value)) return value;

  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    clean[key] = sanitizeNestedValue(nested);
  }
  return clean;
}

/** Remove secrets before the JSON string is ever assembled. */
function sanitizeBackupRow(table: string, row: Record<string, any>): Record<string, any> | null {
  if (table === 'settings' && isSensitiveKey(String(row.key || ''))) return null;

  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    if (isSensitiveKey(key)) continue;
    clean[key] = sanitizeNestedValue(value);
  }
  return clean;
}

function normalizeScalar(value: unknown): unknown {
  return value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

function countRows(tables: Record<string, any[]>): number {
  return BACKUP_TABLE_NAMES.reduce((total, table) => total + (tables[table]?.length || 0), 0);
}


function checksumPayload(backup: {
  format: 'shinewriter-backup';
  format_version: 3;
  meta: BackupMetaV3;
  tables: Record<string, any[]>;
  external_assets: BackupExternalAsset[];
}): string {
  const metaWithoutChecksum = { ...backup.meta, checksum: undefined };
  return JSON.stringify({
    format: backup.format,
    format_version: backup.format_version,
    meta: metaWithoutChecksum,
    tables: backup.tables,
    external_assets: backup.external_assets,
  });
}

/**
 * 流式 SHA-256 over UTF-8 字节，复用 {@link Sha256Stream} 的 O(1) 内存实现。
 *
 * 历史 one-shot 版本会先 `utf8Encode` 整个 JSON 字符串为 Uint8Array，再分配
 * 一份 padded 副本，对 multi-MB 备份（多 TXT 原著 + 全量正文）峰值 4 份大内
 * 存副本，且纯 JS SHA-256 计算即使每 1KB 让出一次事件循环，仍持续占用主线程
 * 数秒到数十秒，是「点击新增备份就卡死」的根因。
 *
 * 流式版本只保留 <64 字节 pending 缓冲 + 8-word hash state，每 ~64KB 让出一次
 * 事件循环（setTimeout 0），UI 始终可响应。digest 与原 one-shot 等价（已由
 * __tests__/continuationHashStream.test.ts 覆盖等价性）。
 */
async function sha256(
  value: string,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const stream = new Sha256Stream();
  const CHUNK_CHAR_SIZE = 65536; // 64K chars per chunk ≈ 64-256KB UTF-8
  const total = value.length;
  let pos = 0;
  let chunkIndex = 0;
  while (pos < total) {
    const end = Math.min(pos + CHUNK_CHAR_SIZE, total);
    stream.updateString(value.substring(pos, end));
    pos = end;
    chunkIndex += 1;
    // 每 4 个 chunk（~256KB chars）让出一次事件循环。过低（如每 1KB）会让
    // setTimeout 调度开销主导；过高（如每 32KB+）会让单次让出之间累积太多
    // 主线程工作。~256KB 是经验上 UI 流畅与吞吐的折中点。
    if (chunkIndex % 4 === 0) {
      await yieldToEventLoop();
      onProgress?.(total === 0 ? 1 : pos / total);
    }
  }
  onProgress?.(1);
  return stream.digest();
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Exported for deterministic format-v3 tests and tooling.
 * `onProgress` 报告 0..1 的 fraction，供 createBackup 映射成阶段百分比。
 */
export async function computeBackupChecksum(
  backup: BackupV3,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  return sha256(checksumPayload(backup), onProgress);
}

/** Legacy v2 fingerprint; retained only so old files remain readable. */
function computeLegacyChecksum(tables: Record<string, any[]>): string {
  const json = JSON.stringify(tables);
  const len = json.length;
  const head = json.substring(0, 50);
  let hash = 0;
  const prime = 2147483647;
  for (let index = 0; index < json.length; index += 1) {
    hash = (hash * 31 + json.charCodeAt(index)) % prime;
  }
  return `${len}:${head}:${hash}`;
}

async function execute(
  db: SQLite.SQLiteDatabase,
  sql: string,
  params: any[] = [],
) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

async function allRows(db: SQLite.SQLiteDatabase, table: string): Promise<Record<string, any>[]> {
  const result = await execute(db, `SELECT * FROM ${table}`);
  const rows: Record<string, any>[] = [];
  for (let index = 0; index < result.rows.length; index += 1) {
    rows.push(result.rows.item(index));
  }
  return rows;
}

async function readBackupTables(db: SQLite.SQLiteDatabase): Promise<Record<string, Record<string, any>[]>> {
  const tables: Record<string, Record<string, any>[]> = {};
  for (const table of BACKUP_MANIFEST) {
    try {
      tables[table.name] = await allRows(db, table.name);
    } catch (error) {
      if (CORE_TABLE_NAMES.has(table.name)) throw error;
      // An optional table may be absent on a pre-manifest database. Do not
      // turn a recoverable old install into a failed backup.
    }
  }
  return tables;
}

function normalizeKind(value: unknown): BackupKind {
  return value === 'manual' || value === 'pre_restore' || value === 'pre_migration' || value === 'schema_recovery'
    ? value
    : 'automatic';
}

function validateRows(
  tables: Record<string, unknown>,
  errors: string[],
): tables is Record<string, Record<string, any>[]> {
  if (!isPlainRecord(tables)) {
    errors.push('备份 tables 必须是对象');
    return false;
  }

  for (const [table, rows] of Object.entries(tables)) {
    const manifest = TABLE_BY_NAME.get(table);
    if (!manifest) continue;
    if (!Array.isArray(rows)) {
      errors.push(`数据表 ${table} 必须是数组`);
      continue;
    }
    const allowedColumns = new Set(manifest.columns);
    rows.forEach((row, rowIndex) => {
      if (!isPlainRecord(row)) {
        errors.push(`数据表 ${table} 第 ${rowIndex + 1} 行不是对象`);
        return;
      }
      for (const [column, value] of Object.entries(row)) {
        if (!allowedColumns.has(column)) {
          errors.push(`数据表 ${table} 包含未知字段：${column}`);
          continue;
        }
        if (value !== null && typeof value === 'object') {
          errors.push(`数据表 ${table}.${column} 第 ${rowIndex + 1} 行类型不受支持`);
        } else if (typeof value === 'number' && !Number.isFinite(value)) {
          errors.push(`数据表 ${table}.${column} 第 ${rowIndex + 1} 行数字无效`);
        }
      }
      if (table === 'settings') {
        if (row.key !== undefined && typeof row.key !== 'string') {
          errors.push(`数据表 settings.key 第 ${rowIndex + 1} 行类型不正确`);
        }
        if (row.value !== undefined && typeof row.value !== 'string') {
          errors.push(`数据表 settings.value 第 ${rowIndex + 1} 行类型不正确`);
        }
      }
    });
  }
  return errors.length === 0;
}

function countKnownTables(tables: Record<string, any[]>): number {
  return Object.keys(tables).filter(table => BACKUP_TABLE_SET.has(table)).length;
}

function baseValidation(parsed: ParsedBackup): BackupValidation {
  return {
    valid: true,
    errors: [],
    appVersion: parsed.appVersion,
    schemaVersion: parsed.schemaVersion,
    tableCount: countKnownTables(parsed.tables),
    rowCount: countRows(parsed.tables),
    formatVersion: parsed.formatVersion,
  };
}

function parseBackupObject(input: unknown): { parsed: ParsedBackup | null; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainRecord(input)) return { parsed: null, errors: ['备份根对象无效'] };
  const backup = input as Record<string, any>;

  // v1 has no format marker. It remains read-only compatible.
  const isV1 = backup.format === undefined && backup.format_version === undefined;
  if (isV1) {
    if (!isPlainRecord(backup.meta) || !isPlainRecord(backup.tables)) {
      return { parsed: null, errors: ['v1 备份缺少 meta 或 tables 字段'] };
    }
    validateRows(backup.tables, errors);
    const parsed: ParsedBackup = {
      formatVersion: 1,
      appVersion: String(backup.meta.app_version || ''),
      schemaVersion: Number(backup.meta.schema_version),
      createdAt: String(backup.meta.backup_date || ''),
      kind: 'automatic',
      tables: backup.tables as Record<string, Record<string, any>[]> ,
      externalAssets: [],
    };
    if (!Number.isFinite(parsed.schemaVersion)) errors.push('v1 schema_version 无效');
    for (const table of CORE_TABLE_NAMES) {
      if (!(table in parsed.tables)) errors.push(`缺少核心表：${table}`);
    }
    return { parsed, errors };
  }

  if (backup.format !== 'shinewriter-backup') {
    errors.push(`format 字段不正确：${String(backup.format)}`);
  }
  const version = Number(backup.format_version);
  if (![1, 2, 3].includes(version)) {
    errors.push(`不支持的 format_version：${String(backup.format_version)}`);
  }
  if (!isPlainRecord(backup.meta) || !isPlainRecord(backup.tables)) {
    errors.push('备份缺少 meta 或 tables 字段');
    return { parsed: null, errors };
  }

  const tables = backup.tables as Record<string, Record<string, any>[]>;
  validateRows(tables, errors);
  const parsed: ParsedBackup = {
    formatVersion: (version === 1 || version === 2 || version === 3 ? version : 3) as 1 | 2 | 3,
    appVersion: String(backup.meta.app_version || ''),
    schemaVersion: Number(backup.meta.schema_version),
    createdAt: String(backup.meta.created_at || ''),
    kind: normalizeKind(backup.meta.kind),
    tables,
    externalAssets: Array.isArray(backup.external_assets) ? backup.external_assets as BackupExternalAsset[] : [],
  };

  if (!Number.isFinite(parsed.schemaVersion)) errors.push('schema_version 无效');
  for (const table of CORE_TABLE_NAMES) {
    if (!(table in parsed.tables)) errors.push(`缺少核心表：${table}`);
  }

  if (version === 3) {
    if (backup.meta.checksum_algorithm !== 'sha256') {
      errors.push('v3 checksum_algorithm 必须为 sha256');
    }
    if (typeof backup.meta.checksum !== 'string' || !backup.meta.checksum) {
      errors.push('v3 备份缺少 checksum');
    }
    if (!Array.isArray(backup.external_assets)) {
      errors.push('v3 external_assets 必须是数组');
    }
  } else if (backup.meta.checksum && typeof backup.meta.checksum !== 'string') {
    errors.push('旧版 checksum 类型不正确');
  }

  return { parsed, errors };
}

export async function readAndValidateBackup(path: string): Promise<ReadValidationResult> {
  try {
    const content = await RNFS.readFile(path, 'utf8');
    const input = JSON.parse(content);
    const { parsed, errors } = parseBackupObject(input);
    if (!parsed) return { parsed: null, validation: { valid: false, errors } };

    const validation = baseValidation(parsed);
    validation.errors.push(...errors);

    if (parsed.formatVersion === 3 && errors.length === 0) {
      const checksum = await computeBackupChecksum(input as BackupV3);
      if (checksum !== input.meta.checksum) {
        validation.errors.push('SHA-256 校验和不匹配，备份可能已损坏');
      }
    } else if (parsed.formatVersion === 2 && input.meta?.checksum) {
      const actualChecksum = computeLegacyChecksum(parsed.tables);
      if (actualChecksum !== input.meta.checksum) {
        validation.errors.push('旧版校验和不匹配，备份可能已损坏');
      }
    }

    validation.valid = validation.errors.length === 0;
    return { parsed: validation.valid ? parsed : null, validation };
  } catch (error: any) {
    return {
      parsed: null,
      validation: {
        valid: false,
        errors: [`读取或解析备份失败：${error?.message || String(error)}`],
      },
    };
  }
}

export async function createBackup(
  db: SQLite.SQLiteDatabase,
  appVersion: string,
  schemaVersion: number,
  kind: BackupKind = 'automatic',
  onProgress?: BackupProgressCallback,
): Promise<string> {
  // 节流：只在整数 percent 变化时才回调，避免 UI 层 re-render 风暴。
  let lastPercent = -1;
  const report = (percent: number, stage: string) => {
    const rounded = Math.max(0, Math.min(100, Math.round(percent)));
    if (rounded === lastPercent) return;
    lastPercent = rounded;
    onProgress?.({ percent: rounded, stage });
  };

  report(0, '准备中');
  await RNFS.mkdir(BACKUP_DIR);

  // 阶段 1：读取数据表（0% → 50%）。按表数加权，sanitize 开销已包含在内。
  const tables: Record<string, Record<string, any>[]> = {};
  const totalTables = BACKUP_MANIFEST.length;
  for (let i = 0; i < totalTables; i += 1) {
    const table = BACKUP_MANIFEST[i];
    const rows = await allRows(db, table.name);
    tables[table.name] = rows
      .map(row => sanitizeBackupRow(table.name, row))
      .filter((row): row is Record<string, any> => row !== null);
    report(((i + 1) / totalTables) * 50, `读取数据表 (${i + 1}/${totalTables})`);
  }

  const externalAssets: BackupExternalAsset[] = [];
  const meta: BackupMetaV3 = {
    app_version: appVersion,
    schema_version: Number(schemaVersion),
    created_at: new Date().toISOString(),
    kind,
    checksum_algorithm: 'sha256',
    checksum: '',
  };
  const draft: BackupV3 = {
    format: 'shinewriter-backup',
    format_version: 3,
    meta,
    tables,
    external_assets: externalAssets,
  };

  // 阶段 2：计算 SHA-256 校验和（50% → 95%）。这是历史卡死的根因阶段，
  // 流式实现 + fraction 回调让 UI 能实时反映进度。
  report(50, '计算校验和');
  meta.checksum = await computeBackupChecksum(draft, fraction => {
    report(50 + fraction * 45, '计算校验和');
  });

  // 阶段 3：写入文件（95% → 99%）。
  const timestamp = Date.now();
  const kindPrefix =
    kind === 'manual' ? 'manual'
    : kind === 'pre_restore' ? 'prerestore'
    : kind === 'schema_recovery' ? 'schemarecovery'
    : kind === 'pre_migration' ? 'premigration'
    : 'backup';
  const fileName = `${kindPrefix}_v${appVersion}_${timestamp}.json`;
  const filePath = `${BACKUP_DIR}/${fileName}`;
  const stagingPath = `${filePath}.tmp`;
  report(95, '写入文件');
  try {
    await RNFS.writeFile(stagingPath, JSON.stringify(draft), 'utf8');
    await RNFS.moveFile(stagingPath, filePath);
  } catch (error) {
    try {
      await RNFS.unlink(stagingPath);
    } catch {
      // The write can fail before the staging file exists. Preserve the
      // original storage error and let the next backup attempt retry cleanly.
    }
    throw error;
  }

  // 阶段 4：清理旧备份（99% → 100%）。
  report(99, '清理旧备份');
  await cleanupOldBackups();
  report(100, '完成');
  return filePath;
}

export async function createManualBackup(
  db: SQLite.SQLiteDatabase,
  appVersion: string,
  schemaVersion: number,
  onProgress?: BackupProgressCallback,
): Promise<string> {
  return createBackup(db, appVersion, schemaVersion, 'manual', onProgress);
}

export async function createPreRestoreBackup(
  db: SQLite.SQLiteDatabase,
  appVersion: string,
  schemaVersion: number,
  onProgress?: BackupProgressCallback,
): Promise<string> {
  return createBackup(db, appVersion, schemaVersion, 'pre_restore', onProgress);
}

export async function validateBackup(path: string): Promise<BackupValidation> {
  return (await readAndValidateBackup(path)).validation;
}

function tableRowsForRestore(
  parsed: ParsedBackup,
  options: RestoreTableOptions,
): { tables: Record<string, Record<string, any>[]>; missingLocalModels: LocalModelReference[] } {
  const tables: Record<string, Record<string, any>[]> = {};
  for (const table of BACKUP_MANIFEST) {
    if (!Object.prototype.hasOwnProperty.call(parsed.tables, table.name)) continue;
    const rows = parsed.tables[table.name] || [];
    tables[table.name] = rows.map(row => {
      const next = { ...row };
      if (options.redactCredentials) {
        const clean = sanitizeBackupRow(table.name, next);
        Object.keys(next).forEach(key => delete next[key]);
        Object.assign(next, clean || {});
      }
      return next;
    });
  }

  return { tables, missingLocalModels: [] };
}

function buildInsertStatement(
  table: TableManifest,
  row: Record<string, any>,
  redactCredentials: boolean,
): SqlStatement {
  const keys = table.columns.filter(key =>
    Object.prototype.hasOwnProperty.call(row, key)
      && (!redactCredentials || !isSensitiveKey(key)),
  );
  if (keys.length === 0) {
    throw new Error(`数据表 ${table.name} 存在没有可恢复字段的行`);
  }
  return {
    sql: `INSERT INTO ${table.name} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    params: keys.map(key => normalizeScalar(row[key])),
  };
}

function rowValue(row: Record<string, any>, key: string): string | null {
  const value = row[key];
  return value === undefined || value === null || value === ''
    ? null
    : String(value);
}

/**
 * Validate the active-pointer graph before opening the restore transaction.
 * The settings row is restored with both pointers NULL first, then the final
 * UPDATEs are appended after all parent rows have been inserted.
 */
function validateRestoreActivePointers(
  sourceTables: Record<string, Record<string, any>[]>,
): void {
  const sources = new Map(
    (sourceTables.continuation_sources || []).map(row => [Number(row.id), row]),
  );
  const chapters = new Map(
    (sourceTables.continuation_source_chapters || []).map(row => [Number(row.id), row]),
  );
  const snapshots = new Map(
    (sourceTables.continuation_canon_snapshots || []).map(row => [String(row.id), row]),
  );
  const styles = new Map(
    (sourceTables.continuation_style_profiles || []).map(row => [String(row.id), row]),
  );

  for (const settings of sourceTables.continuation_settings || []) {
    const projectId = Number(settings.project_id);
    const canonId = rowValue(settings, 'active_canon_snapshot_id');
    const styleId = rowValue(settings, 'active_style_profile_id');
    const canon = canonId ? snapshots.get(canonId) : null;
    if (canonId && (!canon || Number(canon.project_id) !== projectId)) {
      throw new Error(`备份 active Canon 不属于项目 ${projectId}`);
    }
    if (canonId && canon) {
      if (
        Number(canon.source_id) !== Number(settings.active_source_id) ||
        Number(canon.boundary_chapter_id) !== Number(settings.boundary_chapter_id) ||
        Number(canon.boundary_char_offset_exclusive) !==
          Number(settings.boundary_char_offset_global)
      ) {
        throw new Error(`备份 active Canon 与项目 ${projectId} 的 source/boundary 不一致`);
      }
    }

    const style = styleId ? styles.get(styleId) : null;
    if (!styleId || !style) continue;
    const source = sources.get(Number(style.source_id));
    const boundaryChapter = chapters.get(Number(style.boundary_chapter_id));
    if (
      Number(style.project_id) !== projectId ||
      !source ||
      !boundaryChapter ||
      Number(settings.active_source_id) !== Number(style.source_id) ||
      Number(source.version) !== Number(style.source_version) ||
      String(source.normalized_sha256) !== String(style.source_sha256) ||
      String(source.parser_version) !== String(style.parser_version) ||
      String(source.normalization_version) !== String(style.normalization_version) ||
      Number(settings.boundary_chapter_id) !== Number(style.boundary_chapter_id) ||
      Number(boundaryChapter.position) !== Number(style.boundary_position) ||
      Number(settings.boundary_char_offset_global) !==
        Number(style.boundary_char_offset_exclusive) ||
      (canonId && String(style.canon_snapshot_id) !== canonId)
    ) {
      throw new Error(`备份 active Style 与项目 ${projectId} 的 source/boundary 不一致`);
    }
  }
}

function buildRestoreStatements(
  sourceTables: Record<string, Record<string, any>[]>,
  options: RestoreTableOptions,
): SqlStatement[] {
  const presentTables = new Set(Object.keys(sourceTables));
  const statements: SqlStatement[] = [];

  if (
    presentTables.has('continuation_settings') ||
    presentTables.has('continuation_canon_snapshots') ||
    presentTables.has('continuation_style_profiles')
  ) {
    // Clear immediate FK pointers before deleting any parent rows. This is
    // also used by the rollback restore, so it cannot leave the old database
    // pointing at rows that the rollback is about to replace.
    statements.push({
      sql: `UPDATE continuation_settings SET
        active_canon_snapshot_id = NULL,
        active_style_profile_id = NULL`,
    });
  }

  validateRestoreActivePointers(sourceTables);

  for (const table of DELETE_ORDER) {
    if (presentTables.has(table)) statements.push({ sql: `DELETE FROM ${table}` });
  }

  for (const tableName of INSERT_ORDER) {
    if (!presentTables.has(tableName)) continue;
    const table = TABLE_BY_NAME.get(tableName);
    if (!table) continue;
    for (const row of sourceTables[tableName] || []) {
      const restoreRow = tableName === 'continuation_settings'
        ? {
            ...row,
            // The pointer cycle is completed only after every parent table has
            // been restored (see the second phase below).
            active_canon_snapshot_id: null,
            active_style_profile_id: null,
          }
        : row;
      statements.push(buildInsertStatement(table, restoreRow, options.redactCredentials));
    }
    if (tableName === 'settings') {
      // An old backup's metadata must never downgrade the current database.
      statements.push({
        sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
        params: ['schema_version', String(SCHEMA_VERSION)],
      });
    }
  }

  // Phase 2: reattach active Canon/style only after all source, snapshot and
  // profile rows exist. Older backups simply yield NULL for the new style key.
  for (const row of sourceTables.continuation_settings || []) {
    statements.push({
      sql: `UPDATE continuation_settings SET
        active_canon_snapshot_id = ?,
        active_style_profile_id = ?,
        updated_at = COALESCE(updated_at, ?)
        WHERE project_id = ?`,
      params: [
        rowValue(row, 'active_canon_snapshot_id'),
        rowValue(row, 'active_style_profile_id'),
        new Date().toISOString(),
        row.project_id,
      ],
    });
  }

  return statements;
}

async function assertForeignKeyIntegrity(db: SQLite.SQLiteDatabase): Promise<void> {
  const result = await execute(db, 'PRAGMA foreign_key_check');
  if (result.rows.length === 0) return;
  throw new Error(`恢复后发现 ${result.rows.length} 条外键孤儿记录`);
}

async function assertRestoredSchema(db: SQLite.SQLiteDatabase): Promise<void> {
  await assertForeignKeyIntegrity(db);
  const result = await validateSchema(db, { requireActiveLlmConfig: false });
  if (!result.valid) {
    throw new Error(`恢复后 Schema 验证失败：${formatSchemaIssues(result.issues)}`);
  }
}

export async function restoreFromBackup(
  db: SQLite.SQLiteDatabase,
  backupPath: string,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const { parsed, validation } = await readAndValidateBackup(backupPath);
  if (!validation.valid || !parsed) {
    throw new Error(`备份验证失败：${validation.errors.join('; ')}`);
  }

  const preRestoreBackupPath = options.createPreRestoreBackup === false
    ? ''
    : await createPreRestoreBackup(
        db,
        options.appVersion || appVersionJson.versionName.replace(/^V/, ''),
        options.schemaVersion || SCHEMA_VERSION,
      );

  // Read the complete pre-restore state outside SQLite's synchronous
  // transaction callback. It is used only as a safety net if post-commit
  // integrity verification finds a problem.
  const currentTables = await readBackupTables(db);
  const { tables: restoreTables, missingLocalModels } = tableRowsForRestore(parsed, {
    redactCredentials: true,
  });
  const statements = buildRestoreStatements(restoreTables, {
    redactCredentials: true,
  });

  try {
    await executeTransaction(db, statements, { faultDomain: 'restore' });
    try {
      await assertRestoredSchema(db);
    } catch (verificationError) {
      const rollbackStatements = buildRestoreStatements(currentTables, {
        redactCredentials: false,
      });
      try {
        await executeTransaction(db, rollbackStatements);
      } catch (rollbackError: any) {
        throw new Error(
          `恢复后验证失败且回滚失败：${verificationError instanceof Error ? verificationError.message : String(verificationError)}；${rollbackError?.message || String(rollbackError)}`,
        );
      }
      throw verificationError;
    }

    // The portable backup never contains credentials. Clear any old
    // Keychain entries that would otherwise be accidentally associated with
    // restored config IDs.
    const restoredConfigIds = (restoreTables.llm_config || [])
      .map(row => Number(row.id))
      .filter(id => Number.isFinite(id) && id > 0);
    await Promise.all(restoredConfigIds.map(async id => {
      try {
        await clearSecureLLMApiKey(id);
      } catch (error) {
        // The database restore is already committed and contains no secret.
        // A Keychain cleanup failure must not turn that committed restore into
        // a reported half-failure; the next config load can retry cleanup.
        console.warn(`[backup] unable to clear restored LLM credential ${id}`, error);
      }
    }));

    return {
      preRestoreBackupPath,
      missingLocalModels,
      restoredTableCount: Object.keys(restoreTables).length,
      restoredRowCount: countRows(restoreTables),
    };
  } catch (error) {
    throw error;
  }
}

export async function listBackups(): Promise<BackupSummary[]> {
  try {
    await RNFS.mkdir(BACKUP_DIR);
    const files = await RNFS.readDir(BACKUP_DIR);
    const jsonFiles = files.filter(file => file.name.endsWith('.json'));
    const summaries: BackupSummary[] = [];

    for (const file of jsonFiles) {
      try {
        const content = await RNFS.readFile(file.path, 'utf8');
        const backup = JSON.parse(content);
        let kind: BackupKind = 'automatic';
        let appVersion = '';
        let schemaVersion = 0;
        let createdAt = '';

        if (backup.format === 'shinewriter-backup' && backup.format_version >= 2) {
          kind = normalizeKind(backup.meta?.kind);
          appVersion = backup.meta?.app_version || '';
          schemaVersion = Number(backup.meta?.schema_version || 0);
          createdAt = backup.meta?.created_at || '';
        } else {
          if (file.name.startsWith('manual_')) kind = 'manual';
          if (file.name.startsWith('prerestore_')) kind = 'pre_restore';
          if (file.name.startsWith('premigration_')) kind = 'pre_migration';
          if (file.name.startsWith('schemarecovery_')) kind = 'schema_recovery';
          appVersion = backup.meta?.app_version || '';
          schemaVersion = Number(backup.meta?.schema_version || 0);
          createdAt = backup.meta?.backup_date || '';
        }

        // 列表只做轻量结构校验，SHA-256 校验延迟到恢复时（restoreFromBackup）。
        // 原 listBackups 对每个备份都跑一次完整 SHA-256，是"一按备份就卡死"的根因。
        const structValid = !!(
          backup.format === 'shinewriter-backup'
          && backup.format_version
          && backup.meta
        );
        summaries.push({
          path: file.path,
          kind,
          appVersion,
          schemaVersion,
          createdAt: createdAt || new Date(file.mtime || 0).toISOString(),
          size: file.size,
          valid: structValid,
        });
      } catch {
        summaries.push({
          path: file.path,
          kind: 'automatic',
          appVersion: '',
          schemaVersion: 0,
          createdAt: new Date(file.mtime || 0).toISOString(),
          size: file.size,
          valid: false,
        });
      }
    }

    summaries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return summaries;
  } catch {
    return [];
  }
}

export async function deleteBackup(path: string): Promise<void> {
  if (await RNFS.exists(path)) await RNFS.unlink(path);
}

export async function cleanupOldBackups(): Promise<void> {
  try {
    const summaries = await listBackups();
    const byKind: Record<BackupKind, BackupSummary[]> = {
      automatic: [],
      manual: [],
      pre_restore: [],
      pre_migration: [],
      schema_recovery: [],
    };
    for (const summary of summaries) byKind[summary.kind].push(summary);

    const limits: Record<BackupKind, number> = {
      automatic: MAX_AUTOMATIC_BACKUPS,
      manual: MAX_MANUAL_BACKUPS,
      pre_restore: MAX_PRE_RESTORE_BACKUPS,
      pre_migration: MAX_SCHEMA_RECOVERY_BACKUPS,
      schema_recovery: MAX_SCHEMA_RECOVERY_BACKUPS,
    };
    for (const kind of Object.keys(byKind) as BackupKind[]) {
      for (const summary of byKind[kind].slice(limits[kind])) {
        await deleteBackup(summary.path);
      }
    }
  } catch {
    // Backup cleanup is best-effort and must not hide a successful write.
  }
}

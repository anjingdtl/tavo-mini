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

// ---------------------------------------------------------------------------
// CL-08: sidecar metadata for the Backup Center list.
//
// listBackups() must NEVER read + JSON.parse a complete backup (10 × 100MB is
// a guaranteed freeze). Every backup gets a tiny `backup_xxx.json.meta.json`
// sidecar written right after the backup file; the list reads only
// readDir + stat + the small sidecar. Legacy backups without a sidecar are
// shown immediately from filename/mtime/size and backfilled in the background
// via `backfillBackupMeta`.
// ---------------------------------------------------------------------------

export const BACKUP_SIDECAR_SUFFIX = '.meta.json';

export interface BackupSidecarMeta {
  formatVersion: 1;
  kind: BackupKind;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  size: number;
  checksum: string;
  validationState: 'created';
}

export function sidecarPathFor(backupPath: string): string {
  return `${backupPath}${BACKUP_SIDECAR_SUFFIX}`;
}

async function writeBackupSidecar(
  filePath: string,
  meta: Omit<BackupSidecarMeta, 'formatVersion'>,
): Promise<void> {
  const sidecar: BackupSidecarMeta = { formatVersion: 1, ...meta };
  await RNFS.writeFile(sidecarPathFor(filePath), JSON.stringify(sidecar), 'utf8');
}

/** Parse a sidecar file defensively; null when absent or malformed. */
export async function readBackupSidecar(
  sidecarPath: string,
): Promise<BackupSidecarMeta | null> {
  try {
    const raw = await RNFS.readFile(sidecarPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.formatVersion === 1 &&
      typeof parsed.createdAt === 'string'
    ) {
      return parsed as BackupSidecarMeta;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Backfill a sidecar for a legacy backup (no sidecar on disk). Reads the full
 * backup ONCE — the Backup Center calls this in the background AFTER the list
 * has already rendered from filename/mtime/size, never on the list hot path.
 */
export async function backfillBackupMeta(backupPath: string): Promise<void> {
  try {
    const exists = await RNFS.exists(sidecarPathFor(backupPath));
    if (exists) return;
    const stat = await RNFS.stat(backupPath);
    const { parsed } = await readAndValidateBackup(backupPath);
    if (!parsed) return;
    await writeBackupSidecar(backupPath, {
      kind: parsed.kind,
      appVersion: parsed.appVersion,
      schemaVersion: parsed.schemaVersion,
      createdAt: parsed.createdAt,
      size: Number(stat.size ?? 0),
      checksum: '',
      validationState: 'created',
    });
  } catch {
    // best-effort — the list keeps working without the sidecar
  }
}

/**
 * F2-05: backfill legacy sidecars with a bounded concurrency queue instead of
 * Promise.all — each backfill full-reads one complete backup, so concurrent
 * backfills on a large library would read N backups at once. Default
 * concurrency = 1 (serial): the list has already rendered from
 * filename/mtime/size, so there is no need to race the reads. One failing
 * item does not affect the others.
 */
export async function backfillBackupMetaQueued(
  backupPaths: string[],
  concurrency = 1,
): Promise<void> {
  const queue = [...backupPaths];
  const workerCount = Math.max(1, Math.min(concurrency, queue.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      const path = queue.shift() as string;
      await backfillBackupMeta(path);
    }
  });
  await Promise.all(workers);
}

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
  /** CL-08: legacy backup without a sidecar yet — shown from
   *  filename/mtime/size; the UI backfills the sidecar in the background. */
  metaPending?: boolean;
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

export function isSensitiveKey(key: string): boolean {
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
  if (normalized === 'reasoning_content_temp') return true;
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
export function sanitizeBackupRow(table: string, row: Record<string, any>): Record<string, any> | null {
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


/**
 * 增量式 payload 哈希器：不落地完整 payload 字符串，逐片段喂给 Sha256Stream。
 *
 * 字节兼容性（关键）：旧实现是 `sha256(JSON.stringify(payload))`，且内部按
 * 全局 64K 字符边界切片喂给 utf8Encode（切片不保护 surrogate pair）。已写入
 * 磁盘的历史 v3 备份 checksum 都是按这套语义算出来的，因此这里必须逐字复现：
 *   - 片段按到达顺序拼接后，在「全局」64K 整数倍位置切片（leftover 进位），
 *     与旧实现对同一 payload 产生完全相同的切片序列 → 相同 digest；
 *   - 片段序列本身与 `JSON.stringify({format, format_version, meta, tables,
 *     external_assets})` 的字节输出完全一致（键序 = 对象插入序 = 下面 feed 顺序）。
 *
 * 内存收益：任意时刻只持有「当前片段（单表 JSON）+ <64K leftover」，峰值从
 * 「整份 payload 字符串」降到「最大单表 JSON」，消除大库备份校验 OOM。
 */
/**
 * 流式 SHA-256 over UTF-8 字节，复用 {@link Sha256Stream} 的 O(1) 内存实现。
 *
 * 历史 one-shot 版本会先 `utf8Encode` 整个 JSON 字符串为 Uint8Array，再分配
 * 一份 padded 副本，对 multi-MB 备份（多 TXT 原著 + 全量正文）峰值 4 份大内
 * 存副本，且纯 JS SHA-256 计算即使每 1KB 让出一次事件循环，仍持续占用主线程
 * 数秒到数十秒，是「点击新增备份就卡死」的根因。流式版本只保留 <64 字节
 * pending 缓冲 + 8-word hash state，digest 与原 one-shot 等价（已由
 * __tests__/continuationHashStream.test.ts 覆盖等价性）。
 */
export class BackupPayloadHasher {
  private readonly stream = new Sha256Stream();
  private leftover = '';
  private static readonly CHUNK_CHAR_SIZE = 65536;

  feed(piece: string): void {
    let text = piece;
    if (this.leftover.length > 0) {
      text = this.leftover + piece;
      this.leftover = '';
    }
    const CHUNK = BackupPayloadHasher.CHUNK_CHAR_SIZE;
    let pos = 0;
    while (text.length - pos >= CHUNK) {
      this.stream.updateString(text.substring(pos, pos + CHUNK));
      pos += CHUNK;
    }
    this.leftover = pos > 0 ? text.substring(pos) : text;
  }

  digest(): string {
    if (this.leftover.length > 0) {
      this.stream.updateString(this.leftover);
      this.leftover = '';
    }
    return this.stream.digest();
  }
}

/** 让出一次事件循环，避免长哈希阻塞 UI 线程。 */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Exported for deterministic format-v3 tests and tooling.
 * `onProgress` 报告 0..1 的 fraction，供 createBackup 映射成阶段百分比。
 *
 * 内存安全（v2.11.x OOM 修复）：旧实现先 `JSON.stringify` 整个 payload 再哈希，
 * 对 100MB+ 大库备份等于在「文件原文 + 解析对象图」之外再压一份等量大字符串，
 * 直接触发 Java/Hermes OOM，导致备份中心召回与 schema-recovery 校验全部失败。
 * 新实现按 JSON.stringify 的字节序逐片段（meta → 单表 → external_assets）喂给
 * {@link BackupPayloadHasher}，digest 与旧实现一致（见该类注释的兼容性说明）。
 */
export async function computeBackupChecksum(
  backup: BackupV3,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const hasher = new BackupPayloadHasher();
  const tableKeys = Object.keys(backup.tables);
  // 片段数 = 头 1 + meta 1 + 每表 1 + external_assets/收尾 1，用于进度估算。
  const totalPieces = tableKeys.length + 3;
  let donePieces = 0;
  const feedWithProgress = (piece: string) => {
    hasher.feed(piece);
    donePieces += 1;
    onProgress?.(donePieces / totalPieces);
  };

  // 与 JSON.stringify({format, format_version, meta, tables, external_assets})
  // 字节一致：键序为对象字面量插入序。
  feedWithProgress('{"format":');
  hasher.feed(JSON.stringify(backup.format));
  hasher.feed(',"format_version":');
  hasher.feed(JSON.stringify(backup.format_version));
  hasher.feed(',"meta":');
  // checksum 字段置 undefined → stringify 时省略该键，与旧 checksumPayload 一致。
  hasher.feed(JSON.stringify({ ...backup.meta, checksum: undefined }));
  hasher.feed(',"tables":{');
  await yieldToEventLoop();

  for (let index = 0; index < tableKeys.length; index += 1) {
    const key = tableKeys[index];
    hasher.feed(index > 0 ? ',' : '');
    hasher.feed(JSON.stringify(key));
    hasher.feed(':');
    // 单表 JSON 是此刻最大的临时字符串，喂完即可被 GC 回收，不会叠加。
    hasher.feed(JSON.stringify(backup.tables[key]));
    // 每 4 张表让出一次事件循环，保持 UI 可响应（与旧实现的让出策略同量级）。
    if (index % 4 === 3) {
      await yieldToEventLoop();
      onProgress?.(donePieces / totalPieces);
    }
  }

  hasher.feed('},"external_assets":');
  feedWithProgress(JSON.stringify(backup.external_assets));
  hasher.feed('}');
  onProgress?.(1);
  return hasher.digest();
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

async function existingTableNames(
  db: SQLite.SQLiteDatabase,
): Promise<Set<string>> {
  const result = await execute(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  const names = new Set<string>();
  for (let index = 0; index < result.rows.length; index += 1) {
    names.add(String(result.rows.item(index).name || ''));
  }
  return names;
}

const PIPELINE_TASK_CHUNK_SIZE_CHARS = 200_000;
const PIPELINE_TASK_CHUNK_THRESHOLD_CHARS = 500_000;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function readPipelineTasksWithChunkedContext(
  db: SQLite.SQLiteDatabase,
): Promise<Record<string, any>[] | null> {
  let sizeResult;
  try {
    sizeResult = await execute(
      db,
      'SELECT COALESCE(MAX(LENGTH(CAST(pipeline_context_json AS TEXT))), 0) AS max_chars FROM pipeline_tasks',
    );
  } catch {
    // Older pipeline_tasks schemas may not have this column yet. Fall back to
    // the ordinary SELECT * path, which remains schema-version agnostic.
    return null;
  }

  const maxChars = Number(sizeResult.rows.length > 0 ? sizeResult.rows.item(0).max_chars : 0);
  if (!Number.isFinite(maxChars) || maxChars <= PIPELINE_TASK_CHUNK_THRESHOLD_CHARS) {
    return null;
  }

  let columnResult;
  try {
    columnResult = await execute(db, 'PRAGMA table_info(pipeline_tasks)');
  } catch {
    return null;
  }
  const columns: string[] = [];
  for (let index = 0; index < columnResult.rows.length; index += 1) {
    const name = String(columnResult.rows.item(index).name || '');
    if (name) columns.push(name);
  }
  if (!columns.includes('id') || !columns.includes('pipeline_context_json')) {
    return null;
  }

  const contextColumn = quoteIdentifier('pipeline_context_json');
  const tableName = quoteIdentifier('pipeline_tasks');
  const baseColumns = columns
    .filter(column => column !== 'pipeline_context_json')
    .map(quoteIdentifier)
    .join(', ');
  const baseResult = await execute(db, `SELECT ${baseColumns} FROM ${tableName}`);
  const rows: Record<string, any>[] = [];
  for (let index = 0; index < baseResult.rows.length; index += 1) {
    rows.push(baseResult.rows.item(index));
  }

  for (const row of rows) {
    const id = row.id;
    const lengthResult = await execute(
      db,
      `SELECT CASE WHEN ${contextColumn} IS NULL THEN NULL ELSE LENGTH(CAST(${contextColumn} AS TEXT)) END AS char_length FROM ${tableName} WHERE ${quoteIdentifier('id')} = ?`,
      [id],
    );
    if (lengthResult.rows.length === 0 || lengthResult.rows.item(0).char_length === null) {
      row.pipeline_context_json = null;
      continue;
    }

    const charLength = Number(lengthResult.rows.item(0).char_length);
    if (!Number.isFinite(charLength) || charLength < 0) {
      throw new Error('pipeline_tasks.pipeline_context_json 长度无效');
    }
    const chunks: string[] = [];
    for (let offset = 1; offset <= charLength; offset += PIPELINE_TASK_CHUNK_SIZE_CHARS) {
      const chunkResult = await execute(
        db,
        `SELECT substr(CAST(${contextColumn} AS TEXT), ?, ?) AS ${quoteIdentifier('chunk')} FROM ${tableName} WHERE ${quoteIdentifier('id')} = ?`,
        [offset, PIPELINE_TASK_CHUNK_SIZE_CHARS, id],
      );
      if (chunkResult.rows.length === 0) {
        throw new Error(`pipeline_tasks 读取失败：${String(id)}`);
      }
      chunks.push(String(chunkResult.rows.item(0).chunk || ''));
    }
    row.pipeline_context_json = chunks.join('');
  }
  return rows;
}

async function allRows(db: SQLite.SQLiteDatabase, table: string): Promise<Record<string, any>[]> {
  if (table === 'pipeline_tasks') {
    const chunkedRows = await readPipelineTasksWithChunkedContext(db);
    if (chunkedRows) return chunkedRows;
  }
  const result = await execute(db, `SELECT * FROM ${table}`);
  const rows: Record<string, any>[] = [];
  for (let index = 0; index < result.rows.length; index += 1) {
    rows.push(result.rows.item(index));
  }
  return rows;
}

/**
 * Read every manifest table into the serialization shape. Core tables missing
 * on a pre-manifest database throw (fail-closed); optional tables are skipped
 * as empty arrays. Schema Recovery deliberately does not call this helper:
 * its startup path uses a dedicated bounded row/text stream instead of
 * materializing this complete table set.
 */
export async function readBackupTables(
  db: SQLite.SQLiteDatabase,
  options: { redactSensitive?: boolean } = {},
): Promise<Record<string, Record<string, any>[]>> {
  const tables: Record<string, Record<string, any>[]> = {};
  const availableTables = await existingTableNames(db);
  for (const table of BACKUP_MANIFEST) {
    if (!availableTables.has(table.name)) {
      if (CORE_TABLE_NAMES.has(table.name)) {
        throw new Error(`核心备份表缺失：${table.name}`);
      }
      // Avoid issuing a guaranteed-failing SELECT against an older schema.
      // This is particularly important during a pre-migration recovery backup:
      // the manifest already describes the target schema, while the live DB
      // still has the source schema.
      continue;
    }
    try {
      const rows = await allRows(db, table.name);
      tables[table.name] = options.redactSensitive
        ? rows
            .map(row => sanitizeBackupRow(table.name, row))
            .filter((row): row is Record<string, any> => row !== null)
        : rows;
      if (table.backupExcludedColumns?.length) {
        const excluded = new Set(table.backupExcludedColumns);
        tables[table.name] = tables[table.name].map(row => {
          const sanitized = { ...row };
          for (const key of excluded) delete sanitized[key];
          return sanitized;
        });
      }
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
    // 大库备份可达 100MB+：readFile 的原文字符串与 JSON.parse 的对象图必然短暂
    // 共存，因此解析一完成就立刻断开对原文的引用，让后续 checksum 阶段不再叠加
    // 第三份大内存（旧实现还把整个 payload 重新 stringify 一遍，直接 OOM）。
    let rawContent: string | null = await RNFS.readFile(path, 'utf8');
    const input = JSON.parse(rawContent);
    rawContent = null;
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
    const message = error?.message || String(error);
    const isOom = /OutOfMemory|Failed to allocate/i.test(String(message));
    return {
      parsed: null,
      validation: {
        valid: false,
        errors: [
          isOom
            ? `读取或解析备份失败：备份文件过大，设备内存不足（${message}）。请释放设备内存后重试。`
            : `读取或解析备份失败：${message}`,
        ],
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
  // 非核心表（如 outlines 等较新 schema 才有的表）在旧库上可能不存在，
  // SELECT 失败时跳过（空数组）而非中断整个备份——与 readBackupTables 的
  // 容错策略一致。核心表缺失才视为致命错误。
  const tables: Record<string, Record<string, any>[]> = {};
  const availableTables = await existingTableNames(db);
  const totalTables = BACKUP_MANIFEST.length;
  for (let i = 0; i < totalTables; i += 1) {
    const table = BACKUP_MANIFEST[i];
    if (!availableTables.has(table.name)) {
      if (CORE_TABLE_NAMES.has(table.name)) {
        throw new Error(`核心备份表缺失：${table.name}`);
      }
      tables[table.name] = [];
      report(((i + 1) / totalTables) * 50, `读取数据表 (${i + 1}/${totalTables})`);
      continue;
    }
    try {
      const rows = await allRows(db, table.name);
      tables[table.name] = rows
        .map(row => sanitizeBackupRow(table.name, row))
        .filter((row): row is Record<string, any> => row !== null);
      if (table.backupExcludedColumns?.length) {
        const excluded = new Set(table.backupExcludedColumns);
        tables[table.name] = tables[table.name].map(row => {
          const sanitized = { ...row };
          for (const key of excluded) delete sanitized[key];
          return sanitized;
        });
      }
    } catch (error) {
      if (CORE_TABLE_NAMES.has(table.name)) throw error;
      // 非核心表在旧 schema 库上可能缺失，跳过（记空数组）。
      tables[table.name] = [];
    }
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

  // CL-08: write the tiny sidecar right after the backup lands so the Backup
  // Center list never has to read the full file. Best-effort: a missing
  // sidecar degrades to filename/mtime/size + background backfill.
  try {
    const stat = await RNFS.stat(filePath);
    await writeBackupSidecar(filePath, {
      kind,
      appVersion,
      schemaVersion: Number(schemaVersion),
      createdAt: meta.created_at,
      size: Number(stat.size ?? 0),
      checksum: meta.checksum,
      validationState: 'created',
    });
  } catch {
    // non-fatal — list falls back to legacy display + backfill
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
    // CL-08: only complete backup JSON files are listed; sidecar files
    // (*.json.meta.json) are consumed, never listed.
    const jsonFiles = files.filter(
      file => file.name.endsWith('.json') && !file.name.endsWith(BACKUP_SIDECAR_SUFFIX),
    );
    const summaries: BackupSummary[] = [];

    for (const file of jsonFiles) {
      try {
        // 1. Tiny sidecar (readDir/stat + small meta only — NEVER the full
        //    backup JSON on the list hot path).
        const sidecar = await readBackupSidecar(sidecarPathFor(file.path));
        if (sidecar) {
          summaries.push({
            path: file.path,
            kind: sidecar.kind,
            appVersion: sidecar.appVersion,
            schemaVersion: sidecar.schemaVersion,
            createdAt: sidecar.createdAt || new Date(file.mtime || 0).toISOString(),
            size: sidecar.size || file.size,
            valid: true,
          });
          continue;
        }
        // 2. Legacy backup without a sidecar: display immediately from
        //    filename / mtime / size; the UI backfills the sidecar in the
        //    background (backfillBackupMeta) — never block the list.
        let kind: BackupKind = 'automatic';
        if (file.name.startsWith('manual_')) kind = 'manual';
        if (file.name.startsWith('prerestore_')) kind = 'pre_restore';
        if (file.name.startsWith('premigration_')) kind = 'pre_migration';
        if (file.name.startsWith('schemarecovery_')) kind = 'schema_recovery';
        summaries.push({
          path: file.path,
          kind,
          appVersion: '',
          schemaVersion: 0,
          createdAt: new Date(file.mtime || 0).toISOString(),
          size: file.size,
          valid: true,
          metaPending: true,
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
  // F2-05: best-effort remove the sidecar too — an orphaned
  // backup_xxx.json.meta.json must not survive the backup it describes.
  try {
    const sidecar = sidecarPathFor(path);
    if (await RNFS.exists(sidecar)) await RNFS.unlink(sidecar);
  } catch {
    // best-effort — the backup file itself is already gone
  }
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

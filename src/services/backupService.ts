import RNFS from 'react-native-fs';
import type SQLite from 'react-native-sqlite-storage';

const BACKUP_DIR = `${RNFS.ExternalDirectoryPath}/backups`;
const MAX_AUTOMATIC_BACKUPS = 3;
const MAX_MANUAL_BACKUPS = 10;
const MAX_PRE_RESTORE_BACKUPS = 3;

const CORE_TABLES = [
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
];

const ALL_TABLES = [
  ...CORE_TABLES,
  'project_resources',
  'llm_usage_logs',
  'pipeline_tasks',
  'freeform_documents',
  'content_revisions',
  'generation_drafts',
  'project_note_config',
  'note_style_profiles',
];

// Delete order: child tables first, then parent tables
const DELETE_ORDER = [
  'project_plotlines',
  'project_resources',
  'note_style_profiles',
  'fragments',
  'chapters',
  'characters',
  'worldbook_entries',
  'worldbook_collections',
  'plotlines',
  'notes',
  'presets',
  'llm_config',
  'settings',
  'llm_usage_logs',
  'pipeline_tasks',
  'freeform_documents',
  'content_revisions',
  'generation_drafts',
  'project_note_config',
  'projects',
];

// Insert order: parent tables first, then child tables (reverse of delete)
const INSERT_ORDER = [...DELETE_ORDER].reverse();

export interface BackupSummary {
  path: string;
  kind: 'automatic' | 'manual' | 'pre_restore';
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
}

interface BackupMeta {
  app_version: string;
  schema_version: number;
  created_at: string;
  table_count: number;
  row_count: number;
  kind: 'automatic' | 'manual' | 'pre_restore';
  checksum: string;
}

interface BackupV2 {
  format: 'shinewriter-backup';
  format_version: 2;
  meta: BackupMeta;
  tables: Record<string, any[]>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface BackupV1 {
  meta: {
    app_version: string;
    schema_version: string;
    backup_date: string;
    table_count: number;
  };
  tables: Record<string, any[]>;
}

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

async function allRows(db: SQLite.SQLiteDatabase, table: string): Promise<Record<string, any>[]> {
  const result = await execute(db, `SELECT * FROM ${table}`);
  const items: Record<string, any>[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    items.push(result.rows.item(i));
  }
  return items;
}

// 11.12 说明：该 checksum 非加密用途，仅用于检测备份完整性（写入后是否被篡改/损坏），
// 而非安全校验。charCodeAt 循环 O(n) 在大备份下偏慢但可接受，未引入 crypto 是为
// 兼容 RN 环境且避免额外原生依赖；如需强校验可后续替换为 sha256。
function computeChecksum(tables: Record<string, any[]>): string {
  const json = JSON.stringify(tables);
  // Simple deterministic fingerprint: string length + first 50 chars
  const len = json.length;
  const head = json.substring(0, 50);
  // Also compute a basic hash from char codes for better collision resistance
  let hash = 0;
  const prime = 2147483647; // large prime (2^31 - 1)
  for (let i = 0; i < json.length; i++) {
    hash = (hash * 31 + json.charCodeAt(i)) % prime;
  }
  return `${len}:${head}:${hash}`;
}

function countAllRows(tables: Record<string, any[]>): number {
  let total = 0;
  for (const table of ALL_TABLES) {
    total += (tables[table] || []).length;
  }
  return total;
}

export async function createBackup(
  db: SQLite.SQLiteDatabase,
  appVersion: string,
  schemaVersion: number,
  kind: 'automatic' | 'manual' | 'pre_restore' = 'automatic',
): Promise<string> {
  await RNFS.mkdir(BACKUP_DIR);

  const tables: Record<string, any[]> = {};
  for (const table of ALL_TABLES) {
    tables[table] = await allRows(db, table);
  }

  const checksum = computeChecksum(tables);
  const rowCount = countAllRows(tables);

  const backup: BackupV2 = {
    format: 'shinewriter-backup',
    format_version: 2,
    meta: {
      app_version: appVersion,
      schema_version: schemaVersion,
      created_at: new Date().toISOString(),
      table_count: ALL_TABLES.length,
      row_count: rowCount,
      kind,
      checksum,
    },
    tables,
  };

  const timestamp = Date.now();
  const kindPrefix = kind === 'manual' ? 'manual' : kind === 'pre_restore' ? 'prerestore' : 'backup';
  const fileName = `${kindPrefix}_v${appVersion}_${timestamp}.json`;
  const filePath = `${BACKUP_DIR}/${fileName}`;

  await RNFS.writeFile(filePath, JSON.stringify(backup), 'utf8');
  await cleanupOldBackups();

  return filePath;
}

export async function createManualBackup(
  db: SQLite.SQLiteDatabase,
  appVersion: string,
  schemaVersion: number,
): Promise<string> {
  return createBackup(db, appVersion, schemaVersion, 'manual');
}

export async function createPreRestoreBackup(
  db: SQLite.SQLiteDatabase,
  appVersion: string,
  schemaVersion: number,
): Promise<string> {
  return createBackup(db, appVersion, schemaVersion, 'pre_restore');
}

export async function validateBackup(path: string): Promise<BackupValidation> {
  const errors: string[] = [];
  let appVersion: string | undefined;
  let schemaVersion: number | undefined;
  let tableCount: number | undefined;
  let rowCount: number | undefined;

  try {
    const content = await RNFS.readFile(path, 'utf8');
    const backup = JSON.parse(content);

    // Detect v1 format (no format/format_version fields)
    if (!backup.format && !backup.format_version) {
      // v1 backup — accept for backward compat
      if (!backup.meta || !backup.tables) {
        errors.push('v1 备份缺少 meta 或 tables 字段');
      } else {
        appVersion = backup.meta.app_version;
        schemaVersion = backup.meta.schema_version
          ? Number(backup.meta.schema_version)
          : undefined;
        tableCount = backup.meta.table_count;
        rowCount = countAllRows(backup.tables);

        // Check required tables (only core tables are mandatory)
        for (const table of CORE_TABLES) {
          if (!(table in backup.tables)) {
            errors.push(`缺少表: ${table}`);
          }
        }
      }

      return {
        valid: errors.length === 0,
        errors,
        appVersion,
        schemaVersion,
        tableCount,
        rowCount,
      };
    }

    // v2 format
    if (backup.format !== 'shinewriter-backup') {
      errors.push(`format 字段不正确: ${backup.format}`);
    }

    if (backup.format_version !== 2 && backup.format_version !== 1) {
      errors.push(`不支持的 format_version: ${backup.format_version}`);
    }

    if (!backup.meta || !backup.tables) {
      errors.push('备份缺少 meta 或 tables 字段');
      return { valid: false, errors, appVersion, schemaVersion, tableCount, rowCount };
    }

    appVersion = backup.meta.app_version;
    schemaVersion = backup.meta.schema_version;
    tableCount = backup.meta.table_count;
    rowCount = backup.meta.row_count ?? countAllRows(backup.tables);

    // Check required tables (only core tables are mandatory)
    for (const table of CORE_TABLES) {
      if (!(table in backup.tables)) {
        errors.push(`缺少表: ${table}`);
      }
    }

    // Verify checksum
    if (backup.meta.checksum) {
      const actualChecksum = computeChecksum(backup.tables);
      if (actualChecksum !== backup.meta.checksum) {
        errors.push('校验和不匹配，备份可能已损坏');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      appVersion,
      schemaVersion,
      tableCount,
      rowCount,
    };
  } catch (e: any) {
    errors.push(`读取或解析备份失败: ${e.message || String(e)}`);
    return { valid: false, errors, appVersion, schemaVersion, tableCount, rowCount };
  }
}

export async function listBackups(): Promise<BackupSummary[]> {
  try {
    await RNFS.mkdir(BACKUP_DIR);
    const files = await RNFS.readDir(BACKUP_DIR);
    const jsonFiles = files.filter(
      f => f.name.endsWith('.json'),
    );

    const summaries: BackupSummary[] = [];

    for (const file of jsonFiles) {
      try {
        const content = await RNFS.readFile(file.path, 'utf8');
        const backup = JSON.parse(content);

        let kind: 'automatic' | 'manual' | 'pre_restore' = 'automatic';
        let appVersion = '';
        let schemaVersion = 0;
        let createdAt = '';

        if (backup.format === 'shinewriter-backup' && backup.format_version >= 2) {
          kind = backup.meta.kind || 'automatic';
          appVersion = backup.meta.app_version || '';
          schemaVersion = backup.meta.schema_version || 0;
          createdAt = backup.meta.created_at || '';
        } else {
          // v1 format — infer kind from filename
          if (file.name.startsWith('manual_')) {
            kind = 'manual';
          } else if (file.name.startsWith('prerestore_')) {
            kind = 'pre_restore';
          }
          appVersion = backup.meta?.app_version || '';
          schemaVersion = backup.meta?.schema_version
            ? Number(backup.meta.schema_version)
            : 0;
          createdAt = backup.meta?.backup_date || '';
        }

        const validation = await validateBackup(file.path);

        summaries.push({
          path: file.path,
          kind,
          appVersion,
          schemaVersion,
          createdAt: createdAt || new Date(file.mtime || 0).toISOString(),
          size: file.size,
          valid: validation.valid,
        });
      } catch {
        // Unparseable file — still include as invalid
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

    // Sort newest first
    summaries.sort((a, b) => {
      const timeA = new Date(a.createdAt).getTime();
      const timeB = new Date(b.createdAt).getTime();
      return timeB - timeA;
    });

    return summaries;
  } catch {
    return [];
  }
}

export async function restoreFromBackup(
  db: SQLite.SQLiteDatabase,
  backupPath: string,
): Promise<void> {
  // Validate first
  const validation = await validateBackup(backupPath);
  if (!validation.valid) {
    throw new Error(`备份验证失败: ${validation.errors.join('; ')}`);
  }

  const content = await RNFS.readFile(backupPath, 'utf8');
  const backup = JSON.parse(content);

  // Use a single transaction for atomic restore
  await db.transaction(async (tx) => {
    const txx = tx as unknown as SQLite.SQLiteDatabase;

    // Delete in order: child tables first
    for (const table of DELETE_ORDER) {
      await execute(txx, `DELETE FROM ${table}`);
    }

    // Insert in reverse order: parent tables first
    for (const table of INSERT_ORDER) {
      const rows: Record<string, any>[] = backup.tables?.[table] || [];
      for (const row of rows) {
        // 11.13 说明：llm_config 行跳过 api_key 字段，因为明文密钥不入库——
        // 运行时 API Key 按 llm_config.id 走 Android Keystore（react-native-keychain），
        // 备份文件中即使残留 api_key 也不可恢复（密钥不在备份范围内），故此处显式过滤，
        // 避免把历史遗留的明文/空值写回 llm_config.api_key 列。
        const keys = Object.keys(row).filter(k => {
          if (table === 'llm_config' && k === 'api_key') return false;
          return true;
        });
        const placeholders = keys.map(() => '?').join(', ');
        const values = keys.map(k => row[k]);
        await execute(
          txx,
          `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
          values,
        );
      }
    }
  });
}

export async function deleteBackup(path: string): Promise<void> {
  const exists = await RNFS.exists(path);
  if (exists) {
    await RNFS.unlink(path);
  }
}

export async function cleanupOldBackups(): Promise<void> {
  try {
    const summaries = await listBackups();

    const byKind: Record<string, BackupSummary[]> = {
      automatic: [],
      manual: [],
      pre_restore: [],
    };

    for (const s of summaries) {
      if (byKind[s.kind]) {
        byKind[s.kind].push(s);
      }
    }

    // Already sorted newest first by listBackups
    const limits: Record<string, number> = {
      automatic: MAX_AUTOMATIC_BACKUPS,
      manual: MAX_MANUAL_BACKUPS,
      pre_restore: MAX_PRE_RESTORE_BACKUPS,
    };

    for (const [kind, list] of Object.entries(byKind)) {
      const limit = limits[kind] ?? MAX_AUTOMATIC_BACKUPS;
      // Delete oldest beyond the limit
      for (let i = limit; i < list.length; i++) {
        await deleteBackup(list[i].path);
      }
    }
  } catch {
    // 目录不存在或读取失败，忽略
  }
}

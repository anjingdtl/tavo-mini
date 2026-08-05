/**
 * 召回潜在数据：只读扫描模块。
 *
 * 扫描三个源：
 *   A. 当前库（schema 漂移诊断 + 召回表行数 + 键集合）
 *   B. ${DocumentDirectoryPath}/schema-recovery/*.json（恢复点）
 *   C. ${ExternalDirectoryPath}/backups/*.json（用户备份）
 *
 * 本模块绝不开写事务。任何修复/合并动作由 recallMerger 在用户确认后执行。
 */
import RNFS from 'react-native-fs';
import type SQLite from 'react-native-sqlite-storage';
import { execute } from '../../data/connection/execute';
import { openDatabase } from '../../data/connection/openDatabase';
import { inspectKnownSchemaDrift } from '../../data/schema/schemaDriftInspector';
import { readAndValidateBackup } from '../backupService';
import { SCHEMA_RECOVERY_DIR } from '../schemaRecoveryBackup';
import {
  RECALL_TABLES,
  RECALL_KEY_COLUMNS,
  keyOf,
  type RecallTable,
  type RecallScanReport,
  type CurrentDbFinding,
  type BackupSourceFinding,
} from './recallTypes';

const BACKUP_DIR = `${RNFS.ExternalDirectoryPath}/backups`;
const RECALL_CHUNK_SIZE = 2000;

export async function scanRecallSources(): Promise<RecallScanReport> {
  const currentDb = await scanCurrentDb();
  const schemaRecoverySources = await scanDir(
    SCHEMA_RECOVERY_DIR,
    'schema-recovery',
    currentDb.existingKeys,
  );
  const backupSources = await scanDir(
    BACKUP_DIR,
    'backup-json',
    currentDb.existingKeys,
  );
  const sources = [...schemaRecoverySources, ...backupSources].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  return { scannedAt: Date.now(), currentDb, sources };
}

async function scanCurrentDb(): Promise<CurrentDbFinding> {
  const db = await openDatabase();
  const schemaDrift = await inspectKnownSchemaDrift(db);

  const rowCount = {} as Record<RecallTable, number>;
  const existingKeys = {} as Record<RecallTable, string[]>;
  let allReadable = true;

  for (const table of RECALL_TABLES) {
    try {
      const r = await execute(db, `SELECT COUNT(*) AS c FROM ${table}`);
      rowCount[table] = Number(r.rows.item(0)?.c ?? 0);
      existingKeys[table] = await readExistingKeys(db, table);
    } catch {
      rowCount[table] = -1;
      existingKeys[table] = [];
      allReadable = false;
    }
  }

  const reachable = allReadable;
  return { reachable, schemaDrift, rowCount, existingKeys };
}

/** 读取一张表当前已有的键字符串集合（分块）。scanner 和 merger 共用。 */
export async function readExistingKeys(
  db: SQLite.SQLiteDatabase,
  table: RecallTable,
): Promise<string[]> {
  const cols = RECALL_KEY_COLUMNS[table];
  const colList = cols.join(', ');
  const keys: string[] = [];
  let offset = 0;
  while (true) {
    const batch = await execute(
      db,
      `SELECT ${colList} FROM ${table} LIMIT ? OFFSET ?`,
      [RECALL_CHUNK_SIZE, offset],
    );
    const len = batch.rows.length;
    for (let i = 0; i < len; i++) {
      keys.push(keyOf(table, batch.rows.item(i)));
    }
    if (len < RECALL_CHUNK_SIZE) break;
    offset += RECALL_CHUNK_SIZE;
  }
  return keys;
}

async function scanDir(
  dir: string,
  sourceId: 'schema-recovery' | 'backup-json',
  currentKeys: Record<RecallTable, string[]>,
): Promise<BackupSourceFinding[]> {
  let files: RNFS.ReadDirItem[] = [];
  try {
    files = await RNFS.readDir(dir);
  } catch {
    return [];
  }
  const findings: BackupSourceFinding[] = [];
  for (const f of files.filter(f => f.name.endsWith('.json'))) {
    const finding = await parseBackupFile(f, sourceId, currentKeys);
    if (finding) findings.push(finding);
  }
  return findings;
}

async function parseBackupFile(
  file: RNFS.ReadDirItem,
  sourceId: 'schema-recovery' | 'backup-json',
  currentKeys: Record<RecallTable, string[]>,
): Promise<BackupSourceFinding | null> {
  const { parsed, validation } = await readAndValidateBackup(file.path);

  const rowCount = {} as Record<RecallTable, number>;
  const recoverable = {} as Record<RecallTable, number>;

  for (const table of RECALL_TABLES) {
    const sourceRows = parsed?.tables[table] ?? [];
    rowCount[table] = sourceRows.length;
    const currentSet = new Set(currentKeys[table]);
    let missing = 0;
    for (const row of sourceRows) {
      if (!currentSet.has(keyOf(table, row))) missing++;
    }
    recoverable[table] = missing;
  }

  return {
    sourceId,
    filePath: file.path,
    fileName: file.name,
    kind: parsed?.kind ?? 'unknown',
    createdAt:
      parsed?.createdAt ?? new Date(Number(file.mtime ?? 0)).toISOString(),
    schemaVersion: parsed?.schemaVersion ?? 0,
    appVersion: parsed?.appVersion ?? '',
    sizeBytes: file.size,
    valid: validation.valid,
    invalidReason: validation.valid ? undefined : validation.errors.join('; '),
    rowCount,
    recoverable,
  };
}

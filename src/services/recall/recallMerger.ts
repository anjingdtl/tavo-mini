/**
 * 召回潜在数据：合并执行模块。
 *
 * 严格顺序：
 *   1. 强制 createSchemaRecoveryBackup（失败即中止，不动数据）
 *   2. 合并前 captureUserDataRecallSnapshot
 *   3. 源 A：repairKnownSchemaDrift（若勾选）
 *   4. 源 B/C：按 merge order 对每个勾选源 INSERT OR IGNORE 缺失行
 *   5. 合并后 captureUserDataRecallSnapshot + compareRecallSnapshots
 *   6. 状态判定
 *
 * 安全不变量：绝不 DELETE/UPDATE 现有行；合并用 INSERT OR IGNORE + 主键预检。
 */
import type SQLite from 'react-native-sqlite-storage';
import SQLiteModule from 'react-native-sqlite-storage';
import { openDatabase } from '../../data/connection/openDatabase';
import { executeTransaction, type SqlStatement } from '../database/transaction';
import { SCHEMA_MANIFEST } from '../database/schemaManifest';
import { readAndValidateBackup } from '../backupService';
import { createSchemaRecoveryBackup } from '../schemaRecoveryBackup';
import { inspectKnownSchemaDrift } from '../../data/schema/schemaDriftInspector';
import {
  repairKnownSchemaDrift,
} from '../../data/schema/knownSchemaRepairs';
import type { SchemaRepairResult } from '../../data/schema/knownSchemaRepairs';
import {
  captureUserDataRecallSnapshot,
} from '../../data/schema/userDataRecallSnapshot';
import type {
  UserDataRecallSnapshot,
  RecallMismatch,
} from '../../data/schema/userDataRecallSnapshot';
import {
  RECALL_MERGE_ORDER,
  keyOf,
  type RecallTable,
  type RecallSelection,
  type RecallResult,
  type RecallErrorCode,
} from './recallTypes';
import { readExistingKeys } from './recallScanner';

/** 健壮地从任意 thrown 值提取可读消息。 */
function extractMessage(e: unknown): string {
  if (e == null) return '未知错误';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message || e.toString();
  if (typeof e === 'object' && 'message' in e) {
    const m = (e as any).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  // SchemaRecoveryError 等结构化错误可能把详情放在 code / errors 字段
  if (typeof e === 'object') {
    const code = (e as any).code;
    const errors = (e as any).errors;
    if (typeof code === 'string' || (Array.isArray(errors) && errors.length > 0)) {
      return [code, ...(Array.isArray(errors) ? errors : [])].filter(Boolean).join('; ');
    }
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * 当 openDatabase()（含 initializeDatabase）失败时，降级到直接打开原始 SQLite
 * 连接，绕过启动初始化链路。这样即使数据库 schema 损坏/漂移导致启动校验
 * fail-closed，召回功能仍能拿到原始连接执行修复操作。
 */
async function openRawDatabase(): Promise<SQLite.SQLiteDatabase> {
  SQLiteModule.enablePromise(true);
  return SQLiteModule.openDatabase({ name: 'shine_writer.db', location: 'default' });
}

export async function applyRecall(
  selection: RecallSelection,
): Promise<RecallResult> {
  if (!selection.repairCurrentDbDrift && selection.sourceFilePaths.length === 0) {
    return failedResult('NO_SELECTION', '未选择任何召回操作');
  }

  let db: SQLite.SQLiteDatabase;
  try {
    db = await openDatabase();
  } catch (openErr: any) {
    // openDatabase() 内部调 initializeDatabase——如果启动校验 fail-closed
    // （schema 漂移、召回快照不一致等），整个连接会被作废。但底层的 SQLite
    // 连接其实已打开，只是初始化没过。降级到直接打开原始连接，让召回/修复
    // 仍能操作数据库。
    try {
      db = await openRawDatabase();
    } catch (rawErr: any) {
      return failedResult(
        'DB_OPEN_FAILED',
        `无法打开数据库：${extractMessage(openErr)}（原始连接也失败：${extractMessage(rawErr)}）`,
      );
    }
  }

  // 1. 强制恢复备份（任何写操作之前）。失败立即返回，不动数据。
  let recoveryBackupPath: string;
  try {
    const backup = await createSchemaRecoveryBackup(db, 'schema_recovery');
    recoveryBackupPath = backup.path;
  } catch (e: any) {
    return failedResult(
      'RECOVERY_BACKUP_FAILED',
      `恢复备份失败：${extractMessage(e)}`,
    );
  }

  // 2. 合并前召回快照
  const beforeSnapshot = await captureUserDataRecallSnapshot(db);

  const applied: Partial<Record<RecallTable, { inserted: number; skipped: number }>> = {};
  let driftRepairResult: SchemaRepairResult | undefined;
  const errors: string[] = [];

  // 3. 源 A：漂移修复
  if (selection.repairCurrentDbDrift) {
    try {
      const report = await inspectKnownSchemaDrift(db);
      const repairResult = await repairKnownSchemaDrift(db, report);
      driftRepairResult = repairResult;
      if (!repairResult.ok) {
        errors.push(`漂移修复未成功：${repairResult.message}`);
      }
    } catch (e: any) {
      errors.push(`漂移修复失败：${extractMessage(e)}`);
    }
  }

  // 4. 源 B/C：按 merge order 合并每个勾选源
  for (const filePath of selection.sourceFilePaths) {
    try {
      const { parsed } = await readAndValidateBackup(filePath);
      if (!parsed) {
        errors.push(`${filePath}: 解析失败或校验未通过`);
        continue;
      }
      await mergeFromBackup(db, parsed.tables, applied);
    } catch (e: any) {
      errors.push(`${filePath}: ${extractMessage(e)}`);
    }
  }

  // 5. 合并后召回快照 + 非递减守卫
  // 召回语义是"只增不减"：合并后的资料必须是合并前的超集。
  // 注意：不能用 compareRecallSnapshots——它对 characters/worldbook/notes
  // 要求严格 id 集合相等，而召回的目的正是增加这些行。
  const afterSnapshot = await captureUserDataRecallSnapshot(db);
  const recallMismatch = assertRecallNonDecreasing(beforeSnapshot, afterSnapshot);

  // 6. 状态判定
  let status: RecallResult['status'];
  if (recallMismatch) {
    status = 'failed';
  } else if (errors.length > 0) {
    status = 'partial';
  } else {
    status = 'success';
  }

  return {
    status,
    recoveryBackupPath,
    beforeSnapshot,
    afterSnapshot,
    recallMismatch,
    driftRepairResult,
    applied,
    error:
      errors.length > 0
        ? {
            code: recallMismatch ? 'RECALL_MISMATCH' : 'SOURCE_INSERT_FAILED',
            message: errors.join('\n'),
          }
        : undefined,
  };
}

async function mergeFromBackup(
  db: SQLite.SQLiteDatabase,
  tables: Record<string, Record<string, any>[]>,
  appliedAcc: Partial<Record<RecallTable, { inserted: number; skipped: number }>>,
): Promise<void> {
  for (const table of RECALL_MERGE_ORDER) {
    const rows = tables[table];
    if (!Array.isArray(rows) || rows.length === 0) continue;

    const { inserted, skipped } = await insertMissingRows(db, table, rows);
    const prev = appliedAcc[table] ?? { inserted: 0, skipped: 0 };
    appliedAcc[table] = {
      inserted: prev.inserted + inserted,
      skipped: prev.skipped + skipped,
    };
  }
}

/** 取 row 的列与该表 manifest 列的交集（列投影）。 */
function projectColumns(
  table: RecallTable,
  row: Record<string, any>,
): { columns: string[]; values: any[] } {
  const manifestCols = new Set(
    SCHEMA_MANIFEST.find(t => t.name === table)?.columns ?? [],
  );
  const columns: string[] = [];
  const values: any[] = [];
  for (const [col, val] of Object.entries(row)) {
    if (manifestCols.has(col)) {
      columns.push(col);
      values.push(val);
    }
  }
  return { columns, values };
}

async function insertMissingRows(
  db: SQLite.SQLiteDatabase,
  table: RecallTable,
  rows: Record<string, any>[],
): Promise<{ inserted: number; skipped: number }> {
  const existingKeys = new Set(await readExistingKeys(db, table));
  const statements: SqlStatement[] = [];
  let inserted = 0;
  let skipped = 0;

  for (const row of rows) {
    const k = keyOf(table, row);
    if (existingKeys.has(k)) {
      skipped++;
      continue;
    }
    const { columns, values } = projectColumns(table, row);
    if (columns.length === 0) {
      skipped++;
      continue;
    }
    const placeholders = columns.map(() => '?').join(', ');
    statements.push({
      sql: `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
      params: values,
    });
    // 乐观计入 inserted；INSERT OR IGNORE 若遇约束冲突 rowsAffected=0，
    // 但因主键已预检，冲突极少。同源内重复 id 也通过 add 防止二次插入。
    inserted++;
    existingKeys.add(k);
  }

  if (statements.length > 0) {
    await executeTransaction(db, statements, { faultDomain: 'restore' });
  }

  return { inserted, skipped };
}

/**
 * 召回专用非递减守卫：合并后每张表的 id 集合必须是合并前的超集（只增不减）。
 *
 * 与 userDataRecallSnapshot 的 compareRecallSnapshots 不同——后者对
 * characters/worldbook/notes 要求严格 id 集合相等（用于迁移场景，断言无变化）；
 * 召回场景的目的正是增加这些行，因此采用"超集"语义：after 的每个 id 必须包含
 * before 的所有 id，after 可以有 before 没有的 id（召回成功的表现）。
 * 唯一的失败是 before 有某个 id 而 after 没有（数据丢失）。
 */
function assertRecallNonDecreasing(
  before: UserDataRecallSnapshot,
  after: UserDataRecallSnapshot,
): RecallMismatch | null {
  const identityTables: Array<{
    table: string;
    before: typeof before.characters;
    after: typeof after.characters;
  }> = [
    { table: 'projects', before: before.projects, after: after.projects },
    { table: 'chapters', before: before.chapters, after: after.chapters },
    {
      table: 'character_collections',
      before: before.characterCollections,
      after: after.characterCollections,
    },
    { table: 'characters', before: before.characters, after: after.characters },
    {
      table: 'worldbook_collections',
      before: before.worldbookCollections,
      after: after.worldbookCollections,
    },
    {
      table: 'worldbook_entries',
      before: before.worldbookEntries,
      after: after.worldbookEntries,
    },
    { table: 'notes', before: before.notes, after: after.notes },
  ];
  for (const entry of identityTables) {
    const afterSet = new Set(entry.after.ids);
    const missing = entry.before.ids.filter(id => !afterSet.has(id));
    if (missing.length > 0) {
      return {
        table: entry.table,
        reason: `${missing.length} id(s) lost during recall`,
        beforeCount: entry.before.count,
        afterCount: entry.after.count,
        missingIds: missing,
      };
    }
  }
  const linkTables: Array<{
    table: string;
    before: typeof before.projectResources;
    after: typeof after.projectResources;
  }> = [
    {
      table: 'project_resources',
      before: before.projectResources,
      after: after.projectResources,
    },
    {
      table: 'project_collection_settings',
      before: before.projectCollectionSettings,
      after: after.projectCollectionSettings,
    },
  ];
  for (const entry of linkTables) {
    const afterSet = new Set(entry.after.keys);
    const missing = entry.before.keys.filter(k => !afterSet.has(k));
    if (missing.length > 0) {
      return {
        table: entry.table,
        reason: `${missing.length} composite key(s) lost during recall`,
        beforeCount: entry.before.count,
        afterCount: entry.after.count,
      };
    }
  }
  return null;
}

function failedResult(code: RecallErrorCode, message: string): RecallResult {
  return {
    status: 'failed',
    recoveryBackupPath: '',
    beforeSnapshot: {} as any,
    afterSnapshot: {} as any,
    recallMismatch: null,
    applied: {},
    error: { code, message },
  };
}

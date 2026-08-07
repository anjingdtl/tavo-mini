/**
 * F2-04: Schema Recovery backup metadata 必须记录源库 Schema（修复前稳定失败）。
 *
 * 修复前 createSchemaRecoveryBackup 把 meta.schema_version 写成目标
 * SCHEMA_VERSION（42）——备份描述的是「升级目标」，而不是被备份内容的
 * 「源库 Schema」。恢复者无法据此知道备份来自哪个旧版本。
 *
 * 本测试加载真实历史 SQLite fixture（schema-34.db，含真实用户数据），
 * 走真实 initializeDatabase 升级路径（34 → 42），然后在 schema-recovery
 * 目录找到 pre-migration 备份并解析：
 *
 *   meta.schema_version === 34（源库真实 Schema）
 */
import fs from 'fs';
import path from 'path';
import initSqlJsNs from 'sql.js';
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';
import { initializeDatabase } from '../src/data/schema/initializeDatabase';
import { createSchemaRecoveryBackup, SCHEMA_RECOVERY_DIR } from '../src/services/schemaRecoveryBackup';
import { wrapSqlJsDb, type InMemorySqliteDb } from './helpers/canonInMemoryDb';
import { setupInMemoryFs } from './schema40-fixture-helpers';

const initSqlJs: (config?: {
  locateFile?: (file: string) => string;
}) => Promise<{ Database: new (bytes?: Uint8Array) => any }> =
  ((initSqlJsNs as unknown as {
    default?: (config?: { locateFile?: (file: string) => string }) => Promise<{ Database: new (bytes?: Uint8Array) => any }>;
  }).default ??
    (initSqlJsNs as unknown as (config?: { locateFile?: (file: string) => string }) => Promise<{ Database: new (bytes?: Uint8Array) => any }>));

let testDb: InMemorySqliteDb | null = null;
let files: Map<string, string>;

async function loadFixtureDb(version: number): Promise<InMemorySqliteDb> {
  const fixturePath = path.join(
    __dirname,
    'fixtures',
    'databases',
    `schema-${version}.db`,
  );
  const bytes = fs.readFileSync(fixturePath);
  const SQL = await initSqlJs({
    locateFile: (file: string) =>
      path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
  });
  const db = new SQL.Database(new Uint8Array(bytes));
  db.run('PRAGMA foreign_keys = ON');
  const wrapped = wrapSqlJsDb(db);
  __setDatabaseForTest(wrapped as any);
  return wrapped;
}

async function findRecoveryBackupFiles(): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  for (const [filePath, content] of files) {
    if (filePath.startsWith(SCHEMA_RECOVERY_DIR) && filePath.endsWith('.json')) {
      out.push({ path: filePath, content });
    }
  }
  return out;
}

afterEach(() => {
  __resetForTest();
  if (testDb) {
    try {
      testDb.close();
    } catch {
      /* ignore */
    }
    testDb = null;
  }
});

describe('F2-04: schema recovery metadata 记录源 Schema', () => {
  jest.setTimeout(120_000);

  it('真实 Schema-34 fixture 升级：pre-migration 备份 meta.schema_version === 34', async () => {
    files = setupInMemoryFs();
    testDb = await loadFixtureDb(34);
    await initializeDatabase(testDb as any);

    const backups = await findRecoveryBackupFiles();
    expect(backups.length).toBeGreaterThan(0);
    for (const backup of backups) {
      const parsed = JSON.parse(backup.content);
      expect(parsed.meta.kind).toBe('pre_migration');
      expect(parsed.meta.schema_version).toBe(34);
    }
  });

  it('直接调用 createSchemaRecoveryBackup 显式传源版本 38', async () => {
    files = setupInMemoryFs();
    testDb = await loadFixtureDb(34);
    // 显式 sourceSchemaVersion=38：备份 meta 必须记录 38 而非 SCHEMA_VERSION。
    await createSchemaRecoveryBackup(testDb as any, 'pre_migration', 38);

    const backups = await findRecoveryBackupFiles();
    expect(backups.length).toBe(1);
    const parsed = JSON.parse(backups[0].content);
    expect(parsed.meta.schema_version).toBe(38);
  });

  it('不传源版本时默认当前 SCHEMA_VERSION（向后兼容）', async () => {
    files = setupInMemoryFs();
    testDb = await loadFixtureDb(34);
    await createSchemaRecoveryBackup(testDb as any, 'schema_recovery');

    const backups = await findRecoveryBackupFiles();
    expect(backups.length).toBe(1);
    const parsed = JSON.parse(backups[0].content);
    expect(parsed.meta.schema_version).toBe(42);
  });
});

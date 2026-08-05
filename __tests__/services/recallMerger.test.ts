import RNFS from 'react-native-fs';
import { createCanonInMemoryDb, type InMemorySqliteDb } from '../helpers/canonInMemoryDb';
import { __setDatabaseForTest, __resetForTest } from '../../src/data/connection/openDatabase';
import { setupInMemoryFs } from '../schema40-fixture-helpers';
import { createBackup } from '../../src/services/backupService';
import { SCHEMA_RECOVERY_DIR } from '../../src/services/schemaRecoveryBackup';
import { applyRecall } from '../../src/services/recall/recallMerger';

/** Seed characters into a given db (for current-db setup) */
async function seedCharacters(db: InMemorySqliteDb, ids: number[]) {
  await db.executeSql(
    `INSERT OR IGNORE INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
  );
  for (const id of ids) {
    await db.executeSql(
      `INSERT OR REPLACE INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at)
       VALUES (${id}, 1, 0, 'c${id}', 'manual', '{}', 0, 0, 't')`,
    );
  }
}

/** Generate a backup JSON (via a separate throwaway db) and place it at a known source path */
async function makeSourceBackup(
  files: Map<string, string>,
  sourcePath: string,
  seed: (db: InMemorySqliteDb) => Promise<void>,
): Promise<void> {
  const tmpDb = await createCanonInMemoryDb();
  try {
    await seed(tmpDb);
    const realPath = await createBackup(tmpDb as any, '2.11.24', 40, 'manual');
    const content = files.get(realPath);
    if (content === undefined) throw new Error('backup not written to in-memory fs');
    files.set(sourcePath, content);
  } finally {
    try { tmpDb.close(); } catch { /* noop */ }
  }
}

describe('recallMerger', () => {
  let db: InMemorySqliteDb;
  let files: Map<string, string>;

  beforeEach(async () => {
    __resetForTest();
    files = setupInMemoryFs();
    db = await createCanonInMemoryDb();
    __setDatabaseForTest(db as any);
  });

  afterEach(() => {
    __resetForTest();
    try { db.close(); } catch { /* noop */ }
  });

  it('M1: 源里 3 个新 id + 5 个重复 → inserted=3, skipped=5', async () => {
    // current db has characters 1-5
    await seedCharacters(db, [1, 2, 3, 4, 5]);
    // source backup has characters 1-8 (separate db)
    const sourcePath = `${SCHEMA_RECOVERY_DIR}/s.json`;
    await makeSourceBackup(files, sourcePath, async (d) => {
      await seedCharacters(d, [1, 2, 3, 4, 5, 6, 7, 8]);
    });

    const result = await applyRecall({
      repairCurrentDbDrift: false,
      sourceFilePaths: [sourcePath],
    });
    expect(result.status).toBe('success');
    expect(result.applied.characters?.inserted).toBe(3);
    expect(result.applied.characters?.skipped).toBe(5);
    const [cnt] = await db.executeSql(`SELECT COUNT(*) AS c FROM characters`);
    expect(cnt.rows.item(0).c).toBe(8);
  });

  it('M2: 全部重复 → inserted=0, skipped=5', async () => {
    await seedCharacters(db, [1, 2, 3, 4, 5]);
    const sourcePath = `${SCHEMA_RECOVERY_DIR}/s.json`;
    await makeSourceBackup(files, sourcePath, async (d) => {
      await seedCharacters(d, [1, 2, 3, 4, 5]);
    });

    const result = await applyRecall({
      repairCurrentDbDrift: false,
      sourceFilePaths: [sourcePath],
    });
    expect(result.applied.characters?.inserted).toBe(0);
    expect(result.applied.characters?.skipped).toBe(5);
  });

  it('M3: 勾选漂移修复 + 库有漂移 → driftRepairResult 非空且资料表行数不变', async () => {
    // 制造漂移：sql.js 不支持 DROP COLUMN，重建表模拟缺列
    await db.executeSql(`ALTER TABLE canon_evidence RENAME TO canon_evidence_full`);
    await db.executeSql(
      `CREATE TABLE canon_evidence AS SELECT id, project_id, source_id, snapshot_id,
       chapter_id, chapter_position, paragraph_start, paragraph_end,
       char_start, char_end, quote_preview, quote_sha256, analysis_run_id, created_at
       FROM canon_evidence_full`,
    );
    await db.executeSql(`DROP TABLE canon_evidence_full`);
    await seedCharacters(db, [1, 2]);

    const result = await applyRecall({
      repairCurrentDbDrift: true,
      sourceFilePaths: [],
    });
    expect(result.driftRepairResult).toBeDefined();
    expect(result.driftRepairResult!.ok).toBe(true);
    const [cnt] = await db.executeSql(`SELECT COUNT(*) AS c FROM characters`);
    expect(cnt.rows.item(0).c).toBe(2);
  });

  it('M4: 未勾选任何项 → status=failed, NO_SELECTION', async () => {
    const result = await applyRecall({
      repairCurrentDbDrift: false,
      sourceFilePaths: [],
    });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('NO_SELECTION');
  });

  it('M5: 恢复备份失败 → status=failed, RECOVERY_BACKUP_FAILED, 库未改动', async () => {
    // 让 mkdir（createSchemaRecoveryBackup 内部第一步）失败
    (RNFS.mkdir as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
    await seedCharacters(db, [1]);

    const result = await applyRecall({
      repairCurrentDbDrift: false,
      sourceFilePaths: ['whatever.json'],
    });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('RECOVERY_BACKUP_FAILED');
    const [cnt] = await db.executeSql(`SELECT COUNT(*) AS c FROM characters`);
    expect(cnt.rows.item(0).c).toBe(1);
  });

  it('M6: 合并前 ⊂ 合并后 → recallMismatch=null, status=success', async () => {
    await seedCharacters(db, [1]);
    const sourcePath = `${SCHEMA_RECOVERY_DIR}/s.json`;
    await makeSourceBackup(files, sourcePath, async (d) => {
      await seedCharacters(d, [1, 2, 3]);
    });

    const result = await applyRecall({
      repairCurrentDbDrift: false,
      sourceFilePaths: [sourcePath],
    });
    expect(result.recallMismatch).toBeNull();
    expect(result.status).toBe('success');
  });

  it('M9: 关联表 project_resources 打包召回', async () => {
    // current: project 1 + character 1, no project_resources
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    await seedCharacters(db, [1]);
    // source: has project_resources row
    const sourcePath = `${SCHEMA_RECOVERY_DIR}/s.json`;
    await makeSourceBackup(files, sourcePath, async (d) => {
      await d.executeSql(
        `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
      );
      await seedCharacters(d, [1]);
      await d.executeSql(
        `INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (1, 'character', 1, 1)`,
      );
    });

    const result = await applyRecall({
      repairCurrentDbDrift: false,
      sourceFilePaths: [sourcePath],
    });
    expect(result.applied.project_resources?.inserted).toBe(1);
    const [cnt] = await db.executeSql(`SELECT COUNT(*) AS c FROM project_resources`);
    expect(cnt.rows.item(0).c).toBe(1);
  });

  it('M10: 两个源都勾选 → applied 累加', async () => {
    await seedCharacters(db, [1]);
    const sourcePath1 = `${SCHEMA_RECOVERY_DIR}/s1.json`;
    const sourcePath2 = `${SCHEMA_RECOVERY_DIR}/s2.json`;
    await makeSourceBackup(files, sourcePath1, async (d) => {
      await seedCharacters(d, [1, 2]);
    });
    await makeSourceBackup(files, sourcePath2, async (d) => {
      await seedCharacters(d, [1, 3, 4]);
    });

    const result = await applyRecall({
      repairCurrentDbDrift: false,
      sourceFilePaths: [sourcePath1, sourcePath2],
    });
    expect(result.status).toBe('success');
    const totalInserted = result.applied.characters?.inserted ?? 0;
    expect(totalInserted).toBe(3); // chars 2,3,4 added
    const [cnt] = await db.executeSql(`SELECT COUNT(*) AS c FROM characters`);
    expect(cnt.rows.item(0).c).toBe(4);
  });
});

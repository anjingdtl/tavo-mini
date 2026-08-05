import RNFS from 'react-native-fs';
import {
  createCanonInMemoryDb,
  type InMemorySqliteDb,
} from '../helpers/canonInMemoryDb';
import {
  __setDatabaseForTest,
  __resetForTest,
} from '../../src/data/connection/openDatabase';
import { setupInMemoryFs } from '../schema40-fixture-helpers';
import { createBackup } from '../../src/services/backupService';
import { SCHEMA_RECOVERY_DIR } from '../../src/services/schemaRecoveryBackup';
import {
  scanRecallSources,
  applyRecall,
} from '../../src/services/recall/dataRecallService';

/** Generate a backup JSON via a SEPARATE throwaway db and place it at sourcePath. */
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
    try {
      tmpDb.close();
    } catch {
      /* noop */
    }
  }
}

describe('dataRecallService end-to-end', () => {
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
    try {
      db.close();
    } catch {
      /* noop */
    }
  });

  it('E2E: scan 发现源 → apply 合并缺失角色卡 → 重扫 recoverable 归零', async () => {
    // 1. 准备源备份：含 3 个 character（独立 db）
    const sourcePath = `${SCHEMA_RECOVERY_DIR}/e2e.json`;
    await makeSourceBackup(files, sourcePath, async d => {
      await d.executeSql(
        `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
      );
      for (let i = 1; i <= 3; i++) {
        await d.executeSql(
          `INSERT INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at)
           VALUES (${i}, 1, 0, 'c${i}', 'manual', '{}', 0, 0, 't')`,
        );
      }
    });

    // 2. 当前库 character 为空（createCanonInMemoryDb 建空表）
    (RNFS.readDir as jest.Mock).mockImplementation(async (dir: string) => {
      if (dir === SCHEMA_RECOVERY_DIR) {
        return [
          { isFile: () => true, name: 'e2e.json', path: sourcePath, size: 100 },
        ];
      }
      return [];
    });

    // 3. 第一次扫描：应发现可召回 3 个角色卡
    const report1 = await scanRecallSources();
    expect(report1.sources).toHaveLength(1);
    expect(report1.sources[0].recoverable.characters).toBe(3);

    // 4. 执行召回
    const result = await applyRecall({
      repairCurrentDbDrift: false,
      sourceFilePaths: [sourcePath],
    });
    expect(result.status).toBe('success');
    expect(result.applied.characters?.inserted).toBe(3);

    // 5. 校验当前库确实有了 3 行
    const [cnt] = await db.executeSql(
      `SELECT COUNT(*) AS c FROM characters`,
    );
    expect(cnt.rows.item(0).c).toBe(3);

    // 6. 重扫：recoverable 应归零
    const report2 = await scanRecallSources();
    expect(report2.sources[0].recoverable.characters).toBe(0);
  });

  it('E2E: 漂移库 + 召回 → 漂移修复 + 数据保留', async () => {
    // 制造漂移
    await db.executeSql(
      `ALTER TABLE canon_evidence RENAME TO canon_evidence_full`,
    );
    await db.executeSql(
      `CREATE TABLE canon_evidence AS SELECT id, project_id, source_id, snapshot_id,
       chapter_id, chapter_position, paragraph_start, paragraph_end,
       char_start, char_end, quote_preview, quote_sha256, analysis_run_id, created_at
       FROM canon_evidence_full`,
    );
    await db.executeSql(`DROP TABLE canon_evidence_full`);
    // 塞数据
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    await db.executeSql(
      `INSERT INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at)
       VALUES (5, 1, 0, 'hero', 'manual', '{}', 0, 0, 't')`,
    );

    const report = await scanRecallSources();
    expect(report.currentDb.schemaDrift.needsRepair).toBe(true);

    const result = await applyRecall({
      repairCurrentDbDrift: true,
      sourceFilePaths: [],
    });
    expect(result.status).toBe('success');
    expect(result.driftRepairResult?.ok).toBe(true);
    // character 没丢
    const [cnt] = await db.executeSql(
      `SELECT COUNT(*) AS c FROM characters`,
    );
    expect(cnt.rows.item(0).c).toBe(1);
  });
});

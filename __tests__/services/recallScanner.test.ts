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
import { scanRecallSources } from '../../src/services/recall/recallScanner';

type Db = InMemorySqliteDb;

/**
 * 构造一个有效备份 JSON 字符串：用一个独立的临时 db 塞入 seed 数据并生成备份，
 * 再把备份文件内容复制到 in-memory files Map 的指定 path。
 *
 * 重要：使用独立 tmpDb 而非当前库 db，避免 seed 数据污染 current db 状态，
 * 让测试能精确控制「当前库 vs 备份」的差异。
 */
async function writeFakeBackup(
  files: Map<string, string>,
  path: string,
  seed: (db: Db) => Promise<void>,
): Promise<void> {
  const tmpDb = await createCanonInMemoryDb();
  try {
    await seed(tmpDb);
    const realBackupPath = await createBackup(
      tmpDb as any,
      '2.11.24',
      40,
      'manual',
    );
    const content = files.get(realBackupPath);
    if (content === undefined) {
      throw new Error('backup not written to in-memory fs');
    }
    files.set(path, content);
  } finally {
    try {
      tmpDb.close();
    } catch {
      /* noop */
    }
  }
}

describe('recallScanner', () => {
  let db: Db;
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

  it('S1: 当前库正常且无备份源 → reachable=true, sources=[]', async () => {
    const report = await scanRecallSources();
    expect(report.currentDb.reachable).toBe(true);
    expect(report.sources).toEqual([]);
  });

  it('S2: 当前库有漂移 → needsRepair=true 且资料表行数仍可读', async () => {
    // 制造漂移：sql.js 不支持 DROP COLUMN，改用重建表方式模拟缺列
    await db.executeSql(`ALTER TABLE canon_evidence RENAME TO canon_evidence_full`);
    await db.executeSql(
      `CREATE TABLE canon_evidence AS SELECT id, project_id, source_id, snapshot_id,
       chapter_id, chapter_position, paragraph_start, paragraph_end,
       char_start, char_end, quote_preview, quote_sha256, analysis_run_id, created_at
       FROM canon_evidence_full`,
    );
    await db.executeSql(`DROP TABLE canon_evidence_full`);

    const report = await scanRecallSources();
    expect(report.currentDb.schemaDrift.needsRepair).toBe(true);
    expect(report.currentDb.rowCount.characters).toBeGreaterThanOrEqual(0);
    expect(report.currentDb.reachable).toBe(true);
  });

  it('S3: schema-recovery 目录有 1 个有效 JSON → sources 含 1 项 valid=true', async () => {
    const fakePath = `${SCHEMA_RECOVERY_DIR}/test.json`;
    await writeFakeBackup(files, fakePath, async (d) => {
      await d.executeSql(
        `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (100, 'p', 'outline', 't', 't')`,
      );
    });
    (RNFS.readDir as jest.Mock).mockImplementation(async (dir: string) => {
      if (dir === SCHEMA_RECOVERY_DIR) {
        return [
          { isFile: () => true, name: 'test.json', path: fakePath, size: 100 },
        ];
      }
      return [];
    });

    const report = await scanRecallSources();
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0].valid).toBe(true);
    expect(report.sources[0].sourceId).toBe('schema-recovery');
    expect(report.sources[0].recoverable.projects).toBe(1);
  });

  it('S4: schema-recovery 目录有损坏 JSON → 该源 valid=false', async () => {
    const fakePath = `${SCHEMA_RECOVERY_DIR}/broken.json`;
    files.set(fakePath, '{ not valid json');
    (RNFS.readDir as jest.Mock).mockImplementation(async (dir: string) => {
      if (dir === SCHEMA_RECOVERY_DIR) {
        return [
          { isFile: () => true, name: 'broken.json', path: fakePath, size: 10 },
        ];
      }
      return [];
    });

    const report = await scanRecallSources();
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0].valid).toBe(false);
    expect(report.sources[0].invalidReason).toBeTruthy();
  });

  it('S5: 两份备份 JSON 按 createdAt 倒序', async () => {
    const path1 = `${RNFS.ExternalDirectoryPath}/backups/old.json`;
    const path2 = `${RNFS.ExternalDirectoryPath}/backups/new.json`;
    await writeFakeBackup(files, path1, async () => {});
    await writeFakeBackup(files, path2, async () => {});
    const content2 = JSON.parse(files.get(path2)!);
    content2.meta.created_at = '2099-12-31T23:59:59Z';
    files.set(path2, JSON.stringify(content2));
    const content1 = JSON.parse(files.get(path1)!);
    content1.meta.created_at = '2020-01-01T00:00:00Z';
    files.set(path1, JSON.stringify(content1));

    (RNFS.readDir as jest.Mock).mockImplementation(async (dir: string) => {
      if (dir === `${RNFS.ExternalDirectoryPath}/backups`) {
        return [
          { isFile: () => true, name: 'old.json', path: path1, size: 100 },
          { isFile: () => true, name: 'new.json', path: path2, size: 100 },
        ];
      }
      return [];
    });

    const report = await scanRecallSources();
    expect(report.sources).toHaveLength(2);
    expect(report.sources[0].createdAt >= report.sources[1].createdAt).toBe(true);
  });

  it('S6: 当前库 characters=0，源里 characters=5 → recoverable.characters=5', async () => {
    const fakePath = `${SCHEMA_RECOVERY_DIR}/chars.json`;
    await writeFakeBackup(files, fakePath, async (d) => {
      await d.executeSql(
        `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
      );
      for (let i = 1; i <= 5; i++) {
        await d.executeSql(
          `INSERT INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at)
           VALUES (${i}, 1, 0, 'c${i}', 'manual', '{}', 0, 0, 't')`,
        );
      }
    });
    (RNFS.readDir as jest.Mock).mockImplementation(async (dir: string) => {
      if (dir === SCHEMA_RECOVERY_DIR) {
        return [
          { isFile: () => true, name: 'chars.json', path: fakePath, size: 100 },
        ];
      }
      return [];
    });

    const report = await scanRecallSources();
    expect(report.sources[0].recoverable.characters).toBe(5);
  });

  it('S7: 当前库 characters=5，源里同 5 个 id → recoverable.characters=0', async () => {
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    for (let i = 1; i <= 5; i++) {
      await db.executeSql(
        `INSERT INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at)
         VALUES (${i}, 1, 0, 'c${i}', 'manual', '{}', 0, 0, 't')`,
      );
    }
    const fakePath = `${SCHEMA_RECOVERY_DIR}/same.json`;
    await writeFakeBackup(files, fakePath, async (d) => {
      await d.executeSql(
        `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
      );
      for (let i = 1; i <= 5; i++) {
        await d.executeSql(
          `INSERT INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at)
           VALUES (${i}, 1, 0, 'c${i}', 'manual', '{}', 0, 0, 't')`,
        );
      }
    });
    (RNFS.readDir as jest.Mock).mockImplementation(async (dir: string) => {
      if (dir === SCHEMA_RECOVERY_DIR) {
        return [
          { isFile: () => true, name: 'same.json', path: fakePath, size: 100 },
        ];
      }
      return [];
    });

    const report = await scanRecallSources();
    expect(report.sources[0].recoverable.characters).toBe(0);
  });

  it('S8: 当前库 characters=5，源里 8 个（3 新+5 重复）→ recoverable.characters=3', async () => {
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    for (let i = 1; i <= 5; i++) {
      await db.executeSql(
        `INSERT INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at)
         VALUES (${i}, 1, 0, 'c${i}', 'manual', '{}', 0, 0, 't')`,
      );
    }
    const fakePath = `${SCHEMA_RECOVERY_DIR}/partial.json`;
    await writeFakeBackup(files, fakePath, async (d) => {
      await d.executeSql(
        `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
      );
      for (let i = 1; i <= 8; i++) {
        await d.executeSql(
          `INSERT INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at)
           VALUES (${i}, 1, 0, 'c${i}', 'manual', '{}', 0, 0, 't')`,
        );
      }
    });
    (RNFS.readDir as jest.Mock).mockImplementation(async (dir: string) => {
      if (dir === SCHEMA_RECOVERY_DIR) {
        return [
          { isFile: () => true, name: 'partial.json', path: fakePath, size: 100 },
        ];
      }
      return [];
    });

    const report = await scanRecallSources();
    expect(report.sources[0].recoverable.characters).toBe(3);
  });
});

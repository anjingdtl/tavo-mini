/**
 * CL-09: Schema Recovery 去除重复大文件 IO（修复前稳定失败测试）。
 *
 * 修复前 createSchemaRecoveryBackup = createBackup（写完整备份到普通目录）
 * → readAndValidateBackup（完整重读 + 解析 + checksum）→ copyFile（再复制
 * 一次）。100MB+ 库 = 三次全量 IO。
 *
 * 修复后：单次写路径 —— 读表 → 序列化 → 写前计算 checksum → staging →
 * 原子 rename，直接落在 schema-recovery 目录。验收：
 *   1. RNFS.readFile 零调用（无重读）
 *   2. RNFS.copyFile 零调用（无复制）
 *   3. 目标路径在 SCHEMA_RECOVERY_DIR 下
 *   4. checksum 非空且与真实内容一致
 *   5. 产物仍可被标准 v3 读取器解析（可恢复性不降级）
 */
import RNFS from 'react-native-fs';
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';
import { createEmptyInMemoryDb } from './helpers/canonInMemoryDb';
import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { execute } from '../src/data/connection/execute';
import { openDatabase } from '../src/data/connection/openDatabase';
import { createSchemaRecoveryBackup, SCHEMA_RECOVERY_DIR } from '../src/services/schemaRecoveryBackup';
import { readAndValidateBackup } from '../src/services/backupService';
import { setupInMemoryFs } from './schema40-fixture-helpers';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';

let testDb: InMemorySqliteDb | null = null;
let files: Map<string, string>;

async function resetDb() {
  __resetForTest();
  files = setupInMemoryFs();
  testDb = await createEmptyInMemoryDb();
  __setDatabaseForTest(testDb as any);
  await createCurrentSchema(testDb as any);
}

afterEach(async () => {
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

describe('CL-09: schema recovery 单次 IO', () => {
  it('写入零重读零复制：readFile/copyFile 均未被调用', async () => {
    await resetDb();
    await execute(
      await openDatabase(),
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    await execute(
      await openDatabase(),
      `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 0, '第1章', '梗概', '正文内容', 'draft', 't', 't')`,
    );

    const readFile = RNFS.readFile as jest.Mock;
    const copyFile = RNFS.copyFile as jest.Mock;
    readFile.mockClear();
    copyFile.mockClear();

    const result = await createSchemaRecoveryBackup(testDb as any, 'pre_migration');

    // 核心验收：恢复备份流程零完整重读、零复制。
    expect(readFile).not.toHaveBeenCalled();
    expect(copyFile).not.toHaveBeenCalled();
    // 直接落在 schema-recovery 目录。
    expect(result.path.startsWith(SCHEMA_RECOVERY_DIR)).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.checksum).toBeTruthy();
    // 行数元数据正确。
    expect(result.coreCounts.projects).toBe(1);
    expect(result.coreCounts.chapters).toBe(1);
  });

  it('产物可被标准 v3 读取器解析（可恢复性不降级）', async () => {
    await resetDb();
    await execute(
      await openDatabase(),
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    await execute(
      await openDatabase(),
      `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 0, '第1章', '梗概', '正文内容', 'draft', 't', 't')`,
    );

    const result = await createSchemaRecoveryBackup(testDb as any);

    // 测试侧验证（不属于恢复流程 IO）：标准读取器必须能解析 + checksum 通过。
    const { parsed, validation } = await readAndValidateBackup(result.path);
    expect(parsed).not.toBeNull();
    expect(validation.valid).toBe(true);
    expect(parsed!.tables.projects).toHaveLength(1);
    expect(parsed!.tables.chapters).toHaveLength(1);
    expect(parsed!.tables.chapters[0].content).toBe('正文内容');
  });

  it('checksum 按标准字节序计算（等价完整校验，可恢复性不降级）', async () => {
    await resetDb();
    await execute(
      await openDatabase(),
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );

    const result = await createSchemaRecoveryBackup(testDb as any);
    // 写入文件后 checksum 字段已自包含；readAndValidateBackup 用同一字节序
    // 重算必须通过（这是恢复时校验的等价物）。
    const { parsed, validation } = await readAndValidateBackup(result.path);
    expect(parsed).not.toBeNull();
    expect(validation.valid).toBe(true);
    const raw = files.get(result.path);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).meta.checksum).toBe(result.checksum);
  });
});

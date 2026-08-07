/**
 * CL-08: Backup Center 轻量索引（修复前稳定失败测试）。
 *
 * 修复前 listBackups() 对每个备份 RNFS.readFile 完整内容 + JSON.parse：
 * 10 × 100MB 备份 = 1GB 读取 + 解析，首屏必然卡死。
 *
 * 修复后：
 *   1. createBackup 写完 JSON 后立即写 tiny sidecar（*.json.meta.json）
 *   2. listBackups() 只 readDir + stat + 读小 sidecar —— 完整备份读取次数 = 0
 *   3. 无 sidecar 的旧备份：filename/mtime/size 立即显示 + metaPending
 *   4. backfillBackupMeta 后台补齐 sidecar（只读一次完整备份）
 */
/* eslint-env jest */
import RNFS from 'react-native-fs';
import {
  createBackup,
  listBackups,
  backfillBackupMeta,
  readBackupSidecar,
  sidecarPathFor,
} from '../src/services/backupService';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';
import { SCHEMA_VERSION } from '../src/services/migrations';

type TableRows = Record<string, any>[];

const ALL_TABLES = SCHEMA_MANIFEST
  .filter(table => table.backup)
  .slice()
  .sort((a, b) => a.restoreOrder - b.restoreOrder)
  .map(table => table.name);

function makeFullTables(): Record<string, TableRows> {
  const tables: Record<string, TableRows> = {};
  for (const table of ALL_TABLES) tables[table] = [];
  tables.projects = [{ id: 1, name: 'p', mode: 'outline', created_at: 't', updated_at: 't' }];
  tables.settings = [{ key: 'app_version', value: '2.11.34' }];
  return tables;
}

/** Minimal SQLite double for createBackup's SELECT * row reads. */
function createMockDb(tables: Record<string, TableRows>): any {
  return {
    executeSql: jest.fn(async (sql: string) => {
      const match = sql.match(/SELECT \* FROM (\w+)/i);
      const table = match ? match[1] : '';
      const rows = tables[table] || [];
      return [{
        insertId: 0,
        rowsAffected: rows.length,
        rows: {
          length: rows.length,
          item: (index: number) => rows[index],
          raw: () => rows,
        },
      }];
    }),
  };
}

beforeEach(() => {
  const fsMock = RNFS as any;
  fsMock.readFile.mockReset();
  fsMock.writeFile.mockReset();
  fsMock.readDir.mockReset();
  fsMock.stat.mockReset();
  fsMock.exists.mockReset();
  fsMock.exists.mockResolvedValue(false);
});

describe('CL-08: sidecar 轻量索引', () => {
  test('createBackup 写 JSON 后立即写 tiny sidecar', async () => {
    const db = createMockDb(makeFullTables());
    (RNFS as any).stat.mockResolvedValue({ size: 12345, mtime: Date.now() });

    const path = await createBackup(db, '2.11.34', SCHEMA_VERSION, 'manual');

    const writes = (RNFS.writeFile as jest.Mock).mock.calls;
    const sidecarWrite = writes.find(
      (args: string[]) => String(args[0]).endsWith('.meta.json'),
    );
    expect(sidecarWrite).toBeTruthy();
    const sidecar = JSON.parse(sidecarWrite![1]);
    expect(sidecar.formatVersion).toBe(1);
    expect(sidecar.kind).toBe('manual');
    expect(sidecar.appVersion).toBe('2.11.34');
    expect(sidecar.schemaVersion).toBe(SCHEMA_VERSION);
    expect(sidecar.size).toBe(12345);
    expect(sidecar.checksum).toBeTruthy();
    expect(sidecar.validationState).toBe('created');
    expect(sidecarPathFor(path)).toBe(`${path}.meta.json`);
  });

  test('10 × 100MB 大备份：列表阶段完整备份读取次数 = 0（只读 sidecar）', async () => {
    const bigFiles = Array.from({ length: 10 }, (_, index) => ({
      name: `backup_v2.11.33_${index}.json`,
      path: `/a/backup-${index}.json`,
      mtime: new Date(2026, 0, index + 1),
      size: 100 * 1024 * 1024,
    }));
    (RNFS.readDir as jest.Mock).mockResolvedValue(bigFiles);
    (RNFS.readFile as jest.Mock).mockImplementation(async (path: string) => {
      if (path.endsWith('.meta.json')) {
        return JSON.stringify({
          formatVersion: 1,
          kind: 'automatic',
          appVersion: '2.11.33',
          schemaVersion: 42,
          createdAt: '2026-01-01T00:00:00Z',
          size: 100 * 1024 * 1024,
          checksum: 'abc',
          validationState: 'created',
        });
      }
      throw new Error('FULL BACKUP READ ON LIST PATH — CL-08 VIOLATION');
    });

    const summaries = await listBackups();
    expect(summaries).toHaveLength(10);
    expect(summaries[0].size).toBe(100 * 1024 * 1024);
    expect(summaries[0].appVersion).toBe('2.11.33');

    // 核心验收：列表阶段零完整备份读取。
    const fullReads = (RNFS.readFile as jest.Mock).mock.calls.filter(
      (args: string[]) => !String(args[0]).endsWith('.meta.json'),
    );
    expect(fullReads).toHaveLength(0);
    // 每次只读小 sidecar，不解析 100MB 主体。
    const sidecarReads = (RNFS.readFile as jest.Mock).mock.calls;
    expect(sidecarReads).toHaveLength(10);
  });

  test('无 sidecar 的旧备份：立即按 filename/mtime/size 显示 + metaPending', async () => {
    const legacyFiles = [
      { name: 'manual_v2.11.24.json', path: '/a/legacy.json', mtime: new Date('2026-05-01'), size: 5000 },
    ];
    (RNFS.readDir as jest.Mock).mockResolvedValue(legacyFiles);
    (RNFS.readFile as jest.Mock).mockResolvedValue(''); // sidecar 不存在

    const summaries = await listBackups();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].kind).toBe('manual');
    expect(summaries[0].metaPending).toBe(true);
    expect(summaries[0].size).toBe(5000);
    expect(summaries[0].createdAt).toBe(new Date('2026-05-01').toISOString());
    // 依旧零完整读取。
    const fullReads = (RNFS.readFile as jest.Mock).mock.calls.filter(
      (args: string[]) => !String(args[0]).endsWith('.meta.json'),
    );
    expect(fullReads).toHaveLength(0);
  });

  test('backfillBackupMeta：只读一次完整备份后写 sidecar', async () => {
    const backupPath = '/a/legacy.json';
    (RNFS.stat as jest.Mock).mockResolvedValue({ size: 5000, mtime: Date.now() });
    // v1 格式（无 checksum 依赖）也能被 readAndValidateBackup 解析。
    const coreTables: Record<string, any[]> = {};
    for (const table of ALL_TABLES) coreTables[table] = [];
    coreTables.projects = [{ id: 1, name: 'p', mode: 'outline' }];
    const fullContent = JSON.stringify({
      format: 'shinewriter-backup',
      format_version: 1,
      meta: {
        app_version: '2.11.24',
        schema_version: 38,
        backup_date: '2026-05-01T00:00:00Z',
        kind: 'manual',
      },
      tables: coreTables,
    });
    const writtenSidecars = new Map<string, string>();
    (RNFS.writeFile as jest.Mock).mockImplementation(async (path: string, content: string) => {
      if (path.endsWith('.meta.json')) writtenSidecars.set(path, content);
    });
    (RNFS.readFile as jest.Mock).mockImplementation(async (path: string) => {
      if (path.endsWith('.meta.json')) {
        const cached = writtenSidecars.get(path);
        if (cached) return cached;
        throw new Error('no sidecar yet');
      }
      return fullContent;
    });

    await backfillBackupMeta(backupPath);

    const sidecarWrite = (RNFS.writeFile as jest.Mock).mock.calls.find(
      (args: string[]) => String(args[0]).endsWith('.meta.json'),
    );
    expect(sidecarWrite).toBeTruthy();
    const sidecar = JSON.parse(sidecarWrite![1]);
    expect(sidecar.kind).toBe('manual');
    expect(sidecar.appVersion).toBe('2.11.24');
    expect(sidecar.schemaVersion).toBe(38);
    expect(sidecar.size).toBe(5000);

    // sidecar 可被 readBackupSidecar 正确读取。
    const read = await readBackupSidecar(sidecarPathFor(backupPath));
    expect(read?.kind).toBe('manual');
    expect(read?.schemaVersion).toBe(38);
  });
});

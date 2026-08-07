/**
 * F2-05: legacy sidecar backfill 限流 + deleteBackup 清理 sidecar。
 *
 * 修复前：
 *   - BackupCenterScreen 用 Promise.all 对全部 legacy backup 同时做完整
 *     read/parse（N 个大备份并发全量读）；
 *   - deleteBackup(backup.json) 不删除 backup.json.meta.json，留下 orphan。
 *
 * 验收：
 *   1. backfillBackupMetaQueued(concurrency=1) 任意时刻最多 1 个完整 read；
 *   2. 队列满时最大同时 full-read 数 = 1（可调并发数验证）；
 *   3. 单个失败不影响其他（best-effort）；
 *   4. deleteBackup 同时 best-effort 删除 sidecar；
 *   5. 列表本身仍然零完整读（轻量列表不回退）。
 */
import RNFS from 'react-native-fs';
import { setupInMemoryFs } from './schema40-fixture-helpers';
import {
  backfillBackupMetaQueued,
  backfillBackupMeta,
  deleteBackup,
  sidecarPathFor,
} from '../src/services/backupService';

jest.mock('react-native-fs');

function makeBackupBody(kind: string, createdAt: string) {
  // v1 格式：无 checksum 依赖，readAndValidateBackup 可直接解析。
  const coreTables: Record<string, any[]> = {
    projects: [{ id: 1, name: 'p', mode: 'outline' }],
    chapters: [],
    fragments: [],
    plotlines: [],
    project_plotlines: [],
    characters: [],
    worldbook_collections: [],
    worldbook_entries: [],
    notes: [],
    presets: [],
    llm_config: [],
    settings: [],
  };
  return JSON.stringify({
    format: 'shinewriter-backup',
    format_version: 1,
    meta: {
      app_version: '2.11.24',
      schema_version: 38,
      backup_date: createdAt,
      kind,
    },
    tables: coreTables,
  });
}

let files: Map<string, string>;
let readFileCalls: string[];

function setupFsWithLegacyBackups(count: number): string[] {
  files = setupInMemoryFs();
  readFileCalls = [];
  const paths: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const p = `${RNFS.ExternalDirectoryPath}/backups/manual_legacy_${i}.json`;
    files.set(p, makeBackupBody('manual', new Date(2026, 0, i + 1).toISOString()));
    paths.push(p);
  }
  (RNFS.readFile as jest.Mock).mockImplementation(async (p: string) => {
    readFileCalls.push(p);
    const c = files.get(p);
    if (c === undefined) throw new Error(`ENOENT: ${p}`);
    return c;
  });
  (RNFS.exists as jest.Mock).mockImplementation(async (p: string) =>
    files.has(p),
  );
  (RNFS.stat as jest.Mock).mockImplementation(async (p: string) => ({
    size: files.get(p)?.length ?? 0,
    mtime: new Date(),
  }));
  (RNFS.unlink as jest.Mock).mockImplementation(async (p: string) => {
    files.delete(p);
  });
  return paths;
}

describe('F2-05: sidecar backfill 限流', () => {
  it('concurrency=1：任意时刻最多 1 个完整 full-read', async () => {
    const paths = setupFsWithLegacyBackups(5);
    let maxInFlight = 0;
    let inFlight = 0;
    let enteredReadFile = false;
    (RNFS.readFile as jest.Mock).mockImplementation(async (p: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      enteredReadFile = true;
      await new Promise(resolve => setTimeout(resolve, 5));
      const c = files.get(p);
      inFlight -= 1;
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    });

    await backfillBackupMetaQueued(paths, 1);

    expect(enteredReadFile).toBe(true);
    expect(maxInFlight).toBe(1);
    // 全部补上了 sidecar。
    for (const p of paths) {
      expect(files.has(sidecarPathFor(p))).toBe(true);
    }
  });

  it('并发数上限可控（concurrency=2 → maxInFlight<=2）', async () => {
    const paths = setupFsWithLegacyBackups(6);
    let maxInFlight = 0;
    let inFlight = 0;
    (RNFS.readFile as jest.Mock).mockImplementation(async (p: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      const c = files.get(p);
      inFlight -= 1;
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    });

    await backfillBackupMetaQueued(paths, 2);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('单个失败不影响其余（best-effort 继续）', async () => {
    const paths = setupFsWithLegacyBackups(3);
    // 中间那个备份损坏（read 抛错）。
    (RNFS.readFile as jest.Mock).mockImplementation(async (p: string) => {
      if (p.includes('manual_legacy_1.json')) {
        throw new Error('CORRUPT');
      }
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    });

    await backfillBackupMetaQueued(paths, 1);

    // 0 和 2 都补上了，1 没有 sidecar（不抛错）。
    expect(files.has(sidecarPathFor(paths[0]))).toBe(true);
    expect(files.has(sidecarPathFor(paths[1]))).toBe(false);
    expect(files.has(sidecarPathFor(paths[2]))).toBe(true);
  });

  it('已有 sidecar 的备份跳过（不重复完整读）', async () => {
    const paths = setupFsWithLegacyBackups(2);
    files.set(sidecarPathFor(paths[0]), JSON.stringify({ formatVersion: 1 }));
    const readCalls: string[] = [];
    (RNFS.readFile as jest.Mock).mockImplementation(async (p: string) => {
      readCalls.push(p);
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    });

    await backfillBackupMetaQueued(paths, 1);

    expect(readCalls.filter(p => p.endsWith('.json') && !p.endsWith('.meta.json'))).toHaveLength(1);
  });
});

describe('F2-05: deleteBackup 清理 sidecar', () => {
  it('删除 backup.json 时同步 best-effort 删除 .meta.json', async () => {
    setupFsWithLegacyBackups(1);
    const backupPath = `${RNFS.ExternalDirectoryPath}/backups/manual_legacy_0.json`;
    files.set(sidecarPathFor(backupPath), JSON.stringify({ formatVersion: 1 }));
    (RNFS.exists as jest.Mock).mockImplementation(async (p: string) =>
      files.has(p),
    );
    (RNFS.unlink as jest.Mock).mockImplementation(async (p: string) => {
      files.delete(p);
    });

    await deleteBackup(backupPath);

    expect(files.has(backupPath)).toBe(false);
    expect(files.has(sidecarPathFor(backupPath))).toBe(false);
  });

  it('backup 不存在时 sidecar 也尝试清理且不抛错', async () => {
    setupFsWithLegacyBackups(0);
    const backupPath = `${RNFS.ExternalDirectoryPath}/backups/gone.json`;
    files.set(sidecarPathFor(backupPath), '{}');
    (RNFS.exists as jest.Mock).mockImplementation(async (p: string) =>
      files.has(p),
    );
    (RNFS.unlink as jest.Mock).mockImplementation(async (p: string) => {
      files.delete(p);
    });

    await deleteBackup(backupPath);
    expect(files.has(sidecarPathFor(backupPath))).toBe(false);
  });

  it('backfillBackupMeta（单文件）行为不变', async () => {
    const paths = setupFsWithLegacyBackups(1);
    await backfillBackupMeta(paths[0]);
    expect(files.has(sidecarPathFor(paths[0]))).toBe(true);
  });
});

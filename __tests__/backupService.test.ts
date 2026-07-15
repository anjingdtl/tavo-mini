/* eslint-env jest */

import RNFS from 'react-native-fs';
import {
  computeBackupChecksum,
  createBackup,
  restoreFromBackup,
  cleanupOldBackups,
  validateBackup,
  listBackups,
  createManualBackup,
  createPreRestoreBackup,
  deleteBackup,
} from '../src/services/backupService';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';
import { SCHEMA_VERSION } from '../src/services/migrations';

type TableRows = Record<string, any>[];

const ALL_TABLES = SCHEMA_MANIFEST.filter(table => table.backup).map(table => table.name);
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

const createRows = (rows: TableRows) => ({
  length: rows.length,
  item: (index: number) => rows[index],
  raw: () => rows,
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

interface MockDbOptions {
  failOnInsertTable?: string;
}

function createMockDb(initialData: Record<string, TableRows>, options: MockDbOptions = {}) {
  const tableData: Record<string, TableRows> = clone(initialData);
  const executeSql = jest.fn((sql: string, params: any[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    const pragmaTableInfo = normalized.match(/^PRAGMA table_info\((\w+)\)/i);
    if (pragmaTableInfo) {
      const manifest = SCHEMA_MANIFEST.find(table => table.name === pragmaTableInfo[1]);
      const columns = (manifest?.columns || []).map((name, cid) => ({ name, cid }));
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(columns) }];
    }

    if (/^PRAGMA foreign_keys/i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 0, rows: createRows([{ foreign_keys: 1 }]) }];
    }
    if (/^PRAGMA foreign_key_check/i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
    }

    if (/^SELECT name FROM sqlite_master WHERE type = 'table'/i.test(normalized)) {
      return [{
        insertId: 0,
        rowsAffected: 0,
        rows: createRows(ALL_TABLES.map(name => ({ name }))),
      }];
    }
    if (/^SELECT name FROM sqlite_master WHERE type = 'index'/i.test(normalized)) {
      const table = params[0];
      const indexes = SCHEMA_MANIFEST.find(item => item.name === table)?.indexes || [];
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(indexes.map(name => ({ name }))) }];
    }

    const settingsVersion = normalized.match(/^SELECT value FROM settings WHERE key = \?/i);
    if (settingsVersion) {
      const row = tableData.settings?.find(item => item.key === params[0]);
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(row ? [row] : []) }];
    }
    if (/^SELECT id, provider_type, local_model_id, base_url, model_name FROM llm_config WHERE is_active = 1/i.test(normalized)) {
      const rows = (tableData.llm_config || [])
        .filter(row => Number(row.is_active) === 1)
        .map(row => ({
          id: row.id,
          provider_type: row.provider_type,
          local_model_id: row.local_model_id,
          base_url: row.base_url,
          model_name: row.model_name,
        }));
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(rows) }];
    }
    if (/^SELECT id FROM local_llm_models WHERE id = \?/i.test(normalized)) {
      const row = tableData.local_llm_models?.find(item => item.id === params[0]);
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(row ? [row] : []) }];
    }
    if (/^SELECT .* LEFT JOIN /i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
    }

    const selectAll = normalized.match(/^SELECT \* FROM (\w+)/i);
    if (selectAll) {
      return [{
        insertId: 0,
        rowsAffected: 0,
        rows: createRows(tableData[selectAll[1]] || []),
      }];
    }

    const deleteFrom = normalized.match(/^DELETE FROM (\w+)/i);
    if (deleteFrom) {
      tableData[deleteFrom[1]] = [];
      return [{ insertId: 0, rowsAffected: 1, rows: createRows([]) }];
    }

    const insertInto = normalized.match(/^INSERT(?: OR REPLACE)? INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)/i);
    if (insertInto) {
      const table = insertInto[1];
      if (options.failOnInsertTable === table) throw new Error(`injected insert failure: ${table}`);
      const keys = insertInto[2].split(',').map(key => key.trim());
      const row = Object.fromEntries(keys.map((key, index) => [key, params[index]]));
      if (/^INSERT OR REPLACE/i.test(normalized)) {
        const identity = table === 'settings' ? 'key' : 'id';
        const existing = (tableData[table] || []).findIndex(item => item[identity] === row[identity]);
        if (existing >= 0) tableData[table][existing] = row;
        else (tableData[table] ||= []).push(row);
      } else {
        (tableData[table] ||= []).push(row);
      }
      return [{ insertId: 1, rowsAffected: 1, rows: createRows([]) }];
    }

    return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
  });

  const transaction = jest.fn((callback: (tx: any) => void, onError: (error: Error) => void, onSuccess: () => void) => {
    const before = clone(tableData);
    try {
      callback({ executeSql });
      onSuccess();
    } catch (error) {
      Object.keys(tableData).forEach(key => delete tableData[key]);
      Object.assign(tableData, before);
      onError(error as Error);
    }
  });

  return {
    executeSql,
    transaction,
    tableData,
    snapshot: () => clone(tableData),
  } as any;
}

function makeFullTables(overrides: Record<string, TableRows> = {}): Record<string, TableRows> {
  const tables: Record<string, TableRows> = {};
  for (const table of ALL_TABLES) tables[table] = overrides[table] || [];
  return tables;
}

async function makeV3Backup(
  overrides: Record<string, TableRows> = {},
  metaOverrides: Record<string, any> = {},
): Promise<any> {
  const tables = makeFullTables(overrides);
  const backup = {
    format: 'shinewriter-backup' as const,
    format_version: 3 as const,
    meta: {
      app_version: '2.4.3',
      schema_version: SCHEMA_VERSION,
      created_at: '2026-06-13T00:00:00Z',
      kind: 'automatic' as const,
      checksum_algorithm: 'sha256' as const,
      checksum: '',
      ...metaOverrides,
    },
    tables,
    external_assets: [],
  };
  backup.meta.checksum = await computeBackupChecksum(backup);
  return backup;
}

function makeV2Backup(overrides: Record<string, TableRows> = {}, metaOverrides: Record<string, any> = {}) {
  const tables = makeFullTables(overrides);
  const backup = {
    format: 'shinewriter-backup',
    format_version: 2,
    meta: {
      app_version: '1.3.8',
      schema_version: 6,
      created_at: '2026-06-13T00:00:00Z',
      table_count: CORE_TABLES.length,
      row_count: Object.values(tables).reduce((sum, rows) => sum + rows.length, 0),
      kind: 'automatic',
      checksum: '',
      ...metaOverrides,
    },
    tables,
  };
  const tablesJson = JSON.stringify(backup.tables);
  let hash = 0;
  const prime = 2147483647;
  for (let index = 0; index < tablesJson.length; index += 1) {
    hash = (hash * 31 + tablesJson.charCodeAt(index)) % prime;
  }
  backup.meta.checksum = `${tablesJson.length}:${tablesJson.substring(0, 50)}:${hash}`;
  return backup;
}

function writeBackup(backup: any): void {
  (RNFS.readFile as jest.Mock).mockResolvedValue(JSON.stringify(backup));
}

describe('backupService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (RNFS.writeFile as jest.Mock).mockResolvedValue(undefined);
    (RNFS.readFile as jest.Mock).mockResolvedValue('{}');
    (RNFS.mkdir as jest.Mock).mockResolvedValue(undefined);
    (RNFS.readDir as jest.Mock).mockResolvedValue([]);
    (RNFS.unlink as jest.Mock).mockResolvedValue(undefined);
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
  });

  test('createBackup exports the manifest tables with v3 SHA-256 and external model references', async () => {
    const mockDb = createMockDb({
      projects: [{ id: 1, name: '测试项目' }],
      chapters: [{ id: 1, project_id: 1, title: '第1章' }],
      llm_config: [{ id: 1, name: '云端', api_key: 'sk-test-only', is_active: 1 }],
      settings: [{ key: 'webdav_password', value: 'not-a-real-secret' }],
      local_llm_models: [{
        id: 'model-1',
        original_filename: 'qwen.gguf',
        relative_path: 'model-1/model.gguf',
        sha256: 'abc123',
        file_size: 42,
      }],
    });

    await createBackup(mockDb, '1.2.0', 6);

    const written = JSON.parse((RNFS.writeFile as jest.Mock).mock.calls[0][1]);
    expect(written.format).toBe('shinewriter-backup');
    expect(written.format_version).toBe(3);
    expect(written.meta.checksum_algorithm).toBe('sha256');
    expect(written.meta.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(written.tables)).toEqual(ALL_TABLES);
    expect(written.external_assets).toEqual([{
      local_model_reference: {
        id: 'model-1',
        filename: 'qwen.gguf',
        sha256: 'abc123',
        file_size: 42,
        included: false,
      },
    }]);
    expect(written.tables.llm_config[0]).not.toHaveProperty('api_key');
    expect((RNFS.writeFile as jest.Mock).mock.calls[0][1]).not.toMatch(/sk-|Bearer |"api_key"\s*:\s*"[^"\n]+"|password|token/i);
  });

  test('createBackup uses kind-specific prefixes', async () => {
    const mockDb = createMockDb({});
    await createBackup(mockDb, '1.2.0', 6, 'automatic');
    await createManualBackup(mockDb, '1.2.0', 6);
    await createPreRestoreBackup(mockDb, '1.2.0', 6);
    const paths = (RNFS.writeFile as jest.Mock).mock.calls.map(call => call[0]);
    expect(paths.some(path => path.includes('backup_v1.2.0_'))).toBe(true);
    expect(paths.some(path => path.includes('manual_v1.2.0_'))).toBe(true);
    expect(paths.some(path => path.includes('prerestore_v1.2.0_'))).toBe(true);
  });

  test('validateBackup accepts v3 and detects checksum changes', async () => {
    const backup = await makeV3Backup({ projects: [{ id: 1, name: 'p1' }] });
    writeBackup(backup);
    await expect(validateBackup('/fake/path/backup.json')).resolves.toMatchObject({
      valid: true,
      formatVersion: 3,
      appVersion: '2.4.3',
      schemaVersion: SCHEMA_VERSION,
    });

    backup.tables.projects[0].name = 'tampered';
    writeBackup(backup);
    const result = await validateBackup('/fake/path/backup.json');
    expect(result.valid).toBe(false);
    expect(result.errors.join('')).toContain('SHA-256');
  });

  test('validateBackup accepts v1 and v2 backups for read compatibility', async () => {
    const v2 = makeV2Backup({ projects: [{ id: 1, name: 'p1' }] });
    writeBackup(v2);
    expect((await validateBackup('/fake/path/v2.json')).valid).toBe(true);

    const v1 = {
      meta: { app_version: '1.0.0', schema_version: '3', backup_date: '2026-01-01T00:00:00Z' },
      tables: makeFullTables(),
    };
    writeBackup(v1);
    expect((await validateBackup('/fake/path/v1.json')).valid).toBe(true);
  });

  test('validateBackup rejects missing core tables and unsupported field types', async () => {
    const missingCore = await makeV3Backup();
    delete missingCore.tables.projects;
    missingCore.meta.checksum = await computeBackupChecksum(missingCore);
    writeBackup(missingCore);
    const missingResult = await validateBackup('/fake/path/missing.json');
    expect(missingResult.valid).toBe(false);
    expect(missingResult.errors.join('')).toContain('projects');

    const wrongType = await makeV3Backup({ projects: [{ id: { invalid: true } }] });
    writeBackup(wrongType);
    const typeResult = await validateBackup('/fake/path/type.json');
    expect(typeResult.valid).toBe(false);
    expect(typeResult.errors.join('')).toContain('类型不受支持');
  });

  test('restore is atomic when an insert fails', async () => {
    const backup = await makeV3Backup({
      projects: [{ id: 2, name: '新项目' }],
      chapters: [{ id: 2, project_id: 2, title: '新章节' }],
    });
    writeBackup(backup);
    const mockDb = createMockDb(
      { ...makeFullTables(), projects: [{ id: 1, name: '旧项目' }] },
      { failOnInsertTable: 'chapters' },
    );
    const before = mockDb.snapshot();

    await expect(restoreFromBackup(mockDb, '/fake/path/backup.json', { createPreRestoreBackup: false })).rejects.toThrow('injected insert failure');
    expect(mockDb.snapshot()).toEqual(before);
  });

  test('restore verifies schema, strips API keys, preserves current schema version, and returns a pre-restore backup', async () => {
    const backup = await makeV3Backup({
      projects: [{ id: 2, name: '恢复项目' }],
      llm_config: [{ id: 8, name: '恢复配置', api_key: 'sk-not-real', is_active: 1 }],
      settings: [{ key: 'schema_version', value: '6' }, { key: 'theme_mode', value: 'dark' }],
    });
    writeBackup(backup);
    const mockDb = createMockDb(makeFullTables({ projects: [{ id: 1, name: '旧项目' }] }));

    const result = await restoreFromBackup(mockDb, '/fake/path/backup.json');
    expect(result.preRestoreBackupPath).toContain('prerestore_');
    expect(RNFS.writeFile).toHaveBeenCalled();
    expect(mockDb.tableData.projects).toEqual([{ id: 2, name: '恢复项目' }]);
    expect(mockDb.tableData.llm_config[0]).not.toHaveProperty('api_key');
    expect(mockDb.tableData.settings).toContainEqual({ key: 'schema_version', value: String(SCHEMA_VERSION) });
    expect(mockDb.transaction).toHaveBeenCalled();
  });

  test('missing optional tables remain compatible with older backups', async () => {
    const backup = await makeV3Backup({ projects: [{ id: 2, name: '旧格式恢复' }] });
    delete backup.tables.character_collections;
    delete backup.tables.local_llm_models;
    backup.meta.checksum = await computeBackupChecksum(backup);
    writeBackup(backup);
    const mockDb = createMockDb(makeFullTables({
      character_collections: [{ id: 99, project_id: 1, name: '保留集合' }],
      local_llm_models: [{ id: 'keep-model', status: 'ready' }],
    }));

    await restoreFromBackup(mockDb, '/fake/path/backup.json', { createPreRestoreBackup: false });
    expect(mockDb.tableData.character_collections).toEqual([{ id: 99, project_id: 1, name: '保留集合' }]);
    expect(mockDb.tableData.local_llm_models).toEqual([{ id: 'keep-model', status: 'ready' }]);
  });

  test('missing local model files do not block restore and deactivate local configs', async () => {
    const model = {
      id: 'missing-model',
      display_name: 'Qwen',
      original_filename: 'qwen.gguf',
      relative_path: 'missing-model/qwen.gguf',
      file_size: 1024,
      sha256: 'sha-qwen',
      status: 'ready',
    };
    const backup = await makeV3Backup({
      local_llm_models: [model],
      llm_config: [{ id: 9, provider_type: 'llama_cpp', local_model_id: 'missing-model', is_active: 1 }],
    });
    writeBackup(backup);
    const mockDb = createMockDb(makeFullTables());

    const result = await restoreFromBackup(mockDb, '/fake/path/backup.json', { createPreRestoreBackup: false });
    expect(result.missingLocalModels[0]).toMatchObject({ id: 'missing-model', included: false });
    expect(mockDb.tableData.local_llm_models[0]).toMatchObject({
      id: 'missing-model',
      status: 'missing',
      error_code: 'MODEL_FILE_MISSING',
    });
    expect(mockDb.tableData.llm_config[0]).toMatchObject({ id: 9, is_active: 0 });
  });

  test('restore rejects invalid backups before opening a transaction', async () => {
    writeBackup({ format: 'wrong', format_version: 99, meta: {}, tables: {} });
    const mockDb = createMockDb(makeFullTables());
    await expect(restoreFromBackup(mockDb, '/fake/path/bad.json', { createPreRestoreBackup: false })).rejects.toThrow('备份验证失败');
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  test('listBackups sorts v3 summaries and marks unreadable files invalid', async () => {
    const backup1 = await makeV3Backup({}, { created_at: '2026-01-01T00:00:00Z', kind: 'automatic' });
    const backup2 = await makeV3Backup({}, { created_at: '2026-06-01T00:00:00Z', kind: 'manual' });
    const files = [
      { name: 'backup_v1.json', path: '/a/1.json', mtime: new Date('2026-01-01'), size: 100 },
      { name: 'manual_v2.json', path: '/a/2.json', mtime: new Date('2026-06-01'), size: 200 },
      { name: 'broken.json', path: '/a/broken.json', mtime: new Date('2026-07-01'), size: 10 },
    ];
    (RNFS.readDir as jest.Mock).mockResolvedValue(files);
    (RNFS.readFile as jest.Mock).mockImplementation(async (path: string) => {
      if (path.includes('1.json')) return JSON.stringify(backup1);
      if (path.includes('2.json')) return JSON.stringify(backup2);
      throw new Error('parse error');
    });

    const summaries = await listBackups();
    expect(summaries).toHaveLength(3);
    expect(summaries.find(item => item.kind === 'manual')?.valid).toBe(true);
    expect(summaries.find(item => item.path.includes('broken'))?.valid).toBe(false);
  });

  test('cleanupOldBackups enforces per-kind retention limits', async () => {
    const files = Array.from({ length: 4 }, (_, index) => ({
      name: `backup_v${index}.json`,
      path: `/a/automatic-${index}.json`,
      mtime: new Date(Date.now() - index * 1000),
      size: 100,
    }));
    (RNFS.readDir as jest.Mock).mockResolvedValue(files);
    const backup = await makeV3Backup();
    (RNFS.readFile as jest.Mock).mockResolvedValue(JSON.stringify(backup));

    await cleanupOldBackups();
    expect(RNFS.unlink).toHaveBeenCalledTimes(1);
  });

  test('deleteBackup only removes existing files', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await deleteBackup('/a/backup.json');
    await deleteBackup('/a/missing.json');
    expect(RNFS.unlink).toHaveBeenCalledTimes(1);
    expect(RNFS.unlink).toHaveBeenCalledWith('/a/backup.json');
  });

  test('best-effort listing and cleanup tolerate filesystem failures', async () => {
    (RNFS.readFile as jest.Mock).mockRejectedValueOnce(new Error('损坏文件'));
    await expect(validateBackup('/a/broken.json')).resolves.toMatchObject({ valid: false });

    (RNFS.readDir as jest.Mock).mockRejectedValueOnce(new Error('目录不可读'));
    await expect(listBackups()).resolves.toEqual([]);
    (RNFS.readDir as jest.Mock).mockRejectedValueOnce(new Error('清理目录不可读'));
    await expect(cleanupOldBackups()).resolves.toBeUndefined();
  });
});

/* eslint-env jest */

import RNFS from 'react-native-fs';
import {
  createBackup,
  restoreFromBackup,
  cleanupOldBackups,
  validateBackup,
  listBackups,
  createManualBackup,
  createPreRestoreBackup,
  deleteBackup,
} from '../src/services/backupService';

type TableRows = Record<string, any>[];

const ALL_TABLES = [
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
  'project_resources',
  'llm_usage_logs',
  'pipeline_tasks',
  'freeform_documents',
  'content_revisions',
  'generation_drafts',
];

const createRows = (rows: TableRows) => ({
  length: rows.length,
  item: (index: number) => rows[index],
  raw: () => rows,
});

function createMockDb(tableData: Record<string, TableRows>) {
  const executeSql = jest.fn(async (sql: string, _params: any[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    const selectAll = normalized.match(/^SELECT \* FROM (\w+)/i);
    if (selectAll) {
      const table = selectAll[1];
      const rows = tableData[table] || [];
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(rows) }];
    }

    const deleteFrom = normalized.match(/^DELETE FROM (\w+)/i);
    if (deleteFrom) {
      const table = deleteFrom[1];
      if (tableData[table]) tableData[table] = [];
      return [{ insertId: 0, rowsAffected: 1, rows: createRows([]) }];
    }

    const insertInto = normalized.match(/^INSERT INTO (\w+)/i);
    if (insertInto) {
      return [{ insertId: 1, rowsAffected: 1, rows: createRows([]) }];
    }

    return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
  });

  const transaction = jest.fn(async (fn: (tx: any) => Promise<void>) => {
    const tx = { executeSql };
    await fn(tx);
  });

  return { executeSql, transaction } as any;
}

function makeFullTables(overrides: Record<string, TableRows> = {}): Record<string, TableRows> {
  const tables: Record<string, TableRows> = {};
  for (const t of ALL_TABLES) {
    tables[t] = overrides[t] || [];
  }
  return tables;
}

function makeV2Backup(overrides: Record<string, TableRows> = {}, metaOverrides: Record<string, any> = {}) {
  const tables = makeFullTables(overrides);
  return {
    format: 'tavo-mini-backup',
    format_version: 2,
    meta: {
      app_version: '1.3.8',
      schema_version: 6,
      created_at: '2026-06-13T00:00:00Z',
      table_count: ALL_TABLES.length,
      row_count: Object.values(tables).reduce((s, r) => s + r.length, 0),
      kind: 'automatic',
      checksum: '',
      ...metaOverrides,
    },
    tables,
  };
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

  test('createBackup exports all tables to JSON file with v2 format', async () => {
    const mockDb = createMockDb({
      projects: [{ id: 1, name: '测试项目' }],
      chapters: [{ id: 1, project_id: 1, title: '第1章' }],
    });

    const backupPath = await createBackup(mockDb, '1.2.0', 6);

    expect(backupPath).toBeTruthy();
    expect(RNFS.mkdir).toHaveBeenCalled();
    expect(RNFS.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('backup_v1.2.0_'),
      expect.any(String),
      'utf8',
    );

    const writtenJson = JSON.parse((RNFS.writeFile as jest.Mock).mock.calls[0][1]);
    expect(writtenJson.format).toBe('tavo-mini-backup');
    expect(writtenJson.format_version).toBe(2);
    expect(writtenJson.meta.app_version).toBe('1.2.0');
    expect(writtenJson.meta.schema_version).toBe(6);
    expect(writtenJson.meta.kind).toBe('automatic');
    expect(writtenJson.meta.checksum).toBeTruthy();
    expect(writtenJson.meta.row_count).toBeGreaterThanOrEqual(0);
    expect(writtenJson.tables.projects).toHaveLength(1);
    expect(writtenJson.tables.chapters).toHaveLength(1);
  });

  test('createBackup with kind=manual uses manual prefix', async () => {
    const mockDb = createMockDb({});
    await createBackup(mockDb, '1.2.0', 6, 'manual');
    expect(RNFS.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('manual_v1.2.0_'),
      expect.any(String),
      'utf8',
    );
  });

  test('createBackup with kind=pre_restore uses prerestore prefix', async () => {
    const mockDb = createMockDb({});
    await createBackup(mockDb, '1.2.0', 6, 'pre_restore');
    expect(RNFS.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('prerestore_v1.2.0_'),
      expect.any(String),
      'utf8',
    );
  });

  test('createManualBackup delegates with kind=manual', async () => {
    const mockDb = createMockDb({});
    await createManualBackup(mockDb, '1.0.0', 5);
    expect(RNFS.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('manual_v1.0.0_'),
      expect.any(String),
      'utf8',
    );
  });

  test('createPreRestoreBackup delegates with kind=pre_restore', async () => {
    const mockDb = createMockDb({});
    await createPreRestoreBackup(mockDb, '1.0.0', 5);
    expect(RNFS.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('prerestore_v1.0.0_'),
      expect.any(String),
      'utf8',
    );
  });

  test('validateBackup returns valid for v2 backup', async () => {
    const backup = makeV2Backup({ projects: [{ id: 1, name: 'p1' }] });
    // Compute real checksum
    const tablesJson = JSON.stringify(backup.tables);
    let hash = 0;
    const prime = 2147483647;
    for (let i = 0; i < tablesJson.length; i++) {
      hash = (hash * 31 + tablesJson.charCodeAt(i)) % prime;
    }
    backup.meta.checksum = `${tablesJson.length}:${tablesJson.substring(0, 50)}:${hash}`;

    (RNFS.readFile as jest.Mock).mockResolvedValue(JSON.stringify(backup));

    const result = await validateBackup('/fake/path/backup.json');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.appVersion).toBe('1.3.8');
    expect(result.schemaVersion).toBe(6);
  });

  test('validateBackup detects checksum mismatch', async () => {
    const backup = makeV2Backup();
    backup.meta.checksum = 'wrong-checksum';
    (RNFS.readFile as jest.Mock).mockResolvedValue(JSON.stringify(backup));

    const result = await validateBackup('/fake/path/backup.json');
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('校验和'));
  });

  test('validateBackup accepts v1 backup for backward compat', async () => {
    const v1Backup = {
      meta: { app_version: '1.0.0', schema_version: '3', backup_date: '2026-01-01T00:00:00Z', table_count: 17 },
      tables: makeFullTables(),
    };
    (RNFS.readFile as jest.Mock).mockResolvedValue(JSON.stringify(v1Backup));

    const result = await validateBackup('/fake/path/backup.json');
    expect(result.valid).toBe(true);
    expect(result.appVersion).toBe('1.0.0');
    expect(result.schemaVersion).toBe(3);
  });

  test('validateBackup returns errors for invalid format', async () => {
    (RNFS.readFile as jest.Mock).mockResolvedValue(JSON.stringify({
      format: 'wrong-format',
      format_version: 2,
      meta: {},
      tables: {},
    }));

    const result = await validateBackup('/fake/path/backup.json');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('validateBackup handles unreadable file', async () => {
    (RNFS.readFile as jest.Mock).mockRejectedValue(new Error('file not found'));

    const result = await validateBackup('/fake/path/backup.json');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('restoreFromBackup validates and restores v2 backup', async () => {
    const backup = makeV2Backup({ projects: [{ id: 1, name: '恢复项目' }] });
    // Compute real checksum
    const tablesJson = JSON.stringify(backup.tables);
    let hash = 0;
    const prime = 2147483647;
    for (let i = 0; i < tablesJson.length; i++) {
      hash = (hash * 31 + tablesJson.charCodeAt(i)) % prime;
    }
    backup.meta.checksum = `${tablesJson.length}:${tablesJson.substring(0, 50)}:${hash}`;

    (RNFS.readFile as jest.Mock).mockResolvedValue(JSON.stringify(backup));

    const mockDb = createMockDb(makeFullTables());
    await restoreFromBackup(mockDb, '/fake/path/backup.json');

    expect(RNFS.readFile).toHaveBeenCalledWith('/fake/path/backup.json', 'utf8');
    expect(mockDb.transaction).toHaveBeenCalled();
  });

  test('restoreFromBackup throws on validation failure', async () => {
    (RNFS.readFile as jest.Mock).mockResolvedValue(JSON.stringify({
      format: 'wrong',
      format_version: 99,
      meta: {},
      tables: {},
    }));

    const mockDb = createMockDb({});
    await expect(restoreFromBackup(mockDb, '/fake/path/backup.json')).rejects.toThrow('备份验证失败');
  });

  test('restoreFromBackup skips api_key in llm_config', async () => {
    const backup = makeV2Backup({
      llm_config: [{ id: 1, name: 'test', api_key: 'secret-key', base_url: 'http://x' }],
    });
    const tablesJson = JSON.stringify(backup.tables);
    let hash = 0;
    const prime = 2147483647;
    for (let i = 0; i < tablesJson.length; i++) {
      hash = (hash * 31 + tablesJson.charCodeAt(i)) % prime;
    }
    backup.meta.checksum = `${tablesJson.length}:${tablesJson.substring(0, 50)}:${hash}`;

    (RNFS.readFile as jest.Mock).mockResolvedValue(JSON.stringify(backup));

    const mockDb = createMockDb(makeFullTables());
    await restoreFromBackup(mockDb, '/fake/path/backup.json');

    // Check that the INSERT for llm_config did not include api_key
    const insertCalls = (mockDb.executeSql as jest.Mock).mock.calls.filter(
      (c: string[]) => c[0].includes('INSERT INTO llm_config'),
    );
    if (insertCalls.length > 0) {
      const sql = insertCalls[0][0];
      expect(sql).not.toContain('api_key');
    }
  });

  test('listBackups returns sorted summaries', async () => {
    const backup1 = makeV2Backup({}, { created_at: '2026-01-01T00:00:00Z', kind: 'automatic' });
    const backup2 = makeV2Backup({}, { created_at: '2026-06-01T00:00:00Z', kind: 'manual' });

    const files = [
      { name: 'backup_v1_1.json', path: '/a/1.json', mtime: new Date('2026-01-01'), size: 100 },
      { name: 'manual_v1_2.json', path: '/a/2.json', mtime: new Date('2026-06-01'), size: 200 },
    ];
    (RNFS.readDir as jest.Mock).mockResolvedValue(files);
    (RNFS.readFile as jest.Mock)
      .mockResolvedValueOnce(JSON.stringify(backup1))
      .mockResolvedValueOnce(JSON.stringify(backup2));

    const summaries = await listBackups();
    expect(summaries).toHaveLength(2);
    // Newest first
    expect(summaries[0].kind).toBe('manual');
    expect(summaries[1].kind).toBe('automatic');
  });

  test('listBackups handles unparseable files as invalid', async () => {
    const files = [
      { name: 'bad.json', path: '/a/bad.json', mtime: new Date(), size: 10 },
    ];
    (RNFS.readDir as jest.Mock).mockResolvedValue(files);
    (RNFS.readFile as jest.Mock).mockRejectedValue(new Error('parse error'));

    const summaries = await listBackups();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].valid).toBe(false);
  });

  test('deleteBackup removes existing file', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    await deleteBackup('/a/backup.json');
    expect(RNFS.unlink).toHaveBeenCalledWith('/a/backup.json');
  });

  test('deleteBackup skips non-existent file', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(false);
    await deleteBackup('/a/backup.json');
    expect(RNFS.unlink).not.toHaveBeenCalled();
  });

  test('cleanupOldBackups keeps per-kind limits', async () => {
    const makeFile = (name: string, kind: string, idx: number) => ({
        name,
        path: `/a/${name}`,
        mtime: new Date(Date.now() - idx * 1000),
        size: 100,
        kind,
      });

    // 4 automatic, 11 manual, 4 pre_restore
    const files = [
      makeFile('backup_v1_0.json', 'automatic', 0),
      makeFile('backup_v1_1.json', 'automatic', 1),
      makeFile('backup_v1_2.json', 'automatic', 2),
      makeFile('backup_v1_3.json', 'automatic', 3),
      makeFile('manual_v1_0.json', 'manual', 4),
      makeFile('manual_v1_1.json', 'manual', 5),
      makeFile('manual_v1_2.json', 'manual', 6),
      makeFile('manual_v1_3.json', 'manual', 7),
      makeFile('manual_v1_4.json', 'manual', 8),
      makeFile('manual_v1_5.json', 'manual', 9),
      makeFile('manual_v1_6.json', 'manual', 10),
      makeFile('manual_v1_7.json', 'manual', 11),
      makeFile('manual_v1_8.json', 'manual', 12),
      makeFile('manual_v1_9.json', 'manual', 13),
      makeFile('manual_v1_10.json', 'manual', 14),
      makeFile('prerestore_v1_0.json', 'pre_restore', 15),
      makeFile('prerestore_v1_1.json', 'pre_restore', 16),
      makeFile('prerestore_v1_2.json', 'pre_restore', 17),
      makeFile('prerestore_v1_3.json', 'pre_restore', 18),
    ];

    (RNFS.readDir as jest.Mock).mockResolvedValue(files);
    // Each readFile returns a valid v2 backup
    for (const f of files) {
      const kind = f.name.startsWith('manual_') ? 'manual' : f.name.startsWith('prerestore_') ? 'pre_restore' : 'automatic';
      const backup = makeV2Backup({}, { kind, created_at: f.mtime.toISOString() });
      (RNFS.readFile as jest.Mock).mockResolvedValueOnce(JSON.stringify(backup));
    }

    // Need enough mock returns for validateBackup calls too
    // listBackups calls readFile once per file, then validateBackup calls readFile again
    // So we need double the mocks
    for (const f of files) {
      const kind = f.name.startsWith('manual_') ? 'manual' : f.name.startsWith('prerestore_') ? 'pre_restore' : 'automatic';
      const backup = makeV2Backup({}, { kind, created_at: f.mtime.toISOString() });
      (RNFS.readFile as jest.Mock).mockResolvedValueOnce(JSON.stringify(backup));
    }

    await cleanupOldBackups();

    // Should delete: 1 automatic (4-3), 1 manual (11-10), 1 pre_restore (4-3) = 3 total
    expect(RNFS.unlink).toHaveBeenCalledTimes(3);
  });
});

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
import { sha256Hex } from '../src/services/continuation/hashUtils';

type TableRows = Record<string, any>[];

const ALL_TABLES = SCHEMA_MANIFEST
  .filter(table => table.backup)
  .slice()
  .sort((a, b) => a.restoreOrder - b.restoreOrder)
  .map(table => table.name);
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
    (RNFS.moveFile as jest.Mock).mockResolvedValue(undefined);
    (RNFS.readFile as jest.Mock).mockResolvedValue('{}');
    (RNFS.mkdir as jest.Mock).mockResolvedValue(undefined);
    (RNFS.readDir as jest.Mock).mockResolvedValue([]);
    (RNFS.unlink as jest.Mock).mockResolvedValue(undefined);
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env.FAIL_RESTORE_AT_STATEMENT;
  });

  test('createBackup exports the manifest tables with v3 SHA-256 and no external assets', async () => {
    const mockDb = createMockDb({
      projects: [{ id: 1, name: '测试项目' }],
      chapters: [{ id: 1, project_id: 1, title: '第1章' }],
      llm_config: [{ id: 1, name: '云端', api_key: 'sk-test-only', is_active: 1 }],
      settings: [{ key: 'webdav_password', value: 'not-a-real-secret' }],
    });

    await createBackup(mockDb, '1.2.0', 6);

    const written = JSON.parse((RNFS.writeFile as jest.Mock).mock.calls[0][1]);
    expect(written.format).toBe('shinewriter-backup');
    expect(written.format_version).toBe(3);
    expect(written.meta.checksum_algorithm).toBe('sha256');
    expect(written.meta.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(written.tables)).toEqual(ALL_TABLES);
    expect(written.external_assets).toEqual([]);
    expect(written.tables.llm_config[0]).not.toHaveProperty('api_key');
    expect((RNFS.writeFile as jest.Mock).mock.calls[0][1]).not.toMatch(/sk-|Bearer |"api_key"\s*:\s*"[^"\n]+"|password|token/i);
  });

  test('backup and restore preserve V4 policy, stage results, and rejected eligibility', async () => {
    const backup = await makeV3Backup({
      settings: [
        { key: 'context_auto_policy_v2', value: '{"schemaVersion":2}' },
      ],
      continuation_generation_runs: [
        {
          id: 'ct_backup_v4',
          project_id: 1,
          chapter_id: 1,
          state: 'awaiting_user',
          stage: 'awaiting_user',
        },
      ],
      continuation_generation_artifacts: [
        {
          id: 'ca_rejected',
          run_id: 'ct_backup_v4',
          stage: 'repair',
          repair_round: 0,
          parent_artifact_id: null,
          content: '拒绝终稿',
          content_hash: 'rejected-hash',
          eligibility_status: 'rejected',
          rejection_code: 'length_out_of_range',
          created_at: '2026-08-03T00:00:00.000Z',
        },
      ],
      continuation_generation_stage_results: [
        {
          id: 'csr_repair',
          run_id: 'ct_backup_v4',
          stage: 'repair',
          status: 'success',
          request_reserved: 1,
          request_count: 1,
          model_config_id: 2,
          input_tokens: 100,
          output_tokens: 200,
          min_output_tokens: 80,
          max_output_tokens: 220,
          output_json: '{"kind":"full_final"}',
          artifact_id: 'ca_rejected',
          error_code: null,
          error_message: null,
          started_at: '2026-08-03T00:00:00.000Z',
          completed_at: '2026-08-03T00:00:02.000Z',
          created_at: '2026-08-03T00:00:00.000Z',
          updated_at: '2026-08-03T00:00:02.000Z',
        },
      ],
    });
    writeBackup(backup);
    const mockDb = createMockDb(makeFullTables());

    await restoreFromBackup(mockDb, '/fake/path/v4.json', {
      createPreRestoreBackup: false,
    });

    expect(mockDb.tableData.settings).toContainEqual({
      key: 'context_auto_policy_v2',
      value: '{"schemaVersion":2}',
    });
    expect(mockDb.tableData.continuation_generation_stage_results).toContainEqual(
      expect.objectContaining({ id: 'csr_repair', artifact_id: 'ca_rejected' }),
    );
    expect(mockDb.tableData.continuation_generation_artifacts).toContainEqual(
      expect.objectContaining({
        id: 'ca_rejected',
        eligibility_status: 'rejected',
        rejection_code: 'length_out_of_range',
      }),
    );
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

  test('createBackup publishes atomically only after the staging write succeeds', async () => {
    const mockDb = createMockDb({ projects: [{ id: 1, name: '原子备份' }] });

    const filePath = await createBackup(mockDb, '1.2.0', 6, 'manual');

    const stagingPath = (RNFS.writeFile as jest.Mock).mock.calls[0][0];
    expect(stagingPath).toBe(`${filePath}.tmp`);
    expect(RNFS.moveFile).toHaveBeenCalledWith(stagingPath, filePath);
  });

  test('createBackup removes an ENOSPC staging file without publishing a corrupt backup', async () => {
    const mockDb = createMockDb({ projects: [{ id: 1, name: '空间不足' }] });
    const enospc = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    });
    (RNFS.writeFile as jest.Mock).mockRejectedValueOnce(enospc);

    await expect(createBackup(mockDb, '1.2.0', 6, 'manual')).rejects.toBe(enospc);

    const stagingPath = (RNFS.writeFile as jest.Mock).mock.calls[0][0];
    expect(stagingPath).toMatch(/\.json\.tmp$/);
    expect(RNFS.unlink).toHaveBeenCalledWith(stagingPath);
    expect(RNFS.moveFile).not.toHaveBeenCalled();
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

  test('restores an active Canon/style pointer cycle only after parent rows exist', async () => {
    const backup = await makeV3Backup({
      projects: [{ id: 2, name: '含激活指针的项目' }],
      continuation_sources: [{
        id: 10,
        project_id: 2,
        version: 1,
        normalized_sha256: 'source-sha',
        parser_version: 'parser-1',
        normalization_version: 'normalizer-1',
      }],
      continuation_source_chapters: [{
        id: 100,
        source_id: 10,
        position: 4,
      }],
      continuation_canon_snapshots: [{
        id: 'canon-1',
        project_id: 2,
        source_id: 10,
        boundary_chapter_id: 100,
        boundary_char_offset_exclusive: 42,
        status: 'ready',
      }],
      continuation_style_profiles: [{
        id: 'style-1',
        project_id: 2,
        source_id: 10,
        source_version: 1,
        source_sha256: 'source-sha',
        parser_version: 'parser-1',
        normalization_version: 'normalizer-1',
        boundary_chapter_id: 100,
        boundary_position: 4,
        boundary_char_offset_exclusive: 42,
        canon_snapshot_id: 'canon-1',
        state: 'ready',
        review_status: 'confirmed',
      }],
      continuation_settings: [{
        project_id: 2,
        active_source_id: 10,
        boundary_chapter_id: 100,
        boundary_char_offset_global: 42,
        active_canon_snapshot_id: 'canon-1',
        active_style_profile_id: 'style-1',
      }],
    });
    writeBackup(backup);
    const mockDb = createMockDb(makeFullTables());

    await expect(
      restoreFromBackup(mockDb, '/fake/path/active.json', {
        createPreRestoreBackup: false,
      }),
    ).resolves.toMatchObject({
      missingLocalModels: [],
    });

    const updates = mockDb.executeSql.mock.calls
      .map((call: any[]) => String(call[0]).replace(/\s+/g, ' ').trim())
      .filter((sql: string) => sql.startsWith('UPDATE continuation_settings'));
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates.some((sql: string) => sql.includes('active_canon_snapshot_id = ?'))).toBe(true);
  });

  test('rejects an active style whose source or boundary disagrees with settings', async () => {
    const backup = await makeV3Backup({
      projects: [{ id: 2, name: '指针不一致' }],
      continuation_sources: [{
        id: 10,
        project_id: 2,
        version: 1,
        normalized_sha256: 'source-sha',
        parser_version: 'parser-1',
        normalization_version: 'normalizer-1',
      }],
      continuation_source_chapters: [{ id: 100, source_id: 10, position: 4 }],
      continuation_canon_snapshots: [{
        id: 'canon-1',
        project_id: 2,
        source_id: 10,
        boundary_chapter_id: 100,
        boundary_char_offset_exclusive: 42,
      }],
      continuation_style_profiles: [{
        id: 'style-1',
        project_id: 2,
        source_id: 10,
        source_version: 1,
        source_sha256: 'different-sha',
        parser_version: 'parser-1',
        normalization_version: 'normalizer-1',
        boundary_chapter_id: 100,
        boundary_position: 4,
        boundary_char_offset_exclusive: 42,
        canon_snapshot_id: 'canon-1',
      }],
      continuation_settings: [{
        project_id: 2,
        active_source_id: 10,
        boundary_chapter_id: 100,
        boundary_char_offset_global: 42,
        active_canon_snapshot_id: 'canon-1',
        active_style_profile_id: 'style-1',
      }],
    });
    writeBackup(backup);

    await expect(
      restoreFromBackup(createMockDb(makeFullTables()), '/fake/path/invalid.json', {
        createPreRestoreBackup: false,
      }),
    ).rejects.toThrow('备份 active Style 与项目 2 的 source/boundary 不一致');
  });

  test('restore statement injection preserves the original database and pre-restore backup', async () => {
    const backup = await makeV3Backup({
      projects: [{ id: 2, name: '注入后的新项目' }],
      chapters: [{ id: 2, project_id: 2, title: '注入后的新章节' }],
    });
    writeBackup(backup);
    const mockDb = createMockDb(
      makeFullTables({ projects: [{ id: 1, name: '注入前原项目' }] }),
    );
    const before = mockDb.snapshot();
    process.env.FAIL_RESTORE_AT_STATEMENT = '3';

    await expect(
      restoreFromBackup(mockDb, '/fake/path/backup.json'),
    ).rejects.toThrow('FAULT_INJECTION: restore statement 3');

    expect(mockDb.snapshot()).toEqual(before);
    expect(RNFS.moveFile).toHaveBeenCalledWith(
      expect.stringMatching(/prerestore_.*\.json\.tmp$/),
      expect.stringMatching(/prerestore_.*\.json$/),
    );
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
    backup.meta.checksum = await computeBackupChecksum(backup);
    writeBackup(backup);
    const mockDb = createMockDb(makeFullTables({
      character_collections: [{ id: 99, project_id: 1, name: '保留集合' }],
    }));

    await restoreFromBackup(mockDb, '/fake/path/backup.json', { createPreRestoreBackup: false });
    expect(mockDb.tableData.character_collections).toEqual([{ id: 99, project_id: 1, name: '保留集合' }]);
  });

  test('restoreFromBackup reports empty missingLocalModels (local models are no longer in backups)', async () => {
    const backup = await makeV3Backup({
      projects: [{ id: 1, name: 'p1' }],
      llm_config: [{ id: 1, provider_type: 'openai_compatible', is_active: 1, base_url: 'https://x', model_name: 'm' }],
    });
    writeBackup(backup);
    const mockDb = createMockDb(makeFullTables());

    const result = await restoreFromBackup(mockDb, '/fake/path/backup.json', { createPreRestoreBackup: false });
    expect(result.missingLocalModels).toEqual([]);
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

  /**
   * 兼容性守卫：流式分片版 computeBackupChecksum 的 digest 必须与历史
   * one-shot 语义（sha256(JSON.stringify(payload))）完全一致，否则存量
   * v3 备份会被误判为「校验和不匹配 → 已损坏」，召回功能直接不可用。
   */
  test('streaming checksum digest equals legacy one-shot payload digest', async () => {
    // 单表 JSON 超过 64K 字符，强制跨多个分片边界；含中文 + emoji（surrogate pair）。
    const longText = Array.from({ length: 3000 }, (_, i) => `第${i}章内容：这是一段正文文本。✨`).join('');
    const backup = await makeV3Backup({
      chapters: [
        { id: 'ch-1', project_id: 'p-1', title: '第一章', content: longText, sort_order: 1 },
        { id: 'ch-2', project_id: 'p-1', title: '第二章', content: '短内容📖', sort_order: 2 },
      ],
      projects: [{ id: 'p-1', title: '测试项目', created_at: '2026-06-13T00:00:00Z' }],
    });

    // 历史语义参照：对整份 payload 字符串一次性哈希（旧 checksumPayload + one-shot sha256）。
    const legacyPayload = JSON.stringify({
      format: backup.format,
      format_version: backup.format_version,
      meta: { ...backup.meta, checksum: undefined },
      tables: backup.tables,
      external_assets: backup.external_assets,
    });
    const legacyDigest = sha256Hex(legacyPayload);

    await expect(computeBackupChecksum(backup)).resolves.toBe(legacyDigest);
    // meta.checksum 本身也是用同一套算法算的，round-trip 必须自洽。
    expect(backup.meta.checksum).toBe(legacyDigest);
  });
});

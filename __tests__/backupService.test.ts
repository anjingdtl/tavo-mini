/* eslint-env jest */

import RNFS from 'react-native-fs';
import { createBackup, restoreFromBackup, cleanupOldBackups } from '../src/services/backupService';

type TableRows = Record<string, any>[];

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

  return { executeSql } as any;
}

describe('backupService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (RNFS.writeFile as jest.Mock).mockResolvedValue(undefined);
    (RNFS.readFile as jest.Mock).mockResolvedValue('{}');
    (RNFS.mkdir as jest.Mock).mockResolvedValue(undefined);
    (RNFS.readDir as jest.Mock).mockResolvedValue([]);
    (RNFS.unlink as jest.Mock).mockResolvedValue(undefined);
  });

  test('createBackup exports all tables to JSON file', async () => {
    const mockDb = createMockDb({
      projects: [{ id: 1, name: '测试项目' }],
      chapters: [{ id: 1, project_id: 1, title: '第1章' }],
    });

    const backupPath = await createBackup(mockDb, '1.2.0', '3');

    expect(backupPath).toBeTruthy();
    expect(RNFS.mkdir).toHaveBeenCalled();
    expect(RNFS.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('backup_v1.2.0_'),
      expect.any(String),
      'utf8',
    );

    const writtenJson = JSON.parse((RNFS.writeFile as jest.Mock).mock.calls[0][1]);
    expect(writtenJson.meta.app_version).toBe('1.2.0');
    expect(writtenJson.meta.schema_version).toBe('3');
    expect(writtenJson.tables.projects).toHaveLength(1);
    expect(writtenJson.tables.chapters).toHaveLength(1);
  });

  test('restoreFromBackup reads JSON and inserts into database', async () => {
    const backupData = {
      meta: { app_version: '1.2.0', schema_version: '3', backup_date: '2026-05-31T10:00:00Z', table_count: 2 },
      tables: {
        projects: [{ id: 1, name: '恢复项目' }],
        chapters: [],
      },
    };
    (RNFS.readFile as jest.Mock).mockResolvedValue(JSON.stringify(backupData));

    const mockDb = createMockDb({ projects: [], chapters: [] });

    await restoreFromBackup(mockDb, '/fake/path/backup.json');

    expect(RNFS.readFile).toHaveBeenCalledWith('/fake/path/backup.json', 'utf8');
  });

  test('cleanupOldBackups keeps only 3 most recent', async () => {
    const files = [
      { name: 'backup_v1.0.0_1.json', path: '/a/1.json', mtime: new Date('2026-01-01') },
      { name: 'backup_v1.1.0_2.json', path: '/a/2.json', mtime: new Date('2026-02-01') },
      { name: 'backup_v1.2.0_3.json', path: '/a/3.json', mtime: new Date('2026-03-01') },
      { name: 'backup_v1.3.0_4.json', path: '/a/4.json', mtime: new Date('2026-04-01') },
    ];
    (RNFS.readDir as jest.Mock).mockResolvedValue(files);

    await cleanupOldBackups();

    expect(RNFS.unlink).toHaveBeenCalledTimes(1);
    expect(RNFS.unlink).toHaveBeenCalledWith('/a/1.json');
  });
});

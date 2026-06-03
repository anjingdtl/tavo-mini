/* eslint-env jest */

type TableRows = Record<string, any>[];

const createRows = (rows: TableRows) => ({
  length: rows.length,
  item: (index: number) => rows[index],
  raw: () => rows,
});

function createMockDb(existingSettings: Record<string, string> = {}) {
  const settings = new Map<string, string>(Object.entries(existingSettings));
  const executed: string[] = [];

  const executeSql = jest.fn(async (sql: string, params: any[] = []) => {
    executed.push(sql);
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (/^SELECT value FROM settings WHERE key = \?/i.test(normalized)) {
      const value = settings.get(params[0]);
      const rows = value !== undefined ? [{ value }] : [];
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(rows) }];
    }

    if (/^INSERT OR REPLACE INTO settings/i.test(normalized)) {
      settings.set(params[0], params[1]);
      return [{ insertId: 0, rowsAffected: 1, rows: createRows([]) }];
    }

    if (/^SELECT id FROM worldbook_collections/i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 0, rows: createRows([{ id: 1 }]) }];
    }

    return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
  });

  const db = {
    executeSql,
    transaction: jest.fn(async (scope: (tx: { executeSql: typeof executeSql }) => void) => {
      await scope({ executeSql });
    }),
  };

  return { db, settings, executed };
}

describe('install type detection', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('detects fresh install when no app_version exists', async () => {
    const { db, settings } = createMockDb({});
    const { detectInstallType } = require('../src/services/database');
    const info = await detectInstallType(db as any);
    expect(info.installType).toBe('fresh');
    expect(info.previousVersion).toBeNull();
    expect(settings.get('app_version')).toBeTruthy();
    expect(settings.get('install_type')).toBe('fresh');
    expect(settings.get('first_install_version')).toBeTruthy();
  });

  test('detects upgrade when stored version < current version', async () => {
    const { db, settings } = createMockDb({
      app_version: '1.0.0',
      schema_version: '3',
      first_install_version: '1.0.0',
    });
    const { detectInstallType } = require('../src/services/database');
    const info = await detectInstallType(db as any);
    expect(info.installType).toBe('upgrade');
    expect(info.previousVersion).toBe('1.0.0');
    expect(settings.get('previous_version')).toBe('1.0.0');
    expect(settings.get('install_type')).toBe('upgrade');
  });

  test('detects same version when stored version = current version', async () => {
    const { db, settings } = createMockDb({
      app_version: '1.3.7',
      schema_version: '5',
      first_install_version: '1.0.0',
    });
    const { detectInstallType } = require('../src/services/database');
    const info = await detectInstallType(db as any);
    expect(info.installType).toBe('same');
    expect(settings.get('install_type')).toBe('same');
  });
});

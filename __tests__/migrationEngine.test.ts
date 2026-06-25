/* eslint-env jest */

type TableRows = Record<string, any>[];

const createRows = (rows: TableRows) => ({
  length: rows.length,
  item: (index: number) => rows[index],
  raw: () => rows,
});

function createMockDb(startSchemaVersion: string | null) {
  const settings = new Map<string, string>();
  if (startSchemaVersion !== null) {
    settings.set('schema_version', startSchemaVersion);
  }
  const executed: string[] = [];

  const executeSql = jest.fn(async (sql: string, params: any[] = []) => {
    executed.push(sql);
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (/^SELECT value FROM settings WHERE key = \?/i.test(normalized)) {
      const key = params[0];
      const value = settings.get(key);
      const rows = value !== undefined ? [{ value }] : [];
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(rows) }];
    }

    if (/^INSERT OR REPLACE INTO settings/i.test(normalized)) {
      settings.set(params[0], params[1]);
      return [{ insertId: 0, rowsAffected: 1, rows: createRows([]) }];
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

describe('migration engine', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('runs no migrations when already at latest version', async () => {
    const { db, settings } = createMockDb('9');
    const { runMigrations } = require('../src/services/migrations');
    const result = await runMigrations(db as any, 9);
    expect(result.migrationsRun).toBe(0);
    expect(result.hadBreaking).toBe(false);
    expect(settings.get('schema_version')).toBe('9');
  });

  test('runs only needed migrations from v3 to v9', async () => {
    const { db, settings } = createMockDb('3');
    const { runMigrations } = require('../src/services/migrations');
    const result = await runMigrations(db as any, 3);
    expect(result.fromVersion).toBe(3);
    expect(result.toVersion).toBe(9);
    expect(result.migrationsRun).toBe(6);
    expect(settings.get('schema_version')).toBe('9');
  });

  test('detects breaking migrations', async () => {
    const { db } = createMockDb('2');
    const { runMigrations } = require('../src/services/migrations');
    const result = await runMigrations(db as any, 2);
    expect(result.hadBreaking).toBe(true);
  });

  test('returns null backupPath when no breaking migration', async () => {
    const { db } = createMockDb('4');
    const { runMigrations } = require('../src/services/migrations');
    const result = await runMigrations(db as any, 4);
    expect(result.backupPath).toBeNull();
    expect(result.hadBreaking).toBe(false);
  });
});

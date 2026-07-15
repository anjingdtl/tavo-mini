/* eslint-env jest */

import appVersionJson from '../src/constants/version.json';
import {
  initializeDatabase,
  lastInstallInfo,
  repairKnownSchemaDefects,
} from '../src/services/database';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';
import { SCHEMA_VERSION } from '../src/services/migrations';

function createRows(rows: Record<string, any>[]) {
  return {
    length: rows.length,
    item: (index: number) => rows[index],
    raw: () => rows,
  };
}

function createLifecycleDb(
  options: {
    schemaVersion?: number;
    fresh?: boolean;
    failWhenSqlIncludes?: string;
  } = {},
) {
  const schemaVersion = options.schemaVersion ?? SCHEMA_VERSION;
  const tables = new Map<string, Set<string>>();
  const indexes = new Map<string, Set<string>>();
  const settings = new Map<string, string>();
  let activeConfigs: Record<string, any>[] = [];
  const executed: string[] = [];

  const seedCurrentSchema = () => {
    for (const table of SCHEMA_MANIFEST) {
      tables.set(table.name, new Set(table.columns));
      indexes.set(table.name, new Set(table.indexes || []));
    }
  };

  if (!options.fresh) {
    seedCurrentSchema();
    settings.set('schema_version', String(schemaVersion));
    settings.set('app_version', '1.0.0');
    settings.set('first_install_version', '1.0.0');
    if (schemaVersion === 13) {
      tables.get('project_note_config')?.delete('retrieval_fragment_chars');
    }
  }

  type State = {
    tables: Map<string, Set<string>>;
    indexes: Map<string, Set<string>>;
    settings: Map<string, string>;
    activeConfigs: Record<string, any>[];
  };
  const cloneState = (): State => ({
    tables: new Map(
      Array.from(tables.entries()).map(([name, cols]) => [name, new Set(cols)]),
    ),
    indexes: new Map(
      Array.from(indexes.entries()).map(([name, values]) => [
        name,
        new Set(values),
      ]),
    ),
    settings: new Map(settings),
    activeConfigs: activeConfigs.map(config => ({ ...config })),
  });

  const apply = (state: State, sql: string, params: any[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    executed.push(normalized);
    if (
      options.failWhenSqlIncludes &&
      normalized.includes(options.failWhenSqlIncludes)
    ) {
      throw new Error(
        `Injected lifecycle failure: ${options.failWhenSqlIncludes}`,
      );
    }

    const createTable = normalized.match(/^CREATE TABLE IF NOT EXISTS (\w+)/i);
    if (createTable) {
      const manifest = SCHEMA_MANIFEST.find(
        table => table.name === createTable[1],
      );
      if (manifest && !state.tables.has(createTable[1])) {
        state.tables.set(createTable[1], new Set(manifest.columns));
        state.indexes.set(createTable[1], new Set(manifest.indexes || []));
      }
      return [{ rows: createRows([]), rowsAffected: 0, insertId: 0 }];
    }
    const alter = normalized.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/i);
    if (alter) {
      const columns = state.tables.get(alter[1]) || new Set<string>();
      columns.add(alter[2]);
      state.tables.set(alter[1], columns);
      return [{ rows: createRows([]), rowsAffected: 1, insertId: 0 }];
    }
    const createIndex = normalized.match(
      /^CREATE INDEX IF NOT EXISTS (\w+) ON (\w+)/i,
    );
    if (createIndex) {
      const tableIndexes =
        state.indexes.get(createIndex[2]) || new Set<string>();
      tableIndexes.add(createIndex[1]);
      state.indexes.set(createIndex[2], tableIndexes);
      return [{ rows: createRows([]), rowsAffected: 0, insertId: 0 }];
    }
    if (/^PRAGMA foreign_keys/i.test(normalized)) {
      return [
        {
          rows: createRows([{ foreign_keys: 1 }]),
          rowsAffected: 0,
          insertId: 0,
        },
      ];
    }
    if (
      /^SELECT name FROM sqlite_master WHERE type = 'table' AND name = \?/i.test(
        normalized,
      )
    ) {
      return [
        {
          rows: createRows(
            state.tables.has(params[0]) ? [{ name: params[0] }] : [],
          ),
          rowsAffected: 0,
          insertId: 0,
        },
      ];
    }
    if (
      /^SELECT name FROM sqlite_master WHERE type = 'table'/i.test(normalized)
    ) {
      return [
        {
          rows: createRows(
            Array.from(state.tables.keys()).map(name => ({ name })),
          ),
          rowsAffected: 0,
          insertId: 0,
        },
      ];
    }
    const tableInfo = normalized.match(/^PRAGMA table_info\((\w+)\)/i);
    if (tableInfo) {
      return [
        {
          rows: createRows(
            Array.from(state.tables.get(tableInfo[1]) || []).map(name => ({
              name,
            })),
          ),
          rowsAffected: 0,
          insertId: 0,
        },
      ];
    }
    if (
      /^SELECT name FROM sqlite_master WHERE type = 'index'/i.test(normalized)
    ) {
      return [
        {
          rows: createRows(
            Array.from(state.indexes.get(params[0]) || []).map(name => ({
              name,
            })),
          ),
          rowsAffected: 0,
          insertId: 0,
        },
      ];
    }
    if (/^SELECT value FROM settings/i.test(normalized)) {
      const value = state.settings.get(params[0]);
      return [
        {
          rows: createRows(value === undefined ? [] : [{ value }]),
          rowsAffected: 0,
          insertId: 0,
        },
      ];
    }
    if (/^INSERT OR REPLACE INTO settings/i.test(normalized)) {
      state.settings.set(params[0], params[1]);
      return [{ rows: createRows([]), rowsAffected: 1, insertId: 0 }];
    }
    if (/^SELECT id, provider_type, local_model_id/i.test(normalized)) {
      return [
        { rows: createRows(state.activeConfigs), rowsAffected: 0, insertId: 0 },
      ];
    }
    if (/^SELECT id FROM local_llm_models/i.test(normalized)) {
      return [{ rows: createRows([]), rowsAffected: 0, insertId: 0 }];
    }
    if (/^SELECT id FROM llm_config WHERE is_active = 1/i.test(normalized)) {
      return [
        { rows: createRows(state.activeConfigs), rowsAffected: 0, insertId: 0 },
      ];
    }
    if (/^INSERT OR IGNORE INTO llm_config/i.test(normalized)) {
      if (state.activeConfigs.length === 0) {
        state.activeConfigs.push({
          id: 1,
          provider_type: 'openai_compatible',
          local_model_id: null,
        });
      }
      return [{ rows: createRows([]), rowsAffected: 1, insertId: 1 }];
    }
    if (/^SELECT .*LEFT JOIN/i.test(normalized)) {
      return [{ rows: createRows([]), rowsAffected: 0, insertId: 0 }];
    }
    if (/^SELECT id, title FROM notes/i.test(normalized)) {
      return [{ rows: createRows([]), rowsAffected: 0, insertId: 0 }];
    }
    return [{ rows: createRows([]), rowsAffected: 0, insertId: 1 }];
  };

  const database = {
    executeSql: jest.fn(async (sql: string, params: any[] = []) =>
      apply({ tables, indexes, settings, activeConfigs }, sql, params),
    ),
    transaction: jest.fn(
      (
        scope: (tx: {
          executeSql: (sql: string, params?: any[]) => void;
        }) => void,
        onError: (error: unknown) => void,
        onSuccess: () => void,
      ) => {
        const start = executed.length;
        const staged = cloneState();
        try {
          scope({
            executeSql: (sql, params = []) => apply(staged, sql, params),
          });
          tables.clear();
          for (const [name, columns] of staged.tables)
            tables.set(name, columns);
          indexes.clear();
          for (const [name, values] of staged.indexes)
            indexes.set(name, values);
          settings.clear();
          for (const [key, value] of staged.settings) settings.set(key, value);
          activeConfigs = staged.activeConfigs;
          onSuccess();
        } catch (error) {
          executed.splice(start);
          onError(error);
        }
      },
    ),
  };

  return {
    database,
    tables,
    indexes,
    settings,
    activeConfigs: () => activeConfigs,
    executed,
  };
}

describe('database initialization lifecycle', () => {
  test('fresh install creates the latest schema before seeding and finalizing app metadata', async () => {
    const mock = createLifecycleDb({ fresh: true });

    await initializeDatabase(mock.database as any);

    expect(mock.settings.get('schema_version')).toBe(String(SCHEMA_VERSION));
    expect(mock.settings.get('app_version')).toBe(
      appVersionJson.versionName.replace(/^V/, ''),
    );
    expect(mock.tables.has('project_note_config')).toBe(true);
    const schemaProbeIndex = mock.executed.findIndex(sql =>
      sql.startsWith("SELECT name FROM sqlite_master WHERE type = 'table'"),
    );
    const seedIndex = mock.executed.findIndex(sql =>
      sql.startsWith('INSERT OR IGNORE INTO llm_config'),
    );
    expect(seedIndex).toBeGreaterThan(schemaProbeIndex);
    const indexIndex = mock.executed.findIndex(
      (sql, index) =>
        index > seedIndex &&
        sql.startsWith('CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_config'),
    );
    const derivedRepairIndex = mock.executed.findIndex(
      (sql, index) =>
        index > indexIndex && sql.startsWith('SELECT id, title FROM notes'),
    );
    expect(indexIndex).toBeGreaterThan(seedIndex);
    expect(derivedRepairIndex).toBeGreaterThan(indexIndex);
  });

  test.each([8, 13])(
    'upgrades schema %i before validation and seed',
    async schemaVersion => {
      const mock = createLifecycleDb({ schemaVersion });

      await initializeDatabase(mock.database as any);

      expect(mock.settings.get('schema_version')).toBe(String(SCHEMA_VERSION));
      expect(mock.settings.get('app_version')).toBe(
        appVersionJson.versionName.replace(/^V/, ''),
      );
      expect(lastInstallInfo?.schemaVersion).toBe(schemaVersion);
      const validationIndex = mock.executed.findIndex(sql =>
        sql.startsWith("SELECT name FROM sqlite_master WHERE type = 'table'"),
      );
      const seedIndex = mock.executed.findIndex(sql =>
        sql.startsWith('INSERT OR IGNORE INTO llm_config'),
      );
      expect(validationIndex).toBeGreaterThan(-1);
      expect(seedIndex).toBeGreaterThan(validationIndex);
      const indexIndex = mock.executed.findIndex(
        (sql, index) =>
          index > seedIndex &&
          sql.startsWith(
            'CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_config',
          ),
      );
      expect(indexIndex).toBeGreaterThan(seedIndex);
    },
  );

  test('repairs a missing deterministic usage index before startup can fail', async () => {
    const mock = createLifecycleDb({ schemaVersion: SCHEMA_VERSION });
    mock.indexes.get('llm_usage_logs')?.delete('idx_llm_usage_logs_config');

    await initializeDatabase(mock.database as any);

    expect(mock.indexes.get('llm_usage_logs')).toContain(
      'idx_llm_usage_logs_config',
    );
    const repairIndex = mock.executed.findIndex(
      sql =>
        sql.startsWith(
          'CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_config',
        ),
    );
    const seedIndex = mock.executed.findIndex(sql =>
      sql.startsWith('INSERT OR IGNORE INTO llm_config'),
    );
    expect(repairIndex).toBeGreaterThan(-1);
    expect(repairIndex).toBeLessThan(seedIndex);
  });

  test('schema 13 missing retrieval column is repaired by migration, not startup fallback', async () => {
    const mock = createLifecycleDb({ schemaVersion: 13 });

    await initializeDatabase(mock.database as any);

    expect(mock.executed).toContain(
      'ALTER TABLE project_note_config ADD COLUMN retrieval_fragment_chars INTEGER NOT NULL DEFAULT 1000',
    );
  });

  test('migration failure prevents seed and app metadata finalization', async () => {
    const mock = createLifecycleDb({
      schemaVersion: 13,
      failWhenSqlIncludes: 'ALTER TABLE project_note_config',
    });

    await expect(initializeDatabase(mock.database as any)).rejects.toThrow(
      'Injected lifecycle failure',
    );

    expect(mock.settings.get('app_version')).toBe('1.0.0');
    expect(
      mock.executed.some(sql =>
        sql.startsWith('INSERT OR IGNORE INTO llm_config'),
      ),
    ).toBe(false);
  });

  test('rejects an unsupported old schema without compatibility fallback', async () => {
    const mock = createLifecycleDb({ schemaVersion: 2 });

    await expect(initializeDatabase(mock.database as any)).rejects.toThrow(
      '无法从 Schema 2 安全升级',
    );
    expect(
      mock.executed.some(sql =>
        sql.startsWith('INSERT OR IGNORE INTO llm_config'),
      ),
    ).toBe(false);
    expect(mock.settings.get('app_version')).toBe('1.0.0');
  });

  test('rejects a database newer than the supported schema', async () => {
    const mock = createLifecycleDb({ schemaVersion: SCHEMA_VERSION + 1 });

    await expect(initializeDatabase(mock.database as any)).rejects.toThrow(
      `当前数据库 Schema ${
        SCHEMA_VERSION + 1
      } 高于应用支持的版本 ${SCHEMA_VERSION}`,
    );
    expect(
      mock.executed.some(sql =>
        sql.startsWith('INSERT OR IGNORE INTO llm_config'),
      ),
    ).toBe(false);
  });

  test('healthy current schema has no compatibility ALTER repair', async () => {
    const mock = createLifecycleDb({ schemaVersion: SCHEMA_VERSION });

    await initializeDatabase(mock.database as any);
    await repairKnownSchemaDefects(mock.database as any, SCHEMA_VERSION);

    expect(mock.executed.some(sql => sql.startsWith('ALTER TABLE'))).toBe(
      false,
    );
  });
});

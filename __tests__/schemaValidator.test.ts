/* eslint-env jest */

import {
  assertValidSchema,
  validateSchema,
} from '../src/services/database/schemaValidator';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';
import { SCHEMA_VERSION } from '../src/services/migrations';

function createRows(rows: Record<string, any>[]) {
  return {
    length: rows.length,
    item: (index: number) => rows[index],
  };
}

function createValidatorDb() {
  const tables = new Set(SCHEMA_MANIFEST.map(table => table.name));
  const columns = new Map(
    SCHEMA_MANIFEST.map(table => [table.name, new Set(table.columns)]),
  );
  const indexes = new Map(
    SCHEMA_MANIFEST.map(table => [table.name, new Set(table.indexes || [])]),
  );
  const settings = new Map([['schema_version', String(SCHEMA_VERSION)]]);
  let foreignKeys = 1;
  let activeConfigs: Record<string, any>[] = [
    { id: 1, provider_type: 'openai_compatible', local_model_id: null },
  ];
  const localModelIds = new Set<string>();
  let orphanRows: Record<string, any>[] = [];

  const executeSql = jest.fn(async (sql: string, params: any[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (
      /^SELECT name FROM sqlite_master WHERE type = 'table'/i.test(normalized)
    ) {
      return [{ rows: createRows(Array.from(tables).map(name => ({ name }))) }];
    }
    const tableInfo = normalized.match(/^PRAGMA table_info\((\w+)\)/i);
    if (tableInfo) {
      return [
        {
          rows: createRows(
            Array.from(columns.get(tableInfo[1]) || []).map(name => ({ name })),
          ),
        },
      ];
    }
    if (
      /^SELECT name FROM sqlite_master WHERE type = 'index'/i.test(normalized)
    ) {
      return [
        {
          rows: createRows(
            Array.from(indexes.get(params[0]) || []).map(name => ({ name })),
          ),
        },
      ];
    }
    if (/^PRAGMA foreign_keys/i.test(normalized)) {
      return [{ rows: createRows([{ foreign_keys: foreignKeys }]) }];
    }
    if (/^SELECT value FROM settings/i.test(normalized)) {
      const value = settings.get(params[0]);
      return [{ rows: createRows(value === undefined ? [] : [{ value }]) }];
    }
    if (/^SELECT id, provider_type, local_model_id/i.test(normalized)) {
      return [{ rows: createRows(activeConfigs) }];
    }
    if (/^SELECT id FROM local_llm_models/i.test(normalized)) {
      return [
        {
          rows: createRows(
            localModelIds.has(params[0]) ? [{ id: params[0] }] : [],
          ),
        },
      ];
    }
    if (/^SELECT .*LEFT JOIN/i.test(normalized)) {
      return [{ rows: createRows(orphanRows) }];
    }
    return [{ rows: createRows([]) }];
  });

  return {
    database: { executeSql },
    tables,
    columns,
    indexes,
    settings,
    setForeignKeys: (value: number) => {
      foreignKeys = value;
    },
    setActiveConfigs: (value: Record<string, any>[]) => {
      activeConfigs = value;
    },
    localModelIds,
    setOrphanRows: (value: Record<string, any>[]) => {
      orphanRows = value;
    },
  };
}

describe('runtime schema validator', () => {
  test('accepts the current manifest and valid active remote configuration', async () => {
    const mock = createValidatorDb();
    const result = await validateSchema(mock.database as any);

    expect(result).toEqual({ valid: true, issues: [] });
    expect(() => assertValidSchema(result)).not.toThrow();
  });

  test('reports missing table, column, and index identifiers', async () => {
    const mock = createValidatorDb();
    mock.tables.delete('notes');
    mock.columns.get('projects')?.delete('updated_at');
    mock.indexes.get('llm_usage_logs')?.delete('idx_llm_usage_logs_month');

    const result = await validateSchema(mock.database as any, {
      requireActiveLlmConfig: false,
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MISSING_TABLE', table: 'notes' }),
        expect.objectContaining({
          code: 'MISSING_COLUMN',
          table: 'projects',
          column: 'updated_at',
        }),
        expect.objectContaining({
          code: 'MISSING_INDEX',
          index: 'idx_llm_usage_logs_month',
        }),
      ]),
    );
  });

  test('reports schema version and foreign-key failures', async () => {
    const mock = createValidatorDb();
    mock.settings.set('schema_version', '13');
    mock.setForeignKeys(0);

    const result = await validateSchema(mock.database as any, {
      requireActiveLlmConfig: false,
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SCHEMA_VERSION_MISMATCH' }),
        expect.objectContaining({ code: 'FOREIGN_KEYS_DISABLED' }),
      ]),
    );
  });

  test('reports an active local configuration with a missing model', async () => {
    const mock = createValidatorDb();
    mock.setActiveConfigs([
      { id: 2, provider_type: 'llama_cpp', local_model_id: 'missing-model' },
    ]);

    const result = await validateSchema(mock.database as any);

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INVALID_ACTIVE_LLM',
          column: 'local_model_id',
        }),
      ]),
    );
  });

  test('reports orphan references', async () => {
    const mock = createValidatorDb();
    mock.setOrphanRows([{ id: 99 }]);

    const result = await validateSchema(mock.database as any, {
      requireActiveLlmConfig: false,
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'ORPHAN_REFERENCE' }),
      ]),
    );
  });
});

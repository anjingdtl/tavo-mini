/* eslint-env jest */

import { migrateV11toV12 } from '../../src/services/migrations/v11-to-v12';

type TableRows = Record<string, any>[];

const createRows = (rows: TableRows) => ({
  length: rows.length,
  item: (index: number) => rows[index],
  raw: () => rows,
});

function createMockDb(initialColumns: string[] = []) {
  const executed: string[] = [];
  const columns = new Set(initialColumns);
  const tables = new Set<string>();

  const executeSql = jest.fn(async (sql: string, _params: any[] = []) => {
    executed.push(sql);
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (/^PRAGMA table_info\((\w+)\)/i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(Array.from(columns).map((name, cid) => ({ cid, name }))) }];
    }

    if (/^CREATE TABLE IF NOT EXISTS/i.test(normalized)) {
      const match = normalized.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
      if (match) tables.add(match[1]);
      return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
    }

    if (/^CREATE INDEX IF NOT EXISTS/i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
    }

    const alter = normalized.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/i);
    if (alter) {
      columns.add(alter[2]);
      return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
    }

    return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
  });

  return { executeSql, executed, columns, tables };
}

describe('migrateV11toV12', () => {
  it('creates local_llm_models and adds llm_config columns', async () => {
    const { executeSql, executed, columns, tables } = createMockDb(['id', 'name', 'base_url', 'api_key', 'model_name', 'is_active']);
    const db = {
      executeSql,
      transaction: jest.fn((scope: (tx: { executeSql: typeof executeSql }) => void, onError: (error: unknown) => void, onSuccess: () => void) => {
        try {
          scope({ executeSql });
          onSuccess();
        } catch (error) {
          onError(error);
        }
      }),
    };

    await migrateV11toV12(db as any);

    expect(tables.has('local_llm_models')).toBe(true);
    expect(executed.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS local_llm_models'))).toBe(true);
    expect(executed.some(sql => sql.includes('idx_local_llm_models_status'))).toBe(true);
    expect(executed.some(sql => sql.includes('idx_local_llm_models_last_used'))).toBe(true);
    expect(columns.has('provider_type')).toBe(true);
    expect(columns.has('local_model_id')).toBe(true);
    expect(columns.has('local_backend')).toBe(true);
    expect(columns.has('context_window')).toBe(true);
    expect(columns.has('max_output_tokens')).toBe(true);
  });

  it('does not re-add columns that already exist', async () => {
    const { executeSql, executed } = createMockDb([
      'id', 'name', 'base_url', 'api_key', 'model_name', 'is_active',
      'provider_type', 'local_model_id', 'local_backend', 'context_window', 'max_output_tokens',
    ]);
    const db = {
      executeSql,
      transaction: jest.fn((scope: (tx: { executeSql: typeof executeSql }) => void, onError: (error: unknown) => void, onSuccess: () => void) => {
        try {
          scope({ executeSql });
          onSuccess();
        } catch (error) {
          onError(error);
        }
      }),
    };

    await migrateV11toV12(db as any);

    expect(executed.some(sql => /^ALTER TABLE llm_config ADD COLUMN/i.test(sql.replace(/\s+/g, ' ').trim()))).toBe(false);
  });

  it('defaults historical llm_config to openai_compatible provider_type', async () => {
    const { executeSql, executed } = createMockDb(['id', 'name', 'base_url', 'api_key', 'model_name', 'is_active']);
    const db = {
      executeSql,
      transaction: jest.fn((scope: (tx: { executeSql: typeof executeSql }) => void, onError: (error: unknown) => void, onSuccess: () => void) => {
        try {
          scope({ executeSql });
          onSuccess();
        } catch (error) {
          onError(error);
        }
      }),
    };

    await migrateV11toV12(db as any);

    expect(executed.some(sql => sql.includes("provider_type TEXT NOT NULL DEFAULT 'openai_compatible'"))).toBe(true);
  });
});

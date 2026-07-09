/* eslint-env jest */

import { migrateV12ToV13 } from '../src/services/migrations/v12-to-v13';

type TableRows = Record<string, any>[];

const createRows = (rows: TableRows) => ({
  length: rows.length,
  item: (index: number) => rows[index],
  raw: () => rows,
});

interface MockTable {
  name: string;
  columns: Map<string, { type: string; default: any }>;
  rows: Map<number, Record<string, any>>;
  nextId: number;
}

function createMockDb() {
  const tables = new Map<string, MockTable>();

  function ensureTable(name: string): MockTable {
    if (!tables.has(name)) {
      tables.set(name, { name, columns: new Map(), rows: new Map(), nextId: 1 });
    }
    return tables.get(name)!;
  }

  const executeSql = jest.fn(async (sql: string, params: any[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    // ALTER TABLE ... ADD COLUMN
    const alterMatch = normalized.match(
      /^ALTER TABLE (\w+) ADD COLUMN (\w+)(?: (\w+))?(?: DEFAULT (.+))?$/i,
    );
    if (alterMatch) {
      const [, tableName, colName, colType, defaultVal] = alterMatch;
      const table = ensureTable(tableName);
      let parsedDefault: any = null;
      if (defaultVal !== undefined) {
        if (defaultVal.startsWith("'") && defaultVal.endsWith("'")) {
          parsedDefault = defaultVal.slice(1, -1);
        } else if (defaultVal === 'NULL') {
          parsedDefault = null;
        } else {
          parsedDefault = Number(defaultVal);
        }
      }
      table.columns.set(colName, { type: colType || 'TEXT', default: parsedDefault });
      // Apply default to existing rows
      for (const [, row] of table.rows) {
        if (!(colName in row)) {
          row[colName] = parsedDefault;
        }
      }
      return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
    }

    // PRAGMA table_info
    const pragmaMatch = normalized.match(/^PRAGMA table_info\((\w+)\)/i);
    if (pragmaMatch) {
      const tableName = pragmaMatch[1];
      const table = tables.get(tableName);
      if (!table) {
        return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
      }
      const colRows: TableRows = [];
      let cid = 0;
      // Include columns from both the column definitions and any columns found in rows
      const allCols = new Set([...table.columns.keys()]);
      for (const [, row] of table.rows) {
        for (const key of Object.keys(row)) {
          allCols.add(key);
        }
      }
      for (const colName of allCols) {
        colRows.push({ cid, name: colName, type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 });
        cid += 1;
      }
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(colRows) }];
    }

    // UPDATE ... SET ... WHERE ...
    const updateMatch = normalized.match(
      /^UPDATE (\w+) SET (.+?) WHERE (.+)$/i,
    );
    if (updateMatch) {
      const [, tableName, setClause, whereClause] = updateMatch;
      const table = tables.get(tableName);
      if (!table) {
        return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
      }

      // Parse SET clause
      const setPairs: [string, any][] = [];
      const setParts = setClause.split(',').map((s: string) => s.trim());
      for (const part of setParts) {
        const [col, val] = part.split('=').map((s: string) => s.trim());
        let parsedVal: any = val;
        if (val.startsWith("'") && val.endsWith("'")) {
          parsedVal = val.slice(1, -1);
        } else if (val === 'NULL') {
          parsedVal = null;
        }
        setPairs.push([col, parsedVal]);
      }

      let rowsAffected = 0;
      for (const [, row] of table.rows) {
        let matches = false;
        // Simple WHERE evaluation
        if (whereClause.includes("!='unavailable'") || whereClause.includes("!= 'unavailable'")) {
          const col = whereClause.split(' ')[0].trim();
          matches = row[col] !== 'unavailable';
        } else if (whereClause.includes("= 'local_litertlm'")) {
          const col = whereClause.split(' ')[0].trim();
          matches = row[col] === 'local_litertlm';
        } else if (whereClause.includes("= 'llama_cpp'")) {
          const col = whereClause.split(' ')[0].trim();
          matches = row[col] === 'llama_cpp';
        }

        if (matches) {
          for (const [col, val] of setPairs) {
            row[col] = val;
          }
          rowsAffected += 1;
        }
      }
      return [{ insertId: 0, rowsAffected, rows: createRows([]) }];
    }

    return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
  });

  // Helper to insert a row into a table
  function insertRow(tableName: string, row: Record<string, any>) {
    const table = ensureTable(tableName);
    const id = table.nextId++;
    // Add all columns from this row
    for (const [key, val] of Object.entries(row)) {
      if (!table.columns.has(key)) {
        table.columns.set(key, { type: 'TEXT', default: null });
      }
    }
    table.rows.set(id, { ...row });
    return id;
  }

  // Helper to get all rows from a table
  function getAllRows(tableName: string): Record<string, any>[] {
    const table = tables.get(tableName);
    if (!table) return [];
    return Array.from(table.rows.values());
  }

  // Helper to get a specific row
  function getRow(tableName: string, id: number): Record<string, any> | undefined {
    const table = tables.get(tableName);
    if (!table) return undefined;
    return table.rows.get(id);
  }

  // Helper to get table columns
  function getColumns(tableName: string): Set<string> {
    const table = tables.get(tableName);
    if (!table) return new Set();
    const cols = new Set([...table.columns.keys()]);
    for (const [, row] of table.rows) {
      for (const key of Object.keys(row)) {
        cols.add(key);
      }
    }
    return cols;
  }

  const db = {
    executeSql,
    transaction: jest.fn(async (scope: (tx: { executeSql: typeof executeSql }) => void) => {
      await scope({ executeSql });
    }),
  };

  return { db, executeSql, insertRow, getAllRows, getRow, getColumns, tables };
}

describe('migrateV12ToV13', () => {
  it('adds prompt_template column with default chatml', async () => {
    const { db, getColumns } = createMockDb();
    // Ensure the table exists
    const table = db.executeSql; // trigger table creation via PRAGMA
    // Insert a row before migration
    const { insertRow } = createMockDb();
    // We use the same mock db instance
    const mock = createMockDb();
    mock.insertRow('local_llm_models', {
      id: 'model-1',
      display_name: 'Test Model',
      original_filename: 'test.litertlm',
      relative_path: 'models/test.litertlm',
      file_size: 1024,
      sha256: 'abc123',
      status: 'ready',
      backend_preference: 'auto',
      validated_backend: 'cpu',
      context_length: 2048,
      max_output_tokens: 512,
      load_time_ms: null,
      first_token_ms: null,
      tokens_per_second: null,
      imported_at: '2025-01-01T00:00:00.000Z',
      last_used_at: null,
      last_validated_at: null,
      error_code: null,
      error_message: null,
    });

    await migrateV12ToV13(mock.db as any);

    const columns = mock.getColumns('local_llm_models');
    expect(columns.has('prompt_template')).toBe(true);
    expect(columns.has('actual_backend')).toBe(true);

    // Verify default value applied to existing row
    const rows = mock.getAllRows('local_llm_models');
    expect(rows[0].prompt_template).toBe('chatml');
    expect(rows[0].actual_backend).toBeNull();
  });

  it('marks existing litertlm models as unavailable', async () => {
    const mock = createMockDb();
    mock.insertRow('local_llm_models', {
      id: 'model-1',
      display_name: 'Ready Model',
      status: 'ready',
      error_message: null,
    });
    mock.insertRow('local_llm_models', {
      id: 'model-2',
      display_name: 'Error Model',
      status: 'error',
      error_message: 'some error',
    });
    mock.insertRow('local_llm_models', {
      id: 'model-3',
      display_name: 'Already Unavailable',
      status: 'unavailable',
      error_message: 'old message',
    });

    await migrateV12ToV13(mock.db as any);

    const rows = mock.getAllRows('local_llm_models');
    // ready model should be marked unavailable
    expect(rows.find((r) => r.id === 'model-1')?.status).toBe('unavailable');
    expect(rows.find((r) => r.id === 'model-1')?.error_message).toBe(
      'LiteRT-LM 引擎已移除，请重新导入 GGUF 模型',
    );
    // error model should also be marked unavailable
    expect(rows.find((r) => r.id === 'model-2')?.status).toBe('unavailable');
    // already unavailable model should stay unavailable (no change)
    expect(rows.find((r) => r.id === 'model-3')?.status).toBe('unavailable');
    expect(rows.find((r) => r.id === 'model-3')?.error_message).toBe('old message');
  });

  it('updates llm_config provider_type from local_litertlm to llama_cpp', async () => {
    const mock = createMockDb();
    mock.insertRow('llm_config', {
      id: 1,
      name: 'Local Config',
      provider_type: 'local_litertlm',
      local_backend: 'auto',
    });
    mock.insertRow('llm_config', {
      id: 2,
      name: 'Cloud Config',
      provider_type: 'openai_compatible',
      local_backend: null,
    });

    await migrateV12ToV13(mock.db as any);

    const rows = mock.getAllRows('llm_config');
    expect(rows.find((r) => r.id === 1)?.provider_type).toBe('llama_cpp');
    expect(rows.find((r) => r.id === 2)?.provider_type).toBe('openai_compatible');
  });

  it('sets local_backend to cpu for llama_cpp configs', async () => {
    const mock = createMockDb();
    mock.insertRow('llm_config', {
      id: 1,
      name: 'Local Config',
      provider_type: 'local_litertlm',
      local_backend: 'auto',
    });
    mock.insertRow('llm_config', {
      id: 2,
      name: 'Cloud Config',
      provider_type: 'openai_compatible',
      local_backend: null,
    });

    await migrateV12ToV13(mock.db as any);

    const rows = mock.getAllRows('llm_config');
    // local_litertlm -> llama_cpp, then local_backend set to cpu
    expect(rows.find((r) => r.id === 1)?.local_backend).toBe('cpu');
    // openai_compatible config should not be affected
    expect(rows.find((r) => r.id === 2)?.local_backend).toBeNull();
  });

  it('does not add columns if they already exist', async () => {
    const mock = createMockDb();
    // Pre-add the columns
    const table = mock.tables.get('local_llm_models') || {
      name: 'local_llm_models',
      columns: new Map([
        ['prompt_template', { type: 'TEXT', default: 'chatml' }],
        ['actual_backend', { type: 'TEXT', default: null }],
      ]),
      rows: new Map(),
      nextId: 1,
    };
    mock.tables.set('local_llm_models', table);

    await migrateV12ToV13(mock.db as any);

    // Should not have called ALTER TABLE for columns that already exist
    const alterCalls = mock.executeSql.mock.calls.filter(
      (call: any[]) => call[0].includes('ALTER TABLE'),
    );
    expect(alterCalls.length).toBe(0);
  });
});

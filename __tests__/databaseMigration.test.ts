/* eslint-env jest */

type TableRows = Record<string, any>[];

const createRows = (rows: TableRows) => ({
  length: rows.length,
  item: (index: number) => rows[index],
  raw: () => rows,
});

function createLegacySQLiteMock() {
  const schemas = new Map<string, Set<string>>([
    ['projects', new Set(['id', 'name'])],
    ['llm_config', new Set(['id'])],
    ['settings', new Set(['key', 'value'])],
    ['local_llm_models', new Set([
      'id', 'display_name', 'original_filename', 'relative_path', 'file_size', 'sha256',
      'status', 'backend_preference', 'validated_backend', 'context_length', 'max_output_tokens',
      'load_time_ms', 'first_token_ms', 'tokens_per_second', 'imported_at', 'last_used_at',
      'last_validated_at', 'error_code', 'error_message',
    ])],
  ]);
  const rows = new Map<string, TableRows>([
    ['projects', []],
    ['llm_config', [{ id: 1 }]],
    ['settings', []],
  ]);
  const inserts = new Map<string, number>();
  const executed: string[] = [];

  const ensureTable = (table: string) => {
    if (!schemas.has(table)) schemas.set(table, new Set(['id']));
    if (!rows.has(table)) rows.set(table, []);
  };

  const parseCreateTable = (sql: string) => {
    const match = sql.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]+)\)/i);
    if (!match) return;
    const table = match[1];
    if (schemas.has(table)) return;
    const columns = match[2]
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter((name) => name && !['PRIMARY', 'FOREIGN', 'UNIQUE'].includes(name.toUpperCase()));
    schemas.set(table, new Set(columns));
    rows.set(table, []);
  };

  const insertRow = (table: string, columns: string[], params: any[]) => {
    ensureTable(table);
    const schema = schemas.get(table)!;
    for (const column of columns) {
      if (!schema.has(column)) {
        throw new Error(`no such column: ${table}.${column}`);
      }
    }
    const tableRows = rows.get(table)!;
    const nextId = (inserts.get(table) || tableRows.length) + 1;
    inserts.set(table, nextId);
    const row: Record<string, any> = {};
    columns.forEach((column, index) => {
      row[column] = params[index];
    });
    if (schema.has('id') && row.id == null) row.id = nextId;
    tableRows.push(row);
    return nextId;
  };

  const executeSql = jest.fn(async (sql: string, params: any[] = []) => {
    executed.push(sql);
    const normalized = sql.replace(/\s+/g, ' ').trim();

    const pragma = normalized.match(/^PRAGMA table_info\((\w+)\)/i);
    if (pragma) {
      const schema = schemas.get(pragma[1]) || new Set<string>();
      const info = Array.from(schema).map((name, cid) => ({ cid, name }));
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(info) }];
    }

    const alter = normalized.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/i);
    if (alter) {
      ensureTable(alter[1]);
      schemas.get(alter[1])!.add(alter[2]);
      return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
    }

    if (/^CREATE TABLE IF NOT EXISTS/i.test(normalized)) {
      parseCreateTable(sql);
      return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
    }

    if (/^INSERT OR IGNORE INTO llm_config/i.test(normalized)) {
      const tableRows = rows.get('llm_config') || [];
      if (!tableRows.some((row) => row.id === 1)) {
        tableRows.push({
          id: 1,
          name: params[0],
          provider_type: params[1],
          base_url: params[2],
          api_key: params[3],
          model_name: params[4],
          is_active: params[5],
          local_model_id: params[6],
          local_backend: params[7],
          context_window: params[8],
          max_output_tokens: params[9],
        });
        rows.set('llm_config', tableRows);
      }
      return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
    }

    if (/^INSERT INTO llm_config \(/i.test(normalized)) {
      const schema = schemas.get('llm_config')!;
      const llmColumns = normalized.match(/\(([^)]+)\)/)?.[1].split(',').map((c) => c.trim()) || [];
      for (const column of llmColumns) {
        if (!schema.has(column)) throw new Error(`no such column: llm_config.${column}`);
      }
      const id = insertRow('llm_config', llmColumns, params);
      return [{ insertId: id, rowsAffected: 1, rows: createRows([]) }];
    }

    if (/^INSERT OR REPLACE INTO llm_config/i.test(normalized)) {
      const schema = schemas.get('llm_config')!;
      for (const column of ['base_url', 'api_key', 'model_name']) {
        if (!schema.has(column)) throw new Error(`no such column: llm_config.${column}`);
      }
      rows.set('llm_config', [{ id: 1, name: '默认配置', provider_type: 'openai_compatible', base_url: params[0], api_key: params[1], model_name: params[2], is_active: 1, local_model_id: null, local_backend: null, context_window: 4096, max_output_tokens: 4000 }]);
      return [{ insertId: 1, rowsAffected: 1, rows: createRows([]) }];
    }

    if (/^UPDATE llm_config SET name = '默认配置'/i.test(normalized)) {
      rows.set('llm_config', (rows.get('llm_config') || []).map((row) => (
        row.id === 1 && !row.name ? { ...row, name: '默认配置' } : row
      )));
      return [{ insertId: 0, rowsAffected: 1, rows: createRows([]) }];
    }

    if (/^UPDATE llm_config SET api_key = \? WHERE id = \?/i.test(normalized)) {
      rows.set('llm_config', (rows.get('llm_config') || []).map((row) => (
        row.id === params[1] ? { ...row, api_key: params[0] } : row
      )));
      return [{ insertId: 0, rowsAffected: 1, rows: createRows([]) }];
    }

    if (/^UPDATE llm_config SET is_active = 0/i.test(normalized)) {
      rows.set('llm_config', (rows.get('llm_config') || []).map((row) => ({ ...row, is_active: 0 })));
      return [{ insertId: 0, rowsAffected: 1, rows: createRows([]) }];
    }

    if (/^UPDATE llm_config SET is_active = 1 WHERE id = \?/i.test(normalized)) {
      rows.set('llm_config', (rows.get('llm_config') || []).map((row) => (
        row.id === params[0] ? { ...row, is_active: 1 } : row
      )));
      return [{ insertId: 0, rowsAffected: 1, rows: createRows([]) }];
    }

    if (/^UPDATE llm_config SET is_active = 1 WHERE id = \(SELECT id FROM llm_config/i.test(normalized)) {
      const tableRows = rows.get('llm_config') || [];
      if (tableRows[0]) tableRows[0].is_active = 1;
      return [{ insertId: 0, rowsAffected: 1, rows: createRows([]) }];
    }

    if (/^UPDATE llm_config SET name = \?/i.test(normalized)) {
      rows.set('llm_config', (rows.get('llm_config') || []).map((row) => (
        row.id === params[params.length - 1]
          ? {
              ...row,
              name: params[0],
              provider_type: params[1],
              base_url: params[2],
              api_key: params[3],
              model_name: params[4],
              local_model_id: params[5],
              local_backend: params[6],
              context_window: params[7],
              max_output_tokens: params[8],
            }
          : row
      )));
      return [{ insertId: 0, rowsAffected: 1, rows: createRows([]) }];
    }

    if (/^DELETE FROM llm_config WHERE id = \?/i.test(normalized)) {
      rows.set('llm_config', (rows.get('llm_config') || []).filter((row) => row.id !== params[0]));
      return [{ insertId: 0, rowsAffected: 1, rows: createRows([]) }];
    }

    if (/^INSERT OR REPLACE INTO settings/i.test(normalized)) {
      rows.set('settings', [{ key: params[0], value: params[1] }]);
      return [{ insertId: 0, rowsAffected: 1, rows: createRows([]) }];
    }

    if (/^UPDATE settings/i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
    }

    const insert = normalized.match(/^INSERT INTO (\w+) \(([^)]+)\)/i);
    if (insert) {
      const table = insert[1];
      const columns = insert[2].split(',').map((column) => column.trim());
      const id = insertRow(table, columns, params);
      return [{ insertId: id, rowsAffected: 1, rows: createRows([]) }];
    }

    if (/^SELECT \* FROM projects WHERE id = \?/i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(rows.get('projects')!.filter((row) => row.id === params[0])) }];
    }

    if (/^SELECT \* FROM projects/i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(rows.get('projects')!) }];
    }

    if (/^SELECT \* FROM presets/i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(rows.get('presets') || []) }];
    }

    if (/^SELECT id FROM llm_config WHERE is_active = 1/i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 0, rows: createRows((rows.get('llm_config') || []).filter((row) => row.is_active === 1).slice(0, 1)) }];
    }

    if (/^SELECT \* FROM llm_config WHERE is_active = 1/i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 0, rows: createRows((rows.get('llm_config') || []).filter((row) => row.is_active === 1).slice(0, 1)) }];
    }

    if (/^SELECT \* FROM llm_config WHERE id = \?/i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 0, rows: createRows((rows.get('llm_config') || []).filter((row) => row.id === params[0])) }];
    }

    if (/^SELECT \* FROM llm_config/i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(rows.get('llm_config') || []) }];
    }

    if (/^SELECT value FROM settings/i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 0, rows: createRows(rows.get('settings')!.filter((row) => row.key === params[0])) }];
    }

    if (/^UPDATE projects/i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 1, rows: createRows([]) }];
    }

    return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
  });

  return {
    SQLite: {
      enablePromise: jest.fn(),
      openDatabase: jest.fn(async () => ({
        executeSql,
        // V2.2.2 适配：兼容两种 transaction 调用风格：
        //   1) 老式 `transaction(scope)` —— 1 个 callback
        //   2) 新式 `transaction(cb, err, success)` —— 3 个参数（react-native-sqlite-storage promise 风格）
        // 新代码用 `runInTransactionSafe` 走风格 2，3 参数的 success() 必须被同步调起。
        transaction: jest.fn((arg1: any, _arg2?: any, arg3?: any) => {
          if (typeof arg3 === 'function') {
            // 3-arg style: 同步调用 cb，调 success
            arg1({ executeSql });
            if (typeof arg3 === 'function') arg3();
            return;
          }
          // 1-arg style: 兼容老代码
          const scope = arg1;
          Promise.resolve(scope({ executeSql })).catch(() => {});
        }),
      })),
    },
    executed,
  };
}

describe('database migration for legacy installs', () => {
  test('creates character collection schema for fresh installs', async () => {
    jest.resetModules();
    const mock = createLegacySQLiteMock();
    jest.doMock('react-native-sqlite-storage', () => mock.SQLite);

    const database = require('../src/services/database');

    await database.createProject('角色合集项目', 'outline');

    const executed = mock.executed.join('\n');
    expect(executed).toContain('CREATE TABLE IF NOT EXISTS character_collections');
    expect(executed).toContain('collection_id INTEGER NOT NULL DEFAULT 0');
  });

  test('upgrades old tables before creating projects and saving LLM config', async () => {
    jest.resetModules();
    const mock = createLegacySQLiteMock();
    jest.doMock('react-native-sqlite-storage', () => mock.SQLite);

    const database = require('../src/services/database');

    const projectId = await database.createProject('真实项目', 'outline');
    await database.setLLMConfig('https://api.example.com/v1', 'sk-real', 'gpt-real');
    const projects = await database.getAllProjects();
    const llmConfig = await database.getLLMConfig();

    expect(projectId).toBe(1);
    expect(projects[0]).toMatchObject({ name: '真实项目', mode: 'outline' });
    expect(llmConfig).toMatchObject({
      name: '默认配置',
      base_url: 'https://api.example.com/v1',
      api_key: 'sk-real',
      model_name: 'gpt-real',
      is_active: 1,
    });
    expect(mock.executed.join('\n')).toContain('ALTER TABLE llm_config ADD COLUMN name');
    expect(mock.executed.join('\n')).toContain('ALTER TABLE llm_config ADD COLUMN base_url');
    expect(mock.executed.join('\n')).toContain('ALTER TABLE llm_config ADD COLUMN api_key');
    expect(mock.executed.join('\n')).toContain('ALTER TABLE llm_config ADD COLUMN is_active');
    expect(mock.executed.join('\n')).toContain('ALTER TABLE llm_config ADD COLUMN provider_type');
    expect(mock.executed.join('\n')).toContain('ALTER TABLE llm_config ADD COLUMN local_model_id');
    expect(mock.executed.join('\n')).toContain('ALTER TABLE llm_config ADD COLUMN context_window');
    expect(mock.executed.join('\n')).toContain('INSERT OR IGNORE INTO projects (id, name, mode, created_at, updated_at)');
  });

  test('supports multiple LLM configs and reassigns active config when deleting the active one', async () => {
    jest.resetModules();
    const mock = createLegacySQLiteMock();
    jest.doMock('react-native-sqlite-storage', () => mock.SQLite);

    const database = require('../src/services/database');

    await database.setLLMConfig('https://api.one/v1', 'sk-one', 'model-one');
    const secondId = await database.saveLLMConfig({
      name: '备用配置',
      base_url: 'https://api.two/v1',
      api_key: 'sk-two',
      model_name: 'model-two',
      is_active: 1,
    });
    await database.deleteLLMConfig(secondId);

    await expect(database.getLLMConfig()).resolves.toMatchObject({
      name: '默认配置',
      base_url: 'https://api.one/v1',
      api_key: 'sk-one',
      model_name: 'model-one',
      is_active: 1,
    });
  });

  test('uses two-stage as the default pipeline mode for legacy settings', async () => {
    jest.resetModules();
    const mock = createLegacySQLiteMock();
    jest.doMock('react-native-sqlite-storage', () => mock.SQLite);

    const database = require('../src/services/database');

    await expect(database.getPipelineConfig()).resolves.toMatchObject({
      pipelineMode: 'twoStage',
    });
  });
});

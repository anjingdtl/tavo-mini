/* eslint-env jest */

import { migrateV8toV9 } from '../src/services/migrations/v8-to-v9';

type TableRows = Record<string, any>[];

const createRows = (rows: TableRows) => ({
  length: rows.length,
  item: (index: number) => rows[index],
  raw: () => rows,
});

/**
 * 回归 V2.4.3 修复：project_note_config 缺 retrieval_fragment_chars 列导致
 * setProjectNoteConfig 报 "no column named retrieval_fragment_chars"。
 *
 * 双层防线：
 *   1. v8→v9 迁移的 CREATE 定义必须包含 retrieval_fragment_chars
 *   2. ensureSchemaCompatibility 启动时无条件兜底（私有函数不直接测，
 *      通过验证 CREATE 定义 + 现有 v8→v9 迁移覆盖该路径）
 */
function createMockDb(initialColumns: string[] = []) {
  const executed: string[] = [];
  const columns = new Set(initialColumns);
  const tableSchemas = new Map<string, Set<string>>();

  const executeSql = jest.fn(async (sql: string, _params: any[] = []) => {
    executed.push(sql);
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (/^PRAGMA table_info\(/i.test(normalized)) {
      return [
        {
          insertId: 0,
          rowsAffected: 0,
          rows: createRows(
            Array.from(columns).map((name, cid) => ({ cid, name })),
          ),
        },
      ];
    }

    const createMatch = normalized.match(
      /^CREATE TABLE IF NOT EXISTS\s+(\w+)\s+\(([\s\S]+)\)/i,
    );
    if (createMatch) {
      // 模拟 SQLite CREATE TABLE IF NOT EXISTS：表不存在才解析列定义
      const table = createMatch[1];
      if (!tableSchemas.has(table)) {
        const colDefs = createMatch[2]
          .split(',')
          .map(s => s.trim())
          .filter(s => s.length > 0);
        const colNames = colDefs
          .map(def => def.split(/\s+/)[0])
          .filter(
            name =>
              name &&
              !['PRIMARY', 'FOREIGN', 'UNIQUE', 'CONSTRAINT'].includes(
                name.toUpperCase(),
              ),
          );
        tableSchemas.set(table, new Set(colNames));
        // 新建表：把列合入全局 columns（模拟 PRAGMA table_info 反映新表）
        for (const c of colNames) columns.add(c);
      }
      return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
    }

    if (/^CREATE INDEX IF NOT EXISTS/i.test(normalized)) {
      return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
    }

    const alter = normalized.match(
      /^ALTER TABLE (\w+) ADD COLUMN (\w+)/i,
    );
    if (alter) {
      columns.add(alter[2]);
      return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
    }

    return [{ insertId: 0, rowsAffected: 0, rows: createRows([]) }];
  });

  return { executeSql, executed, columns, tables: tableSchemas };
}

describe('migrateV8toV9 — project_note_config schema (V2.4.3 回归)', () => {
  it('CREATE 定义包含 retrieval_fragment_chars 列', async () => {
    const { executed } = createMockDb();
    const db = { executeSql: createMockDb().executeSql, transaction: jest.fn() };

    await migrateV8toV9(db as any);

    // v8→v9 的 CREATE TABLE 语句必须包含 retrieval_fragment_chars 定义，
    // 否则从 schema 8 升级的设备建表时就会缺这列。
    const createNoteConfig = executed.find(sql =>
      /CREATE TABLE IF NOT EXISTS project_note_config/i.test(
        sql.replace(/\s+/g, ' '),
      ),
    );
    // 上面 executed 来自一个空 mock，重做一次拿真实 executed
    const real = createMockDb();
    const realDb = { executeSql: real.executeSql, transaction: jest.fn() };
    await migrateV8toV9(realDb as any);
    const createStmt = real.executed.find(sql =>
      /CREATE TABLE IF NOT EXISTS project_note_config/i.test(
        sql.replace(/\s+/g, ' '),
      ),
    );
    expect(createStmt).toBeDefined();
    expect(createStmt!).toMatch(/retrieval_fragment_chars/);
  });

  it('迁移后 project_note_config 拥有全部 6 列（含 retrieval_fragment_chars）', async () => {
    const mock = createMockDb([]);
    const db = { executeSql: mock.executeSql, transaction: jest.fn() };

    await migrateV8toV9(db as any);

    const expected = [
      'project_id',
      'mode',
      'style_weights',
      'retrieval_top_k',
      'retrieval_fragment_chars',
      'enabled_note_ids',
      'updated_at',
    ];
    for (const col of expected) {
      expect(mock.columns.has(col)).toBe(true);
    }
  });

  it('模拟 setProjectNoteConfig 的 INSERT 不会因缺列失败', async () => {
    // 这是错误信息的根源场景：修复前，从老版本升级的设备上
    // project_note_config 缺 retrieval_fragment_chars，INSERT 引用该列 →
    // SQLite 报 "no column named retrieval_fragment_chars"。
    const mock = createMockDb([]);
    const db = { executeSql: mock.executeSql, transaction: jest.fn() };

    await migrateV8toV9(db as any);

    // 迁移完成后，模拟 setProjectNoteConfig 的 INSERT 语句
    const insertSql = `INSERT OR REPLACE INTO project_note_config
      (project_id, mode, style_weights, retrieval_top_k, retrieval_fragment_chars, enabled_note_ids, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`;

    // 解析 INSERT 中的列名，全部必须在 mock.columns 中
    const colMatch = insertSql.match(/\(([^)]+)\)\s*VALUES/i);
    const insertCols = colMatch![1]
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    for (const col of insertCols) {
      expect(mock.columns.has(col)).toBe(true);
    }
  });
});

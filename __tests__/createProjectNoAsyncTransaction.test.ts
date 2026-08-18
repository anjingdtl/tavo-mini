/* eslint-env jest */

import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';

// Regression: V2.2.0 之前 createProject 用了异步 SQLite transaction callback，
// react-native-sqlite-storage 的 transaction 期望 callback **同步**执行 SQL，
// 任何 await 都会让 transaction 被 finalize，第二次 executeSql 触发 InvalidStateError
// (DOM Exception 11)。
//
// V2.2.2 修法：所有原 async transaction 调用方改为：
//   1) 在事务外 async 读出需要的数据
//   2) 把所有 SQL 合并到 `runInTransactionSafe` helper 里
//   3) helper 用 sync 风格的 `database.transaction((tx) => { ... })` 一次性 push
//   4) callback 必须同步执行所有 executeSql（不 await）
//
// 本测试用 spy 监听 `database.transaction` 调用：
//   - 任何 callback 内部 await 抛出错误（regression 不能复发）
//   - `createProject` 仍然能完成（pipeline 走到最后）

describe('createProject SQLite transaction safety (V2.2.2)', () => {
  let fakeDb: any;
  let seenInserts: string[];
  let txCallbacks: Array<{ sql: string; params: any[] }[]>;

  const recordSql = (sql: string, _params: any[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();
    if (normalized.startsWith('INSERT INTO ')) {
      const m = normalized.match(/INSERT INTO\s+(\w+)/);
      if (m) seenInserts.push(m[1]);
    }
  };

  beforeEach(() => {
    seenInserts = [];
    txCallbacks = [];
    let schemaReady = false;
    const settings = new Map<string, string>();
    // 模拟 react-native-sqlite-storage promise 风格 transaction
    // 关键点：mock 内部**同步**调用 cb，绝不等待任何 microtask
    fakeDb = {
      transaction: jest.fn((cb: any, _err: any, success: any) => {
        const recorded: Array<{ sql: string; params: any[] }> = [];
        const txProxy = {
          executeSql: (sql: string, params: any[] = []) => {
            recorded.push({ sql, params });
            recordSql(sql, params);
          },
        };
        // 同步调用 cb（V2.2.2 helper 的核心约束：cb 不能 await）
        cb(txProxy);
        txCallbacks.push(recorded);
        if (typeof success === 'function') success();
      }),
      executeSql: jest.fn(async (sql: string, params: any[] = []) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        recordSql(sql, params);
        if (/^CREATE TABLE IF NOT EXISTS projects/i.test(normalized)) {
          schemaReady = true;
        }
        if (/^PRAGMA foreign_keys$/i.test(normalized)) {
          const rows = [{ foreign_keys: 1 }];
          return [
            {
              rows: {
                length: rows.length,
                item: (index: number) => rows[index],
                raw: () => rows,
              },
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
          const rows =
            schemaReady &&
            SCHEMA_MANIFEST.some(table => table.name === params[0])
              ? [{ name: params[0] }]
              : [];
          return [
            {
              rows: {
                length: rows.length,
                item: (index: number) => rows[index],
                raw: () => rows,
              },
              rowsAffected: 0,
              insertId: 0,
            },
          ];
        }
        if (
          /^SELECT name FROM sqlite_master WHERE type = 'table'/i.test(
            normalized,
          )
        ) {
          const rows = schemaReady
            ? SCHEMA_MANIFEST.map(table => ({ name: table.name }))
            : [];
          return [
            {
              rows: {
                length: rows.length,
                item: (index: number) => rows[index],
                raw: () => rows,
              },
              rowsAffected: 0,
              insertId: 0,
            },
          ];
        }
        const tableInfo = normalized.match(/^PRAGMA table_info\((\w+)\)/i);
        if (tableInfo) {
          const table = SCHEMA_MANIFEST.find(
            item => item.name === tableInfo[1],
          );
          const rows =
            schemaReady && table ? table.columns.map(name => ({ name })) : [];
          return [
            {
              rows: {
                length: rows.length,
                item: (index: number) => rows[index],
                raw: () => rows,
              },
              rowsAffected: 0,
              insertId: 0,
            },
          ];
        }
        if (
          /^SELECT name FROM sqlite_master WHERE type = 'index'/i.test(
            normalized,
          )
        ) {
          const table = SCHEMA_MANIFEST.find(item => item.name === params[0]);
          const rows =
            schemaReady && table
              ? (table.indexes || []).map(name => ({ name }))
              : [];
          return [
            {
              rows: {
                length: rows.length,
                item: (index: number) => rows[index],
                raw: () => rows,
              },
              rowsAffected: 0,
              insertId: 0,
            },
          ];
        }
        if (/^SELECT value FROM settings/i.test(normalized)) {
          const value = settings.get(params[0]);
          const rows = value === undefined ? [] : [{ value }];
          return [
            {
              rows: {
                length: rows.length,
                item: (index: number) => rows[index],
                raw: () => rows,
              },
              rowsAffected: 0,
              insertId: 0,
            },
          ];
        }
        if (/^INSERT OR REPLACE INTO settings/i.test(normalized)) {
          settings.set(params[0], params[1]);
          return [
            {
              rows: { length: 0, item: () => null, raw: () => [] },
              rowsAffected: 1,
              insertId: 0,
            },
          ];
        }
        if (/^SELECT id, provider_type, base_url, model_name/i.test(normalized)) {
          const rows = [
            {
              id: 1,
              provider_type: 'openai_compatible',
              local_model_id: null,
              base_url: '',
              model_name: '',
            },
          ];
          return [
            {
              rows: {
                length: rows.length,
                item: (index: number) => rows[index],
                raw: () => rows,
              },
              rowsAffected: 0,
              insertId: 0,
            },
          ];
        }
        if (/^SELECT id FROM llm_config WHERE is_active/i.test(normalized)) {
          const rows = [{ id: 1 }];
          return [
            {
              rows: {
                length: rows.length,
                item: (index: number) => rows[index],
                raw: () => rows,
              },
              rowsAffected: 0,
              insertId: 0,
            },
          ];
        }
        if (/^SELECT COUNT/i.test(normalized)) {
          return [
            {
              rows: { length: 0, item: () => ({ c: 0 }), raw: () => [] },
              rowsAffected: 0,
              insertId: 0,
            },
          ];
        }
        return [
          {
            rows: { length: 0, item: () => null, raw: () => [] },
            rowsAffected: 0,
            insertId: 100,
          },
        ];
      }),
    };
    const sqliteStorage = require('react-native-sqlite-storage');
    sqliteStorage.openDatabase.mockResolvedValue(fakeDb);
  });

  test('createProject transaction callback is synchronous (no async leaks)', async () => {
    const db = require('../src/services/database');
    db.__resetForTest();
    await db.openDatabase();

    await db.createProject('TaraRegression', 'outline');

    // V2.2.2 关键约束：所有被调用的 transaction 的 callback 必须是 sync 函数。
    // 我们通过 spy 检测：把原 callback 包成 async 函数，spy 会发现 callback 是 async
    // （AsyncFunction）。V2.2.2 helper 用的是普通 Function 包装 sync 逻辑。
    const txCalls = fakeDb.transaction.mock.calls;
    expect(txCalls.length).toBeGreaterThan(0);
    for (const [cb] of txCalls) {
      // callback 不应该是 AsyncFunction
      expect(cb.constructor.name).not.toBe('AsyncFunction');
    }
  });

  test('createProject pushes project + (optional preset) writes through transactions or direct executeSql', async () => {
    const db = require('../src/services/database');
    db.__resetForTest();
    await db.openDatabase();

    await db.createProject('TaraRegression', 'outline');

    // 关键表都应当被写过；同时防回归：createProject 不再种子首章
    // （种子空章会让一键 N 章从“第 2 章”起跳、导入包 position 0 冲突）。
    expect(seenInserts).toEqual(expect.arrayContaining(['PROJECTS']));
    expect(seenInserts).not.toContain('CHAPTERS');
  });
});

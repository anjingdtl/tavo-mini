/**
 * Real-SQLite in-memory test database backed by sql.js (WASM SQLite).
 *
 * The Canon analysis module touches many tables across migrations and the
 * `createCurrentSchema` fresh-install path, and it exercises both the Promise
 * `executeSql(sql, params)` path and the callback `transaction(scope, errCb,
 * successCb)` overload (see `database/transaction.ts`). This helper builds a
 * schema-complete in-memory database so integration tests can INSERT evidence
 * rows, materialize Canon facts, run the five-dimension gate, and read rows
 * back through real SQLite semantics — not a regex/Map fake.
 *
 * Usage:
 *   const { db, SQL } = await createCanonInMemoryDb();
 *   // db.executeSql / db.transaction behave like react-native-sqlite-storage
 */
import initSqlJsNs from 'sql.js';
import path from 'path';

const initSqlJs: (config?: {
  locateFile?: (file: string) => string;
}) => Promise<SqlJsStatic> =
  ((initSqlJsNs as unknown as {
    default?: (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;
  }).default ??
    (initSqlJsNs as unknown as (config?: {
      locateFile?: (file: string) => string;
    }) => Promise<SqlJsStatic>));

/**
 * The sql.js static namespace shape we use (Database constructor). Kept loose
 * to avoid depending on @types/sql.js internals.
 */
interface SqlJsStatic {
  Database: new () => SqlJsDbInstance;
}
interface SqlJsDbInstance {
  run(sql: string, params?: any[]): void;
  exec(sql: string, params?: any[]): Array<{ columns: string[]; values: any[][] }>;
  getRowsModified(): number;
  close?(): void;
}

export type SqlJsDatabase = SqlJsDbInstance;

/**
 * An in-memory SQLite database shaped to satisfy the `SQLiteDatabase` interface
 * that the Canon analysis code consumes. Implements both the Promise
 * `executeSql(sql, params)` path (used by `execute`) and the callback
 * `transaction(scope, errCb, successCb)` overload (used by `executeTransaction`).
 *
 * The extra `SQLiteDatabase` members (dbname, readTransaction, attach, detach)
 * are stubbed so this type is assignable wherever `SQLite.SQLiteDatabase` is
 * expected; tests only call executeSql / transaction.
 */
export interface InMemorySqliteDb {
  dbname: string;
  executeSql(
    sql: string,
    params?: any[],
  ): Promise<
    [
      {
        rows: {
          length: number;
          item: (index: number) => any;
          raw: () => any[];
        };
        rowsAffected: number;
        insertId: number | undefined;
      },
    ]
  >;
  transaction(
    scope: (tx: any) => void,
    errorCb?: (error: unknown) => void,
    successCb?: () => void,
  ): void;
  readTransaction(): void;
  attach(): void;
  detach(): void;
  /** Underlying sql.js handle, for direct inspection in tests. */
  _sqljs: SqlJsDatabase;
  /** Close + free the WASM database. Call in afterAll. */
  close(): void;
}

/**
 * Run a SQL statement on the sql.js handle and wrap the result into the
 * react-native-sqlite-storage ResultSet shape.
 *
 * sql.js does not separate "write" and "read" — `db.run` executes and returns
 * rowsModified; `db.exec` returns rows. We detect a SELECT (or RETURNING) by
 * checking whether exec yields columns, otherwise treat it as a write.
 */
function runStatement(db: SqlJsDbInstance, sql: string, params: any[] = []) {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!trimmed) {
    return { rows: emptyRows(), rowsAffected: 0, insertId: undefined };
  }
  // Normalize params to scalar forms sql.js accepts (boolean→0/1, undefined→null).
  const normParams = params.map(p => {
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p === undefined) return null;
    return p;
  });
  // For SELECT (and PRAGMA/WITH/EXPLAIN) statements, exec returns the rows.
  const isSelect =
    /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(trimmed) ||
    /\bRETURNING\b/i.test(trimmed);
  if (isSelect) {
    const res = db.exec(trimmed, normParams);
    if (res.length === 0) {
      return { rows: emptyRows(), rowsAffected: 0, insertId: undefined };
    }
    const { columns, values } = res[0];
    const rowsArr = values.map((row: any[]) => {
      const obj: Record<string, any> = {};
      for (let i = 0; i < columns.length; i++) {
        obj[columns[i]] = row[i];
      }
      return obj;
    });
    return {
      rows: makeRows(rowsArr),
      rowsAffected: 0,
      insertId: undefined,
    };
  }
  // Write path: run + capture rowsModified + last insert rowid.
  db.run(trimmed, normParams);
  const rowsAffected = db.getRowsModified();
  let insertId: number | undefined;
  if (rowsAffected > 0 && /^\s*INSERT\b/i.test(trimmed)) {
    const lid = db.exec('SELECT last_insert_rowid() AS id');
    insertId = lid.length > 0 ? (lid[0].values[0][0] as number) : undefined;
  }
  return { rows: emptyRows(), rowsAffected, insertId };
}

function makeRows(rowsArr: any[]) {
  return {
    length: rowsArr.length,
    item: (index: number) => rowsArr[index],
    raw: () => rowsArr,
  };
}

function emptyRows() {
  return makeRows([]);
}

/**
 * Create a real in-memory SQLite database with the Canon schema loaded.
 *
 * The schema is built by replaying the full fresh-install DDL (the same path a
 * brand-new device runs): `createCurrentSchema` statements + all
 * `CREATE INDEX`. We import the schema builder directly so the test database
 * tracks the real production schema, including the latest migration's columns
 * and indexes.
 *
 * For evidence round-trip tests, callers seed `continuation_source_text_chunks`
 * rows directly (the Phase 1 text authority).
 */
export async function createCanonInMemoryDb(): Promise<InMemorySqliteDb> {
  const SQL = await initSqlJs({
    locateFile: (file: string) =>
      path.join(
        __dirname,
        '..',
        '..',
        'node_modules',
        'sql.js',
        'dist',
        file,
      ),
  });
  const db = new SQL.Database() as unknown as SqlJsDbInstance;
  // Enforce FK + case-insensitive LIKE defaults consistent with production.
  db.run('PRAGMA foreign_keys = ON');

  // Build the full fresh-install schema. createCurrentSchema emits an array of
  // SQL strings (some are CREATE TABLE, some CREATE INDEX). Run them all.
  const statements = collectFreshSchemaStatements();
  for (const stmt of statements) {
    // sql.js does not support multi-statement strings in run() reliably for
    // every form; split on ';' boundaries defensively, but only for strings
    // that actually contain multiple statements.
    runOneOrMore(db, stmt);
  }
  return wrapSqlJsDb(db);
}

/**
 * Raw in-memory SQLite WITHOUT any schema — lets callers exercise the real
 * `initializeDatabase` fresh-install path end-to-end.
 */
export async function createEmptyInMemoryDb(): Promise<InMemorySqliteDb> {
  const SQL = await initSqlJs({
    locateFile: (file: string) =>
      path.join(
        __dirname,
        '..',
        '..',
        'node_modules',
        'sql.js',
        'dist',
        file,
      ),
  });
  const db = new SQL.Database() as unknown as SqlJsDbInstance;
  db.run('PRAGMA foreign_keys = ON');
  return wrapSqlJsDb(db);
}

function wrapSqlJsDb(db: SqlJsDbInstance): InMemorySqliteDb {
  const wrapped: InMemorySqliteDb = {
    dbname: ':memory:',
    _sqljs: db as unknown as SqlJsDatabase,
    // Stubs for SQLiteDatabase members the Canon code never calls in tests.
    readTransaction: () => undefined,
    attach: () => undefined,
    detach: () => undefined,
    close() {
      try {
        (db as any).close?.();
      } catch {
        // ignore
      }
    },
    executeSql(sqlStmt, params = []) {
      try {
        const result = runStatement(db, sqlStmt, params);
        return Promise.resolve([result] as any);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    transaction(scope, errorCb, successCb) {
      // sql.js has no native BEGIN/COMMIT transaction object with the RN
      // callback semantics, but the statements in an executeTransaction batch
      // are already meant to run as one unit. We execute them synchronously
      // inside a SAVEPOINT so a throw rolls back the whole batch (matching the
      // atomic contract of executeTransaction).
      const savepoint = `sp_${Math.random().toString(36).slice(2)}`;
      try {
        db.run(`SAVEPOINT ${savepoint}`);
        const tx = {
          executeSql(sqlStmt: string, params: any[] = [], cb?: any) {
            const result = runStatement(db, sqlStmt, params);
            if (typeof cb === 'function') {
              // Propagate callback throws (e.g. onStatementComplete assertions)
              // so the scope aborts and the SAVEPOINT rolls back — matching
              // the native transaction contract. A swallowed throw would
              // silently commit a partial batch.
              cb(null, result);
            }
            return result;
          },
        };
        scope(tx);
        db.run(`RELEASE SAVEPOINT ${savepoint}`);
        successCb?.();
      } catch (error) {
        try {
          db.run(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          db.run(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {
          /* ignore rollback failure */
        }
        errorCb?.(error);
      }
    },
  };
  return wrapped;
}

function runOneOrMore(db: SqlJsDbInstance, raw: string) {
  const parts = splitSqlStatements(raw);
  for (const stmt of parts) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;
    db.run(trimmed);
  }
}

/**
 * Split a SQL string into individual statements on top-level semicolons,
 * ignoring semicolons inside single-quoted string literals. DDL from
 * createCurrentSchema uses backtick template literals but the SQL itself may
 * contain CHECK ('...') defaults; we must not split inside those.
 */
function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inSingleQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      inSingleQuote = !inSingleQuote;
      current += ch;
    } else if (ch === ';' && !inSingleQuote) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current);
  return out;
}

/**
 * Collect every CREATE TABLE / CREATE INDEX statement a fresh install runs,
 * in dependency order. Mirrors `createCurrentSchema.ts`.
 */
function collectFreshSchemaStatements(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createCurrentSchemaStatements } = require('../../src/data/schema/createCurrentSchema');
  return createCurrentSchemaStatements() as string[];
}

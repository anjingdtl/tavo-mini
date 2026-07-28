/* eslint-env jest */

import {
  executeTransaction,
  type SqlStatement,
} from '../src/services/database/transaction';

function createDatabase(options: {
  transactionError?: unknown;
  executeError?: Error;
  duplicateCompletion?: boolean;
} = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const executeSql = jest.fn((sql: string, params: any[] = []) => {
    if (options.executeError) throw options.executeError;
    calls.push({ sql, params });
  });

  const database = {
    transaction: jest.fn((scope: (tx: { executeSql: typeof executeSql }) => void, onError: (error: unknown) => void, onSuccess: () => void) => {
      try {
        scope({ executeSql });
      } catch (error) {
        onError(error);
        return;
      }

      if (options.transactionError) {
        onError(options.transactionError);
        return;
      }

      onSuccess();
      if (options.duplicateCompletion) {
        onSuccess();
        onError(new Error('late transaction error'));
      }
    }),
  };

  return { database, calls, executeSql };
}

describe('executeTransaction', () => {
  afterEach(() => {
    delete process.env.FAIL_MIGRATION_AT_STATEMENT;
  });

  test('resolves an empty batch without opening a transaction', async () => {
    const { database } = createDatabase();

    await expect(executeTransaction(database as any, [])).resolves.toBeUndefined();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  test('schedules statements in order and preserves parameters', async () => {
    const { database, calls } = createDatabase();
    const statements: SqlStatement[] = [
      { sql: 'INSERT INTO demo(value) VALUES (?)', params: ['one'] },
      { sql: 'UPDATE demo SET value = ? WHERE id = ?', params: ['two', 1] },
    ];

    await executeTransaction(database as any, statements);

    expect(calls).toEqual([
      { sql: statements[0].sql, params: ['one'] },
      { sql: statements[1].sql, params: ['two', 1] },
    ]);
  });

  test('rejects with the original error when a statement throws', async () => {
    const error = new Error('statement failed');
    const { database } = createDatabase({ executeError: error });

    await expect(executeTransaction(database as any, [{ sql: 'BROKEN' }])).rejects.toBe(error);
  });

  test('rejects with the original transaction error', async () => {
    const error = { code: 6, message: 'constraint failed' };
    const { database } = createDatabase({ transactionError: error });

    await expect(executeTransaction(database as any, [{ sql: 'INSERT' }])).rejects.toBe(error);
  });

  test('uses a synchronous transaction scope', async () => {
    const { database } = createDatabase();

    await executeTransaction(database as any, [{ sql: 'SELECT 1' }]);

    const scope = database.transaction.mock.calls[0][0];
    expect(scope.constructor.name).not.toBe('AsyncFunction');
  });

  test('passes empty params when a statement omits them', async () => {
    const { database, executeSql } = createDatabase();

    await executeTransaction(database as any, [{ sql: 'VACUUM' }]);

    expect(executeSql).toHaveBeenCalledWith('VACUUM', []);
  });

  test('reports rows-affected from the native asynchronous success callback', async () => {
    const callbacks: Array<(tx: any, result: any) => void> = [];
    const database = {
      transaction(scope: any, _onError: any, onSuccess: any) {
        const tx = {
          executeSql: jest.fn((_sql: string, _params: any[], success: any) => {
            callbacks.push(success);
            return undefined;
          }),
        };
        scope(tx);
        // This mirrors react-native-sqlite-storage: execution callbacks occur
        // after scheduling the statement but before transaction completion.
        callbacks[0](tx, { rowsAffected: 1 });
        onSuccess();
      },
    };
    const counts: number[] = [];

    await executeTransaction(database as any, [{ sql: 'UPDATE demo' }], {
      onStatementComplete: (_index, rowsAffected) => counts.push(rowsAffected),
    });

    expect(counts).toEqual([1]);
  });

  test('settles successfully only once', async () => {
    const { database } = createDatabase({ duplicateCompletion: true });

    await expect(executeTransaction(database as any, [{ sql: 'SELECT 1' }])).resolves.toBeUndefined();
  });

  test('test-only migration injection fails before scheduling statement three', async () => {
    process.env.FAIL_MIGRATION_AT_STATEMENT = '3';
    const { database, calls } = createDatabase();

    await expect(executeTransaction(database as any, [
      { sql: 'MIGRATION 1' },
      { sql: 'MIGRATION 2' },
      { sql: 'MIGRATION 3' },
      { sql: 'MIGRATION 4' },
    ], { faultDomain: 'migration' })).rejects.toThrow(
      'FAULT_INJECTION: migration statement 3',
    );

    expect(calls.map(call => call.sql)).toEqual(['MIGRATION 1', 'MIGRATION 2']);
  });
});

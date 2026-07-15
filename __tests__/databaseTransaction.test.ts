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

  test('settles successfully only once', async () => {
    const { database } = createDatabase({ duplicateCompletion: true });

    await expect(executeTransaction(database as any, [{ sql: 'SELECT 1' }])).resolves.toBeUndefined();
  });
});

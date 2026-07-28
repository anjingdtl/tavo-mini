import type SQLite from 'react-native-sqlite-storage';
import {
  throwIfSqlStatementFault,
  type SqlFaultDomain,
} from '../../testing/faultInjection';

export interface SqlStatement {
  sql: string;
  params?: unknown[];
}

type Completion = () => void;
type Failure = (error: unknown) => void;

/**
 * Execute a prepared batch in one SQLite transaction.
 *
 * react-native-sqlite-storage requires the transaction scope to synchronously
 * schedule every executeSql call. Callers must therefore finish all reads and
 * build the statement list before invoking this function.
 */
export function executeTransaction(
  database: SQLite.SQLiteDatabase,
  statements: readonly SqlStatement[],
  options: {
    faultDomain?: SqlFaultDomain;
    /** Optional per-statement callback for callers that need rows-affected
     * counts (e.g. optimistic-concurrency conflict detection). Native SQLite
     * invokes this from each statement's success callback. */
    onStatementComplete?: (
      oneBasedIndex: number,
      rowsAffected: number,
    ) => void;
  } = {},
): Promise<void> {
  if (statements.length === 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const resolveOnce: Completion = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const rejectOnce: Failure = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const scope = (tx: SQLite.Transaction): void => {
      try {
        for (const [index, statement] of statements.entries()) {
          throwIfSqlStatementFault(options.faultDomain, index + 1);
          // react-native-sqlite-storage's tx.executeSql returns a ResultSet in
          // test doubles synchronously and accepts a success callback in the
          // native path. When onStatementComplete is provided, capture rows-
          // affected from whichever form is available so optimistic-concurrency
          // callers can detect 0-row chapter updates. The callback is optional;
          // when absent we use the plain two-arg form exactly as before.
          const onStmt = options.onStatementComplete;
          if (onStmt) {
            let delivered = false;
            const deliver = (result: SQLite.ResultSet | { rowsAffected?: number }) => {
              if (delivered) return;
              delivered = true;
              onStmt(index + 1, (result as any).rowsAffected ?? 0);
            };
            const r = tx.executeSql(
              statement.sql,
              (statement.params || []) as any[],
              (_t: SQLite.Transaction, result: SQLite.ResultSet) => {
                deliver(result);
              },
            ) as unknown;
            // Some test doubles return a ResultSet instead of invoking the
            // callback. The native module returns asynchronously, so never
            // report a provisional zero before its success callback runs.
            if (r && typeof (r as any).rowsAffected === 'number') {
              deliver(r as { rowsAffected?: number });
            }
          } else {
            tx.executeSql(statement.sql, (statement.params || []) as any[]);
          }
        }
      } catch (error) {
        rejectOnce(error);
        throw error;
      }
    };

    try {
      // The callback overload is the only form that guarantees the native
      // transaction is finalized after all scheduled statements complete.
      const transactionResult = database.transaction(
        scope,
        rejectOnce as SQLite.TransactionErrorCallback,
        resolveOnce as SQLite.TransactionCallback,
      ) as unknown;

      // Some test doubles and older promise-mode wrappers return a Promise
      // even when callbacks are supplied. Supporting that return value keeps
      // the executor deterministic without changing the native callback path.
      if (
        transactionResult &&
        typeof (transactionResult as Promise<unknown>).then === 'function'
      ) {
        (transactionResult as Promise<unknown>).then(resolveOnce, rejectOnce);
      }
    } catch (error) {
      rejectOnce(error);
    }
  });
}

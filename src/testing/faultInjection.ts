export type SqlFaultDomain = 'migration' | 'restore';

const SQL_STATEMENT_ENV: Record<SqlFaultDomain, string> = {
  migration: 'FAIL_MIGRATION_AT_STATEMENT',
  restore: 'FAIL_RESTORE_AT_STATEMENT',
};

/**
 * Jest-only deterministic failure seam. Metro release bundles always evaluate
 * this gate to false, and no application input or remote request can enable it.
 */
export function throwIfSqlStatementFault(
  domain: SqlFaultDomain | undefined,
  oneBasedStatementIndex: number,
): void {
  if (process.env.NODE_ENV !== 'test' || !domain) return;
  const configured = Number(process.env[SQL_STATEMENT_ENV[domain]]);
  if (!Number.isInteger(configured) || configured < 1) return;
  if (configured !== oneBasedStatementIndex) return;
  throw new Error(
    `FAULT_INJECTION: ${domain} statement ${oneBasedStatementIndex}`,
  );
}

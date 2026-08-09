/**
 * Schema 47 → 48: durable lineage for Final-only derived rewrites.
 *
 * The columns are nullable so all existing tasks keep their exact meaning.
 * A derived task stores its parent id, a narrow kind discriminator, and the
 * user's low-priority rewrite instruction while reusing the parent's frozen
 * context and successful upstream checkpoints.
 */
import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';
import { executeTransaction } from '../database/transaction';
import { tableColumns } from './helpers';

const DERIVED_COLUMNS = [
  {
    name: 'parent_task_id',
    ddl: 'ALTER TABLE pipeline_tasks ADD COLUMN parent_task_id TEXT',
  },
  {
    name: 'derived_kind',
    ddl: 'ALTER TABLE pipeline_tasks ADD COLUMN derived_kind TEXT',
  },
  {
    name: 'derived_instruction',
    ddl: 'ALTER TABLE pipeline_tasks ADD COLUMN derived_instruction TEXT',
  },
] as const;

export function buildV47toV48Statements(): SqlStatement[] {
  return [
    ...DERIVED_COLUMNS.map(column => ({ sql: column.ddl })),
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_parent_task
            ON pipeline_tasks(parent_task_id)`,
    },
  ];
}

export async function migrateV47ToV48(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  const columns = await tableColumns(db, 'pipeline_tasks');
  const statements: SqlStatement[] = DERIVED_COLUMNS
    .filter(column => !columns.has(column.name))
    .map(column => ({ sql: column.ddl }));
  statements.push({
    sql: `CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_parent_task
          ON pipeline_tasks(parent_task_id)`,
  });
  await executeTransaction(db, statements, { faultDomain: 'migration' });
}

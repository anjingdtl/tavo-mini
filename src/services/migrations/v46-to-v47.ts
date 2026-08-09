/**
 * Schema 46 → 47: V3.1 fail-closed recovery boundary.
 *
 * This migration is deliberately breaking.  Before any physical mutation the
 * migration runner creates a schema-recovery backup.  The data operation then
 * happens in one transaction: add per-attempt diagnostics and remove the old
 * V3/profile-2 execution chain.  V2 tasks, adopted chapter data, revisions,
 * and usage logs are never touched.
 */
import type SQLite from 'react-native-sqlite-storage';
import { executeTransaction, type SqlStatement } from '../database/transaction';
import { tableColumns } from './helpers';

export const V31_ATTEMPT_DIAGNOSTIC_COLUMNS = [
  {
    name: 'finish_reason',
    ddl: 'ALTER TABLE pipeline_stage_attempts ADD COLUMN finish_reason TEXT',
  },
  {
    name: 'empty_reason',
    ddl: 'ALTER TABLE pipeline_stage_attempts ADD COLUMN empty_reason TEXT',
  },
  {
    name: 'response_channel',
    ddl: 'ALTER TABLE pipeline_stage_attempts ADD COLUMN response_channel TEXT',
  },
  {
    name: 'visible_output_tokens',
    ddl: 'ALTER TABLE pipeline_stage_attempts ADD COLUMN visible_output_tokens INTEGER',
  },
  {
    name: 'parse_failure_code',
    ddl: 'ALTER TABLE pipeline_stage_attempts ADD COLUMN parse_failure_code TEXT',
  },
  {
    name: 'formatter_used',
    ddl: 'ALTER TABLE pipeline_stage_attempts ADD COLUMN formatter_used INTEGER NOT NULL DEFAULT 0',
  },
  {
    name: 'reasoning_content_temp',
    ddl: 'ALTER TABLE pipeline_stage_attempts ADD COLUMN reasoning_content_temp TEXT',
  },
] as const;

export function buildV46toV47Statements(): SqlStatement[] {
  return V31_ATTEMPT_DIAGNOSTIC_COLUMNS.map(column => ({ sql: column.ddl }));
}

function oldV3Profile(row: any): boolean {
  let context: any = null;
  try {
    context = row.pipeline_context_json
      ? JSON.parse(String(row.pipeline_context_json))
      : null;
  } catch {
    // A V3 row with an unreadable context cannot be proven to be V3.1; fail
    // closed by treating it as the pre-V3.1 chain.
    return true;
  }
  const execution = context?.execution;
  return Number(row.outline_workflow_version) === 3 &&
    Number(row.context_budget_version) === 3 &&
    Number(execution?.reasoningProfileVersion) !== 3;
}

/** Idempotent on already-upgraded/drifted databases. */
export async function migrateV46ToV47(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  const columns = await tableColumns(db, 'pipeline_stage_attempts');
  const statements: SqlStatement[] = V31_ATTEMPT_DIAGNOSTIC_COLUMNS
    .filter(column => !columns.has(column.name))
    .map(column => ({ sql: column.ddl }));

  const [result] = await db.executeSql(
    `SELECT id, outline_workflow_version, context_budget_version,
            pipeline_context_json
       FROM pipeline_tasks
      WHERE outline_workflow_version = 3
        AND context_budget_version = 3`,
  );
  const oldTaskIds: string[] = [];
  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows.item(index);
    if (oldV3Profile(row)) oldTaskIds.push(String(row.id));
  }

  // Explicit child deletes make the cleanup safe even for drifted databases
  // that lost an ON DELETE CASCADE declaration.  The task delete remains last.
  for (const taskId of oldTaskIds) {
    statements.push({
      sql: 'DELETE FROM pipeline_stage_attempts WHERE pipeline_task_id = ?',
      params: [taskId],
    });
    statements.push({
      sql: 'DELETE FROM pipeline_stage_checkpoints WHERE task_id = ?',
      params: [taskId],
    });
    statements.push({
      sql: 'DELETE FROM pipeline_tasks WHERE id = ?',
      params: [taskId],
    });
  }
  // New tasks must not recreate profile 2 after the upgrade. This setting is
  // not historical task state; it is the live default for future task starts.
  statements.push({
    sql: `INSERT OR REPLACE INTO settings (key, value)
          VALUES ('pipeline_reasoning_profile_version', '3')`,
  });

  if (statements.length > 0) {
    await executeTransaction(db, statements, { faultDomain: 'migration' });
  }
}


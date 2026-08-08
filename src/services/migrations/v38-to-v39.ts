/**
 * Schema 38 → 39: pipeline_stage_checkpoints (one durable row per task+stage).
 *
 * Replaces append-only stage_results JSON as the authority for stage status.
 * stage_results remains as a legacy projection column for backup/UI compat.
 */
import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';
import { executeTransaction } from '../database/transaction';

export const PIPELINE_STAGE_CHECKPOINTS_DDL = `
CREATE TABLE IF NOT EXISTS pipeline_stage_checkpoints (
  task_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  output_text TEXT,
  error_code TEXT,
  error_message TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  duration_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, stage),
  FOREIGN KEY (task_id) REFERENCES pipeline_tasks(id) ON DELETE CASCADE
)`;

export function buildV38toV39Statements(): SqlStatement[] {
  return [
    { sql: PIPELINE_STAGE_CHECKPOINTS_DDL },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_pipeline_stage_checkpoints_status
            ON pipeline_stage_checkpoints(status)`,
    },
  ];
}

/**
 * Backfill checkpoints from legacy stage_results JSON after table create.
 * Prefer succeeded > skipped > failed for each stage; last wins on ties.
 */
export async function migrateV38ToV39(db: SQLite.SQLiteDatabase): Promise<void> {
  const statements = buildV38toV39Statements();
  await executeTransaction(db, statements, { faultDomain: 'migration' });

  const [result] = await db.executeSql(
    `SELECT id, stage_results FROM pipeline_tasks WHERE stage_results IS NOT NULL AND stage_results != '[]'`,
  );
  const rows = result.rows;
  const now = Date.now();
  const priority: Record<string, number> = {
    success: 50,
    succeeded: 50,
    skipped: 40,
    failed: 30,
    running: 20,
    interrupted: 10,
    pending: 0,
  };

  const upserts: SqlStatement[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows.item(i);
    let parsed: any[] = [];
    try {
      parsed = JSON.parse(row.stage_results || '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    const best = new Map<
      string,
      {
        status: string;
        text: string | null;
        error: string | null;
        tokens?: { input?: number; output?: number; total?: number };
        durationMs?: number;
      }
    >();

    for (const item of parsed) {
      if (!item || !item.stage) continue;
      const stage = String(item.stage);
      const statusRaw = String(item.status || 'pending');
      const mapped =
        statusRaw === 'success' || statusRaw === 'succeeded'
          ? 'succeeded'
          : statusRaw === 'failed'
            ? 'failed'
            : statusRaw === 'skipped'
              ? 'skipped'
              : statusRaw === 'running'
                ? 'running'
                : statusRaw === 'interrupted'
                  ? 'interrupted'
                  : 'pending';
      const prev = best.get(stage);
      const pri = priority[statusRaw] ?? priority[mapped] ?? 0;
      const prevPri = prev
        ? priority[prev.status === 'succeeded' ? 'succeeded' : prev.status] ?? 0
        : -1;
      if (!prev || pri >= prevPri) {
        best.set(stage, {
          status: mapped,
          text: item.text ?? null,
          error: item.error ?? null,
          tokens: item.tokens,
          durationMs: item.durationMs,
        });
      }
    }

    for (const [stage, val] of best) {
      upserts.push({
        sql: `INSERT OR REPLACE INTO pipeline_stage_checkpoints (
          task_id, stage, status, output_text, error_code, error_message,
          input_tokens, output_tokens, total_tokens, duration_ms,
          attempt_count, started_at, completed_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
        params: [
          row.id,
          stage,
          val.status,
          val.text,
          val.error,
          val.tokens?.input ?? null,
          val.tokens?.output ?? null,
          val.tokens?.total ?? null,
          val.durationMs ?? null,
          val.status === 'succeeded' ||
          val.status === 'failed' ||
          val.status === 'skipped'
            ? now
            : null,
          now,
        ],
      });
    }
  }

  if (upserts.length > 0) {
    // Batch in chunks to avoid huge transactions.
    const chunk = 50;
    for (let i = 0; i < upserts.length; i += chunk) {
      await executeTransaction(db, upserts.slice(i, i + chunk), {
        faultDomain: 'migration',
      });
    }
  }
}

export function buildSchema39CreateSqls(): string[] {
  return [
    PIPELINE_STAGE_CHECKPOINTS_DDL,
    `CREATE INDEX IF NOT EXISTS idx_pipeline_stage_checkpoints_status
     ON pipeline_stage_checkpoints(status)`,
  ];
}

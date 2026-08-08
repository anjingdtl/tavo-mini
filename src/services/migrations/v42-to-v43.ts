/**
 * Schema 42 → 43: legacy smart story-memory policy interval unification.
 *
 * One-time data migration for projects created BEFORE the Story Memory
 * architecture upgrade that moved the default smart cadence to 10 chapters
 * (`STORY_MEMORY_DEFAULT_INTERVAL = 10`). Databases created before that
 * upgrade carry `mode = 'smart'` rows with legacy intervals (2..9, most
 * commonly 3) that never inherit the new default, because nothing rewrites
 * persisted policies at runtime.
 *
 * This migration is deliberately narrow:
 *   - ONLY `mode = 'smart'` rows with the legacy system-default interval (3)
 *     are touched. Historical evidence: `STORY_MEMORY_DEFAULT_INTERVAL` was 3
 *     until commit 52f09c6f (Schema 40 era) changed the runtime default to 10
 *     for NEW policies only; the schema column default is still 3. The smart
 *     interval is user-editable in the UI (StoryMemoryScreen), so smart/5,
 *     smart/7, smart/2 etc. are explicit user choices and MUST be preserved.
 *     smart/3 is the only value that can represent a legacy system default.
 *   - `fixed`, `every_chapter`, `manual` are explicit user strategy modes and
 *     stay untouched.
 *   - Rows that do not exist are not created — projects without a policy keep
 *     the fresh-install default (smart / 10) when `ensureStoryMemoryPolicy`
 *     first runs.
 *   - A single UPDATE is idempotent: re-running it changes nothing.
 *
 * The migration runs once through the versioned migration engine (42 → 43).
 * After it completes, the user can freely set their own smart interval again —
 * nothing at runtime re-imposes 10.
 *
 * Non-breaking: no schema change, no table change, no backup-format change.
 */
import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';
import { executeTransaction } from '../database/transaction';

export const SMART_INTERVAL_UNIFICATION_SQL =
  `UPDATE project_story_memory_policy SET interval_chapters = 10 WHERE mode = 'smart' AND interval_chapters = 3`;

export function buildV42toV43Statements(): SqlStatement[] {
  return [{ sql: SMART_INTERVAL_UNIFICATION_SQL }];
}

/** Logic migration — one idempotent UPDATE via the transaction runner. */
export async function migrateV42ToV43(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  const statements = buildV42toV43Statements();
  await executeTransaction(db, statements, { faultDomain: 'migration' });
}

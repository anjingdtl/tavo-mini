import type SQLite from 'react-native-sqlite-storage';
import { executeTransaction } from '../database/transaction';

/**
 * C3 durable Governor state is intentionally an aggregate-only table. Do not
 * add prompt, message, manuscript, Canon, Memory, or JSON/BLOB columns here.
 */
export function buildWritingGovernorProfilesCreateSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS writing_governor_profiles (
      profile_key TEXT PRIMARY KEY NOT NULL CHECK(length(profile_key) BETWEEN 1 AND 128),
      policy_version TEXT NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0 CHECK(sample_count >= 0),
      known_result_count INTEGER NOT NULL DEFAULT 0 CHECK(known_result_count >= 0),
      low_utilization_count INTEGER NOT NULL DEFAULT 0 CHECK(low_utilization_count >= 0),
      length_signal_count INTEGER NOT NULL DEFAULT 0 CHECK(length_signal_count >= 0),
      recommended_scale REAL NOT NULL DEFAULT 1,
      average_completion_ratio REAL,
      average_latency_ms REAL,
      reasoning_sample_count INTEGER NOT NULL DEFAULT 0 CHECK(reasoning_sample_count >= 0),
      reasoning_ratio_ewma REAL,
      reasoning_ratio_high_water REAL,
      reasoning_prompt_ratio_ewma REAL,
      reasoning_prompt_ratio_high_water REAL,
      last_finish_reason TEXT,
      updated_at INTEGER NOT NULL
    )`;
}

/** Schema 59 → 60. Additive and idempotent for upgraded installs/test fixtures. */
export async function migrateV59ToV60(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  await executeTransaction(
    db,
    [{ sql: buildWritingGovernorProfilesCreateSql() }],
    { faultDomain: 'migration' },
  );
}

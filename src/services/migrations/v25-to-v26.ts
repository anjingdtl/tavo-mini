import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

/**
 * Schema 25 → 26: versioned continuation style profiles + active pointer.
 *
 * The Phase 3 `continuation_style_profiles` table previously used `project_id`
 * as its primary key, so only one lightweight row could ever exist per project
 * with no source/boundary fingerprint and no staging/ready/history lifecycle.
 * This migration rebuilds it as a versioned table (Spec §6.1) so Canon analysis
 * can publish a structured style profile atomically alongside the Canon
 * snapshot, while stale legacy rows are preserved as `outdated` (never
 * auto-injected). `continuation_settings` gains `active_style_profile_id` to
 * point at the currently-active profile for a project.
 *
 * Backup format v3 is unchanged: the rebuilt table stays `backup:true`, and the
 * legacy rows survive the RENAME→copy→DROP so a restored backup still carries
 * historical context (just marked outdated until re-analyzed).
 */

/**
 * Canonical CREATE statements for the versioned style profile table and its
 * indexes. Used by both the migration (which rebuilds the table) and the fresh
 * schema (createCurrentSchema) so upgraded and fresh installs agree.
 */
export function buildSchema26CreateSqls(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS continuation_style_profiles (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      source_id INTEGER NOT NULL,
      source_version INTEGER NOT NULL,
      source_sha256 TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      normalization_version TEXT NOT NULL,
      boundary_chapter_id INTEGER NOT NULL,
      boundary_position INTEGER NOT NULL,
      boundary_char_offset_exclusive INTEGER NOT NULL,
      analysis_run_id TEXT NOT NULL,
      canon_snapshot_id TEXT NOT NULL,
      profile_schema_version INTEGER NOT NULL,
      analyzer_version TEXT NOT NULL,
      profile_json TEXT NOT NULL DEFAULT '{}',
      metrics_json TEXT NOT NULL DEFAULT '{}',
      sample_refs_json TEXT NOT NULL DEFAULT '[]',
      user_overrides_json TEXT NOT NULL DEFAULT '{}',
      profile_hash TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'queued',
      review_status TEXT NOT NULL DEFAULT 'pending',
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      CHECK(state IN (
        'queued', 'running', 'ready', 'failed',
        'interrupted', 'cancelled', 'outdated'
      )),
      CHECK(review_status IN ('pending', 'confirmed', 'ignored')),
      CHECK(confidence BETWEEN 0 AND 1),
      CHECK(source_version >= 1),
      CHECK(boundary_position >= 0),
      CHECK(boundary_char_offset_exclusive >= 0),
      CHECK(profile_schema_version >= 1),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
      FOREIGN KEY(canon_snapshot_id)
        REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_continuation_style_profiles_project_state
      ON continuation_style_profiles(project_id, state, updated_at DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_continuation_style_profiles_fingerprint
      ON continuation_style_profiles(
        project_id,
        source_id,
        source_version,
        source_sha256,
        boundary_char_offset_exclusive,
        analyzer_version
      )`,
  ];
}

/**
 * Statements that run after Phase 1/2/3 tables already exist. Used by
 * createCurrentSchema (which creates the versioned style table via
 * buildSchema26CreateSqls and inlines the settings column) and skips the
 * migration-only ALTER and the legacy-table rebuild.
 */
export function buildSchema26PostStyleStatements(): string[] {
  // Fresh schema builds the versioned table directly; nothing post-style is
  // needed beyond what createCurrentSchema already inlines. Kept as a hook for
  // symmetry with buildSchema20PostSettingsStatements.
  return [];
}

export async function migrateV25ToV26(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, buildV25toV26Statements());

  // Schema 25 already accepts style_analysis/style_validation stages (the
  // stages were introduced by the v19 Canon schema). Do not rebuild
  // continuation_analysis_runs: its child tables have immediate
  // ON DELETE CASCADE foreign keys, and SQLite rewrites those references when
  // a parent is renamed. Verify the live SQLite connection after migration.
  const [foreignKeyCheck] = await database.executeSql(
    'PRAGMA foreign_key_check',
  );
  if (foreignKeyCheck.rows.length > 0) {
    throw new Error(
      `Schema 26 迁移后发现 ${foreignKeyCheck.rows.length} 条外键孤儿记录`,
    );
  }

  const childTables = [
    'continuation_analysis_batches',
    'continuation_analysis_work_items',
    'canon_evidence',
    'canon_evidence_links',
  ];
  for (const table of childTables) {
    const [foreignKeys] = await database.executeSql(
      `PRAGMA foreign_key_list(${table})`,
    );
    for (let index = 0; index < foreignKeys.rows.length; index += 1) {
      const row = foreignKeys.rows.item(index);
      if (String(row.table).endsWith('_v25')) {
        throw new Error(
          `Schema 26 迁移后 ${table} 仍引用已删除的 ${String(row.table)}`,
        );
      }
    }
  }
}

/**
 * Migration statements:
 * 1. Rename the legacy single-row-per-project table aside.
 * 2. Create the versioned table + indexes.
 * 3. Backfill legacy rows as `outdated` profiles — they lack a reliable source
 *    fingerprint and the detailed V2 profile, so they must never auto-inject.
 *    We synthesize a stable id and a best-effort profile_json so the row is
 *    valid, but state='outdated' forces re-analysis before use.
 * 4. Drop the renamed legacy table.
 * 5. Add `active_style_profile_id` to continuation_settings (no legacy profile
 *    is auto-activated; the pointer starts NULL).
 *
 * Important: continuation_analysis_runs is intentionally not rebuilt here.
 * Its Schema 25 definition already accepts both style stages, so a parent
 * rename would be unnecessary and could cascade-delete Canon descendants.
 */
export function buildV25toV26Statements(): SqlStatement[] {
  const [createTableSql, createProjectStateIndexSql, createFingerprintIndexSql] =
    buildSchema26CreateSqls();
  return [
    {
      sql: `ALTER TABLE continuation_style_profiles
        RENAME TO continuation_style_profiles_v25`,
    },
    { sql: createTableSql },
    {
      sql: `INSERT INTO continuation_style_profiles (
        id, project_id, source_id, source_version, source_sha256,
        parser_version, normalization_version,
        boundary_chapter_id, boundary_position, boundary_char_offset_exclusive,
        analysis_run_id, canon_snapshot_id,
        profile_schema_version, analyzer_version,
        profile_json, metrics_json, sample_refs_json, user_overrides_json,
        profile_hash, confidence, state, review_status,
        error_code, error_message, created_at, updated_at, completed_at
      ) SELECT
        'legacy_' || project_id,
        project_id,
        source_id,
        1,
        '',
        '',
        '',
        0,
        0,
        0,
        '',
        canon_snapshot_id,
        1,
        'legacy-v25',
        '{}',
        '{}',
        '[]',
        '{}',
        '',
        0,
        'outdated',
        'pending',
        'legacy_pre_v26',
        '升级到 Schema 26 前的轻量画像，缺少原著指纹与详细风格，请重新分析原著风格',
        created_at,
        updated_at,
        updated_at
      FROM continuation_style_profiles_v25`,
    },
    { sql: 'DROP TABLE continuation_style_profiles_v25' },
    { sql: createProjectStateIndexSql },
    { sql: createFingerprintIndexSql },
    {
      // SQLite ADD COLUMN cannot add a true FK at the table level in older
      // versions; column + app-level integrity is sufficient. REFERENCES is
      // declared for documentation and engines that honour it. Mirrors the
      // Schema 19→20 active_canon_snapshot_id pattern.
      sql: `ALTER TABLE continuation_settings
        ADD COLUMN active_style_profile_id TEXT
          REFERENCES continuation_style_profiles(id)`,
    },
  ];
}

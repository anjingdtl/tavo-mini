import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

/**
 * Schema 19 → 20: continuation Phase 2 Canon analysis (Spec §6).
 *
 * Adds:
 *   - continuation_canon_snapshots (+ settings.active_canon_snapshot_id)
 *   - continuation_analysis_runs / continuation_analysis_batches
 *   - canon_evidence / canon_evidence_links
 *   - Five Canon families + aliases/states/knowledge/timeline/plot links
 *
 * Fresh schema must mirror every statement (createCurrentSchema).
 * All Canon business tables are backup:true.
 */

const GOVERNANCE_COLUMNS = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  source_id INTEGER NOT NULL,
  snapshot_id TEXT NOT NULL,
  analysis_run_id TEXT NOT NULL,
  valid_from_position INTEGER NOT NULL,
  valid_to_position INTEGER,
  first_observed_position INTEGER NOT NULL,
  last_observed_position INTEGER NOT NULL,
  confidence REAL NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending',
  origin TEXT NOT NULL DEFAULT 'ai',
  extraction_version TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  supersedes_id INTEGER,
  user_reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
`.trim();

/**
 * Emit table constraints only after each Canon family's specific columns.
 * SQLite does not allow a later column definition after a CHECK or FOREIGN
 * KEY table constraint, which otherwise breaks fresh schema creation.
 */
function governanceFks(table: string): string {
  return `
  CHECK(valid_from_position >= 0),
  CHECK(valid_to_position IS NULL OR valid_to_position > valid_from_position),
  CHECK(first_observed_position >= 0),
  CHECK(last_observed_position >= first_observed_position),
  CHECK(confidence BETWEEN 0 AND 1),
  CHECK(review_status IN ('pending', 'confirmed', 'locked', 'ignored', 'superseded')),
  CHECK(origin IN ('ai', 'user')),
  CHECK(revision >= 1),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
  FOREIGN KEY(snapshot_id) REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE,
  FOREIGN KEY(analysis_run_id) REFERENCES continuation_analysis_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(supersedes_id) REFERENCES ${table}(id) ON DELETE SET NULL`;
}

function governanceIndexes(table: string, extra: string[] = []): SqlStatement[] {
  const base = [
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_${table}_snapshot_review ON ${table}(snapshot_id, review_status)`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_${table}_snapshot_from ON ${table}(snapshot_id, valid_from_position)`,
    },
  ];
  return [...base, ...extra.map(sql => ({ sql }))];
}

/** SQL strings used by both migration and fresh schema. */
export function buildSchema20CreateSqls(): string[] {
  return buildV19toV20Statements().map(s => s.sql);
}

/**
 * Statements that must run after Phase 1 tables + snapshots already exist.
 * Used by createCurrentSchema (which creates snapshots earlier so settings can
 * reference active_canon_snapshot_id) and skips the migration-only ALTER.
 */
export function buildSchema20PostSettingsStatements(): SqlStatement[] {
  return buildV19toV20Statements().filter(s => {
    const sql = s.sql.replace(/\s+/g, ' ');
    if (sql.includes('CREATE TABLE IF NOT EXISTS continuation_canon_snapshots')) {
      return false;
    }
    if (sql.includes('idx_canon_snapshots_one_ready')) return false;
    if (sql.includes('idx_canon_snapshots_source')) return false;
    if (sql.includes('ALTER TABLE continuation_settings')) return false;
    return true;
  });
}

export function buildV19toV20Statements(): SqlStatement[] {
  const statements: SqlStatement[] = [
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_canon_snapshots (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        source_id INTEGER NOT NULL,
        analysis_run_id TEXT,
        source_version INTEGER NOT NULL,
        source_sha256 TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        normalization_version TEXT NOT NULL,
        boundary_chapter_id INTEGER NOT NULL,
        boundary_position INTEGER NOT NULL,
        boundary_char_offset_exclusive INTEGER NOT NULL,
        extraction_version TEXT NOT NULL,
        profile TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK(
          status IN (
            'staging', 'awaiting_review', 'ready',
            'outdated', 'failed'
          )
        ),
        capabilities_json TEXT NOT NULL,
        coverage_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        activated_at TEXT,
        CHECK(source_version >= 1),
        CHECK(boundary_position >= 0),
        CHECK(boundary_char_offset_exclusive >= 0),
        CHECK(profile IN ('quick', 'standard', 'deep')),
        CHECK(revision >= 1),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
        FOREIGN KEY(boundary_chapter_id)
          REFERENCES continuation_source_chapters(id) ON DELETE CASCADE
      )`,
    },
    {
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_canon_snapshots_one_ready
        ON continuation_canon_snapshots(project_id)
        WHERE status = 'ready'`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_canon_snapshots_source
        ON continuation_canon_snapshots(project_id, source_id, status)`,
    },
    {
      // SQLite ADD COLUMN cannot add a true FK constraint at the table level
      // in older versions; column + app-level integrity is sufficient. We still
      // declare REFERENCES for documentation and engines that honour it.
      sql: `ALTER TABLE continuation_settings
        ADD COLUMN active_canon_snapshot_id TEXT
          REFERENCES continuation_canon_snapshots(id)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_analysis_runs (
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
        canon_snapshot_id TEXT NOT NULL,
        profile TEXT NOT NULL,
        model_config_id INTEGER,
        state TEXT NOT NULL,
        stage TEXT NOT NULL,
        progress_current INTEGER NOT NULL DEFAULT 0,
        progress_total INTEGER NOT NULL DEFAULT 0,
        extraction_version TEXT NOT NULL,
        checkpoint_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK(source_version >= 1),
        CHECK(boundary_position >= 0),
        CHECK(boundary_char_offset_exclusive >= 0),
        CHECK(profile IN ('quick', 'standard', 'deep')),
        CHECK(state IN (
          'queued', 'running', 'paused', 'awaiting_review',
          'completed', 'failed', 'cancelled', 'outdated'
        )),
        CHECK(stage IN (
          'snapshot', 'chapter_extraction', 'entity_resolution',
          'temporal_merge', 'global_synthesis', 'evidence_validation',
          'indexing', 'finalizing', 'style_analysis', 'style_validation'
        )),
        CHECK(progress_current >= 0),
        CHECK(progress_total >= 0),
        CHECK(progress_total = 0 OR progress_current <= progress_total),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
        FOREIGN KEY(model_config_id) REFERENCES llm_config(id) ON DELETE SET NULL,
        FOREIGN KEY(canon_snapshot_id)
          REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_analysis_runs_project_state
        ON continuation_analysis_runs(project_id, state)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_analysis_batches (
        run_id TEXT NOT NULL,
        canon_snapshot_id TEXT NOT NULL,
        batch_index INTEGER NOT NULL,
        start_position INTEGER NOT NULL,
        end_position INTEGER NOT NULL,
        input_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL DEFAULT 'queued',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY(run_id, batch_index),
        CHECK(batch_index >= 0),
        CHECK(start_position >= 0 AND end_position > start_position),
        CHECK(state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        CHECK(attempt_count >= 0),
        FOREIGN KEY(run_id) REFERENCES continuation_analysis_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(canon_snapshot_id)
          REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_analysis_batches_state
        ON continuation_analysis_batches(run_id, state, batch_index)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS canon_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        source_id INTEGER NOT NULL,
        snapshot_id TEXT NOT NULL,
        chapter_id INTEGER NOT NULL,
        chapter_position INTEGER NOT NULL,
        paragraph_start INTEGER,
        paragraph_end INTEGER,
        char_start INTEGER NOT NULL,
        char_end INTEGER NOT NULL,
        quote_preview TEXT NOT NULL,
        quote_sha256 TEXT NOT NULL,
        analysis_run_id TEXT NOT NULL,
        source_origin TEXT NOT NULL DEFAULT 'batch',
        rescan_operation_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
        FOREIGN KEY(snapshot_id)
          REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE,
        FOREIGN KEY(chapter_id)
          REFERENCES continuation_source_chapters(id) ON DELETE CASCADE,
        CHECK(char_start >= 0),
        CHECK(char_end > char_start),
        CHECK(
          (paragraph_start IS NULL AND paragraph_end IS NULL)
          OR
          (paragraph_start >= 0 AND paragraph_end >= paragraph_start)
        )
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS canon_evidence_links (
        evidence_id INTEGER NOT NULL,
        snapshot_id TEXT NOT NULL,
        owner_type TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(evidence_id, owner_type, owner_id),
        FOREIGN KEY(evidence_id) REFERENCES canon_evidence(id) ON DELETE CASCADE,
        FOREIGN KEY(snapshot_id)
          REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_canon_evidence_range
        ON canon_evidence(snapshot_id, chapter_position, char_start, char_end)`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_canon_evidence_links_owner
        ON canon_evidence_links(snapshot_id, owner_type, owner_id)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS canon_world_rules (
        ${GOVERNANCE_COLUMNS},
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        constraint_level TEXT NOT NULL CHECK(constraint_level IN ('hard','strong','reference')),
        ${governanceFks('canon_world_rules')}
      )`,
    },
    ...governanceIndexes('canon_world_rules', [
      `CREATE INDEX IF NOT EXISTS idx_canon_world_rules_category ON canon_world_rules(snapshot_id, category)`,
    ]),
    {
      sql: `CREATE TABLE IF NOT EXISTS canon_characters (
        ${GOVERNANCE_COLUMNS},
        canonical_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        background TEXT NOT NULL DEFAULT '',
        appearance_json TEXT NOT NULL DEFAULT '{}',
        personality_json TEXT NOT NULL DEFAULT '{}',
        values_json TEXT NOT NULL DEFAULT '[]',
        behavior_patterns_json TEXT NOT NULL DEFAULT '[]',
        speech_style_json TEXT NOT NULL DEFAULT '{}',
        abilities_json TEXT NOT NULL DEFAULT '[]',
        weaknesses_json TEXT NOT NULL DEFAULT '[]',
        goals_json TEXT NOT NULL DEFAULT '[]',
        fears_json TEXT NOT NULL DEFAULT '[]',
        secrets_json TEXT NOT NULL DEFAULT '[]',
        first_appearance_position INTEGER NOT NULL,
        importance TEXT NOT NULL CHECK(importance IN ('primary','major','supporting','minor')),
        ${governanceFks('canon_characters')}
      )`,
    },
    ...governanceIndexes('canon_characters', [
      `CREATE INDEX IF NOT EXISTS idx_canon_characters_name ON canon_characters(snapshot_id, canonical_name)`,
    ]),
    {
      sql: `CREATE TABLE IF NOT EXISTS canon_character_aliases (
        ${GOVERNANCE_COLUMNS},
        character_id INTEGER NOT NULL,
        alias TEXT NOT NULL,
        alias_normalized TEXT NOT NULL,
        alias_type TEXT NOT NULL,
        is_ambiguous INTEGER NOT NULL DEFAULT 0 CHECK(is_ambiguous IN (0,1)),
        FOREIGN KEY(character_id) REFERENCES canon_characters(id) ON DELETE CASCADE,
        ${governanceFks('canon_character_aliases')}
      )`,
    },
    ...governanceIndexes('canon_character_aliases', [
      `CREATE INDEX IF NOT EXISTS idx_canon_aliases_norm ON canon_character_aliases(snapshot_id, alias_normalized, valid_from_position, valid_to_position)`,
      `CREATE INDEX IF NOT EXISTS idx_canon_aliases_char ON canon_character_aliases(snapshot_id, character_id)`,
    ]),
    {
      sql: `CREATE TABLE IF NOT EXISTS canon_character_state_snapshots (
        ${GOVERNANCE_COLUMNS},
        character_id INTEGER NOT NULL,
        chapter_position INTEGER NOT NULL,
        location TEXT,
        physical_state TEXT,
        emotional_state TEXT,
        identity_state TEXT,
        organization_state TEXT,
        current_goal TEXT,
        possessions_json TEXT NOT NULL DEFAULT '[]',
        abilities_state_json TEXT NOT NULL DEFAULT '{}',
        alive_state TEXT NOT NULL DEFAULT 'unknown' CHECK(alive_state IN ('alive','dead','unknown')),
        summary TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(character_id) REFERENCES canon_characters(id) ON DELETE CASCADE,
        ${governanceFks('canon_character_state_snapshots')}
      )`,
    },
    ...governanceIndexes('canon_character_state_snapshots', [
      `CREATE INDEX IF NOT EXISTS idx_canon_char_state_pos ON canon_character_state_snapshots(snapshot_id, character_id, chapter_position)`,
    ]),
    {
      sql: `CREATE TABLE IF NOT EXISTS canon_relationships (
        ${GOVERNANCE_COLUMNS},
        source_character_id INTEGER NOT NULL,
        target_character_id INTEGER NOT NULL,
        relation_type TEXT NOT NULL,
        attitude TEXT NOT NULL DEFAULT '',
        public_status TEXT NOT NULL CHECK(public_status IN ('public','secret','misunderstood','one_sided')),
        description TEXT NOT NULL DEFAULT '',
        causes_json TEXT NOT NULL DEFAULT '[]',
        CHECK(source_character_id <> target_character_id),
        FOREIGN KEY(source_character_id) REFERENCES canon_characters(id) ON DELETE CASCADE,
        FOREIGN KEY(target_character_id) REFERENCES canon_characters(id) ON DELETE CASCADE,
        ${governanceFks('canon_relationships')}
      )`,
    },
    ...governanceIndexes('canon_relationships', [
      `CREATE INDEX IF NOT EXISTS idx_canon_rel_pair ON canon_relationships(snapshot_id, source_character_id, target_character_id, relation_type, valid_from_position)`,
    ]),
    {
      sql: `CREATE TABLE IF NOT EXISTS canon_plot_threads (
        ${GOVERNANCE_COLUMNS},
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        level TEXT NOT NULL CHECK(level IN ('main','volume','arc','subplot','foreshadowing')),
        status TEXT NOT NULL CHECK(status IN ('active','paused','resolved','abandoned','unknown')),
        importance INTEGER NOT NULL DEFAULT 0,
        start_position INTEGER NOT NULL,
        last_advanced_position INTEGER NOT NULL,
        resolved_position INTEGER,
        established_facts_json TEXT NOT NULL DEFAULT '[]',
        unresolved_questions_json TEXT NOT NULL DEFAULT '[]',
        expected_directions_json TEXT NOT NULL DEFAULT '[]',
        ${governanceFks('canon_plot_threads')}
      )`,
    },
    ...governanceIndexes('canon_plot_threads', [
      `CREATE INDEX IF NOT EXISTS idx_canon_plot_status ON canon_plot_threads(snapshot_id, status, level)`,
    ]),
    {
      sql: `CREATE TABLE IF NOT EXISTS canon_plot_thread_characters (
        snapshot_id TEXT NOT NULL,
        plot_thread_id INTEGER NOT NULL,
        character_id INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY(snapshot_id, plot_thread_id, character_id),
        FOREIGN KEY(snapshot_id)
          REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE,
        FOREIGN KEY(plot_thread_id) REFERENCES canon_plot_threads(id) ON DELETE CASCADE,
        FOREIGN KEY(character_id) REFERENCES canon_characters(id) ON DELETE CASCADE
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS canon_character_experiences (
        ${GOVERNANCE_COLUMNS},
        character_id INTEGER NOT NULL,
        chapter_position INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        involved_character_ids_json TEXT NOT NULL DEFAULT '[]',
        impact_on_personality TEXT,
        impact_on_goal TEXT,
        impact_on_relationship TEXT,
        knowledge_gained_json TEXT NOT NULL DEFAULT '[]',
        secrets_learned_json TEXT NOT NULL DEFAULT '[]',
        importance INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(character_id) REFERENCES canon_characters(id) ON DELETE CASCADE,
        ${governanceFks('canon_character_experiences')}
      )`,
    },
    ...governanceIndexes('canon_character_experiences', [
      `CREATE INDEX IF NOT EXISTS idx_canon_exp_char_pos ON canon_character_experiences(snapshot_id, character_id, chapter_position)`,
    ]),
    {
      sql: `CREATE TABLE IF NOT EXISTS canon_character_knowledge (
        ${GOVERNANCE_COLUMNS},
        character_id INTEGER NOT NULL,
        fact_key TEXT NOT NULL,
        fact_summary TEXT NOT NULL,
        knowledge_state TEXT NOT NULL CHECK(knowledge_state IN ('unknown','suspected','known','misunderstood')),
        learned_position INTEGER,
        learned_from_character_id INTEGER,
        misunderstanding_summary TEXT,
        FOREIGN KEY(character_id) REFERENCES canon_characters(id) ON DELETE CASCADE,
        FOREIGN KEY(learned_from_character_id) REFERENCES canon_characters(id) ON DELETE SET NULL,
        ${governanceFks('canon_character_knowledge')}
      )`,
    },
    ...governanceIndexes('canon_character_knowledge', [
      `CREATE INDEX IF NOT EXISTS idx_canon_know_char_pos ON canon_character_knowledge(snapshot_id, character_id, valid_from_position)`,
    ]),
    {
      sql: `CREATE TABLE IF NOT EXISTS canon_timeline_events (
        ${GOVERNANCE_COLUMNS},
        event_key TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        event_type TEXT NOT NULL,
        chapter_position INTEGER NOT NULL,
        char_start INTEGER,
        char_end INTEGER,
        participant_character_ids_json TEXT NOT NULL DEFAULT '[]',
        location_before TEXT,
        location_after TEXT,
        relative_time_json TEXT NOT NULL DEFAULT '{}',
        causes_event_ids_json TEXT NOT NULL DEFAULT '[]',
        consequences_event_ids_json TEXT NOT NULL DEFAULT '[]',
        importance INTEGER NOT NULL DEFAULT 0,
        CHECK((char_start IS NULL AND char_end IS NULL) OR (char_start >= 0 AND char_end > char_start)),
        ${governanceFks('canon_timeline_events')}
      )`,
    },
    ...governanceIndexes('canon_timeline_events', [
      `CREATE INDEX IF NOT EXISTS idx_canon_timeline_pos ON canon_timeline_events(snapshot_id, chapter_position)`,
    ]),
  ];

  return statements;
}

export async function migrateV19ToV20(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, buildV19toV20Statements());
}

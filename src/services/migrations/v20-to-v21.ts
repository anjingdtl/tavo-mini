import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

/**
 * Schema 20 → 21: continuation Phase 3 AI generation (Spec §7).
 *
 * Adds generation settings/runs/artifacts/plans/checks,
 * state proposals/events/entities/aliases, sync outbox, style profiles.
 * All tables are backup:true (Spec §7.10).
 */

/** SQL strings used by both migration and fresh schema. */
export function buildSchema21CreateSqls(): string[] {
  return buildV20toV21Statements().map(s => s.sql);
}

export async function migrateV20ToV21(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(db, buildV20toV21Statements());
}

export function buildV20toV21Statements(): SqlStatement[] {
  return [
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_generation_settings (
        project_id INTEGER PRIMARY KEY,
        strictness_profile TEXT NOT NULL DEFAULT 'balanced',
        world_rule_level TEXT NOT NULL DEFAULT 'strict',
        character_level TEXT NOT NULL DEFAULT 'strict',
        relationship_level TEXT NOT NULL DEFAULT 'strict',
        plot_level TEXT NOT NULL DEFAULT 'balanced',
        experience_level TEXT NOT NULL DEFAULT 'strict',
        knowledge_level TEXT NOT NULL DEFAULT 'strict',
        style_level TEXT NOT NULL DEFAULT 'balanced',
        allow_new_characters INTEGER NOT NULL DEFAULT 1,
        allow_new_locations INTEGER NOT NULL DEFAULT 1,
        allow_new_organizations INTEGER NOT NULL DEFAULT 1,
        major_relationship_change_policy TEXT NOT NULL DEFAULT 'require_confirmation',
        major_power_change_policy TEXT NOT NULL DEFAULT 'require_confirmation',
        character_death_policy TEXT NOT NULL DEFAULT 'require_confirmation',
        resurrection_policy TEXT NOT NULL DEFAULT 'forbid',
        planner_llm_config_id INTEGER,
        writer_llm_config_id INTEGER,
        checker_llm_config_id INTEGER,
        repair_llm_config_id INTEGER,
        state_extraction_llm_config_id INTEGER,
        planner_confirmation_policy TEXT NOT NULL DEFAULT 'risk_only',
        checker_enabled INTEGER NOT NULL DEFAULT 1,
        max_repair_rounds INTEGER NOT NULL DEFAULT 1,
        target_chapter_chars INTEGER NOT NULL DEFAULT 3000,
        custom_rules_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(strictness_profile IN ('loose', 'balanced', 'strict', 'custom')),
        CHECK(world_rule_level IN ('off', 'balanced', 'strict')),
        CHECK(character_level IN ('off', 'balanced', 'strict')),
        CHECK(relationship_level IN ('off', 'balanced', 'strict')),
        CHECK(plot_level IN ('off', 'balanced', 'strict')),
        CHECK(experience_level IN ('off', 'balanced', 'strict')),
        CHECK(knowledge_level IN ('off', 'balanced', 'strict')),
        CHECK(style_level IN ('off', 'balanced', 'strict')),
        CHECK(allow_new_characters IN (0, 1)),
        CHECK(allow_new_locations IN (0, 1)),
        CHECK(allow_new_organizations IN (0, 1)),
        CHECK(major_relationship_change_policy IN ('allow', 'require_confirmation', 'forbid')),
        CHECK(major_power_change_policy IN ('allow', 'require_confirmation', 'forbid')),
        CHECK(character_death_policy IN ('allow', 'require_confirmation', 'forbid')),
        CHECK(resurrection_policy IN ('allow', 'require_confirmation', 'forbid')),
        CHECK(planner_confirmation_policy IN ('never', 'risk_only', 'always')),
        CHECK(checker_enabled IN (0, 1)),
        CHECK(max_repair_rounds BETWEEN 0 AND 3),
        CHECK(target_chapter_chars BETWEEN 200 AND 30000),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(planner_llm_config_id) REFERENCES llm_config(id) ON DELETE SET NULL,
        FOREIGN KEY(writer_llm_config_id) REFERENCES llm_config(id) ON DELETE SET NULL,
        FOREIGN KEY(checker_llm_config_id) REFERENCES llm_config(id) ON DELETE SET NULL,
        FOREIGN KEY(repair_llm_config_id) REFERENCES llm_config(id) ON DELETE SET NULL,
        FOREIGN KEY(state_extraction_llm_config_id) REFERENCES llm_config(id) ON DELETE SET NULL
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_generation_runs (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        chapter_id INTEGER NOT NULL,
        target_position INTEGER NOT NULL,
        source_id INTEGER,
        source_snapshot_json TEXT NOT NULL,
        canon_snapshot_id TEXT,
        canon_revision INTEGER NOT NULL,
        story_memory_fingerprint TEXT NOT NULL,
        story_memory_through_position INTEGER NOT NULL,
        input_revision_hash TEXT NOT NULL,
        user_instruction TEXT NOT NULL,
        settings_snapshot_json TEXT NOT NULL,
        context_snapshot_json TEXT,
        context_trace_json TEXT,
        token_usage_json TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL,
        stage TEXT NOT NULL,
        completion_reason TEXT,
        adopted_revision_hash TEXT,
        finalized_revision_hash TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK(id LIKE 'ct_%'),
        CHECK(target_position >= 0),
        CHECK(canon_revision >= 1),
        CHECK(story_memory_through_position >= -1),
        CHECK(state IN (
          'queued', 'running', 'awaiting_user', 'completed',
          'failed', 'cancelled', 'interrupted', 'outdated'
        )),
        CHECK(stage IN (
          'context', 'planner', 'writer', 'checker', 'repair',
          'awaiting_user'
        )),
        CHECK(completion_reason IS NULL OR completion_reason IN ('adopted', 'abandoned')),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
        FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE SET NULL,
        FOREIGN KEY(canon_snapshot_id) REFERENCES continuation_canon_snapshots(id) ON DELETE SET NULL
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_runs_project_created
        ON continuation_generation_runs(project_id, created_at DESC)`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_runs_chapter_created
        ON continuation_generation_runs(chapter_id, created_at DESC)`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_runs_state
        ON continuation_generation_runs(state, updated_at)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_generation_artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        repair_round INTEGER NOT NULL DEFAULT 0,
        parent_artifact_id TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK(stage IN ('writer', 'repair', 'user_edit')),
        CHECK(repair_round BETWEEN 0 AND 3),
        UNIQUE(run_id, content_hash),
        FOREIGN KEY(run_id) REFERENCES continuation_generation_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(parent_artifact_id) REFERENCES continuation_generation_artifacts(id) ON DELETE SET NULL
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_artifacts_run_created
        ON continuation_generation_artifacts(run_id, created_at)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_plans (
        run_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        plan_json TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        confirmation_status TEXT NOT NULL DEFAULT 'not_required',
        confirmed_at TEXT,
        created_at TEXT NOT NULL,
        CHECK(schema_version >= 1),
        CHECK(confirmation_status IN ('not_required', 'pending', 'confirmed', 'rejected')),
        FOREIGN KEY(run_id) REFERENCES continuation_generation_runs(id) ON DELETE CASCADE
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_check_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        chapter_id INTEGER NOT NULL,
        artifact_id TEXT NOT NULL,
        artifact_hash TEXT NOT NULL,
        category TEXT NOT NULL,
        subtype TEXT NOT NULL,
        severity TEXT NOT NULL,
        confidence REAL NOT NULL,
        generated_start INTEGER,
        generated_end INTEGER,
        generated_excerpt TEXT NOT NULL,
        description TEXT NOT NULL,
        entity_ref_type TEXT,
        entity_ref_id TEXT,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        suggested_fix TEXT,
        resolution_status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(category IN (
          'world', 'character', 'relationship', 'plot',
          'experience', 'knowledge', 'timeline', 'style'
        )),
        CHECK(severity IN ('info', 'warning', 'error', 'blocking')),
        CHECK(confidence BETWEEN 0 AND 1),
        CHECK(entity_ref_type IS NULL OR entity_ref_type IN (
          'canon_character', 'continuation_entity', 'plotline', 'world'
        )),
        CHECK(
          (entity_ref_type IS NULL AND entity_ref_id IS NULL)
          OR
          (entity_ref_type IS NOT NULL AND entity_ref_id IS NOT NULL)
        ),
        CHECK(
          (generated_start IS NULL AND generated_end IS NULL) OR
          (generated_start >= 0 AND generated_end > generated_start)
        ),
        CHECK(resolution_status IN (
          'open', 'auto_repaired', 'accepted_by_user',
          'dismissed_by_user', 'obsolete'
        )),
        FOREIGN KEY(run_id) REFERENCES continuation_generation_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
        FOREIGN KEY(artifact_id) REFERENCES continuation_generation_artifacts(id) ON DELETE CASCADE
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_checks_run_artifact
        ON continuation_check_results(run_id, artifact_id, severity)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_state_proposals (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        chapter_id INTEGER NOT NULL,
        source_run_id TEXT,
        extraction_content_hash TEXT NOT NULL,
        chapter_revision_hash TEXT NOT NULL,
        proposal_type TEXT NOT NULL,
        subject_ref_type TEXT,
        subject_ref_id TEXT,
        payload_json TEXT NOT NULL,
        proposal_fingerprint TEXT NOT NULL,
        evidence_start INTEGER NOT NULL,
        evidence_end INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        decision_note TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(proposal_type IN (
          'character_state', 'relationship_change', 'plot_advance',
          'character_experience', 'knowledge_change', 'new_world_fact',
          'new_character', 'new_location', 'new_organization',
          'foreshadowing', 'other'
        )),
        CHECK(subject_ref_type IS NULL OR subject_ref_type IN (
          'canon_character', 'continuation_entity', 'plotline', 'world'
        )),
        CHECK(evidence_start >= 0 AND evidence_end > evidence_start),
        CHECK(status IN ('pending', 'accepted', 'rejected', 'superseded', 'invalidated')),
        UNIQUE(project_id, chapter_id, chapter_revision_hash, proposal_fingerprint),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
        FOREIGN KEY(source_run_id) REFERENCES continuation_generation_runs(id) ON DELETE SET NULL
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_proposals_project_status
        ON continuation_state_proposals(project_id, status, chapter_id)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_state_events (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL UNIQUE,
        project_id INTEGER NOT NULL,
        chapter_id INTEGER NOT NULL,
        chapter_position INTEGER NOT NULL,
        chapter_revision_hash TEXT NOT NULL,
        event_type TEXT NOT NULL,
        entity_refs_json TEXT NOT NULL DEFAULT '[]',
        payload_json TEXT NOT NULL,
        valid_from_position INTEGER NOT NULL,
        valid_to_position INTEGER,
        created_at TEXT NOT NULL,
        invalidated_at TEXT,
        invalidation_reason TEXT,
        CHECK(chapter_position >= 0),
        CHECK(valid_from_position >= 0),
        CHECK(valid_to_position IS NULL OR valid_to_position > valid_from_position),
        FOREIGN KEY(proposal_id) REFERENCES continuation_state_proposals(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_events_project_position
        ON continuation_state_events(project_id, valid_from_position, invalidated_at)`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_events_chapter
        ON continuation_state_events(chapter_id, invalidated_at)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_entities (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        entity_type TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        profile_json TEXT NOT NULL DEFAULT '{}',
        created_from_proposal_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(entity_type IN ('character', 'location', 'organization')),
        CHECK(status IN ('active', 'merged', 'invalidated')),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(created_from_proposal_id) REFERENCES continuation_state_proposals(id) ON DELETE CASCADE
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_entity_aliases (
        entity_id TEXT NOT NULL,
        normalized_alias TEXT NOT NULL,
        display_alias TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(entity_id, normalized_alias),
        FOREIGN KEY(entity_id) REFERENCES continuation_entities(id) ON DELETE CASCADE
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_state_sync_outbox (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        chapter_id INTEGER,
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK(operation IN ('extract_state', 'apply_event', 'rebuild_story_memory')),
        CHECK(state IN ('pending', 'running', 'completed', 'failed', 'interrupted', 'cancelled')),
        CHECK(attempt_count >= 0),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_outbox_state
        ON continuation_state_sync_outbox(state, created_at)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_style_profiles (
        project_id INTEGER PRIMARY KEY,
        source_id INTEGER NOT NULL,
        canon_snapshot_id TEXT NOT NULL,
        canon_revision INTEGER NOT NULL,
        narrative_person TEXT NOT NULL DEFAULT '',
        tense TEXT NOT NULL DEFAULT '',
        average_sentence_length REAL NOT NULL DEFAULT 0,
        average_paragraph_length REAL NOT NULL DEFAULT 0,
        dialogue_ratio REAL NOT NULL DEFAULT 0,
        description_ratio REAL NOT NULL DEFAULT 0,
        pacing_notes TEXT NOT NULL DEFAULT '',
        lexical_notes TEXT NOT NULL DEFAULT '',
        sample_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        review_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(canon_revision >= 1),
        CHECK(average_sentence_length >= 0),
        CHECK(average_paragraph_length >= 0),
        CHECK(dialogue_ratio BETWEEN 0 AND 1),
        CHECK(description_ratio BETWEEN 0 AND 1),
        CHECK(review_status IN ('pending', 'confirmed', 'ignored')),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
        FOREIGN KEY(canon_snapshot_id)
          REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE
      )`,
    },
  ];
}

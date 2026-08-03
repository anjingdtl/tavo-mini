/* eslint-env jest */

import { runMigrations, SCHEMA_VERSION } from '../src/services/migrations';
import { buildV4toV5Statements } from '../src/services/migrations/v4-to-v5';
import { createMigrationDb } from './migrationTestUtils';

describe('migration schema matrix', () => {
  // Upgrade every prior schema version that, once migrated, must contain the
  // full Phase 3 continuation table set. Starting versions 21+ already carry
  // those tables (created by an earlier 20→21 migration on their own upgrade
  // path), so the Phase 3 assertions below only hold for fromVersion <= 20.
  test.each(Array.from({ length: 29 }, (_, index) => index + 3))(
    'upgrades schema %i to the current schema',
    async fromVersion => {
      const mock = createMigrationDb({ schemaVersion: fromVersion });

      const result = await runMigrations(mock.database as any, fromVersion);

      expect(result).toMatchObject({
        fromVersion,
        toVersion: SCHEMA_VERSION,
      });
      expect(mock.settings.get('schema_version')).toBe(String(SCHEMA_VERSION));
      expect(mock.schemas.has('content_revisions')).toBe(true);
      expect(mock.schemas.has('generation_drafts')).toBe(true);
      expect(mock.schemas.has('project_note_config')).toBe(true);
      expect(mock.schemas.has('note_style_profiles')).toBe(true);
      expect(mock.schemas.has('character_collections')).toBe(true);
      expect(mock.schemas.has('local_llm_models')).toBe(false);
      // Schema 19 continuation tables must exist after every upgrade path.
      expect(mock.schemas.has('continuation_sources')).toBe(true);
      expect(mock.schemas.has('continuation_source_text_chunks')).toBe(true);
      expect(mock.schemas.has('continuation_source_chapters')).toBe(true);
      expect(mock.schemas.has('continuation_settings')).toBe(true);
      expect(mock.schemas.has('continuation_import_jobs')).toBe(true);
      // Schema 20 Canon tables (only if migration path includes 19→20).
      if (fromVersion <= 19) {
        expect(mock.schemas.has('continuation_canon_snapshots')).toBe(true);
        expect(mock.schemas.has('continuation_analysis_runs')).toBe(true);
        expect(mock.schemas.has('canon_world_rules')).toBe(true);
        expect(mock.schemas.has('canon_characters')).toBe(true);
        expect(mock.schemas.has('canon_timeline_events')).toBe(true);
      }
      // Schema 21 Phase 3 generation tables (always after upgrade to 21).
      expect(mock.schemas.has('continuation_generation_settings')).toBe(true);
      expect(mock.schemas.has('continuation_generation_runs')).toBe(true);
      expect(mock.schemas.has('continuation_state_proposals')).toBe(true);
      expect(mock.schemas.has('continuation_state_events')).toBe(true);
      expect(mock.schemas.has('continuation_state_sync_outbox')).toBe(true);
      // Schema 32 V4 persistence primitives are present on every path.
      expect(
        mock.schemas.get('continuation_generation_settings')?.has(
          'control_llm_config_id',
        ),
      ).toBe(true);
      expect(mock.schemas.has('continuation_generation_stage_results')).toBe(
        true,
      );
      expect(
        mock.schemas.get('continuation_generation_artifacts')?.has(
          'eligibility_status',
        ),
      ).toBe(true);
      expect(
        mock.schemas.get('continuation_generation_artifacts')?.has(
          'rejection_code',
        ),
      ).toBe(true);
      // Schema 26 versioned style profile table exists after every upgrade
      // path (the v25→v26 migration rebuilds the legacy table).
      expect(mock.schemas.has('continuation_style_profiles')).toBe(true);
      expect(
        mock.schemas.get('continuation_style_profiles')?.has('profile_hash'),
      ).toBe(true);
      expect(
        mock.schemas
          .get('continuation_settings')
          ?.has('active_style_profile_id'),
      ).toBe(true);
    },
  );

  test('creates the required historical indexes during a full upgrade', async () => {
    const mock = createMigrationDb({ schemaVersion: 3 });

    await runMigrations(mock.database as any, 3);

    const required = [
      'idx_content_revisions_target',
      'idx_generation_drafts_target',
      'idx_llm_usage_logs_month',
      'idx_local_llm_models_status',
      'idx_notes_collection_id',
      'idx_project_collection_settings_lookup',
      'idx_local_llm_models_last_used',
      'idx_llm_usage_logs_config',
      'idx_project_story_memory_status',
      'idx_project_story_memory_dirty',
      'idx_chapter_memory_patches_project_position',
      'idx_chapter_memory_patches_status',
      'idx_story_memory_snapshots_project_position',
      'idx_story_memory_batches_project_through',
      'idx_story_memory_batches_status',
      'idx_story_memory_batches_project_range',
      // Schema 19 continuation indexes (Spec §9).
      'idx_continuation_sources_one_ready',
      'idx_continuation_text_chunks_range',
      'idx_continuation_import_one_active',
      // Schema 20 Canon indexes.
      'idx_canon_snapshots_one_ready',
      'idx_canon_snapshots_source',
      'idx_analysis_runs_project_state',
      'idx_continuation_analysis_batches_state',
      'idx_canon_evidence_range',
      'idx_canon_evidence_links_owner',
      'idx_canon_world_rules_snapshot_review',
      'idx_canon_characters_snapshot_review',
      'idx_canon_timeline_events_snapshot_review',
      // Schema 21 Phase 3 indexes.
      'idx_continuation_runs_project_created',
      'idx_continuation_runs_state',
      'idx_continuation_artifacts_run_created',
      'idx_continuation_stage_results_run_state',
      'idx_continuation_checks_run_artifact',
      'idx_continuation_proposals_project_status',
      'idx_continuation_events_project_position',
      'idx_continuation_outbox_state',
      // Schema 26 versioned style profile indexes.
      'idx_continuation_style_profiles_project_state',
      'idx_continuation_style_profiles_fingerprint',
    ];
    for (const name of required) {
      expect(mock.indexes.has(name)).toBe(true);
    }
  });

  test('keeps data conversion inserts idempotent on rerun', async () => {
    const mock = createMigrationDb({ schemaVersion: 4 });
    const insert = buildV4toV5Statements()[0].sql;

    expect(insert).toMatch(/WHERE NOT EXISTS/i);
    await runMigrations(mock.database as any, 4);
    await runMigrations(mock.database as any, 4);

    expect(mock.getCollectionRows()).toBe(1);
  });

  test('upgrades schema 25 to 26 rebuilding the style profile table', async () => {
    // Schema 25 already carries the Phase 3 tables; only the 25→26 step runs.
    const mock = createMigrationDb({ schemaVersion: 25 });
    // This index belongs to the existing Canon run table. The repair must
    // leave it in place rather than rebuilding the parent and risking child
    // rows through immediate foreign keys.
    mock.indexes.add('idx_analysis_runs_project_state');

    const result = await runMigrations(mock.database as any, 25);

    expect(result).toMatchObject({ fromVersion: 25, toVersion: SCHEMA_VERSION });
    expect(mock.settings.get('schema_version')).toBe(String(SCHEMA_VERSION));
    // Versioned style profile table rebuilt with the new shape.
    expect(mock.schemas.has('continuation_style_profiles')).toBe(true);
    expect(
      mock.schemas.get('continuation_style_profiles')?.has('profile_hash'),
    ).toBe(true);
    expect(
      mock.schemas.get('continuation_style_profiles')?.has('canon_revision'),
    ).toBe(false);
    // settings gained the active style pointer.
    expect(
      mock.schemas.get('continuation_settings')?.has('active_style_profile_id'),
    ).toBe(true);
    // New indexes registered.
    expect(
      mock.indexes.has('idx_continuation_style_profiles_project_state'),
    ).toBe(true);
    expect(
      mock.indexes.has('idx_continuation_style_profiles_fingerprint'),
    ).toBe(true);
    // analysis_runs rebuilt with the widened stage CHECK, original index kept.
    expect(mock.schemas.has('continuation_analysis_runs')).toBe(true);
    expect(mock.indexes.has('idx_analysis_runs_project_state')).toBe(true);
  });
});

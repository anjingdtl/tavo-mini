/* eslint-env jest */

import { runMigrations, SCHEMA_VERSION } from '../src/services/migrations';
import { buildV4toV5Statements } from '../src/services/migrations/v4-to-v5';
import { createMigrationDb } from './migrationTestUtils';

describe('migration schema matrix', () => {
  test.each(Array.from({ length: 12 }, (_, index) => index + 3))(
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
      expect(mock.schemas.has('local_llm_models')).toBe(true);
    },
  );

  test('creates the required historical indexes during a full upgrade', async () => {
    const mock = createMigrationDb({ schemaVersion: 3 });

    await runMigrations(mock.database as any, 3);

    expect(mock.indexes).toEqual(
      new Set([
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
      ]),
    );
  });

  test('keeps data conversion inserts idempotent on rerun', async () => {
    const mock = createMigrationDb({ schemaVersion: 4 });
    const insert = buildV4toV5Statements()[0].sql;

    expect(insert).toMatch(/WHERE NOT EXISTS/i);
    await runMigrations(mock.database as any, 4);
    await runMigrations(mock.database as any, 4);

    expect(mock.getCollectionRows()).toBe(1);
  });
});

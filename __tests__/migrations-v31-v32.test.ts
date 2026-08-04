import {
  buildSchema32StageResultsCreateSql,
  buildSchema32RunCreateSql,
  buildV31toV32Statements,
} from '../src/services/migrations/v31-to-v32';
import { runMigrations, SCHEMA_VERSION } from '../src/services/migrations';
import { createMigrationDb } from './migrationTestUtils';

function seedSchema31ContinuationTables(mock: ReturnType<typeof createMigrationDb>) {
  mock.schemas.set(
    'continuation_generation_settings',
    new Set(['project_id', 'checker_enabled', 'max_repair_rounds']),
  );
  mock.schemas.set(
    'continuation_generation_runs',
    new Set([
      'id',
      'project_id',
      'chapter_id',
      'target_position',
      'source_id',
      'source_snapshot_json',
      'canon_snapshot_id',
      'canon_revision',
      'story_memory_fingerprint',
      'story_memory_through_position',
      'input_revision_hash',
      'user_instruction',
      'settings_snapshot_json',
      'context_snapshot_json',
      'context_trace_json',
      'token_usage_json',
      'state',
      'stage',
      'completion_reason',
      'adopted_revision_hash',
      'finalized_revision_hash',
      'error_code',
      'error_message',
      'created_at',
      'updated_at',
      'completed_at',
    ]),
  );
  mock.schemas.set(
    'continuation_generation_artifacts',
    new Set([
      'id',
      'run_id',
      'stage',
      'repair_round',
      'parent_artifact_id',
      'content',
      'content_hash',
      'created_at',
    ]),
  );
}

describe('Schema 31 → 32 continuation persistence', () => {
  it('widens the run stage contract and creates the V4 result table', () => {
    const runSql = buildSchema32RunCreateSql();
    const stageSql = buildSchema32StageResultsCreateSql();
    const migrationSql = buildV31toV32Statements()
      .map(statement => statement.sql)
      .join('\n');

    expect(SCHEMA_VERSION).toBe(35);
    expect(runSql).toContain("'auditing'");
    expect(runSql).toContain("'local_verify'");
    expect(runSql).toContain("'planner'");
    expect(stageSql).toContain("CHECK(request_count BETWEEN 0 AND 1)");
    expect(stageSql).toContain('UNIQUE(run_id, stage)');
    expect(stageSql).toContain('FOREIGN KEY(artifact_id)');
    expect(migrationSql).toContain('control_llm_config_id');
    expect(migrationSql).toContain('eligibility_status');
    expect(migrationSql).toContain('rejection_code');
    expect(migrationSql).not.toMatch(/api[_-]?key|authorization|prompt/i);
  });

  it('upgrades a Schema 31 continuation graph without rewriting old rows', async () => {
    const mock = createMigrationDb({ schemaVersion: 31 });
    seedSchema31ContinuationTables(mock);

    const result = await runMigrations(mock.database as any, 31);

    expect(result).toMatchObject({ fromVersion: 31, toVersion: SCHEMA_VERSION });
    expect(mock.settings.get('schema_version')).toBe(String(SCHEMA_VERSION));
    expect(
      mock.schemas.get('continuation_generation_settings')?.has(
        'control_llm_config_id',
      ),
    ).toBe(true);
    expect(
      mock.schemas.get('continuation_generation_artifacts')?.has(
        'eligibility_status',
      ),
    ).toBe(true);
    expect(mock.schemas.has('continuation_generation_stage_results')).toBe(
      true,
    );
    expect(mock.indexes.has('idx_continuation_stage_results_run_state')).toBe(
      true,
    );
  });

  it('rolls back the Schema 32 DDL and keeps Schema 31 when a statement fails', async () => {
    const mock = createMigrationDb({
      schemaVersion: 31,
      failWhenSqlIncludes: 'continuation_generation_stage_results',
    });
    seedSchema31ContinuationTables(mock);
    const oldRunColumns = new Set(mock.schemas.get('continuation_generation_runs'));

    await expect(runMigrations(mock.database as any, 31)).rejects.toThrow(
      'Injected migration failure',
    );

    expect(mock.settings.get('schema_version')).toBe('31');
    expect(mock.schemas.get('continuation_generation_runs')).toEqual(
      oldRunColumns,
    );
    expect(mock.schemas.has('continuation_generation_stage_results')).toBe(
      false,
    );
  });
});

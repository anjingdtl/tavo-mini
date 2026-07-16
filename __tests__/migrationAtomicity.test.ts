/* eslint-env jest */

import { runMigrations } from '../src/services/migrations';
import { createMigrationDb } from './migrationTestUtils';

describe('migration atomicity', () => {
  afterEach(() => {
    delete process.env.FAIL_MIGRATION_AT_STATEMENT;
  });

  test('test injection fails migration statement three and preserves version and columns', async () => {
    process.env.FAIL_MIGRATION_AT_STATEMENT = '3';
    const mock = createMigrationDb({ schemaVersion: 12 });
    const initialColumns = new Set(mock.schemas.get('local_llm_models'));

    await expect(runMigrations(mock.database as any, 12)).rejects.toThrow(
      'FAULT_INJECTION: migration statement 3',
    );

    expect(mock.settings.get('schema_version')).toBe('12');
    expect(mock.schemas.get('local_llm_models')).toEqual(initialColumns);
  });

  test('does not advance schema version when a migration statement fails', async () => {
    const mock = createMigrationDb({
      schemaVersion: 13,
      failWhenSqlIncludes: 'ALTER TABLE project_note_config',
    });
    const initialColumns = new Set(mock.schemas.get('project_note_config'));

    await expect(runMigrations(mock.database as any, 13)).rejects.toThrow(
      'Injected migration failure',
    );

    expect(mock.settings.get('schema_version')).toBe('13');
    expect(mock.schemas.get('project_note_config')).toEqual(initialColumns);
  });

  test('does not execute a later migration after an earlier one rejects', async () => {
    const mock = createMigrationDb({
      schemaVersion: 12,
      failWhenSqlIncludes: 'UPDATE local_llm_models SET status',
    });

    await expect(runMigrations(mock.database as any, 12)).rejects.toThrow();

    expect(mock.settings.get('schema_version')).toBe('12');
    expect(mock.schemas.get('local_llm_models')?.has('prompt_template')).toBe(false);
  });
});

import { migrateV28ToV29 } from '../src/services/migrations/v28-to-v29';
import { createMigrationDb } from './migrationTestUtils';

describe('schema 29 multi-file source migration', () => {
  it('adds every missing column for a normal schema-28 upgrade', async () => {
    const mock = createMigrationDb({ schemaVersion: 28 });
    await migrateV28ToV29(mock.database as any);

    expect(
      mock.schemas.get('continuation_sources')?.has('source_files_json'),
    ).toBe(true);
    expect(mock.schemas.get('continuation_sources')?.has('is_multi_file')).toBe(
      true,
    );
    expect(mock.schemas.get('continuation_sources')?.has('file_count')).toBe(
      true,
    );
    expect(
      mock.schemas.get('continuation_source_text_chunks')?.has('file_index'),
    ).toBe(true);
    expect(
      mock.schemas.get('continuation_source_chapters')?.has('file_index'),
    ).toBe(true);
  });

  it('skips a preview-written column instead of blocking startup', async () => {
    const mock = createMigrationDb({ schemaVersion: 28 });
    mock.schemas.get('continuation_sources')?.add('source_files_json');

    await migrateV28ToV29(mock.database as any);

    const duplicateColumnSql = mock.executed.filter(statement =>
      statement.includes('ADD COLUMN source_files_json'),
    );
    expect(duplicateColumnSql).toEqual([]);
    expect(mock.schemas.get('continuation_sources')?.has('is_multi_file')).toBe(
      true,
    );
  });

  it('is a no-op when every preview column is already present', async () => {
    const mock = createMigrationDb({ schemaVersion: 28 });
    mock.schemas.get('continuation_sources')?.add('source_files_json');
    mock.schemas.get('continuation_sources')?.add('is_multi_file');
    mock.schemas.get('continuation_sources')?.add('file_count');
    mock.schemas.get('continuation_source_text_chunks')?.add('file_index');
    mock.schemas.get('continuation_source_chapters')?.add('file_index');

    await migrateV28ToV29(mock.database as any);

    expect(
      mock.executed.filter(statement => statement.startsWith('ALTER TABLE')),
    ).toEqual([]);
  });
});

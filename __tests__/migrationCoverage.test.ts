/* eslint-env jest */

import { buildV3toV4Statements, migrateV3toV4 } from '../src/services/migrations/v3-to-v4';
import { buildV4toV5Statements, migrateV4toV5 } from '../src/services/migrations/v4-to-v5';
import { buildV5toV6Statements, migrateV5toV6 } from '../src/services/migrations/v5-to-v6';
import { buildV6toV7Statements, migrateV6toV7 } from '../src/services/migrations/v6-to-v7';
import { buildV7toV8Statements, migrateV7toV8 } from '../src/services/migrations/v7-to-v8';
import { buildV8toV9Statements, migrateV8toV9 } from '../src/services/migrations/v8-to-v9';
import { buildV9toV10Statements, migrateV9toV10 } from '../src/services/migrations/v9-to-v10';
import { buildV10toV11Statements, migrateV10toV11 } from '../src/services/migrations/v10-to-v11';
import { buildV13toV14Statements, migrateV13ToV14 } from '../src/services/migrations/v13-to-v14';
import {
  hasBreakingMigration,
  isIncompatibleUpgrade,
  runMigrations,
  SCHEMA_VERSION,
} from '../src/services/migrations';

function rows(values: Record<string, unknown>[]) {
  return {
    length: values.length,
    item: (index: number) => values[index],
  };
}

function fakeDatabase(columns: string[] = []) {
  const executeSql = jest.fn(async (sql: string) => {
    if (sql.startsWith('PRAGMA table_info')) {
      return [{ rows: rows(columns.map(name => ({ name }))) }];
    }
    return [{ rows: rows([]) }];
  });
  const transaction = jest.fn((scope: any, _onError: any, onSuccess: () => void) => {
    scope({ executeSql: jest.fn() });
    onSuccess();
  });
  return { executeSql, transaction } as any;
}

describe('migration statement coverage', () => {
  test('builds and applies schema 3 through 11 migrations', async () => {
    const database = fakeDatabase();
    expect(buildV3toV4Statements()).toHaveLength(4);
    expect(buildV4toV5Statements()).toHaveLength(2);
    expect(buildV5toV6Statements()).toHaveLength(2);
    expect(buildV6toV7Statements()).toHaveLength(2);
    expect(buildV8toV9Statements()).toHaveLength(2);
    expect(await buildV7toV8Statements(database)).toHaveLength(3);
    expect(await buildV9toV10Statements(database)).toHaveLength(3);
    expect(await buildV10toV11Statements(database)).toHaveLength(4);
    await migrateV3toV4(database);
    await migrateV4toV5(database);
    await migrateV5toV6(database);
    await migrateV6toV7(database);
    await migrateV7toV8(database);
    await migrateV8toV9(database);
    await migrateV9toV10(database);
    await migrateV10toV11(database);
  });

  test('covers existing-column branches in conditional migrations', async () => {
    const database = fakeDatabase(['model_name', 'project_id', 'llm_config_id', 'llm_config_name', 'collection_id']);
    expect(await buildV7toV8Statements(database)).toHaveLength(1);
    expect(await buildV9toV10Statements(database)).toHaveLength(1);
    expect(await buildV10toV11Statements(database)).toHaveLength(3);
    const current = fakeDatabase(['retrieval_fragment_chars']);
    const old = fakeDatabase([]);
    expect(await buildV13toV14Statements(current)).toEqual([]);
    expect(await buildV13toV14Statements(old)).toHaveLength(1);
    await migrateV13ToV14(current);
    await migrateV13ToV14(old);
  });

  test('does not insert a project-zero character collection when one already exists', async () => {
    const statements = await buildV10toV11Statements(fakeDatabase());
    const collectionInsert = statements.find(statement =>
      statement.sql.includes('INSERT INTO character_collections'),
    );

    expect(collectionInsert?.sql).toContain(
      'COALESCE((SELECT SUM(estimated_tokens) FROM characters), 0)',
    );
    expect(collectionInsert?.sql).not.toMatch(/FROM characters\s+WHERE NOT EXISTS/i);
  });

  test('runs the migration engine with and without the breaking backup path', async () => {
    const database = fakeDatabase();
    const onBackup = jest.fn(async () => '/backup/pre-v3.json');
    const fromBreaking = await runMigrations(database, 2, onBackup);
    expect(fromBreaking).toMatchObject({
      fromVersion: 2,
      toVersion: SCHEMA_VERSION,
      hadBreaking: true,
      backupPath: '/backup/pre-v3.json',
    });
    expect(onBackup).toHaveBeenCalledTimes(1);

    const fromSupported = await runMigrations(database, 3);
    expect(fromSupported.hadBreaking).toBe(false);
    expect(fromSupported.backupPath).toBeNull();
    expect(hasBreakingMigration(2)).toBe(true);
    expect(hasBreakingMigration(3)).toBe(false);
    expect(isIncompatibleUpgrade(2)).toBe(true);
    expect(isIncompatibleUpgrade(3)).toBe(false);
  });
});

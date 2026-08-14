/** Schema 51 → 52: Writer Style semantic / compatibility asset fields. */
import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';
import { executeTransaction } from '../database/transaction';
import { tableColumns } from './helpers';

const PROJECT_COLUMNS = [
  {
    name: 'active_writer_style_id',
    ddl: 'ALTER TABLE projects ADD COLUMN active_writer_style_id INTEGER',
  },
] as const;

const PRESET_COLUMNS = [
  {
    name: 'semantic_json',
    ddl: 'ALTER TABLE presets ADD COLUMN semantic_json TEXT',
  },
  {
    name: 'compatibility_json',
    ddl: 'ALTER TABLE presets ADD COLUMN compatibility_json TEXT',
  },
  {
    name: 'source_format',
    ddl: "ALTER TABLE presets ADD COLUMN source_format TEXT NOT NULL DEFAULT 'legacy_shinewriter'",
  },
  {
    name: 'source_fingerprint',
    ddl: "ALTER TABLE presets ADD COLUMN source_fingerprint TEXT NOT NULL DEFAULT ''",
  },
  {
    name: 'compatibility_fingerprint',
    ddl: 'ALTER TABLE presets ADD COLUMN compatibility_fingerprint TEXT',
  },
  {
    name: 'asset_contract_version',
    ddl: 'ALTER TABLE presets ADD COLUMN asset_contract_version INTEGER NOT NULL DEFAULT 1',
  },
] as const;

export function buildSchema52CreateSqls(): string[] {
  return [...PROJECT_COLUMNS, ...PRESET_COLUMNS].map(column => column.ddl);
}

export async function migrateV51ToV52(db: SQLite.SQLiteDatabase): Promise<void> {
  const projectColumns = await tableColumns(db, 'projects');
  const presetColumns = await tableColumns(db, 'presets');
  const columns = [
    ...(projectColumns.size > 0
      ? PROJECT_COLUMNS.filter(column => !projectColumns.has(column.name))
      : []),
    ...(presetColumns.size > 0
      ? PRESET_COLUMNS.filter(column => !presetColumns.has(column.name))
      : []),
  ];
  const statements: SqlStatement[] = columns.map(column => ({ sql: column.ddl }));
  if (statements.length > 0) {
    await executeTransaction(db, statements, { faultDomain: 'migration' });
  }
  if (presetColumns.size > 0) {
    await executeTransaction(
      db,
      [
        {
          sql: "UPDATE presets SET source_format = 'legacy_shinewriter' WHERE source_format IS NULL OR source_format = ''",
        },
      ],
      { faultDomain: 'migration' },
    );
  }
}

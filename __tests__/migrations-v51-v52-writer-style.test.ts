import { createEmptyInMemoryDb } from './helpers/canonInMemoryDb';
import {
  migrateV51ToV52,
  buildSchema52CreateSqls,
} from '../src/services/migrations/v51-to-v52';
import { runMigrations, SCHEMA_VERSION } from '../src/services/migrations';

async function columns(db: any, table: string): Promise<Set<string>> {
  const [result] = await db.executeSql(`PRAGMA table_info(${table})`);
  return new Set(result.rows.raw().map((row: any) => row.name));
}

describe('Schema 51 → 52 Writer Style asset contract', () => {
  test('adds the project binding and asset columns without changing legacy rows', async () => {
    const db = await createEmptyInMemoryDb();
    try {
      await db.executeSql('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      await db.executeSql('CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT)');
      await db.executeSql(`CREATE TABLE presets (
        id INTEGER PRIMARY KEY,
        name TEXT,
        system_prompt TEXT,
        writing_style TEXT,
        extra_instructions TEXT,
        temperature REAL,
        top_p REAL,
        max_tokens INTEGER
      )`);
      await db.executeSql("INSERT INTO settings (key, value) VALUES ('schema_version', '51')");
      await db.executeSql("INSERT INTO projects (id, name) VALUES (1, 'legacy')");
      await db.executeSql(
        "INSERT INTO presets (id, name, system_prompt, writing_style, extra_instructions, temperature, top_p, max_tokens) VALUES (7, '旧预设', 'system', 'style', 'extra', 0.8, 0.9, 4000)",
      );

      await migrateV51ToV52(db as any);
      await migrateV51ToV52(db as any);

      const projectColumns = await columns(db, 'projects');
      const presetColumns = await columns(db, 'presets');
      expect(projectColumns.has('active_writer_style_id')).toBe(true);
      for (const name of [
        'semantic_json',
        'compatibility_json',
        'source_format',
        'source_fingerprint',
        'compatibility_fingerprint',
        'asset_contract_version',
      ]) {
        expect(presetColumns.has(name)).toBe(true);
      }
      const [row] = await db.executeSql(
        'SELECT name, system_prompt, writing_style, extra_instructions, source_format FROM presets WHERE id = 7',
      );
      expect(row.rows.item(0)).toEqual({
        name: '旧预设',
        system_prompt: 'system',
        writing_style: 'style',
        extra_instructions: 'extra',
        source_format: 'legacy_shinewriter',
      });
    } finally {
      db.close();
    }
  });

  test('latest-to-latest is a no-op and fresh schema exposes the contract', async () => {
    const db = await createEmptyInMemoryDb();
    try {
      await db.executeSql('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      await db.executeSql('CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, active_writer_style_id INTEGER)');
      await db.executeSql(`CREATE TABLE presets (
        id INTEGER PRIMARY KEY,
        name TEXT,
        system_prompt TEXT,
        writing_style TEXT,
        extra_instructions TEXT,
        temperature REAL,
        top_p REAL,
        max_tokens INTEGER,
        semantic_json TEXT,
        compatibility_json TEXT,
        source_format TEXT,
        source_fingerprint TEXT,
        compatibility_fingerprint TEXT,
        asset_contract_version INTEGER
      )`);
      const before = (await columns(db, 'presets')).size;
      const result = await runMigrations(db as any, SCHEMA_VERSION);
      expect(result.migrationsRun).toBe(0);
      expect((await columns(db, 'presets')).size).toBe(before);
      expect(buildSchema52CreateSqls()).toHaveLength(7);
    } finally {
      db.close();
    }
  });
});

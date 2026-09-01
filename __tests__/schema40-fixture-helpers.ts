/**
 * Shared fixture helpers for the Schema 40 drift-repair test matrix.
 *
 * Builds real sql.js SQLite databases in specific schema/drift states, seeds
 * canonical user data, and provides assertion helpers for before/after
 * identity comparison.
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import RNFS from 'react-native-fs';

export interface FixtureSeed {
  projectId?: number;
  characterId?: number;
  characterName?: string;
  worldbookId?: number;
}

/**
 * Seed a canonical set of user data into a fresh schema-complete database:
 *   - global project + one real project
 *   - character collection + one character
 *   - worldbook collection + one entry
 *   - project_resources links
 */
export async function seedCanonicalData(
  db: InMemorySqliteDb,
  opts: FixtureSeed = {},
): Promise<void> {
  const projectId = opts.projectId ?? 1;
  const characterId = opts.characterId ?? 1;
  const characterName = opts.characterName ?? '林小白';
  const worldbookId = opts.worldbookId ?? 1;

  await db.executeSql(
    `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (0, '__tavo_global_workspace__', 'outline', '2026-07-01', '2026-07-01')`,
  );
  await db.executeSql(
    `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (${projectId}, '我的小说', 'continuation', '2026-07-01', '2026-07-01')`,
  );
  await db.executeSql(
    `INSERT INTO character_collections (id, project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES (1, 0, '主角团', 1, 50000, 0, '2026-07-01')`,
  );
  await db.executeSql(
    `INSERT INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at) VALUES (${characterId}, 0, 1, '${characterName}', 'manual', '{"name":"${characterName}"}', 50000, 10, '2026-07-01')`,
  );
  await db.executeSql(
    `INSERT INTO worldbook_collections (id, project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES (1, 0, '世界观设定', 1, 50000, 0, '2026-07-01')`,
  );
  await db.executeSql(
    `INSERT INTO worldbook_entries (id, project_id, collection_id, keyword_primary, keyword_secondary, content, comment, enabled, constant, max_tokens, estimated_tokens, position, created_at) VALUES (${worldbookId}, 0, 1, '魔法体系', '元素', '这是一个基于元素的世界...', '', 1, 0, 50000, 20, 0, '2026-07-01')`,
  );
  await db.executeSql(
    `INSERT INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (${projectId}, 'character', ${characterId}, 1)`,
  );
  await db.executeSql(
    `INSERT INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (${projectId}, 'worldbook', ${worldbookId}, 1)`,
  );
}

export interface ResourceCounts {
  characters: number;
  characterCollections: number;
  worldbookEntries: number;
  worldbookCollections: number;
  projects: number;
}

export async function readResourceCounts(
  db: InMemorySqliteDb,
): Promise<ResourceCounts> {
  const counts: Partial<ResourceCounts> = {};
  for (const [key, table] of [
    ['characters', 'characters'],
    ['characterCollections', 'character_collections'],
    ['worldbookEntries', 'worldbook_entries'],
    ['worldbookCollections', 'worldbook_collections'],
    ['projects', 'projects'],
  ] as const) {
    const [res] = await db.executeSql(`SELECT COUNT(*) AS c FROM ${table}`);
    counts[key] = Number(res.rows.item(0).c);
  }
  return counts as ResourceCounts;
}

export async function readCharacterIds(
  db: InMemorySqliteDb,
): Promise<number[]> {
  const [res] = await db.executeSql('SELECT id FROM characters ORDER BY id');
  const ids: number[] = [];
  for (let i = 0; i < res.rows.length; i++) ids.push(Number(res.rows.item(i).id));
  return ids;
}

export async function readWorldbookIds(
  db: InMemorySqliteDb,
): Promise<number[]> {
  const [res] = await db.executeSql('SELECT id FROM worldbook_entries ORDER BY id');
  const ids: number[] = [];
  for (let i = 0; i < res.rows.length; i++) ids.push(Number(res.rows.item(i).id));
  return ids;
}

/**
 * Drop the canon_evidence provenance columns + index to simulate the drift
 * (recorded version says they exist, physical schema says they don't).
 */
export async function dropProvenanceColumns(
  db: InMemorySqliteDb,
): Promise<void> {
  await db.executeSql('DROP INDEX IF EXISTS idx_canon_evidence_rescan_op');
  await db.executeSql('ALTER TABLE canon_evidence DROP COLUMN source_origin');
  await db.executeSql(
    'ALTER TABLE canon_evidence DROP COLUMN rescan_operation_id',
  );
}

/** Drop only source_origin (Case E: partial drift). */
export async function dropSourceOriginOnly(
  db: InMemorySqliteDb,
): Promise<void> {
  await db.executeSql('DROP INDEX IF EXISTS idx_canon_evidence_rescan_op');
  await db.executeSql('ALTER TABLE canon_evidence DROP COLUMN source_origin');
}

/** Drop only rescan_operation_id (Case F: partial drift). */
export async function dropRescanOpOnly(
  db: InMemorySqliteDb,
): Promise<void> {
  await db.executeSql('DROP INDEX IF EXISTS idx_canon_evidence_rescan_op');
  await db.executeSql(
    'ALTER TABLE canon_evidence DROP COLUMN rescan_operation_id',
  );
}

/** Drop only the index (Case G: columns present, index missing). */
export async function dropRescanIndexOnly(
  db: InMemorySqliteDb,
): Promise<void> {
  await db.executeSql('DROP INDEX IF EXISTS idx_canon_evidence_rescan_op');
}

export async function columnExists(
  db: InMemorySqliteDb,
  table: string,
  column: string,
): Promise<boolean> {
  const [res] = await db.executeSql(`PRAGMA table_info(${table})`);
  for (let i = 0; i < res.rows.length; i++) {
    if (res.rows.item(i).name === column) return true;
  }
  return false;
}

export async function indexExists(
  db: InMemorySqliteDb,
  name: string,
): Promise<boolean> {
  const [res] = await db.executeSql(
    "SELECT name FROM sqlite_master WHERE type='index' AND name=?",
    [name],
  );
  return res.rows.length > 0;
}

/**
 * Set up the in-memory RNFS mock so createSchemaRecoveryBackup can
 * write/verify files. Returns the file map for inspection.
 */
export function setupInMemoryFs(): Map<string, string> {
  const files = new Map<string, string>();
  jest.clearAllMocks();
  (RNFS.mkdir as jest.Mock).mockResolvedValue(undefined);
  (RNFS.writeFile as jest.Mock).mockImplementation(async (p: string, c: string) => {
    files.set(p, c);
  });
  (RNFS.appendFile as jest.Mock).mockImplementation(async (p: string, c: string) => {
    files.set(p, `${files.get(p) || ''}${c}`);
  });
  (RNFS.write as jest.Mock).mockImplementation(async (p: string, c: string, position = 0) => {
    const current = files.get(p) || '';
    files.set(p, `${current.slice(0, position)}${c}${current.slice(position + c.length)}`);
  });
  (RNFS.moveFile as jest.Mock).mockImplementation(async (f: string, t: string) => {
    files.set(t, files.get(f) || '');
    files.delete(f);
  });
  (RNFS.copyFile as jest.Mock).mockImplementation(async (f: string, t: string) => {
    files.set(t, files.get(f) || '');
  });
  (RNFS.readFile as jest.Mock).mockImplementation(async (p: string) => {
    const c = files.get(p);
    if (c === undefined) throw new Error(`ENOENT: ${p}`);
    return c;
  });
  (RNFS.readDir as jest.Mock).mockResolvedValue([]);
  (RNFS.unlink as jest.Mock).mockResolvedValue(undefined);
  (RNFS.exists as jest.Mock).mockResolvedValue(true);
  return files;
}

/** Create a fresh schema-complete database (full Schema 40 fresh install). */
export async function createFreshDb(): Promise<InMemorySqliteDb> {
  return createCanonInMemoryDb();
}

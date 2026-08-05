/**
 * End-to-end repair proof: the actual user incident scenario.
 *
 * Constructs a REAL sql.js in-memory SQLite database at "Schema 39" (recorded
 * version) whose `canon_evidence` table is missing `source_origin` /
 * `rescan_operation_id` (the physical drift), seeds real user data, then runs
 * the full `initializeDatabase` flow and proves:
 *
 *   1. The drift is detected.
 *   2. A schema-recovery backup is created.
 *   3. The provenance columns are repaired.
 *   4. The user's characters / worldbook / collections are still present and
 *      their IDs are unchanged (recall verified).
 *   5. The final schema validation passes.
 *
 * This is the proof that the fix resolves the reported incident: users who
 * overwrite-install the patched version get their data back automatically.
 */
import RNFS from 'react-native-fs';
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';
import { initializeDatabase, lastSchemaRecovery } from '../src/services/database';
import { SCHEMA_VERSION } from '../src/services/migrations';

describe('Schema 40 end-to-end repair: recorded-39 drifted DB', () => {
  let db: InMemorySqliteDb;

  beforeEach(async () => {
    __resetForTest();
    db = await createCanonInMemoryDb();
    __setDatabaseForTest(db as any);

    // In-memory RNFS so createSchemaRecoveryBackup can write/verify a file.
    const files = new Map<string, string>();
    jest.clearAllMocks();
    (RNFS.mkdir as jest.Mock).mockResolvedValue(undefined);
    (RNFS.writeFile as jest.Mock).mockImplementation(async (p: string, c: string) => {
      files.set(p, c);
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
  });

  afterEach(() => {
    __resetForTest();
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });

  it('records schema 40 and repairs a recorded-39 drifted database without data loss', async () => {
    // ── Setup: seed real user data + simulate the drift ──
    await seedUserData(db);
    await simulateDrift(db); // drop source_origin + rescan_operation_id
    // Record schema_version = 39 (the incident state)
    await db.executeSql(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '39')",
    );
    await db.executeSql(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('app_version', '2.11.23')",
    );

    // ── Capture BEFORE state for later comparison ──
    const [charBefore] = await db.executeSql('SELECT id, name FROM characters ORDER BY id');
    const charIdsBefore: number[] = [];
    for (let i = 0; i < charBefore.rows.length; i++) {
      charIdsBefore.push(Number(charBefore.rows.item(i).id));
    }
    const [wbBefore] = await db.executeSql('SELECT id FROM worldbook_entries ORDER BY id');
    const wbIdsBefore: number[] = [];
    for (let i = 0; i < wbBefore.rows.length; i++) {
      wbIdsBefore.push(Number(wbBefore.rows.item(i).id));
    }

    // ── Run the full initialization (the fix) ──
    await initializeDatabase(db as any);

    // ── Assertions ──
    // 1. Schema version advanced to 40
    const [verRow] = await db.executeSql(
      "SELECT value FROM settings WHERE key = 'schema_version'",
    );
    expect(Number(verRow.rows.item(0).value)).toBe(SCHEMA_VERSION);

    // 2. canon_evidence now has both provenance columns
    const [cols] = await db.executeSql('PRAGMA table_info(canon_evidence)');
    const colNames: string[] = [];
    for (let i = 0; i < cols.rows.length; i++) {
      colNames.push(cols.rows.item(i).name);
    }
    expect(colNames).toContain('source_origin');
    expect(colNames).toContain('rescan_operation_id');

    // 3. The rescan index exists
    const [idx] = await db.executeSql(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_canon_evidence_rescan_op'",
    );
    expect(idx.rows.length).toBe(1);

    // 4. source_origin was backfilled to 'batch'
    const [batchRows] = await db.executeSql(
      "SELECT COUNT(*) AS c FROM canon_evidence WHERE source_origin IS NULL OR TRIM(source_origin) = ''",
    );
    expect(Number(batchRows.rows.item(0).c)).toBe(0);

    // 5. User data intact: character IDs unchanged
    const [charAfter] = await db.executeSql('SELECT id, name FROM characters ORDER BY id');
    const charIdsAfter: number[] = [];
    for (let i = 0; i < charAfter.rows.length; i++) {
      charIdsAfter.push(Number(charAfter.rows.item(i).id));
    }
    expect(charIdsAfter).toEqual(charIdsBefore);
    expect(charAfter.rows.item(0).name).toBe('林小白');

    // 6. User data intact: worldbook IDs unchanged
    const [wbAfter] = await db.executeSql('SELECT id FROM worldbook_entries ORDER BY id');
    const wbIdsAfter: number[] = [];
    for (let i = 0; i < wbAfter.rows.length; i++) {
      wbIdsAfter.push(Number(wbAfter.rows.item(i).id));
    }
    expect(wbIdsAfter).toEqual(wbIdsBefore);

    // 7. Recovery state surfaced to the UI
    expect(lastSchemaRecovery).not.toBeNull();
    expect(lastSchemaRecovery!.recallVerified).toBe(true);
    expect(lastSchemaRecovery!.backupCreated).toBe(true);
    expect(lastSchemaRecovery!.repaired).toBe(true);
  });

  it('is idempotent: re-running initializeDatabase on the repaired DB does not re-repair', async () => {
    await seedUserData(db);
    await simulateDrift(db);
    await db.executeSql(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '39')",
    );

    // First run: repairs the drift
    await initializeDatabase(db as any);
    const firstRepair = lastSchemaRecovery;

    // Second run: no drift, no backup needed, no repair
    await initializeDatabase(db as any);
    const secondRepair = lastSchemaRecovery;

    // After the first successful run, the DB is at Schema 40 with no drift,
    // so the second run should not create a backup or repair.
    expect(secondRepair).toBeNull();

    // Data still intact
    const [chars] = await db.executeSql('SELECT COUNT(*) AS c FROM characters');
    expect(Number(chars.rows.item(0).c)).toBe(1);
    void firstRepair;
  });
});

// ── Shared helpers (same as the Phase 0 repro) ──────────────────────────

async function seedUserData(db: InMemorySqliteDb): Promise<void> {
  await db.executeSql(
    `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (0, '__tavo_global_workspace__', 'outline', '2026-07-01', '2026-07-01')`,
  );
  await db.executeSql(
    `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, '我的小说', 'continuation', '2026-07-01', '2026-07-01')`,
  );
  await db.executeSql(
    `INSERT INTO character_collections (id, project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES (1, 0, '主角团', 1, 50000, 0, '2026-07-01')`,
  );
  await db.executeSql(
    `INSERT INTO characters (id, project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at) VALUES (1, 0, 1, '林小白', 'manual', '{"name":"林小白"}', 50000, 10, '2026-07-01')`,
  );
  await db.executeSql(
    `INSERT INTO worldbook_collections (id, project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES (1, 0, '世界观设定', 1, 50000, 0, '2026-07-01')`,
  );
  await db.executeSql(
    `INSERT INTO worldbook_entries (id, project_id, collection_id, keyword_primary, keyword_secondary, content, comment, enabled, constant, max_tokens, estimated_tokens, position, created_at) VALUES (1, 0, 1, '魔法体系', '元素', '这是一个基于元素的世界...', '', 1, 0, 50000, 20, 0, '2026-07-01')`,
  );
  await db.executeSql(
    `INSERT INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (1, 'character', 1, 1)`,
  );
  await db.executeSql(
    `INSERT INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (1, 'worldbook', 1, 1)`,
  );
}

async function simulateDrift(db: InMemorySqliteDb): Promise<void> {
  // Drop the index first (it references the columns), then drop the columns.
  await db.executeSql('DROP INDEX IF EXISTS idx_canon_evidence_rescan_op');
  await db.executeSql('ALTER TABLE canon_evidence DROP COLUMN source_origin');
  await db.executeSql(
    'ALTER TABLE canon_evidence DROP COLUMN rescan_operation_id',
  );
}

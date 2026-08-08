/**
 * Schema 42 → 43: legacy smart story-memory policy interval unification.
 *
 * One-time data migration: every pre-upgrade `mode = 'smart'` policy row gets
 * `interval_chapters = 10` (the new default smart cadence). `fixed` /
 * `every_chapter` / `manual` are explicit user strategies and must stay
 * untouched; projects without a policy row must NOT get one created.
 *
 * Matrix (real sql.js SQLite, real `initializeDatabase` upgrade chain):
 *   M1 smart/3  → smart/10
 *   M2 smart/5  → smart/10
 *   M3 smart/10 → smart/10
 *   M4 fixed/3  → fixed/3
 *   M5 fixed/7  → fixed/7
 *   M6 manual/3 → manual/3
 *   M7 every_chapter/2 → every_chapter/2
 *   M8 no policy → no policy created
 *   M9 re-run is idempotent
 *   M10 after migration, user-set smart/5 survives reloads (no runtime clamp)
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import { setupInMemoryFs } from './schema40-fixture-helpers';
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';
import { initializeDatabase } from '../src/services/database';
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildV42toV43Statements,
  migrateV42ToV43,
} from '../src/services/migrations/v42-to-v43';
import {
  ensureStoryMemoryPolicy,
  getStoryMemoryPolicy,
  upsertStoryMemoryPolicy,
} from '../src/data/repositories/storyMemoryRepository';
import type { StoryMemoryPolicy } from '../src/services/storyMemory/storyMemoryTypes';

const T = '2026-08-01T00:00:00.000Z';

describe('Schema 42 → 43 smart policy interval unification', () => {
  it('reports SCHEMA_VERSION >= 43', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(43);
  });

  it('builds a single narrow UPDATE for smart rows only', () => {
    const stmts = buildV42toV43Statements();
    expect(stmts.length).toBe(1);
    const sql = stmts[0].sql;
    expect(sql).toContain('UPDATE project_story_memory_policy');
    expect(sql).toContain('interval_chapters = 10');
    expect(sql).toContain("WHERE mode = 'smart'");
    // No schema change, no inserts, no other modes touched.
    expect(sql).not.toContain('ALTER TABLE');
    expect(sql).not.toContain('INSERT');
    expect(sql).not.toContain('CREATE');
    expect(sql).not.toMatch(/fixed|every_chapter|manual/);
  });
});

describe('Schema 42 → 43 upgrade chain (real sql.js)', () => {
  let db: InMemorySqliteDb;

  beforeEach(async () => {
    __resetForTest();
    db = await createCanonInMemoryDb();
    __setDatabaseForTest(db as any);
    setupInMemoryFs();
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (0, '__tavo_global_workspace__', 'outline', ?, ?)`,
      [T, T],
    );
    // Record the pre-upgrade state: schema 42 + an older app version.
    await db.executeSql(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '42')",
    );
    await db.executeSql(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('app_version', '2.11.36')",
    );
  });

  afterEach(() => {
    __resetForTest();
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });

  async function seedProject(id: number, name: string): Promise<void> {
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (?, ?, 'novel', ?, ?)`,
      [id, name, T, T],
    );
  }

  async function seedPolicy(
    projectId: number,
    mode: string,
    interval: number,
  ): Promise<void> {
    await db.executeSql(
      `INSERT INTO project_story_memory_policy
        (project_id, mode, interval_chapters, pending_token_soft_limit,
         update_on_key_chapter, updated_at)
       VALUES (?, ?, ?, 2400, 1, ?)`,
      [projectId, mode, interval, T],
    );
  }

  async function readPolicy(projectId: number) {
    const [res] = await db.executeSql(
      `SELECT mode, interval_chapters FROM project_story_memory_policy WHERE project_id = ?`,
      [projectId],
    );
    if (res.rows.length === 0) return null;
    return {
      mode: res.rows.item(0).mode as string,
      interval: Number(res.rows.item(0).interval_chapters),
    };
  }

  async function upgrade(): Promise<void> {
    await initializeDatabase(db as any);
  }

  // M1: legacy smart/3 → smart/10
  it('M1 smart/3 becomes smart/10', async () => {
    await seedProject(1, '小说A');
    await seedPolicy(1, 'smart', 3);
    await upgrade();
    expect(await readPolicy(1)).toEqual({ mode: 'smart', interval: 10 });
    expect(
      Number((await db.executeSql("SELECT value FROM settings WHERE key = 'schema_version'"))[0].rows.item(0).value),
    ).toBe(SCHEMA_VERSION);
  });

  // M2: legacy smart/5 → smart/10
  it('M2 smart/5 becomes smart/10', async () => {
    await seedProject(1, '小说A');
    await seedPolicy(1, 'smart', 5);
    await upgrade();
    expect(await readPolicy(1)).toEqual({ mode: 'smart', interval: 10 });
  });

  // M3: smart/10 stays smart/10
  it('M3 smart/10 stays smart/10', async () => {
    await seedProject(1, '小说A');
    await seedPolicy(1, 'smart', 10);
    await upgrade();
    expect(await readPolicy(1)).toEqual({ mode: 'smart', interval: 10 });
  });

  // M4: fixed/3 untouched
  it('M4 fixed/3 stays fixed/3', async () => {
    await seedProject(1, '小说A');
    await seedPolicy(1, 'fixed', 3);
    await upgrade();
    expect(await readPolicy(1)).toEqual({ mode: 'fixed', interval: 3 });
  });

  // M5: fixed/7 untouched
  it('M5 fixed/7 stays fixed/7', async () => {
    await seedProject(1, '小说A');
    await seedPolicy(1, 'fixed', 7);
    await upgrade();
    expect(await readPolicy(1)).toEqual({ mode: 'fixed', interval: 7 });
  });

  // M6: manual untouched
  it('M6 manual stays unchanged', async () => {
    await seedProject(1, '小说A');
    await seedPolicy(1, 'manual', 3);
    await upgrade();
    expect(await readPolicy(1)).toEqual({ mode: 'manual', interval: 3 });
  });

  // M7: every_chapter untouched
  it('M7 every_chapter stays unchanged', async () => {
    await seedProject(1, '小说A');
    await seedPolicy(1, 'every_chapter', 2);
    await upgrade();
    expect(await readPolicy(1)).toEqual({
      mode: 'every_chapter',
      interval: 2,
    });
  });

  // M8: project without a policy row gets none created
  it('M8 projects without a policy do not get one created', async () => {
    await seedProject(1, '小说A');
    await upgrade();
    const [res] = await db.executeSql(
      'SELECT COUNT(*) AS c FROM project_story_memory_policy',
    );
    expect(Number(res.rows.item(0).c)).toBe(0);
  });

  // M9: re-running the migration is idempotent
  it('M9 migration is idempotent when re-run', async () => {
    await seedProject(1, '小说A');
    await seedProject(2, '小说B');
    await seedPolicy(1, 'smart', 3);
    await seedPolicy(2, 'fixed', 7);
    await migrateV42ToV43(db as any);
    expect(await readPolicy(1)).toEqual({ mode: 'smart', interval: 10 });
    expect(await readPolicy(2)).toEqual({ mode: 'fixed', interval: 7 });
    // Second run: no further changes.
    await migrateV42ToV43(db as any);
    expect(await readPolicy(1)).toEqual({ mode: 'smart', interval: 10 });
    expect(await readPolicy(2)).toEqual({ mode: 'fixed', interval: 7 });
  });

  // M10: after migration, the user can re-set smart interval and it sticks.
  it('M10 user re-setting smart interval after upgrade is respected', async () => {
    await seedProject(1, '小说A');
    await seedPolicy(1, 'smart', 3);
    await upgrade();
    expect(await readPolicy(1)).toEqual({ mode: 'smart', interval: 10 });

    const policy: StoryMemoryPolicy = {
      projectId: 1,
      mode: 'smart',
      intervalChapters: 5,
      pendingTokenSoftLimit: 12000,
      updateOnKeyChapter: true,
      updatedAt: T,
    };
    const saved = await upsertStoryMemoryPolicy(policy);
    expect(saved.intervalChapters).toBe(5);

    // Reload path (fresh read through the repository) must still see 5.
    const reloaded = await getStoryMemoryPolicy(1);
    expect(reloaded?.intervalChapters).toBe(5);
    expect(reloaded?.mode).toBe('smart');

    // ensureStoryMemoryPolicy must NOT re-impose 10 on an existing policy.
    const ensured = await ensureStoryMemoryPolicy(1);
    expect(ensured.intervalChapters).toBe(5);
  });
});

describe('Schema 42 → 43 data safety (real sql.js)', () => {
  let db: InMemorySqliteDb;

  beforeEach(async () => {
    __resetForTest();
    db = await createCanonInMemoryDb();
    __setDatabaseForTest(db as any);
    setupInMemoryFs();
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (0, '__tavo_global_workspace__', 'outline', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, '小说A', 'novel', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      `INSERT INTO chapters (id, project_id, position, title, content, status, created_at, updated_at)
       VALUES (1, 1, 1, '第一章', '第一章正文内容', 'finalized', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      `INSERT INTO chapters (id, project_id, position, title, content, status, created_at, updated_at)
       VALUES (2, 1, 2, '第二章', '第二章正文内容', 'finalized', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      `INSERT INTO project_story_memory
        (project_id, schema_version, through_chapter_id, through_chapter_position,
         memory_json, estimated_tokens, state_fingerprint, status, source, updated_at)
       VALUES (1, 2, 1, 1, '{"protagonist":"李四","place":"长安"}', 10, 'fp-legacy-1', 'empty', 'native', ?)`,
      [T],
    );
    await db.executeSql(
      `INSERT INTO story_memory_batches
        (batch_id, project_id, from_chapter_id, from_position, through_chapter_id,
         through_position, schema_version, source_fingerprint, base_state_fingerprint,
         patch_json, chapter_summaries_json, estimated_tokens, status, generated_at)
       VALUES ('batch-1', 1, 1, 1, 1, 1, 2, 'sf-1', 'bsf-1', '{"k":"v"}', '[{"pos":1}]', 10, 'generated', ?)`,
      [T],
    );
    await db.executeSql(
      `INSERT INTO project_story_memory_policy
        (project_id, mode, interval_chapters, pending_token_soft_limit,
         update_on_key_chapter, updated_at)
       VALUES (1, 'smart', 3, 2400, 1, ?)`,
      [T],
    );
    await db.executeSql(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '42')",
    );
    await db.executeSql(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('app_version', '2.11.36')",
    );
  });

  afterEach(() => {
    __resetForTest();
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });

  it('only the smart policy interval changes; chapters/memory/batches stay byte-identical', async () => {
    const [projBefore] = await db.executeSql('SELECT id, name, mode FROM projects ORDER BY id');
    const [chapBefore] = await db.executeSql('SELECT id, project_id, position, title, content, status FROM chapters ORDER BY id');
    const [memBefore] = await db.executeSql('SELECT * FROM project_story_memory WHERE project_id = 1');
    const [batchBefore] = await db.executeSql('SELECT * FROM story_memory_batches WHERE batch_id = ?', ['batch-1']);

    const snapshot = <T,>(res: { rows: { length: number; item: (i: number) => T; raw: () => T[] } }) =>
      res.rows.raw();

    const before = {
      projects: JSON.stringify(snapshot(projBefore)),
      chapters: JSON.stringify(snapshot(chapBefore)),
      memory: JSON.stringify(snapshot(memBefore)),
      batches: JSON.stringify(snapshot(batchBefore)),
    };

    await initializeDatabase(db as any);

    const [projAfter] = await db.executeSql('SELECT id, name, mode FROM projects ORDER BY id');
    const [chapAfter] = await db.executeSql('SELECT id, project_id, position, title, content, status FROM chapters ORDER BY id');
    const [memAfter] = await db.executeSql('SELECT * FROM project_story_memory WHERE project_id = 1');
    const [batchAfter] = await db.executeSql('SELECT * FROM story_memory_batches WHERE batch_id = ?', ['batch-1']);
    const [policyAfter] = await db.executeSql(
      'SELECT mode, interval_chapters FROM project_story_memory_policy WHERE project_id = 1',
    );

    expect(JSON.stringify(snapshot(projAfter))).toBe(before.projects);
    expect(JSON.stringify(snapshot(chapAfter))).toBe(before.chapters);
    expect(JSON.stringify(snapshot(memAfter))).toBe(before.memory);
    expect(JSON.stringify(snapshot(batchAfter))).toBe(before.batches);
    // The ONLY mutation: smart interval 3 → 10.
    expect(policyAfter.rows.item(0).mode).toBe('smart');
    expect(Number(policyAfter.rows.item(0).interval_chapters)).toBe(10);
  });
});

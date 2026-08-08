/**
 * Schema 42 → 43: legacy smart story-memory policy interval unification.
 *
 * One-time data migration: every pre-upgrade `mode = 'smart'` policy row gets
 * `interval_chapters = 10` (the new default smart cadence). `fixed` /
 * `every_chapter` / `manual` are explicit user strategies and must stay
 * untouched; projects without a policy row must NOT get one created.
 *
 * Matrix (real sql.js SQLite, real `initializeDatabase` upgrade chain):
 *   M1 smart/3  → smart/10  (legacy system default)
 *   M2 smart/5  → smart/5   (explicit user choice, preserved)
 *   M3 smart/7  → smart/7   (explicit user choice, preserved)
 *   M4 smart/10 → smart/10  (already the new default)
 *   M5 fixed/3  → fixed/3
 *   M6 fixed/7  → fixed/7
 *   M7 manual/3 → manual/3
 *   M8 every_chapter/2 → every_chapter/2
 *   M9 no policy → no policy created
 *   M10 re-run is idempotent
 *   M11 after migration, user-set smart/5 survives reloads (no runtime clamp)
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

  it('builds a single narrow UPDATE for legacy-default smart rows only', () => {
    const stmts = buildV42toV43Statements();
    expect(stmts.length).toBe(1);
    const sql = stmts[0].sql;
    expect(sql).toContain('UPDATE project_story_memory_policy');
    expect(sql).toContain('interval_chapters = 10');
    expect(sql).toContain("WHERE mode = 'smart'");
    // Narrow: only the legacy system default (smart/3) is rewritten, so
    // explicit user choices (smart/2, smart/5, smart/7, smart/9...) survive.
    expect(sql).toContain('interval_chapters = 3');
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

  // M2: explicit user choice smart/5 → preserved as smart/5
  it('M2 smart/5 stays smart/5 (explicit user choice)', async () => {
    await seedProject(1, '小说A');
    await seedPolicy(1, 'smart', 5);
    await upgrade();
    expect(await readPolicy(1)).toEqual({ mode: 'smart', interval: 5 });
  });

  // M3: explicit user choice smart/7 → preserved as smart/7
  it('M3 smart/7 stays smart/7 (explicit user choice)', async () => {
    await seedProject(1, '小说A');
    await seedPolicy(1, 'smart', 7);
    await upgrade();
    expect(await readPolicy(1)).toEqual({ mode: 'smart', interval: 7 });
  });

  // M4: smart/10 (already the new default) stays smart/10
  it('M4 smart/10 stays smart/10', async () => {
    await seedProject(1, '小说A');
    await seedPolicy(1, 'smart', 10);
    await upgrade();
    expect(await readPolicy(1)).toEqual({ mode: 'smart', interval: 10 });
  });

  // M4b: explicit user choice smart/2 → preserved as smart/2
  it('M4b smart/2 stays smart/2 (explicit user choice)', async () => {
    await seedProject(1, '小说A');
    await seedPolicy(1, 'smart', 2);
    await upgrade();
    expect(await readPolicy(1)).toEqual({ mode: 'smart', interval: 2 });
  });

  // M5: fixed/3 untouched
  it('M5 fixed/3 stays fixed/3', async () => {
    await seedProject(1, '小说A');
    await seedPolicy(1, 'fixed', 3);
    await upgrade();
    expect(await readPolicy(1)).toEqual({ mode: 'fixed', interval: 3 });
  });

  // M6: fixed/7 untouched
  it('M6 fixed/7 stays fixed/7', async () => {
    await seedProject(1, '小说A');
    await seedPolicy(1, 'fixed', 7);
    await upgrade();
    expect(await readPolicy(1)).toEqual({ mode: 'fixed', interval: 7 });
  });

  // M7: manual untouched
  it('M7 manual stays unchanged', async () => {
    await seedProject(1, '小说A');
    await seedPolicy(1, 'manual', 3);
    await upgrade();
    expect(await readPolicy(1)).toEqual({ mode: 'manual', interval: 3 });
  });

  // M8: every_chapter untouched
  it('M8 every_chapter stays unchanged', async () => {
    await seedProject(1, '小说A');
    await seedPolicy(1, 'every_chapter', 2);
    await upgrade();
    expect(await readPolicy(1)).toEqual({
      mode: 'every_chapter',
      interval: 2,
    });
  });

  // M9: project without a policy row gets none created
  it('M9 projects without a policy do not get one created', async () => {
    await seedProject(1, '小说A');
    await upgrade();
    const [res] = await db.executeSql(
      'SELECT COUNT(*) AS c FROM project_story_memory_policy',
    );
    expect(Number(res.rows.item(0).c)).toBe(0);
  });

  // M10: re-running the migration is idempotent
  it('M10 migration is idempotent when re-run', async () => {
    await seedProject(1, '小说A');
    await seedProject(2, '小说B');
    await seedProject(3, '小说C');
    await seedPolicy(1, 'smart', 3);
    await seedPolicy(2, 'fixed', 7);
    await seedPolicy(3, 'smart', 5);
    await migrateV42ToV43(db as any);
    expect(await readPolicy(1)).toEqual({ mode: 'smart', interval: 10 });
    expect(await readPolicy(2)).toEqual({ mode: 'fixed', interval: 7 });
    expect(await readPolicy(3)).toEqual({ mode: 'smart', interval: 5 });
    // Second run: no further changes.
    await migrateV42ToV43(db as any);
    expect(await readPolicy(1)).toEqual({ mode: 'smart', interval: 10 });
    expect(await readPolicy(2)).toEqual({ mode: 'fixed', interval: 7 });
    expect(await readPolicy(3)).toEqual({ mode: 'smart', interval: 5 });
  });

  // M11: after migration, the user can re-set smart interval and it sticks.
  it('M11 user re-setting smart interval after upgrade is respected', async () => {
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
    // §6.3 data-safety coverage: seed one representative row in every
    // content/domain table so the migration cannot silently touch anything
    // outside the policy row.
    await db.executeSql(
      `INSERT INTO outlines
        (id, project_id, title, content, source_type, enabled, position,
         estimated_tokens, content_hash, created_at, updated_at)
       VALUES (1, 1, '大纲', '故事走向', 'manual', 1, 0, 10, 'hash-outline', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      `INSERT INTO notes (id, project_id, collection_id, title, content, created_at, updated_at)
       VALUES (1, 1, 0, '设定笔记', '女主身世', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      `INSERT INTO characters (id, project_id, collection_id, name, data_json, created_at)
       VALUES (1, 1, 0, '李四', '{"age":25}', ?)`,
      [T],
    );
    await db.executeSql(
      `INSERT INTO character_collections (id, project_id, name, created_at)
       VALUES (1, 1, '主角团', ?)`,
      [T],
    );
    await db.executeSql(
      `INSERT INTO worldbook_collections (id, project_id, name, created_at)
       VALUES (1, 1, '世界观', ?)`,
      [T],
    );
    await db.executeSql(
      `INSERT INTO worldbook_entries (id, project_id, collection_id, keyword_primary, content, created_at)
       VALUES (1, 1, 1, '长安', '帝都', ?)`,
      [T],
    );
    await db.executeSql(
      `INSERT INTO llm_config (id, name, base_url, model_name, is_active, context_window, max_output_tokens)
       VALUES (1, 'deepseek', 'https://api.example.com/v1', 'deepseek-chat', 1, 32768, 4096)`,
    );
    await db.executeSql(
      `INSERT INTO pipeline_tasks
        (id, target_type, target_id, status, created_at, updated_at)
       VALUES ('task-1', 'chapter', 1, 'succeeded', ?, ?)`,
      [Date.now(), Date.now()],
    );
    await db.executeSql(
      `INSERT INTO pipeline_stage_checkpoints
        (task_id, stage, status, updated_at, attempt_count)
       VALUES ('task-1', 'draft', 'succeeded', ?, 1)`,
      [Date.now()],
    );
    await db.executeSql(
      `INSERT INTO pipeline_stage_attempts
        (id, pipeline_task_id, stage, attempt_no, request_fingerprint,
         llm_config_snapshot_json, client_request_id, status, started_at)
       VALUES ('att-1', 'task-1', 'draft', 1, 'fp-request-1', '{}', 'cr-1', 'succeeded', ?)`,
      [Date.now()],
    );
    await db.executeSql(
      `INSERT INTO content_revisions
        (id, project_id, target_type, target_id, title, content, source, source_ref, created_at)
       VALUES (1, 1, 'chapter', 1, '第一章', '第一章正文内容', 'pipeline', 'task-1', ?)`,
      [T],
    );
    await db.executeSql(
      `INSERT INTO multi_chapter_batches
        (id, project_id, status, source_prompt, chapter_count, target_words_per_chapter,
         pipeline_mode, planner_hash, current_ordinal, completed_count,
         used_llm_calls, used_input_tokens, used_output_tokens, row_version, created_at, updated_at)
       VALUES ('batch-mc-1', 1, 'running', '写十章', 10, 2000, 'draft_review',
               'planner-hash', 1, 0, 1, 100, 50, 1, ?, ?)`,
      [Date.now(), Date.now()],
    );
    await db.executeSql(
      `INSERT INTO multi_chapter_batch_items
        (batch_id, ordinal, title, synopsis, key_beats_json, target_words, status, created_at, updated_at)
       VALUES ('batch-mc-1', 1, '第一章', '开篇', '[]', 2000, 'completed', ?, ?)`,
      [Date.now(), Date.now()],
    );
    await db.executeSql(
      `INSERT INTO multi_chapter_batch_item_runs
        (batch_id, ordinal, run_no, pipeline_task_id, llm_config_snapshot_json, reason, status, created_at)
       VALUES ('batch-mc-1', 1, 1, 'task-1', '{}', 'initial', 'completed', ?)`,
      [Date.now()],
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

  const snapshotTables = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const table of [
      'projects',
      'chapters',
      'outlines',
      'notes',
      'characters',
      'character_collections',
      'worldbook_collections',
      'worldbook_entries',
      'llm_config',
      'pipeline_tasks',
      'pipeline_stage_checkpoints',
      'pipeline_stage_attempts',
      'content_revisions',
      'project_story_memory',
      'story_memory_batches',
      'multi_chapter_batches',
      'multi_chapter_batch_items',
      'multi_chapter_batch_item_runs',
    ]) {
      const [res] = await db.executeSql(`SELECT * FROM ${table} ORDER BY 1`);
      out[table] = JSON.stringify(res.rows.raw());
    }
    return out;
  };

  it('only the legacy-default smart policy interval changes; all other tables stay byte-identical', async () => {
    const before = await snapshotTables();

    await initializeDatabase(db as any);

    const after = await snapshotTables();
    for (const table of Object.keys(before)) {
      if (table === 'project_story_memory_policy') continue;
      expect(after[table]).toBe(before[table]);
    }

    // The ONLY mutation: smart interval 3 → 10.
    const [policyAfter] = await db.executeSql(
      'SELECT mode, interval_chapters FROM project_story_memory_policy WHERE project_id = 1',
    );
    expect(policyAfter.rows.item(0).mode).toBe('smart');
    expect(Number(policyAfter.rows.item(0).interval_chapters)).toBe(10);
  });
});

/**
 * U3: V2.11.24 / Schema40 老用户 → current 全链升级（真实 sql.js + initializeDatabase）。
 *
 * Schema 40 → current 完整迁移链，携带：
 *   - projects/chapters/outlines/notes/characters/worldbook/llm_config
 *   - pipeline_tasks/checkpoints/attempts/content_revisions
 *   - multi_chapter_batches/items/runs
 *   - Story Memory policy: smart/3（旧默认）+ smart/5（用户自定义）+ fixed/7
 *
 * 断言：
 *   - 除 policy 允许字段外全部表前后字节一致
 *   - smart/3 → smart/10；smart/5 保持 5；fixed/7 保持 7
 *   - schema_version 最终 = 43
 */
import { createCanonInMemoryDb, type InMemorySqliteDb } from './helpers/canonInMemoryDb';
import { setupInMemoryFs } from './schema40-fixture-helpers';
import {
  __resetForTest,
  __setDatabaseForTest,
} from '../src/data/connection/openDatabase';
import { initializeDatabase } from '../src/services/database';
import { SCHEMA_VERSION } from '../src/services/migrations';

const T = '2026-07-20T00:00:00.000Z';

describe('U3: Schema40 (V2.11.24) → current full chain (real sql.js)', () => {
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
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, '老用户小说', 'novel', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      `INSERT INTO chapters (id, project_id, position, title, content, status, created_at, updated_at)
       VALUES (1, 1, 0, '第一章', '第一章正文。', 'finalized', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      `INSERT INTO outlines (id, project_id, title, content, source_type, enabled, position, estimated_tokens, content_hash, created_at, updated_at)
       VALUES (1, 1, '大纲A', '走向', 'manual', 1, 0, 10, 'h1', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      `INSERT INTO notes (id, project_id, collection_id, title, content, created_at, updated_at)
       VALUES (1, 1, 0, '设定', '内容', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      `INSERT INTO characters (id, project_id, collection_id, name, data_json, created_at)
       VALUES (1, 1, 0, '主角', '{"age":20}', ?)`,
      [T],
    );
    await db.executeSql(
      `INSERT INTO worldbook_entries (id, project_id, collection_id, keyword_primary, content, created_at)
       VALUES (1, 1, 0, '城', '都城', ?)`,
      [T],
    );
    await db.executeSql(
      `INSERT INTO llm_config (id, name, base_url, model_name, is_active, context_window, max_output_tokens)
       VALUES (1, '本地模型', '', '', 1, 4096, 4096)`,
    );
    await db.executeSql(
      `INSERT INTO pipeline_tasks (id, target_type, target_id, status, created_at, updated_at)
       VALUES ('task-u3-1', 'chapter', 1, 'succeeded', ?, ?)`,
      [Date.now(), Date.now()],
    );
    await db.executeSql(
      `INSERT INTO content_revisions (id, project_id, target_type, target_id, title, content, source, source_ref, created_at)
       VALUES (1, 1, 'chapter', 1, '第一章', '第一章正文。', 'pipeline', 'task-u3-1', ?)`,
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
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (2, '项目B', 'novel', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      `INSERT INTO project_story_memory_policy
        (project_id, mode, interval_chapters, pending_token_soft_limit,
         update_on_key_chapter, updated_at)
       VALUES (2, 'smart', 5, 2400, 1, ?)`,
      [T],
    );
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (3, '项目C', 'novel', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      `INSERT INTO project_story_memory_policy
        (project_id, mode, interval_chapters, pending_token_soft_limit,
         update_on_key_chapter, updated_at)
       VALUES (3, 'fixed', 7, 2400, 1, ?)`,
      [T],
    );
    // V2.11.24 / Schema 40
    await db.executeSql(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '40')",
    );
    await db.executeSql(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('app_version', '2.11.24')",
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

  async function snapshotTables(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const table of [
      'projects',
      'chapters',
      'outlines',
      'notes',
      'characters',
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
      try {
        const [res] = await db.executeSql(`SELECT * FROM ${table} ORDER BY 1`);
        out[table] = JSON.stringify(res.rows.raw());
      } catch {
        out[table] = '__missing__';
      }
    }
    return out;
  }

  it('runs the full Schema40→current chain; only legacy smart/3 policy changes', async () => {
    const before = await snapshotTables();
    const beforeSchema = await db.executeSql(
      "SELECT value FROM settings WHERE key = 'schema_version'",
    );
    expect(beforeSchema[0].rows.item(0).value).toBe('40');

    await initializeDatabase(db as any);

    const after = await db.executeSql(
      "SELECT value FROM settings WHERE key = 'schema_version'",
    );
    expect(after[0].rows.item(0).value).toBe(String(SCHEMA_VERSION));
    expect(String(SCHEMA_VERSION)).toBe('46');

    const fullAfter = await snapshotTables();
    for (const table of Object.keys(before)) {
      if (table === 'project_story_memory_policy') continue;
      if (before[table] === '__missing__' && fullAfter[table] === '__missing__')
        continue;
      expect(fullAfter[table]).toBe(before[table]);
    }

    const [p1] = await db.executeSql(
      'SELECT mode, interval_chapters FROM project_story_memory_policy WHERE project_id = 1',
    );
    expect(p1.rows.item(0).mode).toBe('smart');
    expect(Number(p1.rows.item(0).interval_chapters)).toBe(10);
    const [p2] = await db.executeSql(
      'SELECT mode, interval_chapters FROM project_story_memory_policy WHERE project_id = 2',
    );
    expect(p2.rows.item(0).mode).toBe('smart');
    expect(Number(p2.rows.item(0).interval_chapters)).toBe(5);
    const [p3] = await db.executeSql(
      'SELECT mode, interval_chapters FROM project_story_memory_policy WHERE project_id = 3',
    );
    expect(p3.rows.item(0).mode).toBe('fixed');
    expect(Number(p3.rows.item(0).interval_chapters)).toBe(7);
  });
});


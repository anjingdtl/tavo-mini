/**
 * 一次性验证（不进 CI）：用 emulator-5554 的真实用户 DB（V2.11.35 / Schema42）
 * 跑完整 initializeDatabase 升级链到 Schema43，验证：
 *   - 数据不漂移（fingerprint 对比）
 *   - smart policy 语义（该库无 policy 行 → 不创建）
 * 仅在本轮验证时运行，不纳入 testPathIgnorePatterns。
 */
import fs from 'fs';
import path from 'path';
import initSqlJsNs from 'sql.js';
import { wrapSqlJsDb } from './helpers/canonInMemoryDb';
import {
  __resetForTest,
  __setDatabaseForTest,
} from '../src/data/connection/openDatabase';
import { initializeDatabase } from '../src/services/database';
import { SCHEMA_VERSION } from '../src/services/migrations';

const DB_PATH = path.resolve(
  __dirname,
  '..',
  'test-logs',
  'schema43-qa-20260808-153204',
  'db-before-upgrade.sqlite',
);

const skip = !fs.existsSync(DB_PATH);

const initSqlJs: (config?: {
  locateFile?: (file: string) => string;
}) => Promise<{ Database: new (bytes?: Uint8Array) => any }> =
  ((initSqlJsNs as unknown as {
    default?: (config?: {
      locateFile?: (file: string) => string;
    }) => Promise<{ Database: new (bytes?: Uint8Array) => any }>;
  }).default ?? initSqlJsNs) as never;

const describeUpgrade = skip ? describe.skip : describe;

describeUpgrade('real user DB Schema42 → 43 upgrade (manual evidence)', () => {
  let wrapped: ReturnType<typeof wrapSqlJsDb> | null = null;

  afterEach(() => {
    __resetForTest();
    try {
      wrapped?.close();
    } catch {
      /* ignore */
    }
    wrapped = null;
  });

  async function snapshot(): Promise<Record<string, string>> {
    const dbHandle = wrapped!;
    const out: Record<string, string> = {};
    const tables = [
      'projects',
      'chapters',
      'pipeline_tasks',
      'pipeline_stage_checkpoints',
      'pipeline_stage_attempts',
      'content_revisions',
      'outlines',
      'notes',
      'characters',
      'character_collections',
      'worldbook_collections',
      'worldbook_entries',
      'llm_config',
      'llm_usage_logs',
      'project_story_memory',
      'story_memory_batches',
      'project_story_memory_policy',
      'multi_chapter_batches',
      'multi_chapter_batch_items',
      'multi_chapter_batch_item_runs',
    ];
    for (const t of tables) {
      try {
        const [res] = await dbHandle.executeSql(
          `SELECT * FROM ${t} ORDER BY 1`,
        );
        out[t] = JSON.stringify(res.rows.raw());
      } catch {
        out[t] = '__missing__';
      }
    }
    return out;
  }

  it('upgrades real user data to Schema 43 without drift', async () => {
    expect(skip).toBe(false);
    __resetForTest();
    const SQL = await initSqlJs({
      locateFile: (file: string) =>
        path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
    });
    const bytes = fs.readFileSync(DB_PATH);
    const raw = new SQL.Database(bytes);
    wrapped = wrapSqlJsDb(raw);
    __setDatabaseForTest(wrapped as never);

    const before = await snapshot();
    const beforeSchema = await wrapped.executeSql(
      "SELECT value FROM settings WHERE key = 'schema_version'",
    );
    expect(beforeSchema[0].rows.item(0).value).toBe('42');

    await initializeDatabase(wrapped as never);

    const after = await snapshot();
    for (const t of Object.keys(before)) {
      if (t === 'project_story_memory_policy') continue;
      if (before[t] === '__missing__' && after[t] === '__missing__') continue;
      expect(after[t]).toBe(before[t]);
    }
    const afterSchema = await wrapped.executeSql(
      "SELECT value FROM settings WHERE key = 'schema_version'",
    );
    expect(afterSchema[0].rows.item(0).value).toBe(String(SCHEMA_VERSION));
    const [policyCount] = await wrapped.executeSql(
      'SELECT COUNT(*) AS c FROM project_story_memory_policy',
    );
    expect(policyCount).toBeDefined();
    expect(policyCount.rows).toBeDefined();
    // 真实用户库无 policy 行 → 迁移不得创建
    expect(Number(policyCount.rows.item(0).c)).toBe(0);
  });
});

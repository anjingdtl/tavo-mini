/**
 * F2-03: UserContentFingerprint 必须保持 row-key 绑定（修复前稳定失败测试）。
 *
 * 漏洞：compareUserContentFingerprints 在「迁移新增列」或
 * `allowCollectionIdMigration` 模式下改用 per-column aggregates —— 每列
 * 的值集合排序后哈希，丢失「哪个值属于哪一行」。两行内容互换时每列值
 * 集合完全不变，但用户内容已经串行。
 *
 * 反例：
 *   1. chapters 两行 content 互换 + 同时新增 summary_json 列 → 必须 mismatch
 *   2. worldbook_entries 两行 content 互换 + allowlist 生效 → 必须 mismatch
 * 合法场景（必须 pass）：
 *   3. 仅 collection_id 归一化（allowlist 放行该列）
 *   4. 仅新增列补默认值，旧字段不变
 */
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';
import { createFreshDb, setupInMemoryFs } from './schema40-fixture-helpers';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  captureUserContentFingerprint,
  compareUserContentFingerprints,
} from '../src/data/schema/userContentFingerprint';

let db: InMemorySqliteDb | null = null;

async function resetDb(): Promise<InMemorySqliteDb> {
  __resetForTest();
  setupInMemoryFs();
  const fresh = await createFreshDb();
  __setDatabaseForTest(fresh as any);
  db = fresh;
  return fresh;
}

afterEach(() => {
  __resetForTest();
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
});

/** 把 chapters 重建为旧 schema（无 summary_json 列）。 */
async function rebuildChaptersOldSchema(fresh: InMemorySqliteDb): Promise<void> {
  await fresh.executeSql(`DROP TABLE chapters`);
  await fresh.executeSql(
    `CREATE TABLE chapters (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       project_id INTEGER NOT NULL,
       position INTEGER NOT NULL DEFAULT 0,
       title TEXT NOT NULL DEFAULT '',
       synopsis TEXT NOT NULL DEFAULT '',
       content TEXT NOT NULL DEFAULT '',
       status TEXT NOT NULL DEFAULT 'draft',
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  );
}

describe('F2-03: fingerprint row-key 绑定（跨行互换反例）', () => {
  it('两行 chapter content 互换 + 新增 summary_json → 必须 mismatch', async () => {
    const fresh = await resetDb();
    await fresh.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    await rebuildChaptersOldSchema(fresh);
    await fresh.executeSql(
      `INSERT INTO chapters (id, project_id, position, title, synopsis, content, status, created_at, updated_at) VALUES
       (1, 1, 0, '第1章', '梗概A', '内容A', 'draft', 't', 't'),
       (2, 1, 1, '第2章', '梗概B', '内容B', 'draft', 't', 't')`,
    );
    const before = await captureUserContentFingerprint(fresh as any);

    // 迁移：新增 summary_json 列，同时两行 content 互换（用户内容串行）。
    await fresh.executeSql(`ALTER TABLE chapters ADD COLUMN summary_json TEXT`);
    await fresh.executeSql(
      `UPDATE chapters SET content = '内容B', summary_json = '{"brief":"m1"}' WHERE id = 1`,
    );
    await fresh.executeSql(
      `UPDATE chapters SET content = '内容A', summary_json = '{"brief":"m2"}' WHERE id = 2`,
    );
    const after = await captureUserContentFingerprint(fresh as any);

    const mismatch = compareUserContentFingerprints(before, after);
    expect(mismatch).not.toBeNull();
    expect(mismatch!.table).toBe('chapters');
    expect(mismatch!.rowKey).toBeDefined();
  });

  it('两行 worldbook content 互换 + allowlist → 必须 mismatch', async () => {
    const fresh = await resetDb();
    await fresh.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    await fresh.executeSql(
      `INSERT INTO worldbook_collections (id, project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES
       (1, 1, 'c1', 1, 50000, 0, 't'),
       (2, 1, 'c2', 1, 50000, 0, 't')`,
    );
    await fresh.executeSql(
      `INSERT INTO worldbook_entries (id, project_id, collection_id, keyword_primary, keyword_secondary, content, comment, enabled, constant, max_tokens, estimated_tokens, position, created_at) VALUES
       (1, 1, 1, 'k1', '', '词条内容X', '', 1, 0, 2000, 0, 0, 't'),
       (2, 1, 2, 'k2', '', '词条内容Y', '', 1, 0, 2000, 0, 1, 't')`,
    );
    const before = await captureUserContentFingerprint(fresh as any);

    // 迁移归一化 collection_id 的同时，两行 content 互换。
    await fresh.executeSql(`UPDATE worldbook_entries SET content = '词条内容Y' WHERE id = 1`);
    await fresh.executeSql(`UPDATE worldbook_entries SET content = '词条内容X' WHERE id = 2`);
    const after = await captureUserContentFingerprint(fresh as any);

    const mismatch = compareUserContentFingerprints(before, after, {
      allowCollectionIdMigration: true,
    });
    expect(mismatch).not.toBeNull();
    expect(mismatch!.table).toBe('worldbook_entries');
  });

  it('仅 collection_id 归一化（allowlist）→ pass', async () => {
    const fresh = await resetDb();
    await fresh.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    await fresh.executeSql(
      `INSERT INTO worldbook_collections (id, project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES
       (1, 1, 'c1', 1, 50000, 0, 't'),
       (2, 1, 'c2', 1, 50000, 0, 't')`,
    );
    await fresh.executeSql(
      `INSERT INTO worldbook_entries (id, project_id, collection_id, keyword_primary, keyword_secondary, content, comment, enabled, constant, max_tokens, estimated_tokens, position, created_at) VALUES
       (1, 1, 1, 'k1', '', '内容', '', 1, 0, 2000, 0, 0, 't'),
       (2, 1, 2, 'k2', '', '内容2', '', 1, 0, 2000, 0, 1, 't')`,
    );
    const before = await captureUserContentFingerprint(fresh as any);

    // 归一化：两行 collection_id 各自重绑（仅该列变化）。
    await fresh.executeSql(`UPDATE worldbook_entries SET collection_id = 2 WHERE id = 1`);
    await fresh.executeSql(`UPDATE worldbook_entries SET collection_id = 1 WHERE id = 2`);
    const after = await captureUserContentFingerprint(fresh as any);

    expect(
      compareUserContentFingerprints(before, after, {
        allowCollectionIdMigration: true,
      }),
    ).toBeNull();
  });

  it('仅新增列补默认值，旧字段不变 → pass', async () => {
    const fresh = await resetDb();
    await fresh.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    await rebuildChaptersOldSchema(fresh);
    await fresh.executeSql(
      `INSERT INTO chapters (id, project_id, position, title, synopsis, content, status, created_at, updated_at) VALUES
       (1, 1, 0, '第1章', '梗概A', '内容A', 'draft', 't', 't'),
       (2, 1, 1, '第2章', '梗概B', '内容B', 'draft', 't', 't')`,
    );
    const before = await captureUserContentFingerprint(fresh as any);

    await fresh.executeSql(`ALTER TABLE chapters ADD COLUMN summary_json TEXT`);
    await fresh.executeSql(
      `UPDATE chapters SET summary_json = '{}' WHERE id IN (1, 2)`,
    );
    const after = await captureUserContentFingerprint(fresh as any);

    expect(compareUserContentFingerprints(before, after)).toBeNull();
  });
});

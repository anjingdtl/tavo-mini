/**
 * CL-03: 内容级 UserContentFingerprint（修复前稳定失败测试）。
 *
 * 旧 recall snapshot 只校验 count/min/max/sum/ids —— 同 id 同 count 的正文
 * 改写完全无法发现。本测试证明内容级 SHA-256 指纹能检测：
 *   1. 章节正文同 count 改写（核心场景）
 *   2. null / '' / 0 / false 的显式区分
 *   3. 行数变化
 *   4. 迁移列新增时的按列对齐（共有列必须逐字节一致）
 *   5. collection_id 迁移归一化 allowlist
 *   6. 集成：initializeDatabase 升级（same-version）前后内容被改写 → 阻断启动
 *
 * 修复前：capture/compare 不存在（模块缺失，测试编译失败即失败证据）；
 * initializeDatabase 无指纹校验 → 集成测试断言不抛错 → 失败。
 */
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';
import {
  createFreshDb,
  setupInMemoryFs,
} from './schema40-fixture-helpers';
import {
  createEmptyInMemoryDb,
  type InMemorySqliteDb,
} from './helpers/canonInMemoryDb';
import * as fingerprintModule from '../src/data/schema/userContentFingerprint';
const {
  captureUserContentFingerprint,
  compareUserContentFingerprints,
  normalizeFingerprintValue,
  fingerprintTableSummary,
} = fingerprintModule;
import {
  CONTENT_FINGERPRINT_TABLES,
  MAX_ROW_HASH_MAP_ROWS,
  type ContentFingerprintTable,
  type UserContentFingerprint,
} from '../src/data/schema/userContentFingerprint';
import { initializeDatabase } from '../src/data/schema/initializeDatabase';

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

describe('capture / compare（真实 sql.js SQLite）', () => {
  it('同 id 同 count 的章节正文改写必须被检测为 mismatch', async () => {
    const fresh = await resetDb();
    await fresh.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    await fresh.executeSql(
      `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 0, '第1章', '梗概', '原始正文内容', 'draft', 't', 't')`,
    );

    const before = await captureUserContentFingerprint(fresh as any);

    // 同 id、同 count，仅 content 改写 —— 旧 count/sum 校验永远发现不了。
    await fresh.executeSql(
      `UPDATE chapters SET content = '被改写后的正文内容' WHERE id = 1`,
    );

    const after = await captureUserContentFingerprint(fresh as any);
    const mismatch = compareUserContentFingerprints(before, after);
    expect(mismatch).not.toBeNull();
    expect(mismatch!.table).toBe('chapters');
    expect(mismatch!.reason).toBe('row_content');
    expect(before.overallHash).not.toBe(after.overallHash);
  });

  it('显式区分 null / 空字符串 / 0 / false', () => {
    expect(normalizeFingerprintValue(null)).toBe('null');
    expect(normalizeFingerprintValue('')).toBe('""');
    expect(normalizeFingerprintValue(0)).toBe('0');
    expect(normalizeFingerprintValue(false)).toBe('false');
    expect(normalizeFingerprintValue(undefined)).toBe('null');
    // 空字符串 ↔ 0 ↔ false 之间的差异必须保留。
    const values = ['""', '0', 'false', 'null'];
    expect(new Set(values).size).toBe(4);
  });

  it('行数变化必须被检测', async () => {
    const fresh = await resetDb();
    await fresh.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    await fresh.executeSql(
      `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 0, '第1章', '梗概', '正文', 'draft', 't', 't')`,
    );
    const before = await captureUserContentFingerprint(fresh as any);
    await fresh.executeSql(
      `DELETE FROM chapters WHERE id = 1`,
    );
    const after = await captureUserContentFingerprint(fresh as any);
    const mismatch = compareUserContentFingerprints(before, after);
    expect(mismatch).not.toBeNull();
    expect(mismatch!.reason).toBe('row_count');
  });

  it('迁移新增列：共有列逐字节一致则通过（按列对齐）', async () => {
    const fresh = await resetDb();
    await fresh.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    // 旧 schema：chapters 无 summary_json 列。
    await fresh.executeSql(
      `CREATE TABLE chapters_old (
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
    await fresh.executeSql(
      `INSERT INTO chapters_old (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 0, '第1章', '梗概', '正文', 'draft', 't', 't')`,
    );
    // 模拟迁移前快照：将 chapters_old 冒充 chapters？不行 —— 直接对
    // chapters 表做列增删更真实：先 DROP 再按旧结构重建。
    // 这里直接构造 before 为「旧列集」、after 为「新列集」：
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
    await fresh.executeSql(
      `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 0, '第1章', '梗概', '正文', 'draft', 't', 't')`,
    );
    const before = await captureUserContentFingerprint(fresh as any);

    // 迁移：ADD COLUMN summary_json 并填充（老行补 null → 新值算新列，不阻断）。
    await fresh.executeSql(
      `ALTER TABLE chapters ADD COLUMN summary_json TEXT`,
    );
    await fresh.executeSql(
      `UPDATE chapters SET summary_json = '{"brief":"迁移补填"}' WHERE id = 1`,
    );
    const after = await captureUserContentFingerprint(fresh as any);

    // 共有列（除 summary_json 外）逐字节一致 → 允许（迁移新增列合法）。
    expect(compareUserContentFingerprints(before, after)).toBeNull();

    // 但若共有列被改写 → 必须阻断。
    await fresh.executeSql(
      `UPDATE chapters SET content = '迁移中意外改写了正文' WHERE id = 1`,
    );
    const afterRewrite = await captureUserContentFingerprint(fresh as any);
    const mismatch = compareUserContentFingerprints(before, afterRewrite);
    expect(mismatch).not.toBeNull();
    expect(mismatch!.detail).toContain('content');
  });

  it('collection_id 迁移归一化 allowlist 只放行该列', async () => {
    const fresh = await resetDb();
    await fresh.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    await fresh.executeSql(
      `INSERT INTO worldbook_collections (id, project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES (1, 1, 'c1', 1, 50000, 0, 't')`,
    );
    await fresh.executeSql(
      `INSERT INTO worldbook_collections (id, project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES (2, 1, 'c2', 1, 50000, 0, 't')`,
    );
    await fresh.executeSql(
      `INSERT INTO worldbook_entries (id, project_id, collection_id, keyword_primary, keyword_secondary, content, comment, enabled, constant, max_tokens, estimated_tokens, position, created_at)
       VALUES (1, 1, 1, 'k', '', '内容', '', 1, 0, 2000, 0, 0, 't')`,
    );
    const before = await captureUserContentFingerprint(fresh as any);

    // 迁移：collection_id 重新绑定（v4→v5 归一化的等价形式）。
    await fresh.executeSql(
      `UPDATE worldbook_entries SET collection_id = 2 WHERE id = 1`,
    );
    const after = await captureUserContentFingerprint(fresh as any);

    // 未开 allowlist → 必须报 mismatch。
    expect(compareUserContentFingerprints(before, after)).not.toBeNull();
    // 开启 allowlist → 通过。
    expect(
      compareUserContentFingerprints(before, after, {
        allowCollectionIdMigration: true,
      }),
    ).toBeNull();

    // allowlist 下改写其他列仍必须阻断。
    await fresh.executeSql(
      `UPDATE worldbook_entries SET content = '改写' WHERE id = 1`,
    );
    const afterRewrite = await captureUserContentFingerprint(fresh as any);
    expect(
      compareUserContentFingerprints(before, afterRewrite, {
        allowCollectionIdMigration: true,
      }),
    ).not.toBeNull();
  });

  it('读取失败必须 fail-closed（不吞错误返回空快照）', async () => {
    const fresh = await resetDb();
    // 模拟某张表读取抛错（磁盘错误等）：capture 必须 propagate，绝不
    // catch 后返回空指纹（否则升级校验被静默跳过）。
    const spy = jest
      .spyOn(fresh, 'executeSql')
      .mockRejectedValueOnce(new Error('disk I/O error'));
    await expect(
      captureUserContentFingerprint(fresh as any),
    ).rejects.toThrow(/内容指纹读取失败/);
    spy.mockRestore();
  });
});

describe('集成：initializeDatabase 升级前后内容指纹（CL-03 fail-closed）', () => {
  it('before/after 之间发生内容改写必须阻断启动（USER_CONTENT_FINGERPRINT_MISMATCH）', async () => {
    // 用「空库」让 initializeDatabase 走真实 fresh → same 升级路径。
    __resetForTest();
    setupInMemoryFs();
    const fresh = await createEmptyInMemoryDb();
    db = fresh;
    __setDatabaseForTest(fresh as any);

    // 第一次：fresh 安装（建全量 schema）。
    await initializeDatabase(fresh as any);

    // 植入用户内容（真实升级路径会在 before 捕获它）。
    await fresh.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    await fresh.executeSql(
      `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 0, '第1章', '梗概', '用户正文内容', 'draft', 't', 't')`,
    );

    // 第二次：same-version 启动 —— 内容未变，必须通过。
    await initializeDatabase(fresh as any);

    // 第三次：在 before 指纹与 after 指纹之间注入一次内容改写（同 id 同
    // count —— 旧 count/sum 校验无法发现），模拟迁移/修复步骤破坏内容。
    // 指纹比较必须发现并阻断启动。
    const originalCapture = fingerprintModule.captureUserContentFingerprint;
    const spy = jest
      .spyOn(fingerprintModule, 'captureUserContentFingerprint')
      .mockImplementationOnce(async (database: any) =>
        originalCapture(database),
      )
      .mockImplementationOnce(async (database: any) => {
        // after 捕获前注入内容改写（模拟迁移写坏正文）。
        await database.executeSql(
          `UPDATE chapters SET content = '迁移中被改写的正文' WHERE id = 1`,
        );
        return originalCapture(database);
      });

    let caught: any = null;
    try {
      await initializeDatabase(fresh as any);
    } catch (e: any) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('USER_CONTENT_FINGERPRINT_MISMATCH');
    expect(String(caught.message)).toContain('chapters');
    spy.mockRestore();
  });
});

function makeFingerprint(
  overrides: Record<string, Partial<ContentFingerprintTable>> = {},
): UserContentFingerprint {
  const tables = Object.fromEntries(
    CONTENT_FINGERPRINT_TABLES.map(spec => [
      spec.label,
      {
        missing: false,
        rowCount: 0,
        columnsUsed: [],
        columnAggregates: {},
        rowHashes: new Map<string, string>(),
        rowColumnHashes: new Map<string, Record<string, string>>(),
        aggregateHash: 'stable',
        ...overrides[spec.label],
      },
    ]),
  ) as Record<string, ContentFingerprintTable>;
  return { tables, overallHash: 'stable', capturedAt: 0 };
}

class ReportedSizeMap<K, V> extends Map<K, V> {
  constructor(entries: readonly (readonly [K, V])[], private readonly reportedSize: number) {
    super(entries);
  }

  get size(): number {
    return this.reportedSize;
  }
}

describe('内容指纹未覆盖分支', () => {
  it('normalizes arrays, sorted objects, NaN, booleans and fallback values', () => {
    expect(normalizeFingerprintValue(NaN)).toBe('NaN');
    expect(normalizeFingerprintValue(true)).toBe('true');
    expect(normalizeFingerprintValue(['', 0, false])).toBe(
      '["\\"\\"","0","false"]',
    );
    expect(normalizeFingerprintValue({ z: 1, a: false })).toBe(
      '{"a":false,"z":1}',
    );
    expect(normalizeFingerprintValue(Symbol('fallback'))).toBe('Symbol(fallback)');
  });

  it('captures missing tables distinctly from empty tables', async () => {
    const missingDb = await createEmptyInMemoryDb();
    try {
      const snapshot = await captureUserContentFingerprint(missingDb as any);
      expect(snapshot.tables.projects).toMatchObject({
        missing: true,
        rowCount: 0,
      });
      expect(fingerprintTableSummary(snapshot).projects).toBe(-1);
    } finally {
      missingDb.close();
    }

    const fresh = await resetDb();
    const snapshot = await captureUserContentFingerprint(fresh as any);
    expect(snapshot.tables.projects).toMatchObject({
      missing: false,
      rowCount: 0,
    });
    expect(fingerprintTableSummary(snapshot).projects).toBe(0);
  });

  it('propagates both PRAGMA and SELECT failures fail-closed', async () => {
    const pragmaErrorDb = {
      executeSql: jest.fn().mockRejectedValue(new Error('pragma failed')),
    };
    await expect(
      captureUserContentFingerprint(pragmaErrorDb as any),
    ).rejects.toThrow(/pragma failed/);

    const selectErrorDb = {
      executeSql: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.startsWith('PRAGMA')) {
          return [
            {
              rows: {
                length: 1,
                item: () => ({ name: 'id' }),
              },
            },
          ];
        }
        throw new Error('select failed');
      }),
    };
    await expect(
      captureUserContentFingerprint(selectErrorDb as any),
    ).rejects.toThrow(/select failed/);
  });

  it('reports missing snapshots, table appearance/disappearance and column removal', () => {
    const beforeMissingSnapshot = makeFingerprint();
    const afterMissingSnapshot = makeFingerprint();
    delete afterMissingSnapshot.tables.chapters;
    expect(
      compareUserContentFingerprints(
        beforeMissingSnapshot,
        afterMissingSnapshot,
      ),
    ).toMatchObject({ table: 'chapters', reason: 'table_missing' });

    const appeared = compareUserContentFingerprints(
      makeFingerprint({ projects: { missing: true } }),
      makeFingerprint(),
    );
    expect(appeared).toMatchObject({
      table: 'projects',
      reason: 'table_appeared',
    });

    const disappeared = compareUserContentFingerprints(
      makeFingerprint(),
      makeFingerprint({ projects: { missing: true } }),
    );
    expect(disappeared).toMatchObject({
      table: 'projects',
      reason: 'table_missing',
    });

    const removedColumn = compareUserContentFingerprints(
      makeFingerprint({
        chapters: {
          columnsUsed: ['content', 'summary_json'],
          aggregateHash: 'before',
        },
      }),
      makeFingerprint({
        chapters: {
          columnsUsed: ['content'],
          aggregateHash: 'after',
        },
      }),
    );
    expect(removedColumn).toMatchObject({
      table: 'chapters',
      reason: 'row_content',
    });
    expect(removedColumn?.detail).toContain('summary_json');
  });

  it('reports same-count row loss, row addition and row content change by key', () => {
    const beforeRows = new Map([
      ['id=1', 'hash-1'],
      ['id=2', 'hash-2'],
    ]);
    const before = makeFingerprint({
      chapters: {
        rowCount: 2,
        columnsUsed: ['content'],
        aggregateHash: 'before',
        rowHashes: beforeRows,
      },
    });

    const missingRow = compareUserContentFingerprints(
      before,
      makeFingerprint({
        chapters: {
          rowCount: 2,
          columnsUsed: ['content'],
          aggregateHash: 'after',
          rowHashes: new Map([
            ['id=1', 'hash-1'],
            ['id=3', 'hash-3'],
          ]),
        },
      }),
    );
    expect(missingRow?.rowKey).toBe('id=2');
    expect(missingRow?.detail).toContain('行缺失');

    const changedRow = compareUserContentFingerprints(
      before,
      makeFingerprint({
        chapters: {
          rowCount: 2,
          columnsUsed: ['content'],
          aggregateHash: 'after',
          rowHashes: new Map([
            ['id=1', 'hash-1'],
            ['id=2', 'changed'],
          ]),
        },
      }),
    );
    expect(changedRow?.rowKey).toBe('id=2');
    expect(changedRow?.detail).toContain('行内容变化');

    const newRow = compareUserContentFingerprints(
      makeFingerprint({
        chapters: {
          rowCount: 2,
          columnsUsed: ['content'],
          aggregateHash: 'before',
          rowHashes: new Map([
            ['id=1', 'hash-1'],
            ['id=2', 'hash-2'],
          ]),
        },
      }),
      makeFingerprint({
        chapters: {
          rowCount: 2,
          columnsUsed: ['content'],
          aggregateHash: 'after',
          rowHashes: new ReportedSizeMap(
            [
              ['id=1', 'hash-1'],
              ['id=2', 'hash-2'],
              ['id=3', 'hash-3'],
            ],
            2,
          ),
        },
      }),
    );
    expect(newRow?.rowKey).toBe('id=3');
    expect(newRow?.detail).toContain('新增行');
  });

  it('uses column aggregate fallback for unbounded snapshots and fails closed when unavailable', () => {
    const huge = {
      rowCount: MAX_ROW_HASH_MAP_ROWS + 1,
      columnsUsed: ['content'],
      rowHashes: new Map<string, string>(),
      rowColumnHashes: new Map<string, Record<string, string>>(),
      aggregateHash: 'before',
    };
    const stableFallback = compareUserContentFingerprints(
      makeFingerprint({
        chapters: {
          ...huge,
          columnAggregates: { content: 'same' },
        },
      }),
      makeFingerprint({
        chapters: {
          ...huge,
          columnsUsed: ['content', 'summary_json'],
          aggregateHash: 'after',
          columnAggregates: { content: 'same' },
        },
      }),
    );
    expect(stableFallback).toBeNull();

    const changedColumn = compareUserContentFingerprints(
      makeFingerprint({
        chapters: {
          ...huge,
          columnAggregates: { content: 'before' },
        },
      }),
      makeFingerprint({
        chapters: {
          ...huge,
          columnsUsed: ['content', 'summary_json'],
          aggregateHash: 'after',
          columnAggregates: { content: 'after' },
        },
      }),
    );
    expect(changedColumn?.detail).toContain('列内容变化');

    const noAggregate = compareUserContentFingerprints(
      makeFingerprint({ chapters: huge }),
      makeFingerprint({
        chapters: {
          ...huge,
          columnsUsed: ['content', 'summary_json'],
          aggregateHash: 'after',
        },
      }),
    );
    expect(noAggregate?.detail).toContain('无法按列对齐校验');
  });
});

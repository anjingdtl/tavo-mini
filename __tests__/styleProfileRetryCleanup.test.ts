/* eslint-env jest, node, es2020 */
// Regression: BUG-007 — 「单独重试风格分析」点击后无 UI 反馈。
// 根因：continuation_style_profiles 在 (project_id, source_id, source_version,
// source_sha256, boundary_char_offset_exclusive, analyzer_version) 上有
// idx_continuation_style_profiles_fingerprint UNIQUE 索引；上次失败的
// profile 仍占着 fingerprint 槽位，retryStyleAnalysis 调 runStyleAnalysis
// 时 INSERT 新 profileId 直接被 SQLite UNIQUE 拒掉，整个 retry 静默失败。
//
// 修复：retryStyleAnalysis 进入 runStyleAnalysis 前，先 DELETE 同 fingerprint
// 且 state ∈ {running, failed, interrupted, cancelled, outdated} 的旧行（不动 ready）
// —— 不删除 active 引用、ready 行；只让 retry 能 INSERT 一个新的失败尝试记录。
//
// 这个测试直接调 retryStyleAnalysis，记录 executeSql 的 SQL 顺序，断言：
//   1) 第一个针对 continuation_style_profiles 的写操作是 DELETE
//   2) DELETE 的 WHERE 子句必须包含 fingerprint 字段 + state 过滤（避免误删 ready）
//   3) DELETE 之后再 INSERT 入新 profileId
//   4) 不删 ready 行。

const styleAnalysisServiceMock = {
  __mock: { called: 0, llmFailed: true },
};

jest.mock('../src/services/continuation/canon/canonRepository', () => ({
  __esModule: true,
  getActiveSnapshot: jest.fn(async () => null),
  listRunsForProject: jest.fn(async () => [
    {
      id: 'run-1',
      canonSnapshotId: 'snap-1',
      modelConfigId: 1,
      profile: 'deep',
      state: 'failed',
      stage: 'style_analysis',
    },
  ]),
}));

jest.mock('../src/services/continuation/continuationSourceReader', () => ({
  __esModule: true,
  continuationSourceReader: {
    getSnapshot: jest.fn(async () => ({
      sourceId: 9,
      sourceVersion: 1,
      normalizedSha256: 'sha-source-1',
      parserVersion: 'v1',
      normalizationVersion: 'v1',
      boundary: {
        chapterId: 3,
        chapterPosition: 3,
        charOffsetExclusive: 1000,
      },
    })),
  },
}));

jest.mock('../src/services/llm', () => ({
  __esModule: true,
  callLLMResult: jest.fn(async () => ({
    ok: false,
    error: { message: 'forced LLM failure' },
  })),
  resolveLLMRequestConfigById: jest.fn(async () => null),
}));

jest.mock('../src/services/continuation/canon/activateSnapshotAndStyleProfile', () => ({
  __esModule: true,
  activateSnapshotAndStyleProfile: jest.fn(async () => undefined),
}));

import { __resetForTest, __setDatabaseForTest } from '../src/data/connection/openDatabase';
import { STYLE_ANALYZER_VERSION } from '../src/services/continuation/styleProfile/styleAnalysisPrompt';
import { retryStyleAnalysis } from '../src/services/continuation/styleProfile/styleAnalysisService';

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('BUG-007 retryStyleAnalysis must clean stale fingerprint rows', () => {
  let fakeDb: any;
  let writeOps: Array<{ sql: string; params: any[] }>;
  let styleRowsById: Map<string, any>;

  beforeEach(() => {
    styleAnalysisServiceMock.__mock.called = 0;
    writeOps = [];
    styleRowsById = new Map();

    const removeFailedRows = () => {
      let removed = 0;
      for (const [id, row] of Array.from(styleRowsById.entries())) {
        if (
          row.state === 'running' ||
          row.state === 'failed' ||
          row.state === 'interrupted' ||
          row.state === 'cancelled' ||
          row.state === 'outdated'
        ) {
          styleRowsById.delete(id);
          removed++;
        }
      }
      return removed;
    };

    fakeDb = {
      transaction: jest.fn((cb: any) => {
        const recorded: Array<{ sql: string; params: any[] }> = [];
        const tx = {
          executeSql: (sql: string, params: any[] = []) => {
            const n = normalize(sql);
            recorded.push({ sql: n, params });
            writeOps.push({ sql: n, params });
          },
        };
        cb(tx);
      }),
      executeSql: jest.fn(async (sql: string, params: any[] = []) => {
        const n = normalize(sql);
        if (/^INSERT INTO continuation_style_profiles/i.test(n)) {
          writeOps.push({ sql: n, params });
          const id = params[0];
          styleRowsById.set(id, {
            id,
            project_id: params[1],
            source_id: params[2],
            source_version: params[3],
            source_sha256: params[4],
            boundary_char_offset_exclusive: params[9],
            analyzer_version: params[13],
            state: params[21],
          });
          return [
            { rows: { length: 0, item: () => null, raw: () => [] }, rowsAffected: 1, insertId: 0 },
          ];
        }
        if (/^UPDATE continuation_style_profiles/i.test(n)) {
          writeOps.push({ sql: n, params });
          return [
            { rows: { length: 0, item: () => null, raw: () => [] }, rowsAffected: 1, insertId: 0 },
          ];
        }
        if (/^DELETE FROM continuation_style_profiles/i.test(n)) {
          writeOps.push({ sql: n, params });
          const removed = removeFailedRows();
          return [
            {
              rows: { length: 0, item: () => null, raw: () => [] },
              rowsAffected: removed,
              insertId: 0,
            },
          ];
        }
        if (/FROM continuation_style_profiles/i.test(n)) {
          const rows = Array.from(styleRowsById.values()).map(r => ({
            id: r.id,
            project_id: r.project_id,
            source_id: r.source_id,
            source_version: r.source_version,
            source_sha256: r.source_sha256,
            boundary_char_offset_exclusive: r.boundary_char_offset_exclusive,
            analyzer_version: r.analyzer_version,
            state: r.state,
            ...r,
          }));
          return [
            {
              rows: {
                length: rows.length,
                item: (i: number) => rows[i],
                raw: () => rows,
              },
              rowsAffected: 0,
              insertId: 0,
            },
          ];
        }
        return [
          { rows: { length: 0, item: () => null, raw: () => [] }, rowsAffected: 0, insertId: 0 },
        ];
      }),
    };

    // Seed an existing failed style profile that would otherwise trigger
    // UNIQUE failure on retry (matches fingerprint below).
    styleRowsById.set('existing-failed-id', {
      id: 'existing-failed-id',
      project_id: 3,
      source_id: 9,
      source_version: 1,
      source_sha256: 'sha-source-1',
      boundary_char_offset_exclusive: 1000,
      analyzer_version: STYLE_ANALYZER_VERSION,
      state: 'failed',
    });

    __setDatabaseForTest(fakeDb as any);
  });

  afterEach(() => {
    __resetForTest();
    jest.restoreAllMocks();
  });

  it('retryStyleAnalysis issues DELETE on continuation_style_profiles BEFORE INSERT', async () => {
    // retryStyleAnalysis throws on LLM failure, which is fine — we only
    // care about the SQL sequence it issued before throwing.
    await expect(retryStyleAnalysis(3)).rejects.toBeDefined();

    const styleProfileWrites = writeOps.filter(o =>
      /continuation_style_profiles/i.test(o.sql),
    );
    expect(styleProfileWrites.length).toBeGreaterThan(0);

    const deleteIdx = styleProfileWrites.findIndex(o =>
      /^DELETE FROM continuation_style_profiles/i.test(o.sql),
    );
    const insertIdx = styleProfileWrites.findIndex(o =>
      /^INSERT INTO continuation_style_profiles/i.test(o.sql),
    );

    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeLessThan(insertIdx);

    const deleteSql = styleProfileWrites[deleteIdx].sql.toUpperCase();
    expect(deleteSql).toMatch(/STATE\s+IN\s*\(/i);
    expect(deleteSql).toMatch(/SOURCE_ID\s*=/);
    expect(deleteSql).toMatch(/SOURCE_VERSION\s*=/);
    expect(deleteSql).toMatch(/SOURCE_SHA256\s*=/);
    expect(deleteSql).toMatch(/BOUNDARY_CHAR_OFFSET_EXCLUSIVE\s*=/);
    expect(deleteSql).toMatch(/ANALYZER_VERSION\s*=/);
  });

  it('does NOT delete a ready profile under the same fingerprint', async () => {
    styleRowsById.set('ready-id', {
      id: 'ready-id',
      project_id: 3,
      source_id: 9,
      source_version: 1,
      source_sha256: 'sha-source-1',
      boundary_char_offset_exclusive: 1000,
      analyzer_version: STYLE_ANALYZER_VERSION,
      state: 'ready',
    });

    await expect(retryStyleAnalysis(3)).rejects.toBeDefined();

    const stillReady = Array.from(styleRowsById.values()).some(
      r => r.id === 'ready-id',
    );
    expect(stillReady).toBe(true);
  });

  it('cleans a running profile left by a killed or paused request', async () => {
    styleRowsById.set('orphaned-running-id', {
      id: 'orphaned-running-id',
      project_id: 3,
      source_id: 9,
      source_version: 1,
      source_sha256: 'sha-source-1',
      boundary_char_offset_exclusive: 1000,
      analyzer_version: STYLE_ANALYZER_VERSION,
      state: 'running',
    });

    await expect(retryStyleAnalysis(3)).rejects.toBeDefined();

    expect(styleRowsById.has('orphaned-running-id')).toBe(false);
  });
});

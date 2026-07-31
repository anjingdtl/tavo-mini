/**
 * Regression: deleting the active original-work source must never write the
 * project `chapters` table (Spec §12 / §14.3).
 *
 * Locks the statement batch shape of buildClearActiveSourceAndDeleteStatements
 * and the post-condition contract of deleteContinuationSource.
 */
import { buildClearActiveSourceAndDeleteStatements } from '../src/services/continuation/continuationSourceRepository';

describe('buildClearActiveSourceAndDeleteStatements (Spec §14.3)', () => {
  const stmts = buildClearActiveSourceAndDeleteStatements({
    projectId: 7,
    sourceId: 42,
    ts: '2026-07-31T00:00:00.000Z',
  });

  it('never mentions the project chapters table', () => {
    for (const s of stmts) {
      expect(s.sql).not.toMatch(/\bFROM chapters\b/i);
      expect(s.sql).not.toMatch(/\bINTO chapters\b/i);
      expect(s.sql).not.toMatch(/\bUPDATE chapters\b/i);
      expect(s.sql).not.toMatch(/\bDELETE FROM chapters\b/i);
    }
  });

  it('outdates Canon / analysis / style / digests before clearing pointers', () => {
    expect(stmts[0].sql).toContain('continuation_canon_snapshots');
    expect(stmts[0].sql).toContain("status = 'outdated'");
    expect(stmts[1].sql).toContain('continuation_analysis_runs');
    expect(stmts[2].sql).toContain('continuation_style_profiles');
    expect(stmts[3].sql).toContain('continuation_historical_digests');
  });

  it('nulls settings pointers before deleting the source', () => {
    const settingsIdx = stmts.findIndex(s =>
      s.sql.includes('UPDATE continuation_settings'),
    );
    const deleteIdx = stmts.findIndex(s =>
      s.sql.includes('DELETE FROM continuation_sources'),
    );
    expect(settingsIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(settingsIdx);
    expect(stmts[settingsIdx].sql).toContain('active_source_id = NULL');
    expect(stmts[settingsIdx].sql).toContain('boundary_chapter_id = NULL');
    expect(stmts[settingsIdx].sql).toContain('active_canon_snapshot_id = NULL');
    expect(stmts[settingsIdx].sql).toContain('active_style_profile_id = NULL');
    expect(stmts[settingsIdx].params).toContain(7);
  });

  it('marks in-flight generation runs outdated for this project only', () => {
    const runStmt = stmts.find(s =>
      s.sql.includes('continuation_generation_runs'),
    );
    expect(runStmt).toBeDefined();
    expect(runStmt!.sql).toContain("state = 'outdated'");
    expect(runStmt!.sql).toContain(
      "'queued', 'running', 'awaiting_user', 'interrupted'",
    );
    expect(runStmt!.params).toContain('source_deleted');
    expect(runStmt!.params).toContain(7);
  });

  it('deletes only the given source id', () => {
    const del = stmts.find(s => s.sql.includes('DELETE FROM continuation_sources'));
    expect(del).toBeDefined();
    expect(del!.params).toEqual([42]);
  });
});

describe('deleteContinuationSource preserves chapter rows', () => {
  type Row = Record<string, any>;

  function makeDb(state: {
    chapters: Row[];
    sources: Row[];
    settings: Row[];
    runs: Row[];
    jobs: Row[];
  }) {
    const executeSql = jest.fn(async (sql: string, params: any[] = []) => {
      const n = sql.replace(/\s+/g, ' ').trim();
      if (/SELECT COUNT\(\*\) AS c FROM chapters WHERE project_id/i.test(n)) {
        const projectId = params[0];
        const c = state.chapters.filter(ch => ch.project_id === projectId).length;
        return [{ rows: { length: 1, item: () => ({ c }) } }];
      }
      if (
        /SELECT COUNT\(\*\) AS c FROM continuation_generation_runs/i.test(n)
      ) {
        const projectId = params[0];
        const inflight = new Set([
          'queued',
          'running',
          'awaiting_user',
          'interrupted',
        ]);
        const c = state.runs.filter(
          r => r.project_id === projectId && inflight.has(r.state),
        ).length;
        return [{ rows: { length: 1, item: () => ({ c }) } }];
      }
      if (
        /SELECT input_copy_relative_path FROM continuation_import_jobs/i.test(n)
      ) {
        const rows = state.jobs.filter(
          j => j.project_id === params[0] && j.source_id === params[1],
        );
        return [
          {
            rows: {
              length: rows.length,
              item: (i: number) => rows[i],
            },
          },
        ];
      }
      return [{ rows: { length: 0, item: () => null } }];
    });
    return { executeSql };
  }

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('returns preserved counts and never issues chapter DELETE SQL', async () => {
    const state = {
      chapters: [
        { id: 10, project_id: 1, title: '第 21 章', content: 'hello' },
        { id: 11, project_id: 1, title: '第 22 章', content: 'world' },
      ],
      sources: [{ id: 5, project_id: 1, status: 'ready' }],
      settings: [{ project_id: 1, active_source_id: 5 }],
      runs: [
        { id: 'ct1', project_id: 1, state: 'awaiting_user' },
        { id: 'ct2', project_id: 1, state: 'completed' },
      ],
      jobs: [
        {
          project_id: 1,
          source_id: 5,
          input_copy_relative_path: 'continuation-imports/x.txt',
        },
      ],
    };
    const db = makeDb(state);
    const clearSpy = jest.fn(async () => {
      // Simulate CASCADE: drop source only; chapters untouched.
      state.sources = state.sources.filter(s => s.id !== 5);
      state.settings[0].active_source_id = null as unknown as number;
      state.runs = state.runs.map(r =>
        r.state === 'awaiting_user' ? { ...r, state: 'outdated' } : r,
      );
    });
    const renumberSpy = jest.fn(async () => ({ renamed: 2 }));
    const unlinkSpy = jest.fn(async () => undefined);

    jest.doMock('../src/services/continuation/continuationSourceRepository', () => ({
      getDb: async () => db,
      getActiveSource: async () => ({ id: 5, projectId: 1, displayName: '原著' }),
      clearActiveSourceAndDelete: clearSpy,
      // re-export symbols import service may touch
      buildActivateSourceBoundaryStatements: jest.fn(),
      ensureSettingsRow: jest.fn(),
      deleteSourceCascade: jest.fn(),
      getSourceByIdInTx: jest.fn(),
      insertChapters: jest.fn(),
      insertChunks: jest.fn(),
      insertSource: jest.fn(),
      nextSourceVersionInTx: jest.fn(),
      updateSourceStatus: jest.fn(),
      validateChunkContiguity: jest.fn(),
      asSourcePosition: (n: number) => n,
      asUtf16Offset: (n: number) => n,
    }));
    jest.doMock(
      '../src/services/continuation/chapterNumbering/continuationChapterNumbering',
      () => ({
        renumberContinuationChapterTitles: renumberSpy,
      }),
    );
    jest.doMock('react-native-fs', () => ({
      DocumentDirectoryPath: '/docs',
      unlink: unlinkSpy,
      mkdir: jest.fn(),
      copyFile: jest.fn(),
    }));

    // openDatabase may be pulled transitively; stub to keep renumber isolated.
    jest.doMock('../src/data/connection/openDatabase', () => ({
      openDatabase: async () => db,
    }));

    const {
      deleteContinuationSource,
    } = require('../src/services/continuation/continuationImportService');

    const result = await deleteContinuationSource(1);

    expect(result).toEqual({
      deleted: true,
      preservedChapterCount: 2,
      outdatedRunCount: 1,
    });
    expect(clearSpy).toHaveBeenCalledWith(db, 1, 5);
    expect(renumberSpy).toHaveBeenCalledWith(1);
    expect(unlinkSpy).toHaveBeenCalledWith('/docs/continuation-imports/x.txt');
    // Chapters rows still present with original content.
    expect(state.chapters).toHaveLength(2);
    expect(state.chapters[0].content).toBe('hello');
    expect(state.chapters[1].content).toBe('world');
    // No chapter-mutating SQL was issued by the service itself.
    const sqls = db.executeSql.mock.calls.map((c: any[]) => String(c[0]));
    expect(sqls.some((s: string) => /DELETE FROM chapters/i.test(s))).toBe(
      false,
    );
    expect(sqls.some((s: string) => /UPDATE chapters/i.test(s))).toBe(false);
  });

  it('no-ops when there is no active source and still reports chapter count', async () => {
    const state = {
      chapters: [{ id: 1, project_id: 3, title: '第 1 章', content: 'x' }],
      sources: [] as Row[],
      settings: [{ project_id: 3, active_source_id: null }],
      runs: [] as Row[],
      jobs: [] as Row[],
    };
    const db = makeDb(state);
    const clearSpy = jest.fn();

    jest.doMock('../src/services/continuation/continuationSourceRepository', () => ({
      getDb: async () => db,
      getActiveSource: async () => null,
      clearActiveSourceAndDelete: clearSpy,
      buildActivateSourceBoundaryStatements: jest.fn(),
      ensureSettingsRow: jest.fn(),
      deleteSourceCascade: jest.fn(),
      getSourceByIdInTx: jest.fn(),
      insertChapters: jest.fn(),
      insertChunks: jest.fn(),
      insertSource: jest.fn(),
      nextSourceVersionInTx: jest.fn(),
      updateSourceStatus: jest.fn(),
      validateChunkContiguity: jest.fn(),
      asSourcePosition: (n: number) => n,
      asUtf16Offset: (n: number) => n,
    }));
    jest.doMock('react-native-fs', () => ({
      DocumentDirectoryPath: '/docs',
      unlink: jest.fn(),
      mkdir: jest.fn(),
      copyFile: jest.fn(),
    }));

    const {
      deleteContinuationSource,
    } = require('../src/services/continuation/continuationImportService');

    const result = await deleteContinuationSource(3);
    expect(result).toEqual({
      deleted: false,
      preservedChapterCount: 1,
      outdatedRunCount: 0,
    });
    expect(clearSpy).not.toHaveBeenCalled();
  });
});

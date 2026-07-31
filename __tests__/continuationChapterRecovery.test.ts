/**
 * Recovery project isolation: never mutates the source project's chapters.
 */
import type { RecoverableChapterBody } from '../src/services/continuation/continuationChapterRecoveryService';

describe('continuationChapterRecoveryService', () => {
  const liveChapters = [
    { id: 100, project_id: 1, title: '新线第1章', content: 'accident rewrite A', position: 0 },
    { id: 101, project_id: 1, title: '新线第2章', content: 'accident rewrite B', position: 1 },
  ];

  const revisionRows = [
    // orphan (chapter 10 deleted)
    {
      id: 1,
      target_id: 10,
      title: '旧第21章',
      content: 'old body twenty one '.repeat(3),
      created_at: '2026-07-01T00:00:00.000Z',
    },
    {
      id: 2,
      target_id: 11,
      title: '旧第22章',
      content: 'old body twenty two '.repeat(3),
      created_at: '2026-07-01T01:00:00.000Z',
    },
    // live chapter's own revision — must NOT enter orphans-only recovery
    {
      id: 3,
      target_id: 100,
      title: '新线第1章',
      content: 'accident rewrite A',
      created_at: '2026-07-30T00:00:00.000Z',
    },
  ];

  function makeDb() {
    return {
      executeSql: jest.fn(async (sql: string, params: any[] = []) => {
        const n = sql.replace(/\s+/g, ' ');
        if (/FROM content_revisions/i.test(n)) {
          return [
            {
              rows: {
                length: revisionRows.length,
                item: (i: number) => revisionRows[i],
              },
            },
          ];
        }
        if (/continuation_generation_artifacts/i.test(n)) {
          return [{ rows: { length: 0, item: () => null } }];
        }
        return [{ rows: { length: 0, item: () => null } }];
      }),
    };
  }

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('collectRecoverableChapterBodies marks deleted chapter revisions as orphan', async () => {
    const db = makeDb();
    jest.doMock('../src/data/connection/openDatabase', () => ({
      openDatabase: async () => db,
    }));
    jest.doMock('../src/data/repositories/projectRepository', () => ({
      getChaptersByProject: async () => liveChapters,
      getProjectById: async () => ({
        id: 1,
        name: '主线',
        mode: 'continuation',
      }),
      createChapter: jest.fn(),
      updateChapter: jest.fn(),
    }));
    jest.doMock(
      '../src/services/continuation/continuationProjectService',
      () => ({
        createContinuationProject: jest.fn(),
      }),
    );

    const {
      collectRecoverableChapterBodies,
    } = require('../src/services/continuation/continuationChapterRecoveryService');

    const bodies: RecoverableChapterBody[] =
      await collectRecoverableChapterBodies(1);
    expect(bodies.length).toBe(3);
    const orphans = bodies.filter(b => b.source === 'orphan_revision');
    expect(orphans).toHaveLength(2);
    expect(orphans.map(o => o.originalChapterId).sort()).toEqual([10, 11]);
  });

  it('createRecoveryProject with orphansOnly does not touch source chapters', async () => {
    const db = makeDb();
    const updateChapter = jest.fn(async () => undefined);
    const createChapter = jest.fn(async (_p: number, pos: number) => 200 + pos);
    const createContinuationProject = jest.fn(async () => ({
      id: 99,
      name: '主线（找回）',
      mode: 'continuation',
      created_at: 't',
      updated_at: 't',
    }));
    const sourceChaptersBefore = [...liveChapters];

    jest.doMock('../src/data/connection/openDatabase', () => ({
      openDatabase: async () => db,
    }));
    jest.doMock('../src/data/repositories/projectRepository', () => ({
      getChaptersByProject: async (projectId: number) => {
        if (projectId === 1) return sourceChaptersBefore;
        // seed chapter on recovery project
        if (projectId === 99) return [{ id: 500, position: 0, title: '第 1 章', content: '' }];
        return [];
      },
      getProjectById: async () => ({
        id: 1,
        name: '主线',
        mode: 'continuation',
      }),
      createChapter,
      updateChapter,
    }));
    jest.doMock(
      '../src/services/continuation/continuationProjectService',
      () => ({
        createContinuationProject,
      }),
    );

    const {
      createRecoveryProject,
    } = require('../src/services/continuation/continuationChapterRecoveryService');

    const result = await createRecoveryProject({
      sourceProjectId: 1,
      orphansAndArtifactsOnly: true,
    });

    expect(result.projectId).toBe(99);
    expect(result.chapterCount).toBe(2);
    expect(result.sources.orphan).toBe(2);
    // Source project chapter list object never mutated by recovery.
    expect(sourceChaptersBefore).toHaveLength(2);
    expect(sourceChaptersBefore[0].content).toBe('accident rewrite A');
    // Only recovery project chapters were written.
    expect(updateChapter).toHaveBeenCalled();
    const updatedIds = updateChapter.mock.calls.map((c: any[]) => c[0]);
    expect(updatedIds.every((id: number) => id === 500 || id >= 200)).toBe(
      true,
    );
    expect(createContinuationProject).toHaveBeenCalledWith({
      name: '主线（找回）',
    });
  });
});

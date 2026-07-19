import {
  createEmptyChapterMemoryPatch,
  createEmptyStoryMemory,
} from '../src/services/storyMemory/storyMemoryDefaults';
import { applyStoryMemoryPatch } from '../src/services/storyMemory/storyMemoryMerger';

const mockAll = jest.fn();
const mockOne = jest.fn();
const mockExecute = jest.fn();
const mockExecuteTransaction = jest.fn();
const mockDatabase = { name: 'test' };

jest.mock('../src/data/connection/query', () => ({
  all: (...args: unknown[]) => mockAll(...args),
  one: (...args: unknown[]) => mockOne(...args),
}));
jest.mock('../src/data/connection/execute', () => ({
  execute: (...args: unknown[]) => mockExecute(...args),
}));
jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: jest.fn(async () => mockDatabase),
}));
jest.mock('../src/data/connection/transaction', () => ({
  executeTransaction: (...args: unknown[]) => mockExecuteTransaction(...args),
}));

import {
  ensureProjectStoryMemoryRow,
  getChapterMemoryPatch,
  getProjectStoryMemory,
  markStoryMemoryDirty,
  saveStoryMemoryBatchUpdate,
  saveStoryMemoryUpdate,
} from '../src/data/repositories/storyMemoryRepository';

function appliedMemory() {
  const patch = createEmptyChapterMemoryPatch({
    chapterId: 1,
    chapterPosition: 0,
    title: '第一章',
  });
  patch.episodicSummary.brief = '发现暗门';
  return applyStoryMemoryPatch(createEmptyStoryMemory(7), patch, {
    projectId: 7,
    chapterId: 1,
    chapterPosition: 0,
    sourceFingerprint: 'source',
    now: '2026-07-18T00:00:00.000Z',
  });
}

describe('story memory repository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue({ rowsAffected: 1 });
    mockExecuteTransaction.mockResolvedValue(undefined);
  });

  it('maps project and patch JSON rows', async () => {
    const result = appliedMemory();
    mockOne
      .mockResolvedValueOnce({
        project_id: 7,
        schema_version: 1,
        through_chapter_id: 1,
        through_chapter_position: 0,
        memory_json: JSON.stringify(result.state),
        estimated_tokens: 12,
        state_fingerprint: result.state.metadata.stateFingerprint,
        last_applied_patch_id: result.resolvedPatch.patchId,
        status: 'clean',
        source: 'native',
        dirty_from_position: null,
        last_error: '',
        updated_at: '2026-07-18T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        chapter_id: 1,
        project_id: 7,
        chapter_position: 0,
        patch_id: result.resolvedPatch.patchId,
        schema_version: 1,
        source_fingerprint: 'source',
        base_memory_fingerprint: result.resolvedPatch.baseMemoryFingerprint,
        result_memory_fingerprint: result.resolvedPatch.resultMemoryFingerprint,
        episodic_summary_json: JSON.stringify(
          result.resolvedPatch.episodicSummary,
        ),
        patch_json: JSON.stringify(result.resolvedPatch.normalizedPatch),
        estimated_tokens: 10,
        status: 'applied',
        last_error: '',
        generated_at: result.resolvedPatch.generatedAt,
        applied_at: result.resolvedPatch.appliedAt,
      });
    await expect(getProjectStoryMemory(7)).resolves.toEqual(
      expect.objectContaining({ status: 'clean' }),
    );
    await expect(getChapterMemoryPatch(1)).resolves.toEqual(
      expect.objectContaining({
        status: 'applied',
        patch: expect.objectContaining({ chapterId: 1 }),
      }),
    );
  });

  it('rejects corrupted JSON instead of partially parsing it', async () => {
    mockOne.mockResolvedValueOnce({
      project_id: 7,
      memory_json: '{bad',
      status: 'failed',
    });
    await expect(getProjectStoryMemory(7)).rejects.toThrow('JSON 已损坏');
  });

  it('lazily initializes legacy projects without invoking an LLM', async () => {
    const state = createEmptyStoryMemory(7);
    mockOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ position: 2 })
      .mockResolvedValueOnce({
        project_id: 7,
        memory_json: JSON.stringify(state),
        status: 'empty',
        source: 'native',
        state_fingerprint: state.metadata.stateFingerprint,
        estimated_tokens: state.metadata.estimatedTokens,
        dirty_from_position: 2,
        last_error: '',
        updated_at: '2026-07-18T00:00:00.000Z',
        through_chapter_id: null,
        through_chapter_position: -1,
        last_applied_patch_id: null,
      });
    await expect(ensureProjectStoryMemoryRow(7)).resolves.toEqual(
      expect.objectContaining({ dirtyFromPosition: 2 }),
    );
    expect(mockExecute).toHaveBeenCalledWith(
      mockDatabase,
      expect.stringContaining('INSERT OR IGNORE INTO project_story_memory'),
      expect.arrayContaining([
        7,
        expect.any(String),
        expect.any(Number),
        expect.any(String),
        2,
      ]),
    );
  });

  it('keeps the earliest dirty position', async () => {
    const state = createEmptyStoryMemory(7);
    mockOne.mockResolvedValueOnce({
      project_id: 7,
      memory_json: JSON.stringify(state),
      status: 'dirty',
      source: 'native',
      state_fingerprint: state.metadata.stateFingerprint,
      estimated_tokens: 0,
      dirty_from_position: 3,
      last_error: '',
      updated_at: '',
      through_chapter_id: null,
      through_chapter_position: -1,
      last_applied_patch_id: null,
    });
    await markStoryMemoryDirty(7, 8, '章节已修改');
    // Dirty mark + applied-batch invalidation share one transaction.
    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1);
    const statements = mockExecuteTransaction.mock.calls[0][1] as Array<{
      sql: string;
      params?: unknown[];
    }>;
    expect(statements[0].sql).toEqual(
      expect.stringContaining('dirty_from_position = CASE'),
    );
    expect(statements[0].params).toEqual(
      expect.arrayContaining([8, 8, 8, '章节已修改']),
    );
    // Dirty must invalidate applied batches from the edit point forward so
    // rebuild cannot reuse a pre-edit checkpoint chain.
    expect(statements[1].sql).toEqual(
      expect.stringContaining("status = 'invalidated'"),
    );
    expect(statements[1].params).toEqual(
      expect.arrayContaining([
        expect.stringContaining('已覆盖章节已变更'),
        7,
        8,
      ]),
    );
  });

  it('persists patch, state, episodic memory and snapshot in one transaction', async () => {
    const result = appliedMemory();
    await saveStoryMemoryUpdate({
      state: result.state,
      patch: result.resolvedPatch,
      episodicMemoryText: '核心事件：发现暗门',
      finalizedAt: '2026-07-18T00:00:00.000Z',
      createSnapshot: true,
    });
    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1);
    const statements = mockExecuteTransaction.mock.calls[0][1];
    expect(
      statements.map((item: { sql: string }) => item.sql).join('\n'),
    ).toEqual(expect.stringContaining('chapter_memory_patches'));
    expect(
      statements.map((item: { sql: string }) => item.sql).join('\n'),
    ).toEqual(expect.stringContaining('project_story_memory'));
    expect(
      statements.map((item: { sql: string }) => item.sql).join('\n'),
    ).toEqual(expect.stringContaining('UPDATE chapters SET memory_summary'));
    expect(
      statements.map((item: { sql: string }) => item.sql).join('\n'),
    ).toEqual(expect.stringContaining('story_memory_snapshots'));
  });

  it('guards a batch update with an atomic persisted-fingerprint check', async () => {
    const state = createEmptyStoryMemory(7);
    state.metadata.stateFingerprint = 'result-fingerprint';
    await saveStoryMemoryBatchUpdate({
      previousFingerprint: 'persisted-before-rebuild',
      state,
      batch: {
        schemaVersion: 2,
        batchId: 'batch-1',
        projectId: 7,
        fromChapterId: 1,
        fromPosition: 0,
        throughChapterId: 3,
        throughPosition: 2,
        sourceFingerprint: 'source',
        baseStateFingerprint: 'snapshot-base',
        resultStateFingerprint: 'result-fingerprint',
        patch: {} as any,
        chapterSummaries: [],
        estimatedTokens: 10,
        status: 'applied',
        lastError: '',
        generatedAt: '2026-07-18T00:00:00.000Z',
        appliedAt: '2026-07-18T00:00:00.000Z',
      },
      chapterSummaries: [],
      createSnapshot: false,
    });

    expect(mockOne).not.toHaveBeenCalled();
    const first = mockExecuteTransaction.mock.calls[0][1][0];
    expect(first.sql).toContain(
      'SELECT state_fingerprint FROM project_story_memory',
    );
    expect(first.sql).toContain("status <> 'dirty'");
    expect(first.sql).toContain('ELSE NULL');
    expect(first.params).toEqual(
      expect.arrayContaining([7, 'persisted-before-rebuild', 'snapshot-base']),
    );
  });

  it('surfaces transaction failures without partial fallback writes', async () => {
    mockExecuteTransaction.mockRejectedValueOnce(new Error('rollback'));
    const result = appliedMemory();
    await expect(
      saveStoryMemoryUpdate({
        state: result.state,
        patch: result.resolvedPatch,
        episodicMemoryText: '事件',
        finalizedAt: '2026-07-18T00:00:00.000Z',
      }),
    ).rejects.toThrow('rollback');
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

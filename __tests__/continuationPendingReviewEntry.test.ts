/**
 * Pending review recovery: unadopted awaiting_user runs must be discoverable
 * by chapter/project so users can re-open ContinuationResult after leaving.
 */
import { openDatabase } from '../src/data/connection/openDatabase';
import {
  findLatestPendingReviewRunForChapter,
  listPendingReviewRunsForProject,
  newContinuationRunId,
} from '../src/services/continuation/generation/generationRepository';

jest.mock('../src/data/connection/openDatabase');

type RunRow = Record<string, unknown>;

function makeDb(rows: RunRow[]) {
  return {
    executeSql: jest.fn(async (sql: string, params: unknown[] = []) => {
      let filtered = [...rows];
      // Match on the WHERE clause only: the metadata projection SELECT
      // also lists project_id / chapter_id as plain columns.
      if (/WHERE[\s\S]*chapter_id = \?/i.test(sql)) {
        const projectId = params[0];
        const chapterId = params[1];
        filtered = filtered.filter(
          r => r.project_id === projectId && r.chapter_id === chapterId,
        );
      } else if (/WHERE[\s\S]*project_id = \?/i.test(sql)) {
        const projectId = params[0];
        filtered = filtered.filter(r => r.project_id === projectId);
      }
      if (
        sql.includes("state = 'awaiting_user'") ||
        sql.includes("state IN ('awaiting_user', 'awaiting_regeneration')")
      ) {
        filtered = filtered.filter(
          r =>
            r.state === 'awaiting_user' || r.state === 'awaiting_regeneration',
        );
      }
      if (sql.includes("state = 'completed'")) {
        filtered = filtered.filter(r => r.state === 'completed');
      }
      // ORDER BY updated_at DESC
      filtered.sort((a, b) =>
        String(b.updated_at).localeCompare(String(a.updated_at)),
      );
      if (sql.includes('LIMIT 1') || (params[1] === 1 && sql.includes('LIMIT'))) {
        filtered = filtered.slice(0, 1);
      } else if (typeof params[1] === 'number' && sql.includes('LIMIT')) {
        filtered = filtered.slice(0, params[1]);
      }
      return [
        {
          rows: {
            length: filtered.length,
            item: (i: number) => filtered[i],
          },
        },
      ];
    }),
  };
}

function baseRow(overrides: RunRow): RunRow {
  return {
    id: 'ct_1',
    project_id: 1,
    chapter_id: 10,
    target_position: 0,
    source_id: null,
    source_snapshot_json: '{}',
    canon_snapshot_id: null,
    canon_revision: 0,
    story_memory_fingerprint: '',
    story_memory_through_position: -1,
    input_revision_hash: '',
    user_instruction: 'test',
    settings_snapshot_json: '{}',
    context_snapshot_json: null,
    context_trace_json: null,
    token_usage_json: '{}',
    state: 'awaiting_user',
    stage: 'awaiting_user',
    completion_reason: null,
    adopted_revision_hash: null,
    finalized_revision_hash: null,
    error_code: null,
    error_message: null,
    created_at: '2026-08-04T00:00:00.000Z',
    updated_at: '2026-08-04T00:00:00.000Z',
    completed_at: null,
    ...overrides,
  };
}

describe('pending continuation review recovery', () => {
  test('findLatestPendingReviewRunForChapter returns newest awaiting_user only', async () => {
    const rows = [
      baseRow({
        id: 'ct_old',
        state: 'awaiting_user',
        updated_at: '2026-08-04T01:00:00.000Z',
      }),
      baseRow({
        id: 'ct_new',
        state: 'awaiting_user',
        updated_at: '2026-08-04T02:00:00.000Z',
      }),
      baseRow({
        id: 'ct_done',
        state: 'completed',
        completion_reason: 'adopted',
        updated_at: '2026-08-04T03:00:00.000Z',
      }),
    ];
    (openDatabase as jest.Mock).mockResolvedValue(makeDb(rows));
    const run = await findLatestPendingReviewRunForChapter(1, 10);
    expect(run?.id).toBe('ct_new');
  });

  test('listPendingReviewRunsForProject ignores non-awaiting runs', async () => {
    const rows = [
      baseRow({ id: 'ct_a', chapter_id: 1, state: 'awaiting_user' }),
      baseRow({ id: 'ct_b', chapter_id: 2, state: 'running' }),
      baseRow({ id: 'ct_c', chapter_id: 3, state: 'cancelled' }),
    ];
    (openDatabase as jest.Mock).mockResolvedValue(makeDb(rows));
    const runs = await listPendingReviewRunsForProject(1);
    expect(runs.map(r => r.id)).toEqual(['ct_a']);
  });

  test('newContinuationRunId is non-empty', () => {
    expect(newContinuationRunId().length).toBeGreaterThan(4);
  });
});

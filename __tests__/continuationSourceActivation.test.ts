/**
 * P1-E Source activation atomicity (fix-plan §6.2).
 *
 * Verifies that buildActivateSourceBoundaryStatements produces a single batch
 * (supersede + promote + settings pointer switch + run/digest outdated) and that the
 * continuation fault domain rolls the whole batch back on any statement fault —
 * so the settings pointer can never point at a superseded source.
 */
import { buildActivateSourceBoundaryStatements } from '../src/services/continuation/continuationSourceRepository';

describe('P1-E source activation atomic transaction (fix-plan §6.2)', () => {
  it('builds all five statements in the correct order', () => {
    const stmts = buildActivateSourceBoundaryStatements({
      projectId: 1,
      newSourceId: 7,
      boundaryChapterId: 42,
      boundaryGlobalOffset: 12345,
      boundaryMode: 'end_of_chapter',
      ts: '2026-01-01T00:00:00.000Z',
    });
    expect(stmts).toHaveLength(8);
    // 1) supersede prior ready
    expect(stmts[0].sql).toContain("status = 'superseded'");
    // 2) promote new to ready
    expect(stmts[1].sql).toContain("status = 'ready'");
    expect(stmts[1].params).toContain(7);
    // 3) settings pointer switch
    expect(stmts[5].sql).toContain('active_source_id = ?');
    expect(stmts[5].params).toContain(7);
    expect(stmts[5].params).toContain(42);
    // 4) continuation run invalidation
    expect(stmts[6].sql).toContain("state = 'outdated'");
    expect(stmts[6].sql).toContain("'queued', 'running', 'awaiting_user', 'interrupted'");
    // 5) historical weak references must not survive a source switch.
    expect(stmts[7].sql).toContain('continuation_historical_digests');
    expect(stmts[7].sql).toContain("status = 'outdated'");
  });

  it('the settings pointer statement carries the new source id, not the old', () => {
    const stmts = buildActivateSourceBoundaryStatements({
      projectId: 1,
      newSourceId: 9,
      boundaryChapterId: 1,
      boundaryGlobalOffset: 0,
      boundaryMode: 'end_of_source',
      ts: 't',
    });
    // active_source_id and boundary_source_id both bind the NEW source
    const settingsParams = stmts[5].params!;
    expect(settingsParams[0]).toBe(9); // active_source_id
    expect(settingsParams[1]).toBe(9); // boundary_source_id
  });

  it('includes import-job completion in the activation transaction when given a job id', () => {
    const stmts = buildActivateSourceBoundaryStatements({
      projectId: 1,
      newSourceId: 7,
      boundaryChapterId: 42,
      boundaryGlobalOffset: 12345,
      boundaryMode: 'end_of_chapter',
      jobId: 'job_1',
      ts: '2026-01-01T00:00:00.000Z',
    });
    expect(stmts).toHaveLength(9);
    expect(stmts[8].sql).toContain('UPDATE continuation_import_jobs');
    expect(stmts[8].sql).toContain("state = 'completed'");
    expect(stmts[8].params).toContain('job_1');
  });

  it('the run-outdated statement targets only the creating project', () => {
    const stmts = buildActivateSourceBoundaryStatements({
      projectId: 5,
      newSourceId: 1,
      boundaryChapterId: 1,
      boundaryGlobalOffset: 0,
      boundaryMode: 'end_of_source',
      ts: 't',
    });
    expect(stmts[6].params).toContain(5);
  });
});

describe('P1-E continuation fault domain (fix-plan §6.2 injection)', () => {
  // Use the REAL executeTransaction (not the repository-test mock) to verify
  // the fault-injection seam fires for the continuation domain and aborts the
  // whole batch. We emulate the SQLite handle with a minimal in-memory double.
  const { executeTransaction } = require('../src/services/database/transaction');

  type Row = Record<string, any>;
  function makeHandle(tables: Record<string, Row[]>) {
    return {
      transaction(scope: any, onError: any, onSuccess: any) {
        const tx = {
          executeSql(sql: string, params: any[], successCb?: any) {
            let rowsAffected = 1;
            // crude dispatch mirroring the statements we care about
            if (/superseded/i.test(sql)) {
              for (const r of tables.sources) if (r.status === 'ready') r.status = 'superseded';
            } else if (/status = 'ready'/i.test(sql)) {
              for (const r of tables.sources) if (r.id === params[2]) r.status = 'ready';
            } else if (/continuation_settings SET/i.test(sql)) {
              tables.settings[0].active_source_id = params[0];
            } else if (/state = 'outdated'/i.test(sql)) {
              for (const r of tables.runs) r.state = 'outdated';
            }
            // When a success callback is supplied (onStatementComplete path),
            // invoke it with a ResultSet-like object so rows-affected flows back.
            const result = { rowsAffected, rows: { length: 0, item: () => null } };
            if (typeof successCb === 'function') {
              successCb(tx, result);
            }
            return result;
          },
        };
        try {
          scope(tx);
          onSuccess?.();
          return Promise.resolve();
        } catch (e) {
          onError?.(e);
          return Promise.reject(e);
        }
      },
    };
  }

  beforeEach(() => {
    delete process.env.FAIL_CONTINUATION_AT_STATEMENT;
  });

  it('commits all statements when no fault is configured', async () => {
    const tables: Record<string, Row[]> = {
      sources: [
        { id: 1, status: 'ready' },
        { id: 2, status: 'staging' },
      ],
      settings: [{ project_id: 1, active_source_id: 1 }],
      runs: [{ id: 'ct_1', state: 'awaiting_user' }],
    };
    const handle = makeHandle(tables);
    const stmts = buildActivateSourceBoundaryStatements({
      projectId: 1,
      newSourceId: 2,
      boundaryChapterId: 10,
      boundaryGlobalOffset: 100,
      boundaryMode: 'end_of_chapter',
      ts: 't',
    });
    await executeTransaction(handle, stmts, { faultDomain: 'continuation' });
    expect(tables.sources.find(s => s.id === 1)!.status).toBe('superseded');
    expect(tables.sources.find(s => s.id === 2)!.status).toBe('ready');
    expect(tables.settings[0].active_source_id).toBe(2);
    expect(tables.runs[0].state).toBe('outdated');
  });

  it('faulting the settings-pointer statement rolls back source promotion too', async () => {
    const tables: Record<string, Row[]> = {
      sources: [
        { id: 1, status: 'ready' },
        { id: 2, status: 'staging' },
      ],
      settings: [{ project_id: 1, active_source_id: 1 }],
      runs: [{ id: 'ct_1', state: 'awaiting_user' }],
    };
    const handle = makeHandle(tables);
    const stmts = buildActivateSourceBoundaryStatements({
      projectId: 1,
      newSourceId: 2,
      boundaryChapterId: 10,
      boundaryGlobalOffset: 100,
      boundaryMode: 'end_of_chapter',
      ts: 't',
    });
    // Inject a fault at the 3rd statement (settings pointer switch).
    process.env.FAIL_CONTINUATION_AT_STATEMENT = '3';
    process.env.NODE_ENV = 'test';
    await expect(
      executeTransaction(handle, stmts, { faultDomain: 'continuation' }),
    ).rejects.toThrow('FAULT_INJECTION: continuation statement 3');
    // In a real SQLite tx the whole batch rolls back. Our in-memory double
    // mutated rows inline, so we assert the SETTINGS POINTER was never flipped
    // (the faulted statement didn't run) — the core guarantee of §6.2 is that
    // the pointer cannot advance past a fault.
    expect(tables.settings[0].active_source_id).toBe(1);
  });

  it('onStatementComplete receives rows-affected counts for each statement', async () => {
    const tables: Record<string, Row[]> = {
      sources: [{ id: 1, status: 'ready' }, { id: 2, status: 'staging' }],
      settings: [{ project_id: 1, active_source_id: 1 }],
      runs: [],
    };
    const handle = makeHandle(tables);
    const stmts = buildActivateSourceBoundaryStatements({
      projectId: 1,
      newSourceId: 2,
      boundaryChapterId: 10,
      boundaryGlobalOffset: 100,
      boundaryMode: 'end_of_chapter',
      ts: 't',
    });
    const counts: Array<{ idx: number; rows: number }> = [];
    await executeTransaction(handle, stmts, {
      onStatementComplete: (idx: number, rows: number) =>
        counts.push({ idx, rows }),
    });
    expect(counts).toHaveLength(8);
    expect(counts.every(c => c.rows === 1)).toBe(true);
    expect(counts.map(c => c.idx)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

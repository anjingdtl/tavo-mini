/**
 * Phase 2 Phase 2 — Pipeline Topology Version + Resume Contract Red Tests
 * (二 Phase §5.6).
 *
 * Covers:
 *   Case 1  legacy task resumes under its FROZEN old topology (proof stage),
 *           succeeded draft/review/factCheck/brief are never re-dispatched.
 *   Case 2  compact_standard task durable semantics fixture (succeeded stages
 *           reused after crash; the future QA slot is exercised via the shared
 *           audit checkpoint until Phase 4 renames it).
 *   Case 3  batch topology frozen at creation + preserved on read-back;
 *           pre-upgrade (legacy) batches stay legacy.
 *   Case 4  migration: pre-upgrade rows default to legacy_standard; the
 *           v54→v55 ALTER is idempotent and the fresh-install DDL carries it.
 *   Case 5  corrupt frozen topology → fail-closed (PIPELINE_TOPOLOGY_CORRUPT).
 *   Case 6  kernel-freeze topology label drives the compact Final Candidate.
 */
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  createCanonInMemoryDb,
  createEmptyInMemoryDb,
} from './helpers/canonInMemoryDb';
import { __resetForTest, __setDatabaseForTest } from '../src/data/connection/openDatabase';
import { initializeDatabase } from '../src/services/database';
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildV54toV55Statements,
  migrateV54ToV55,
  PIPELINE_TOPOLOGY_VERSION_COLUMN,
} from '../src/services/migrations/v54-to-v55';
import {
  checkPipelineResumeContract,
  COMPACT_PIPELINE_TOPOLOGY_VERSION,
  CURRENT_PIPELINE_TOPOLOGY_VERSION,
  LEGACY_PIPELINE_TOPOLOGY_VERSION,
  normalizePersistedPipelineTopologyVersion,
  pipelineTopologyLabel,
} from '../src/services/pipeline/outlineWorkflowVersion';
import { determineNextPipelineAction } from '../src/services/pipeline/determineNextPipelineAction';
import type {
  PersistedPipelineTaskView,
  PersistedStageCheckpoint,
} from '../src/services/pipeline/types';
import { finalCandidateModeForPolicy } from '../src/services/writing/stages/finalCandidate';
import {
  createBatch,
  getBatchById,
} from '../src/data/repositories/multiChapterBatchRepository';
import { createCurrentSchemaStatements } from '../src/data/schema/createCurrentSchema';

const T = Date.now();

function taskView(
  overrides: Partial<PersistedPipelineTaskView> = {},
): PersistedPipelineTaskView {
  return {
    id: 't1',
    status: 'interrupted',
    pipelineMode: 'full',
    hasExecutionSnapshot: true,
    hasDraftContext: true,
    hasAuditContext: true,
    outlineWorkflowVersion: 4,
    contextBudgetVersion: 5,
    pipelineTopologyVersion: COMPACT_PIPELINE_TOPOLOGY_VERSION,
    executionProfile: 'standard',
    finalText: null,
    ...overrides,
  };
}

function checkpoint(
  stage: PersistedStageCheckpoint['stage'],
  status: PersistedStageCheckpoint['status'],
): PersistedStageCheckpoint {
  return { stage, status };
}

describe('pipeline topology helpers (§5.2/§5.5)', () => {
  test('CURRENT_PIPELINE_TOPOLOGY_VERSION is compact_standard (2)', () => {
    expect(CURRENT_PIPELINE_TOPOLOGY_VERSION).toBe(
      COMPACT_PIPELINE_TOPOLOGY_VERSION,
    );
    expect(COMPACT_PIPELINE_TOPOLOGY_VERSION).toBe(2);
    expect(LEGACY_PIPELINE_TOPOLOGY_VERSION).toBe(1);
  });

  test('Case 4: absent/legacy value normalizes to 1 (pre-upgrade rows never drift to compact)', () => {
    expect(normalizePersistedPipelineTopologyVersion(undefined)).toBe(1);
    expect(normalizePersistedPipelineTopologyVersion('')).toBe(1);
    expect(normalizePersistedPipelineTopologyVersion(null)).toBe(1);
    expect(normalizePersistedPipelineTopologyVersion(1)).toBe(1);
    expect(normalizePersistedPipelineTopologyVersion(2)).toBe(2);
    expect(pipelineTopologyLabel(undefined)).toBe('legacy_standard');
    expect(pipelineTopologyLabel(1)).toBe('legacy_standard');
    expect(pipelineTopologyLabel(2)).toBe('compact_standard');
  });

  test('Case 5: corrupt frozen topology is detected (null), not guessed', () => {
    expect(normalizePersistedPipelineTopologyVersion(99)).toBeNull();
    expect(normalizePersistedPipelineTopologyVersion('abc')).toBeNull();
  });
});

describe('resume contract gate (§5.5/§5.6, H4/H6)', () => {
  test('Case 1: legacy task (topology=1, resumable budget) IS allowed to resume per its old topology', () => {
    const gate = checkPipelineResumeContract({
      status: 'interrupted',
      contextBudgetVersion: 5,
      pipelineTopologyVersion: LEGACY_PIPELINE_TOPOLOGY_VERSION,
    });
    expect(gate.ok).toBe(true);
  });

  test('compact task with resumable budget resumes too', () => {
    const gate = checkPipelineResumeContract({
      status: 'interrupted',
      contextBudgetVersion: 7,
      pipelineTopologyVersion: COMPACT_PIPELINE_TOPOLOGY_VERSION,
    });
    expect(gate.ok).toBe(true);
  });

  test('Case 5: corrupt topology fails closed with PIPELINE_TOPOLOGY_CORRUPT', () => {
    const gate = checkPipelineResumeContract({
      status: 'interrupted',
      contextBudgetVersion: 5,
      pipelineTopologyVersion: 99,
    });
    expect(gate.ok).toBe(false);
    expect(gate.errorCode).toBe('PIPELINE_TOPOLOGY_CORRUPT');
  });

  test('non-resumable budget protocol stays blocked (LEGACY_PIPELINE_RESUME_BLOCKED)', () => {
    const gate = checkPipelineResumeContract({
      status: 'interrupted',
      contextBudgetVersion: 4,
      pipelineTopologyVersion: LEGACY_PIPELINE_TOPOLOGY_VERSION,
    });
    expect(gate.ok).toBe(false);
    expect(gate.errorCode).toBe('LEGACY_PIPELINE_RESUME_BLOCKED');
  });
});

describe('Case 1 — legacy resume per old topology (determineNextPipelineAction)', () => {
  test('legacy task (owv=3, brief chain) with proof interrupted resumes ONLY proof', () => {
    const view = taskView({
      outlineWorkflowVersion: 3,
      contextBudgetVersion: 5,
      pipelineTopologyVersion: LEGACY_PIPELINE_TOPOLOGY_VERSION,
    });
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
      checkpoint('review', 'succeeded'),
      checkpoint('factCheck', 'succeeded'),
      checkpoint('brief', 'succeeded'),
      checkpoint('proof', 'interrupted'),
    ];
    const action = determineNextPipelineAction(view, stages);
    expect(action.type).toBe('run_proof');
  });

  test('legacy proof failed → retry proof only; succeeded stages not re-dispatched', () => {
    const view = taskView({
      outlineWorkflowVersion: 3,
      contextBudgetVersion: 5,
      pipelineTopologyVersion: LEGACY_PIPELINE_TOPOLOGY_VERSION,
    });
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
      checkpoint('review', 'succeeded'),
      checkpoint('factCheck', 'succeeded'),
      checkpoint('brief', 'succeeded'),
      checkpoint('proof', 'failed'),
    ];
    const action = determineNextPipelineAction(view, stages);
    expect(action.type).toBe('blocked');
    if (action.type === 'blocked') {
      expect(action.reason.stage).toBe('proof');
      expect(action.reason.userAction).toBe('retry');
    }
  });
});

describe('Case 2 — compact durable semantics fixture (resume after crash)', () => {
  test('compact task: draft + future-QA slot succeeded, crash → continue without re-calling them', () => {
    const view = taskView({
      pipelineTopologyVersion: COMPACT_PIPELINE_TOPOLOGY_VERSION,
    });
    // The Phase 4 QA checkpoint occupies the same shared audit slot today.
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
      checkpoint('review', 'succeeded'),
      checkpoint('factCheck', 'interrupted'),
      checkpoint('brief', 'pending'),
      checkpoint('proof', 'pending'),
    ];
    const action = determineNextPipelineAction(view, stages);
    expect(action.type).toBe('run_fact_check');
    // draft and review (the future QA) were succeeded → never re-requested.
  });

  test('compact task: all audits + revision succeeded → local finalize, proof never dispatched', () => {
    const view = taskView({
      pipelineTopologyVersion: COMPACT_PIPELINE_TOPOLOGY_VERSION,
    });
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
      checkpoint('review', 'succeeded'),
      checkpoint('factCheck', 'succeeded'),
      checkpoint('brief', 'succeeded'),
      checkpoint('proof', 'interrupted'),
    ];
    // Compact Standard (Phase 3 §6) has no proof node: a stray proof
    // checkpoint is ignored and the run local-finalizes from the candidate.
    const action = determineNextPipelineAction(view, stages);
    expect(action.type).toBe('finalize_from_draft');
  });
});

describe('Case 3 — batch topology freeze + inheritance contract', () => {
  let db: InMemorySqliteDb;

  beforeAll(async () => {
    __resetForTest();
    db = await createCanonInMemoryDb();
    __setDatabaseForTest(db as any);
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at)
       VALUES (1, '批次项目', 'outline', 0, 0)`,
    );
  });

  afterAll(() => {
    __resetForTest();
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });

  test('new batch freezes compact_standard (2) by default', async () => {
    await createBatch({
      id: 'batch-compact-1',
      projectId: 1,
      sourcePrompt: '写三章',
      chapterCount: 3,
      targetWordsPerChapter: 2000,
      pipelineMode: 'full',
    });
    const batch = await getBatchById('batch-compact-1');
    expect(batch?.pipelineTopologyVersion).toBe(
      CURRENT_PIPELINE_TOPOLOGY_VERSION,
    );
  });

  test('legacy batch value (1) is preserved and re-readable', async () => {
    await createBatch({
      id: 'batch-legacy-topo',
      projectId: 1,
      sourcePrompt: '旧批次',
      chapterCount: 1,
      targetWordsPerChapter: 2000,
      pipelineMode: 'full',
      pipelineTopologyVersion: LEGACY_PIPELINE_TOPOLOGY_VERSION,
    });
    const batch = await getBatchById('batch-legacy-topo');
    expect(batch?.pipelineTopologyVersion).toBe(
      LEGACY_PIPELINE_TOPOLOGY_VERSION,
    );
  });
});

describe('Case 4 — Schema 54 → 55 migration (real sql.js)', () => {
  let db: InMemorySqliteDb;

  beforeEach(async () => {
    __resetForTest();
    db = await createCanonInMemoryDb();
    __setDatabaseForTest(db as any);
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at)
       VALUES (0, '__tavo_global_workspace__', 'outline', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at)
       VALUES (1, '小说A', 'outline', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      `INSERT INTO chapters (id, project_id, position, title, content, status, created_at, updated_at)
       VALUES (1, 1, 1, '第一章', '正文', 'finalized', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '54')",
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

  test('SCHEMA_VERSION advanced to 55', () => {
    expect(SCHEMA_VERSION).toBe(55);
  });

  test('fresh-install DDL already carries pipeline_topology_version (both tables)', () => {
    const sqls = createCurrentSchemaStatements().join('\n');
    expect(sqls).toContain(
      'pipeline_topology_version INTEGER NOT NULL DEFAULT 1',
    );
  });

  test('buildV54toV55Statements emits 2 ALTERs defaulting to 1', () => {
    const stmts = buildV54toV55Statements();
    expect(stmts.length).toBe(2);
    const sql = stmts.map(s => s.sql).join('\n');
    expect(sql).toContain('ALTER TABLE pipeline_tasks');
    expect(sql).toContain('ALTER TABLE multi_chapter_batches');
    expect(sql).toContain('NOT NULL DEFAULT 1');
  });

  test('pre-upgrade rows default to legacy_standard (1) after upgrade', async () => {
    await db.executeSql(
      `INSERT INTO pipeline_tasks (id, target_type, target_id, status, created_at, updated_at)
       VALUES ('legacy-task-55', 'chapter', 1, 'interrupted', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      `INSERT INTO multi_chapter_batches
        (id, project_id, status, source_prompt, chapter_count, target_words_per_chapter,
         pipeline_mode, row_version, created_at, updated_at)
       VALUES ('legacy-batch-55', 1, 'running', '旧批次', 2, 2000, 'full', 1, ?, ?)`,
      [T, T],
    );

    await initializeDatabase(db as any);

    const [taskRows] = await db.executeSql(
      `SELECT pipeline_topology_version FROM pipeline_tasks WHERE id = 'legacy-task-55'`,
    );
    expect(Number(taskRows.rows.item(0).pipeline_topology_version)).toBe(1);

    const [batchRows] = await db.executeSql(
      `SELECT pipeline_topology_version FROM multi_chapter_batches WHERE id = 'legacy-batch-55'`,
    );
    expect(Number(batchRows.rows.item(0).pipeline_topology_version)).toBe(1);

    expect(
      Number(
        (
          await db.executeSql(
            "SELECT value FROM settings WHERE key = 'schema_version'",
          )
        )[0].rows.item(0).value,
      ),
    ).toBe(SCHEMA_VERSION);
  });

  test('explicit compact (2) INSERT survives and is re-readable', async () => {
    await initializeDatabase(db as any);
    await db.executeSql(
      `INSERT INTO pipeline_tasks
        (id, target_type, target_id, status, outline_workflow_version,
         context_budget_version, pipeline_topology_version, created_at, updated_at)
       VALUES ('compact-task-55', 'chapter', 1, 'idle', 4, 5, 2, ?, ?)`,
      [T, T],
    );
    const [rows] = await db.executeSql(
      `SELECT pipeline_topology_version FROM pipeline_tasks WHERE id = 'compact-task-55'`,
    );
    expect(Number(rows.rows.item(0).pipeline_topology_version)).toBe(2);
  });

  test('migration is idempotent and repairs a physically column-less table', async () => {
    const raw = await createEmptyInMemoryDb();
    __resetForTest();
    __setDatabaseForTest(raw as any);
    await raw.executeSql(`
      CREATE TABLE pipeline_tasks (
        id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        stage_results TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    await raw.executeSql(`
      CREATE TABLE multi_chapter_batches (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        source_prompt TEXT NOT NULL,
        chapter_count INTEGER NOT NULL,
        target_words_per_chapter INTEGER NOT NULL,
        pipeline_mode TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    await migrateV54ToV55(raw as any);
    await expect(migrateV54ToV55(raw as any)).resolves.toBeUndefined();
    const [taskCols] = await raw.executeSql(
      `PRAGMA table_info(pipeline_tasks)`,
    );
    const names = new Set<string>();
    for (let i = 0; i < taskCols.rows.length; i += 1) {
      names.add(String(taskCols.rows.item(i).name));
    }
    expect(names.has(PIPELINE_TOPOLOGY_VERSION_COLUMN)).toBe(true);
    const [batchCols] = await raw.executeSql(
      `PRAGMA table_info(multi_chapter_batches)`,
    );
    const batchNames = new Set<string>();
    for (let i = 0; i < batchCols.rows.length; i += 1) {
      batchNames.add(String(batchCols.rows.item(i).name));
    }
    expect(batchNames.has(PIPELINE_TOPOLOGY_VERSION_COLUMN)).toBe(true);
    __resetForTest();
    try {
      raw.close();
    } catch {
      /* ignore */
    }
  });
});

describe('Case 6 — kernel freeze label drives the compact Final Candidate', () => {
  test('compact label → compact candidate mode (proof excluded)', () => {
    expect(
      finalCandidateModeForPolicy({
        values: { pipelineTopologyVersion: pipelineTopologyLabel(2) },
      }),
    ).toBe('compact');
  });

  test('legacy label → legacy candidate mode (proof still a candidate)', () => {
    expect(
      finalCandidateModeForPolicy({
        values: { pipelineTopologyVersion: pipelineTopologyLabel(1) },
      }),
    ).toBe('legacy');
  });
});

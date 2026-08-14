/**
 * Continuation batch execution adapter integration tests
 * (Round 5–9: adapter wiring, auto adoption, finalize, state gate, serial
 * orchestration, resume cases, fault injection FI-01..FI-10).
 *
 * Real SQLite (batch tables / chapters / story memory) via the in-memory
 * helper; the Continuation V5 boundary (runner + repository + reader + canon)
 * is simulated with controllable mocks so every crash window and terminal
 * state can be scripted deterministically.
 */
jest.mock('../src/services/continuation/generation/generationRepository', () => {
  const actual = jest.requireActual(
    '../src/services/continuation/generation/generationRepository',
  );
  return {
    ...actual,
    getRunById: (...args: any[]) => (mockRepo.getRunById as any)(...args),
    listRunsForProject: (...args: any[]) =>
      (mockRepo.listRunsForProject as any)(...args),
    getLatestArtifactForStage: (...args: any[]) =>
      (mockRepo.getLatestArtifactForStage as any)(...args),
    listChecksForArtifact: (...args: any[]) =>
      (mockRepo.listChecksForArtifact as any)(...args),
    getOutboxByDedupe: (...args: any[]) => (mockRepo.getOutboxByDedupe as any)(...args),
    getOutboxSummary: (...args: any[]) => (mockRepo.getOutboxSummary as any)(...args),
    findLatestAdoptedRunForChapter: (...args: any[]) =>
      (mockRepo.findLatestAdoptedRunForChapter as any)(...args),
  };
});

jest.mock(
  '../src/services/continuation/generation/continuationGenerationRunner',
  () => {
    const actual = jest.requireActual(
      '../src/services/continuation/generation/continuationGenerationRunner',
    );
    return {
      ...actual,
      startContinuationRun: (...args: any[]) =>
        (mockRunner.startContinuationRun as any)(...args),
      adoptArtifactAsDraft: (...args: any[]) =>
        (mockRunner.adoptArtifactAsDraft as any)(...args),
      finalizeContinuationChapter: (...args: any[]) =>
        (mockRunner.finalizeContinuationChapter as any)(...args),
      cancelContinuationRun: (...args: any[]) =>
        (mockRunner.cancelContinuationRun as any)(...args),
      resumeInterruptedRun: (...args: any[]) =>
        (mockRunner.resumeInterruptedRun as any)(...args),
    };
  },
);

jest.mock('../src/services/continuation/continuationSourceReader', () => ({
  continuationSourceReader: {
    getSnapshot: jest.fn(async () => mockWorld.sourceSnapshot),
    listBoundedSourceChapters: jest.fn(async () => []),
    listBoundedSourceChaptersForRange: jest.fn(async () => []),
    listBoundedSourceChapterMetas: jest.fn(async () => []),
  },
}));

jest.mock('../src/services/continuation/canon/canonQueryService', () => ({
  CanonQueryService: {
    getActiveSnapshot: jest.fn(async () => mockWorld.canonSnapshot),
    getContextBundle: jest.fn(),
  },
}));

jest.mock(
  '../src/services/continuation/generation/continuationStateOutboxWorker',
  () => ({
    processContinuationOutbox: jest.fn(async () => ({
      processed: 0,
      failed: 0,
    })),
  }),
);

jest.mock('../src/native/PipelineForegroundModule', () => ({
  PipelineForeground: {
    start: jest.fn(() => Promise.resolve()),
    updateProgress: jest.fn(() => Promise.resolve()),
    notifyComplete: jest.fn(() => Promise.resolve()),
    notifyFailed: jest.fn(() => Promise.resolve()),
    stop: jest.fn(() => Promise.resolve()),
  },
}));

jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: {
    getState: () => ({
      registerPersistedTask: jest.fn(),
      resolveTask: jest.fn(),
      failTask: jest.fn(),
      persistTaskStage: jest.fn(),
      updateTaskStage: jest.fn(),
      persistCompleteTask: jest.fn(),
      completeTask: jest.fn(),
      cancelTask: jest.fn(),
      persistFailTask: jest.fn(),
      persistTaskStatus: jest.fn(),
      setTaskStatus: jest.fn(),
      persistTaskPipelineContext: jest.fn(),
      setTaskPipelineContext: jest.fn(),
      setTaskFinalText: jest.fn(),
      persistTaskFinalText: jest.fn(),
      setTaskInputFingerprint: jest.fn(),
    }),
  },
}));

import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  __setDatabaseForTest,
  __resetForTest,
} from '../src/data/connection/openDatabase';
import { openDatabase } from '../src/data/connection/openDatabase';
import {
  createBatch,
  createBatchItem,
  getBatchById,
  getBatchItems,
  updateBatchStatus,
  updateBatchItem,
  claimBatchLease,
} from '../src/data/repositories/multiChapterBatchRepository';
import { reconcileMultiChapterBatch } from '../src/services/multiChapterBatch/reconcileMultiChapterBatch';
import {
  cancelContinuationBatch,
  rearmContinuationItemForUserResume,
  observeContinuationRun,
} from '../src/services/multiChapterBatch/continuationBatchAdapter';
import { buildContinuationBatchChapterInstruction } from '../src/services/multiChapterBatch/continuationBatchInstruction';
import {
  encodeContinuationBatchAnchor,
  encodeContinuationBatchExecutionPolicy,
} from '../src/services/multiChapterBatch/batchMode';
import { contentRevisionHash } from '../src/services/continuation/generation/generationRepository';
import {
  ContinuationConflictError,
  ContinuationOutdatedError,
} from '../src/services/continuation/generation/types';

// ---------------------------------------------------------------------------
// World simulation
// ---------------------------------------------------------------------------

interface RunLike {
  id: string;
  projectId: number;
  chapterId: number;
  targetPosition: number;
  state: string;
  stage: string;
  completionReason: 'adopted' | 'abandoned' | null;
  adoptedRevisionHash: string | null;
  finalizedRevisionHash: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  workflowVersion: 5;
}

interface ArtifactLike {
  id: string;
  runId: string;
  stage: 'final';
  repairRound: number;
  parentArtifactId: string | null;
  content: string;
  contentHash: string;
  eligibilityStatus: 'eligible' | 'rejected';
  createdAt: string;
}

const mockWorld = {
  db: null as unknown as InMemorySqliteDb,
  runs: [] as RunLike[],
  artifacts: [] as ArtifactLike[],
  checks: [] as Array<{
    artifactId: string;
    severity: string;
    resolutionStatus: string;
    subtype: string;
  }>,
  outbox: new Map<
    string,
    { state: string; attemptCount: number; lastError: string | null }
  >(),
  startCalls: [] as any[],
  adoptCalls: [] as any[],
  finalizeCalls: [] as any[],
  resumeCalls: [] as string[],
  cancelCalls: [] as string[],
  runScript: [] as Array<Partial<RunLike> & { eligibility?: 'eligible' | 'rejected' }>,
  adoptShouldThrow: null as Error | null,
  finalizeShouldThrow: null as Error | null,
  finalizeOutboxState: 'completed',
  sourceSnapshot: {
    projectId: 1,
    sourceId: 7,
    sourceVersion: 3,
    normalizedSha256: 'sha-abc',
    parserVersion: 'p1',
    normalizationVersion: 'n1',
    boundary: { chapterId: 11, chapterPosition: 1, charOffsetExclusive: 500 },
  },
  canonSnapshot: { id: 'snap-1', revision: 8, status: 'ready' },
};

function resetMockWorld() {
  mockWorld.runs = [];
  mockWorld.artifacts = [];
  mockWorld.checks = [];
  mockWorld.outbox = new Map();
  mockWorld.startCalls = [];
  mockWorld.adoptCalls = [];
  mockWorld.finalizeCalls = [];
  mockWorld.resumeCalls = [];
  mockWorld.cancelCalls = [];
  mockWorld.runScript = [];
  mockWorld.adoptShouldThrow = null;
  mockWorld.finalizeShouldThrow = null;
  mockWorld.finalizeOutboxState = 'completed';
  mockWorld.sourceSnapshot = {
    projectId: 1,
    sourceId: 7,
    sourceVersion: 3,
    normalizedSha256: 'sha-abc',
    parserVersion: 'p1',
    normalizationVersion: 'n1',
    boundary: { chapterId: 11, chapterPosition: 1, charOffsetExclusive: 500 },
  };
  mockWorld.canonSnapshot = { id: 'snap-1', revision: 8, status: 'ready' };
}

async function sql(sqlText: string, params: any[] = []): Promise<any> {
  const db = await openDatabase();
  const [res] = await db.executeSql(sqlText, params);
  return res;
}

const mockRunner = {
  async startContinuationRun(input: any) {
    mockWorld.startCalls.push(input);
    const script =
      mockWorld.runScript.length > 0
        ? mockWorld.runScript.shift()!
        : ({ state: 'awaiting_user', eligibility: 'eligible' } as any);
    const n = mockWorld.runs.length + 1;
    const run: RunLike = {
      id: `ct_test_${n}`,
      projectId: input.projectId,
      chapterId: input.chapterId,
      targetPosition: input.targetPosition,
      state: script.state ?? 'awaiting_user',
      stage: script.stage ?? 'final_reviser',
      completionReason: (script.completionReason as any) ?? null,
      adoptedRevisionHash: (script.adoptedRevisionHash as any) ?? null,
      finalizedRevisionHash: (script.finalizedRevisionHash as any) ?? null,
      errorCode: script.errorCode ?? null,
      errorMessage: script.errorMessage ?? null,
      createdAt: new Date(Date.now() + n).toISOString(),
      updatedAt: new Date(Date.now() + n).toISOString(),
      workflowVersion: 5,
    };
    mockWorld.runs.push(run);
    if (run.state === 'awaiting_user') {
      const content = `正文内容-${run.id}`;
      mockWorld.artifacts.push({
        id: `art_${n}`,
        runId: run.id,
        stage: 'final',
        repairRound: 2,
        parentArtifactId: null,
        content,
        contentHash: contentRevisionHash(content),
        eligibilityStatus: script.eligibility ?? 'eligible',
        createdAt: run.createdAt,
      });
    }
    return { ...run };
  },

  async adoptArtifactAsDraft(input: { runId: string }) {
    mockWorld.adoptCalls.push(input.runId);
    if (mockWorld.adoptShouldThrow) throw mockWorld.adoptShouldThrow;
    const run = mockWorld.runs.find(r => r.id === input.runId);
    if (!run) throw new Error('run 不存在');
    if (run.state !== 'awaiting_user' && run.state !== 'interrupted') {
      throw new Error(`run 状态 ${run.state} 不可采纳`);
    }
    const artifact = mockWorld.artifacts.find(
      a => a.runId === run.id && a.stage === 'final',
    );
    if (!artifact || artifact.eligibilityStatus !== 'eligible') {
      throw new Error('当前正文不可采纳');
    }
    run.state = 'completed';
    run.completionReason = 'adopted';
    run.adoptedRevisionHash = artifact.contentHash;
    // Mirror the real adoption's chapter write (draft status).
    await sql(
      `UPDATE chapters SET content = ?, status = 'draft', updated_at = ? WHERE id = ?`,
      [artifact.content, new Date().toISOString(), run.chapterId],
    );
    return { contentHash: artifact.contentHash };
  },

  async finalizeContinuationChapter(input: {
    projectId: number;
    chapterId: number;
    content: string;
    sourceRunId?: string | null;
  }) {
    mockWorld.finalizeCalls.push(input);
    if (mockWorld.finalizeShouldThrow) throw mockWorld.finalizeShouldThrow;
    const hash = contentRevisionHash(input.content);
    const posRes = await sql('SELECT position FROM chapters WHERE id = ?', [
      input.chapterId,
    ]);
    const position = Number(posRes.rows.item(0).position);
    await sql(
      `UPDATE chapters SET status = 'finalized', finalized_at = ?, updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), new Date().toISOString(), input.chapterId],
    );
    const memoryStatus =
      mockWorld.finalizeOutboxState === 'completed' ? 'clean' : 'dirty';
    await sql(
      `UPDATE project_story_memory SET status = ?, dirty_from_position = ?, updated_at = ? WHERE project_id = ?`,
      [
        memoryStatus,
        memoryStatus === 'dirty' ? position : null,
        new Date().toISOString(),
        input.projectId,
      ],
    );
    const run = mockWorld.runs.find(r => r.id === input.sourceRunId);
    if (run) run.finalizedRevisionHash = hash;
    mockWorld.outbox.set(`extract_state:${input.chapterId}:${hash}`, {
      state: mockWorld.finalizeOutboxState,
      attemptCount: 0,
      lastError: null,
    });
    mockWorld.outbox.set(
      `rebuild_story_memory:auto:${input.projectId}:${position}:${hash}`,
      { state: mockWorld.finalizeOutboxState, attemptCount: 0, lastError: null },
    );
    return { revisionHash: hash, outboxDedupeKey: `extract_state:${input.chapterId}:${hash}` };
  },

  async cancelContinuationRun(runId: string) {
    mockWorld.cancelCalls.push(runId);
    const run = mockWorld.runs.find(r => r.id === runId);
    if (
      run &&
      !['cancelled', 'completed', 'outdated'].includes(run.state)
    ) {
      run.state = 'cancelled';
      run.errorCode = 'cancelled';
    }
  },

  async resumeInterruptedRun(runId: string) {
    mockWorld.resumeCalls.push(runId);
    const run = mockWorld.runs.find(r => r.id === runId);
    if (run && run.state === 'interrupted') {
      run.state = 'awaiting_user';
      run.stage = 'final_reviser';
      if (!mockWorld.artifacts.some(a => a.runId === run.id)) {
        const content = `恢复后正文-${run.id}`;
        mockWorld.artifacts.push({
          id: `art_resume_${mockWorld.artifacts.length + 1}`,
          runId: run.id,
          stage: 'final',
          repairRound: 2,
          parentArtifactId: null,
          content,
          contentHash: contentRevisionHash(content),
          eligibilityStatus: 'eligible',
          createdAt: new Date().toISOString(),
        });
      }
    }
  },
};

const mockRepo = {
  async getRunById(id: string) {
    const run = mockWorld.runs.find(r => r.id === id);
    return run ? { ...run } : null;
  },
  async listRunsForProject(projectId: number, _limit?: number) {
    return mockWorld.runs
      .filter(r => r.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(r => ({ ...r }));
  },
  async getLatestArtifactForStage(runId: string, stage: string) {
    const found = [...mockWorld.artifacts]
      .reverse()
      .find(a => a.runId === runId && a.stage === stage);
    return found ? { ...found } : null;
  },
  async listChecksForArtifact(_runId: string, artifactId: string) {
    return mockWorld.checks
      .filter(c => c.artifactId === artifactId)
      .map(c => ({ ...c, id: 1 }));
  },
  async getOutboxByDedupe(dedupeKey: string) {
    const row = mockWorld.outbox.get(dedupeKey);
    if (!row) return null;
    return {
      id: `co_${dedupeKey.length}`,
      projectId: 1,
      chapterId: null,
      operation: 'extract_state',
      payloadJson: '{}',
      dedupeKey,
      state: row.state,
      attemptCount: row.attemptCount,
      lastError: row.lastError,
      createdAt: '',
      updatedAt: '',
      completedAt: row.state === 'completed' ? '' : null,
    };
  },
  async getOutboxSummary(_projectId: number) {
    let pendingCount = 0;
    let failedCount = 0;
    let lastError: string | null = null;
    let lastFailedDedupeKey: string | null = null;
    for (const [key, row] of mockWorld.outbox) {
      if (['pending', 'running', 'interrupted'].includes(row.state)) {
        pendingCount += 1;
      }
      if (row.state === 'failed') {
        failedCount += 1;
        lastError = row.lastError;
        lastFailedDedupeKey = key;
      }
    }
    return { pendingCount, failedCount, lastError, lastFailedDedupeKey };
  },
  async findLatestAdoptedRunForChapter(_projectId: number, chapterId: number) {
    const adopted = mockWorld.runs
      .filter(
        r =>
          Number(r.chapterId) === Number(chapterId) &&
          r.state === 'completed' &&
          r.completionReason === 'adopted',
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return adopted[0] ? { ...adopted[0] } : null;
  },
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ANCHOR = {
  schemaVersion: 1 as const,
  sourceId: 7,
  sourceVersion: 3,
  sourceSha256: 'sha-abc',
  boundaryPosition: 1,
  boundaryChapterId: 11,
  boundaryCharOffsetExclusive: 500,
  canonSnapshotId: 'snap-1',
  canonRevision: 8,
  startingContinuationTailPosition: -1,
  startingContinuationTailChapterId: null,
};

let batchCounter = 0;

async function seedBatch(chapterCount: number): Promise<string> {
  batchCounter += 1;
  const batchId = `batch_ct_${batchCounter}`;
  // Anchor tail follows the CURRENT project tail (tests share one DB, so
  // earlier tests' chapters count as the pre-existing continuation).
  const existing = await chapterRows();
  const tailPosition =
    existing.length > 0
      ? Math.max(...existing.map(c => Number(c.position)))
      : -1;
  await createBatch({
    id: batchId,
    projectId: 1,
    sourcePrompt: '本批目标：找出真凶',
    chapterCount,
    targetWordsPerChapter: 3000,
    pipelineMode: 'full',
    writingMode: 'continuation',
    continuationAnchorJson: encodeContinuationBatchAnchor({
      ...ANCHOR,
      startingContinuationTailPosition: tailPosition,
    }),
    continuationExecutionPolicyJson: encodeContinuationBatchExecutionPolicy({
      schemaVersion: 1,
      autoAdoptEligibleFinal: true,
      pauseOnSoftWarning: true,
      stateGatePollIntervalMs: 200,
      stateGateMaxAttempts: 3,
    }),
  });
  for (let i = 1; i <= chapterCount; i += 1) {
    await createBatchItem({
      batchId,
      ordinal: i,
      title: `夜访旧宅-${i}`,
      synopsis: `Item${i} 梗概：推进第 ${i} 步调查`,
      keyBeatsJson: JSON.stringify([`节拍-${i}-A`, `节拍-${i}-B`]),
      carryIn: i === 1 ? '承接原著边界' : `承接第 ${i - 1} 章结尾`,
      carryOut: `交给第 ${i + 1} 章的悬念`,
      targetWords: 3000,
    });
  }
  await updateBatchStatus(batchId, 'ready', {});
  await updateBatchStatus(batchId, 'running', { startedAt: Date.now() });
  return batchId;
}

async function drive(batchId: string): Promise<void> {
  await reconcileMultiChapterBatch(batchId, {
    owner: 'adapter-test',
    runPipeline: jest.fn(),
    resumePipeline: jest.fn(),
  });
}

async function chapterRows(): Promise<any[]> {
  const res = await sql(
    'SELECT * FROM chapters WHERE project_id = 1 ORDER BY position ASC',
  );
  const rows: any[] = [];
  for (let i = 0; i < res.rows.length; i += 1) rows.push(res.rows.item(i));
  return rows;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('continuation batch adapter', () => {
  beforeAll(async () => {
    const db = await createCanonInMemoryDb();
    mockWorld.db = db;
    __setDatabaseForTest(db as any);
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at)
       VALUES (1, '续写项目', 'continuation', 0, 0)`,
    );
    await db.executeSql(
      `INSERT INTO project_story_memory (project_id, status, updated_at)
       VALUES (1, 'clean', '1970-01-01T00:00:00.000Z')`,
    );
  });

  afterAll(() => {
    __resetForTest();
    mockWorld.db?.close();
  });

  beforeEach(() => {
    resetMockWorld();
  });

  describe('serial orchestration (doc §33 / §8)', () => {
    it('writes 3 chapters strictly serially: eligible → adopt → finalize → state gate → next', async () => {
      const batchId = await seedBatch(3);
      await drive(batchId);

      const batch = await getBatchById(batchId);
           expect(batch?.status).toBe('completed');
      expect(batch?.completedCount).toBe(3);

      const items = await getBatchItems(batchId);
      for (const item of items) {
        expect(item.status).toBe('succeeded');
        expect(item.adoptionFingerprint).toBeTruthy();
        expect(item.activePipelineTaskId).toBeNull();
      }

      // 3 chapters at positions 0/1/2, all finalized.
      const chapters = await chapterRows();
      expect(chapters).toHaveLength(3);
      expect(chapters.map(c => c.position)).toEqual([0, 1, 2]);
      for (const chapter of chapters) {
        expect(chapter.status).toBe('finalized');
        expect(String(chapter.content)).toMatch(/正文内容-ct_test_\d+/);
      }

      // Exactly one run per chapter, bound in order.
      expect(mockWorld.startCalls).toHaveLength(3);
      expect(mockWorld.adoptCalls).toHaveLength(3);
      expect(mockWorld.finalizeCalls).toHaveLength(3);
      // Strictly serial: chapter N+1's run starts only after N's chapter
      // exists and is finalized (positions ascend in start order).
      for (let i = 0; i < 3; i += 1) {
        expect(mockWorld.startCalls[i].chapterId).toBe(chapters[i].id);
      }
    });

    it('injects ONLY the current chapter plan projection into userInstruction (P0)', async () => {
      const batchId = await seedBatch(3);
      await drive(batchId);
      expect(mockWorld.startCalls).toHaveLength(3);
      for (let i = 0; i < 3; i += 1) {
        const instruction = mockWorld.startCalls[i].userInstruction as string;
        expect(instruction).toContain('本批目标：找出真凶');
        expect(instruction).toContain(`夜访旧宅-${i + 1}`);
        expect(instruction).toContain(`Item${i + 1} 梗概`);
        expect(instruction).toContain(`节拍-${i + 1}-A`);
        // Future items' details never appear.
        for (let j = 1; j <= 3; j += 1) {
          if (j === i + 1) continue;
          expect(instruction).not.toContain(`Item${j} 梗概`);
          expect(instruction).not.toContain(`节拍-${j}-A`);
        }
        // Current chapter content starts empty (V5 owns the seam).
        expect(mockWorld.startCalls[i].currentChapterContent).toBe('');
      }
    });

    it('summary_json stores the current chapter instruction only', async () => {
      const batchId = await seedBatch(2);
      await drive(batchId);
      const items = await getBatchItems(batchId);
      const res = await sql('SELECT summary_json FROM chapters WHERE id = ?', [
        items[0].chapterId,
      ]);
      const summary = JSON.parse(res.rows.item(0).summary_json);
      expect(summary.batch_instruction).toContain('夜访旧宅-1');
      expect(summary.batch_instruction).not.toContain('夜访旧宅-2');
    });

    it('never routes continuation batches through runChapterPipeline', async () => {
      const batchId = await seedBatch(1);
      const runPipeline = jest.fn();
      await reconcileMultiChapterBatch(batchId, {
        owner: 'adapter-test',
        runPipeline,
        resumePipeline: jest.fn(),
      });
      expect(runPipeline).not.toHaveBeenCalled();
    });

    it('driving a completed batch again is a no-op (idempotency)', async () => {
      const batchId = await seedBatch(2);
      await drive(batchId);
      const startCount = mockWorld.startCalls.length;
      const adoptCount = mockWorld.adoptCalls.length;
      await drive(batchId);
      expect(mockWorld.startCalls).toHaveLength(startCount);
      expect(mockWorld.adoptCalls).toHaveLength(adoptCount);
      const batch = await getBatchById(batchId);
      expect(batch?.completedCount).toBe(2);
    });
  });

  describe('adoption gate (doc §13 / §14 / §35.4)', () => {
    it('rejected final pauses the batch and never adopts', async () => {
      const batchId = await seedBatch(1);
      mockWorld.runScript = [{ state: 'awaiting_user', eligibility: 'rejected' }];
      await drive(batchId);
      const batch = await getBatchById(batchId);
      expect(batch?.status).toBe('paused_user');
      expect(batch?.errorCode).toBe('BATCH_CONTINUATION_FINAL_REJECTED');
      expect(mockWorld.adoptCalls).toHaveLength(0);
      const items = await getBatchItems(batchId);
      const res = await sql('SELECT status FROM chapters WHERE id = ?', [
        items[0].chapterId,
      ]);
      expect(res.rows.item(0).status).toBe('planned');
    });

    it('awaiting_regeneration pauses the batch', async () => {
      const batchId = await seedBatch(1);
      mockWorld.runScript = [
        { state: 'awaiting_regeneration', errorMessage: 'final 未交付' },
      ];
      await drive(batchId);
      const batch = await getBatchById(batchId);
      expect(batch?.status).toBe('paused_user');
      expect(batch?.errorCode).toBe('BATCH_CONTINUATION_FINAL_REJECTED');
      expect(mockWorld.adoptCalls).toHaveLength(0);
    });

    it('open blocking checks pause with NEEDS_REVIEW (soft warning policy)', async () => {
      const batchId = await seedBatch(1);
      mockWorld.runScript = [{ state: 'awaiting_user', eligibility: 'eligible' }];
      // Seed an open severe check once we know the artifact id: the adapter
      // reads checks for the final artifact of the started run.
      const origStart = mockRunner.startContinuationRun.bind(mockRunner);
      mockRunner.startContinuationRun = async (input: any) => {
        const run = await origStart(input);
        const artifact = mockWorld.artifacts.find(a => a.runId === run.id);
        if (artifact) {
          mockWorld.checks.push({
            artifactId: artifact.id,
            severity: 'error',
            resolutionStatus: 'open',
            subtype: 'source_overlap',
          });
        }
        return run;
      };
      try {
        await drive(batchId);
        const batch = await getBatchById(batchId);
        expect(batch?.status).toBe('paused_user');
        expect(batch?.errorCode).toBe('BATCH_CONTINUATION_FINAL_NEEDS_REVIEW');
        expect(mockWorld.adoptCalls).toHaveLength(0);
      } finally {
        mockRunner.startContinuationRun = origStart;
      }
    });

    it('adoption conflict pauses with CHAPTER_CONFLICT and never overwrites', async () => {
      const batchId = await seedBatch(1);
      mockWorld.adoptShouldThrow = new ContinuationConflictError(
        '章节在生成期间已被编辑，请确认覆盖后再采纳',
      );
      await drive(batchId);
      const batch = await getBatchById(batchId);
      expect(batch?.status).toBe('paused_user');
      expect(batch?.errorCode).toBe('BATCH_CONTINUATION_CHAPTER_CONFLICT');
      const items = await getBatchItems(batchId);
      expect(items[0].status).toBe('failed');
    });

    it('outdated run pauses with RUN_OUTDATED (FI-10 analog)', async () => {
      const batchId = await seedBatch(1);
      mockWorld.adoptShouldThrow = new ContinuationOutdatedError();
      await drive(batchId);
      const batch = await getBatchById(batchId);
      expect(batch?.errorCode).toBe('BATCH_CONTINUATION_RUN_OUTDATED');
      expect(mockWorld.startCalls).toHaveLength(1);
    });

    it('failed run pauses without auto retry (doc §25)', async () => {
      const batchId = await seedBatch(1);
      mockWorld.runScript = [{ state: 'failed', errorMessage: '模型超时' }];
      await drive(batchId);
      const batch = await getBatchById(batchId);
      expect(batch?.status).toBe('paused_user');
      expect(batch?.errorCode).toBe('BATCH_CONTINUATION_RUN_FAILED');
      expect(mockWorld.startCalls).toHaveLength(1);
      expect(mockWorld.adoptCalls).toHaveLength(0);
    });
  });

  describe('finalize + state gate (doc §15–§18 / §35.5)', () => {
    it('finalize failure blocks item success and the next chapter', async () => {
      const batchId = await seedBatch(2);
      mockWorld.finalizeShouldThrow = new Error('定稿写入失败');
      await drive(batchId);
      const batch = await getBatchById(batchId);
      expect(batch?.status).toBe('paused_user');
      expect(batch?.errorCode).toBe('BATCH_CONTINUATION_FINALIZE_FAILED');
      const items = await getBatchItems(batchId);
      expect(items[0].status).toBe('failed');
      // Chapter 2 never starts: LLM call count for it = 0.
      expect(mockWorld.startCalls).toHaveLength(1);
    });

    it('state gate waiting keeps item unsucceeded and blocks the next chapter', async () => {
      const batchId = await seedBatch(2);
      mockWorld.finalizeOutboxState = 'pending';
      await drive(batchId);
      const items = await getBatchItems(batchId);
      expect(items[0].status).toBe('waiting_retry');
      expect(items[0].errorCode).toBe('BATCH_CONTINUATION_STATE_SYNC_WAIT');
      expect(items[1].status).toBe('pending');
      // Chapter 2 LLM call = 0 while state is unsettled.
      expect(mockWorld.startCalls).toHaveLength(1);
    });

    it('state gate blocked (failed outbox) pauses with STATE_SYNC_FAILED', async () => {
      const batchId = await seedBatch(1);
      mockWorld.finalizeOutboxState = 'failed';
      await drive(batchId);
      const batch = await getBatchById(batchId);
      expect(batch?.status).toBe('paused_user');
      expect(batch?.errorCode).toBe('BATCH_CONTINUATION_STATE_SYNC_FAILED');
      const items = await getBatchItems(batchId);
      expect(items[0].status).toBe('failed');
    });

    it('state gate ready → item succeeded → next chapter proceeds', async () => {
      const batchId = await seedBatch(2);
      mockWorld.finalizeOutboxState = 'pending';
      await drive(batchId);
      expect(mockWorld.startCalls).toHaveLength(1);
      // Settle the outbox (worker completes while the batch waits).
      for (const [key, row] of mockWorld.outbox) {
        mockWorld.outbox.set(key, { ...row, state: 'completed' });
      }
      await sql(
        `UPDATE project_story_memory SET status = 'clean', dirty_from_position = NULL WHERE project_id = 1`,
      );
      // Chapter 2's finalize will enqueue fresh rows — let them settle.
      mockWorld.finalizeOutboxState = 'completed';
      await drive(batchId);
      const items = await getBatchItems(batchId);
      expect(items[0].status).toBe('succeeded');
      expect(mockWorld.startCalls).toHaveLength(2);
      const batch = await getBatchById(batchId);
      expect(batch?.completedCount).toBe(2);
      expect(batch?.status).toBe('completed');
    });

    it('post-finalize manual edit of the completed chapter blocks the gate', async () => {
      const batchId = await seedBatch(2);
      mockWorld.finalizeOutboxState = 'pending';
      await drive(batchId);
      // User edits the finalized chapter while the gate waits.
      const items0 = await getBatchItems(batchId);
      await sql(
        'UPDATE chapters SET content = ?, updated_at = ? WHERE id = ?',
        ['用户手动改写后的正文', new Date().toISOString(), items0[0].chapterId],
      );
      for (const [key, row] of mockWorld.outbox) {
        mockWorld.outbox.set(key, { ...row, state: 'completed' });
      }
      await drive(batchId);
      const batch = await getBatchById(batchId);
      expect(batch?.errorCode).toBe('BATCH_CONTINUATION_CHAPTER_CONFLICT');
      expect(mockWorld.startCalls).toHaveLength(1);
    });
  });

  describe('drift guard (doc §20 / E2E-CB-04 analog)', () => {
    it('canon revision change pauses the batch fail-closed before the next chapter', async () => {
      const batchId = await seedBatch(2);
      // Chapter 1 completes; then canon drifts.
      mockWorld.runScript = [{ state: 'awaiting_user', eligibility: 'eligible' }];
      const origStart = mockRunner.startContinuationRun.bind(mockRunner);
      let started = 0;
      mockRunner.startContinuationRun = async (input: any) => {
        started += 1;
        const run = await origStart(input);
        if (started === 1) {
          // Canon revision changes after chapter 1 finished.
          mockWorld.canonSnapshot = { id: 'snap-1', revision: 9, status: 'ready' };
        }
        return run;
      };
      try {
        await drive(batchId);
        const batch = await getBatchById(batchId);
        expect(batch?.status).toBe('paused_project_changed');
        expect(batch?.errorCode).toBe('BATCH_CONTINUATION_CANON_CHANGED');
        expect(mockWorld.startCalls).toHaveLength(1);
      } finally {
        mockRunner.startContinuationRun = origStart;
        mockWorld.canonSnapshot = { id: 'snap-1', revision: 8, status: 'ready' };
      }
    });

    it('source change pauses with SOURCE_CHANGED', async () => {
      const batchId = await seedBatch(1);
      mockWorld.sourceSnapshot = { ...mockWorld.sourceSnapshot, sourceVersion: 4 };
      await drive(batchId);
      const batch = await getBatchById(batchId);
      expect(batch?.status).toBe('paused_project_changed');
      expect(batch?.errorCode).toBe('BATCH_CONTINUATION_SOURCE_CHANGED');
      expect(mockWorld.startCalls).toHaveLength(0);
    });

    it('tail chapter inserted by the user pauses with PROJECT_CHANGED', async () => {
      const batchId = await seedBatch(1);
      // Insert AFTER the frozen anchor tail (tests share one DB, so the
      // anchor tail equals the current project tail at seed time).
      const existing = await chapterRows();
      const tailPosition =
        existing.length > 0
          ? Math.max(...existing.map(c => Number(c.position)))
          : -1;
      const now = new Date().toISOString();
      await sql(
        `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
         VALUES (1, ?, '用户插入章', '', '', 'draft', ?, ?)`,
        [tailPosition + 1, now, now],
      );
      await drive(batchId);
      const batch = await getBatchById(batchId);
      expect(batch?.status).toBe('paused_project_changed');
      expect(batch?.errorCode).toBe('BATCH_PROJECT_CHANGED');
    });
  });

  describe('resume cases (doc §22) + fault injection', () => {
    it('FI-02: run persisted but binding lost → rebinds, never a second run', async () => {
      const batchId = await seedBatch(1);
      // Simulate the crash window: chapter created, run created unbound.
      const items0 = await getBatchItems(batchId);
      void items0;
      const now = new Date().toISOString();
      const [chRes] = [await sql(
        `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
         VALUES (1, 0, '夜访旧宅-1', 's', '', 'planned', ?, ?)`,
        [now, now],
      )];
      void chRes;
      const chapterId = (
        await sql('SELECT id FROM chapters WHERE project_id = 1 ORDER BY id DESC LIMIT 1')
      ).rows.item(0).id;
      await updateBatchItem(batchId, 1, {
        chapterId,
        status: 'creating_pipeline_task',
      });
      // The orphaned run exists and is live.
      mockWorld.runs.push({
        id: 'ct_orphan_1',
        projectId: 1,
        chapterId,
        targetPosition: 0,
        state: 'awaiting_user',
        stage: 'final_reviser',
        completionReason: null,
        adoptedRevisionHash: null,
        finalizedRevisionHash: null,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        workflowVersion: 5,
      });
      mockWorld.artifacts.push({
        id: 'art_orphan',
        runId: 'ct_orphan_1',
        stage: 'final',
        repairRound: 2,
        parentArtifactId: null,
        content: '孤儿 run 的正文',
        contentHash: contentRevisionHash('孤儿 run 的正文'),
        eligibilityStatus: 'eligible',
        createdAt: new Date().toISOString(),
      });
      await drive(batchId);
      // No NEW run was started; the orphan was adopted and finalized.
      expect(mockWorld.startCalls).toHaveLength(0);
      expect(mockWorld.adoptCalls).toContain('ct_orphan_1');
      const items = await getBatchItems(batchId);
      expect(items[0].activeContinuationRunId).toBe('ct_orphan_1');
      expect(items[0].status).toBe('succeeded');
    });

    it('FI-04: adoption committed, batch not — resume completes finalize + commit (no re-adopt)', async () => {
      const batchId = await seedBatch(1);
      const now = new Date().toISOString();
      const [chInsert] = [await sql(
        `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
         VALUES (1, 0, '夜访旧宅-1', 's', '已采纳正文', 'draft', ?, ?)`,
        [now, now],
      )];
      void chInsert;
      const chapterId = (
        await sql('SELECT id FROM chapters WHERE project_id = 1 ORDER BY id DESC LIMIT 1')
      ).rows.item(0).id;
      const adoptedHash = contentRevisionHash('已采纳正文');
      mockWorld.runs.push({
        id: 'ct_adopted_1',
        projectId: 1,
        chapterId,
        targetPosition: 0,
        state: 'completed',
        stage: 'final_reviser',
        completionReason: 'adopted',
        adoptedRevisionHash: adoptedHash,
        finalizedRevisionHash: null,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        workflowVersion: 5,
      });
      await updateBatchItem(batchId, 1, {
        chapterId,
        status: 'running_pipeline',
        activeContinuationRunId: 'ct_adopted_1',
      });
      await drive(batchId);
      // The crash-recovery drive must NOT adopt again.
      expect(mockWorld.adoptCalls).toHaveLength(0);
      expect(mockWorld.finalizeCalls).toHaveLength(1);
      const items = await getBatchItems(batchId);
      expect(items[0].status).toBe('succeeded');
    });

    it('FI-05: finalize committed, item not — resume skips destructive finalize', async () => {
      const batchId = await seedBatch(1);
      const now = new Date().toISOString();
      const content = '已定稿正文';
      await sql(
        `INSERT INTO chapters (project_id, position, title, synopsis, content, status, finalized_at, created_at, updated_at)
         VALUES (1, 0, '夜访旧宅-1', 's', ?, 'finalized', ?, ?, ?)`,
        [content, now, now, now],
      );
      const chapterId = (
        await sql('SELECT id FROM chapters WHERE project_id = 1 ORDER BY id DESC LIMIT 1')
      ).rows.item(0).id;
      const hash = contentRevisionHash(content);
      mockWorld.runs.push({
        id: 'ct_finalized_1',
        projectId: 1,
        chapterId,
        targetPosition: 0,
        state: 'completed',
        stage: 'final_reviser',
        completionReason: 'adopted',
        adoptedRevisionHash: hash,
        finalizedRevisionHash: hash,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        workflowVersion: 5,
      });
      // Outbox already settled by the pre-crash finalize.
      mockWorld.outbox.set(`extract_state:${chapterId}:${hash}`, {
        state: 'completed',
        attemptCount: 0,
        lastError: null,
      });
      mockWorld.outbox.set(`rebuild_story_memory:auto:1:0:${hash}`, {
        state: 'completed',
        attemptCount: 0,
        lastError: null,
      });
      await updateBatchItem(batchId, 1, {
        chapterId,
        status: 'adopting',
        activeContinuationRunId: 'ct_finalized_1',
      });
      await drive(batchId);
      expect(mockWorld.finalizeCalls).toHaveLength(0);
      const items = await getBatchItems(batchId);
      expect(items[0].status).toBe('succeeded');
      const batch = await getBatchById(batchId);
      expect(batch?.status).toBe('completed');
    });

    it('case D: interrupted run resumes the SAME run (no second V5)', async () => {
      const batchId = await seedBatch(1);
      const now = new Date().toISOString();
      await sql(
        `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
         VALUES (1, 0, '夜访旧宅-1', 's', '', 'planned', ?, ?)`,
        [now, now],
      );
      const chapterId = (
        await sql('SELECT id FROM chapters WHERE project_id = 1 ORDER BY id DESC LIMIT 1')
      ).rows.item(0).id;
      mockWorld.runs.push({
        id: 'ct_interrupted_1',
        projectId: 1,
        chapterId,
        targetPosition: 0,
        state: 'interrupted',
        stage: 'revision_writer',
        completionReason: null,
        adoptedRevisionHash: null,
        finalizedRevisionHash: null,
        errorCode: 'cold_start',
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        workflowVersion: 5,
      });
      await updateBatchItem(batchId, 1, {
        chapterId,
        status: 'running_pipeline',
        activeContinuationRunId: 'ct_interrupted_1',
      });
      await drive(batchId);
      expect(mockWorld.resumeCalls).toContain('ct_interrupted_1');
      // The resumed run was adopted; no NEW run started.
      expect(mockWorld.startCalls).toHaveLength(0);
      expect(mockWorld.adoptCalls).toContain('ct_interrupted_1');
    });

    it('case H/I: cancelled run pauses; explicit user resume rearms a new run', async () => {
      const batchId = await seedBatch(1);
      mockWorld.runScript = [{ state: 'cancelled', errorMessage: '用户在单章页取消' }];
      await drive(batchId);
      let batch = await getBatchById(batchId);
      expect(batch?.errorCode).toBe('BATCH_CONTINUATION_RUN_FAILED');
      // Explicit user resume: rearm clears the dead binding.
      await rearmContinuationItemForUserResume(batchId, 1);
      const items = await getBatchItems(batchId);
      expect(items[0].activeContinuationRunId).toBeNull();
      expect(items[0].status).toBe('chapter_ready');
      await updateBatchStatus(batchId, 'running', {});
      // New run may now start (explicit user action, doc §25).
      await drive(batchId);
      // One cancelled attempt + one fresh explicit-user run.
      expect(mockWorld.startCalls).toHaveLength(2);
      batch = (await getBatchById(batchId))!;
      expect(batch.status).toBe('completed');
    });

    it('FI-09: cancel during a live run cancels the run and unstarted items', async () => {
      const batchId = await seedBatch(2);
      // Chapter 2's run is live (bound + observed running) when cancel lands.
      const origStart = mockRunner.startContinuationRun.bind(mockRunner);
      const origGetRunById = mockRepo.getRunById.bind(mockRepo);
      let started = 0;
      let observedSecondRun = false;
      mockRunner.startContinuationRun = async (input: any) => {
        started += 1;
        const run = await origStart(input);
        if (started === 2) {
          // Second run stays running (fire-and-forget in progress).
          const live = mockWorld.runs.find(r => r.id === run.id)!;
          live.state = 'running';
          mockWorld.artifacts = mockWorld.artifacts.filter(a => a.runId !== run.id);
          return { ...live };
        }
        return run;
      };
      mockRepo.getRunById = async (id: string) => {
        const run = await origGetRunById(id);
        if (
          run &&
          started === 2 &&
          run.state === 'running' &&
          !observedSecondRun
        ) {
          // The run is now bound and being observed — user cancels mid-run.
          observedSecondRun = true;
          const items = await getBatchItems(batchId);
          await cancelContinuationBatch(batchId, items, 2);
          await updateBatchStatus(batchId, 'cancelled', {
            cancelledAt: Date.now(),
            errorCode: 'BATCH_CANCELLED',
          });
          return { ...run, state: 'running' };
        }
        return run;
      };
      try {
        await drive(batchId);
      } finally {
        mockRunner.startContinuationRun = origStart;
        mockRepo.getRunById = origGetRunById;
      }
      const items = await getBatchItems(batchId);
      expect(items[0].status).toBe('succeeded');
      expect(items[1].status).toBe('cancelled');
      const cancelledRun = mockWorld.runs.find(r =>
        mockWorld.cancelCalls.includes(r.id),
      );
      expect(cancelledRun?.state).toBe('cancelled');
    });

    it('FI-08: lease loss fails closed (second executor rejected)', async () => {
      const batchId = await seedBatch(1);
      const batch = await getBatchById(batchId);
      const claimed = await claimBatchLease(
        batchId,
        'other-executor',
        60_000,
        batch!.rowVersion,
      );
      expect(claimed).toBe(true);
      await expect(drive(batchId)).rejects.toMatchObject({
        code: 'BATCH_LEASE_CONFLICT',
      });
      expect(mockWorld.startCalls).toHaveLength(0);
    });
  });

  describe('observation mapping (doc §12)', () => {
    it('maps continuation states onto batch observations', () => {
      const partial = {
        errorMessage: null,
        completionReason: null,
      } as const;
      expect(
        observeContinuationRun({ ...partial, state: 'running', stage: 'round1' as any }),
      ).toEqual({
        status: 'running',
        stage: 'round1',
      });
      expect(
        observeContinuationRun({ ...partial, state: 'awaiting_user', stage: 'final_reviser' as any })
          .status,
      ).toBe('awaiting_adoption');
      expect(
        observeContinuationRun({
          ...partial,
          state: 'completed',
          stage: 'final_reviser' as any,
          completionReason: 'adopted',
        }).status,
      ).toBe('adopted');
      expect(
        observeContinuationRun({
          ...partial,
          state: 'completed',
          stage: 'final_reviser' as any,
          completionReason: null,
        }).status,
      ).toBe('abandoned');
      expect(
        observeContinuationRun({ ...partial, state: 'interrupted', stage: 'revision_writer' as any })
          .status,
      ).toBe('interrupted');
    });
  });

  describe('instruction builder parity inside the adapter', () => {
    it('uses the shared builder for startContinuationRun input', async () => {
      const batchId = await seedBatch(1);
      await drive(batchId);
      const items = await getBatchItems(batchId);
      const batch = (await getBatchById(batchId))!;
      const expected = buildContinuationBatchChapterInstruction(batch, items[0]);
      expect(mockWorld.startCalls[0].userInstruction).toBe(expected);
    });
  });
});

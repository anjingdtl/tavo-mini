const mockOpenDatabase = jest.fn();
const mockExecute = jest.fn();
const mockGetRunById = jest.fn();
const mockListBatches = jest.fn();
const mockListWorkItems = jest.fn();
const mockUpdateRunState = jest.fn();
const mockUpdateSnapshotMeta = jest.fn();
const mockCountFutureEvidence = jest.fn();
const mockCountOrphanEvidence = jest.fn();
const mockListBoundedSourceChapters = jest.fn();
const mockListBoundedSourceChaptersForRange = jest.fn();
const mockListBoundedSourceChapterMetas = jest.fn();
const mockGetSnapshot = jest.fn();
const mockRunStyleAnalysis = jest.fn();
const mockActivateSnapshotAndStyleProfile = jest.fn();

jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: (...args: any[]) => mockOpenDatabase(...args),
}));
jest.mock('../src/data/connection/execute', () => ({
  execute: (...args: any[]) => mockExecute(...args),
}));
jest.mock('../src/services/uuidBridge', () => ({
  v4: jest.fn(),
}));
jest.mock('../src/services/continuation/continuationSourceReader', () => ({
  continuationSourceReader: {
    getSnapshot: (...args: any[]) => mockGetSnapshot(...args),
    listBoundedSourceChapters: (...args: any[]) =>
      mockListBoundedSourceChapters(...args),
    listBoundedSourceChaptersForRange: (...args: any[]) =>
      mockListBoundedSourceChaptersForRange(...args),
    listBoundedSourceChapterMetas: (...args: any[]) =>
      mockListBoundedSourceChapterMetas(...args),
  },
}));
jest.mock('../src/services/llm', () => ({
  resolveLLMRequestConfig: jest.fn(),
  resolveLLMRequestConfigById: jest.fn(),
  callLLM: jest.fn(),
  callLLMResult: jest.fn(),
}));
jest.mock('../src/services/continuation/styleProfile/styleAnalysisService', () => ({
  runStyleAnalysis: (...args: any[]) => mockRunStyleAnalysis(...args),
}));
jest.mock('../src/services/continuation/canon/activateSnapshotAndStyleProfile', () => ({
  activateSnapshotAndStyleProfile: (...args: any[]) =>
    mockActivateSnapshotAndStyleProfile(...args),
}));
jest.mock('../src/services/continuation/canon/canonRepository', () => ({
  getActiveSnapshot: jest.fn(),
  getDb: jest.fn(),
  getRunById: (...args: any[]) => mockGetRunById(...args),
  getSnapshotById: jest.fn(),
  insertBatches: jest.fn(),
  insertWorkItems: jest.fn(),
  insertRun: jest.fn(),
  insertSnapshot: jest.fn(),
  listBatches: (...args: any[]) => mockListBatches(...args),
  listWorkItems: (...args: any[]) => mockListWorkItems(...args),
  listRunsForProject: jest.fn(),
  updateRunState: (...args: any[]) => mockUpdateRunState(...args),
  updateWorkItem: jest.fn(),
  updateSnapshotMeta: (...args: any[]) => mockUpdateSnapshotMeta(...args),
  countFutureEvidence: (...args: any[]) => mockCountFutureEvidence(...args),
  countOrphanEvidence: (...args: any[]) => mockCountOrphanEvidence(...args),
  asSourcePosition: (value: number) => value,
}));

import { processAnalysisRun } from '../src/services/continuation/canon/canonAnalysisService';

const sourceSnapshot = {
  sourceId: 7,
  sourceVersion: 3,
  normalizedSha256: 'source-hash',
  parserVersion: 'parser-1',
  normalizationVersion: 'normalizer-1',
  boundary: {
    chapterId: 1,
    chapterPosition: 0,
    charOffsetExclusive: 100,
  },
};

function makeRun() {
  return {
    id: 'run-1',
    projectId: 9,
    sourceId: sourceSnapshot.sourceId,
    sourceVersion: sourceSnapshot.sourceVersion,
    sourceSha256: sourceSnapshot.normalizedSha256,
    parserVersion: sourceSnapshot.parserVersion,
    normalizationVersion: sourceSnapshot.normalizationVersion,
    boundaryChapterId: sourceSnapshot.boundary.chapterId,
    boundaryPosition: sourceSnapshot.boundary.chapterPosition,
    boundaryCharOffsetExclusive: sourceSnapshot.boundary.charOffsetExclusive,
    canonSnapshotId: 'snapshot-1',
    profile: 'deep',
    modelConfigId: 42,
    state: 'queued',
    stage: 'snapshot',
    progressCurrent: 1,
    progressTotal: 2,
    extractionVersion: 'canon-v1',
    checkpointJson: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 'created',
    updatedAt: 'updated',
    completedAt: null,
  };
}

const completedBatch = {
  runId: 'run-1',
  canonSnapshotId: 'snapshot-1',
  batchIndex: 0,
  startPosition: 0,
  endPosition: 1,
  inputHash: 'input-hash',
  idempotencyKey: 'idempotency-key',
  state: 'completed',
  attemptCount: 1,
  resultJson: '{}',
  errorCode: null,
  errorMessage: null,
  createdAt: 'created',
  updatedAt: 'updated',
  completedAt: 'completed',
};

const completedWorkItems = [
  {
    runId: 'run-1',
    batchIndex: 0,
    materialType: 'character_state',
    state: 'completed',
    attemptCount: 1,
    resultJson: '{}',
    errorCode: null,
    errorMessage: null,
    createdAt: 'created',
    updatedAt: 'updated',
    completedAt: 'completed',
  },
  {
    runId: 'run-1',
    batchIndex: 0,
    materialType: 'world_plot',
    state: 'completed',
    attemptCount: 1,
    resultJson: '{}',
    errorCode: null,
    errorMessage: null,
    createdAt: 'created',
    updatedAt: 'updated',
    completedAt: 'completed',
  },
];

describe('complete Canon analysis style stage', () => {
  let run: ReturnType<typeof makeRun>;
  let db: { executeSql: jest.Mock };
  const events: string[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    events.length = 0;
    run = makeRun();
    db = {
      executeSql: jest.fn().mockResolvedValue([
        { rows: { item: () => ({ c: 0 }) } },
      ]),
    };
    mockOpenDatabase.mockResolvedValue(db);
    mockExecute.mockResolvedValue(undefined);
    mockGetSnapshot.mockResolvedValue(sourceSnapshot);
    mockListBoundedSourceChapters.mockResolvedValue([
      {
        id: 1,
        sourceId: sourceSnapshot.sourceId,
        position: 0,
        title: '第一章',
        content: '正文',
        range: { start: 0, end: 80 },
        clippedByBoundary: false,
      },
    ]);
    // H1: canonAnalysisService 改用按区间流式读取，mock 需返回同一章节
    mockListBoundedSourceChaptersForRange.mockResolvedValue([
      {
        id: 1,
        sourceId: sourceSnapshot.sourceId,
        position: 0,
        title: '第一章',
        content: '正文',
        range: { start: 0, end: 80 },
        clippedByBoundary: false,
      },
    ]);
    // H1: finalize 阶段轻量元数据（不含 content），用于计算 analyzedChapters
    mockListBoundedSourceChapterMetas.mockResolvedValue([
      {
        id: 1,
        sourceId: sourceSnapshot.sourceId,
        position: 0,
        title: '第一章',
        contentLength: 80,
        range: { start: 0, end: 80 },
        clippedByBoundary: false,
      },
    ]);
    mockGetRunById.mockImplementation(async () => run);
    mockListBatches.mockResolvedValue([completedBatch]);
    mockListWorkItems.mockResolvedValue(completedWorkItems);
    mockUpdateRunState.mockImplementation(async (_db, _runId, patch) => {
      events.push(`run:${patch.stage ?? 'unchanged'}`);
      run = { ...run, ...patch };
    });
    mockUpdateSnapshotMeta.mockResolvedValue(undefined);
    mockCountFutureEvidence.mockResolvedValue(0);
    mockCountOrphanEvidence.mockResolvedValue(0);
    mockRunStyleAnalysis.mockImplementation(async input => {
      events.push('style_analysis');
      expect(input).toEqual(
        expect.objectContaining({
          projectId: 9,
          runId: 'run-1',
          canonSnapshotId: 'snapshot-1',
          sourceSnapshot,
          modelConfigId: 42,
        }),
      );
      return { profileId: 'style-1', success: true };
    });
    mockActivateSnapshotAndStyleProfile.mockImplementation(async input => {
      events.push('style_validation');
      expect(input).toEqual({
        projectId: 9,
        analysisRunId: 'run-1',
        canonSnapshotId: 'snapshot-1',
        styleProfileId: 'style-1',
        allowStyleSkip: false,
      });
      run = {
        ...run,
        state: 'completed',
        stage: 'style_validation',
        completedAt: '2026-07-30T12:00:00.000Z',
      } as unknown as typeof run;
    });
  });

  it('runs style analysis and only completes after atomic activation', async () => {
    const result = await processAnalysisRun('run-1');

    expect(mockRunStyleAnalysis).toHaveBeenCalledTimes(1);
    expect(mockActivateSnapshotAndStyleProfile).toHaveBeenCalledTimes(1);
    expect(result.state).toBe('completed');
    expect(events.indexOf('style_analysis')).toBeGreaterThan(
      events.indexOf('run:style_analysis'),
    );
    expect(events.indexOf('style_validation')).toBeGreaterThan(
      events.indexOf('style_analysis'),
    );

    const finalizingPatch = mockUpdateRunState.mock.calls
      .map(call => call[2])
      .find(
        patch =>
          patch.stage === 'finalizing' && patch.state === 'running',
      );
    expect(finalizingPatch).toEqual(
      expect.objectContaining({
        state: 'running',
        stage: 'finalizing',
        completedAt: null,
      }),
    );
    expect(
      mockUpdateRunState.mock.calls.some(
        call => call[2]?.state === 'awaiting_review',
      ),
    ).toBe(false);
  });
});

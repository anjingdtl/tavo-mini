/**
 * P1-1 Pre-Adoption Revision: the Final Candidate Artifact is the revision
 * base. Outline candidates live in pipeline_tasks.final_text; continuation
 * candidates are the awaiting_user run's explicit Current Final Authority.
 * Candidate apply writes the candidate store — never the chapter body — and
 * refuses stale candidates.
 */
const mockGetChapterById = jest.fn();
const mockUpdateChapter = jest.fn();
const mockCreateRevision = jest.fn();

jest.mock('../src/services/database', () => ({
  getChapterById: (...args: unknown[]) => mockGetChapterById(...args),
  updateChapter: (...args: unknown[]) => mockUpdateChapter(...args),
}));

jest.mock('../src/services/revisionService', () => ({
  createRevision: (...args: unknown[]) => mockCreateRevision(...args),
}));

jest.mock('../src/services/storyMemory/storyMemoryService', () => ({
  finalizeChapterMemory: jest.fn(),
}));

jest.mock('../src/services/writing/persist/continuationAdoption', () => ({
  finalizeContinuationChapter: jest.fn(),
}));

const mockGetLatestCompletedTask = jest.fn();
const mockGetAdoptionPayload = jest.fn();
const mockGetContextPayload = jest.fn();
const mockGetLatestAcceptedTask = jest.fn();

jest.mock('../src/data/repositories/pipelineTaskRepository', () => ({
  getPipelineTaskById: (...args: unknown[]) => mockGetLatestCompletedTask(...args),
  getLatestCompletedPipelineTaskForTarget: (...args: unknown[]) =>
    mockGetLatestCompletedTask(...args),
  getPipelineTaskAdoptionPayload: (...args: unknown[]) =>
    mockGetAdoptionPayload(...args),
  getPipelineTaskContextPayload: (...args: unknown[]) =>
    mockGetContextPayload(...args),
  getLatestAcceptedPipelineTaskForTarget: (...args: unknown[]) =>
    mockGetLatestAcceptedTask(...args),
}));

const mockFindPendingRun = jest.fn();
const mockGetRunSnapshot = jest.fn();

jest.mock('../src/services/continuation/generation', () => ({
  getRunById: (...args: unknown[]) => mockFindPendingRun(...args),
  findLatestAdoptedRunForChapter: jest.fn(),
  findLatestPendingReviewRunForChapter: (...args: unknown[]) =>
    mockFindPendingRun(...args),
  getRunContextSnapshotJson: (...args: unknown[]) =>
    mockGetRunSnapshot(...args),
}));

const mockGetLatestEligibleArtifact = jest.fn();
const mockInsertArtifact = jest.fn();
const mockGetCurrentEligibleArtifact = jest.fn();
const mockGetEligibleArtifactForRun = jest.fn();
const mockInsertFinalArtifactAndActivate = jest.fn();

jest.mock(
  '../src/services/continuation/generation/generationRepository',
  () => ({
    getCurrentEligibleArtifact: (...args: unknown[]) =>
      mockGetCurrentEligibleArtifact(...args),
    getEligibleArtifactForRun: (...args: unknown[]) =>
      mockGetEligibleArtifactForRun(...args),
    getLatestEligibleArtifact: (...args: unknown[]) =>
      mockGetLatestEligibleArtifact(...args),
    insertArtifact: (...args: unknown[]) => mockInsertArtifact(...args),
    insertFinalArtifactAndActivate: (...args: unknown[]) =>
      mockInsertFinalArtifactAndActivate(...args),
  }),
);

jest.mock('../src/data/repositories/writingRequestReceiptRepository', () => ({
  upsertWritingRequestReceipt: jest.fn().mockResolvedValue(undefined),
}));

const mockPersistTaskFinalText = jest.fn();

jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: {
    getState: () => ({
      persistTaskFinalText: mockPersistTaskFinalText,
    }),
  },
}));

jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(),
  resolveLLMRequestConfigById: jest.fn(),
}));

import {
  applyUserRevisionPreviewToCandidate,
  createWholeChapterRewritePreview,
  loadUserRevisionCandidateBase,
  type UserRevisionFrozenTruth,
} from '../src/services/writing/userRevision';
import { hashContent } from '../src/services/continuation/generation/continuationV5Contracts';

const CANDIDATE_A = '候选初稿：他推门而入，雨声在身后合拢。';
const CANDIDATE_B = '候选修订稿：他推门而入，雨声在身后合拢，灯还亮着。';

const frozenContext = {
  projectId: 9,
  chapterId: 8,
  freezeFingerprint: 'freeze-candidate',
  generationTraceId: 'trace-candidate',
  requirements: { items: [] },
  stagePolicy: { values: { scenario: 'outline' } },
  truthProjection: { fingerprint: 'truth-candidate' },
  model: { configId: 5, modelName: 'frozen-model' },
  instruction: {
    title: '第八章',
    synopsis: '保持因果。',
    userInstruction: '写一场雨夜重逢。',
    targetPosition: 7,
  },
};

function makeTruth(chapterId: number): UserRevisionFrozenTruth {
  return {
    version: 1,
    scenario: 'outline',
    projectId: 9,
    chapterId,
    writingRunId: null,
    generationTraceId: 'trace-candidate',
    freezeFingerprint: 'freeze-candidate',
    truthProjectionFingerprint: 'truth-candidate',
    modelConfigId: 5,
    modelName: 'frozen-model',
    title: '第八章',
    synopsis: '保持因果。',
    userInstruction: '',
    targetPosition: 7,
    contextText: '冻结事实。',
  };
}

const chapter = {
  id: 8,
  project_id: 9,
  title: '第八章',
  synopsis: '',
  content: '旧的章节正文，不是候选。',
  status: 'draft' as const,
  position: 8,
  summary_json: null,
  created_at: '2026-08-31T00:00:00.000Z',
  updated_at: '2026-08-31T00:00:00.000Z',
};

function llmResult(text: string) {
  return {
    text,
    reasoningText: 'reasoning 不进入正文',
    inputTokens: 8,
    outputTokens: 8,
    totalTokens: 16,
    reasoningTokens: 2,
    finishReason: 'stop',
    providerRequestId: 'provider-candidate',
  } as any;
}

describe('candidate revision base (pre-adoption)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetChapterById.mockResolvedValue(chapter);
    mockUpdateChapter.mockResolvedValue(undefined);
    mockCreateRevision.mockResolvedValue(77);
    mockPersistTaskFinalText.mockResolvedValue(undefined);
    mockInsertArtifact.mockResolvedValue({ id: 'ca-new' });
    mockInsertFinalArtifactAndActivate.mockResolvedValue({ id: 'ca-new' });
    mockGetCurrentEligibleArtifact.mockReset();
    mockGetEligibleArtifactForRun.mockReset();
    mockInsertFinalArtifactAndActivate.mockReset();
    mockInsertFinalArtifactAndActivate.mockResolvedValue({ id: 'ca-new' });
  });

  it('loads the outline candidate from pipeline_tasks.final_text', async () => {
    mockGetLatestCompletedTask.mockResolvedValue({
      id: 'task-1',
      targetType: 'chapter',
      targetId: 8,
      status: 'completed',
    });
    mockGetAdoptionPayload.mockResolvedValue({
      id: 'task-1',
      finalText: CANDIDATE_A,
    });
    mockGetContextPayload.mockResolvedValue(
      JSON.stringify({ frozenWritingContext: frozenContext }),
    );

    const base = await loadUserRevisionCandidateBase({
      candidateRef: {
        kind: 'pipeline_task',
        taskId: 'task-1',
        projectId: 9,
        chapterId: 8,
      },
    });

    expect(base.baseBody).toBe(CANDIDATE_A);
    expect(base.baseBodyFingerprint).toBe(hashContent(CANDIDATE_A));
    expect(base.candidateRef).toEqual({
      kind: 'pipeline_task',
      taskId: 'task-1',
      projectId: 9,
      chapterId: 8,
    });
    expect(base.frozenTruth.freezeFingerprint).toBe('freeze-candidate');
  });

  it('loads the continuation candidate from the awaiting_user run', async () => {
    mockFindPendingRun.mockResolvedValue({
      id: 'run-1',
      projectId: 9,
      chapterId: 8,
      workflowVersion: 5,
      state: 'awaiting_user',
    });
    mockGetRunSnapshot.mockResolvedValue(
      JSON.stringify({
        frozenWritingContext: {
          ...frozenContext,
          stagePolicy: { values: { scenario: 'continuation' } },
        },
      }),
    );
    mockGetLatestEligibleArtifact.mockResolvedValue({
      id: 'ca-final',
      stage: 'final',
      eligibilityStatus: 'eligible',
      content: CANDIDATE_A,
    });

    mockGetCurrentEligibleArtifact.mockResolvedValue({
      id: 'ca-final',
      stage: 'final',
      eligibilityStatus: 'eligible',
      content: CANDIDATE_A,
    });
    const base = await loadUserRevisionCandidateBase({
      candidateRef: {
        kind: 'continuation_run',
        runId: 'run-1',
        projectId: 9,
        chapterId: 8,
      },
    });

    expect(base.baseBody).toBe(CANDIDATE_A);
    expect(base.candidateRef).toEqual({
      kind: 'continuation_run',
      runId: 'run-1',
      projectId: 9,
      chapterId: 8,
      artifactId: 'ca-final',
    });
    expect(base.frozenTruth.scenario).toBe('continuation');
  });

  it('applies a whole rewrite to the outline candidate without touching the chapter', async () => {
    mockGetLatestCompletedTask.mockResolvedValue({
      id: 'task-1',
      targetType: 'chapter',
      targetId: 8,
      status: 'completed',
    });
    mockGetAdoptionPayload
      .mockResolvedValueOnce({ id: 'task-1', finalText: CANDIDATE_A })
      .mockResolvedValueOnce({ id: 'task-1', finalText: CANDIDATE_A })
      .mockResolvedValue({ id: 'task-1', finalText: CANDIDATE_B });
    mockGetContextPayload.mockResolvedValue(
      JSON.stringify({ frozenWritingContext: frozenContext }),
    );
    const base = await loadUserRevisionCandidateBase({
      candidateRef: {
        kind: 'pipeline_task',
        taskId: 'task-1',
        projectId: 9,
        chapterId: 8,
      },
    });

    const preview = await createWholeChapterRewritePreview({
      chapter: { ...chapter, content: base.baseBody },
      scenario: 'outline',
      instruction: '结尾留下灯光的余韵。',
      frozenTruth: base.frozenTruth,
      candidateRef: base.candidateRef,
      call: jest.fn().mockResolvedValue(llmResult(CANDIDATE_B)),
    });
    expect(preview.candidateRef).toEqual({
      kind: 'pipeline_task',
      taskId: 'task-1',
      projectId: 9,
      chapterId: 8,
    });

    const applied = await applyUserRevisionPreviewToCandidate({ preview });

    expect(applied.revisionId).toBe(77);
    expect(mockPersistTaskFinalText).toHaveBeenCalledWith('task-1', CANDIDATE_B);
    // The chapter body and the memory closure are untouched pre-adoption.
    expect(mockUpdateChapter).not.toHaveBeenCalled();
    expect(mockInsertArtifact).not.toHaveBeenCalled();
    // The before snapshot preserves the pre-revision CANDIDATE, not the chapter.
    expect(mockCreateRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        content: CANDIDATE_A,
        source: 'before_whole_chapter_rewrite',
      }),
      { skipContentDedupe: true },
    );
    const sourceRef = JSON.parse(mockCreateRevision.mock.calls[0][0].sourceRef);
    expect(sourceRef.scope).toBe('pre_adoption_candidate');
    expect(sourceRef.requestId).toBe(preview.receipt.requestId);
    expect(sourceRef.receipt).toBeUndefined();
    expect(JSON.stringify(sourceRef)).not.toContain(CANDIDATE_A);
  });

  it('applies a revision to the continuation candidate as a new eligible final artifact', async () => {
    mockFindPendingRun.mockResolvedValue({
      id: 'run-1',
      projectId: 9,
      chapterId: 8,
      workflowVersion: 5,
      state: 'awaiting_user',
    });
    mockGetRunSnapshot.mockResolvedValue(
      JSON.stringify({
        frozenWritingContext: {
          ...frozenContext,
          stagePolicy: { values: { scenario: 'continuation' } },
        },
      }),
    );
    mockGetCurrentEligibleArtifact
      .mockResolvedValueOnce({
        id: 'ca-final',
        stage: 'final',
        eligibilityStatus: 'eligible',
        content: CANDIDATE_A,
      })
      .mockResolvedValueOnce({
        id: 'ca-final',
        stage: 'final',
        eligibilityStatus: 'eligible',
        content: CANDIDATE_A,
      })
      .mockResolvedValue({
        id: 'ca-new',
        stage: 'final',
        eligibilityStatus: 'eligible',
        content: CANDIDATE_B,
      });
    mockGetEligibleArtifactForRun.mockResolvedValue({
      id: 'ca-final',
      stage: 'final',
      eligibilityStatus: 'eligible',
      content: CANDIDATE_A,
    });
    const base = await loadUserRevisionCandidateBase({
      candidateRef: {
        kind: 'continuation_run',
        runId: 'run-1',
        projectId: 9,
        chapterId: 8,
      },
    });
    const preview = await createWholeChapterRewritePreview({
      chapter: { ...chapter, content: base.baseBody },
      scenario: 'continuation',
      instruction: '收束在人物动作上。',
      frozenTruth: base.frozenTruth,
      candidateRef: base.candidateRef,
      call: jest.fn().mockResolvedValue(llmResult(CANDIDATE_B)),
    });

    await applyUserRevisionPreviewToCandidate({ preview });

    expect(mockInsertFinalArtifactAndActivate).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        content: CANDIDATE_B,
        parentArtifactId: 'ca-final',
        expectedCurrentArtifactId: 'ca-final',
      }),
    );
    expect(mockUpdateChapter).not.toHaveBeenCalled();
    expect(mockPersistTaskFinalText).not.toHaveBeenCalled();
  });

  it('rejects a stale candidate without writing the store', async () => {
    mockGetLatestCompletedTask.mockResolvedValue({
      id: 'task-1',
      targetType: 'chapter',
      targetId: 8,
      status: 'completed',
    });
    mockGetAdoptionPayload
      .mockResolvedValueOnce({ id: 'task-1', finalText: CANDIDATE_A })
      .mockResolvedValue({ id: 'task-1', finalText: '别的正文已经写进候选。' });
    mockGetContextPayload.mockResolvedValue(
      JSON.stringify({ frozenWritingContext: frozenContext }),
    );
    const base = await loadUserRevisionCandidateBase({
      candidateRef: {
        kind: 'pipeline_task',
        taskId: 'task-1',
        projectId: 9,
        chapterId: 8,
      },
    });
    const preview = await createWholeChapterRewritePreview({
      chapter: { ...chapter, content: base.baseBody },
      scenario: 'outline',
      instruction: '润色。',
      frozenTruth: base.frozenTruth,
      candidateRef: base.candidateRef,
      call: jest.fn().mockResolvedValue(llmResult(CANDIDATE_B)),
    });

    await expect(
      applyUserRevisionPreviewToCandidate({ preview }),
    ).rejects.toMatchObject({ code: 'USER_REVISION_CANDIDATE_STALE' });
    expect(mockPersistTaskFinalText).not.toHaveBeenCalled();
    expect(mockCreateRevision).not.toHaveBeenCalled();
  });

  it('rejects a candidate whose write did not land (fail-closed verify)', async () => {
    mockGetLatestCompletedTask.mockResolvedValue({
      id: 'task-1',
      targetType: 'chapter',
      targetId: 8,
      status: 'completed',
    });
    mockGetAdoptionPayload.mockResolvedValue({
      id: 'task-1',
      finalText: CANDIDATE_A,
    });
    mockGetContextPayload.mockResolvedValue(
      JSON.stringify({ frozenWritingContext: frozenContext }),
    );
    const base = await loadUserRevisionCandidateBase({
      candidateRef: {
        kind: 'pipeline_task',
        taskId: 'task-1',
        projectId: 9,
        chapterId: 8,
      },
    });
    const preview = await createWholeChapterRewritePreview({
      chapter: { ...chapter, content: base.baseBody },
      scenario: 'outline',
      instruction: '润色。',
      frozenTruth: base.frozenTruth,
      candidateRef: base.candidateRef,
      call: jest.fn().mockResolvedValue(llmResult(CANDIDATE_B)),
    });

    await expect(
      applyUserRevisionPreviewToCandidate({ preview }),
    ).rejects.toMatchObject({ code: 'USER_REVISION_CANDIDATE_WRITE_FAILED' });
  });

  it('blocks a plain-text-invalid candidate at the final write', async () => {
    mockGetLatestCompletedTask.mockResolvedValue({
      id: 'task-1',
      targetType: 'chapter',
      targetId: 8,
      status: 'completed',
    });
    mockGetAdoptionPayload.mockResolvedValue({
      id: 'task-1',
      finalText: CANDIDATE_A,
    });
    mockGetContextPayload.mockResolvedValue(
      JSON.stringify({ frozenWritingContext: frozenContext }),
    );
    const base = await loadUserRevisionCandidateBase({
      candidateRef: {
        kind: 'pipeline_task',
        taskId: 'task-1',
        projectId: 9,
        chapterId: 8,
      },
    });
    const preview = await createWholeChapterRewritePreview({
      chapter: { ...chapter, content: base.baseBody },
      scenario: 'outline',
      instruction: '改写。',
      frozenTruth: makeTruth(8),
      candidateRef: base.candidateRef,
      call: jest.fn().mockResolvedValue(
        llmResult(JSON.stringify({ content: CANDIDATE_B })),
      ),
    }).catch(() => null);
    // The wrapper response must already fail at preview creation.
    expect(preview).toBeNull();
  });
});

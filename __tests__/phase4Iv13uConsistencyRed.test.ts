/**
 * IV-13U RED guards.
 *
 * These tests intentionally describe the single-identity / single-receipt /
 * single-body-contract / single-current-final boundary. They are expected to
 * fail against the pre-IV-13U implementation and become the narrow CHECK-A
 * regression set after the smallest repair lands.
 */

const mockGetChapterById = jest.fn();
const mockUpdateChapter = jest.fn();

jest.mock('../src/services/database', () => ({
  getChapterById: (...args: unknown[]) => mockGetChapterById(...args),
  updateChapter: (...args: unknown[]) => mockUpdateChapter(...args),
}));

jest.mock('../src/services/revisionService', () => ({
  createRevision: jest.fn(),
}));

jest.mock('../src/services/storyMemory/storyMemoryService', () => ({
  finalizeChapterMemory: jest.fn(),
}));

jest.mock('../src/services/writing/persist/continuationAdoption', () => ({
  finalizeContinuationChapter: jest.fn(),
}));

const mockGetPipelineTaskById = jest.fn();
const mockGetLatestCompletedTask = jest.fn();
const mockGetTaskAdoptionPayload = jest.fn();
const mockGetTaskContextPayload = jest.fn();

jest.mock('../src/data/repositories/pipelineTaskRepository', () => ({
  getPipelineTaskById: (...args: unknown[]) => mockGetPipelineTaskById(...args),
  getLatestCompletedPipelineTaskForTarget: (...args: unknown[]) =>
    mockGetLatestCompletedTask(...args),
  getPipelineTaskAdoptionPayload: (...args: unknown[]) =>
    mockGetTaskAdoptionPayload(...args),
  getPipelineTaskContextPayload: (...args: unknown[]) =>
    mockGetTaskContextPayload(...args),
  getLatestAcceptedPipelineTaskForTarget: jest.fn(),
}));

const mockGetRunById = jest.fn();
const mockFindLatestPendingRun = jest.fn();
const mockGetRunSnapshot = jest.fn();

jest.mock('../src/services/continuation/generation', () => ({
  getRunById: (...args: unknown[]) => mockGetRunById(...args),
  findLatestAdoptedRunForChapter: jest.fn(),
  findLatestPendingReviewRunForChapter: (...args: unknown[]) =>
    mockFindLatestPendingRun(...args),
  getRunContextSnapshotJson: (...args: unknown[]) =>
    mockGetRunSnapshot(...args),
}));

const mockGetLatestEligibleArtifact = jest.fn();
const mockGetCurrentEligibleArtifact = jest.fn();
const mockInsertArtifact = jest.fn();

jest.mock(
  '../src/services/continuation/generation/generationRepository',
  () => ({
    getLatestEligibleArtifact: (...args: unknown[]) =>
      mockGetLatestEligibleArtifact(...args),
    getCurrentEligibleArtifact: (...args: unknown[]) =>
      mockGetCurrentEligibleArtifact(...args),
    insertArtifact: (...args: unknown[]) => mockInsertArtifact(...args),
  }),
);

jest.mock('../src/data/repositories/writingRequestReceiptRepository', () => ({
  upsertWritingRequestReceipt: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: {
    getState: () => ({ persistTaskFinalText: jest.fn() }),
  },
}));

jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(),
  resolveLLMRequestConfigById: jest.fn(),
}));

import {
  createWholeChapterRewritePreview,
  loadUserRevisionCandidateBase,
  type UserRevisionFrozenTruth,
} from '../src/services/writing/userRevision';
import { validateFinalArtifact } from '../src/services/pipeline/finalArtifactValidator';
import {
  validateFinalArtifact as validateContinuationFinalArtifact,
} from '../src/services/continuation/generation/finalArtifactValidator';
import { validatePlainTextNovelBody } from '../src/services/writing/contracts/plainTextNovelBody';
import { createCurrentSchemaStatements } from '../src/data/schema/createCurrentSchema';

const BODY_A = '候选 A：他推门而入，雨声在身后合拢。';
const BODY_B = '候选 B：他推门而入，灯火在雨幕深处重新亮起。';

const frozenContext = {
  projectId: 9,
  chapterId: 8,
  freezeFingerprint: 'freeze-red',
  generationTraceId: 'trace-red',
  requirements: { items: [] },
  stagePolicy: { values: { scenario: 'outline' } },
  truthProjection: { fingerprint: 'truth-red' },
  model: { configId: 5, modelName: 'frozen-model' },
  instruction: {
    title: '第八章',
    synopsis: '保持因果。',
    userInstruction: '写一场雨夜重逢。',
    targetPosition: 7,
  },
};

const truth: UserRevisionFrozenTruth = {
  version: 1,
  scenario: 'outline',
  projectId: 9,
  chapterId: 8,
  writingRunId: 'run-red',
  generationTraceId: 'trace-red',
  freezeFingerprint: 'freeze-red',
  truthProjectionFingerprint: 'truth-red',
  modelConfigId: 5,
  modelName: 'frozen-model',
  title: '第八章',
  synopsis: '保持因果。',
  userInstruction: '写一场雨夜重逢。',
  targetPosition: 7,
  contextText: '冻结事实。',
};

const chapter = {
  id: 8,
  project_id: 9,
  title: '第八章',
  synopsis: '',
  content: '章节现有正文。',
  status: 'draft' as const,
  position: 8,
  summary_json: null,
  created_at: '2026-08-31T00:00:00.000Z',
  updated_at: '2026-08-31T00:00:00.000Z',
};

function snapshotFor(scenario: 'outline' | 'continuation') {
  return JSON.stringify({
    frozenWritingContext: {
      ...frozenContext,
      stagePolicy: { values: { scenario } },
    },
  });
}

describe('IV-13U RED: exact candidate identity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetChapterById.mockResolvedValue(chapter);
    mockGetTaskContextPayload.mockResolvedValue(snapshotFor('outline'));
    mockGetTaskAdoptionPayload.mockImplementation(async (taskId: string) => ({
      id: taskId,
      finalText: taskId === 'task-a' ? BODY_A : BODY_B,
    }));
    mockGetRunSnapshot.mockImplementation(async (runId: string) =>
      snapshotFor(runId === 'run-a' ? 'continuation' : 'continuation'),
    );
    mockGetLatestEligibleArtifact.mockResolvedValue({
      id: 'artifact-b',
      stage: 'final',
      eligibilityStatus: 'eligible',
      content: BODY_B,
    });
    mockGetCurrentEligibleArtifact.mockResolvedValue({
      id: 'artifact-a',
      stage: 'final',
      eligibilityStatus: 'eligible',
      content: BODY_A,
    });
  });

  it('uses the exact pipeline task id and never falls back to chapter latest', async () => {
    mockGetPipelineTaskById.mockResolvedValue({
      id: 'task-a',
      targetType: 'chapter',
      targetId: 8,
      status: 'completed',
    });
    mockGetLatestCompletedTask.mockResolvedValue({
      id: 'task-b',
      targetType: 'chapter',
      targetId: 8,
      status: 'completed',
    });

    const base = await loadUserRevisionCandidateBase({
      candidateRef: {
        kind: 'pipeline_task',
        taskId: 'task-a',
        projectId: 9,
        chapterId: 8,
      },
    } as any);

    expect(mockGetPipelineTaskById).toHaveBeenCalledWith('task-a');
    expect(mockGetLatestCompletedTask).not.toHaveBeenCalled();
    expect(base.baseBody).toBe(BODY_A);
    expect(base.candidateRef).toMatchObject({
      kind: 'pipeline_task',
      taskId: 'task-a',
    });
  });

  it('uses the exact continuation run and its current final authority', async () => {
    mockGetRunById.mockResolvedValue({
      id: 'run-a',
      projectId: 9,
      chapterId: 8,
      workflowVersion: 5,
      state: 'awaiting_user',
    });
    mockFindLatestPendingRun.mockResolvedValue({
      id: 'run-b',
      projectId: 9,
      chapterId: 8,
      workflowVersion: 5,
      state: 'awaiting_user',
    });

    const base = await loadUserRevisionCandidateBase({
      candidateRef: {
        kind: 'continuation_run',
        runId: 'run-a',
        projectId: 9,
        chapterId: 8,
      },
    } as any);

    expect(mockGetRunById).toHaveBeenCalledWith('run-a');
    expect(mockFindLatestPendingRun).not.toHaveBeenCalled();
    expect(mockGetCurrentEligibleArtifact).toHaveBeenCalledWith('run-a');
    expect(base.baseBody).toBe(BODY_A);
    expect(base.candidateRef).toMatchObject({
      kind: 'continuation_run',
      runId: 'run-a',
    });
  });
});

describe('IV-13U RED: one durable writing request receipt', () => {
  it('exposes the shared WritingRequestReceipt identity on a User Revision', async () => {
    const preview = await createWholeChapterRewritePreview({
      chapter,
      scenario: 'outline',
      instruction: '润色。',
      frozenTruth: truth,
      call: jest.fn().mockResolvedValue({
        text: '重写后的完整正文。',
        reasoningText: '不会进入正文。',
        inputTokens: 5,
        outputTokens: 5,
        totalTokens: 10,
        reasoningTokens: 1,
        finishReason: 'stop',
        providerRequestId: 'provider-red',
      }),
    });

    expect(preview.receipt).toMatchObject({
      requestId: expect.any(String),
      generationTraceId: expect.any(String),
      stage: expect.any(String),
      outcome: 'succeeded',
      physicalRequestCount: 1,
    });
  });
});

describe('IV-13U RED: one shared final body contract', () => {
  const naturalSentence =
    '他反复交代，其余内容不变，只把最后一句压低。雨水沿着窗棂落下，屋里没有人再追问。';

  it('gives the same valid verdict to the shared contract and Outline validator', () => {
    expect(validatePlainTextNovelBody(naturalSentence).valid).toBe(true);
    const result = validateFinalArtifact({
      text: naturalSentence,
      reasoningText: null,
      finishReason: 'stop',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects the same technical body in Outline and Continuation validators', () => {
    const invalidBodies = [
      '{"content":"正文。"}',
      '```text\n正文。\n```',
      '<think>内部推理</think>正文。',
      '[draft-p-001] 正文。',
      '{"patches":[]}',
      '修改说明：正文。',
      '你是终稿修订员：正文。',
      '第八章\n第八章\n正文。',
      'FROZEN_CONTEXT_BEGIN 正文。',
      '正文【',
    ];
    for (const body of invalidBodies) {
      const outline = validateFinalArtifact({
        text: body,
        reasoningText: null,
        finishReason: 'stop',
      });
      const continuation = validateContinuationFinalArtifact({
        envelope: {
          schemaVersion: 1,
          content: body,
          revisionArtifactHash: 'revision',
          architectureHash: 'architecture',
          auditContractHash: 'audit',
          appliedObligationIds: [],
          appliedCanonRequirementIds: [],
          appliedStyleRequirementIds: [],
          validNoOpRequirementIds: [],
          validNoOpReasons: {},
          unappliedItems: [],
          restoredProtectedPassageIds: [],
          declaredNewCoreFacts: [],
          usedArchitectSceneIds: [],
        },
        finishReason: 'stop',
        snapshot: {
          settingsSnapshot: { values: { targetChapterChars: 100 } },
          lengthPolicy: undefined,
        } as any,
        architecture: { sceneUnits: [] } as any,
        architectureHash: 'architecture',
        audit: {
          finalObligations: [],
          architectureAudit: { rejectedScenes: [] },
        } as any,
        auditContractHash: 'audit',
        revisionArtifactHash: 'revision',
      });
      expect(validatePlainTextNovelBody(body).valid).toBe(false);
      expect(outline.valid).toBe(false);
      expect(continuation.passed).toBe(false);
      expect(continuation.codes.some(code => code.startsWith('final_'))).toBe(
        true,
      );
    }
  });
});

describe('IV-13U RED: schema has one current final authority and one receipt ledger', () => {
  it('creates the current-final pointer and durable receipt table', () => {
    const ddl = createCurrentSchemaStatements().join('\n');
    expect(ddl).toContain('active_final_artifact_id');
    expect(ddl).toContain('writing_request_receipts');
  });
});

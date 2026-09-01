/**
 * P1-3: the user revision receipt must explain the real physical call.
 * Option B contract — the wire uses the live config resolved from the frozen
 * configId, so the receipt records the RESOLVED provider/model identity;
 * `frozenModelName` is kept only as the frozen generation binding.
 */
jest.mock('../src/services/database', () => ({
  getChapterById: jest.fn(),
  updateChapter: jest.fn(),
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

jest.mock('../src/data/repositories/writingRequestReceiptRepository', () => ({
  upsertWritingRequestReceipt: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/data/repositories/pipelineTaskRepository', () => ({
  getLatestCompletedPipelineTaskForTarget: jest.fn(),
  getPipelineTaskAdoptionPayload: jest.fn(),
  getPipelineTaskContextPayload: jest.fn(),
  getLatestAcceptedPipelineTaskForTarget: jest.fn(),
}));

jest.mock('../src/services/continuation/generation', () => ({
  findLatestAdoptedRunForChapter: jest.fn(),
  findLatestPendingReviewRunForChapter: jest.fn(),
  getRunContextSnapshotJson: jest.fn(),
}));

jest.mock(
  '../src/services/continuation/generation/generationRepository',
  () => ({
    getLatestEligibleArtifact: jest.fn(),
    insertArtifact: jest.fn(),
  }),
);

jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: {
    getState: () => ({ persistTaskFinalText: jest.fn() }),
  },
}));

const mockCallLLMResult = jest.fn();
const mockResolveById = jest.fn();

jest.mock('../src/services/llm', () => ({
  callLLMResult: (...args: unknown[]) => mockCallLLMResult(...args),
  resolveLLMRequestConfigById: (...args: unknown[]) =>
    mockResolveById(...args),
}));

import {
  createWholeChapterRewritePreview,
  type UserRevisionFrozenTruth,
} from '../src/services/writing/userRevision';

const truth: UserRevisionFrozenTruth = {
  version: 1,
  scenario: 'outline',
  projectId: 9,
  chapterId: 8,
  writingRunId: 'run-receipt',
  generationTraceId: 'trace-receipt',
  freezeFingerprint: 'freeze-receipt',
  truthProjectionFingerprint: 'truth-receipt',
  modelConfigId: 7,
  modelName: 'frozen-model-a',
  title: '第八章',
  synopsis: '',
  userInstruction: '',
  targetPosition: 7,
  contextText: '冻结事实。',
};

const chapter = {
  id: 8,
  project_id: 9,
  title: '第八章',
  synopsis: '',
  content: '原稿正文。',
  status: 'draft' as const,
  position: 8,
  summary_json: null,
  created_at: '2026-08-31T00:00:00.000Z',
  updated_at: '2026-08-31T00:00:00.000Z',
};

describe('user revision receipt model identity (P1-3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The live config with the frozen id now points at model B — the wire
    // WILL use model B, so the receipt must say model B.
    mockResolveById.mockResolvedValue({
      id: 7,
      name: 'writing-config',
      provider_type: 'deepseek',
      api_key: 'secret-do-not-leak',
      model_name: 'live-model-b',
      url: 'https://api.example.com/v1/chat/completions',
    });
    mockCallLLMResult.mockResolvedValue({
      text: '重写后的完整正文。',
      reasoningText: 'reasoning',
      inputTokens: 5,
      outputTokens: 5,
      totalTokens: 10,
      reasoningTokens: 1,
      finishReason: 'stop',
      providerRequestId: 'provider-1',
    });
  });

  it('records the resolved live model, not the frozen name', async () => {
    const preview = await createWholeChapterRewritePreview({
      chapter,
      scenario: 'outline',
      instruction: '润色。',
      frozenTruth: truth,
    });

    expect(mockResolveById).toHaveBeenCalledWith(7);
    expect(preview.receipt.model).toBe('live-model-b');
    expect(preview.receipt.provider).toBe('deepseek');
    expect(preview.receipt.frozenModelName).toBe('frozen-model-a');
    expect(preview.receipt.llmConfigId).toBe(7);
    // Thinking stays explicitly on and the common receipt records one
    // physical dispatch.
    expect(preview.receipt.thinking).toEqual({ type: 'enabled' });
    expect(preview.receipt.physicalRequestCount).toBe(1);
  });

  it('records direct User Revision provenance instead of the shared prompt compiler', async () => {
    const preview = await createWholeChapterRewritePreview({
      chapter,
      scenario: 'outline',
      instruction: '润色。',
      frozenTruth: truth,
    });

    expect(preview.receipt.promptCompilerVersion).toBe(
      'direct-user-revision-v1',
    );
    expect(preview.receipt.promptCompilerVersion).not.toBe(
      'shared-prompt-compiler-v1',
    );
  });

  it('never writes the credential into the receipt chain', async () => {
    const preview = await createWholeChapterRewritePreview({
      chapter,
      scenario: 'outline',
      instruction: '润色。',
      frozenTruth: truth,
    });
    const serialized = JSON.stringify(preview.receipt);
    expect(serialized).not.toContain('secret-do-not-leak');
    expect(serialized).not.toContain('重写后的完整正文');
    expect(serialized).not.toContain('原稿正文');
  });

  it('keeps the frozen identity when an injected caller is the observed call', async () => {
    const preview = await createWholeChapterRewritePreview({
      chapter,
      scenario: 'outline',
      instruction: '润色。',
      frozenTruth: truth,
      call: jest.fn().mockResolvedValue({
        text: '重写后的完整正文。',
        reasoningText: null,
        inputTokens: 5,
        outputTokens: 5,
        totalTokens: 10,
        reasoningTokens: null,
        finishReason: 'stop',
        providerRequestId: null,
      } as any),
    });
    expect(mockResolveById).not.toHaveBeenCalled();
    expect(preview.receipt.model).toBe('frozen-model-a');
    expect(preview.receipt.frozenModelName).toBe('frozen-model-a');
  });
});

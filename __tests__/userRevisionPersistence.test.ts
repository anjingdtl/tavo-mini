const mockGetChapterById = jest.fn();
const mockUpdateChapter = jest.fn();
const mockCreateRevision = jest.fn();
const mockFinalizeChapterMemory = jest.fn();
const mockFinalizeContinuationChapter = jest.fn();

jest.mock('../src/services/database', () => ({
  getChapterById: (...args: unknown[]) => mockGetChapterById(...args),
  updateChapter: (...args: unknown[]) => mockUpdateChapter(...args),
}));

jest.mock('../src/services/revisionService', () => ({
  createRevision: (...args: unknown[]) => mockCreateRevision(...args),
}));

jest.mock('../src/services/storyMemory/storyMemoryService', () => ({
  finalizeChapterMemory: (...args: unknown[]) =>
    mockFinalizeChapterMemory(...args),
}));

jest.mock('../src/services/writing/persist/continuationAdoption', () => ({
  finalizeContinuationChapter: (...args: unknown[]) =>
    mockFinalizeContinuationChapter(...args),
}));

jest.mock('../src/data/repositories/writingRequestReceiptRepository', () => ({
  upsertWritingRequestReceipt: jest.fn().mockResolvedValue(undefined),
}));

import {
  applyUserRevisionPreview,
  createWholeChapterRewritePreview,
  type UserRevisionFrozenTruth,
} from '../src/services/writing/userRevision';

const truth: UserRevisionFrozenTruth = {
  version: 1,
  scenario: 'outline',
  projectId: 9,
  chapterId: 8,
  writingRunId: 'run-persist',
  generationTraceId: 'trace-persist',
  freezeFingerprint: 'freeze-persist',
  truthProjectionFingerprint: 'truth-persist',
  modelConfigId: 1,
  modelName: 'test-model',
  title: '雨夜',
  synopsis: '保持因果。',
  userInstruction: '',
  targetPosition: 0,
  contextText: '冻结事实：城门已关闭。',
};

function llmResult(text: string) {
  return {
    text,
    reasoningText: 'reasoning 不进入业务正文',
    inputTokens: 10,
    outputTokens: 10,
    totalTokens: 20,
    reasoningTokens: 2,
    finishReason: 'stop',
    providerRequestId: 'provider-persist',
  } as any;
}

const chapter = {
  id: 8,
  project_id: 9,
  title: '第 8 章',
  synopsis: '',
  content: '原稿。',
  status: 'draft' as const,
  position: 8,
  summary_json: null,
  memory_summary: '',
  memory_summary_tokens: 0,
  created_at: '2026-08-31T00:00:00.000Z',
  updated_at: '2026-08-31T00:00:00.000Z',
};

describe('user revision persistence boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetChapterById.mockResolvedValue(chapter);
    mockUpdateChapter.mockResolvedValue(undefined);
    mockCreateRevision.mockResolvedValue(42);
    mockFinalizeChapterMemory.mockResolvedValue({ ok: true });
    mockFinalizeContinuationChapter.mockResolvedValue({ ok: true });
  });

  it('writes a recoverable before-snapshot and durable receipt reference on apply', async () => {
    const preview = await createWholeChapterRewritePreview({
      chapter,
      scenario: 'outline',
      instruction: '增强冲突，但保持事实。',
      frozenTruth: truth,
      call: jest.fn().mockResolvedValue(llmResult('新稿。')),
    });

    const applied = await applyUserRevisionPreview({ preview });

    expect(applied.revisionId).toBe(42);
    expect(mockCreateRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '原稿。',
        source: 'before_whole_chapter_rewrite',
        sourceRef: expect.any(String),
      }),
      // Audit snapshots skip the content dedupe so the receipt always lands.
      { skipContentDedupe: true },
    );
    const sourceRef = JSON.parse(mockCreateRevision.mock.calls[0][0].sourceRef);
    expect(sourceRef.requestId).toBe(preview.receipt.requestId);
    expect(sourceRef.receipt).toBeUndefined();
    expect(JSON.stringify(sourceRef)).not.toContain('原稿。');
    expect(mockUpdateChapter).toHaveBeenCalledWith(8, { content: '新稿。' });
    expect(applied.preview.state).toBe('applied');
    // P0-2: apply must re-enter the ONE existing PostWriting closure with the
    // revision-advanced opt-in so memory describes the new body.
    expect(mockFinalizeChapterMemory).toHaveBeenCalledWith(8, {
      revisionAdvancedBody: true,
    });
  });

  it('restores the previous body when the PostWriting closure fails', async () => {
    const preview = await createWholeChapterRewritePreview({
      chapter,
      scenario: 'outline',
      instruction: '增强冲突。',
      frozenTruth: truth,
      call: jest.fn().mockResolvedValue(llmResult('新稿。')),
    });
    mockFinalizeChapterMemory.mockRejectedValue(
      new Error('WRITING_POST_WRITING_REVISION_DRIFT: x'),
    );

    await expect(applyUserRevisionPreview({ preview })).rejects.toMatchObject({
      code: 'USER_REVISION_POST_WRITING_FAILED',
    });
    // The chapter write is rolled back so the visible body never diverges
    // from memory authority.
    expect(mockUpdateChapter).toHaveBeenLastCalledWith(8, {
      content: '原稿。',
    });
  });

  it('rejects a changed chapter before creating a revision or updating content', async () => {
    const preview = await createWholeChapterRewritePreview({
      chapter,
      scenario: 'outline',
      instruction: '增强冲突。',
      frozenTruth: truth,
      call: jest.fn().mockResolvedValue(llmResult('新稿。')),
    });
    mockGetChapterById.mockResolvedValue({ ...chapter, content: '用户新稿。' });

    await expect(applyUserRevisionPreview({ preview })).rejects.toMatchObject({
      code: 'USER_REVISION_STALE_BASE',
    });
    expect(mockCreateRevision).not.toHaveBeenCalled();
    expect(mockUpdateChapter).not.toHaveBeenCalled();
  });
});

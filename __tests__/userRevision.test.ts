import {
  applyScopedRepairPatches,
  createTargetedRevisionPreview,
  createWholeChapterRewritePreview,
  createUserRevisionSelectionSnapshot,
  discardUserRevisionPreview,
  UserRevisionError,
  type UserRevisionFrozenTruth,
} from '../src/services/writing/userRevision';

import { upsertWritingRequestReceipt } from '../src/data/repositories/writingRequestReceiptRepository';

jest.mock('../src/data/repositories/writingRequestReceiptRepository', () => ({
  upsertWritingRequestReceipt: jest.fn().mockResolvedValue(undefined),
}));

const mockUpsertWritingRequestReceipt = upsertWritingRequestReceipt as jest.Mock;

const truth: UserRevisionFrozenTruth = {
  version: 1,
  scenario: 'outline',
  projectId: 9,
  chapterId: 1,
  writingRunId: 'run_1',
  generationTraceId: 'trace_1',
  freezeFingerprint: 'freeze_1',
  truthProjectionFingerprint: 'truth_1',
  modelConfigId: 1,
  modelName: 'test-model',
  title: '雨夜',
  synopsis: '保留事件因果。',
  userInstruction: '',
  targetPosition: 0,
  contextText: '冻结事实：城门已关闭。',
};

function result(text: string) {
  return {
    text,
    reasoningText: '不会进入正文的 reasoning',
    inputTokens: 10,
    outputTokens: 8,
    totalTokens: 18,
    reasoningTokens: 3,
    finishReason: 'stop',
    providerRequestId: 'provider_1',
  } as any;
}

describe('user revision safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses Continuation Patch and preserves text outside a multi-paragraph selection', () => {
    const body = '前文。\n\n旧句一。\n\n旧句二。\n\n后文。';
    const start = body.indexOf('旧句一');
    const end = body.indexOf('后文');
    const snapshot = createUserRevisionSelectionSnapshot({
      chapterId: 7,
      scenario: 'outline',
      baseBody: body,
      selectionStart: start,
      selectionEnd: end,
      instruction: '让这两句更紧张。',
    });
    const candidate = applyScopedRepairPatches({
      original: body,
      snapshot,
      patches: [
        { start, end: start + '旧句一'.length, replacement: '紧张的一句' },
        {
          start: body.indexOf('旧句二'),
          end: body.indexOf('旧句二') + '旧句二'.length,
          replacement: '紧张的第二句',
        },
      ],
    });
    expect(candidate).toBe(
      '前文。\n\n紧张的一句。\n\n紧张的第二句。\n\n后文。',
    );
  });

  it('rejects out-of-range, overlap and stale patches', () => {
    const body = '甲甲\n\n乙乙。';
    const start = body.indexOf('乙');
    const end = start + 2;
    const snapshot = createUserRevisionSelectionSnapshot({
      chapterId: 1,
      scenario: 'continuation',
      baseBody: body,
      selectionStart: start,
      selectionEnd: end,
      instruction: '改得更冷。',
    });
    expect(() =>
      applyScopedRepairPatches({
        original: body,
        snapshot,
        patches: [{ start: start - 1, end, replacement: '越界' }],
      }),
    ).toThrow(UserRevisionError);
    expect(() =>
      applyScopedRepairPatches({
        original: body,
        snapshot,
        patches: [
          { start, end: end, replacement: '一' },
          { start: start + 1, end, replacement: '二' },
        ],
      }),
    ).toThrow(UserRevisionError);
    expect(() =>
      applyScopedRepairPatches({
        original: body + '变更',
        snapshot,
        patches: [{ start, end, replacement: '新' }],
      }),
    ).toThrow(/正文已发生变化/);
  });

  it('uses UTF-16 offsets for surrogate pairs', () => {
    const body = 'A😀B\n\n旧句。';
    const start = body.indexOf('旧句');
    const snapshot = createUserRevisionSelectionSnapshot({
      chapterId: 2,
      scenario: 'outline',
      baseBody: body,
      selectionStart: start,
      selectionEnd: start + 3,
      instruction: '替换。',
    });
    expect(
      applyScopedRepairPatches({
        original: body,
        snapshot,
        patches: [{ start, end: start + 3, replacement: '新句。' }],
      }),
    ).toBe('A😀B\n\n新句。');
  });

  it('performs exactly one targeted call and rejects a full-text response', async () => {
    const call = jest.fn().mockResolvedValue(result('完整章节正文。'));
    await expect(
      createTargetedRevisionPreview({
        chapter: { id: 1, project_id: 9, content: '甲甲\n\n乙乙。' },
        scenario: 'outline',
        instruction: '改写乙句。',
        selectionStart: 4,
        selectionEnd: 7,
        frozenTruth: truth,
        call,
      }),
    ).rejects.toMatchObject({ code: 'USER_REVISION_TARGETED_FULL_TEXT' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][2].thinking).toEqual({ type: 'enabled' });
    expect(call.mock.calls[0][2].responseFormat).toBeUndefined();
    expect(
      mockUpsertWritingRequestReceipt.mock.calls.map(
        callArgs => callArgs[0].previewState,
      ),
    ).toEqual(['started', 'pending', 'failed']);
  });

  it('rejects tolerant-parser wrappers for targeted revision', async () => {
    const call = jest
      .fn()
      .mockResolvedValueOnce(
        result(
          '```json\n{"patches":[{"start":4,"end":7,"replacement":"新句。"}]}\n```',
        ),
      )
      .mockResolvedValueOnce(
        result(
          '模型说明：{"patches":[{"start":4,"end":7,"replacement":"新句。"}]}',
        ),
      );
    const input = {
      chapter: { id: 1, project_id: 9, content: '甲甲\n\n乙乙。' },
      scenario: 'outline' as const,
      instruction: '改写乙句。',
      selectionStart: 4,
      selectionEnd: 7,
      frozenTruth: truth,
      call,
    };

    await expect(createTargetedRevisionPreview(input)).rejects.toMatchObject({
      code: 'USER_REVISION_PATCH_INVALID',
    });
    await expect(createTargetedRevisionPreview(input)).rejects.toMatchObject({
      code: 'USER_REVISION_PATCH_INVALID',
    });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('returns a diffable targeted preview from one strict Patch response', async () => {
    const body = '前文。\n\n旧句。\n\n后文。';
    const start = body.indexOf('旧句');
    const call = jest.fn().mockResolvedValue(
      result(
        JSON.stringify({
          patches: [{ start, end: start + 3, replacement: '新句。' }],
        }),
      ),
    );
    const preview = await createTargetedRevisionPreview({
      chapter: { id: 3, project_id: 9, content: body },
      scenario: 'outline',
      instruction: '让这句更紧张。',
      selectionStart: start,
      selectionEnd: start + 3,
      frozenTruth: { ...truth, chapterId: 3 },
      call,
    });

    expect(preview.candidateBody).toBe('前文。\n\n新句。\n\n后文。');
    expect(preview.diff.changes.length).toBeGreaterThan(0);
    expect(preview.receipt.physicalRequestCount).toBe(1);
    expect(preview.receipt.governorBypassed).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('performs one whole rewrite call, rejects JSON/fence output, and has a discardable preview', async () => {
    const call = jest
      .fn()
      .mockResolvedValueOnce(result('{"content":"正文"}'))
      .mockResolvedValueOnce(result('```\n重写正文。\n```'))
      .mockResolvedValueOnce(result('雨声压住了屋檐，门外的脚步越来越近。'));
    const input = {
      chapter: { id: 2, project_id: 9, content: '原正文。' },
      scenario: 'continuation' as const,
      instruction: '保留事实，增强冲突。',
      frozenTruth: {
        ...truth,
        scenario: 'continuation' as const,
        chapterId: 2,
      },
      call,
    };
    await expect(createWholeChapterRewritePreview(input)).rejects.toMatchObject(
      {
        code: 'USER_REVISION_WHOLE_BODY_INVALID',
      },
    );
    await expect(createWholeChapterRewritePreview(input)).rejects.toMatchObject(
      {
        code: 'USER_REVISION_WHOLE_BODY_INVALID',
      },
    );
    const preview = await createWholeChapterRewritePreview(input);
    expect(preview.state).toBe('pending');
    expect(preview.candidateBody).toBe('雨声压住了屋檐，门外的脚步越来越近。');
    expect(call).toHaveBeenCalledTimes(3);
    await expect(discardUserRevisionPreview(preview)).resolves.toMatchObject({
      state: 'discarded',
    });
  });
});

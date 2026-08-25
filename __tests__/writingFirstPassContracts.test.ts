/**
 * First-pass contracts must live in the Shared Writer, not in retired
 * Outline/Continuation writer cores. Kernel unification is not allowed to
 * drop V3.2 dual-channel adopt, one Formatter, per-stage thinking, or the
 * Brief revision compressor.
 */
import { compileSharedWritingPrompt } from '../src/services/writing/prompt/sharedPromptCompiler';
import { resolveElasticStageOutputReservation } from '../src/services/contextAutoAllocator';
import { executeSharedWriterStage } from '../src/services/writing/stages/writerCore';
import { compileKernelStageReasoning } from '../src/services/writing/contracts/stageReasoning';
import * as stageLlmCall from '../src/services/writing/stages/stageLlmCall';
import { setSecureLLMApiKey } from '../src/services/secureStorage';

function stageInput(overrides?: {
  outputContract?: 'prose' | 'json_envelope';
  reviewMode?: string;
  modelName?: string;
  thinking?: { type: 'enabled' | 'disabled' };
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  stageReasoning?: Record<string, unknown>;
}) {
  const requirements = {
    version: 1 as const,
    items: [],
    fingerprint: 'fp-first-pass',
  };
  const stagePolicy = {
    version: 1 as const,
    reviewMode: overrides?.reviewMode || 'full',
    strictness: 'fail-closed',
    semanticApplyRequired: true,
    stageOrder: [],
    outputContract: overrides?.outputContract || 'prose',
    skipRules: {},
    values: {
      stageReasoning: overrides?.stageReasoning,
    },
    requirementsFingerprint: requirements.fingerprint,
  };
  return {
    frozenContext: {
      version: 1,
      writingRunId: 'wr-fp',
      generationTraceId: 'gt-fp',
      projectId: 1,
      chapterId: 2,
      instruction: {
        title: '一次通过章',
        synopsis: '收回治理契约',
        userInstruction: '写完本章',
        currentContent: '',
        targetPosition: 1,
      },
      rendered: {
        version: 1,
        text: '【draft】初稿正文必须被修订合同引用，而不是从零另写。',
        items: [],
        estimatedInputTokens: 8,
        fingerprint: 'render-fp',
      },
      requirements,
      stagePolicy,
      model: {
        configId: 7,
        provider: 'openai_compatible',
        modelName: overrides?.modelName || 'frozen-model',
        url: 'https://frozen.example/v1/chat/completions',
        name: 'frozen',
        contextWindow: 32000,
        maxOutputTokens: 200000,
        thinking: overrides?.thinking || { type: 'enabled' },
        reasoningEffort: overrides?.reasoningEffort || 'high',
        credentialRef: { kind: 'llm-config-api-key', configId: 7 },
      },
      freezeFingerprint: 'freeze-fp',
    },
    artifacts: {
      draft: { stage: 'draft', body: '初稿正文必须被修订合同引用，而不是从零另写。' },
    },
    requirements,
    stagePolicy,
    modelConfig: {
      configId: 7,
      name: 'frozen',
      providerType: 'openai_compatible',
      url: 'https://frozen.example/v1/chat/completions',
      modelName: overrides?.modelName || 'frozen-model',
      contextWindow: 32000,
      maxOutputTokens: 200000,
      thinking: overrides?.thinking || { type: 'enabled' },
      reasoningEffort: overrides?.reasoningEffort || 'high',
      credentialRef: { kind: 'llm-config-api-key', configId: 7 },
    },
    trace: {
      freezeFingerprint: 'freeze-fp',
      requirementsFingerprint: requirements.fingerprint,
    },
  } as any;
}

describe('Writing Kernel first-pass contracts', () => {
  test('Outline Freeze compiles V3.3 per-stage thinking, not report-disabled', () => {
    const table = compileKernelStageReasoning({
      scenario: 'outline',
      modelName: 'deepseek-v4-flash',
      requestedEffort: 'high',
    });
    expect(table.review.thinking).toEqual({ type: 'enabled' });
    expect(table.review.reasoningEffort).toBe('high');
    expect(table.factCheck.thinking).toEqual({ type: 'enabled' });
    expect(table.factCheck.reasoningEffort).toBe('low');
    expect(table.revision.thinking).toEqual({ type: 'enabled' });
    expect(table.draft.thinking).toEqual({ type: 'enabled' });
  });

  test('Continuation DeepSeek V4 Freeze still disables thinking for JSON stages', () => {
    const table = compileKernelStageReasoning({
      scenario: 'continuation',
      modelName: 'deepseek-v4-flash',
      requestedEffort: 'high',
      continuationThinking: { type: 'disabled' },
    });
    expect(table.draft.thinking).toEqual({ type: 'disabled' });
    expect(table.revision.thinking).toEqual({ type: 'disabled' });
    expect(table.review.thinking).toEqual({ type: 'disabled' });
  });

  test('Revision is a Brief compressor, not an unbounded chapter rewrite', () => {
    const compiled = compileSharedWritingPrompt({
      stage: 'revision',
      frozenContext: stageInput().frozenContext,
      artifacts: stageInput().artifacts,
      requirements: stageInput().requirements,
      stagePolicy: stageInput().stagePolicy,
    });
    const text = compiled.messages.map(item => item.content).join('\n');
    expect(compiled.responseFormat).toBe('json_object');
    expect(compiled.maxTokens).toBe(
      resolveElasticStageOutputReservation({
        contextWindow: 32000,
        modelMaxOutputTokens: 200000,
      }),
    );
    expect(text).toMatch(/修订合同|Brief/);
    expect(text).toMatch(/strategy/);
    expect(text).toMatch(/不要从零重写|不要另起一篇|受控修订/);
    expect(text).not.toMatch(/重写完整章节，而不是打补丁/);
  });

  test('Review adopts a complete JSON candidate from reasoning without a second call', async () => {
    const transport = jest
      .spyOn(stageLlmCall, 'callWritingStageLLM')
      .mockResolvedValue({
        text: '',
        reasoningText: JSON.stringify({
          schemaVersion: 1,
          content: '未发现必须修改的问题',
          verdict: 'pass',
          findings: [],
        }),
        emptyReason: 'reasoning_only',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      } as any);
    try {
      const artifact = await executeSharedWriterStage({
        stage: 'review',
        stageInput: stageInput(),
      });
      expect(artifact.body).toContain('未发现必须修改的问题');
      expect(artifact.structured).toEqual(
        expect.objectContaining({ verdict: 'pass', findings: [] }),
      );
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls[0][2].thinking).toEqual({ type: 'enabled' });
      expect(transport.mock.calls[0][2].reasoningEffort).toBe('high');
    } finally {
      transport.mockRestore();
    }
  });

  test('unadoptable Review gets exactly one thinking-disabled Formatter', async () => {
    await setSecureLLMApiKey('sk-frozen-secret', 7);
    const transport = jest
      .spyOn(stageLlmCall, 'callWritingStageLLM')
      .mockResolvedValueOnce({
        text: '',
        reasoningText: '只有自然语言推理，没有 JSON。',
        emptyReason: 'reasoning_only',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      } as any)
      .mockResolvedValueOnce({
        text: JSON.stringify({
          schemaVersion: 1,
          content: 'Formatter 整理后的报告',
          verdict: 'needs_revision',
          findings: [{ target: 'opening', issue: '缺动作', instruction: '补上选择' }],
        }),
        inputTokens: 8,
        outputTokens: 12,
        totalTokens: 20,
      } as any);
    try {
      const artifact = await executeSharedWriterStage({
        stage: 'review',
        stageInput: stageInput(),
      });
      expect(artifact.body).toContain('Formatter 整理后的报告');
      expect(transport).toHaveBeenCalledTimes(2);
      expect(transport.mock.calls[0][2].thinking).toEqual({ type: 'enabled' });
      expect(transport.mock.calls[1][2].thinking).toEqual({ type: 'disabled' });
      expect(transport.mock.calls[1][2].reasoningEffort).toBeUndefined();
      expect(String(transport.mock.calls[1][2].scenario)).toMatch(/formatter/);
      expect(transport.mock.calls[1][1]).toBe(transport.mock.calls[0][1]);
      expect(transport.mock.calls[1][1]).toBeGreaterThan(4096);
    } finally {
      transport.mockRestore();
    }
  });

  test('Formatter failure does not start a third Primary replay', async () => {
    const transport = jest
      .spyOn(stageLlmCall, 'callWritingStageLLM')
      .mockResolvedValue({
        text: '',
        reasoningText: '仍然没有 JSON',
        emptyReason: 'reasoning_only',
        inputTokens: 4,
        outputTokens: 4,
        totalTokens: 8,
      } as any);
    try {
      await expect(
        executeSharedWriterStage({
          stage: 'review',
          stageInput: stageInput(),
        }),
      ).rejects.toMatchObject({ code: 'SHARED_WRITER_EMPTY_OUTPUT' });
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      transport.mockRestore();
    }
  });

  test('prose Draft never treats raw reasoning as chapter body', async () => {
    const transport = jest
      .spyOn(stageLlmCall, 'callWritingStageLLM')
      .mockResolvedValueOnce({
        text: '',
        reasoningText: '我想这样写一章很长的推理，但不是正文。',
        emptyReason: 'reasoning_only',
        inputTokens: 10,
        outputTokens: 40,
        totalTokens: 50,
      } as any)
      .mockResolvedValueOnce({
        text: '雨夜里他把暗号按了下去。',
        inputTokens: 10,
        outputTokens: 16,
        totalTokens: 26,
      } as any);
    try {
      const artifact = await executeSharedWriterStage({
        stage: 'draft',
        stageInput: stageInput({ outputContract: 'prose' }),
      });
      expect(artifact.body).toBe('雨夜里他把暗号按了下去。');
      expect(artifact.body).not.toContain('很长的推理');
      expect(transport).toHaveBeenCalledTimes(2);
      expect(transport.mock.calls[1][2].thinking).toEqual({ type: 'disabled' });
    } finally {
      transport.mockRestore();
    }
  });
});

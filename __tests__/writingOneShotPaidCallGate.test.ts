/**
 * One-Shot paid-call hard gates (极速档 V1.0 plan §4 / §13 Gate A).
 *
 * Within one one_shot chapter there must be at most ONE physical LLM request:
 *   - Formatter is forbidden (primary adoption failure fails closed).
 *   - Primary empty / reasoning-only / malformed never triggers a second call.
 * Standard profile keeps the V3.2 Formatter contract unchanged.
 */
import { setSecureLLMApiKey } from '../src/services/secureStorage';
import { executeSharedWriterStage } from '../src/services/writing/stages/writerCore';
import * as stageLlmCall from '../src/services/writing/stages/stageLlmCall';

function oneShotStageInput(profile: 'one_shot' | 'standard') {
  const requirements = {
    version: 1 as const,
    items: [],
    fingerprint: 'requirements-gate',
  };
  const frozenContext = {
    version: 1,
    writingRunId: 'wr-gate',
    generationTraceId: 'gt-gate',
    projectId: 1,
    chapterId: 2,
    instruction: {
      title: '门禁章',
      synopsis: '验证一次调用',
      userInstruction: '写完本章',
      currentContent: '',
      targetPosition: 1,
    },
    rendered: {
      version: 1,
      text: '【outline:current】\n上下文内容',
      items: [],
      estimatedInputTokens: 12,
      fingerprint: 'render-gate',
    },
    requirements,
    stagePolicy: {
      version: 1,
      reviewMode: 'full',
      strictness: 'fail-closed',
      semanticApplyRequired: true,
      stageOrder: [],
      outputContract: 'prose' as const,
      skipRules: {},
      values:
        profile === 'one_shot'
          ? {
              executionProfile: 'one_shot',
            }
          : {},
      requirementsFingerprint: requirements.fingerprint,
    },
    model: {
      configId: 7,
      provider: 'openai_compatible',
      modelName: 'gate-model',
      url: 'https://gate.example/v1/chat/completions',
      name: 'gate-config',
      contextWindow: 32000,
      maxOutputTokens: 2048,
      allowInsecureLanHttp: false,
      thinking: { type: 'enabled' as const },
      reasoningEffort: 'low' as const,
      credentialRef: { kind: 'llm-config-api-key' as const, configId: 7 },
    },
    freezeFingerprint: 'freeze-gate',
  } as any;
  return {
    frozenContext,
    artifacts: {},
    requirements,
    stagePolicy: frozenContext.stagePolicy,
    modelConfig: {
      configId: 7,
      name: 'gate-config',
      providerType: 'openai_compatible',
      url: 'https://gate.example/v1/chat/completions',
      modelName: 'gate-model',
      contextWindow: 32000,
      maxOutputTokens: 2048,
      thinking: { type: 'enabled' as const },
      reasoningEffort: 'low' as const,
      credentialRef: { kind: 'llm-config-api-key' as const, configId: 7 },
    },
    trace: {
      freezeFingerprint: 'freeze-gate',
      requirementsFingerprint: requirements.fingerprint,
    },
  } as any;
}

describe('One-Shot paid LLM call gate', () => {
  beforeEach(async () => {
    await setSecureLLMApiKey('sk-gate', 7);
  });

  test('one_shot primary success = exactly one physical call, persisted, no formatter', async () => {
    const transport = jest
      .spyOn(stageLlmCall, 'callWritingStageLLM')
      .mockResolvedValue({
        text: '极速档一次生成的完整正文。',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      } as any);
    try {
      const artifact = await executeSharedWriterStage({
        stage: 'draft',
        stageInput: oneShotStageInput('one_shot'),
      });
      expect(artifact.body).toContain('极速档一次生成的完整正文');
      expect(artifact.formatterUsed).toBeFalsy();
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      transport.mockRestore();
    }
  });

  test('one_shot reasoning-only primary FAILS CLOSED without a formatter call', async () => {
    const transport = jest
      .spyOn(stageLlmCall, 'callWritingStageLLM')
      .mockResolvedValue({
        text: '',
        reasoningText: '这是模型隐藏推理，没有正文。',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        emptyReason: 'reasoning_only',
      } as any);
    try {
      await expect(
        executeSharedWriterStage({
          stage: 'draft',
          stageInput: oneShotStageInput('one_shot'),
        }),
      ).rejects.toMatchObject({
        code: 'SHARED_WRITER_EMPTY_OUTPUT',
      });
      // The hard gate: no second physical request was ever issued.
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      transport.mockRestore();
    }
  });

  test('one_shot provider failure FAILS CLOSED (no retry, no formatter)', async () => {
    const transport = jest
      .spyOn(stageLlmCall, 'callWritingStageLLM')
      .mockRejectedValue(
        Object.assign(new Error('provider timeout'), {
          failureClass: 'safe_retry',
        }),
      );
    try {
      await expect(
        executeSharedWriterStage({
          stage: 'draft',
          stageInput: oneShotStageInput('one_shot'),
        }),
      ).rejects.toThrow('provider timeout');
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      transport.mockRestore();
    }
  });

  test('one_shot structured continuation draft with malformed reasoning-only output fails closed after one call', async () => {
    const input = oneShotStageInput('one_shot');
    input.stagePolicy.reviewMode = 'continuation-v5';
    input.stagePolicy.outputContract = 'json_envelope';
    input.frozenContext.stagePolicy = input.stagePolicy;
    const transport = jest
      .spyOn(stageLlmCall, 'callWritingStageLLM')
      .mockResolvedValue({
        text: '',
        reasoningText: '推理内容也不是JSON',
        inputTokens: 5,
        outputTokens: 5,
        totalTokens: 10,
        emptyReason: 'reasoning_only',
      } as any);
    try {
      // json_envelope draft with nothing adoptable: the standard profile
      // would rescue via Formatter; one_shot must fail closed instead.
      await expect(
        executeSharedWriterStage({
          stage: 'draft',
          stageInput: input,
        }),
      ).rejects.toMatchObject({
        code: 'SHARED_WRITER_EMPTY_OUTPUT',
      });
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      transport.mockRestore();
    }
  });

  test('standard profile keeps the thinking-disabled Formatter rescue contract', async () => {
    const transport = jest
      .spyOn(stageLlmCall, 'callWritingStageLLM')
      .mockResolvedValueOnce({
        text: '',
        reasoningText: '只有推理。',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        emptyReason: 'reasoning_only',
      } as any)
      .mockResolvedValueOnce({
        text: 'Formatter 整理出的正文。',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      } as any);
    try {
      const artifact = await executeSharedWriterStage({
        stage: 'draft',
        stageInput: oneShotStageInput('standard'),
      });
      expect(artifact.body).toContain('Formatter 整理出的正文');
      expect(artifact.formatterUsed).toBe(true);
      expect(transport).toHaveBeenCalledTimes(2);
      // The formatter call must be thinking-disabled.
      expect(transport.mock.calls[1][2].thinking).toEqual({ type: 'disabled' });
    } finally {
      transport.mockRestore();
    }
  });

  test('resume with a persisted draft artifact issues ZERO physical calls', async () => {
    const transport = jest
      .spyOn(stageLlmCall, 'callWritingStageLLM')
      .mockResolvedValue({
        text: 'must not be called',
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      } as any);
    try {
      const input = oneShotStageInput('one_shot');
      input.persistAdapter = {
        loadExisting: async () => ({
          stage: 'draft',
          body: '已持久化的 Draft 正文。',
        }),
        reserve: jest.fn(),
        persistStageArtifact: jest.fn(),
      };
      const artifact = await executeSharedWriterStage({
        stage: 'draft',
        stageInput: input,
      });
      expect(artifact.body).toContain('已持久化的 Draft 正文');
      expect(transport).not.toHaveBeenCalled();
      expect(input.persistAdapter.reserve).not.toHaveBeenCalled();
    } finally {
      transport.mockRestore();
    }
  });
});

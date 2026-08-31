import { setSecureLLMApiKey } from '../src/services/secureStorage';
import { compileSharedWritingPrompt } from '../src/services/writing/prompt/sharedPromptCompiler';
import { executeSharedWriterStage } from '../src/services/writing/stages/writerCore';
import * as stageLlmCall from '../src/services/writing/stages/stageLlmCall';
import * as llm from '../src/services/llm';
import { freezeV5ModelConfig } from '../src/services/continuation/generation/continuationV5Models';
import { buildContinuationKernelFrozenModel } from '../src/services/writing/scenario/continuationRunPreparation';

function draftStageInput() {
  const requirements = {
    version: 1 as const,
    items: [
      {
        id: 'obligation:draft-seal',
        kind: 'obligation' as const,
        severity: 'blocking' as const,
        validation: 'semantic' as const,
        text: '必须写完本章主要冲突',
      },
    ],
    fingerprint: 'requirements-seal',
  };
  const frozenContext = {
    version: 1,
    writingRunId: 'wr-seal',
    generationTraceId: 'gt-seal',
    projectId: 1,
    chapterId: 2,
    instruction: {
      title: '封口章',
      synopsis: '验证共享 Draft 编译',
      userInstruction: '写完本章',
      currentContent: '',
      targetPosition: 1,
    },
    rendered: {
      version: 1,
      text: '【outline:current】\n主角必须在雨夜做出选择。',
      items: [],
      estimatedInputTokens: 12,
      fingerprint: 'render-seal',
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
      values: {
        frozenStageMessages: {
          draft: [
            { role: 'system', content: 'OLD FROZEN DRAFT BYPASS' },
            { role: 'user', content: 'This old compileDraftStageRequest must not win.' },
          ],
        },
      },
      requirementsFingerprint: requirements.fingerprint,
    },
    model: {
      configId: 7,
      provider: 'openai_compatible',
      modelName: 'frozen-model',
      url: 'https://frozen.example/v1/chat/completions',
      name: 'frozen-config',
      contextWindow: 32000,
      maxOutputTokens: 2048,
      allowInsecureLanHttp: false,
      thinking: { type: 'enabled' as const },
      reasoningEffort: 'high' as const,
      credentialRef: { kind: 'llm-config-api-key' as const, configId: 7 },
    },
    freezeFingerprint: 'freeze-seal',
  } as any;

  return {
    frozenContext,
    artifacts: {},
    requirements,
    stagePolicy: frozenContext.stagePolicy,
    modelConfig: {
      configId: 7,
      name: 'frozen-config',
      providerType: 'openai_compatible',
      url: 'https://frozen.example/v1/chat/completions',
      modelName: 'frozen-model',
      contextWindow: 32000,
      maxOutputTokens: 2048,
      allowInsecureLanHttp: false,
      thinking: { type: 'enabled' as const },
      reasoningEffort: 'high' as const,
      credentialRef: { kind: 'llm-config-api-key' as const, configId: 7 },
    },
    trace: {
      freezeFingerprint: 'freeze-seal',
      requirementsFingerprint: requirements.fingerprint,
    },
  } as any;
}

describe('Writing Kernel final seal — Draft compile and frozen model behavior', () => {
  test('Outline and Continuation Draft both compile through the shared Draft prompt', () => {
    const outline = compileSharedWritingPrompt({
      stage: 'draft',
      ...draftStageInput(),
    });
    const continuationInput = draftStageInput();
    continuationInput.stagePolicy.reviewMode = 'continuation-v5';
    continuationInput.stagePolicy.outputContract = 'json_envelope';
    continuationInput.frozenContext.stagePolicy = continuationInput.stagePolicy;
    const continuation = compileSharedWritingPrompt({
      stage: 'draft',
      ...continuationInput,
    });

    expect(outline.messages[0].content).toContain('Shared Draft Writer');
    expect(continuation.messages[0].content).toContain('Shared Draft Writer');
    expect(outline.messages[1].content).toContain('主角必须在雨夜做出选择');
    expect(outline.messages[1].content).toContain('必须写完本章主要冲突');
    expect(outline.messages[1].content).toContain('【本章指令】');
    expect(continuation.messages[1].content).toContain('主角必须在雨夜做出选择');
  });

  test('frozenStageMessages cannot replace the shared Draft compile', () => {
    const result = compileSharedWritingPrompt({
      stage: 'draft',
      ...draftStageInput(),
    });
    const joined = result.messages.map(item => item.content).join('\n');
    expect(joined).not.toContain('OLD FROZEN DRAFT BYPASS');
    expect(joined).not.toContain('old compileDraftStageRequest must not win');
    expect(result.messages[0].content).toContain('Shared Draft Writer');
    expect(result.messages[1].content).toContain('【冻结上下文】');
  });

  test('post-Freeze request uses frozen model behavior and only resolves the credential', async () => {
    await setSecureLLMApiKey('sk-frozen-secret', 7);
    const liveRead = jest
      .spyOn(llm, 'resolveLLMRequestConfigById')
      .mockResolvedValue({
        id: 7,
        name: 'LIVE-CHANGED',
        provider_type: 'openai_compatible',
        api_key: 'sk-live-must-not-win',
        url: 'https://live.example/v1/chat/completions',
        model_name: 'live-changed-model',
        context_window: 999999,
        max_output_tokens: 99999,
        allow_insecure_lan_http: true,
        thinking: { type: 'disabled' },
      });
    const activeRead = jest
      .spyOn(llm, 'resolveLLMRequestConfig')
      .mockResolvedValue({
        id: 99,
        name: 'ACTIVE-LIVE',
        provider_type: 'openai_compatible',
        api_key: 'sk-active-must-not-win',
        url: 'https://active.example/v1/chat/completions',
        model_name: 'active-live-model',
        context_window: 111,
        max_output_tokens: 222,
      });
    const transport = jest
      .spyOn(stageLlmCall, 'callWritingStageLLM')
      .mockResolvedValue({
        text: '完整初稿正文。',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      } as any);

    try {
      const artifact = await executeSharedWriterStage({
        stage: 'draft',
        stageInput: draftStageInput(),
      });
      expect(artifact.body).toContain('完整初稿正文');
      expect(liveRead).not.toHaveBeenCalled();
      expect(activeRead).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledTimes(1);
      const requestConfig = transport.mock.calls[0][2].requestConfig;
      expect(requestConfig).toMatchObject({
        id: 7,
        name: 'frozen-config',
        provider_type: 'openai_compatible',
        api_key: 'sk-frozen-secret',
        url: 'https://frozen.example/v1/chat/completions',
        model_name: 'frozen-model',
        context_window: 32000,
        max_output_tokens: 2048,
        allow_insecure_lan_http: false,
        thinking: { type: 'enabled' },
      });
      expect(transport.mock.calls[0][2].reasoningEffort).toBe('high');
    } finally {
      liveRead.mockRestore();
      activeRead.mockRestore();
      transport.mockRestore();
    }
  });

  test('Continuation DeepSeek V4 Freeze keeps thinking enabled for the JSON draft contract', () => {
    const frozen = freezeV5ModelConfig({
      id: 7,
      name: 'deepseek-live',
      provider_type: 'openai_compatible',
      api_key: 'sk-must-not-be-frozen',
      url: 'https://api.deepseek.com/chat/completions',
      model_name: 'deepseek-v4-flash',
      context_window: 1000000,
      max_output_tokens: 200000,
      allow_insecure_lan_http: false,
      thinking: { type: 'enabled' },
    });
    expect(frozen.thinking).toEqual({ type: 'enabled' });
    expect(frozen).not.toHaveProperty('api_key');
    expect(frozen.url).toBe('https://api.deepseek.com/chat/completions');
    expect(frozen.allowInsecureLanHttp).toBe(false);

    const kernelModel = buildContinuationKernelFrozenModel({
      frozenModel: frozen,
    });
    expect(kernelModel.thinking).toEqual({ type: 'enabled' });
    expect(kernelModel.url).toBe('https://api.deepseek.com/chat/completions');
    expect(kernelModel.modelName).toBe('deepseek-v4-flash');
    expect(kernelModel.credentialRef).toEqual({
      kind: 'llm-config-api-key',
      configId: 7,
    });
  });

  test('Continuation Draft request enforces Thinking Always On without a live model read', async () => {
    await setSecureLLMApiKey('sk-frozen-secret', 7);
    const liveRead = jest
      .spyOn(llm, 'resolveLLMRequestConfigById')
      .mockResolvedValue({
        id: 7,
        name: 'LIVE-CHANGED',
        provider_type: 'openai_compatible',
        api_key: 'sk-live-must-not-win',
        url: 'https://live.example/v1/chat/completions',
        model_name: 'live-changed-model',
        context_window: 999999,
        max_output_tokens: 99999,
        thinking: { type: 'enabled' },
      });
    const transport = jest
      .spyOn(stageLlmCall, 'callWritingStageLLM')
      .mockResolvedValue({
        text: JSON.stringify({
          content: '续写初稿正文。',
          appliedObligationIds: ['obligation:draft-seal'],
        }),
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      } as any);

    try {
      const stageInput = draftStageInput();
      stageInput.stagePolicy.reviewMode = 'continuation-v5';
      stageInput.stagePolicy.outputContract = 'json_envelope';
      stageInput.frozenContext.stagePolicy = stageInput.stagePolicy;
      stageInput.modelConfig.modelName = 'deepseek-v4-flash';
      stageInput.modelConfig.url =
        'https://api.deepseek.com/chat/completions';
      stageInput.modelConfig.thinking = { type: 'disabled' };
      stageInput.frozenContext.model.thinking = { type: 'disabled' };

      const artifact = await executeSharedWriterStage({
        stage: 'draft',
        stageInput,
      });
      expect(artifact.body).toContain('续写初稿正文');
      expect(liveRead).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledTimes(1);
      const callConfig = transport.mock.calls[0]?.[2];
      expect(callConfig?.thinking).toEqual({ type: 'enabled' });
      expect(callConfig?.requestConfig?.thinking).toEqual({
        type: 'enabled',
      });
      expect(callConfig?.requestConfig?.model_name).toBe('deepseek-v4-flash');
    } finally {
      liveRead.mockRestore();
      transport.mockRestore();
    }
  });
});

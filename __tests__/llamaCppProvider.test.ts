/* eslint-env jest */

import { llamaCppProvider } from '../src/services/llm/llamaCppProvider';
import { generate as nativeGenerate } from '../src/native/LlamaCppModule';

let mockGenerationHandlers: any;

jest.mock('../src/services/database', () => ({
  getLocalModelById: jest.fn(async () => ({
    id: 'qwen3',
    display_name: 'Qwen3',
    relative_path: 'qwen3/model.gguf',
    status: 'ready',
    prompt_template: 'chatml',
  })),
  logLLMUsage: jest.fn(async () => undefined),
}));

jest.mock('../src/native/LlamaCppModule', () => ({
  isLlamaCppAvailable: jest.fn(() => true),
  loadModel: jest.fn(async () => ({ backend: 'cpu', loadTimeMs: 1 })),
  generate: jest.fn(async (requestId: string) => {
    mockGenerationHandlers.onCompleted({
      requestId,
      text: '正文生成成功。',
      outputTokens: 3,
      cancelled: false,
    });
  }),
  cancel: jest.fn(async () => undefined),
  observeGeneration: jest.fn((_requestId: string, handlers: any) => {
    mockGenerationHandlers = handlers;
    return jest.fn();
  }),
}));

describe('llamaCppProvider', () => {
  beforeEach(() => {
    mockGenerationHandlers = undefined;
    jest.clearAllMocks();
  });

  it('clamps legacy oversized local max output tokens before native generation', async () => {
    await llamaCppProvider.generate(
      [{ role: 'user', content: '写一段正文。' }],
      {
        requestConfig: {
          id: 2,
          name: '本地：Qwen3',
          provider_type: 'llama_cpp',
          api_key: '',
          model_name: 'qwen3',
          url: '',
          local_model_id: 'qwen3',
          local_backend: 'cpu',
          context_window: 4096,
          max_output_tokens: 4000,
        },
      },
    );

    expect(nativeGenerate).toHaveBeenCalledWith(
      expect.any(String),
      'qwen3',
      expect.objectContaining({ max_tokens: 512 }),
    );
  });

  it('keeps a lower local config limit even when callers pass a larger max token hint', async () => {
    await llamaCppProvider.generate(
      [{ role: 'user', content: '写一段正文。' }],
      {
        max_tokens: 1000,
        requestConfig: {
          id: 2,
          name: '本地：Qwen3',
          provider_type: 'llama_cpp',
          api_key: '',
          model_name: 'qwen3',
          url: '',
          local_model_id: 'qwen3',
          local_backend: 'cpu',
          context_window: 4096,
          max_output_tokens: 64,
        },
      },
    );

    expect(nativeGenerate).toHaveBeenCalledWith(
      expect.any(String),
      'qwen3',
      expect.objectContaining({ max_tokens: 64 }),
    );
  });

  it('suppresses and strips Qwen3 reasoning blocks', async () => {
    (nativeGenerate as jest.Mock).mockImplementationOnce(async (requestId: string, _modelId: string, options: any) => {
      expect(options.prompt).toContain('/no_think');
      mockGenerationHandlers.onCompleted({
        requestId,
        text: '<think>这里是思考过程。</think>\n正文生成成功。',
        outputTokens: 8,
        cancelled: false,
      });
    });

    const result = await llamaCppProvider.generate(
      [{ role: 'user', content: '写一段正文。' }],
      {
        requestConfig: {
          id: 2,
          name: '本地：Qwen3',
          provider_type: 'llama_cpp',
          api_key: '',
          model_name: 'qwen3',
          url: '',
          local_model_id: 'qwen3',
          local_backend: 'cpu',
          context_window: 4096,
          max_output_tokens: 64,
        },
      },
    );

    expect(result.text).toBe('正文生成成功。');
  });
});

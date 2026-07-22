import {
  normalizeChatCompletionUrl,
  createLLMConfigError,
  openAICompatibleProvider,
} from '../src/services/llm/openAICompatibleProvider';
import { testLLMConnection } from '../src/services/llm';

test.each([
  ['https://api.example.com', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/v1', 'https://api.example.com/v1/chat/completions'],
  [
    'https://api.example.com/v1/chat/completions/',
    'https://api.example.com/v1/chat/completions',
  ],
  ['https://api.deepseek.com', 'https://api.deepseek.com/chat/completions'],
  ['https://api.deepseek.com/', 'https://api.deepseek.com/chat/completions'],
  [
    'https://api.deepseek.com/v1',
    'https://api.deepseek.com/v1/chat/completions',
  ],
  // 智谱 BigModel 用 /v4 版本段，不应再追加 /v1（否则 404）
  [
    'https://open.bigmodel.cn/api/paas/v4',
    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  ],
  [
    'https://open.bigmodel.cn/api/coding/paas/v4',
    'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
  ],
])('normalizes OpenAI-compatible endpoint %s', (input, expected) => {
  expect(normalizeChatCompletionUrl(input)).toBe(expected);
});

test('uses a clear Chinese error when LLM configuration is incomplete', () => {
  expect(createLLMConfigError().message).toBe(
    '请先在设置中配置 API 地址、API Key 和模型名称。',
  );
});

test('tests an OpenAI-compatible LLM connection with the provided runtime config', async () => {
  const fetchMock = jest.fn(async (..._args: any[]) => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '连接成功' } }] }),
  }));
  globalThis.fetch = fetchMock as any;

  await expect(
    testLLMConnection(
      'http://192.168.1.8:8000/v1',
      'sk-real',
      'local-model',
      'openai_compatible',
      undefined,
      true,
    ),
  ).resolves.toBe('连接成功');
  expect(fetchMock).toHaveBeenCalledWith(
    'http://192.168.1.8:8000/v1/chat/completions',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer sk-real' }),
    }),
  );
});

test('requests JSON mode and exposes the provider finish reason', async () => {
  const fetchMock = jest.fn(async (..._args: any[]) => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: { content: '{"ok":true}' },
          finish_reason: 'length',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  }));
  globalThis.fetch = fetchMock as any;

  const result = await openAICompatibleProvider.generate(
    [{ role: 'user', content: 'Return JSON.' }],
    {
      max_tokens: 2400,
      responseFormat: 'json_object',
      requestConfig: {
        provider_type: 'openai_compatible',
        api_key: 'test-key',
        model_name: 'test-model',
        url: 'https://api.example.com/v1/chat/completions',
      },
    },
  );

  expect(result.finishReason).toBe('length');
  const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
  expect(request.response_format).toEqual({ type: 'json_object' });
});

test('falls back without JSON mode when a compatible provider rejects it', async () => {
  const fetchMock = jest
    .fn<any, any[]>()
    .mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'unknown response_format json_object',
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          { message: { content: '{"ok":true}' }, finish_reason: 'stop' },
        ],
      }),
    });
  globalThis.fetch = fetchMock as any;

  await expect(
    openAICompatibleProvider.generate(
      [{ role: 'user', content: 'Return JSON.' }],
      {
        responseFormat: 'json_object',
        requestConfig: {
          provider_type: 'openai_compatible',
          api_key: 'test-key',
          model_name: 'test-model',
          url: 'https://api.example.com/v1/chat/completions',
        },
      },
    ),
  ).resolves.toEqual(expect.objectContaining({ text: '{"ok":true}' }));

  expect(fetchMock).toHaveBeenCalledTimes(2);
  const retryRequest = JSON.parse(fetchMock.mock.calls[1][1]?.body as string);
  expect(retryRequest).not.toHaveProperty('response_format');
});

test('separates content and reasoning_content without fallback', async () => {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: '正式正文',
            reasoning_content: '内部推理过程',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    }),
  }));
  globalThis.fetch = fetchMock as any;

  const result = await openAICompatibleProvider.generate(
    [{ role: 'user', content: '写一段' }],
    {
      requestConfig: {
        provider_type: 'openai_compatible',
        api_key: 'test-key',
        model_name: 'test-model',
        url: 'https://api.example.com/v1/chat/completions',
      },
    },
  );

  expect(result.text).toBe('正式正文');
  expect(result.reasoningText).toBe('内部推理过程');
  expect(result.text).not.toContain('内部推理');
});

test('reasoning-only response yields null text', async () => {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: '',
            reasoning_content: '只有推理没有正文',
          },
          finish_reason: 'stop',
        },
      ],
    }),
  }));
  globalThis.fetch = fetchMock as any;

  const result = await openAICompatibleProvider.generate(
    [{ role: 'user', content: '写一段' }],
    {
      requestConfig: {
        provider_type: 'openai_compatible',
        api_key: 'test-key',
        model_name: 'test-model',
        url: 'https://api.example.com/v1/chat/completions',
      },
    },
  );

  expect(result.text).toBeNull();
  expect(result.reasoningText).toBe('只有推理没有正文');
});

test('content-only response keeps reasoningText null', async () => {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: { content: '只有正文' },
          finish_reason: 'stop',
        },
      ],
    }),
  }));
  globalThis.fetch = fetchMock as any;

  const result = await openAICompatibleProvider.generate(
    [{ role: 'user', content: '写一段' }],
    {
      requestConfig: {
        provider_type: 'openai_compatible',
        api_key: 'test-key',
        model_name: 'test-model',
        url: 'https://api.example.com/v1/chat/completions',
      },
    },
  );

  expect(result.text).toBe('只有正文');
  expect(result.reasoningText).toBeNull();
});

test('both empty content and reasoning yields null text', async () => {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '', reasoning_content: '' } }],
    }),
  }));
  globalThis.fetch = fetchMock as any;

  const result = await openAICompatibleProvider.generate(
    [{ role: 'user', content: '写一段' }],
    {
      requestConfig: {
        provider_type: 'openai_compatible',
        api_key: 'test-key',
        model_name: 'test-model',
        url: 'https://api.example.com/v1/chat/completions',
      },
    },
  );

  expect(result.text).toBeNull();
  expect(result.reasoningText).toBeNull();
});

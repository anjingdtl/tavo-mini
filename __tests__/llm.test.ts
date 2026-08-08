import {
  normalizeChatCompletionUrl,
  createLLMConfigError,
  openAICompatibleProvider,
  supportsReasoningEffort,
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

test('forwards an optional thinking control without changing callers that omit it', async () => {
  const fetchMock = jest.fn(async (..._args: any[]) => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
    }),
  }));
  globalThis.fetch = fetchMock as any;

  await openAICompatibleProvider.generate(
    [{ role: 'user', content: 'Return JSON.' }],
    {
      thinking: { type: 'disabled' },
      requestConfig: {
        provider_type: 'openai_compatible',
        api_key: 'test-key',
        model_name: 'test-model',
        url: 'https://api.example.com/v1/chat/completions',
      },
    },
  );

  const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
  expect(request.thinking).toEqual({ type: 'disabled' });
});

test.each(['low', 'medium', 'high', 'max'] as const)(
  'sends DeepSeek V4 Flash reasoning_effort=%s only for the official endpoint',
  async effort => {
    const fetchMock = jest.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '正文' }, finish_reason: 'stop' }],
      }),
    }));
    globalThis.fetch = fetchMock as any;

    await openAICompatibleProvider.generate(
      [{ role: 'user', content: '写一段' }],
      {
        thinking: { type: 'enabled' },
        reasoningEffort: effort,
        requestConfig: {
          provider_type: 'openai_compatible',
          api_key: 'test-key',
          model_name: 'deepseek-v4-flash',
          url: 'https://api.deepseek.com/v1/chat/completions',
        },
      },
    );

    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(request.thinking).toEqual({ type: 'enabled' });
    expect(request.reasoning_effort).toBe(effort);
  },
);

test('does not send reasoning_effort for a gateway or disabled thinking', async () => {
  expect(
    supportsReasoningEffort({
      providerType: 'openai_compatible',
      modelName: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    }),
  ).toBe(true);
  expect(
    supportsReasoningEffort({
      providerType: 'openai_compatible',
      modelName: 'deepseek-v4-flash',
      baseUrl: 'https://gateway.example.com/v1/chat/completions',
    }),
  ).toBe(false);

  const fetchMock = jest.fn(async (..._args: any[]) => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '正文' }, finish_reason: 'stop' }],
    }),
  }));
  globalThis.fetch = fetchMock as any;
  await openAICompatibleProvider.generate(
    [{ role: 'user', content: '写一段' }],
    {
      thinking: { type: 'disabled' },
      reasoningEffort: 'max',
      requestConfig: {
        provider_type: 'openai_compatible',
        api_key: 'test-key',
        model_name: 'deepseek-v4-flash',
        url: 'https://api.deepseek.com/v1/chat/completions',
      },
    },
  );
  const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
  expect(request).not.toHaveProperty('reasoning_effort');
});

test('reports official reasoning token usage and derives visible output tokens', async () => {
  const fetchMock = jest.fn(async (..._args: any[]) => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '正文' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        completion_tokens_details: { reasoning_tokens: 12 },
      },
    }),
  }));
  globalThis.fetch = fetchMock as any;
  const result = await openAICompatibleProvider.generate(
    [{ role: 'user', content: '写一段' }],
    {
      requestConfig: {
        provider_type: 'openai_compatible',
        api_key: 'test-key',
        model_name: 'deepseek-v4-flash',
        url: 'https://api.deepseek.com/v1/chat/completions',
      },
    },
  );
  expect(result.reasoningTokens).toBe(12);
  expect(result.visibleOutputTokens).toBe(8);
});

test('does not silently retry when DeepSeek rejects reasoning_effort', async () => {
  const fetchMock = jest.fn<any, any[]>().mockResolvedValue({
    ok: false,
    status: 400,
    text: async () => 'reasoning_effort unsupported',
    headers: { get: () => null },
  });
  globalThis.fetch = fetchMock as any;
  await expect(
    openAICompatibleProvider.generate(
      [{ role: 'user', content: '写一段' }],
      {
        responseFormat: 'json_object',
        thinking: { type: 'enabled' },
        reasoningEffort: 'high',
        requestConfig: {
          provider_type: 'openai_compatible',
          api_key: 'test-key',
          model_name: 'deepseek-v4-flash',
          url: 'https://api.deepseek.com/v1/chat/completions',
        },
      },
    ),
  ).rejects.toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
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

// --- S1 fix: surface the real reason for an empty response (spec §1) ----

test('classifies a length-truncated empty response as emptyReason=length', async () => {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: { content: '' },
          finish_reason: 'length',
        },
      ],
    }),
  }));
  globalThis.fetch = fetchMock as any;

  const result = await openAICompatibleProvider.generate(
    [{ role: 'user', content: 'x' }],
    {
      requestConfig: {
        provider_type: 'openai_compatible',
        api_key: 'k',
        model_name: 'm',
        url: 'https://api.example.com/v1/chat/completions',
      },
    },
  );

  expect(result.text).toBeNull();
  expect(result.emptyReason).toBe('length');
});

test('classifies a reasoning-only response as emptyReason=reasoning_only', async () => {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: { content: '', reasoning_content: '推理烧光预算' },
          finish_reason: 'length',
        },
      ],
    }),
  }));
  globalThis.fetch = fetchMock as any;

  const result = await openAICompatibleProvider.generate(
    [{ role: 'user', content: 'x' }],
    {
      requestConfig: {
        provider_type: 'openai_compatible',
        api_key: 'k',
        model_name: 'm',
        url: 'https://api.example.com/v1/chat/completions',
      },
    },
  );

  expect(result.text).toBeNull();
  expect(result.reasoningText).toBe('推理烧光预算');
  expect(result.emptyReason).toBe('reasoning_only');
});

test('throws the real gateway error when a 200 response carries an error body', async () => {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      error: {
        code: 'unsupported_parameter',
        message: 'response_format 不被当前模型支持',
      },
    }),
  }));
  globalThis.fetch = fetchMock as any;

  await expect(
    openAICompatibleProvider.generate(
      [{ role: 'user', content: 'x' }],
      {
        requestConfig: {
          provider_type: 'openai_compatible',
          api_key: 'k',
          model_name: 'm',
          url: 'https://api.example.com/v1/chat/completions',
        },
      },
    ),
  ).rejects.toThrow(/unsupported_parameter|response_format/);
});

test('joins content array parts before deciding emptiness', async () => {
  // Some gateways return content as [{type:'text',text:'...'}].
  const fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: [
              { type: 'text', text: '{"ok":' },
              { type: 'text', text: 'true}' },
            ],
          },
          finish_reason: 'stop',
        },
      ],
    }),
  }));
  globalThis.fetch = fetchMock as any;

  const result = await openAICompatibleProvider.generate(
    [{ role: 'user', content: 'x' }],
    {
      requestConfig: {
        provider_type: 'openai_compatible',
        api_key: 'k',
        model_name: 'm',
        url: 'https://api.example.com/v1/chat/completions',
      },
    },
  );

  expect(result.text).toBe('{"ok":true}');
  expect(result.emptyReason).toBeUndefined();
});

test('marks a no-choices 200 response (without error body) as emptyReason=no_choices', async () => {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [] }),
  }));
  globalThis.fetch = fetchMock as any;

  const result = await openAICompatibleProvider.generate(
    [{ role: 'user', content: 'x' }],
    {
      requestConfig: {
        provider_type: 'openai_compatible',
        api_key: 'k',
        model_name: 'm',
        url: 'https://api.example.com/v1/chat/completions',
      },
    },
  );

  expect(result.text).toBeNull();
  expect(result.emptyReason).toBe('no_choices');
});

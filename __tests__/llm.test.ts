import { normalizeChatCompletionUrl, createLLMConfigError, testLLMConnection } from '../src/services/llm';

test.each([
  ['https://api.example.com', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/v1', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/v1/chat/completions/', 'https://api.example.com/v1/chat/completions'],
  ['https://api.deepseek.com', 'https://api.deepseek.com/chat/completions'],
  ['https://api.deepseek.com/', 'https://api.deepseek.com/chat/completions'],
  ['https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/chat/completions'],
  // 智谱 BigModel 用 /v4 版本段，不应再追加 /v1（否则 404）
  ['https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4/chat/completions'],
  ['https://open.bigmodel.cn/api/coding/paas/v4', 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'],
])('normalizes OpenAI-compatible endpoint %s', (input, expected) => {
  expect(normalizeChatCompletionUrl(input)).toBe(expected);
});

test('uses a clear Chinese error when LLM configuration is incomplete', () => {
  expect(createLLMConfigError().message).toBe('请先在设置中配置 API 地址、API Key 和模型名称。');
});

test('tests an OpenAI-compatible LLM connection with the provided runtime config', async () => {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '连接成功' } }] }),
  }));
  globalThis.fetch = fetchMock as any;

  await expect(testLLMConnection('http://192.168.1.8:8000/v1', 'sk-real', 'local-model')).resolves.toBe('连接成功');
  expect(fetchMock).toHaveBeenCalledWith(
    'http://192.168.1.8:8000/v1/chat/completions',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer sk-real' }),
    }),
  );
});

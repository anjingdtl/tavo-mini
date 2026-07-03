/* eslint-env jest */
/**
 * 非流式流水线 LLM 调用集成仿真。
 *
 * 仿真方式：mock fetch + 数据库 + LLM；不依赖真物理设备。
 */

import { callLLMResult, resolveLLMRequestConfig } from '../src/services/llm';

const mockGetLLMConfig = jest.fn();
const mockLogLLMUsage = jest.fn();
const mockSecure = {
  getSecureLLMApiKey: jest.fn(async () => 'sk-e2e-test'),
  migrateLegacyLLMApiKey: jest.fn(async () => null),
};

jest.mock('../src/services/database', () => ({
  getLLMConfig: (...args: any[]) => mockGetLLMConfig(...args),
  logLLMUsage: (...args: any[]) => mockLogLLMUsage(...args),
}));
jest.mock('../src/services/secureStorage', () => mockSecure);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetLLMConfig.mockResolvedValue({
    id: 99,
    name: 'e2e-config',
    base_url: 'https://e2e.local/v1',
    api_key: 'sk-e2e-test',
    model_name: 'e2e-model',
    is_active: 1,
  });
  mockLogLLMUsage.mockResolvedValue(undefined);
});

function nonStreamOk(jsonBody: any): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => jsonBody,
  } as any;
}

describe('pipeline LLM non-streaming integration', () => {
  test('callLLMResult sends non-streaming requests and records usage', async () => {
    globalThis.fetch = jest.fn(async () => nonStreamOk({
      choices: [{ message: { content: 'non-stream result' } }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    })) as any;

    const result = await callLLMResult(
      [{ role: 'user', content: 'x' }],
      200,
      { scenario: 'pipeline_draft' },
    );

    expect(result.text).toBe('non-stream result');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://e2e.local/v1/chat/completions',
      expect.objectContaining({
        body: expect.stringContaining('"stream":false'),
      }),
    );
    expect(mockLogLLMUsage).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success',
      scenario: 'pipeline_draft',
      totalTokens: 8,
    }));
  });

  test('resolved request config can be reused across parallel non-streaming calls', async () => {
    const requestConfig = await resolveLLMRequestConfig();
    const callOrder: string[] = [];
    globalThis.fetch = jest.fn(async (_u: any, opts: any) => {
      const body = String(opts?.body || '');
      callOrder.push(body.includes('审阅') ? 'review' : 'fact');
      return nonStreamOk({
        choices: [{ message: { content: body.includes('审阅') ? 'review-out' : 'fact-out' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }) as any;

    const reviewPromise = callLLMResult(
      [
        { role: 'system', content: '你是一位资深小说审阅编辑' },
        { role: 'user', content: '请审阅以下小说初稿：草稿内容' },
      ],
      200,
      { scenario: 'pipeline_review', requestConfig },
    );
    const factPromise = callLLMResult(
      [
        { role: 'system', content: '你是小说事实核查员' },
        { role: 'user', content: '设定：草稿内容' },
      ],
      200,
      { scenario: 'pipeline_factcheck', requestConfig },
    );

    const [review, fact] = await Promise.all([reviewPromise, factPromise]);

    expect(mockGetLLMConfig).toHaveBeenCalledTimes(1);
    expect(callOrder.sort()).toEqual(['fact', 'review']);
    expect([review.text, fact.text].sort()).toEqual(['fact-out', 'review-out']);
  });

  test('external abort is reported as cancelled for non-streaming requests', async () => {
    const ac = new AbortController();
    globalThis.fetch = jest.fn(async (_u: any, opts: any) => {
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const e: any = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
        setTimeout(() => ac.abort(), 20);
      });
    }) as any;

    await expect(callLLMResult(
      [{ role: 'user', content: 'a' }],
      200,
      { scenario: 'pipeline_draft' },
      ac.signal,
    )).rejects.toMatchObject({ code: 'cancelled' });
  });
});

import { TextEncoder } from 'util';
import {
  callLLMStream,
  type LLMStreamHandlers,
} from '../src/services/llm';

const mockGetLLMConfig = jest.fn();
const mockLogLLMUsage = jest.fn();
const mockSecure = {
  getSecureLLMApiKey: jest.fn(async () => 'sk-test'),
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
    id: 7,
    name: 'test-config',
    base_url: 'https://api.test/v1',
    api_key: 'sk-test',
    model_name: 'gpt-test',
    is_active: 1,
  });
  mockLogLLMUsage.mockResolvedValue(undefined);
});

// 构造一个分块发出的 SSE 响应，模拟真实流式
function sseResponse(events: any[], chunkEvery = 1): Response {
  const encoder = new TextEncoder();
  const body = events
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .join('');
  let cursor = 0;
  const step = chunkEvery;
  const reader = {
    read: jest.fn(async () => {
      if (cursor >= body.length) return { done: true, value: undefined };
      const chunk = body.slice(cursor, cursor + step);
      cursor += step;
      return { done: false, value: encoder.encode(chunk) };
    }),
  };
  return {
    ok: true,
    status: 200,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null),
    },
    body: { getReader: () => reader },
  } as any;
}

function collectHandlers(): LLMStreamHandlers & { chunks: string[] } {
  const chunks: string[] = [];
  let resolveDone: (v: any) => void;
  let rejectDone: (e: any) => void;
  const donePromise = new Promise<any>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // donePromise 由 collectHandlers 内部自管理；当生产代码在 onError 中 reject 它时，
  // 测试用例通过主 await 链路（callLLMStream 返回的 Promise）确认结果，
  // 但 donePromise 是 side promise，不应该产生 unhandledRejection。
  donePromise.catch(() => {});
  const handlers: LLMStreamHandlers = {
    onChunk: (delta: string) => chunks.push(delta),
    onDone: (r) => resolveDone(r),
    onError: (e) => rejectDone(e),
  };
  return Object.assign(handlers, { chunks, donePromise, resolveDone: resolveDone!, rejectDone: rejectDone! }) as any;
}

test('callLLMStream 解析 SSE 并按 chunk 回调，累积文本等于最终文本', async () => {
  const events = [
    { choices: [{ delta: { content: '你好' } }] },
    { choices: [{ delta: { content: '，' } }] },
    { choices: [{ delta: { content: '世界' } }] },
    { choices: [{ delta: { content: '！' } }] },
  ];
  globalThis.fetch = jest.fn(async () => sseResponse(events, 5)) as any;
  const h = collectHandlers() as any;
  const result = await callLLMStream(
    [{ role: 'user', content: 'hi' }],
    200,
    { scenario: 'pipeline_draft' },
    h,
  );
  expect(result.text).toBe('你好，世界！');
  expect(h.chunks.join('')).toBe('你好，世界！');
  expect(mockLogLLMUsage).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'success', scenario: 'pipeline_draft' }),
  );
});

test('callLLMStream 把 [DONE] 帧当作正常结束', async () => {
  const events = [
    { choices: [{ delta: { content: 'A' } }] },
    { choices: [{ delta: { content: 'B' } }] },
  ];
  const encoder = new TextEncoder();
  const raw = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  let cursor = 0;
  const reader = {
    read: jest.fn(async () => {
      if (cursor >= raw.length) return { done: true, value: undefined };
      const chunk = raw.slice(cursor, cursor + 8);
      cursor += 8;
      return { done: false, value: encoder.encode(chunk) };
    }),
  };
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body: { getReader: () => reader },
  })) as any;
  const h = collectHandlers() as any;
  const result = await callLLMStream(
    [{ role: 'user', content: 'hi' }],
    200,
    { scenario: 'chat' },
    h,
  );
  expect(result.text).toBe('AB');
});

test('callLLMStream 外部 signal 已 aborted 时立即抛 cancelled', async () => {
  const ac = new AbortController();
  ac.abort();
  const h = collectHandlers() as any;
  await expect(
    callLLMStream(
      [{ role: 'user', content: 'hi' }],
      200,
      { scenario: 'pipeline_draft' },
      h,
      ac.signal,
      { totalTimeoutMs: 5000, stallTimeoutMs: 1000 },
    ),
  ).rejects.toMatchObject({ code: 'cancelled' });
  // 失败路径应也写一条日志
  expect(mockLogLLMUsage).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'error', errorCode: 'cancelled' }),
  );
});

test('callLLMStream 检测到非 SSE Content-Type 时抛 stream_not_supported', async () => {
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    body: { getReader: () => ({ read: async () => ({ done: true }) }) },
  })) as any;
  const h = collectHandlers() as any;
  await expect(
    callLLMStream(
      [{ role: 'user', content: 'hi' }],
      200,
      { scenario: 'pipeline_draft' },
      h,
    ),
  ).rejects.toMatchObject({ code: 'stream_not_supported' });
});

test('callLLMStream 连接 stall 超时抛 stall', async () => {
  // 模拟真实 fetch：fetch 的 signal 触发 abort 时 reader.read() reject
  let storedSignal: AbortSignal | undefined;
  const reader = {
    read: jest.fn(() => new Promise<any>((_resolve, reject) => {
      if (storedSignal?.aborted) {
        const e: any = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
        return;
      }
      storedSignal?.addEventListener('abort', () => {
        const e: any = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      }, { once: true });
    })),
  };
  globalThis.fetch = jest.fn(async (_url: string, opts: any) => {
    storedSignal = opts?.signal;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: { getReader: () => reader },
    };
  }) as any;
  const h = collectHandlers() as any;
  await expect(
    callLLMStream(
      [{ role: 'user', content: 'hi' }],
      200,
      { scenario: 'pipeline_draft' },
      h,
      undefined,
      { stallTimeoutMs: 50, totalTimeoutMs: 5000 },
    ),
  ).rejects.toMatchObject({ code: 'stall' });
});

test('callLLMStream 总超时抛 timeout（在 stall 之前）', async () => {
  let storedSignal: AbortSignal | undefined;
  const reader = {
    read: jest.fn(() => new Promise<any>((_resolve, reject) => {
      if (storedSignal?.aborted) {
        const e: any = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
        return;
      }
      storedSignal?.addEventListener('abort', () => {
        const e: any = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      }, { once: true });
    })),
  };
  globalThis.fetch = jest.fn(async (_url: string, opts: any) => {
    storedSignal = opts?.signal;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: { getReader: () => reader },
    };
  }) as any;
  const h = collectHandlers() as any;
  await expect(
    callLLMStream(
      [{ role: 'user', content: 'hi' }],
      200,
      { scenario: 'pipeline_draft' },
      h,
      undefined,
      { stallTimeoutMs: 5000, totalTimeoutMs: 50 },
    ),
  ).rejects.toMatchObject({ code: 'timeout' });
});

test('callLLMStream 处理半包畸形 JSON 行（不抛错）', async () => {
  const encoder = new TextEncoder();
  // 故意混入一段畸形 JSON 行
  const raw =
    `data: {"choices":[{"delta":{"content":"OK"}}]}\n\n` +
    `data: not-json\n\n` +
    `data: [DONE]\n\n`;
  let cursor = 0;
  const reader = {
    read: jest.fn(async () => {
      if (cursor >= raw.length) return { done: true, value: undefined };
      const chunk = raw.slice(cursor, cursor + 10);
      cursor += 10;
      return { done: false, value: encoder.encode(chunk) };
    }),
  };
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body: { getReader: () => reader },
  })) as any;
  const h = collectHandlers() as any;
  const result = await callLLMStream(
    [{ role: 'user', content: 'hi' }],
    200,
    { scenario: 'pipeline_draft' },
    h,
  );
  expect(result.text).toBe('OK');
});

test('callLLMStream 当流里包含 usage 时把 prompt/completion 计入返回', async () => {
  const events = [
    { choices: [{ delta: { content: 'X' } }] },
    { choices: [{ delta: {} }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } },
  ];
  globalThis.fetch = jest.fn(async () => sseResponse(events, 999)) as any;
  const h = collectHandlers() as any;
  const result = await callLLMStream(
    [{ role: 'user', content: 'hi' }],
    200,
    { scenario: 'pipeline_draft' },
    h,
  );
  expect(result.text).toBe('X');
  expect(result.inputTokens).toBe(11);
  expect(result.outputTokens).toBe(5);
  expect(result.totalTokens).toBe(16);
  expect(result.rawUsage).toEqual({ prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 });
});

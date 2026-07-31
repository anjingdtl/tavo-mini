import {
  orderSourceFiles,
  type OrderingInputFile,
} from '../src/services/continuation/continuationOrderingService';

// Mock callLLMResult
jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(),
}));

import { callLLMResult } from '../src/services/llm';

const mockCallLLMResult = callLLMResult as jest.MockedFunction<typeof callLLMResult>;

const baseFiles: OrderingInputFile[] = [
  { index: 0, fileName: 'volume2.txt', fileSizeBytes: 100000, headSample: '第二卷 开始', tailSample: '第二卷 结束' },
  { index: 1, fileName: 'volume1.txt', fileSizeBytes: 100000, headSample: '第一卷 开始', tailSample: '第一卷 结束' },
  { index: 2, fileName: 'volume3.txt', fileSizeBytes: 100000, headSample: '第三卷 开始', tailSample: '第三卷 结束' },
];

describe('orderSourceFiles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns LLM-ordered indexes on success', async () => {
    mockCallLLMResult.mockResolvedValueOnce({
      text: JSON.stringify({
        order: [1, 0, 2],
        confidence: 0.9,
        reasoning: '按卷标记排序：第一卷在前，第二卷次之，第三卷最后',
      }),
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });

    const result = await orderSourceFiles(baseFiles, 1);

    expect(result.method).toBe('llm');
    expect(result.orderedFileIndexes).toEqual([1, 0, 2]);
    expect(result.confidence).toBe(0.9);
    expect(result.reasoning).toContain('第一卷');
  });

  it('falls back to filename sort when LLM throws', async () => {
    mockCallLLMResult.mockRejectedValueOnce(new Error('network'));

    const result = await orderSourceFiles(baseFiles, 1);

    expect(result.method).toBe('fallback_filename');
    expect(result.orderedFileIndexes).toEqual([1, 0, 2]); // volume1 < volume2 < volume3
    expect(result.confidence).toBe(0);
  });

  it('falls back when LLM returns invalid JSON', async () => {
    mockCallLLMResult.mockResolvedValueOnce({
      text: 'not json at all',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    const result = await orderSourceFiles(baseFiles, 1);

    expect(result.method).toBe('fallback_filename');
  });

  it('falls back when LLM returns incomplete indexes', async () => {
    mockCallLLMResult.mockResolvedValueOnce({
      text: JSON.stringify({ order: [0, 1], confidence: 0.8, reasoning: '...' }),
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    const result = await orderSourceFiles(baseFiles, 1);

    expect(result.method).toBe('fallback_filename');
  });

  it('falls back when LLM returns duplicate indexes', async () => {
    mockCallLLMResult.mockResolvedValueOnce({
      text: JSON.stringify({ order: [0, 0, 2], confidence: 0.8, reasoning: '...' }),
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    const result = await orderSourceFiles(baseFiles, 1);

    expect(result.method).toBe('fallback_filename');
  });

  it('falls back when LLM returns out-of-range indexes', async () => {
    mockCallLLMResult.mockResolvedValueOnce({
      text: JSON.stringify({ order: [0, 1, 5], confidence: 0.8, reasoning: '...' }),
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    const result = await orderSourceFiles(baseFiles, 1);

    expect(result.method).toBe('fallback_filename');
  });
});

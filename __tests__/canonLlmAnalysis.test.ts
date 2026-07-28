jest.mock('../src/services/llm', () => ({
  callLLM: jest.fn(),
  resolveLLMRequestConfigById: jest.fn(),
}));

import { callLLM, resolveLLMRequestConfigById } from '../src/services/llm';
import {
  defaultExtractorModeForProfile,
  extractWithLlm,
} from '../src/services/continuation/canon/canonAnalysisService';
import {
  asSourcePosition,
  asUtf16Offset,
} from '../src/services/continuation/continuationSourceRepository';

const chapter = {
  id: 7,
  sourceId: 3,
  position: asSourcePosition(0),
  title: '第一章',
  content: '林凡在青云镇拜师。',
  range: { start: asUtf16Offset(12), end: asUtf16Offset(22) },
  clippedByBoundary: false,
};

const validResult = JSON.stringify({
  schemaVersion: 1,
  worldRules: [],
  characters: [
    {
      canonicalName: '林凡',
      aliases: [],
      description: '在青云镇拜师的主角。',
      importance: 'primary',
      confidence: 0.9,
      evidence: [
        {
          chapterId: 7,
          chapterPosition: 0,
          charStart: 12,
          charEnd: 14,
          quotePreview: '林凡',
        },
      ],
    },
  ],
  relationships: [],
  plotThreads: [],
  experiences: [],
  knowledge: [],
  states: [],
  timelineEvents: [],
});

describe('Canon LLM analysis', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (resolveLLMRequestConfigById as jest.Mock).mockResolvedValue({
      id: 42,
      provider_type: 'openai_compatible',
      model_name: 'test-model',
      url: 'https://example.com/chat/completions',
      api_key: 'test',
    });
  });

  it('uses LLM for Standard and Deep while reserving Quick for offline preview', () => {
    expect(defaultExtractorModeForProfile('quick')).toBe('deterministic');
    expect(defaultExtractorModeForProfile('standard')).toBe('llm');
    expect(defaultExtractorModeForProfile('deep')).toBe('llm');
  });

  it('binds Deep extraction to the captured configuration and requests structured JSON', async () => {
    (callLLM as jest.Mock).mockResolvedValue(validResult);

    const result = await extractWithLlm([chapter], 'deep', 42);

    expect(result.characters[0].canonicalName).toBe('林凡');
    expect(resolveLLMRequestConfigById).toHaveBeenCalledWith(42);
    expect(callLLM).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining('bodyStart=12'),
        }),
      ]),
      8000,
      expect.objectContaining({
        responseFormat: 'json_object',
        scenario: 'continuation_canon_analysis',
        requestConfig: expect.objectContaining({ id: 42 }),
      }),
    );
  });

  it('does not silently replace an LLM failure with deterministic keywords', async () => {
    (callLLM as jest.Mock).mockRejectedValue(new Error('network unavailable'));

    await expect(extractWithLlm([chapter], 'deep', 42)).rejects.toThrow(
      'network unavailable',
    );
  });
});

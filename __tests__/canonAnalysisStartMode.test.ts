const mockOpenDatabase = jest.fn();
const mockExecute = jest.fn();
const mockInsertSnapshot = jest.fn();
const mockInsertRun = jest.fn();
const mockInsertBatches = jest.fn();
const mockInsertWorkItems = jest.fn();
const mockUpdateRunState = jest.fn();
const mockGetSnapshot = jest.fn();
const mockListBoundedSourceChapters = jest.fn();
const mockResolveConfig = jest.fn();
const mockV4 = jest.fn();

jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: (...args: any[]) => mockOpenDatabase(...args),
}));
jest.mock('../src/data/connection/execute', () => ({
  execute: (...args: any[]) => mockExecute(...args),
}));
jest.mock('../src/services/uuidBridge', () => ({
  v4: (...args: any[]) => mockV4(...args),
}));
jest.mock('../src/services/continuation/continuationSourceReader', () => ({
  continuationSourceReader: {
    getSnapshot: (...args: any[]) => mockGetSnapshot(...args),
    listBoundedSourceChapters: (...args: any[]) =>
      mockListBoundedSourceChapters(...args),
  },
}));
jest.mock('../src/services/llm', () => ({
  resolveLLMRequestConfig: (...args: any[]) => mockResolveConfig(...args),
  resolveLLMRequestConfigById: jest.fn(),
  callLLM: jest.fn(),
  callLLMResult: jest.fn(),
}));
jest.mock('../src/services/continuation/canon/canonRepository', () => ({
  insertSnapshot: (...args: any[]) => mockInsertSnapshot(...args),
  insertRun: (...args: any[]) => mockInsertRun(...args),
  insertBatches: (...args: any[]) => mockInsertBatches(...args),
  insertWorkItems: (...args: any[]) => mockInsertWorkItems(...args),
  updateRunState: (...args: any[]) => mockUpdateRunState(...args),
  asSourcePosition: (value: number) => value,
}));

import { startAnalysis } from '../src/services/continuation/canon/canonAnalysisService';
import {
  asSourcePosition,
  asUtf16Offset,
} from '../src/services/continuation/continuationSourceRepository';

function chapter(position: number) {
  return {
    id: position + 1,
    sourceId: 4,
    position: asSourcePosition(position),
    title: `第${position + 1}章`,
    content: `正文${position + 1}`,
    range: {
      start: asUtf16Offset(position * 100),
      end: asUtf16Offset(position * 100 + 80),
    },
    clippedByBoundary: false,
  };
}

describe('Canon analysis start modes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenDatabase.mockResolvedValue({});
    mockExecute.mockResolvedValue(undefined);
    mockInsertSnapshot.mockResolvedValue(undefined);
    mockInsertRun.mockResolvedValue(undefined);
    mockInsertBatches.mockResolvedValue(undefined);
    mockInsertWorkItems.mockResolvedValue(undefined);
    mockUpdateRunState.mockResolvedValue(undefined);
    mockGetSnapshot.mockResolvedValue({
      projectId: 9,
      sourceId: 4,
      sourceVersion: 1,
      normalizedSha256: 'source-hash',
      parserVersion: 'parser-1',
      normalizationVersion: 'normalizer-1',
      boundary: {
        chapterId: 35,
        chapterPosition: asSourcePosition(34),
        charOffsetExclusive: asUtf16Offset(3500),
      },
    });
    mockListBoundedSourceChapters.mockResolvedValue(
      Array.from({ length: 35 }, (_, index) => chapter(index)),
    );
    mockResolveConfig.mockResolvedValue({ id: 42 });
    mockV4.mockReturnValueOnce('snapshot-id').mockReturnValueOnce('run-id');
  });

  it('creates an LLM-backed 30-chapter tail plan for fast continuation', async () => {
    await startAnalysis({ projectId: 9, mode: 'fast_continuation' });

    expect(mockInsertRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profile: 'standard',
        modelConfigId: 42,
        progressTotal: 20,
      }),
    );
    const batches = mockInsertBatches.mock.calls[0][1];
    expect(batches).toHaveLength(10);
    expect(batches[0]).toMatchObject({ startPosition: 5, endPosition: 8 });
    expect(batches.at(-1)).toMatchObject({
      startPosition: 32,
      endPosition: 35,
    });
    expect(mockUpdateRunState).toHaveBeenCalledWith(
      expect.anything(),
      'run-id',
      expect.objectContaining({
        checkpointJson: expect.stringContaining('"tailChapterCount":30'),
      }),
    );
    expect(mockInsertWorkItems).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ materialType: 'character_state' }),
        expect.objectContaining({ materialType: 'world_plot' }),
      ]),
    );
    expect(mockInsertWorkItems.mock.calls[0][1]).toHaveLength(20);
  });

  it('uses all chapters and the deep LLM preset for complete Canon analysis', async () => {
    await startAnalysis({ projectId: 9, mode: 'full_canon' });

    expect(mockInsertRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ profile: 'deep', progressTotal: 24 }),
    );
    const batches = mockInsertBatches.mock.calls[0][1];
    expect(batches).toHaveLength(12);
    expect(batches[0]).toMatchObject({ startPosition: 0, endPosition: 3 });
    expect(batches.at(-1)).toMatchObject({
      startPosition: 33,
      endPosition: 35,
    });
    expect(mockInsertWorkItems.mock.calls[0][1]).toHaveLength(24);
  });

  it('refuses to start when a 4096-window local model cannot fit 3×6000-char chapters (S1)', async () => {
    // Local llama_cpp model with a 4096 context window.
    mockResolveConfig.mockResolvedValueOnce({
      id: 42,
      provider_type: 'llama_cpp',
      context_window: 4096,
      model_name: 'local.gguf',
      url: 'http://127.0.0.1:8080/v1/chat/completions',
      api_key: 'local',
    });
    // Three 6000-char chapters; the standard output baseline (8192) alone
    // already exceeds the 4096 effective window.
    mockListBoundedSourceChapters.mockResolvedValueOnce([
      chapter(0),
      chapter(1),
      chapter(2),
    ].map(c => ({ ...c, content: '字'.repeat(6000) })));

    await expect(
      startAnalysis({ projectId: 9, mode: 'fast_continuation' }),
    ).rejects.toThrow(/上下文不足|context/i);

    // Nothing should have been persisted for a refused run.
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
    expect(mockInsertRun).not.toHaveBeenCalled();
    expect(mockInsertBatches).not.toHaveBeenCalled();
  });

  it('refuses a local model even when context_window is reported large, because the provider clamps n_ctx to 4096 (S1)', async () => {
    // The llama.cpp provider clamps n_ctx to min(4096, context_window), so a
    // locally-reported 20000 window is effectively 4096 at inference time.
    // The preflight must use the same conservative ceiling and refuse rather
    // than let the run enter three identical retries that can never succeed.
    mockResolveConfig.mockResolvedValueOnce({
      id: 42,
      provider_type: 'llama_cpp',
      context_window: 20000,
      model_name: 'local.gguf',
      url: 'http://127.0.0.1:8080/v1/chat/completions',
      api_key: 'local',
    });
    mockListBoundedSourceChapters.mockResolvedValueOnce(
      Array.from({ length: 6 }, (_, i) => ({
        ...chapter(i),
        content: '字'.repeat(6000),
      })),
    );

    await expect(
      startAnalysis({ projectId: 9, mode: 'fast_continuation' }),
    ).rejects.toThrow(/上下文不足|context/i);
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
  });
});

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
        progressTotal: 50,
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
  });

  it('uses all chapters and the deep LLM preset for complete Canon analysis', async () => {
    await startAnalysis({ projectId: 9, mode: 'full_canon' });

    expect(mockInsertRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ profile: 'deep', progressTotal: 60 }),
    );
    const batches = mockInsertBatches.mock.calls[0][1];
    expect(batches).toHaveLength(12);
    expect(batches[0]).toMatchObject({ startPosition: 0, endPosition: 3 });
    expect(batches.at(-1)).toMatchObject({
      startPosition: 33,
      endPosition: 35,
    });
  });
});

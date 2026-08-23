/**
 * Stability Phase II — Phase 6 red/green coverage.
 *
 * Every source-capture failure on the Generation semantic path must remain an
 * explicit diagnostic when the existing degraded behavior returns an empty
 * source collection.
 */
jest.mock('../src/services/macroReplace', () => ({
  processMacros: jest.fn(async (text: string) => text),
}));

jest.mock('../src/services/database', () => ({
  getChaptersByProject: jest.fn(async () => []),
  getCharactersByProject: jest.fn(async () => {
    throw new Error('characters unavailable');
  }),
  getNotesByProject: jest.fn(async () => {
    throw new Error('notes unavailable');
  }),
  getNotesContentByIds: jest.fn(async () => ({})),
  getWorldbookEntriesByProject: jest.fn(async () => {
    throw new Error('worldbook unavailable');
  }),
  getProjectNoteConfig: jest.fn(async () => {
    throw new Error('note config unavailable');
  }),
  getProjectById: jest.fn(async () => ({ id: 7, mode: 'outline', name: 'p' })),
  getActiveLLMConfig: jest.fn(async () => ({
    id: 1,
    context_window: 128000,
  })),
}));

jest.mock('../src/data/repositories/outlineRepository', () => ({
  getEnabledOutlinesByProject: jest.fn(async () => []),
}));

jest.mock('../src/services/storyMemory/storyMemoryPrepare', () => ({
  prepareStoryMemoryForGeneration: jest.fn(async () => ({
    blocked: false,
    fatal: false,
    checkpoint: null,
    checkpointEligibility: { usable: false, reason: 'missing' },
    coverage: null,
    coverageCandidates: undefined,
    rawChapterIds: [],
    checkpointUpdated: false,
    warnings: [],
  })),
}));

jest.mock('../src/utils/idfCache', () => ({
  computeMemorySummarySignature: jest.fn(() => 'sig'),
  getCachedIdf: jest.fn(() => null),
  setCachedIdf: jest.fn(),
}));

jest.mock('../src/services/noteRetriever', () => ({
  retrieveNoteFragments: jest.fn(async () => {
    throw new Error('note retrieval unavailable');
  }),
}));

import { buildContext } from '../src/services/contextBuilder';
import * as db from '../src/services/database';
import {
  getUnclassifiedSemanticFallbacks,
  SECOND_PHASE_SILENT_FALLBACK_AUDIT,
} from '../src/services/context/generation/silentFallbackAudit';

const chapter = {
  id: 1,
  project_id: 7,
  position: 1,
  title: '当前章',
  synopsis: '当前章梗概',
  content: '',
  status: 'planned',
  summary_json: null,
  created_at: '',
  updated_at: '',
};

const config = {
  strategy: 'sliding',
  slidingWindowSize: 4,
  customRangeStart: 0,
  customRangeEnd: -1,
  resourceBudget: 2000,
  includeResources: true,
  memoryTopK: 5,
} as any;

test('Phase 6 gate has no unclassified semantic fallback', () => {
  expect(SECOND_PHASE_SILENT_FALLBACK_AUDIT.length).toBeGreaterThan(0);
  expect(getUnclassifiedSemanticFallbacks()).toEqual([]);
  expect(
    SECOND_PHASE_SILENT_FALLBACK_AUDIT.every(
      entry => entry.classification && entry.observability,
    ),
  ).toBe(true);
});

test('source capture failures are visible on the Generation semantic path', async () => {
  const result = await buildContext(chapter as any, config, 7, undefined, {
    contextWindow: 32000,
    reservedOutputTokens: 4000,
    contextBudgetVersion: 5,
  });

  const diagnostics = result.stabilityDiagnostics;
  // 统一写作核心：有窗口信息的调用走候选采集路径，失败经
  // resourcePreparation / resourceContextCandidates.* 诊断暴露（可观测性
  // 契约不变：code 必须出现，source 指向统一引擎的采集层）。
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'RESOURCE_RETRIEVAL_FAILED',
        source: 'collectGenerationMaterials.resourcePreparation',
      }),
      expect.objectContaining({
        code: 'NOTE_RETRIEVAL_FAILED',
        source: 'resourceContextCandidates.noteConfig',
      }),
    ]),
  );
});

test('note body and retrieval failures are separately visible', async () => {
  (db.getCharactersByProject as jest.Mock).mockResolvedValue([]);
  (db.getNotesByProject as jest.Mock).mockResolvedValue([
    { id: 9, title: '资料笔记', max_tokens: 1000 },
  ]);
  (db.getNotesContentByIds as jest.Mock).mockRejectedValue(
    new Error('note body unavailable'),
  );
  (db.getProjectNoteConfig as jest.Mock).mockResolvedValue({
    mode: 'retrieval',
    retrievalTopK: 5,
  });
  (db.getWorldbookEntriesByProject as jest.Mock).mockResolvedValue([]);

  const result = await buildContext(chapter as any, config, 7, undefined, {
    contextWindow: 32000,
    reservedOutputTokens: 4000,
    contextBudgetVersion: 5,
  });

  expect(result.stabilityDiagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'NOTE_RETRIEVAL_FAILED',
        source: 'resourceContextCandidates.noteRetrieval',
      }),
    ]),
  );
});

test('missing model capacity is classified before the outline budget fallback', async () => {
  (db.getCharactersByProject as jest.Mock).mockResolvedValue([]);
  (db.getNotesByProject as jest.Mock).mockResolvedValue([]);
  (db.getNotesContentByIds as jest.Mock).mockResolvedValue({});
  (db.getProjectNoteConfig as jest.Mock).mockResolvedValue(null);
  (db.getWorldbookEntriesByProject as jest.Mock).mockResolvedValue([]);
  (db.getActiveLLMConfig as jest.Mock).mockRejectedValue(
    new Error('model config unavailable'),
  );

  const result = await buildContext(chapter as any, config, 7);

  expect(result.stabilityDiagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'BUDGET_INVALID_CAPACITY',
        source: 'collectGenerationMaterials.collectOutline.activeModel',
      }),
    ]),
  );
});

test('hierarchical note config fallback is visible instead of becoming mode none', async () => {
  (db.getCharactersByProject as jest.Mock).mockResolvedValue([]);
  (db.getNotesByProject as jest.Mock).mockResolvedValue([
    { id: 12, title: '层级笔记', max_tokens: 1000 },
  ]);
  (db.getNotesContentByIds as jest.Mock).mockRejectedValue(
    new Error('hierarchical note body unavailable'),
  );
  (db.getProjectNoteConfig as jest.Mock).mockRejectedValue(
    new Error('hierarchical note config unavailable'),
  );
  (db.getWorldbookEntriesByProject as jest.Mock).mockResolvedValue([]);

  const result = await buildContext(chapter as any, config, 7, undefined, {
    contextWindow: 32000,
    reservedOutputTokens: 4000,
    contextBudgetVersion: 6,
  });

  expect(result.stabilityDiagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'NOTE_RETRIEVAL_FAILED',
        source: 'resourceContextCandidates.noteConfig',
      }),
    ]),
  );
});

test('hierarchical note retrieval and body fallbacks are visible', async () => {
  (db.getCharactersByProject as jest.Mock).mockResolvedValue([]);
  (db.getNotesByProject as jest.Mock).mockResolvedValue([
    { id: 12, title: '层级笔记', max_tokens: 1000 },
  ]);
  (db.getProjectNoteConfig as jest.Mock).mockResolvedValue({
    mode: 'retrieval',
    retrievalTopK: 5,
  });
  (db.getWorldbookEntriesByProject as jest.Mock).mockResolvedValue([]);

  const retrievalResult = await buildContext(chapter as any, config, 7, undefined, {
    contextWindow: 32000,
    reservedOutputTokens: 4000,
    contextBudgetVersion: 6,
  });
  expect(retrievalResult.stabilityDiagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'NOTE_RETRIEVAL_FAILED',
        source: 'resourceContextCandidates.noteRetrieval',
      }),
    ]),
  );

  (db.getProjectNoteConfig as jest.Mock).mockResolvedValue({ mode: 'original' });
  (db.getNotesContentByIds as jest.Mock).mockRejectedValue(
    new Error('hierarchical note body unavailable'),
  );
  const bodyResult = await buildContext(chapter as any, config, 7, undefined, {
    contextWindow: 32000,
    reservedOutputTokens: 4000,
    contextBudgetVersion: 6,
  });
  expect(bodyResult.stabilityDiagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'NOTE_RETRIEVAL_FAILED',
        source: 'resourceContextCandidates.noteContents',
      }),
    ]),
  );
});

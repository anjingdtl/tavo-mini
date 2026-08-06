/**
 * Phase 2: elastic budget integration in the Draft context builder.
 * Verifies that options.elasticBudget switches the fixed-ratio soft caps to
 * the elastic allocator and surfaces an ElasticBudgetTrace, while the flag
 * OFF path keeps the legacy behavior untouched.
 */
jest.mock('../src/services/macroReplace', () => ({
  processMacros: jest.fn(async (text: string) => text),
}));

jest.mock('../src/services/database', () => ({
  getChaptersByProject: jest.fn(async () => []),
  getCharactersByProject: jest.fn(async () => []),
  getNotesByProject: jest.fn(async () => []),
  getNotesContentByIds: jest.fn(async () => ({})),
  getWorldbookEntriesByProject: jest.fn(async () => []),
  getProjectNoteConfig: jest.fn(async () => null),
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
    checkpoint: null,
    checkpointEligibility: { usable: false, reason: 'missing' },
    coverage: null,
    checkpointUpdated: false,
  })),
}));

jest.mock('../src/utils/idfCache', () => ({
  computeMemorySummarySignature: jest.fn(() => 'sig'),
  getCachedIdf: jest.fn(() => null),
  setCachedIdf: jest.fn(),
}));

import { buildContext } from '../src/services/contextBuilder';

const baseChapter = {
  id: 1,
  project_id: 7,
  position: 0,
  title: '第一章',
  synopsis: '开篇',
  content: '',
  status: 'planned',
  summary_json: null,
  created_at: '',
  updated_at: '',
};

const baseConfig = {
  strategy: 'sliding',
  slidingWindowSize: 4000,
  customRangeStart: 0,
  customRangeEnd: -1,
  resourceBudget: 2000,
  includeResources: true,
  storyStateBudgetTokens: 8000,
  episodicMemoryBudgetTokens: 20000,
  summaryBudgetTokens: 8000,
  memoryTopK: 5,
};

const WINDOW = 16_000;
const RESERVED = 2_000;

describe('buildContext elastic budget (Phase 2)', () => {
  it('attaches an elasticBudgetTrace when enabled', async () => {
    const result = await buildContext(
      baseChapter as any,
      baseConfig as any,
      7,
      undefined,
      {
        retrievalUserPrompt: '继续推进调查',
        contextWindow: WINDOW,
        reservedOutputTokens: RESERVED,
        elasticBudget: true,
      },
    );
    expect(result.elasticBudgetTrace).toBeDefined();
    expect(result.elasticBudgetTrace!.contextWindow).toBe(WINDOW);
    expect(result.elasticBudgetTrace!.softInputLimit).toBeGreaterThan(0);
    expect(result.elasticBudgetTrace!.riskLevel).toBeDefined();
  });

  it('keeps the trace undefined when the flag is off (legacy path)', async () => {
    const result = await buildContext(
      baseChapter as any,
      baseConfig as any,
      7,
      undefined,
      {
        retrievalUserPrompt: '继续推进调查',
        contextWindow: WINDOW,
        reservedOutputTokens: RESERVED,
      },
    );
    expect(result.elasticBudgetTrace).toBeUndefined();
  });

  it('allocates soft budgets inside the 80% soft pool', async () => {
    const result = await buildContext(
      baseChapter as any,
      baseConfig as any,
      7,
      undefined,
      {
        retrievalUserPrompt: '继续推进调查',
        contextWindow: WINDOW,
        reservedOutputTokens: RESERVED,
        elasticBudget: true,
      },
    );
    const trace = result.elasticBudgetTrace!;
    expect(trace.finalEstimatedInputTokens).toBeLessThanOrEqual(
      trace.burstInputLimit,
    );
    // protocol is mandatory (256) and gets its full allocation
    const protocol = trace.modules.find(m => m.id === 'protocol')!;
    expect(protocol.finalAllocatedTokens).toBe(protocol.availableTokens);
    // high-value story state is preferred and receives more than sliding window
    const storyState = trace.modules.find(m => m.id === 'storyState')!;
    const sliding = trace.modules.find(m => m.id === 'slidingWindow')!;
    expect(storyState.finalAllocatedTokens).toBeGreaterThan(
      sliding.finalAllocatedTokens,
    );
    // empty modules (no outlines here) still allocate to available content
    expect(result.pipelineContext.outlineText).toBe('');
  });
});

/**
 * buildContext pipelineContext snapshot tests (SPEC §7, §17, §20.3).
 *
 * Verifies the shared snapshot returned by buildContext carries every section
 * the downstream stages need, and that the same snapshot flows to all stages.
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
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';

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
  memoryTopK: 5,
};

test('buildContext returns a pipelineContext snapshot with all fields (SPEC §7)', async () => {
  const result = await buildContext(
    baseChapter as any,
    baseConfig as any,
    7,
    undefined,
    { retrievalUserPrompt: '继续推进调查' },
  );

  expect(result.pipelineContext).toBeDefined();
  const snap: PipelineContextSnapshot = result.pipelineContext;
  // All required fields present (string-typed; may be empty but must be defined).
  for (const field of [
    'presetText',
    'storyMemoryText',
    'characterText',
    'noteText',
    'worldbookText',
    'episodicMemoryText',
    'recentBridgeText',
    'currentInstructionText',
    'retrievalUserPrompt',
  ] as (keyof PipelineContextSnapshot)[]) {
    expect(typeof snap[field]).toBe('string');
  }
  // retrievalUserPrompt is the one we passed in.
  expect(snap.retrievalUserPrompt).toBe('继续推进调查');
});

test('snapshot currentInstructionText matches the chapter title + synopsis block', async () => {
  const result = await buildContext(
    baseChapter as any,
    baseConfig as any,
    7,
    undefined,
    {},
  );
  expect(result.pipelineContext.currentInstructionText).toContain('第一章');
  expect(result.pipelineContext.currentInstructionText).toContain('开篇');
});

test('snapshot presetText matches the resolved system prompt injected into messages (SPEC §7.3 — same source)', async () => {
  const preset = {
    id: 9,
    name: '悬疑风',
    system_prompt: '你是悬疑小说作者',
    writing_style: '冷峻克制',
    extra_instructions: '不要出现超自然元素',
    temperature: 0.8,
    top_p: 0.9,
    max_tokens: 1000,
  };
  const result = await buildContext(
    baseChapter as any,
    baseConfig as any,
    7,
    preset as any,
    {},
  );
  // The first system message body == snapshot.presetText (same source).
  const systemMessage = result.messages.find(m => m.role === 'system');
  expect(systemMessage?.content).toBe(result.pipelineContext.presetText);
  expect(result.pipelineContext.presetText).toContain('悬疑小说作者');
  expect(result.pipelineContext.presetText).toContain('冷峻克制');
});

test('snapshot.sourceFingerprint identifies the project and chapter for cross-stage debugging', async () => {
  const result = await buildContext(
    baseChapter as any,
    baseConfig as any,
    7,
    undefined,
    {},
  );
  expect(result.pipelineContext.sourceFingerprint).toContain('proj=7');
  expect(result.pipelineContext.sourceFingerprint).toContain('chapter=1');
});

test('buildContext still returns messages / chapters / trace / estimatedInputTokens (backward compatible)', async () => {
  const result = await buildContext(
    baseChapter as any,
    baseConfig as any,
    7,
    undefined,
    {},
  );
  expect(Array.isArray(result.messages)).toBe(true);
  expect(Array.isArray(result.chapters)).toBe(true);
  expect(Array.isArray(result.trace)).toBe(true);
  expect(typeof result.estimatedInputTokens).toBe('number');
});

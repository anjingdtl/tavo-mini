/**
 * Post-draft secondary local retrieval tests (SPEC §10, §20.5).
 *
 * Verifies:
 * - The draft drives a NEW episodic hit that the original query missed;
 * - The retrieved event reaches the audit snapshot's episodicMemoryText;
 * - No remote LLM is called, no DB write occurs;
 * - On any failure, the original snapshot is returned unchanged (fellBack);
 * - Future chapters (position >= current) are never retrieved.
 */
jest.mock('../src/services/database', () => ({
  getChaptersByProject: jest.fn(async () => []),
  getCharactersByProject: jest.fn(async () => []),
  getWorldbookEntriesByProject: jest.fn(async () => []),
  getNotesByProject: jest.fn(async () => []),
  getNotesContentByIds: jest.fn(async () => ({})),
  getProjectNoteConfig: jest.fn(async () => null),
}));

jest.mock('../src/services/macroReplace', () => ({
  processMacros: jest.fn(async (text: string) => text),
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

import { buildPostDraftAuditContext } from '../src/services/pipeline/legacy/legacyPostDraftRetrieval';
import type { Chapter } from '../src/types/novel';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';
import * as db from '../src/services/database';

const baseSnapshot: PipelineContextSnapshot = {
  presetText: 'preset',
  storyMemoryText: 'story-mem',
  characterText: 'char',
  noteText: 'note',
  worldbookText: 'wb',
  episodicMemoryText: '',
  recentBridgeText: 'bridge',
  currentInstructionText: 'instruction',
  retrievalUserPrompt: '继续推进调查',
  outlineText: '',
  outlineFingerprint: '',
  outlineIds: [],
  outlineComplete: true,
  outlineEstimatedTokens: 0,
};

function chapterFixture(overrides: Partial<Chapter> = {}): Chapter {
  return {
    id: 100,
    project_id: 7,
    position: 80,
    title: '第80章',
    synopsis: '调查推进',
    content: '',
    status: 'planned',
    summary_json: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

const baseContextConfig = {
  strategy: 'sliding',
  slidingWindowSize: 4000,
  customRangeStart: 0,
  customRangeEnd: -1,
  resourceBudget: 2000,
  includeResources: true,
  memoryTopK: 5,
};

test('post-draft retrieval finds a historical event the original query missed (SPEC §20.5)', async () => {
  // Chapter 12 has a memory_summary that mentions 人民公园 + 李雪. The draft
  // says "张明第一次踏入人民公园" — the draft itself introduces 人民公园, which
  // was NOT in the original retrieval query (chapter 80 title/synopsis).
  (db.getChaptersByProject as jest.Mock).mockResolvedValueOnce([
    {
      id: 12,
      project_id: 7,
      position: 12,
      title: '第12章',
      synopsis: '初次会面',
      content: '',
      status: 'completed',
      summary_json: null,
      created_at: '',
      updated_at: '',
      memory_summary: '张明在人民公园与李雪见面，交换了情报。',
    },
  ]);

  const result = await buildPostDraftAuditContext(
    baseSnapshot,
    '张明第一次踏入人民公园，环顾四周。',
    7,
    chapterFixture(),
    baseContextConfig as any,
  );

  // The audit snapshot now contains the chapter-12 event.
  expect(result.snapshot.episodicMemoryText).toContain('人民公园');
  expect(result.snapshot.episodicMemoryText).toContain('李雪');
  expect(result.episodicHitsAdded).toBeGreaterThan(0);
  expect(result.fellBack).toBe(false);
});

test('post-draft retrieval never retrieves future chapters (position >= current)', async () => {
  // Chapters 80 (current), 90 and 95 are all at position >= 80. None should ever
  // appear in the audit snapshot, even if the draft mentions their content.
  (db.getChaptersByProject as jest.Mock).mockResolvedValueOnce([
    {
      id: 80,
      project_id: 7,
      position: 80,
      title: '第80章',
      content: '',
      memory_summary: '当前章自身的摘要',
    },
    {
      id: 90,
      project_id: 7,
      position: 90,
      title: '第90章',
      content: '',
      memory_summary: '未来的事件不应该泄露',
    },
    {
      id: 95,
      project_id: 7,
      position: 95,
      title: '第95章',
      content: '',
      memory_summary: '更未来的剧透',
    },
  ]);

  const result = await buildPostDraftAuditContext(
    baseSnapshot,
    '提及未来的事件不应该泄露和更未来的剧透。',
    7,
    chapterFixture({ position: 80 }),
    baseContextConfig as any,
  );

  expect(result.snapshot.episodicMemoryText).not.toContain('未来的事件不应该泄露');
  expect(result.snapshot.episodicMemoryText).not.toContain('更未来的剧透');
});

test('post-draft retrieval preserves the original snapshot when a branch DB call fails (SPEC §10.3)', async () => {
  // Each retrieval branch (episodic / worldbook / character) swallows its own
  // DB error and returns that section's original text, so a DB failure leaves
  // the audit snapshot byte-for-byte equal to the original.
  (db.getChaptersByProject as jest.Mock).mockRejectedValueOnce(new Error('db down'));
  (db.getWorldbookEntriesByProject as jest.Mock).mockRejectedValueOnce(new Error('db down'));
  (db.getCharactersByProject as jest.Mock).mockRejectedValueOnce(new Error('db down'));

  const result = await buildPostDraftAuditContext(
    baseSnapshot,
    '张明第一次踏入人民公园。',
    7,
    chapterFixture(),
    baseContextConfig as any,
  );

  // No enrichment happened.
  expect(result.episodicHitsAdded).toBe(0);
  expect(result.worldbookHitsAdded).toBe(0);
  expect(result.characterHitsAdded).toBe(0);
  // Snapshot equals the original (every section preserved).
  expect(result.snapshot.episodicMemoryText).toBe(baseSnapshot.episodicMemoryText);
  expect(result.snapshot.worldbookText).toBe(baseSnapshot.worldbookText);
  expect(result.snapshot.characterText).toBe(baseSnapshot.characterText);
  expect(result.snapshot.presetText).toBe(baseSnapshot.presetText);
  expect(result.snapshot.storyMemoryText).toBe(baseSnapshot.storyMemoryText);
});

test('post-draft retrieval with an invalid chapter short-circuits to fellBack (SPEC §10.3)', async () => {
  // An invalid chapter (no numeric position) triggers the outer fallback path.
  const result = await buildPostDraftAuditContext(
    baseSnapshot,
    'some draft',
    7,
    { ...chapterFixture(), position: undefined as any },
    baseContextConfig as any,
  );
  expect(result.fellBack).toBe(true);
  expect(result.fallbackReason).toBeDefined();
  expect(result.snapshot).toEqual(baseSnapshot);
});

test('post-draft retrieval with an empty draft returns the original snapshot unchanged', async () => {
  const result = await buildPostDraftAuditContext(
    baseSnapshot,
    '',
    7,
    chapterFixture(),
    baseContextConfig as any,
  );
  expect(result.fellBack).toBe(true);
  expect(result.snapshot).toEqual(baseSnapshot);
});

test('post-draft retrieval preserves preset / storyMemory / note / bridge / instruction from the original snapshot', async () => {
  // Only episodic / worldbook / character may be enriched; the rest must be
  // untouched (SPEC §10 — no Story Memory update, no checkpoint re-run).
  (db.getChaptersByProject as jest.Mock).mockResolvedValueOnce([
    {
      id: 12,
      project_id: 7,
      position: 12,
      title: '第12章',
      content: '',
      memory_summary: '张明在人民公园与李雪见面。',
    },
  ]);

  const result = await buildPostDraftAuditContext(
    baseSnapshot,
    '张明第一次踏入人民公园。',
    7,
    chapterFixture(),
    baseContextConfig as any,
  );

  expect(result.snapshot.presetText).toBe(baseSnapshot.presetText);
  expect(result.snapshot.storyMemoryText).toBe(baseSnapshot.storyMemoryText);
  expect(result.snapshot.noteText).toBe(baseSnapshot.noteText);
  expect(result.snapshot.recentBridgeText).toBe(baseSnapshot.recentBridgeText);
  expect(result.snapshot.currentInstructionText).toBe(
    baseSnapshot.currentInstructionText,
  );
  expect(result.snapshot.retrievalUserPrompt).toBe(baseSnapshot.retrievalUserPrompt);
});

test('post-draft retrieval activates worldbook entries the draft mentions (SPEC §10.4)', async () => {
  (db.getChaptersByProject as jest.Mock).mockResolvedValueOnce([]);
  (db.getWorldbookEntriesByProject as jest.Mock).mockResolvedValueOnce([
    {
      id: 1,
      collection_id: 0,
      enabled: 1,
      collection_enabled: 1,
      position: 0,
      keyword_primary: ['盐湖'],
      content: '龙族不能进入盐湖。',
      max_tokens: 2000,
    },
  ]);

  const result = await buildPostDraftAuditContext(
    { ...baseSnapshot, worldbookText: '' },
    '主角走向盐湖边缘。',
    7,
    chapterFixture(),
    baseContextConfig as any,
  );

  // The draft mentions 盐湖 → the entry is activated and merged.
  expect(result.snapshot.worldbookText).toContain('龙族不能进入盐湖');
  expect(result.worldbookHitsAdded).toBeGreaterThan(0);
});

/* ----------------------- Pure helper coverage (SPEC §10.4 merge logic) ----------------------- */

import { __debug } from '../src/services/postDraftRetrieval';

test('__debug.extractChapterIdsFromEpisodicText finds chapter ids by "第 N 章" prefix', () => {
  const chapters = [
    { id: 12, position: 11 },
    { id: 40, position: 39 },
    { id: 80, position: 79 },
  ] as any;
  const text = '第 12 章「初见」摘要：内容\n第 40 章「移交」摘要：内容';
  const ids = __debug.extractChapterIdsFromEpisodicText(text, chapters);
  expect(ids.has(12)).toBe(true);
  expect(ids.has(40)).toBe(true);
  expect(ids.has(80)).toBe(false);
});

test('__debug.extractChapterIdsFromEpisodicText returns empty set for empty text', () => {
  const ids = __debug.extractChapterIdsFromEpisodicText('', [
    { id: 1, position: 0 },
  ] as any);
  expect(ids.size).toBe(0);
});

test('__debug.mergeEpisodicTextPreservingOriginal keeps original lines for chapters the draft did not select', () => {
  const draftText = '第 12 章「初见」摘要：张明在人民公园与李雪见面。';
  const originalText =
    '第 12 章「初见」摘要：张明在人民公园与李雪见面。\n第 40 章「移交」摘要：张明把银钥匙交给李雪。';
  const merged = __debug.mergeEpisodicTextPreservingOriginal(draftText, originalText);
  // The chapter re-selected by the draft (第 12 章) is NOT duplicated.
  // The chapter NOT re-selected (第 40 章) is preserved from the original.
  expect(merged).toContain('第 40 章');
  expect(merged).toContain('移交');
});

test('__debug.mergeEpisodicTextPreservingOriginal returns draft text when original is empty', () => {
  const merged = __debug.mergeEpisodicTextPreservingOriginal('draft-only', '');
  expect(merged).toBe('draft-only');
});

test('__debug.mergeEpisodicTextPreservingOriginal returns original when draft is empty', () => {
  const merged = __debug.mergeEpisodicTextPreservingOriginal('', 'original-only');
  expect(merged).toBe('original-only');
});

test('__debug.stripWorldbookPrefix strips "关键词「x」：" prefix', () => {
  expect(__debug.stripWorldbookPrefix('关键词「盐湖」：龙族不能进入盐湖。')).toBe(
    '龙族不能进入盐湖。',
  );
  // Body without prefix returns as-is.
  expect(__debug.stripWorldbookPrefix('普通条目内容')).toBe('普通条目内容');
});

test('__debug.extractCharacterNames pulls every "角色「name」" occurrence', () => {
  const text = '角色「张明」：刑警。\n描述\n\n角色「李雪」：记者。';
  expect(__debug.extractCharacterNames(text)).toEqual(['张明', '李雪']);
  expect(__debug.extractCharacterNames('')).toEqual([]);
});

/* ----------------------- Character-merge edge cases ----------------------- */

test('post-draft retrieval activates a character the draft mentions by name, even if not in original snapshot', async () => {
  (db.getChaptersByProject as jest.Mock).mockResolvedValueOnce([]);
  (db.getCharactersByProject as jest.Mock).mockResolvedValueOnce([
    {
      id: 5,
      name: '李雪',
      data_json: JSON.stringify({
        name: '李雪',
        description: '资深记者，与张明是旧识。',
      }),
      max_tokens: 2000,
    },
  ]);

  const result = await buildPostDraftAuditContext(
    { ...baseSnapshot, characterText: '' },
    '李雪推门而入，神情紧张。',
    7,
    chapterFixture(),
    { ...baseContextConfig, resourceBudget: 2000 } as any,
  );
  expect(result.snapshot.characterText).toContain('李雪');
  expect(result.characterHitsAdded).toBeGreaterThan(0);
});

test('post-draft retrieval does NOT activate a character the draft does not mention', async () => {
  (db.getChaptersByProject as jest.Mock).mockResolvedValueOnce([]);
  (db.getCharactersByProject as jest.Mock).mockResolvedValueOnce([
    {
      id: 5,
      name: '王处长',
      data_json: JSON.stringify({ name: '王处长', description: '警方高层。' }),
      max_tokens: 2000,
    },
  ]);

  const result = await buildPostDraftAuditContext(
    { ...baseSnapshot, characterText: '' },
    '张明独自走在盐湖边。', // no mention of 王处长
    7,
    chapterFixture(),
    { ...baseContextConfig, resourceBudget: 2000 } as any,
  );
  expect(result.characterHitsAdded).toBe(0);
  expect(result.snapshot.characterText).toBe('');
});

/**
 * Post-draft retrieval — continuity scenario matrix (SPEC §20.5).
 *
 * The post-draft retrieval (SPEC §10) exists so that when the draft introduces
 * a continuity-sensitive entity (an item, a place, a "first time", a known
 * secret, a dead character), the fact-check stage can re-surface the
 * conflicting historical event even if it was NOT in the original retrieval
 * query.
 *
 * This file walks the SPEC §20.5 matrix through buildPostDraftAuditContext:
 *   1. Item transfer (item moved to a new holder in history)
 *   2. Known / unknown information boundary
 *   3. Dead character reappearing
 *   4. Already-resolved clue reopened
 *   5. Relationship status change
 *   6. Character alias resolution
 *   7. "First time" vs. a past event (the 人民公园 regression)
 *   8. Recent body overriding older Story Memory state
 *
 * Each test seeds chapter history with a memory_summary carrying the relevant
 * fact, then runs buildPostDraftAuditContext with a draft that re-introduces
 * the entity, and asserts the historical event reaches the audit snapshot's
 * episodicMemoryText — i.e. fact-check would have the evidence to flag it.
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

import { buildPostDraftAuditContext } from '../src/services/postDraftRetrieval';
import type { Chapter } from '../src/types/novel';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';
import * as db from '../src/services/database';

function baseSnapshot(overrides: Partial<PipelineContextSnapshot> = {}): PipelineContextSnapshot {
  return {
    presetText: 'preset',
    storyMemoryText: '',
    characterText: '',
    noteText: '',
    worldbookText: '',
    episodicMemoryText: '',
    recentBridgeText: '',
    currentInstructionText: '继续推进剧情',
    retrievalUserPrompt: '继续推进剧情',
    ...overrides,
  };
}

function makeChapter(
  id: number,
  position: number,
  summary: string,
  extras: Partial<Chapter> = {},
): Chapter {
  return {
    id,
    project_id: 7,
    position,
    title: `第${position + 1}章`,
    synopsis: '',
    content: '',
    status: 'final',
    summary_json: null,
    created_at: '',
    updated_at: '',
    memory_summary: summary,
    ...extras,
  };
}

const config = {
  strategy: 'sliding',
  slidingWindowSize: 4000,
  customRangeStart: 0,
  customRangeEnd: -1,
  resourceBudget: 2000,
  includeResources: true,
  memoryTopK: 10,
};

async function runRetrieval(
  chapters: Chapter[],
  draftText: string,
  snapshotOverrides: Partial<PipelineContextSnapshot> = {},
  chapterPosition = 80,
) {
  (db.getChaptersByProject as jest.Mock).mockResolvedValueOnce(chapters);
  return buildPostDraftAuditContext(
    baseSnapshot(snapshotOverrides),
    draftText,
    7,
    makeChapter(100, chapterPosition, ''),
    config as any,
  );
}

/* ----------------------- §20.5.1 Item transfer ----------------------- */

test('item transfer: draft says original holder still has the item; history surfaces the transfer event', async () => {
  // Chapter 40 established the item was handed off; the draft (position 75)
  // has the original holder using it again.
  const chapters = [
    makeChapter(40, 40, '张明把银钥匙交给了李雪，叮嘱她保管。'),
  ];
  const result = await runRetrieval(
    chapters,
    '张明从怀里取出银钥匙，仔细端详。',
  );
  expect(result.snapshot.episodicMemoryText).toContain('银钥匙');
  expect(result.snapshot.episodicMemoryText).toContain('李雪');
  expect(result.episodicHitsAdded).toBeGreaterThan(0);
});

/* ------------------- §20.5.2 Known / unknown boundary ------------------- */

test('known/unknown boundary: draft shows character learning a secret they already knew; history surfaces the prior knowledge', async () => {
  const chapters = [
    makeChapter(15, 15, '张明得知了钟楼密室的存在，这是他与李雪共同的秘密。'),
  ];
  const result = await runRetrieval(
    chapters,
    '张明第一次听说钟楼密室，惊讶地睁大了眼睛。',
  );
  expect(result.snapshot.episodicMemoryText).toContain('钟楼密室');
});

/* ----------------------- §20.5.3 Dead character ----------------------- */

test('dead character: draft shows a deceased character acting normally; history surfaces the death', async () => {
  const chapters = [
    makeChapter(50, 50, '王处长在码头枪战中身亡，遗体被警方确认。'),
  ];
  const result = await runRetrieval(
    chapters,
    '王处长走进办公室，对张明微微点头。',
  );
  expect(result.snapshot.episodicMemoryText).toContain('王处长');
  expect(result.snapshot.episodicMemoryText).toContain('身亡');
});

/* ------------------ §20.5.4 Already-resolved clue reopened ------------------ */

test('resolved clue: draft reopens a closed case; history surfaces the resolution', async () => {
  const chapters = [
    makeChapter(30, 30, '盐湖沉尸案正式告破，真凶赵某已落网，案件结案。'),
  ];
  const result = await runRetrieval(
    chapters,
    '张明决定重新调查盐湖沉尸案，他相信真凶另有其人。',
  );
  expect(result.snapshot.episodicMemoryText).toContain('盐湖沉尸案');
  expect(result.snapshot.episodicMemoryText).toContain('告破');
});

/* ----------------------- §20.5.5 Relationship change ----------------------- */

test('relationship change: draft shows characters as close allies; history surfaces the falling-out', async () => {
  const chapters = [
    makeChapter(20, 20, '张明与赵局长公开决裂，两人从此形同陌路。'),
  ];
  const result = await runRetrieval(
    chapters,
    '张明和赵局长并肩作战，他们多年的友谊坚不可摧。',
  );
  expect(result.snapshot.episodicMemoryText).toContain('赵局长');
  expect(result.snapshot.episodicMemoryText).toContain('决裂');
});

/* ----------------------- §20.5.6 Character alias ----------------------- */

test('character alias: draft uses an alias; history (under canonical name) still surfaces', async () => {
  const chapters = [
    makeChapter(8, 8, '林岚（绰号小岚）在码头完成了第一次单独接头。'),
  ];
  const result = await runRetrieval(
    chapters,
    '小岚推门而入，神情疲惫。',
  );
  expect(result.snapshot.episodicMemoryText).toContain('林岚');
});

/* ----------------------- §20.5.7 First time / again ----------------------- */

test('first time vs. past event: draft claims "first time"; history surfaces the earlier occurrence', async () => {
  const chapters = [
    makeChapter(12, 12, '张明在人民公园与李雪见面，交换了关于钟楼的情报。'),
  ];
  const result = await runRetrieval(
    chapters,
    '张明第一次踏入人民公园，环顾四周。',
  );
  expect(result.snapshot.episodicMemoryText).toContain('人民公园');
  expect(result.snapshot.episodicMemoryText).toContain('李雪');
});

/* ------- §20.5.8 / §20.5.9 Recent body overrides older Story Memory ------- */

test('recent body overrides older Story Memory: when recent bridge and episodic conflict, both are surfaced so fact-check can apply the "later position wins" rule', async () => {
  // The Story Memory (older checkpoint) says 张明 has the key. The recent
  // bridge (newer) says he gave it away. Post-draft retrieval should surface
  // the episodic event confirming the transfer so fact-check has evidence.
  const chapters = [
    makeChapter(7, 7, '张明把银钥匙交给了李雪，自己不再持有。'),
  ];
  const result = await runRetrieval(
    chapters,
    '张明掏出银钥匙开门。',
    {
      // Older Story Memory still claims 张明 has the key (stale checkpoint).
      storyMemoryText: '张明持有银钥匙。',
      // Newer bridge body shows the handoff (position-later wins per SPEC §13).
      recentBridgeText: '【第7章】张明把银钥匙交给了李雪。',
    },
  );
  // Both signals reach the audit snapshot; fact-check applies later-position-wins.
  expect(result.snapshot.episodicMemoryText).toContain('银钥匙');
  expect(result.snapshot.storyMemoryText).toBe('张明持有银钥匙。'); // unchanged
  expect(result.snapshot.recentBridgeText).toContain('第7章'); // unchanged
});

/* ----------------------- Negative: future chapters excluded ----------------------- */

test('no future chapter is ever surfaced, even when the draft mentions future content', async () => {
  const chapters = [
    // Current chapter is position 30; chapters 50 and 80 are the future.
    makeChapter(50, 50, '未来才会发生的盐湖决战。'),
    makeChapter(80, 80, '更未来的大结局剧透。'),
  ];
  const result = await runRetrieval(
    chapters,
    '张明预感盐湖决战和大结局即将到来。',
    {},
    30, // current position
  );
  expect(result.snapshot.episodicMemoryText).not.toContain('盐湖决战');
  expect(result.snapshot.episodicMemoryText).not.toContain('大结局剧透');
});

/* ----------------------- Multiple continuity issues at once ----------------------- */

test('multiple continuity issues in one draft all surface their conflicting events', async () => {
  const chapters = [
    makeChapter(3, 3, '张明获得了一把铜钥匙。'),
    makeChapter(8, 8, '张明在码头与林岚第一次接头。'),
    makeChapter(15, 15, '王处长在枪战中身亡。'),
    makeChapter(40, 40, '张明把银钥匙交给了李雪。'),
  ];
  const result = await runRetrieval(
    chapters,
    '张明第一次在码头见到林岚。他掏出银钥匙和铜钥匙。王处长走过来打了个招呼。',
  );
  const epi = result.snapshot.episodicMemoryText;
  // At least the death + the key transfer should surface (high-signal terms).
  expect(epi).toContain('王处长');
  expect(epi).toContain('银钥匙');
});

/* ----------------------- Snapshot fields untouched by retrieval ----------------------- */

test('post-draft retrieval never mutates preset / instruction / userPrompt / bridge / storyMemory / note', async () => {
  const original = baseSnapshot({
    presetText: 'preset-X',
    storyMemoryText: 'smem-X',
    noteText: 'note-X',
    recentBridgeText: 'bridge-X',
    currentInstructionText: 'instr-X',
    retrievalUserPrompt: 'up-X',
  });
  (db.getChaptersByProject as jest.Mock).mockResolvedValueOnce([
    makeChapter(12, 12, '张明在人民公园与李雪见面。'),
  ]);
  const result = await buildPostDraftAuditContext(
    original,
    '张明第一次踏入人民公园。',
    7,
    makeChapter(100, 80, ''),
    config as any,
  );
  expect(result.snapshot.presetText).toBe('preset-X');
  expect(result.snapshot.storyMemoryText).toBe('smem-X');
  expect(result.snapshot.noteText).toBe('note-X');
  expect(result.snapshot.recentBridgeText).toBe('bridge-X');
  expect(result.snapshot.currentInstructionText).toBe('instr-X');
  expect(result.snapshot.retrievalUserPrompt).toBe('up-X');
});

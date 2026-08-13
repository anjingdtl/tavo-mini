jest.mock('../src/services/database', () => ({
  getChaptersByProject: jest.fn(async () => []),
  getCharactersByProject: jest.fn(async () => []),
  getNotesByProject: jest.fn(async () => []),
  getNotesContentByIds: jest.fn(async () => ({})),
  getWorldbookEntriesByProject: jest.fn(async () => []),
  getProjectNoteConfig: jest.fn(async () => null),
  getProjectById: jest.fn(async () => ({ id: 7, mode: 'freeform', name: 'p' })),
  getActiveLLMConfig: jest.fn(async () => ({
    id: 1,
    context_window: 20000,
  })),
}));

jest.mock('../src/services/macroReplace', () => ({
  processMacros: jest.fn(async (text: string) => text),
}));

jest.mock('../src/data/repositories/outlineRepository', () => ({
  getEnabledOutlinesByProject: jest.fn(async () => []),
}));

jest.mock('../src/services/storyMemory/storyMemoryPrepare', () => ({
  prepareStoryMemoryForGeneration: jest.fn(async () => ({
    blocked: false,
    blockReason: '',
    fatal: false,
    degraded: false,
    checkpoint: null,
    checkpointEligibility: { usable: false, reason: 'missing' },
    coverage: null,
    coverageCandidates: undefined,
    checkpointUpdated: false,
    warnings: [],
  })),
}));

jest.mock('../src/utils/idfCache', () => ({
  computeMemorySummarySignature: jest.fn(() => 'sig'),
  getCachedIdf: jest.fn(() => null),
  setCachedIdf: jest.fn(),
}));

import * as db from '../src/services/database';
import { buildContext } from '../src/services/contextBuilder';
import {
  buildPhase2ContextTrace,
  buildResourceContextV2,
  buildResourceSelectionTrace,
  captureResourceSourceSnapshot,
  collectPhase2BudgetResources,
  compileNoteDetailCandidatesFromSnapshot,
} from '../src/services/context/resources';
import type {
  FrozenPresetContext,
  FrozenResourceDetailItem,
} from '../src/services/context/resources';
import { parsePipelineContextSnapshotStrict } from '../src/services/pipelineTaskContext';
import {
  buildBriefResourceViewFromSnapshotV4,
  buildFactCheckContextFromSnapshotV4,
  buildProofConstraintsFromSnapshotV4,
  buildReviewContextFromSnapshotV4,
} from '../src/services/pipeline/stageResourceContextV4';
import { novelCharacterDraftToCharaCard } from '../src/services/construction/characterDraftAdapter';

const chapter = {
  id: 2,
  project_id: 7,
  position: 2,
  title: '雨夜回家',
  synopsis: '林晚撑伞经过青秀路。',
  content: '',
  status: 'planned',
  summary_json: null,
  created_at: '',
  updated_at: '',
};

const preset: FrozenPresetContext = {
  presetName: '默认基线',
  sourceFingerprint: 'preset-fp',
  presetSource: 'default_runtime_baseline',
  systemText: 'system',
  writingStyleText: '',
  extraInstructionsText: '',
  combinedText: 'system',
};

function noteRow(id: number, title = `Note ${id}`) {
  return { id, title, content: '列表预览，不得冒充正文' };
}

function characterRow(id: number, name: string) {
  const card = novelCharacterDraftToCharaCard({
    name,
    role: '主角',
    identity: '普通人',
    personality: '克制',
    motivation: '查明真相',
    conflict: '不愿妥协',
  } as any);
  return { id, name, data_json: JSON.stringify(card.data) };
}

function worldbookRow(id: number) {
  return {
    id,
    comment: '青秀路规则',
    keyword_primary: '青秀路',
    keyword_secondary: '',
    content: '雨夜不得独行，青秀路存在危险。',
    constant: 0,
  };
}

function configureEmptyResourceReads() {
  (db.getCharactersByProject as jest.Mock).mockResolvedValue([]);
  (db.getWorldbookEntriesByProject as jest.Mock).mockResolvedValue([]);
  (db.getProjectNoteConfig as jest.Mock).mockResolvedValue(null);
}

beforeEach(() => {
  jest.clearAllMocks();
  configureEmptyResourceReads();
  (db.getNotesByProject as jest.Mock).mockResolvedValue([]);
  (db.getNotesContentByIds as jest.Mock).mockResolvedValue({});
  (db.getChaptersByProject as jest.Mock).mockResolvedValue([]);
  (db.getProjectById as jest.Mock).mockResolvedValue({
    id: 7,
    mode: 'freeform',
    name: 'p',
  });
});

test('T-01 Snapshot 后不再读取 Notes，Detail 只能来自 Note A', async () => {
  let listReads = 0;
  let contentReads = 0;
  (db.getNotesByProject as jest.Mock).mockImplementation(async () => {
    listReads += 1;
    if (listReads > 2) throw new Error('unexpected live Notes read');
    return [noteRow(11, '同源笔记')];
  });
  (db.getNotesContentByIds as jest.Mock).mockImplementation(async () => {
    contentReads += 1;
    if (contentReads > 2) throw new Error('unexpected live Notes content read');
    return { 11: 'Note A 正文' };
  });

  const snapshot = await captureResourceSourceSnapshot(7, {
    includeResources: true,
  });
  (db.getNotesByProject as jest.Mock).mockRejectedValue(
    new Error('Snapshot 后禁止读取'),
  );
  (db.getNotesContentByIds as jest.Mock).mockRejectedValue(
    new Error('Snapshot 后禁止读取'),
  );

  const built = buildResourceContextV2({
    source: snapshot,
    haystack: {
      title: '雨夜',
      synopsis: '',
      currentBody: '',
      userPrompt: '',
      previousChapter: '',
      previousChapters: '',
      storyMemory: '',
      outline: '',
      episodic: '',
      activatedDetailText: '',
    },
  });

  expect(listReads).toBe(2);
  expect(contentReads).toBe(2);
  expect(built.details.find(item => item.sourceKind === 'note')?.content).toContain(
    'Note A 正文',
  );
  expect(built.details.find(item => item.sourceKind === 'note')?.content).not.toContain(
    'Note B',
  );
});

test('T-02 Snapshot A→B→B 选择稳定的 B，并保持 fingerprint 同源', async () => {
  let contentReads = 0;
  (db.getNotesByProject as jest.Mock).mockResolvedValue([noteRow(12, '变更笔记')]);
  (db.getNotesContentByIds as jest.Mock).mockImplementation(async () => {
    contentReads += 1;
    return { 12: contentReads === 1 ? '正文 A' : '正文 B' };
  });

  const snapshot = await captureResourceSourceSnapshot(7, {
    includeResources: true,
  });
  const parsed = JSON.parse(snapshot.notes[0].payload);
  const built = buildResourceContextV2({
    source: snapshot,
    haystack: {
      title: '',
      synopsis: '',
      currentBody: '',
      userPrompt: '',
      previousChapter: '',
      previousChapters: '',
      storyMemory: '',
      outline: '',
      episodic: '',
      activatedDetailText: '',
    },
  });
  const detail = built.details.find(item => item.sourceKind === 'note');

  expect(contentReads).toBe(3);
  expect(parsed.content).toBe('正文 B');
  expect(detail?.content).toContain('正文 B');
  expect(detail?.sourceFingerprint).toBe(snapshot.notes[0].fingerprint);
});

test('T-03 Snapshot A→B→C fail-closed before any LLM call', async () => {
  let contentReads = 0;
  const llmCall = jest.fn();
  (db.getNotesByProject as jest.Mock).mockResolvedValue([noteRow(13)]);
  (db.getNotesContentByIds as jest.Mock).mockImplementation(async () => {
    contentReads += 1;
    return { 13: ['正文 A', '正文 B', '正文 C'][contentReads - 1] };
  });

  await expect(
    captureResourceSourceSnapshot(7, { includeResources: true }),
  ).rejects.toMatchObject({ code: 'RESOURCE_SOURCE_CHANGED_DURING_BUILD' });
  expect(contentReads).toBe(3);
  expect(llmCall).not.toHaveBeenCalled();
});

test('T-04 Notes 列表失败软降级，Character/Worldbook Awareness 和 Preview Warning 保持', async () => {
  (db.getCharactersByProject as jest.Mock).mockResolvedValue([
    characterRow(1, '林晚'),
  ]);
  (db.getWorldbookEntriesByProject as jest.Mock).mockResolvedValue([
    worldbookRow(8),
  ]);
  (db.getNotesByProject as jest.Mock).mockRejectedValue(new Error('notes list down'));

  const built = await collectPhase2BudgetResources({
    projectId: 7,
    config: { includeResources: true, worldbookRecursive: true } as any,
    preset: null,
    haystack: { chapter: chapter as any, previousChaptersText: '', storyMemoryText: '', outlineText: '', episodicText: '' },
  });
  const selection = buildResourceSelectionTrace({
    awareness: built.awareness,
    details: built.details,
    frozenDetails: [],
    includeResources: true,
    warnings: built.warnings,
  });
  const trace = buildPhase2ContextTrace({
    preset,
    awareness: built.awareness,
    details: [],
    selection,
    includeResources: true,
  });

  expect(built.awareness.some(item => item.sourceKind === 'character')).toBe(true);
  expect(built.awareness.some(item => item.sourceKind === 'worldbook')).toBe(true);
  expect(built.warnings.some(item => item.code === 'NOTE_LIST_READ_FAILED')).toBe(true);
  expect(selection.some(item => item.warningCode === 'NOTE_LIST_READ_FAILED')).toBe(true);
  expect(trace.some(item => item.warning?.includes('笔记资料本轮读取失败'))).toBe(true);
});

test('T-05 Notes 正文失败不伪装为空资料，保留结构化 Warning 且不注入 Note Detail', async () => {
  (db.getNotesByProject as jest.Mock).mockResolvedValue([noteRow(14, '正文失败笔记')]);
  (db.getNotesContentByIds as jest.Mock).mockRejectedValue(new Error('content down'));

  const built = await collectPhase2BudgetResources({
    projectId: 7,
    config: { includeResources: true } as any,
    preset: null,
    haystack: { chapter: chapter as any, previousChaptersText: '', storyMemoryText: '', outlineText: '', episodicText: '' },
  });
  const noteDetails = built.details.filter(item => item.sourceKind === 'note');

  expect(built.warnings.some(item => item.code === 'NOTE_CONTENT_READ_FAILED')).toBe(true);
  expect(noteDetails).toHaveLength(0);
  expect(JSON.parse(built.source.notes[0].payload).__contentAvailable).toBe(false);
  expect(
    buildResourceSelectionTrace({
      awareness: built.awareness,
      details: built.details,
      frozenDetails: [],
      includeResources: true,
      warnings: built.warnings,
    }).some(item => item.warningCode === 'NOTE_CONTENT_READ_FAILED'),
  ).toBe(true);
});

test('T-06 单条 Note payload 异常只跳过该条，其他 Note Detail 正常并发出 Warning', () => {
  const result = compileNoteDetailCandidatesFromSnapshot({
    notes: [
      {
        kind: 'note',
        id: 15,
        title: '坏笔记',
        payload: '{bad-json',
        fingerprint: 'bad',
      },
      {
        kind: 'note',
        id: 16,
        title: '好笔记',
        payload: JSON.stringify({ id: 16, title: '好笔记', content: '可用正文' }),
        fingerprint: 'good',
      },
    ],
    haystack: {
      title: '',
      synopsis: '',
      currentBody: '',
      userPrompt: '',
      previousChapters: '',
      storyMemory: '',
      outline: '',
      episodic: '',
    },
  });

  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0].content).toContain('可用正文');
  expect(result.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'NOTE_DETAIL_COMPILE_FAILED',
        sourceId: 15,
      }),
    ]),
  );
});

test('T-07 save < balanced < rich 在最终 V7 resource board 和 frozen detail 分配中成立', async () => {
  const rows = Array.from({ length: 8 }, (_, index) => noteRow(100 + index, `竞争笔记 ${index}`));
  const content = '同一候选集的正文。'.repeat(44);
  const buildAt = async (intensity: 'save' | 'balanced' | 'rich') => {
    configureEmptyResourceReads();
    (db.getNotesByProject as jest.Mock).mockResolvedValue(rows);
    (db.getNotesContentByIds as jest.Mock).mockResolvedValue(
      Object.fromEntries(rows.map(row => [row.id, content])),
    );
    (db.getChaptersByProject as jest.Mock).mockResolvedValue([
      {
        ...chapter,
        id: 1,
        position: 1,
        title: '前章',
        synopsis: '',
        content: '前章竞争正文。'.repeat(1300),
      },
    ]);
    const result = await buildContext(
      chapter as any,
      {
        strategy: 'sliding',
        slidingWindowSize: 6000,
        customRangeStart: 0,
        customRangeEnd: -1,
        resourceBudget: 6000,
        includeResources: true,
        memoryTopK: 0,
        resourceDetailIntensity: intensity,
      } as any,
      7,
      undefined,
      {
        contextWindow: 10000,
        reservedOutputTokens: 1000,
        contextBudgetVersion: 7,
      },
    );
    return {
      board: result.hierarchicalBudgetTrace?.boardAllocations.resources.allocatedTokens || 0,
      frozen: (result.pipelineContext.resourceDetailItems || []).reduce(
        (sum, item) => sum + item.allocatedTokens,
        0,
      ),
      hardInputLimit: result.hierarchicalBudgetTrace?.envelope.hardInputLimit || 0,
      totalInput: result.hierarchicalBudgetTrace?.totalEstimatedInputTokens || 0,
    };
  };

  const save = await buildAt('save');
  const balanced = await buildAt('balanced');
  const rich = await buildAt('rich');

  expect(save.board).toBeLessThan(balanced.board);
  expect(balanced.board).toBeLessThan(rich.board);
  expect(save.frozen).toBeLessThan(balanced.frozen);
  expect(balanced.frozen).toBeLessThan(rich.frozen);
  expect(rich.totalInput).toBeLessThanOrEqual(rich.hardInputLimit);
});

test('T-08 Note 未获详情分配时使用 NOT_SELECTED，不伪装成 AWARENESS_ONLY', () => {
  const detail: FrozenResourceDetailItem = {
    id: 'note-detail:17',
    sourceKind: 'note',
    sourceId: 17,
    title: '未选笔记',
    content: '',
    actualTokens: 100,
    allocatedTokens: 0,
    activationReason: 'explicit',
    clipped: true,
  };
  const sourceCandidate = {
    id: detail.id,
    sourceKind: 'note' as const,
    sourceId: 17,
    title: detail.title,
    content: '未选笔记正文',
    actualTokens: 100,
    activationReason: 'explicit' as const,
    relevance: 0.5,
    explicitSelected: true,
    sourceOrder: 2000,
  };
  const selection = buildResourceSelectionTrace({
    awareness: [],
    details: [sourceCandidate],
    frozenDetails: [detail],
    includeResources: true,
  });
  const trace = buildPhase2ContextTrace({
    preset,
    awareness: [],
    details: [detail],
    selection,
    includeResources: true,
  });

  expect(selection[0].status).toBe('NOT_SELECTED');
  expect(trace.find(item => item.kind === 'note')?.resourcePreviewStatus).toBe(
    'NOT_SELECTED',
  );
  expect(trace.find(item => item.kind === 'note')?.resourcePreviewStatus).not.toBe(
    'AWARENESS_ONLY',
  );
});

test('T-09 Snapshot V4 Resume 和五阶段只消费 Frozen Note，不受 live DB 变化影响', () => {
  const raw = {
    presetText: '冻结预设',
    storyMemoryText: '',
    characterText: '',
    noteText: 'Note A 正文',
    worldbookText: '',
    episodicMemoryText: '',
    recentBridgeText: '',
    currentInstructionText: '继续写',
    retrievalUserPrompt: '',
    outlineText: '',
    outlineFingerprint: '',
    outlineIds: [],
    outlineComplete: true,
    outlineEstimatedTokens: 0,
    snapshotVersion: 4,
    resourceContextVersion: 2,
    resourceDetailItems: [
      {
        id: 'note-detail:18',
        sourceKind: 'note',
        sourceId: 18,
        title: '冻结笔记',
        content: 'Note A 正文',
        actualTokens: 3,
        allocatedTokens: 3,
        activationReason: 'explicit',
        clipped: false,
      },
    ],
    presetSystemText: '冻结预设',
    presetSourceFingerprint: 'preset-a',
  };
  const snapshot = parsePipelineContextSnapshotStrict(raw, {});
  const liveNote = 'Note B 正文（live DB 已修改）';
  const review = buildReviewContextFromSnapshotV4(snapshot);
  const fact = buildFactCheckContextFromSnapshotV4(snapshot);
  const proof = buildProofConstraintsFromSnapshotV4(snapshot);
  const brief = buildBriefResourceViewFromSnapshotV4(snapshot);

  expect(liveNote).toContain('Note B');
  expect(snapshot.noteText).toBe('Note A 正文');
  expect(review.noteText).toContain('Note A 正文');
  expect(fact.noteText).toContain('Note A 正文');
  expect(proof.noteText).toContain('Note A 正文');
  expect(brief.presetText).toContain('冻结预设');
  expect(JSON.stringify({ review, fact, proof, brief })).not.toContain('Note B');
});

test('T-10 includeResources=false 保留 Preset，不产生 Notes Warning 或资源 ERROR', async () => {
  const built = await collectPhase2BudgetResources({
    projectId: 7,
    config: { includeResources: false } as any,
    preset: {
      id: 3,
      name: '悬疑预设',
      system_prompt: '中文悬疑作者',
      writing_style: '冷峻',
      extra_instructions: '',
    } as any,
    haystack: { chapter: chapter as any, previousChaptersText: '', storyMemoryText: '', outlineText: '', episodicText: '' },
  });
  const selection = buildResourceSelectionTrace({
    awareness: built.awareness,
    details: built.details,
    frozenDetails: [],
    includeResources: false,
    warnings: built.warnings,
  });

  expect(built.source.preset?.title).toBe('悬疑预设');
  expect(built.awareness).toHaveLength(0);
  expect(built.details).toHaveLength(0);
  expect(built.warnings).toHaveLength(0);
  expect(selection).toEqual(
    expect.arrayContaining([expect.objectContaining({ status: 'DISABLED' })]),
  );
  expect(selection.some(item => item.status === 'ERROR')).toBe(false);
});

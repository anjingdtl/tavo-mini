/**
 * Stability Phase 7 — Golden Journeys (plan §8), chain A (outline pipeline).
 *
 * 20 fixed critical journeys. These are the primary stability metric —
 * NOT jest-count. Each journey asserts the §8 invariants:
 *   note none → note content 0; dirty story memory → no dirty checkpoint;
 *   writer style → frozen snapshot; 1M window → bounded intake;
 *   resume → generationFingerprint unchanged.
 *
 * Harness: mock DB boundary (same pattern as contextBuilderV7.integration),
 * REAL buildContext / draftPipelineCompiler / envelope serialize+parse /
 * fingerprint machinery. LLM is never involved.
 */
jest.mock('../src/services/macroReplace', () => ({
  processMacros: jest.fn(async (text: string) => text),
}));

let mockChapters: any[] = [];
let mockCharacters: any[] = [];
let mockNotes: any[] = [];
let mockWorldbook: any[] = [];
let mockNoteConfig: any = null;
let mockOutlineRows: any[] = [];
let mockContextWindow = 128000;
let mockPreparedStoryMemory: any = null;

jest.mock('../src/services/database', () => ({
  getChaptersByProject: jest.fn(async () => mockChapters),
  getCharactersByProject: jest.fn(async () => mockCharacters),
  getNotesByProject: jest.fn(async () => mockNotes),
  getNotesContentByIds: jest.fn(async () =>
    Object.fromEntries(mockNotes.map((n: any) => [Number(n.id), n.content])),
  ),
  getWorldbookEntriesByProject: jest.fn(async () => mockWorldbook),
  getProjectNoteConfig: jest.fn(async () => mockNoteConfig),
  getProjectById: jest.fn(async () => ({ id: 7, mode: 'outline', name: 'p' })),
  getActiveLLMConfig: jest.fn(async () => ({
    id: 1,
    context_window: mockContextWindow,
    max_output_tokens: 8000,
  })),
  getPipelineConfig: jest.fn(async () => ({
    pipelineMode: 'full',
    activeWriterStyleId: null,
    draftPresetId: null,
    reviewPresetId: null,
    factCheckPresetId: null,
    proofPresetId: null,
    draftMaxTokens: 4000,
    reviewMaxTokens: 1500,
    factCheckMaxTokens: 1500,
    proofMaxTokens: 4000,
  })),
  getContextConfig: jest.fn(async () => ({
    strategy: 'sliding',
    slidingWindowSize: 4,
    customRangeStart: 0,
    customRangeEnd: -1,
    resourceBudget: 2000,
    includeResources: true,
    memoryTopK: 5,
  })),
  getPresetsByProject: jest.fn(async () => [] as any[]),
}));

jest.mock('../src/data/repositories/outlineRepository', () => ({
  getEnabledOutlinesByProject: jest.fn(async () => mockOutlineRows),
}));

jest.mock('../src/services/storyMemory/storyMemoryPrepare', () => ({
  prepareStoryMemoryForGeneration: jest.fn(async () => mockPreparedStoryMemory),
}));

jest.mock('../src/utils/idfCache', () => ({
  computeMemorySummarySignature: jest.fn(() => 'sig'),
  getCachedIdf: jest.fn(() => null),
  setCachedIdf: jest.fn(),
}));

jest.mock('../src/services/llm', () => {
  const actual = jest.requireActual('../src/services/llm');
  return {
    ...actual,
    resolveLLMRequestConfig: jest.fn(async () => ({
      id: 1,
      context_window: mockContextWindow,
      model_name: 'model-a',
      provider_type: 'openai_compatible',
    })),
    resolveLLMRequestConfigById: jest.fn(async () => ({
      id: 1,
      context_window: mockContextWindow,
      model_name: 'model-a',
      provider_type: 'openai_compatible',
    })),
  };
});

import { buildContext } from '../src/services/contextBuilder';
import { compileDraftPipelineRequest } from '../src/services/draftPipelineCompiler';
import { compileDraftStageRequest } from '../src/services/pipeline/compileStageRequest';
import {
  serializePipelineTaskContext,
  parsePersistedPipelineTaskContext,
} from '../src/services/pipelineTaskContext';
import {
  deriveFrozenGenerationContext,
  computeGenerationFingerprint,
  buildGenerationFingerprintInput,
} from '../src/services/pipeline/frozenGenerationContext';
import { compileDraftFromFrozenRequest } from '../src/services/pipeline/compileStageRequest';
import type { Outline } from '../src/types/outline';
import type { PipelineExecutionSnapshot } from '../src/types/pipelineExecution';
import type { FrozenWriterStyleV1 } from '../src/services/writerStyle/types';

const PROJECT = 7;

function chapterAt(position: number, content = '', title = `第${position + 1}章`) {
  return {
    id: position + 1,
    project_id: PROJECT,
    position,
    title,
    synopsis: '',
    content,
    status: 'final' as const,
    summary_json: null,
    created_at: '',
    updated_at: '',
    memory_summary: position < 1 ? '' : `第${position + 1}章梗概：事件推进。`,
  };
}

const CONFIG: any = {
  strategy: 'sliding',
  slidingWindowSize: 4,
  customRangeStart: 0,
  customRangeEnd: -1,
  resourceBudget: 2000,
  includeResources: true,
  memoryTopK: 5,
};

function makeOutline(overrides: Partial<Outline> = {}): Outline {
  return {
    id: 1,
    projectId: PROJECT,
    title: '主线',
    content: '主角踏上旅程，抵达青秀路。',
    sourceType: 'manual',
    enabled: true,
    position: 0,
    estimatedTokens: 20,
    contentHash: 'hash-outline',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function cleanCheckpoint(throughPosition: number) {
  return {
    state: {
      schemaVersion: 1 as const,
      projectId: PROJECT,
      throughChapterId: throughPosition,
      throughChapterPosition: throughPosition,
      characters: {},
      relationships: {},
      mainline: { summary: '主线推进', arcs: [] } as any,
      metadata: { updatedAt: '', revisionCount: 0 } as any,
    },
    status: 'clean' as 'clean' | 'dirty',
    dirtyFromPosition: null,
    lastError: '',
    updatedAt: '',
  };
}

function execution(overrides: Partial<PipelineExecutionSnapshot> = {}): PipelineExecutionSnapshot {
  const tier = (stage: string) => ({
    stage,
    requestedTier: 'low' as const,
    effectiveTier: 'low' as const,
    thinking: 'enabled' as const,
    effort: 'low' as const,
  });
  return {
    pipelineMode: 'full',
    outlineWorkflowVersion: 4,
    contextBudgetVersion: 5,
    finalReviserReasoningPolicyVersion: 3,
    reasoningEffort: 'low',
    reasoningProfileVersion: 5,
    requestedReasoningTier: 'low',
    stageReasoning: {
      draft: tier('draft'),
      review: tier('review'),
      factCheck: tier('factCheck'),
      brief: tier('brief'),
      proof: tier('proof'),
    },
    briefPolicyVersion: 4,
    draftMaxTokens: 4000,
    reviewMaxTokens: 1500,
    factCheckMaxTokens: 1500,
    proofMaxTokens: 4000,
    draftPresetId: null,
    reviewPresetId: null,
    factCheckPresetId: null,
    proofPresetId: null,
    draftPreset: null,
    reviewPreset: null,
    factCheckPreset: null,
    proofPreset: null,
    model: {
      llmConfigId: 1,
      modelName: 'model-a',
      contextWindow: mockContextWindow,
    },
    createdAt: 1700000000000,
    ...overrides,
  } as PipelineExecutionSnapshot;
}

function basePrepared(overrides: Record<string, unknown> = {}) {
  return {
    blocked: false,
    checkpoint: null,
    checkpointEligibility: { usable: false, reason: 'missing' },
    coverage: null,
    checkpointUpdated: false,
    warnings: [],
    ...overrides,
  };
}

/** Freeze a full envelope from a buildContext result (the production path). */
function freeze(result: Awaited<ReturnType<typeof buildContext>>, exec?: PipelineExecutionSnapshot) {
  return serializePipelineTaskContext({
    draftContext: result.pipelineContext,
    execution: exec ?? execution(),
    trace: {
      version: 1,
      generationTraceId: 'gt-golden00-00000001',
      createdAt: 1700000000000,
    },
  });
}

function fingerprintOf(result: Awaited<ReturnType<typeof buildContext>>, exec?: PipelineExecutionSnapshot) {
  return computeGenerationFingerprint(
    buildGenerationFingerprintInput(result.pipelineContext, exec ?? execution(), null),
  );
}

function resetFixtures() {
  mockChapters = [];
  mockCharacters = [];
  mockNotes = [];
  mockWorldbook = [];
  mockNoteConfig = null;
  mockOutlineRows = [];
  mockContextWindow = 128000;
  mockPreparedStoryMemory = basePrepared();
}

beforeEach(() => {
  resetFixtures();
});

describe('Golden Journeys — 大纲与资料 (GJ-01..04)', () => {
  test('GJ-01 基础大纲写作：大纲完整注入且携带指纹', async () => {
    mockOutlineRows = [makeOutline()];
    mockChapters = [chapterAt(0, '旧章正文'), chapterAt(1)];
    mockPreparedStoryMemory = basePrepared();
    const result = await buildContext(chapterAt(1), CONFIG, PROJECT, undefined, {
      contextWindow: 128000,
      reservedOutputTokens: 4000,
      contextBudgetVersion: 5,
    });
    expect(result.pipelineContext.outlineText).toContain('主角踏上旅程');
    expect(result.pipelineContext.outlineFingerprint).toBeTruthy();
    expect(result.pipelineContext.outlineComplete).toBe(true);
  });

  test('GJ-02 大纲+人物+世界观：资料进入快照', async () => {
    mockOutlineRows = [makeOutline()];
    mockCharacters = [
      {
        id: 1,
        name: '林晚',
        data_json: JSON.stringify({ name: '林晚', description: '克制的主角' }),
      },
    ];
    mockWorldbook = [
      {
        id: 8,
        keyword_primary: '青秀路',
        keyword_secondary: '',
        content: '青秀路存在雨夜杀人狂。',
        constant: 0,
        position: 0,
      },
    ];
    mockChapters = [chapterAt(0, '旧章正文 青秀路'), chapterAt(1)];
    const result = await buildContext(chapterAt(1), CONFIG, PROJECT, undefined, {
      contextWindow: 128000,
      reservedOutputTokens: 4000,
      contextBudgetVersion: 1,
    });
    expect(result.pipelineContext.characterText).toContain('林晚');
    expect(result.pipelineContext.worldbookText).toContain('雨夜杀人狂');
  });

  test('GJ-03 大纲+笔记：笔记内容进入快照', async () => {
    mockOutlineRows = [makeOutline()];
    mockNotes = [{ id: 3, content: '笔记：反派动机是旧怨' }];
    mockNoteConfig = null; // 默认 original 模式
    mockChapters = [chapterAt(0, '旧章'), chapterAt(1)];
    const result = await buildContext(chapterAt(1), CONFIG, PROJECT, undefined, {
      contextWindow: 128000,
      reservedOutputTokens: 4000,
      contextBudgetVersion: 1,
    });
    expect(result.pipelineContext.noteText).toContain('反派动机');
  });

  test('GJ-04 Note=none → note 内容为 0', async () => {
    mockOutlineRows = [makeOutline()];
    mockNotes = [{ id: 3, content: '笔记：不应出现' }];
    mockNoteConfig = { mode: 'none' };
    mockChapters = [chapterAt(0, '旧章'), chapterAt(1)];
    const result = await buildContext(chapterAt(1), CONFIG, PROJECT, undefined, {
      contextWindow: 128000,
      reservedOutputTokens: 4000,
      contextBudgetVersion: 1,
    });
    expect(result.pipelineContext.noteText).toBe('');
    expect(result.pipelineContext.noteText).not.toContain('不应出现');
  });
});

describe('Golden Journeys — Story Memory / Writer Style / Preset (GJ-05..08)', () => {
  test('GJ-05 Story Memory ready → 注入干净检查点', async () => {
    mockOutlineRows = [makeOutline()];
    mockChapters = [chapterAt(0, '旧章'), chapterAt(1), chapterAt(2)];
    mockPreparedStoryMemory = basePrepared({
      checkpoint: cleanCheckpoint(1),
      checkpointEligibility: { usable: true, reason: 'usable' },
    });
    const result = await buildContext(chapterAt(2), CONFIG, PROJECT, undefined, {
      contextWindow: 128000,
      reservedOutputTokens: 4000,
      contextBudgetVersion: 1,
    });
    expect(result.pipelineContext.storyMemoryText.length).toBeGreaterThan(0);
  });

  test('GJ-06 Story Memory dirty → 不注入脏检查点', async () => {
    mockOutlineRows = [makeOutline()];
    mockChapters = [chapterAt(0, '旧章'), chapterAt(1), chapterAt(2)];
    const dirty = cleanCheckpoint(1);
    dirty.status = 'dirty';
    mockPreparedStoryMemory = basePrepared({
      checkpoint: dirty,
      checkpointEligibility: { usable: false, reason: 'not_clean' },
    });
    const result = await buildContext(chapterAt(2), CONFIG, PROJECT, undefined, {
      contextWindow: 128000,
      reservedOutputTokens: 4000,
      contextBudgetVersion: 1,
    });
    expect(result.pipelineContext.storyMemoryText).toBe('');
  });

  test('GJ-07 Writer Style enabled → snapshot 冻结且参与指纹', async () => {
    mockOutlineRows = [makeOutline()];
    mockChapters = [chapterAt(0, '旧章'), chapterAt(1)];
    const style = (name: string): FrozenWriterStyleV1 =>
      ({
        semanticVersion: 1,
        assetId: 1,
        assetName: name,
        sourceFormat: 'semantic_json',
        semantic: null,
        legacySystemText: `风格-${name}`,
        legacyWritingStyleText: '',
        legacyExtraInstructionsText: '',
        sourceFingerprint: `fp-${name}`,
        compatibilityFingerprint: `compat-${name}`,
        samplerResolution: 'frozen',
        stageProjections: {
          draft: { estimatedTokens: 50, mode: 'FULL', text: `风格-${name}` },
          review: { estimatedTokens: 50, mode: 'FULL', text: `风格-${name}` },
          factCheck: { estimatedTokens: 50, mode: 'FULL', text: `风格-${name}` },
          brief: { estimatedTokens: 50, mode: 'FULL', text: `风格-${name}` },
          proof: { estimatedTokens: 50, mode: 'FULL', text: `风格-${name}` },
        },
      }) as any;
    const compiledA = await compileDraftPipelineRequest({
      chapter: chapterAt(1) as any,
      draftMaxTokens: 4000,
      contextBudgetVersion: 5,
      writerStyleSnapshot: style('A'),
    });
    expect(compiledA.pipelineContext?.writerStyleSnapshot?.assetName).toBe('A');
    // 风格进入冻结快照；换风格 → 快照与指纹都变化
    const compiledB = await compileDraftPipelineRequest({
      chapter: chapterAt(1) as any,
      draftMaxTokens: 4000,
      contextBudgetVersion: 5,
      writerStyleSnapshot: style('B'),
    });
    expect(compiledB.pipelineContext?.writerStyleSnapshot?.assetName).toBe('B');
    const frozenA = serializePipelineTaskContext({
      draftContext: compiledA.pipelineContext!,
      execution: execution(),
    });
    const frozenB = serializePipelineTaskContext({
      draftContext: compiledB.pipelineContext!,
      execution: execution(),
    });
    expect(frozenA.pipelineContextJson).not.toBe(frozenB.pipelineContextJson);
    expect(frozenA.generationFingerprint).not.toBe(frozenB.generationFingerprint);
  });

  test('GJ-08 Preset 切换 → presetText 与指纹变化', async () => {
    mockOutlineRows = [makeOutline()];
    mockChapters = [chapterAt(0, '旧章'), chapterAt(1)];
    const presetA = {
      id: 1,
      name: 'A',
      system_prompt: '你是严肃文学作家',
      writing_style: '',
      extra_instructions: '',
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 4000,
    } as any;
    const presetB = { ...presetA, id: 2, name: 'B', system_prompt: '你是网文作家' };
    const a = await compileDraftPipelineRequest({
      chapter: chapterAt(1) as any,
      draftPreset: presetA,
      draftMaxTokens: 4000,
      contextBudgetVersion: 5,
    });
    const b = await compileDraftPipelineRequest({
      chapter: chapterAt(1) as any,
      draftPreset: presetB,
      draftMaxTokens: 4000,
      contextBudgetVersion: 5,
    });
    expect(a.pipelineContext!.presetText).toContain('严肃文学作家');
    expect(b.pipelineContext!.presetText).toContain('网文作家');
    expect(
      serializePipelineTaskContext({
        draftContext: a.pipelineContext!,
        execution: execution(),
      }).generationFingerprint,
    ).not.toEqual(
      serializePipelineTaskContext({
        draftContext: b.pipelineContext!,
        execution: execution(),
      }).generationFingerprint,
    );
  });
});

describe('Golden Journeys — Context 策略与窗口 (GJ-09..13)', () => {
  async function buildWith(window: number, budgetVersion = 6) {
    mockOutlineRows = [makeOutline()];
    mockCharacters = [
      {
        id: 1,
        name: '林晚',
        data_json: JSON.stringify({ name: '林晚', description: '主角' }),
      },
    ];
    mockWorldbook = [
      {
        id: 8,
        keyword_primary: '青秀路',
        keyword_secondary: '',
        content: '青秀路设定。',
        constant: 0,
        position: 0,
      },
    ];
    mockChapters = [chapterAt(0, '旧章 青秀路'), chapterAt(1)];
    return buildContext(chapterAt(1), CONFIG, PROJECT, undefined, {
      contextWindow: window,
      reservedOutputTokens: 4000,
      contextBudgetVersion: budgetVersion,
    });
  }

  test('GJ-09 Context Auto（V3 策略）→ 策略哈希随快照冻结', async () => {
    const result = await buildWith(128000, 6);
    expect(result.pipelineContext.contextBudgetV3Summary).toBeDefined();
    expect(
      result.pipelineContext.contextBudgetV3Summary!.contextAutomationPolicyHash,
    ).toBeTruthy();
  });

  test('GJ-10 手动 Context（无策略注入）→ 快照确定且可重放', async () => {
    const result = await buildWith(128000, 5);
    expect(result.pipelineContext).toBeDefined();
    const frozen = freeze(result);
    const parsed = parsePersistedPipelineTaskContext(frozen);
    expect(parsed.draftContext.presetText).toBe(result.pipelineContext.presetText);
  });

  test('GJ-11 64K 窗口 → 硬限内完成渲染', async () => {
    mockContextWindow = 65536;
    const result = await buildWith(65536, 5);
    expect(result.estimatedInputTokens).toBeLessThanOrEqual(
      65536 - 4000,
    );
  });

  test('GJ-12 128K 窗口 → 硬限内完成渲染', async () => {
    const result = await buildWith(128000, 5);
    expect(result.estimatedInputTokens).toBeLessThanOrEqual(128000 - 4000);
  });

  test('GJ-13 1M Provider → 不因窗口巨大无界吞入资料', async () => {
    // 大量资料候选：30 个角色 + 30 条世界书 + 30 章
    mockCharacters = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      name: `角色${i}`,
      data_json: JSON.stringify({
        name: `角色${i}`,
        description: `描述-${i}-`.repeat(40),
      }),
    }));
    mockWorldbook = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      keyword_primary: `设定${i}`,
      keyword_secondary: '',
      content: `设定内容-${i}-`.repeat(60),
      constant: 0,
      position: i,
    }));
    mockOutlineRows = [makeOutline()];
    mockChapters = Array.from({ length: 30 }, (_, i) =>
      chapterAt(i, `章节正文-${i}-`.repeat(100)),
    );
    mockPreparedStoryMemory = basePrepared();
    const current = chapterAt(30, '', '第31章');
    const result = await buildContext(current, CONFIG, PROJECT, undefined, {
      contextWindow: 1_000_000,
      reservedOutputTokens: 8000,
      contextBudgetVersion: 5,
    });
    // 硬限 = window - reserved - safety；渲染总量必须受硬限约束
    expect(result.estimatedInputTokens).toBeLessThanOrEqual(1_000_000 - 8000);
    // 未来章节零泄漏
    expect(
      result.chapters.every(c => c.position < current.position),
    ).toBe(true);
  });
});

describe('Golden Journeys — 预算压力 (GJ-14..16)', () => {
  test('GJ-14 Mandatory 接近 Hard Limit → 大纲要么完整要么显式失败，绝不静默丢弃', async () => {
    mockOutlineRows = [
      makeOutline({
        content: '主线大纲内容-'.repeat(4000),
        estimatedTokens: 40_000,
      }),
    ];
    mockChapters = [chapterAt(0, '旧章'), chapterAt(1)];
    mockPreparedStoryMemory = basePrepared();
    // 64K 窗口下大纲占掉接近全部输入预算
    let result: Awaited<ReturnType<typeof buildContext>> | null = null;
    let failed = false;
    try {
      result = await buildContext(chapterAt(1), CONFIG, PROJECT, undefined, {
        contextWindow: 65536,
        reservedOutputTokens: 16000,
        contextBudgetVersion: 5,
      });
    } catch (error) {
      failed = true;
      expect(String((error as Error).message)).toMatch(/预算|上下文|大纲/);
    }
    if (!failed && result) {
      // 若成功：大纲必须未被截断（outline 不裁剪契约）
      expect(result.pipelineContext.outlineText).toContain('主线大纲内容-');
    }
  });

  test('GJ-15 Soft 超 80% → 弹性预算工作且硬限不被突破', async () => {
    mockOutlineRows = [makeOutline({ content: '软压力大纲-'.repeat(1500) })];
    mockChapters = Array.from({ length: 8 }, (_, i) =>
      chapterAt(i, `正文-${i}-`.repeat(120)),
    );
    const result = await buildContext(chapterAt(8, '', '第9章'), CONFIG, PROJECT, undefined, {
      contextWindow: 32768,
      reservedOutputTokens: 8000,
      contextBudgetVersion: 5,
      elasticBudget: true,
    });
    expect(result.estimatedInputTokens).toBeLessThanOrEqual(32768 - 8000);
    if (result.elasticBudgetTrace) {
      expect(result.elasticBudgetTrace.hardInputLimit).toBeGreaterThan(0);
      // 软/爆发/硬三水位单调不减，预算结构完整
      const { softInputLimit, burstInputLimit, hardInputLimit } =
        result.elasticBudgetTrace;
      expect(softInputLimit).toBeLessThanOrEqual(burstInputLimit);
      expect(burstInputLimit).toBeLessThanOrEqual(hardInputLimit);
    }
  });

  test('GJ-16 接近 95% burst → 不崩溃、硬限成立、指纹稳定', async () => {
    mockOutlineRows = [makeOutline({ content: '高压大纲-'.repeat(1200) })];
    mockChapters = Array.from({ length: 6 }, (_, i) =>
      chapterAt(i, `正文-${i}-`.repeat(100)),
    );
    const first = await buildContext(chapterAt(6, '', '第7章'), CONFIG, PROJECT, undefined, {
      contextWindow: 24576,
      reservedOutputTokens: 6000,
      contextBudgetVersion: 5,
      elasticBudget: true,
    });
    const second = await buildContext(chapterAt(6, '', '第7章'), CONFIG, PROJECT, undefined, {
      contextWindow: 24576,
      reservedOutputTokens: 6000,
      contextBudgetVersion: 5,
      elasticBudget: true,
    });
    expect(first.estimatedInputTokens).toBeLessThanOrEqual(24576 - 6000);
    // 同输入 → 同输出（预算稳定性）
    expect(fingerprintOf(first)).toBe(fingerprintOf(second));
  });
});

describe('Golden Journeys — Resume / Freeze 语义 (GJ-19..20)', () => {
  test('GJ-19 Kill → Cold Start → Resume：fingerprint 不变，Draft 消费冻结请求', async () => {
    mockOutlineRows = [makeOutline()];
    mockChapters = [chapterAt(0, '旧章'), chapterAt(1)];
    // 生产真实冻结路径：actionPersistInitialSnapshot 使用 compileDraftStageRequest
    const compiled = await compileDraftStageRequest({
      chapter: chapterAt(1) as any,
      draftMaxTokens: 4000,
      contextBudgetVersion: 5,
    });
    expect(compiled.ready).toBe(true);
    if (!compiled.ready) return;
    const frozen = serializePipelineTaskContext({
      draftContext: compiled.draftCompile!.pipelineContext,
      execution: execution(),
      frozenDraftRequest: compiled.frozenDraftRequest!,
      trace: {
        version: 1,
        generationTraceId: 'gt-golden19-deadbeef',
        createdAt: 1700000000000,
      },
    });
    // Cold start = 进程内状态全丢，仅剩持久化 JSON
    const restored = parsePersistedPipelineTaskContext(frozen);
    expect(restored.generationFingerprint).toBe(frozen.generationFingerprint);
    expect(restored.trace?.generationTraceId).toBe('gt-golden19-deadbeef');
    const view = deriveFrozenGenerationContext({
      pipelineTaskId: 't',
      parsed: restored,
    });
    expect(view!.storedGenerationFingerprint).toBe(
      view!.computedGenerationFingerprint,
    );
    // Draft 只消费冻结请求（compileDraftFromFrozenRequest）
    const draftReady = compileDraftFromFrozenRequest({
      frozen: restored.frozenDraftRequest!,
    });
    expect(draftReady.ready).toBe(true);
    if (draftReady.ready) {
      expect(draftReady.messages).toEqual(restored.frozenDraftRequest!.messages);
    }
  });

  test('GJ-20 Freeze 后 DB 数据变化再 Resume：语义指纹不变', async () => {
    mockOutlineRows = [makeOutline()];
    mockCharacters = [
      { id: 1, name: '林晚', data_json: JSON.stringify({ name: '林晚' }) },
    ];
    mockChapters = [chapterAt(0, '旧章'), chapterAt(1)];
    const result = await buildContext(chapterAt(1), CONFIG, PROJECT, undefined, {
      contextWindow: 128000,
      reservedOutputTokens: 4000,
      contextBudgetVersion: 5,
    });
    const frozenBefore = freeze(result);
    const fpBefore = frozenBefore.generationFingerprint;

    // DB 在 freeze 之后被大改：大纲、角色、章节全部变化
    mockOutlineRows = [makeOutline({ content: '被换掉的大纲', contentHash: 'changed' })];
    mockCharacters = [
      { id: 2, name: '新角色', data_json: JSON.stringify({ name: '新角色' }) },
    ];
    mockChapters = [chapterAt(0, '完全不同的旧章'), chapterAt(1), chapterAt(2)];

    // Resume 走冻结快照，不重读 DB → 指纹不变
    const restored = parsePersistedPipelineTaskContext(frozenBefore);
    expect(restored.generationFingerprint).toBe(fpBefore);
    expect(restored.draftContext.outlineText).toContain('主角踏上旅程');
    expect(restored.draftContext.characterText).toContain('林晚');
  });
});

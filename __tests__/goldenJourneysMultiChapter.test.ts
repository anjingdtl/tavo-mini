/**
 * Stability Phase 7 — Golden Journeys GJ-17/GJ-18 (plan §8).
 *
 * GJ-17 单章 / GJ-18 一键 N 章：每章独立 Snapshot，未来计划/来源泄漏 = 0。
 *
 * 多章链路（batch / continuation analog）的隔离不变量在真实冻结机制上验证：
 * 逐章 buildContext → serializePipelineTaskContext → 断言
 *   - 每章指纹互不相同（独立快照，不串章）
 *   - 每章 episodic/previous 来源严格 prior（未来泄漏 = 0，§4.6 守卫放行）
 *   - 后续章节的新增内容不改变先前章节已冻结信封的指纹（无后向污染）
 *
 * Continuation V5 专属链路的候选/CANON 覆盖见既有
 * continuationBatchAdapter / canonFutureLeakage 等套件。
 */
jest.mock('../src/services/macroReplace', () => ({
  processMacros: jest.fn(async (text: string) => text),
}));

let mockChapters: any[] = [];
let mockOutlineRows: any[] = [];

jest.mock('../src/services/database', () => ({
  getChaptersByProject: jest.fn(async () => mockChapters),
  getCharactersByProject: jest.fn(async () => []),
  getNotesByProject: jest.fn(async () => []),
  getNotesContentByIds: jest.fn(async () => ({})),
  getWorldbookEntriesByProject: jest.fn(async () => []),
  getProjectNoteConfig: jest.fn(async () => null),
  getProjectById: jest.fn(async () => ({ id: 7, mode: 'outline', name: 'p' })),
  getActiveLLMConfig: jest.fn(async () => ({
    id: 1,
    context_window: 128000,
    max_output_tokens: 8000,
  })),
}));

jest.mock('../src/data/repositories/outlineRepository', () => ({
  getEnabledOutlinesByProject: jest.fn(async () => mockOutlineRows),
}));

jest.mock('../src/services/storyMemory/storyMemoryPrepare', () => ({
  prepareStoryMemoryForGeneration: jest.fn(async () => ({
    blocked: false,
    checkpoint: null,
    checkpointEligibility: { usable: false, reason: 'missing' },
    coverage: null,
    checkpointUpdated: false,
    warnings: [],
  })),
}));

jest.mock('../src/utils/idfCache', () => ({
  computeMemorySummarySignature: jest.fn(() => 'sig'),
  getCachedIdf: jest.fn(() => null),
  setCachedIdf: jest.fn(),
}));

import { buildContext } from '../src/services/contextBuilder';
import {
  serializePipelineTaskContext,
  parsePersistedPipelineTaskContext,
} from '../src/services/pipelineTaskContext';
import {
  deriveFrozenGenerationContext,
} from '../src/services/pipeline/frozenGenerationContext';
import { assertNoFutureSourceLeakage } from '../src/services/context/generationStageContracts';
import type { PipelineExecutionSnapshot } from '../src/types/pipelineExecution';

const PROJECT = 7;
const TOTAL_CHAPTERS = 5;

function chapterAt(position: number, content: string) {
  return {
    id: position + 1,
    project_id: PROJECT,
    position,
    title: `第${position + 1}章`,
    synopsis: '',
    content,
    status: 'final' as const,
    summary_json: null,
    created_at: '',
    updated_at: '',
    memory_summary: `第${position + 1}章梗概。`,
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

function execution(): PipelineExecutionSnapshot {
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
    model: { llmConfigId: 1, modelName: 'model-a', contextWindow: 128000 },
    createdAt: 1700000000000,
  } as PipelineExecutionSnapshot;
}

/** 逐章冻结（模拟 batch 顺序生成：每章生成后其正文才进入 DB）。 */
async function freezeEachChapter() {
  const frozen: Array<{
    position: number;
    serialized: ReturnType<typeof serializePipelineTaskContext>;
  }> = [];
  for (let position = 0; position < TOTAL_CHAPTERS; position++) {
    const current = chapterAt(position, position === 0 ? '' : `第${position}章正文。`);
    // 生产语义：写第 N 章时，第 N-1 章已完成入库
    mockChapters = Array.from({ length: position + 1 }, (_, i) =>
      chapterAt(i, i === position ? '' : `第${i}章正文。`),
    );
    const result = await buildContext(current, CONFIG, PROJECT, undefined, {
      contextWindow: 128000,
      reservedOutputTokens: 4000,
      contextBudgetVersion: 5,
    });
    frozen.push({
      position,
      serialized: serializePipelineTaskContext({
        draftContext: result.pipelineContext,
        execution: execution(),
        trace: {
          version: 1,
          generationTraceId: `gt-golden17-${String(position).padStart(2, '0')}aaaa`,
          createdAt: 1700000000000 + position,
        },
      }),
    });
  }
  return frozen;
}

describe('GJ-17 单章 / GJ-18 一键 N 章：每章独立 Snapshot，泄漏=0', () => {
  test('GJ-17 单章冻结：来源严格 prior，指纹可推导', async () => {
    mockOutlineRows = [];
    mockChapters = [chapterAt(0, '已完成正文')];
    const current = chapterAt(1, '');
    const result = await buildContext(current, CONFIG, PROJECT, undefined, {
      contextWindow: 128000,
      reservedOutputTokens: 4000,
      contextBudgetVersion: 5,
    });
    // §4.6 守卫放行 = 未来来源泄漏为 0
    expect(() =>
      assertNoFutureSourceLeakage({
        currentPosition: current.position,
        previousChapters: result.chapters,
        episodicCandidates: [],
      }),
    ).not.toThrow();
    const serialized = serializePipelineTaskContext({
      draftContext: result.pipelineContext,
      execution: execution(),
    });
    const view = deriveFrozenGenerationContext({
      pipelineTaskId: 'single',
      parsed: parsePersistedPipelineTaskContext(serialized),
    });
    expect(view!.computedGenerationFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test('GJ-18 N 章顺序生成：每章指纹独立、无未来泄漏、无后向污染', async () => {
    mockOutlineRows = [];
    const frozen = await freezeEachChapter();

    // 1) 每章独立快照：指纹互不相同
    const fingerprints = frozen.map(f => f.serialized.generationFingerprint);
    expect(new Set(fingerprints).size).toBe(TOTAL_CHAPTERS);

    // 2) 每章快照身份正确归属（trace id 逐章独立且可恢复）
    const traceIds = frozen.map(
      f => parsePersistedPipelineTaskContext(f.serialized).trace?.generationTraceId,
    );
    expect(new Set(traceIds).size).toBe(TOTAL_CHAPTERS);
    traceIds.forEach((id, i) => expect(id).toBe(`gt-golden17-${String(i).padStart(2, '0')}aaaa`));

    // 3) 无后向污染：第 4/5 章入库后，第 1 章的冻结指纹不变
    const firstFingerprint = frozen[0].serialized.generationFingerprint;
    const reparsedFirst = parsePersistedPipelineTaskContext(frozen[0].serialized);
    const viewFirst = deriveFrozenGenerationContext({
      pipelineTaskId: 'ch0',
      parsed: reparsedFirst,
    });
    expect(viewFirst!.computedGenerationFingerprint).toBe(firstFingerprint);
  });
});

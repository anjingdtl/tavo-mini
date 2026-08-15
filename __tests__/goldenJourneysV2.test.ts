/**
 * Stability Phase 7 — Golden Journey V2 (plan §11).
 *
 * The Phase-1 20 journeys remain in goldenJourneys.test.ts and
 * goldenJourneysMultiChapter.test.ts. This suite adds GJ-21..28 and makes the
 * decision contract itself the assertion surface: Candidate, Selection,
 * Reason, Allocation, Rendered, Fingerprint, and Diagnostic.
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

jest.mock('../src/services/database', () => ({
  getChaptersByProject: jest.fn(async () => mockChapters),
  getCharactersByProject: jest.fn(async () => mockCharacters),
  getNotesByProject: jest.fn(async () => mockNotes),
  getNotesContentByIds: jest.fn(async () =>
    Object.fromEntries(mockNotes.map((note: any) => [Number(note.id), note.content])),
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
import {
  parsePersistedPipelineTaskContext,
  serializePipelineTaskContext,
} from '../src/services/pipelineTaskContext';
import { computeGenerationContractFingerprint } from '../src/services/context/generation/generationContractValidation';
import { buildGenerationTraceSummary } from '../src/services/pipeline/generationTrace';
import {
  createContinuationBatchTraceId,
  createContinuationGenerationTrace,
} from '../src/services/continuation/generation/continuationGenerationTrace';
import { buildContinuationBatchChapterInstruction } from '../src/services/multiChapterBatch/continuationBatchInstruction';
import { estimateTokens } from '../src/utils/tokenEstimator';
import type { FrozenWriterStyleV1 } from '../src/services/writerStyle/types';

const PROJECT = 7;
const CONFIG: any = {
  strategy: 'sliding',
  slidingWindowSize: 4,
  customRangeStart: 0,
  customRangeEnd: -1,
  resourceBudget: 2000,
  includeResources: true,
  memoryTopK: 5,
};

function chapterAt(position: number, content = '', title = `第${position + 1}章`) {
  return {
    id: position + 1,
    project_id: PROJECT,
    position,
    title,
    synopsis: `第${position + 1}章概要`,
    content,
    status: 'final' as const,
    summary_json: null,
    created_at: '',
    updated_at: '',
    memory_summary: position < 1 ? '' : `第${position + 1}章梗概`,
  };
}

function makeOutline(content = '主线计划：主角在青秀路完成调查。') {
  return {
    id: 1,
    projectId: PROJECT,
    title: '主线',
    content,
    sourceType: 'manual' as const,
    enabled: true,
    position: 0,
    estimatedTokens: 20,
    contentHash: 'hash-outline',
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function resetFixtures() {
  mockChapters = [chapterAt(0, '前章正文'), chapterAt(1)];
  mockCharacters = [];
  mockNotes = [];
  mockWorldbook = [];
  mockNoteConfig = null;
  mockOutlineRows = [makeOutline()];
  mockContextWindow = 128000;
}

function execution() {
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
  } as any;
}

async function buildJourney(
  options: Record<string, unknown> = {},
  config = CONFIG,
) {
  const contextWindow = Number(options.contextWindow || 128000);
  mockContextWindow = contextWindow;
  return buildContext(
    chapterAt(1),
    config,
    PROJECT,
    undefined,
    {
      contextWindow,
      reservedOutputTokens: 4000,
      contextBudgetVersion: 5,
      ...options,
    },
  );
}

function mandatoryDecisionSignature(contract: any) {
  return contract.candidates
    .filter((candidate: any) => candidate.requirement === 'mandatory')
    .map((candidate: any) => {
      const budget = contract.budget.find(
        (item: any) => item.candidateId === candidate.candidateId,
      );
      const rendered = contract.rendered.find(
        (item: any) => item.candidateId === candidate.candidateId,
      );
      return [
        candidate.candidateId,
        candidate.selected,
        budget?.allocatedTokens ?? null,
        budget?.allocationReason ?? null,
        rendered?.actualTokens ?? null,
        rendered?.included ?? null,
      ];
    })
    .sort((a: any[], b: any[]) => String(a[0]).localeCompare(String(b[0])));
}

/**
 * One reusable V2 assertion deliberately covers all seven decision surfaces.
 * It also round-trips the real persisted envelope so this is not a shape-only
 * unit test.
 */
function assertGoldenJourneyV2(
  pipelineContext: any,
  traceId: string,
) {
  const contract = pipelineContext.generationContract;
  expect(contract).toBeDefined();
  expect(contract.version).toBe(2);
  expect(contract.candidates.length).toBeGreaterThan(0);

  const candidateIds = new Set<string>();
  for (const candidate of contract.candidates) {
    expect(candidateIds.has(candidate.candidateId)).toBe(false);
    candidateIds.add(candidate.candidateId);
    expect(typeof candidate.selected).toBe('boolean');
    const reason = candidate.selected
      ? candidate.selectedReason
      : candidate.rejectedReason;
    expect(typeof reason).toBe('string');
    expect(reason).not.toBe('');
    expect(candidate.contentHash).toMatch(/^[0-9a-f]{64}$/i);
  }

  expect(contract.budget.length).toBeGreaterThan(0);
  for (const budget of contract.budget) {
    expect(candidateIds.has(budget.candidateId)).toBe(true);
    expect(budget.allocatedTokens).toBeGreaterThanOrEqual(0);
    expect(budget.demandTokens).toBeGreaterThanOrEqual(0);
    expect(budget.allocationReason).not.toBe('');
    expect(typeof budget.budgetClipped).toBe('boolean');
    expect(budget.budgetClipped).toBe(budget.clippedByBudget);
  }

  expect(contract.rendered.length).toBeGreaterThan(0);
  for (const rendered of contract.rendered) {
    expect(candidateIds.has(rendered.candidateId)).toBe(true);
    expect(rendered.allocatedTokens).toBeGreaterThanOrEqual(0);
    expect(rendered.actualTokens).toBeGreaterThanOrEqual(0);
    expect(typeof rendered.included).toBe('boolean');
    expect(typeof rendered.clipped).toBe('boolean');
    expect(rendered.renderedHash).toMatch(/^[0-9a-f]{64}$/i);
  }

  expect(contract.messages.length).toBeGreaterThan(0);
  expect(Array.isArray(contract.diagnostics)).toBe(true);
  for (const diagnostic of contract.diagnostics) {
    expect(diagnostic.code).not.toBe('');
    expect(['info', 'warning', 'error', 'blocking']).toContain(
      diagnostic.severity,
    );
    expect(diagnostic.message).not.toBe('');
  }
  expect(contract.fingerprint).toBe(
    computeGenerationContractFingerprint(contract),
  );

  const serialized = serializePipelineTaskContext({
    draftContext: pipelineContext,
    execution: execution(),
    trace: {
      version: 1,
      generationTraceId: traceId,
      createdAt: 1700000000000,
    },
  });
  const parsed = parsePersistedPipelineTaskContext(serialized);
  const summary = buildGenerationTraceSummary({
    pipelineTaskId: `task-${traceId}`,
    parsed,
    attempts: [],
  });
  expect(summary.version).toBe(2);
  if (summary.version !== 2) return contract;
  expect(summary.candidateCount).toBe(contract.candidates.length);
  expect(summary.selectedCount).toBe(
    contract.candidates.filter((candidate: any) => candidate.selected).length,
  );
  expect(summary.candidates).toHaveLength(contract.candidates.length);
  expect(summary.candidates.every(candidate => candidate.reason.length > 0)).toBe(
    true,
  );
  expect(summary.diagnostics).toEqual(contract.diagnostics);
  return contract;
}

function style(name: string): FrozenWriterStyleV1 {
  return {
    semanticVersion: 1,
    assetId: 1,
    assetName: name,
    sourceFormat: 'shinewriter',
    semantic: null,
    legacySystemText: `风格-${name}`,
    legacyWritingStyleText: '',
    legacyExtraInstructionsText: '',
    sourceFingerprint: `fp-${name}`,
    compatibilityFingerprint: `compat-${name}`,
    samplerResolution: {
      preservedFields: [],
      ignoredAtPipeline: [],
    },
    stageProjections: {
      draft: {
        stage: 'draft',
        protected: true,
        compilerVersion: 'writer-style-projection-v1',
        estimatedTokens: 50,
        mode: 'FULL',
        text: `风格-${name}`,
      },
      review: {
        stage: 'review',
        protected: true,
        compilerVersion: 'writer-style-projection-v1',
        estimatedTokens: 50,
        mode: 'FULL',
        text: `风格-${name}`,
      },
      factCheck: {
        stage: 'factCheck',
        protected: true,
        compilerVersion: 'writer-style-projection-v1',
        estimatedTokens: 50,
        mode: 'FULL',
        text: `风格-${name}`,
      },
      brief: {
        stage: 'brief',
        protected: true,
        compilerVersion: 'writer-style-projection-v1',
        estimatedTokens: 50,
        mode: 'FULL',
        text: `风格-${name}`,
      },
      proof: {
        stage: 'proof',
        protected: true,
        compilerVersion: 'writer-style-projection-v1',
        estimatedTokens: 50,
        mode: 'FULL',
        text: `风格-${name}`,
      },
    },
  } as any;
}

beforeEach(resetFixtures);

describe('Golden Journey V2 — decision contract and freeze stability', () => {
  test('GJ-21 same inputs freeze twice → semantic contract identical', async () => {
    const first = await buildJourney();
    const second = await buildJourney();
    const firstContract = assertGoldenJourneyV2(
      first.pipelineContext,
      'gt-1-abcdefgh',
    );
    const secondContract = assertGoldenJourneyV2(
      second.pipelineContext,
      'gt-2-abcdefgh',
    );
    expect(secondContract).toEqual(firstContract);
  });

  test('GJ-22 adding an inactive low-relevance worldbook keeps mandatory allocation unchanged', async () => {
    const baseline = await buildJourney();
    const baselineContract = assertGoldenJourneyV2(
      baseline.pipelineContext,
      'gt-3-abcdefgh',
    );
    mockWorldbook = [
      {
        id: 99,
        keyword_primary: '不存在的关键词',
        keyword_secondary: '',
        content: '低相关世界观，不应改变强制上下文。',
        constant: 0,
        position: 99,
      },
    ];
    const expanded = await buildJourney();
    const expandedContract = assertGoldenJourneyV2(
      expanded.pipelineContext,
      'gt-4-abcdefgh',
    );
    expect(mandatoryDecisionSignature(expandedContract)).toEqual(
      mandatoryDecisionSignature(baselineContract),
    );
  });

  test('GJ-23 64K → 128K keeps the mandatory selected set', async () => {
    const small = await buildJourney({ contextWindow: 65536 });
    const large = await buildJourney({ contextWindow: 128000 });
    const smallContract = assertGoldenJourneyV2(
      small.pipelineContext,
      'gt-5-abcdefgh',
    );
    const largeContract = assertGoldenJourneyV2(
      large.pipelineContext,
      'gt-6-abcdefgh',
    );
    expect(
      smallContract.candidates
        .filter((candidate: any) => candidate.requirement === 'mandatory')
        .map((candidate: any) => [candidate.candidateId, candidate.selected])
        .sort(),
    ).toEqual(
      largeContract.candidates
        .filter((candidate: any) => candidate.requirement === 'mandatory')
        .map((candidate: any) => [candidate.candidateId, candidate.selected])
        .sort(),
    );
  });

  test('GJ-24 128K → 1M keeps the sliding window bounded', async () => {
    const config = { ...CONFIG, slidingWindowSize: 20 };
    mockChapters = Array.from({ length: 11 }, (_, position) =>
      chapterAt(position, `PRIOR_${position}`),
    );
    const medium = await buildContext(
      chapterAt(10, '', '第11章'),
      config,
      PROJECT,
      undefined,
      {
        contextWindow: 128000,
        reservedOutputTokens: 8000,
        contextBudgetVersion: 5,
      },
    );
    const huge = await buildContext(
      chapterAt(10, '', '第11章'),
      config,
      PROJECT,
      undefined,
      {
        contextWindow: 1_000_000,
        reservedOutputTokens: 8000,
        contextBudgetVersion: 5,
      },
    );
    assertGoldenJourneyV2(medium.pipelineContext, 'gt-7-abcdefgh');
    assertGoldenJourneyV2(huge.pipelineContext, 'gt-7-bcdefghi');
    for (const result of [medium, huge]) {
      expect(result.pipelineContext.recentBridgeText).toBeTruthy();
      expect(estimateTokens(result.pipelineContext.recentBridgeText)).toBeLessThanOrEqual(
        config.slidingWindowSize,
      );
      expect(result.pipelineContext.recentBridgeText).not.toContain('PRIOR_0');
    }
    expect(huge.estimatedInputTokens).toBeLessThan(1_000_000);
  });

  test('GJ-25 doubling optional resource content does not displace mandatory material', async () => {
    mockWorldbook = [
      {
        id: 10,
        keyword_primary: '青秀路',
        keyword_secondary: '',
        content: '可选世界观。'.repeat(20),
        constant: 0,
        position: 0,
      },
    ];
    const normal = await buildJourney();
    const normalContract = assertGoldenJourneyV2(
      normal.pipelineContext,
      'gt-8-abcdefgh',
    );
    mockWorldbook[0].content = '可选世界观。'.repeat(40);
    const doubled = await buildJourney();
    const doubledContract = assertGoldenJourneyV2(
      doubled.pipelineContext,
      'gt-9-abcdefgh',
    );
    expect(mandatoryDecisionSignature(doubledContract)).toEqual(
      mandatoryDecisionSignature(normalContract),
    );
  });

  test('GJ-26 Writer Style changes only new generation; resume consumes old frozen style', async () => {
    const chapter = chapterAt(1);
    const compiledA = await compileDraftPipelineRequest({
      chapter: chapter as any,
      draftMaxTokens: 4000,
      contextBudgetVersion: 5,
      writerStyleSnapshot: style('A'),
    });
    assertGoldenJourneyV2(compiledA.pipelineContext, 'gt-a-abcdefgh');
    const frozenA = serializePipelineTaskContext({
      draftContext: compiledA.pipelineContext,
      execution: execution(),
      trace: {
        version: 1,
        generationTraceId: 'gt-a-abcdefgh',
        createdAt: 1700000000000,
      },
    });
    const resumed = parsePersistedPipelineTaskContext(frozenA);
    expect(resumed.draftContext.writerStyleSnapshot?.assetName).toBe('A');

    const compiledB = await compileDraftPipelineRequest({
      chapter: chapter as any,
      draftMaxTokens: 4000,
      contextBudgetVersion: 5,
      writerStyleSnapshot: style('B'),
    });
    assertGoldenJourneyV2(compiledB.pipelineContext, 'gt-b-abcdefgh');
    expect(compiledB.pipelineContext.writerStyleSnapshot?.assetName).toBe('B');
    const frozenB = serializePipelineTaskContext({
      draftContext: compiledB.pipelineContext,
      execution: execution(),
    });
    expect(frozenA.generationFingerprint).not.toBe(frozenB.generationFingerprint);
  });

  test('GJ-27 deleting worldbook after freeze affects new generation but not resume', async () => {
    mockWorldbook = [
      {
        id: 11,
        keyword_primary: '青秀路',
        keyword_secondary: '',
        content: '冻结前世界观：雨夜必须带伞。',
        constant: 1,
        position: 0,
      },
    ];
    const before = await buildJourney();
    assertGoldenJourneyV2(before.pipelineContext, 'gt-c-abcdefgh');
    expect(before.pipelineContext.worldbookText).toContain('冻结前世界观');
    const frozen = serializePipelineTaskContext({
      draftContext: before.pipelineContext,
      execution: execution(),
      trace: {
        version: 1,
        generationTraceId: 'gt-c-abcdefgh',
        createdAt: 1700000000000,
      },
    });
    mockWorldbook = [];
    const resumed = parsePersistedPipelineTaskContext(frozen);
    expect(resumed.draftContext.worldbookText).toContain('冻结前世界观');
    expect(resumed.generationFingerprint).toBe(frozen.generationFingerprint);

    const fresh = await buildJourney();
    assertGoldenJourneyV2(fresh.pipelineContext, 'gt-d-abcdefgh');
    expect(fresh.pipelineContext.worldbookText).not.toContain('冻结前世界观');
    const freshFrozen = serializePipelineTaskContext({
      draftContext: fresh.pipelineContext,
      execution: execution(),
    });
    expect(freshFrozen.generationFingerprint).not.toBe(
      frozen.generationFingerprint,
    );
  });
});

describe('Golden Journey V2 — Continuation N=3', () => {
  function continuationSnapshot(ordinal: number, instruction: string) {
    return {
      projectId: PROJECT,
      targetChapterId: 100 + ordinal,
      targetPosition: ordinal + 2,
      source: {
        sourceId: 11,
        sourceVersion: 2,
        normalizedSha256: 'source-hash',
        parserVersion: 'parser-v1',
        normalizationVersion: 'normalizer-v1',
        boundary: {
          chapterId: 20,
          chapterPosition: 2,
          charOffsetExclusive: 456,
        },
      },
      canon: { snapshotId: 'canon-1', revision: 4 },
      storyMemory: {
        stateFingerprint: 'memory-hash',
        throughPosition: 2,
        status: 'ready',
      },
      inputRevisionHash: `input-${ordinal}`,
      contextBudget: {
        modelContextLimit: 32768,
        inputBudget: 24000,
        reservedOutputTokens: 4000,
      },
      primaryAnchor: {
        kind: 'continuation_chapter',
        chapterId: 20,
        position: 2,
      },
      settingsSnapshot: {
        resolvedModelConfigIds: { writer: 2 },
        frozenModelConfigs: { writer: null },
      },
      bundles: { userInstruction: instruction },
    } as any;
  }

  test('GJ-28 Continuation N=3 has independent fingerprints, correct lineage, and zero future leakage', () => {
    const futureOnly = 'FUTURE_ONLY_CHAPTER_3_SECRET';
    const batch = createContinuationBatchTraceId('gj-28-batch');
    const traces = [1, 2, 3].map(ordinal => {
      const instruction = buildContinuationBatchChapterInstruction(
        {
          sourcePrompt: '只推进当前章节',
          writingMode: 'continuation',
          futureSiblingPlan: futureOnly,
        } as any,
        {
          ordinal,
          title: `当前第${ordinal}章`,
          synopsis: `当前第${ordinal}章梗概`,
          keyBeatsJson: JSON.stringify([`当前事件${ordinal}`]),
          carryIn: '接缝',
          carryOut: '交接',
          targetWords: 3000,
        } as any,
      );
      return createContinuationGenerationTrace({
        snapshot: continuationSnapshot(ordinal, instruction),
        trace: {
          sourceId: 11,
          canonSnapshotId: 'canon-1',
          canonRevision: 4,
          targetPosition: ordinal + 2,
          entityRefs: [],
          storyMemoryFingerprint: 'memory-hash',
          freshness: {
            canonReady: true,
            storyMemoryStatus: 'ready',
            pendingStateExtractionCount: 0,
            pendingMajorProposalCount: 0,
          },
          categories: [],
          totalInputTokens: 12,
          reservedOutputTokens: 4000,
          inputBudget: 24000,
          modelContextLimit: 32768,
          omittedCapabilities: [],
        } as any,
        runId: `gj-28-${ordinal}`,
        generationTraceId: `gt_gj28_${ordinal}`,
        batchTraceId: batch,
        chapterOrdinal: ordinal,
        chapterCount: 3,
        state: 'running',
        stage: 'round1',
      });
    });

    expect(new Set(traces.map(trace => trace.batchTraceId)).size).toBe(1);
    expect(traces.map(trace => trace.generationTrace?.lineage.chapterOrdinal)).toEqual([
      1,
      2,
      3,
    ]);
    expect(
      traces.every(trace => trace.generationTrace?.lineage.chapterCount === 3),
    ).toBe(true);
    expect(
      new Set(
        traces.map(trace => trace.generationTrace?.lineage.chapterFingerprint),
      ).size,
    ).toBe(3);
    expect(JSON.stringify(traces)).not.toContain(futureOnly);
  });
});

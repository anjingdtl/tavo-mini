/**
 * Stability Phase 6 — Generation Replay Harness (plan §7).
 *
 * Gate P0-6: same fixture replayed 10 times → identical fingerprint; all
 * deterministic derivations (semantic fingerprint, frozen request
 * fingerprint) replay to their frozen values; tampered content is detected.
 */
import {
  replayFrozenGeneration,
  replayDeterminism,
  replayGenerationFixtureV2,
  replayDeterminismV2,
} from '../src/services/pipeline/replayHarness';
import type { GenerationReplayFixtureV2 } from '../src/services/pipeline/replayHarness';
import {
  serializePipelineTaskContext,
  computeFrozenDraftRequestFingerprint,
} from '../src/services/pipelineTaskContext';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';
import type { PipelineExecutionSnapshot } from '../src/types/pipelineExecution';
import type { FrozenDraftRequest } from '../src/types/pipelineFrozen';

function context(): PipelineContextSnapshot {
  return {
    presetText: 'preset',
    storyMemoryText: 'story',
    characterText: 'char',
    noteText: 'note',
    worldbookText: 'wb',
    episodicMemoryText: 'episodic',
    recentBridgeText: 'bridge',
    currentInstructionText: 'instruction',
    retrievalUserPrompt: 'prompt',
    outlineText: 'outline',
    outlineFingerprint: 'outline-fp',
    outlineIds: [1],
    outlineComplete: true,
    outlineEstimatedTokens: 12,
    projectId: 7,
    chapterId: 23,
    createdAt: 1700000000000,
    snapshotVersion: 1,
    stabilityDiagnostics: [
      {
        code: 'RESOURCE_RETRIEVAL_FAILED',
        severity: 'warning',
        message: 'demo',
      },
    ],
  };
}

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
    model: {
      llmConfigId: 1,
      name: 'Model',
      provider: 'openai_compatible',
      modelName: 'model-a',
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
    createdAt: 1700000000000,
  } as PipelineExecutionSnapshot;
}

function frozenRequest(): FrozenDraftRequest {
  const meta = {
    estimatedInputTokens: 42100,
    reservedOutputTokens: 4000,
    safetyMargin: 2000,
    contextWindow: 128000,
  };
  const messages = [
    { role: 'system' as const, content: 'sys prompt' },
    { role: 'user' as const, content: '请写第23章' },
  ];
  return {
    messages,
    ...meta,
    allocations: [
      { id: 'outline', requested: 100, allocated: 100, truncated: false },
    ],
    requestFingerprint: computeFrozenDraftRequestFingerprint(messages, meta),
    chapterTitle: '第23章',
    prevEnding: '……',
    userPrompt: '请写第23章',
  };
}

function fixture() {
  return serializePipelineTaskContext({
    draftContext: context(),
    execution: execution(),
    frozenDraftRequest: frozenRequest(),
    trace: {
      version: 1,
      generationTraceId: 'gt-replay00-a1b2c3d4',
      createdAt: 1700000000000,
    },
  });
}

describe('replayFrozenGeneration', () => {
  test('all deterministic checks pass on a healthy fixture', () => {
    const result = replayFrozenGeneration(fixture());
    expect(result.ok).toBe(true);
    expect(result.parsed).toBe(true);
    expect(result.generationTraceId).toBe('gt-replay00-a1b2c3d4');
    expect(result.generationFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.diagnostics.map(d => d.code)).toEqual([
      'RESOURCE_RETRIEVAL_FAILED',
    ]);
    expect(
      result.checks.map(c => ({ name: c.name, passed: c.passed })),
    ).toEqual([
      { name: 'envelope_parse', passed: true },
      { name: 'generation_fingerprint_matches_stored', passed: true },
      { name: 'frozen_draft_request_fingerprint_replay', passed: true },
    ]);
  });

  test('semantic tamper fails the fingerprint check', () => {
    const serialized = fixture();
    const raw = JSON.parse(serialized.pipelineContextJson);
    raw.draftContext.outlineText = '被篡改的大纲';
    const result = replayFrozenGeneration({
      pipelineContextJson: JSON.stringify(raw),
      pipelineContextVersion: serialized.pipelineContextVersion,
      pipelineContextHash: null,
    });
    expect(result.ok).toBe(false);
    const failed = result.checks.find(c => !c.passed);
    expect(failed?.name).toBe('generation_fingerprint_matches_stored');
  });

  test('message tamper fails the frozen request fingerprint replay', () => {
    const serialized = fixture();
    const raw = JSON.parse(serialized.pipelineContextJson);
    raw.frozenDraftRequest.messages[1].content = '被篡改的指令';
    // Repair the byte-level integrity so the SEMANTIC check is what fires.
    const json = JSON.stringify(raw);
    const result = replayFrozenGeneration({
      pipelineContextJson: json,
      pipelineContextVersion: serialized.pipelineContextVersion,
      pipelineContextHash: null,
    });
    expect(result.ok).toBe(false);
    expect(
      result.checks.find(c => !c.passed)?.name,
    ).toBe('frozen_draft_request_fingerprint_replay');
  });

  test('corrupt envelope reports parse failure without throwing', () => {
    const result = replayFrozenGeneration({
      pipelineContextJson: '{not json',
      pipelineContextHash: null,
    });
    expect(result.parsed).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.checks[0].name).toBe('envelope_parse');
  });
});

describe('replayDeterminism (Phase 6 gate)', () => {
  test('same fixture × 10 → identical fingerprints', () => {
    const serialized = fixture();
    const result = replayDeterminism({
      pipelineContextJson: serialized.pipelineContextJson,
      pipelineContextVersion: serialized.pipelineContextVersion,
      pipelineContextHash: serialized.pipelineContextHash,
    });
    expect(result.iterations).toBe(10);
    expect(result.allIdentical).toBe(true);
    expect(new Set(result.fingerprints).size).toBe(1);
  });
});

function replayChapter(position = 2): any {
  return {
    id: position + 1,
    project_id: 7,
    position,
    title: `第${position + 1}章`,
    synopsis: '主角抵达青秀路。',
    content: '',
    status: 'planned',
    summary_json: null,
    created_at: '2026-08-15T00:00:00.000Z',
    updated_at: '2026-08-15T00:00:00.000Z',
  };
}

function replayFixture(overrides: Partial<GenerationReplayFixtureV2> = {}): GenerationReplayFixtureV2 {
  return {
    fixtureId: 'REG-001',
    project: { id: 7, mode: 'outline' },
    chapter: replayChapter(),
    previousChapters: [
      { ...replayChapter(1), content: '前章正文。' },
    ],
    outline: {
      text: '主线：主角抵达青秀路。',
      estimatedTokens: 12,
      fingerprint: 'outline-replay-v2',
      outlineIds: [1],
      complete: true,
    },
    resources: {
      characters: [
        {
          id: 1,
          name: '林晚',
          data_json: JSON.stringify({ description: '克制的主角。' }),
        },
      ],
      notes: [{ id: 2, title: '反派动机' }],
      noteConfig: { mode: 'original' },
      noteContents: { 2: '旧怨未消。' },
      worldbookEntries: [
        {
          id: 3,
          keyword_primary: '青秀路',
          content: '青秀路存在雨夜杀人狂。',
          constant: 0,
          position: 0,
        },
      ],
      candidates: [],
    },
    storyMemory: {
      text: '主线状态：主角正在调查。',
      prepared: { checkpointEligibility: { usable: true, reason: 'usable' } },
    },
    contextConfig: {
      strategy: 'sliding',
      slidingWindowSize: 4,
      customRangeStart: 0,
      customRangeEnd: -1,
      resourceBudget: 2000,
      includeResources: true,
    },
    preset: '你是一位稳定的中文小说作者。',
    writerStyle: { text: '克制、清晰、少用套话。' },
    modelConfig: {
      contextWindow: 128000,
      reservedOutputTokens: 4000,
      safetyMargin: 2000,
    },
    policy: { allocationMode: 'legacy' },
    expected: null,
    ...overrides,
  };
}

function fixtureWithExpected(replayCase: GenerationReplayFixtureV2): GenerationReplayFixtureV2 {
  const first = replayGenerationFixtureV2(replayCase);
  expect(first.ok).toBe(true);
  expect(first.actual).toBeDefined();
  return { ...replayCase, expected: first.actual! };
}

describe('replayGenerationFixtureV2 (Phase 4 Decision Replay)', () => {
  test('executes every stage and returns structured decision diffs', () => {
    const replayCase = fixtureWithExpected(replayFixture());
    const result = replayGenerationFixtureV2(replayCase);
    expect(result.ok).toBe(true);
    expect(result.stageOrder).toEqual([
      'collect',
      'normalize',
      'plan',
      'allocate',
      'render',
      'freeze',
      'compare',
    ]);
    expect(result.actual?.candidates.length).toBeGreaterThan(0);
    expect(result.actual?.budget.length).toBeGreaterThan(0);
    expect(result.actual?.rendered.length).toBeGreaterThan(0);

    const tamperedExpected = {
      ...replayCase.expected!,
      candidates: replayCase.expected!.candidates.map(candidate =>
        candidate.candidateId === 'character:1'
          ? { ...candidate, selected: !candidate.selected }
          : candidate,
      ),
      budget: replayCase.expected!.budget.map(item =>
        item.candidateId === 'character:1'
          ? { ...item, allocatedTokens: item.allocatedTokens + 1 }
          : item,
      ),
      rendered: replayCase.expected!.rendered.map(item =>
        item.candidateId === 'character:1'
          ? { ...item, renderedHash: '0'.repeat(64) }
          : item,
      ),
      diagnostics: [
        {
          code: 'REPLAY_EXPECTED_DIAGNOSTIC',
          severity: 'warning' as const,
          message: 'expected mismatch',
        },
      ],
      fingerprint: 'f'.repeat(64),
    };
    const mismatch = replayGenerationFixtureV2({
      ...replayCase,
      expected: tamperedExpected,
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.diffs.map(diff => diff.kind)).toEqual(
      expect.arrayContaining([
        'selection_mismatch',
        'allocation_mismatch',
        'render_mismatch',
        'fingerprint_mismatch',
        'diagnostics_mismatch',
      ]),
    );
  });

  test('replays one fixture ten times with identical decisions and render', () => {
    const replayCase = fixtureWithExpected(replayFixture());
    const result = replayDeterminismV2(replayCase, 10);
    expect(result.iterations).toBe(10);
    expect(result.allIdentical).toBe(true);
    expect(new Set(result.candidateSignatures).size).toBe(1);
    expect(new Set(result.selectedSignatures).size).toBe(1);
    expect(new Set(result.allocationSignatures).size).toBe(1);
    expect(new Set(result.renderSignatures).size).toBe(1);
    expect(new Set(result.fingerprints).size).toBe(1);
  });

  test.each([
    ['REG-001', replayFixture()],
    ['GJ-07 Writer Style', replayFixture({
      fixtureId: 'GJ-07 Writer Style',
      writerStyle: { text: '只使用冻结的作家风格。' },
    })],
    ['Note None', replayFixture({
      fixtureId: 'Note None',
      resources: {
        ...replayFixture().resources,
        noteConfig: { mode: 'none' },
      },
    })],
    ['Story Memory Dirty', replayFixture({
      fixtureId: 'Story Memory Dirty',
      storyMemory: {
        text: '',
        prepared: { checkpointEligibility: { usable: false, reason: 'not_clean' } },
      },
    })],
    ['1M Context', replayFixture({
      fixtureId: '1M Context',
      modelConfig: {
        contextWindow: 1_000_000,
        reservedOutputTokens: 8000,
        safetyMargin: 2000,
      },
      resources: {
        ...replayFixture().resources,
        candidates: Array.from({ length: 30 }, (_, index) => ({
          candidateId: `other:large-${index}`,
          sourceType: 'other' as const,
          sourceId: index,
          content: `大窗口资料-${index}-`.repeat(60),
          selected: true,
          selectedReason: 'fixture_source',
          demandTokens: 300,
          sourceOrder: index,
        })),
      },
    })],
  ])('supports required fixture %s through the full replay pipeline', (_name, replayCase) => {
    const replayed = replayGenerationFixtureV2(
      fixtureWithExpected(replayCase as GenerationReplayFixtureV2),
    );
    expect(replayed.ok).toBe(true);
    expect(replayed.actual?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(replayed.diffs).toEqual([]);
  });
});

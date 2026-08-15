/**
 * Stability Phase 1 — Generation Trace (Trace First).
 *
 * Gate P0-1: existing generation behavior unchanged; a trace identity can
 * cover one full single-chapter generation (id minted at entry → frozen into
 * the persisted envelope → stable across serialize/parse → resume reuses).
 */
import {
  createGenerationTraceId,
  deriveOverallStatus,
  buildGenerationTraceSummary,
  isValidGenerationTraceId,
} from '../src/services/pipeline/generationTrace';
import {
  parsePersistedPipelineTaskContext,
  serializePipelineTaskContext,
} from '../src/services/pipelineTaskContext';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';
import type { PipelineExecutionSnapshot } from '../src/types/pipelineExecution';
import type { PipelineStageAttemptRow } from '../src/data/repositories/pipelineStageAttemptRepository';
import type { GenerationDiagnostic } from '../src/types/generationTrace';
import type { FrozenGenerationContextContractV2 } from '../src/services/context/generation/generationContracts';
import { computeGenerationContractFingerprint } from '../src/services/context/generation/generationContractValidation';

function context(): PipelineContextSnapshot {
  return {
    presetText: 'preset',
    storyMemoryText: '',
    characterText: 'character',
    noteText: '',
    worldbookText: 'worldbook',
    episodicMemoryText: '',
    recentBridgeText: '',
    currentInstructionText: '继续本章',
    retrievalUserPrompt: '',
    outlineText: '停在门前',
    outlineFingerprint: 'outline-fp',
    outlineIds: [1],
    outlineComplete: true,
    outlineEstimatedTokens: 10,
    projectId: 7,
    chapterId: 23,
    createdAt: 1700000000000,
    snapshotVersion: 1,
  };
}

function execution(): PipelineExecutionSnapshot {
  return {
    pipelineMode: 'full',
    outlineWorkflowVersion: 4,
    contextBudgetVersion: 5,
    finalReviserReasoningPolicyVersion: 3,
    reasoningEffort: 'high',
    reasoningProfileVersion: 5,
    requestedReasoningTier: 'high',
    stageReasoning: (['draft', 'review', 'factCheck', 'brief', 'proof'] as const)
      .reduce(
        (acc, stage) => ({
          ...acc,
          [stage]: {
            stage,
            requestedTier: 'high',
            effectiveTier: stage === 'factCheck' ? 'low' : 'high',
            thinking: 'enabled',
            effort: stage === 'factCheck' ? 'low' : 'high',
            supported: true,
          },
        }),
        {} as PipelineExecutionSnapshot['stageReasoning'],
      ),
    briefPolicyVersion: 4,
    briefVisibleOutputFloor: 1200,
    briefReasoningHeadroom: 1200,
    briefMaxTokens: 4096,
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

function draftAttemptRow(
  overrides: Partial<PipelineStageAttemptRow> = {},
): PipelineStageAttemptRow {
  return {
    id: 'att-1',
    pipelineTaskId: 'task-1',
    stage: 'draft',
    attemptNo: 1,
    requestVersion: 1,
    requestFingerprint: 'fp',
    allocationTraceJson: JSON.stringify({
      hardInputLimit: 53536,
      softInputLimit: 42828,
      burstInputLimit: 50859,
      finalEstimatedInputTokens: 42100,
    }),
    frozenRequestJson: null,
    llmConfigId: 1,
    llmConfigSnapshotJson: '{}',
    clientRequestId: 'c-1',
    providerRequestId: null,
    status: 'succeeded',
    failureClass: null,
    errorCode: null,
    errorMessage: null,
    httpStatus: null,
    retryAfterMs: null,
    startedAt: 1700000000000,
    lastProgressAt: null,
    deadlineAt: null,
    nextRetryAt: null,
    completedAt: 1700000001000,
    inputTokens: 42100,
    outputTokens: 1200,
    totalTokens: 43300,
    reasoningTokens: null,
    finishReason: 'stop',
    emptyReason: null,
    responseChannel: 'content',
    responseCandidateChannel: null,
    visibleOutputTokens: 1200,
    parseFailureCode: null,
    formatterUsed: false,
    reasoningContentTemp: null,
    responseCandidateTemp: null,
    validationDetailsJson: null,
    promptCacheHitTokens: null,
    promptCacheMissTokens: null,
    ...overrides,
  };
}

function traceContract(): FrozenGenerationContextContractV2 {
  const payload = {
    version: 2 as const,
    projectId: 7,
    chapterId: 23,
    currentPosition: 3,
    candidates: [
      {
        candidateId: 'character:1',
        sourceType: 'character' as const,
        sourceId: 1,
        sourceRevision: null,
        contentHash: 'a'.repeat(64),
        activation: 'automatic' as const,
        selected: true,
        selectedReason: 'project_character',
        rejectedReason: null,
        requirement: 'preferred' as const,
        relevance: 0.9,
        priority: 7,
        selectionBoost: 1,
        demandTokens: 12,
      },
      {
        candidateId: 'note:2',
        sourceType: 'note' as const,
        sourceId: 2,
        sourceRevision: null,
        contentHash: 'b'.repeat(64),
        activation: 'automatic' as const,
        selected: false,
        selectedReason: null,
        rejectedReason: 'not_activated',
        requirement: 'optional' as const,
        relevance: 0.2,
        priority: 2,
        selectionBoost: 1,
        demandTokens: 8,
      },
      {
        candidateId: 'worldbook:3',
        sourceType: 'worldbook' as const,
        sourceId: 3,
        sourceRevision: null,
        contentHash: 'c'.repeat(64),
        activation: 'automatic' as const,
        selected: true,
        selectedReason: 'keyword_match',
        rejectedReason: null,
        requirement: 'preferred' as const,
        relevance: 0.5,
        priority: 4,
        selectionBoost: 1,
        demandTokens: 10,
      },
    ],
    budget: [
      {
        candidateId: 'character:1',
        demandTokens: 12,
        requestedTokens: 12,
        minTokens: 0,
        targetTokens: 12,
        maxTokens: 12,
        allocatedTokens: 10,
        allocationReason: 'preferred',
        waterLevel: 'soft' as const,
        budgetClipped: true,
        clippedByBudget: true,
      },
      {
        candidateId: 'note:2',
        demandTokens: 8,
        requestedTokens: 8,
        minTokens: 0,
        targetTokens: 8,
        maxTokens: 8,
        allocatedTokens: 0,
        allocationReason: 'not_activated',
        waterLevel: 'none' as const,
        budgetClipped: true,
        clippedByBudget: true,
      },
      {
        candidateId: 'worldbook:3',
        demandTokens: 10,
        requestedTokens: 10,
        minTokens: 0,
        targetTokens: 10,
        maxTokens: 10,
        allocatedTokens: 0,
        allocationReason: 'budget_zero',
        waterLevel: 'none' as const,
        budgetClipped: true,
        clippedByBudget: true,
      },
    ],
    rendered: [
      {
        candidateId: 'character:1',
        allocatedTokens: 10,
        actualTokens: 8,
        included: true,
        clipped: true,
        clippingReason: 'allocation_limit',
        renderedHash: 'd'.repeat(64),
      },
      {
        candidateId: 'note:2',
        allocatedTokens: 0,
        actualTokens: 0,
        included: false,
        clipped: false,
        clippingReason: 'source_empty',
        renderedHash: 'e'.repeat(64),
      },
      {
        candidateId: 'worldbook:3',
        allocatedTokens: 0,
        actualTokens: 0,
        included: false,
        clipped: true,
        clippingReason: 'budget_zero',
        renderedHash: 'f'.repeat(64),
      },
    ],
    messages: [{ role: 'system' as const, content: 'trace' }],
    diagnostics: [],
  };
  const contract = { ...payload, fingerprint: '' } as FrozenGenerationContextContractV2;
  return {
    ...contract,
    fingerprint: computeGenerationContractFingerprint(contract),
  };
}

describe('createGenerationTraceId', () => {
  test('produces stable-format unique ids', () => {
    const a = createGenerationTraceId(1700000000000);
    const b = createGenerationTraceId(1700000000000);
    expect(isValidGenerationTraceId(a)).toBe(true);
    expect(isValidGenerationTraceId(b)).toBe(true);
    expect(a).not.toBe(b);
  });

  test('rejects malformed ids', () => {
    expect(isValidGenerationTraceId('')).toBe(false);
    expect(isValidGenerationTraceId('gt-abc')).toBe(false);
    expect(isValidGenerationTraceId(null)).toBe(false);
  });
});

describe('deriveOverallStatus', () => {
  test('empty diagnostics → OK', () => {
    expect(deriveOverallStatus([])).toBe('OK');
  });

  test('warning or error → DEGRADED', () => {
    const warning: GenerationDiagnostic = {
      code: 'RESOURCE_RETRIEVAL_FAILED',
      severity: 'warning',
      message: 'x',
    };
    const error: GenerationDiagnostic = {
      code: 'STORY_MEMORY_CHECKPOINT_DIRTY',
      severity: 'error',
      message: 'x',
    };
    expect(deriveOverallStatus([warning])).toBe('DEGRADED');
    expect(deriveOverallStatus([error])).toBe('DEGRADED');
  });

  test('blocking dominates everything', () => {
    const diagnostics: GenerationDiagnostic[] = [
      { code: 'BUDGET_MANDATORY_OVERFLOW', severity: 'error', message: 'x' },
      { code: 'BUDGET_INVALID_CAPACITY', severity: 'blocking', message: 'x' },
    ];
    expect(deriveOverallStatus(diagnostics)).toBe('BLOCKED');
  });

  test('info only → OK', () => {
    expect(
      deriveOverallStatus([
        { code: 'GENERATION_CONTEXT_SOURCE_CHANGED', severity: 'info', message: 'x' },
      ]),
    ).toBe('OK');
  });
});

describe('envelope trace record round-trip', () => {
  test('trace survives serialize → parse', () => {
    const trace = {
      version: 1 as const,
      generationTraceId: createGenerationTraceId(),
      createdAt: 1700000000000,
    };
    const serialized = serializePipelineTaskContext({
      draftContext: context(),
      execution: execution(),
      trace,
    });
    const parsed = parsePersistedPipelineTaskContext(serialized);
    expect(parsed.trace).toEqual(trace);
  });

  test('absent trace (historical envelope) parses to null without throwing', () => {
    const serialized = serializePipelineTaskContext({
      draftContext: context(),
      execution: execution(),
    });
    const parsed = parsePersistedPipelineTaskContext(serialized);
    expect(parsed.trace).toBeNull();
  });

  test('malformed trace degrades to null, never blocks resume', () => {
    const serialized = serializePipelineTaskContext({
      draftContext: context(),
      execution: execution(),
      trace: {
        version: 1 as const,
        generationTraceId: createGenerationTraceId(),
        createdAt: 1700000000000,
      },
    });
    const tampered = JSON.parse(serialized.pipelineContextJson);
    tampered.trace = { version: 9, generationTraceId: '', createdAt: 'nope' };
    const raw = JSON.stringify(tampered);
    const parsed = parsePersistedPipelineTaskContext({
      ...serialized,
      pipelineContextJson: raw,
      pipelineContextHash: null,
    });
    expect(parsed.trace).toBeNull();
  });
});

describe('buildGenerationTraceSummary', () => {
  test('derives the §6 minimal summary from persisted state', () => {
    const serialized = serializePipelineTaskContext({
      draftContext: context(),
      execution: execution(),
      trace: {
        version: 1 as const,
        generationTraceId: 'gt-abc12345-x1y2z3w4',
        createdAt: 1700000000000,
      },
    });
    const parsed = parsePersistedPipelineTaskContext(serialized);
    const summary = buildGenerationTraceSummary({
      pipelineTaskId: 'task-1',
      parsed,
      attempts: [draftAttemptRow()],
    });
    expect(summary.version).toBe(1);
    expect(summary.generationTraceId).toBe('gt-abc12345-x1y2z3w4');
    expect(summary.projectId).toBe(7);
    expect(summary.chapterId).toBe(23);
    expect(summary.modelId).toBe('model-a');
    expect(summary.contextWindow).toBe(128000);
    expect(summary.reservedOutputTokens).toBe(4000);
    expect(summary.budget).toEqual({
      hardInputLimit: 53536,
      softInputLimit: 42828,
      burstInputLimit: 50859,
      finalEstimatedInputTokens: 42100,
    });
    expect(summary.attemptCount).toBe(1);
    expect(summary.overallStatus).toBe('OK');
  });

  test('unknown fields stay null — the summary never guesses', () => {
    const summary = buildGenerationTraceSummary({
      pipelineTaskId: 'task-legacy',
      parsed: null,
      attempts: [],
    });
    expect(summary.generationTraceId).toBeNull();
    expect(summary.modelId).toBeNull();
    expect(summary.contextWindow).toBeNull();
    expect(summary.budget.hardInputLimit).toBeNull();
    expect(summary.candidateCount).toBeNull();
    expect(summary.selectedCount).toBeNull();
    expect(summary.diagnostics).toEqual([]);
  });

  test('prefers the succeeded draft attempt for the budget trace', () => {
    const serialized = serializePipelineTaskContext({
      draftContext: context(),
      execution: execution(),
    });
    const parsed = parsePersistedPipelineTaskContext(serialized);
    const summary = buildGenerationTraceSummary({
      pipelineTaskId: 'task-1',
      parsed,
      attempts: [
        draftAttemptRow({
          id: 'att-failed',
          attemptNo: 1,
          status: 'failed',
          allocationTraceJson: JSON.stringify({ hardInputLimit: 1 }),
        }),
        draftAttemptRow({
          id: 'att-ok',
          attemptNo: 2,
          status: 'succeeded',
          allocationTraceJson: JSON.stringify({ hardInputLimit: 53536 }),
        }),
      ],
    });
    expect(summary.budget.hardInputLimit).toBe(53536);
    expect(summary.attemptCount).toBe(2);
  });

  test('derives decision-level Trace V2 from the frozen candidate contract', () => {
    const serialized = serializePipelineTaskContext({
      draftContext: {
        ...context(),
        generationContract: traceContract(),
        stageTimings: [
          { stage: 'collect', durationMs: 3, note: 'repository capture' },
          { stage: 'freeze', durationMs: 1 },
        ],
      },
      execution: execution(),
      frozenDraftRequest: {
        messages: [{ role: 'system', content: 'trace' }],
        estimatedInputTokens: 20,
        reservedOutputTokens: 4000,
        safetyMargin: 2000,
        contextWindow: 128000,
        allocations: [],
        requestFingerprint: 'trace-request',
        chapterTitle: '第23章',
        prevEnding: '',
        userPrompt: '',
      },
    });
    const parsed = parsePersistedPipelineTaskContext(serialized);
    const summary = buildGenerationTraceSummary({
      pipelineTaskId: 'task-v2',
      parsed,
      attempts: [draftAttemptRow()],
    }) as any;
    expect(summary.version).toBe(2);
    expect(summary.candidateSummary).toEqual(
      expect.objectContaining({
        total: 3,
        selected: 2,
        rejected: 1,
        included: 1,
        clipped: 3,
      }),
    );
    expect(summary.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateId: 'character:1',
          selected: true,
          demandTokens: 12,
          allocatedTokens: 10,
          actualTokens: 8,
          reason: 'included',
        }),
        expect.objectContaining({
          candidateId: 'note:2',
          selected: false,
          reason: 'not_activated',
        }),
        expect.objectContaining({
          candidateId: 'worldbook:3',
          selected: true,
          reason: 'budget_zero',
        }),
      ]),
    );
    expect(summary.modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ module: 'character', allocatedTokens: 10 }),
        expect.objectContaining({ module: 'worldbook', allocatedTokens: 0 }),
      ]),
    );
    expect(summary.stageTimings).toEqual([
      { stage: 'collect', durationMs: 3, note: 'repository capture' },
      { stage: 'freeze', durationMs: 1 },
    ]);
  });
});

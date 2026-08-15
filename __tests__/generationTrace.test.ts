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
});

/**
 * One-Shot resume / crash gates (极速档 V1.0 plan §11 / §13 Gate E).
 *
 * - The frozen execution snapshot carries executionProfile across resume.
 * - one_shot blocks every automatic stage retry path (outline safe_retry
 *   reset) — a failed primary must fail closed instead of re-requesting.
 * - Standard tasks keep the auto-retry contract (control group).
 */
import type { ReconcileOptions } from '../src/services/pipeline/reconcile';
import { parsePipelineExecutionSnapshot } from '../src/services/pipelineTaskContext';
import {
  consumeFailedStageRetryDisposition,
  maybeAutoRetryStage,
} from '../src/services/pipeline/outlineStageRuntime';

jest.mock('../src/data/repositories/pipelineStageAttemptRepository', () => ({
  getStageAttempts: jest.fn(),
  createStageAttempt: jest.fn(),
  updateStageAttempt: jest.fn(),
}));

// The database barrel uses read-only re-export bindings; rebuild it with
// plain properties so the checkpoint write can be spied.
jest.mock('../src/services/database', () => {
  const actual = jest.requireActual('../src/services/database');
  return {
    ...actual,
    upsertStageCheckpoint: jest.fn().mockResolvedValue(undefined),
    getStageCheckpoints: jest.fn().mockResolvedValue([]),
    ensurePendingCheckpoints: jest.fn().mockResolvedValue(undefined),
  };
});

import { getStageAttempts } from '../src/data/repositories/pipelineStageAttemptRepository';
import * as db from '../src/services/database';

const upsertStageCheckpointMock = db.upsertStageCheckpoint as jest.Mock;

function oneShotFrozenContext() {
  return {
    version: 1,
    writingRunId: 'wr-resume',
    generationTraceId: 'gt-resume',
    instruction: {},
    sourceBundle: {},
    model: {},
    policy: {},
    requirements: {},
    stagePolicy: {
      version: 1,
      reviewMode: 'full',
      strictness: 'fail-closed',
      semanticApplyRequired: true,
      stageOrder: [],
      outputContract: 'prose',
      skipRules: {},
      values: { executionProfile: 'one_shot' },
      requirementsFingerprint: 'fp',
    },
    plan: {},
    allocation: {},
    rendered: {},
    materials: [],
    freezeFingerprint: 'freeze-resume',
  } as any;
}

describe('One-Shot resume gates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getStageAttempts as jest.Mock).mockResolvedValue([
      {
        id: 'att-1',
        status: 'safe_to_retry',
        failureClass: 'safe_retry',
        attemptNo: 1,
        nextRetryAt: Date.now() - 1000,
      },
    ]);
  });

  test('execution snapshot round-trips executionProfile through the parser', () => {
    const raw = {
      pipelineMode: 'full',
      createdAt: Date.now(),
      outlineWorkflowVersion: 4,
      contextBudgetVersion: 7,
      finalReviserReasoningPolicyVersion: 3,
      reasoningProfileVersion: 5,
      requestedReasoningTier: 'high',
      stageReasoning: {
        draft: { stage: 'draft', requestedTier: 'high', effectiveTier: 'high', thinking: 'enabled', effort: 'high', supported: true },
        review: { stage: 'review', requestedTier: 'high', effectiveTier: 'high', thinking: 'enabled', effort: 'high', supported: true },
        factCheck: { stage: 'factCheck', requestedTier: 'high', effectiveTier: 'low', thinking: 'enabled', effort: 'low', supported: true },
        brief: { stage: 'brief', requestedTier: 'high', effectiveTier: 'high', thinking: 'enabled', effort: 'high', supported: true },
        proof: { stage: 'proof', requestedTier: 'high', effectiveTier: 'high', thinking: 'enabled', effort: 'high', supported: true },
      },
      briefPolicyVersion: 4,
      draftMaxTokens: 100,
      reviewMaxTokens: 100,
      factCheckMaxTokens: 100,
      proofMaxTokens: 100,
      executionProfile: 'one_shot',
      model: {
        llmConfigId: 1,
        name: 'm',
        provider: 'openai_compatible',
        modelName: 'm',
        url: 'https://m.example',
        contextWindow: 32000,
        maxOutputTokens: 2048,
      },
    };
    const parsed = parsePipelineExecutionSnapshot(raw);
    expect(parsed.executionProfile).toBe('one_shot');
    // Historical envelopes predate the profile: absent must stay standard.
    const legacy = parsePipelineExecutionSnapshot({ ...raw, executionProfile: undefined });
    expect(legacy.executionProfile).toBeUndefined();
    // Unknown values fail closed at parse time (no silent tier guessing).
    expect(() =>
      parsePipelineExecutionSnapshot({ ...raw, executionProfile: 'extreme' }),
    ).toThrow();
  });

  test('one_shot blocks the outline auto stage retry (no checkpoint reset, no second request)', async () => {
    const options: ReconcileOptions = {
      frozenWritingContext: oneShotFrozenContext(),
      writingKernelTrace: {
        freezeFingerprint: 'freeze-resume',
      } as any,
    };
    const stages = [
      { stage: 'draft', status: 'failed', outputText: null },
    ] as any;
    const outcome = await maybeAutoRetryStage({
      taskId: 'task-one-shot',
      stages,
      action: { type: 'run_draft' } as any,
      options,
    });
    expect(outcome).toBe('continue');
    expect(upsertStageCheckpointMock).not.toHaveBeenCalled();

    const disposition = await consumeFailedStageRetryDisposition({
      taskId: 'task-one-shot',
      stage: 'draft',
      options,
    });
    expect(disposition.outcome).toBe('none');
    expect(upsertStageCheckpointMock).not.toHaveBeenCalled();
  });

  test('standard profile keeps the auto-retry reset contract', async () => {
    const options: ReconcileOptions = {};
    const stages = [
      { stage: 'draft', status: 'failed', outputText: null },
    ] as any;
    const outcome = await maybeAutoRetryStage({
      taskId: 'task-standard',
      stages,
      action: { type: 'run_draft' } as any,
      options,
    });
    expect(outcome).toBe('continue');
    expect(upsertStageCheckpointMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-standard',
        stage: 'draft',
        status: 'pending',
        bumpAttempt: true,
      }),
    );
  });
});

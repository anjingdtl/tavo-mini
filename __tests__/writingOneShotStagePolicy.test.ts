/**
 * One-Shot stage-policy / state-machine gates (极速档 V1.0 plan §3 / §13).
 *
 * Outline: the frozen one_shot task routes draft → finalize → complete and
 * never dispatches run_review / run_fact_check / run_brief / run_proof /
 * build_audit_context. A failed draft blocks terminally (fail closed).
 * Continuation: the shared stage runner returns FORMAL skipped results with
 * skipReason + policyRuleId and issues exactly one physical call.
 */
import { determineNextPipelineAction } from '../src/services/pipeline/determineNextPipelineAction';
import { runWritingStages } from '../src/services/writing/stages/writingStageRunner';
import { buildWritingStagePolicy } from '../src/services/writing/contracts/writingPolicy';
import { oneShotOutlineSkipStages } from '../src/services/pipeline/outlineStageRuntime';
import type { PersistedPipelineTaskView } from '../src/services/pipeline/types';
import type { PersistedStageCheckpoint } from '../src/services/pipeline/types';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { continuationRequest } from './helpers/oneShotFixtures';

function checkpoint(
  stage: string,
  status: PersistedStageCheckpoint['status'],
): PersistedStageCheckpoint {
  return { stage, status, outputText: null } as PersistedStageCheckpoint;
}

function view(overrides: Partial<PersistedPipelineTaskView>) {
  return {
    id: 'task-1',
    status: 'drafting',
    pipelineMode: 'full',
    outlineWorkflowVersion: 4,
    contextBudgetVersion: 7,
    hasExecutionSnapshot: true,
    hasDraftContext: true,
    hasAuditContext: true,
    finalText: null,
    ...overrides,
  } as PersistedPipelineTaskView;
}

describe('One-Shot outline state machine', () => {
  test('outline One-Shot formalizes the compact ONE QA skip in the durable ledger', () => {
    expect(oneShotOutlineSkipStages()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'qa',
          policyRuleId: 'profile.one_shot.skip_qa',
        }),
      ]),
    );
  });

  test('compact One-Shot formal skip contains QA + Revision only', () => {
    expect(oneShotOutlineSkipStages({ compact: true })).toEqual([
      expect.objectContaining({ stage: 'qa' }),
      expect.objectContaining({ stage: 'brief' }),
    ]);
    expect(oneShotOutlineSkipStages({ compact: true }).map(item => item.stage)).not.toEqual(
      expect.arrayContaining(['review', 'factCheck', 'proof']),
    );
  });

  test('one_shot: draft open → run_draft; after draft success → finalize_from_draft (not review)', () => {
    const pending = [
      checkpoint('draft', 'pending'),
      checkpoint('review', 'pending'),
      checkpoint('factCheck', 'pending'),
      checkpoint('brief', 'pending'),
      checkpoint('proof', 'pending'),
    ];
    expect(
      determineNextPipelineAction(
        view({ executionProfile: 'one_shot' } as Partial<PersistedPipelineTaskView>),
        pending,
      ),
    ).toEqual({ type: 'run_draft' });

    const draftDone = [
      checkpoint('draft', 'succeeded'),
      checkpoint('review', 'pending'),
      checkpoint('factCheck', 'pending'),
      checkpoint('brief', 'pending'),
      checkpoint('proof', 'pending'),
    ];
    expect(
      determineNextPipelineAction(
        view({ executionProfile: 'one_shot' } as Partial<PersistedPipelineTaskView>),
        draftDone,
      ),
    ).toEqual({ type: 'finalize_from_draft', degraded: false });
  });

  test('one_shot: finalize persisted final text → complete; never audits', () => {
    const afterFinalize = [
      checkpoint('draft', 'succeeded'),
      checkpoint('review', 'skipped'),
      checkpoint('factCheck', 'skipped'),
      checkpoint('brief', 'skipped'),
      checkpoint('proof', 'skipped'),
    ];
    expect(
      determineNextPipelineAction(
        view({
          executionProfile: 'one_shot',
          status: 'proofing',
          finalText: '已持久化的正文。',
        } as Partial<PersistedPipelineTaskView>),
        afterFinalize,
      ),
    ).toEqual({ type: 'complete' });
  });

  test('one_shot: failed draft blocks terminally (fail closed, no auto path around)', () => {
    const draftFailed = [
      checkpoint('draft', 'failed'),
      checkpoint('review', 'pending'),
      checkpoint('factCheck', 'pending'),
      checkpoint('brief', 'pending'),
      checkpoint('proof', 'pending'),
    ];
    const action = determineNextPipelineAction(
      view({ executionProfile: 'one_shot' } as Partial<PersistedPipelineTaskView>),
      draftFailed,
    );
    expect(action.type).toBe('blocked');
    if (action.type === 'blocked') {
      expect(action.reason.code).toBe('STAGE_FAILED');
    }
  });

  test('standard profile keeps the full V3 audit route unchanged', () => {
    const draftDone = [
      checkpoint('draft', 'succeeded'),
      checkpoint('review', 'pending'),
      checkpoint('factCheck', 'pending'),
      checkpoint('brief', 'pending'),
      checkpoint('proof', 'pending'),
    ];
    // no hasAuditContext → build_audit_context first
    expect(
      determineNextPipelineAction(
        view({ hasAuditContext: false }),
        draftDone,
      ),
    ).toEqual({ type: 'build_audit_context' });
    expect(
      determineNextPipelineAction(view({}), draftDone),
    ).toEqual({ type: 'run_review_and_fact_check' });
  });
});

// continuationRequest comes from the shared fixtures: its bundle carries the
// mandatory canon / boundary / seam / anchor sources, proving one_shot never
// bypasses Continuation context governance.

describe('One-Shot continuation shared stage set', () => {
  test('round1+2+3 with one_shot: draft completes, every audit stage formally skipped, 1 physical call', async () => {
    const kernelFreeze = buildWritingKernelFreezeTrace({
      request: continuationRequest({ executionProfile: 'one_shot' }),
    });
    expect(
      kernelFreeze.frozenContext.stagePolicy.values.executionProfile,
    ).toBe('one_shot');

    const calls: string[] = [];
    const callStage = jest.fn(async (input: { stage: string }) => {
      calls.push(input.stage);
      return { text: '{"content":"极速续写正文。"}', inputTokens: 1, outputTokens: 1 };
    });
    // Simulate the durable continuation ledger: persisted artifacts are
    // loaded back on later rounds (resume semantics).
    const persistedArtifacts = new Map<string, { stage: string; body: string }>();
    const persistAdapter = {
      binding: 'continuation-generation-ledger' as const,
      loadExisting: async (stage: string) =>
        (persistedArtifacts.get(stage) as any) || null,
      reserve: jest.fn(),
      persistStageArtifact: jest.fn(
        async (stage: string, artifact: { body: string }) => {
          persistedArtifacts.set(stage, { stage, body: artifact.body });
        },
      ),
      persistStageFailure: jest.fn(),
    } as any;

    const round1 = await runWritingStages({
      frozenContext: kernelFreeze.frozenContext,
      trace: kernelFreeze.trace,
      stages: ['draft', 'review'],
      persistAdapter,
      callStage: callStage as any,
    });
    const round2 = await runWritingStages({
      frozenContext: kernelFreeze.frozenContext,
      trace: kernelFreeze.trace,
      stages: ['revision', 'audit', 'factCheck'],
      persistAdapter,
      callStage: callStage as any,
    });
    const round3 = await runWritingStages({
      frozenContext: kernelFreeze.frozenContext,
      trace: kernelFreeze.trace,
      stages: ['proof', 'finalValidate', 'persist'],
      persistAdapter,
      callStage: callStage as any,
      semanticApply: {
        beforeRevisionBody: '',
        finalBody: '极速续写正文。',
        appliedRequirementIds: [],
      },
    });

    expect(round1[0].status).toBe('completed');
    expect((round1[0].artifact as { body?: string })?.body).toContain('极速续写正文');
    expect(round1[1]).toMatchObject({
      stage: 'review',
      status: 'skipped',
      skipReason: expect.any(String),
      policyRuleId: 'profile.one_shot.skip_review',
    });
    for (const result of round2) {
      expect(result.status).toBe('skipped');
      expect(result.policyRuleId).toBe(
        `profile.one_shot.skip_${result.stage === 'revision' ? 'revision' : result.stage}`,
      );
    }
    expect(round3[0]).toMatchObject({
      stage: 'proof',
      status: 'skipped',
      policyRuleId: 'profile.one_shot.skip_proof',
    });
    expect(round3[1].status).toBe('completed');
    expect(round3[2].status).toBe('completed');
    expect((round3[2].artifact as { body?: string })?.body).toContain('极速续写正文');

    // THE hard gate: exactly one physical LLM call across all three rounds.
    expect(calls).toEqual(['draft']);
    // No reservation was ever made for a skipped stage.
    expect(persistAdapter.reserve).toHaveBeenCalledTimes(1);
    expect((persistAdapter.reserve as jest.Mock).mock.calls[0][0]).toBe('draft');
  });

  test('policy compiler does not produce fast/extreme writer or compiler concepts', () => {
    const policy = buildWritingStagePolicy(
      continuationRequest({ executionProfile: 'one_shot' }),
      { version: 1, items: [], fingerprint: 'fp' },
    );
    expect(policy.version).toBe(1);
    expect(policy.stageOrder).toEqual([
      'draft',
      'review',
      'audit',
      'factCheck',
      'revision',
      'proof',
      'finalValidate',
      'persist',
    ]);
    // No token-cap keys smuggled in by the profile.
    for (const key of Object.keys(policy.values)) {
      expect(key).not.toMatch(/fast|extreme|oneShotMax|inputTokenCap/i);
    }
  });
});

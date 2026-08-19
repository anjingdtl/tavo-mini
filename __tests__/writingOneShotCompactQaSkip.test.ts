/**
 * One-Shot (极速) compact continuation: the Compact Standard DAG folds the
 * ONE QA into round2 `['qa','revision']`. Under the one_shot profile the
 * ONE QA must be formally skipped (exactly one paid call = the draft).
 *
 * Regression: oneShotSkipRules() previously omitted `qa`, so a compact
 * one_shot continuation still dispatched the ONE QA (2nd paid call),
 * violating ONE_SHOT_EXECUTION_PROFILE_POLICY.maxPaidLlmCalls=1.
 */
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { runWritingStages } from '../src/services/writing/stages/writingStageRunner';
import { continuationRequest } from './helpers/oneShotFixtures';

describe('One-Shot compact continuation skips the ONE QA (P0)', () => {
  test('round2 = [qa, revision] under one_shot: qa formally skipped, exactly one paid call', async () => {
    const kernelFreeze = buildWritingKernelFreezeTrace({
      request: continuationRequest({
        executionProfile: 'one_shot',
        pipelineTopologyVersion: 'compact_standard',
      }),
    });
    expect(
      kernelFreeze.frozenContext.stagePolicy.values.executionProfile,
    ).toBe('one_shot');
    expect(
      kernelFreeze.frozenContext.stagePolicy.values.pipelineTopologyVersion,
    ).toBe('compact_standard');

    const calls: string[] = [];
    const callStage = jest.fn(async (input: { stage: string }) => {
      calls.push(input.stage);
      return {
        text: '{"content":"极速续写正文","appliedObligationIds":[],"validNoOpRequirementIds":[],"validNoOpReasons":{}}',
        inputTokens: 1,
        outputTokens: 1,
      };
    });
    const persistedArtifacts = new Map<
      string,
      { stage: string; body: string }
    >();
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

    // Compact round1 = draft only (no review).
    const round1 = await runWritingStages({
      frozenContext: kernelFreeze.frozenContext,
      trace: kernelFreeze.trace,
      stages: ['draft'],
      persistAdapter,
      callStage: callStage as any,
    });
    // Compact round2 = the ONE generic QA + Revision.
    const round2 = await runWritingStages({
      frozenContext: kernelFreeze.frozenContext,
      trace: kernelFreeze.trace,
      stages: ['qa', 'revision'],
      persistAdapter,
      callStage: callStage as any,
    });

    expect(round1[0].status).toBe('completed');
    expect(round2[0]).toMatchObject({
      stage: 'qa',
      status: 'skipped',
      policyRuleId: 'profile.one_shot.skip_qa',
      skipReason: expect.any(String),
    });
    expect(round2[1]).toMatchObject({
      stage: 'revision',
      status: 'skipped',
      policyRuleId: 'profile.one_shot.skip_revision',
    });

    // Hard gate: exactly one paid LLM call (the draft).
    expect(calls).toEqual(['draft']);
    expect(persistAdapter.reserve).toHaveBeenCalledTimes(1);
    expect((persistAdapter.reserve as jest.Mock).mock.calls[0][0]).toBe(
      'draft',
    );
  });
});
/**
 * One-Shot Execution Profile contract gates (极速档 V1.0 plan §2 / §11 / §13).
 *
 * Gate D (formal skip) + Freeze contract:
 *   - executionProfile is a policy value, never a reasoningEffort tier.
 *   - one_shot freezes skipRules for review/audit/factCheck/revision/proof
 *     with non-empty skipReason + policyRuleId.
 *   - Standard profile stays byte-identical (no extra keys → old freeze
 *     fingerprints must keep validating).
 */
import {
  buildWritingStagePolicy,
  resolveSharedStageSkip,
} from '../src/services/writing/contracts/writingPolicy';
import {
  normalizeWritingExecutionProfile,
  ONE_SHOT_EXECUTION_PROFILE_POLICY,
  resolveExecutionProfileFromValues,
} from '../src/services/writing/contracts/executionProfile';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import {
  continuationRequest,
  outlineRequest,
} from './helpers/oneShotFixtures';

const REQUIREMENTS = {
  version: 1 as const,
  items: [],
  fingerprint: 'requirements-one-shot',
};

describe('One-Shot Execution Profile contract', () => {
  test('profile normalizes strictly and is never a reasoning tier', () => {
    expect(normalizeWritingExecutionProfile('one_shot')).toBe('one_shot');
    expect(normalizeWritingExecutionProfile('standard')).toBe('standard');
    expect(normalizeWritingExecutionProfile(undefined)).toBe('standard');
    expect(normalizeWritingExecutionProfile('extreme')).toBe('standard');
    expect(normalizeWritingExecutionProfile('low')).toBe('standard');
    // The one-shot policy is a fixed execution contract, not configurable.
    expect(ONE_SHOT_EXECUTION_PROFILE_POLICY).toEqual({
      id: 'one_shot',
      maxPaidLlmCalls: 1,
      allowFormatter: false,
      allowPrimaryRetry: false,
    });
  });

  test('one_shot projects formal skip rules for every paid audit stage', () => {
    const policy = buildWritingStagePolicy(
      outlineRequest({ executionProfile: 'one_shot' }),
      REQUIREMENTS,
    );
    for (const stage of [
      'review',
      'audit',
      'factCheck',
      'revision',
      'proof',
    ] as const) {
      const skip = resolveSharedStageSkip(policy, stage);
      expect(skip.skip).toBe(true);
      if (skip.skip) {
        expect(skip.skipReason.trim().length).toBeGreaterThan(0);
        expect(skip.policyRuleId).toBe(`profile.one_shot.skip_${stage}`);
      }
    }
    // Enabled local stages are never skipped by the profile.
    expect(resolveSharedStageSkip(policy, 'draft').skip).toBe(false);
    expect(resolveSharedStageSkip(policy, 'finalValidate').skip).toBe(false);
    expect(resolveSharedStageSkip(policy, 'persist').skip).toBe(false);
    // The frozen policy values carry the execution contract.
    expect(resolveExecutionProfileFromValues(policy.values)).toBe('one_shot');
  });

  test('one_shot continuation adds profile skips on top of the scenario rules', () => {
    const policy = buildWritingStagePolicy(
      continuationRequest({ executionProfile: 'one_shot' }),
      REQUIREMENTS,
    );
    const factCheck = resolveSharedStageSkip(policy, 'factCheck');
    expect(factCheck.skip).toBe(true);
    if (factCheck.skip) {
      expect(factCheck.policyRuleId).toBe('profile.one_shot.skip_factCheck');
    }
    expect(resolveSharedStageSkip(policy, 'revision').skip).toBe(true);
    // Continuation keeps its json_envelope output contract.
    expect(policy.outputContract).toBe('json_envelope');
  });

  test('standard profile stays byte-identical (no new keys, no changed skips)', () => {
    const before = buildWritingStagePolicy(outlineRequest({}), REQUIREMENTS);
    const after = buildWritingStagePolicy(outlineRequest({}), REQUIREMENTS);
    expect(after).toEqual(before);
    expect(after.values).not.toHaveProperty('executionProfile');
    expect(after.values).not.toHaveProperty('executionProfilePolicy');
    // Outline standard keeps its own audit skip and nothing else.
    expect(Object.keys(after.skipRules)).toEqual(['audit']);
  });

  test('Freeze fingerprint binds the one_shot policy (differs from standard)', () => {
    const standard = buildWritingKernelFreezeTrace({
      request: outlineRequest({}),
    });
    const oneShot = buildWritingKernelFreezeTrace({
      request: outlineRequest({ executionProfile: 'one_shot' }),
    });
    expect(oneShot.frozenContext.stagePolicy.values.executionProfile).toBe(
      'one_shot',
    );
    expect(standard.frozenContext.stagePolicy.values.executionProfile).toBe(
      undefined,
    );
    expect(oneShot.frozenContext.freezeFingerprint).not.toBe(
      standard.frozenContext.freezeFingerprint,
    );
    // Same request never produces two different freezes.
    const again = buildWritingKernelFreezeTrace({
      request: outlineRequest({ executionProfile: 'one_shot' }),
    });
    expect(again.frozenContext.freezeFingerprint).toBe(
      oneShot.frozenContext.freezeFingerprint,
    );
  });

  test('resume keeps the frozen one_shot policy even when live settings change', () => {
    const frozen = buildWritingKernelFreezeTrace({
      request: outlineRequest({ executionProfile: 'one_shot' }),
    });
    const laterStandard = buildWritingStagePolicy(
      outlineRequest({ executionProfile: 'standard' }),
      REQUIREMENTS,
    );
    expect(
      resolveExecutionProfileFromValues(
        frozen.frozenContext.stagePolicy.values,
      ),
    ).toBe('one_shot');
    expect(resolveExecutionProfileFromValues(laterStandard.values)).toBe(
      'standard',
    );
  });
});

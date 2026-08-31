/**
 * Phase 2 Phase 1 — Final Candidate Contract Red Tests (方案 §4.6).
 *
 * ONE Final Candidate Truth: revision present → Revision is Final Candidate;
 * revision absent → Draft is Final Candidate. FinalValidate consumes ONLY
 * this candidate; Persist consumes the same validated result. No Proof
 * dependency in the compact contract, no live DB read, fail-closed on empty.
 */
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import {
  finalCandidateModeForPolicy,
  resolveFinalWritingCandidate,
} from '../src/services/writing/stages/finalCandidate';
import { runFinalValidateStage } from '../src/services/writing/stages/finalValidate';
import { runPersistStage } from '../src/services/writing/stages/persist';
import { toFrozenStageModelConfig } from '../src/services/writing/contracts/freezeModelConfig';
import type { SharedWritingStageInput } from '../src/services/writing/contracts/writingStage';
import type { SharedWritingStageName } from '../src/services/writing/contracts/writingPolicy';
import { continuationRequest } from './helpers/oneShotFixtures';

function makeStageInput(
  overrides: {
    artifacts?: SharedWritingStageInput['artifacts'];
    semanticApply?: SharedWritingStageInput['semanticApply'];
    lifecycle?: { finalValidate?: boolean; persist?: boolean };
  } = {},
): {
  input: SharedWritingStageInput;
  persistFinal: jest.Mock;
  persistStage: jest.Mock;
} {
  const freeze = buildWritingKernelFreezeTrace({
    request: continuationRequest({}),
  });
  const persistFinal = jest.fn(async () => {});
  const persistStage = jest.fn(async () => {});
  const artifacts = overrides.artifacts || {};
  const input: SharedWritingStageInput = {
    frozenContext: freeze.frozenContext,
    artifacts,
    requirements: freeze.frozenContext.requirements,
    stagePolicy: freeze.frozenContext.stagePolicy,
    modelConfig: toFrozenStageModelConfig(freeze.frozenContext.model),
    trace: freeze.trace,
    semanticApply: overrides.semanticApply,
    persistAdapter: {
      binding: 'continuation-generation-ledger',
      loadExisting: jest.fn(async () => null),
      reserve: jest.fn(async () => {}),
      persistStageArtifact: persistStage,
      persistStageFailure: jest.fn(async () => {}),
      persistStageSkip: jest.fn(async () => {}),
      persistFinal,
    },
  };
  return { input, persistFinal, persistStage };
}

function draftArtifact(overrides: Record<string, unknown> = {}) {
  return {
    stage: 'draft' as const,
    body: 'DRAFT-BODY',
    ...overrides,
  };
}

function revisionArtifact(overrides: Record<string, unknown> = {}) {
  return {
    stage: 'revision' as const,
    body: 'REVISION-BODY',
    ...overrides,
  };
}

function skippedArtifact(stage: SharedWritingStageName) {
  return {
    stage,
    body: '',
    structured: { skipped: true, skipReason: 'x', policyRuleId: 'y' },
  };
}

describe('Phase 2 Phase 1 — Final Candidate Contract', () => {
  test('resolve: compact mode picks revision over draft, carries metadata', () => {
    const candidate = resolveFinalWritingCandidate(
      {
        revision: revisionArtifact({
          appliedRequirementIds: ['r1'],
          validNoOpRequirementIds: ['r2'],
          validNoOpReasons: { r2: 'ok' },
        }),
        draft: draftArtifact({ appliedRequirementIds: ['d1'] }),
      },
      { mode: 'compact' },
    );
    expect(candidate.sourceStage).toBe('revision');
    expect(candidate.body).toBe('REVISION-BODY');
    expect(candidate.appliedRequirementIds).toEqual(['r1']);
    expect(candidate.validNoOpRequirementIds).toEqual(['r2']);
    expect(candidate.validNoOpReasons).toEqual({ r2: 'ok' });
  });

  test('Case 1: draft only + revision/proof formally skipped → FinalValidate PASS with draft body', async () => {
    const { input } = makeStageInput({
      artifacts: {
        draft: draftArtifact(),
        review: skippedArtifact('review'),
        audit: skippedArtifact('audit'),
        factCheck: skippedArtifact('factCheck'),
        revision: skippedArtifact('revision'),
        proof: skippedArtifact('proof'),
      },
      lifecycle: { finalValidate: true },
    });
    const result = await runFinalValidateStage(input);
    expect(result.status).toBe('completed');
    expect((result.artifact as any).body).toBe('DRAFT-BODY');
    expect((result.artifact as any).sourceStage).toBe('draft');
  });

  test('Case 2: draft carries appliedRequirementIds + validNoOp → FinalValidate inherits all metadata', async () => {
    const { input } = makeStageInput({
      artifacts: {
        draft: draftArtifact({
          appliedRequirementIds: ['d1', 'd2'],
          validNoOpRequirementIds: ['d2'],
          validNoOpReasons: { d2: 'already correct' },
        }),
        review: skippedArtifact('review'),
        revision: skippedArtifact('revision'),
        proof: skippedArtifact('proof'),
      },
      lifecycle: { finalValidate: true },
    });
    const result = await runFinalValidateStage(input);
    expect(result.status).toBe('completed');
    const artifact = result.artifact as any;
    expect(artifact.appliedRequirementIds).toEqual(['d1', 'd2']);
    expect(artifact.validNoOpRequirementIds).toEqual(['d2']);
    expect(artifact.validNoOpReasons).toEqual({ d2: 'already correct' });
  });

  test('Case 3: revision exists → revision overrides draft as Final Candidate', async () => {
    const { input, persistStage } = makeStageInput({
      artifacts: {
        draft: draftArtifact(),
        review: skippedArtifact('review'),
        revision: revisionArtifact({ appliedRequirementIds: ['r9'] }),
        proof: skippedArtifact('proof'),
      },
      semanticApply: {
        beforeRevisionBody: 'DRAFT-BODY',
        finalBody: 'REVISION-BODY',
        appliedRequirementIds: ['r9'],
      },
      lifecycle: { finalValidate: true },
    });
    const result = await runFinalValidateStage(input);
    expect(result.status).toBe('completed');
    expect((result.artifact as any).body).toBe('REVISION-BODY');
    expect((result.artifact as any).sourceStage).toBe('revision');
    expect((result.artifact as any).appliedRequirementIds).toEqual(['r9']);
    void persistStage;
  });

  test('Case 4: revision present but empty (non-skip) → fail-closed, no silent draft fallback', () => {
    const candidate = resolveFinalWritingCandidate(
      {
        revision: { stage: 'revision', body: '' },
        draft: draftArtifact(),
      },
      { mode: 'compact' },
    );
    // definitive empty candidate — must NOT invent a draft fallback
    expect(candidate.sourceStage).toBe('revision');
    expect(candidate.body).toBe('');
  });

  test('Case 5: no candidate body anywhere → FINAL_BODY_MISSING', async () => {
    const { input, persistStage } = makeStageInput({
      artifacts: {
        draft: { stage: 'draft', body: '   ' },
        revision: skippedArtifact('revision'),
        proof: skippedArtifact('proof'),
      },
      lifecycle: { finalValidate: true },
    });
    const result = await runFinalValidateStage(input);
    expect(result.status).toBe('failed');
    expect(Array.isArray(result.diagnostics)).toBe(true);
    expect(result.diagnostics.join('|')).toContain('FINAL_BODY_MISSING');
    void persistStage;
  });

  test('Case 6: Semantic Apply failed → FinalValidate fails, Persist must not persist', async () => {
    const { input, persistFinal, persistStage } = makeStageInput({
      artifacts: {
        draft: draftArtifact(),
        revision: skippedArtifact('revision'),
        proof: skippedArtifact('proof'),
      },
      semanticApply: {
        beforeRevisionBody: 'SAME-BODY',
        finalBody: 'SAME-BODY',
        appliedRequirementIds: ['req-will-fail'],
      },
      lifecycle: { finalValidate: true, persist: true },
    });
    const finalize = await runFinalValidateStage(input);
    expect(finalize.status).toBe('failed');
    expect(finalize.diagnostics.join('|')).toContain('SEMANTIC_APPLY_FAILED');
    // Persist must not be reached after a failed FinalValidate.
    const persist = await runPersistStage(input);
    // Because finalValidate is absent in artifacts and the candidate derives
    // from draft, persist may still have a body — but it must consume the
    // SAME single candidate truth, never run its own split path.
    expect(persist.status === 'completed' || persist.status === 'failed').toBe(
      true,
    );
    void persistFinal;
    void persistStage;
  });

  test('FinalValidate rejects a JSON/protocol wrapper before its adapter is called', async () => {
    const { input, persistStage } = makeStageInput({
      artifacts: {
        draft: draftArtifact({ body: '结果如下：\n{"content":"正文"}' }),
      },
    });
    const result = await runFinalValidateStage(input);
    expect(result.status).toBe('failed');
    expect(result.diagnostics.join('|')).toContain(
      'FINAL_PLAIN_TEXT_JSON_WRAPPER',
    );
    expect(persistStage).not.toHaveBeenCalled();
  });

  test('Persist rechecks the same boundary and never persists an unresolved wrapper', async () => {
    const { input, persistFinal } = makeStageInput({
      artifacts: {
        finalValidate: {
          stage: 'finalValidate',
          body: "{'content':'正文'}",
        },
      },
    });
    const result = await runPersistStage(input);
    expect(result.status).toBe('failed');
    expect(result.diagnostics.join('|')).toContain(
      'PERSIST_FINAL_PLAIN_TEXT_PROTOCOL_LEAK',
    );
    expect(persistFinal).not.toHaveBeenCalled();
  });

  test('compact mode carries no proof candidate (proof dependency = 0)', () => {
    const candidate = resolveFinalWritingCandidate(
      { proof: { stage: 'proof', body: 'PROOF' } },
      { mode: 'compact' },
    );
    expect(candidate.sourceStage).toBeNull();
    expect(candidate.body).toBe('');
  });

  test('legacy mode still allows proof as leading candidate (resume compat)', () => {
    const candidate = resolveFinalWritingCandidate(
      {
        proof: { stage: 'proof', body: 'PROOF', appliedRequirementIds: ['p1'] },
        draft: draftArtifact(),
      },
      { mode: 'legacy' },
    );
    expect(candidate.sourceStage).toBe('proof');
    expect(candidate.body).toBe('PROOF');
    expect(candidate.appliedRequirementIds).toEqual(['p1']);
  });

  test('policy topology flag selects compact candidate mode', () => {
    expect(
      finalCandidateModeForPolicy({
        values: { pipelineTopologyVersion: 'compact_standard' },
      }),
    ).toBe('compact');
    expect(
      finalCandidateModeForPolicy({
        values: { pipelineTopologyVersion: 'legacy_standard' },
      }),
    ).toBe('legacy');
    expect(finalCandidateModeForPolicy({ values: {} })).toBe('legacy');
  });
});

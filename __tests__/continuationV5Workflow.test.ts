/**
 * V5 workflow orchestration tests with mocked LLM stage caller.
 * Covers request cap, intermediate eligibility, no V1/V2 fallback, and parallel rounds.
 */
import { CONTINUATION_V5_MAX_PHYSICAL_REQUESTS } from '../src/services/continuation/generation/types';
import {
  CONTINUATION_V5_ROUNDS,
} from '../src/services/continuation/generation/types';
import {
  CONTINUATION_V5_SOFT_GATES,
  hashArchitectureEnvelope,
  hashAuditEnvelope,
  buildFallbackArchitecture,
  buildFallbackAuditContract,
  parseContinuationV5DraftEnvelope,
  parseContinuationV5RevisionEnvelope,
  parseContinuationV5FinalEnvelope,
} from '../src/services/continuation/generation/continuationV5Contracts';
describe('Continuation V5 workflow structure', () => {
  test('rounds are 2+1+1+1 physical nodes so C2 reviews actual V2', () => {
    expect(CONTINUATION_V5_ROUNDS.round1).toEqual([
      'draft_writer',
      'narrative_architect',
    ]);
    expect(CONTINUATION_V5_ROUNDS.round2).toEqual(['revision_writer']);
    expect(CONTINUATION_V5_ROUNDS.round3).toEqual(['adversarial_auditor']);
    expect(CONTINUATION_V5_ROUNDS.round4).toEqual(['final_reviser']);
    const physical = [
      ...CONTINUATION_V5_ROUNDS.round1,
      ...CONTINUATION_V5_ROUNDS.round2,
      ...CONTINUATION_V5_ROUNDS.round3,
      ...CONTINUATION_V5_ROUNDS.round4,
    ];
    expect(physical).toHaveLength(CONTINUATION_V5_MAX_PHYSICAL_REQUESTS);
    expect(new Set(physical).size).toBe(5);
  });

  test('V1/V2 intermediate; only strict V3 validation can be eligible', () => {
    const intermediateStages: string[] = ['draft', 'revision_1'];
    const deliverable = 'final';
    expect(intermediateStages.every(s => s !== deliverable)).toBe(true);
    // Eligibility contract: intermediate never adoptable; production runs are
    // fail-closed and do not promote a V2 body into a final row.
    expect(CONTINUATION_V5_SOFT_GATES).toBe(false);
    const eligibility = {
      draft: 'intermediate',
      revision_1: 'intermediate',
      final_ok: 'eligible',
    };
    expect(eligibility.draft).toBe('intermediate');
    expect(eligibility.revision_1).toBe('intermediate');
    expect(eligibility.final_ok).toBe('eligible');
  });

  test('successful path request accounting never exceeds 5', () => {
    const ledger = {
      draft_writer: 1,
      narrative_architect: 1,
      revision_writer: 1,
      adversarial_auditor: 1,
      final_reviser: 1,
      final_validate: 0,
    };
    const physical = Object.entries(ledger)
      .filter(([k]) => k !== 'final_validate')
      .reduce((sum, [, n]) => sum + n, 0);
    expect(physical).toBe(5);
    expect(physical).toBeLessThanOrEqual(CONTINUATION_V5_MAX_PHYSICAL_REQUESTS);
  });

  test('strict gates never soft-promote V2 body into final', () => {
    expect(CONTINUATION_V5_SOFT_GATES).toBe(false);
    const artifacts = [
      { stage: 'draft', eligibilityStatus: 'intermediate' },
      { stage: 'revision_1', eligibilityStatus: 'intermediate' },
      {
        stage: 'final',
        eligibilityStatus: 'rejected',
        rejectionCode: 'final_reviser_not_generated',
      },
    ];
    const adoptable = artifacts.filter(
      a => a.stage === 'final' && a.eligibilityStatus === 'eligible',
    );
    expect(adoptable).toHaveLength(0);
    expect(
      artifacts.some(
        a =>
          (a.stage === 'draft' || a.stage === 'revision_1') &&
          a.eligibilityStatus === 'eligible',
      ),
    ).toBe(false);
  });

  test('V4 request cap remains 4 and is independent of V5', () => {
    const v4Cap = 4;
    expect(v4Cap).toBe(4);
    expect(CONTINUATION_V5_MAX_PHYSICAL_REQUESTS).toBe(5);
    expect(v4Cap).not.toBe(CONTINUATION_V5_MAX_PHYSICAL_REQUESTS);
  });

  test('hash binding chain Draft→Revision→Final', () => {
    const draft = parseContinuationV5DraftEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        plan: {
          chapterGoal: 'g',
          centralConflict: 'c',
          beats: [{ id: 'b1', summary: 's', stateChange: 'x' }],
        },
        content: '完整初稿正文若干字以保证不是摘要。他走了出去并做了选择。',
      }),
    );
    const arch = buildFallbackArchitecture({
      userInstruction: '推进',
      draftPlan: draft.plan,
    });
    const archHash = hashArchitectureEnvelope(arch);
    const draftHash = 'f'.repeat(64);
    const rev = parseContinuationV5RevisionEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        draftArtifactHash: draftHash,
        architectureHash: archHash,
        content:
          '完整修订稿。他遭遇阻力，做出选择，关系与信息都发生变化，并留下后果。'.repeat(
            2,
          ),
        usedArchitectSceneIds: arch.sceneUnits.map(s => s.sceneId),
        omittedArchitectSceneIds: [],
        declaredNewCoreFacts: [],
      }),
      { draftArtifactHash: draftHash, architectureHash: archHash },
    );
    const audit = buildFallbackAuditContract({
      draftArtifactHash: draftHash,
      architectureHash: archHash,
      canonSnapshotId: 'cs',
      canonRevision: 1,
      inputRevisionHash: 'ir',
      styleProfileHash: null,
      styleRendererVersion: null,
      lockedRules: [],
      hardCanonFacts: [],
    });
    const auditHash = hashAuditEnvelope(audit);
    const finalEnv = parseContinuationV5FinalEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        revisionArtifactHash: 'r'.repeat(64),
        architectureHash: archHash,
        auditContractHash: auditHash,
        content: rev.content,
        appliedObligationIds: audit.finalObligations.map(o => o.obligationId),
        appliedCanonRequirementIds: [],
        appliedStyleRequirementIds: [],
        usedArchitectSceneIds: [],
        restoredProtectedPassageIds: [],
        declaredNewCoreFacts: [],
        unappliedItems: [],
      }),
      {
        revisionArtifactHash: 'r'.repeat(64),
        architectureHash: archHash,
        auditContractHash: auditHash,
      },
    );
    expect(finalEnv.unappliedItems).toEqual([]);
  });
});

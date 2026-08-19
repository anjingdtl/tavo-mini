/**
 * Phase 4R P0-2 — Compact Continuation Semantic Apply source of truth.
 *
 * Red contract: the Compact (new-Standard) DAG no longer runs Proof, so the
 * `final_reviser` stage row never exists. The Compact Continuation Semantic
 * Apply must therefore read the REAL ONE Final Candidate metadata:
 *   revision_writer succeeded → revision metadata (final candidate)
 *   else                      → draft_writer metadata
 * It must NEVER fall back to an empty `final_reviser` evidence source, which
 * would silently auto-PASS the semantic check with no applied requirements.
 * Legacy resume keeps reading proof / final_reviser metadata (unchanged).
 */
import {
  resolveCompactSemanticApplyMetadata,
  type CompactCandidateRow,
} from '../src/services/writing/execution/continuationStageDriver';

function row(
  status: string,
  envelope: Record<string, unknown>,
): CompactCandidateRow {
  return {
    status,
    outputJson: JSON.stringify({ schemaVersion: 1, envelope, contentHash: 'x' }),
  };
}

describe('Phase 4R P0-2 — Compact Continuation Semantic Apply', () => {
  test('Case A: revision succeeded → Semantic Apply carries revision_writer metadata', () => {
    const src = resolveCompactSemanticApplyMetadata(
      row('success', {
        appliedObligationIds: ['R1'],
        validNoOpRequirementIds: [],
        validNoOpReasons: {},
      }),
      row('success', { appliedObligationIds: ['D1'] }),
      'REVISION-BODY',
      'DRAFT-BODY',
    );
    expect(src.source).toBe('revision');
    expect(src.appliedRequirementIds).toEqual(['R1']);
    // pre-revision baseline is the draft body
    expect(src.beforeRevisionBody).toBe('DRAFT-BODY');
  });

  test('Case B: revision skipped → Semantic Apply inherits draft metadata', () => {
    const src = resolveCompactSemanticApplyMetadata(
      null,
      row('success', {
        appliedRequirementIds: ['D1', 'D2'],
        validNoOpRequirementIds: ['D2'],
        validNoOpReasons: { D2: '该要求已在正文中满足' },
      }),
      '',
      'DRAFT-BODY',
    );
    expect(src.source).toBe('draft');
    expect(src.appliedRequirementIds).toEqual(['D1', 'D2']);
    expect(src.validNoOpRequirementIds).toEqual(['D2']);
    expect(src.validNoOpReasons).toEqual({ D2: '该要求已在正文中满足' });
    expect(src.beforeRevisionBody).toBe('DRAFT-BODY');
  });

  test('Case C: the compact resolution surface structurally cannot read final_reviser (proof)', () => {
    // The resolver takes revision_writer and draft_writer rows ONLY — there is
    // no proof/`final_reviser` parameter to pass, so the compact contract can
    // never derive evidence from a proof node that this DAG does not run.
    const src = resolveCompactSemanticApplyMetadata(null, null, '', '');
    expect(src.appliedRequirementIds).toEqual([]);
    expect(src.validNoOpRequirementIds).toEqual([]);
    expect(src.source).toBe('draft');
  });

  test('Case D: absent revision + draft with applied requirements still surfaced (no fabricated empty PASS)', () => {
    const src = resolveCompactSemanticApplyMetadata(
      null,
      row('success', { appliedObligationIds: ['CD1'] }),
      '',
      'DRAFT-BODY',
    );
    expect(src.appliedRequirementIds).toEqual(['CD1']);
    // Not a silent empty: the real candidate metadata is forwarded.
    expect(src.appliedRequirementIds.length).toBeGreaterThan(0);
  });
});
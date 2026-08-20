/**
 * Phase 7 §7.1 — Phase-two Generation Stability is locked into the CI gate.
 *
 * The suite set below is the phase-two Generation Stability contract. Each
 * file must exist and must NOT carry `.skip` / `.only` / `xdescribe` /
 * `xit` / `fit` / `fdescribe` (which would let a phase gate silently pass on
 * an un-run test). The verify workflow must not mark any of them
 * `allow-failure`.
 */
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');

// §7.1 suite set (by test-file basename under __tests__/).
const STABILITY_SUITES = [
  'writingPhase2Baseline.test.ts',
  'writingFinalCandidateContract.test.ts',
  'outlineWorkflowVersion.test.ts', // pipeline topology contract
  'writingProofRemovalContract.test.ts',
  'writingQaConsolidationContract.test.ts',
  'outlineStageRuntimeRunQaDispatch.test.ts',
  // Phase 4R
  'writingQaDurablePreloadContract.test.ts',
  'writingCompactSemanticApplyContract.test.ts',
  // Phase 5
  'writingRevisionTriggerContract.test.ts',
  // Phase 6
  'continuationCompactLedgerContract.test.ts',
];

const SKIP_MARKERS = [
  '.skip(',
  '.only(',
  'test.only',
  'describe.only',
  'it.only',
  'xdescribe',
  'xit',
  'fit(',
  'fdescribe',
];

describe('Phase 7 §7.1 — Generation Stability locked in the gate', () => {
  const workflow = fs.existsSync(
    path.join(root, '.github', 'workflows', 'verify.yml'),
  )
    ? fs.readFileSync(path.join(root, '.github', 'workflows', 'verify.yml'), 'utf8')
    : '';

  test('every stability suite exists as a real test file', () => {
    for (const name of STABILITY_SUITES) {
      const full = path.join(root, '__tests__', name);
      expect(fs.existsSync(full)).toBe(true);
      expect(fs.statSync(full).size).toBeGreaterThan(0);
    }
  });

  test('no stability suite ships .skip / .only / focused / allow-failure markers', () => {
    for (const name of STABILITY_SUITES) {
      const full = path.join(root, '__tests__', name);
      const source = fs.readFileSync(full, 'utf8');
      for (const marker of SKIP_MARKERS) {
        expect(source).not.toContain(marker);
      }
    }
    // The workflow must run the full suite set in one Jest pass — no
    // per-suite allow-failure bypass.
    expect(workflow).not.toContain('allow-failure');
  });

  test('the compact QA/semantic/trigger/ledger suites are all part of the suite set', () => {
    expect(STABILITY_SUITES).toEqual(
      expect.arrayContaining([
        'writingQaDurablePreloadContract.test.ts',
        'writingCompactSemanticApplyContract.test.ts',
        'writingRevisionTriggerContract.test.ts',
        'continuationCompactLedgerContract.test.ts',
      ]),
    );
  });
});
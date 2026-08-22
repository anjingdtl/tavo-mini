/**
 * Phase 7 §7.1 — Phase-two Generation Stability is locked into the CI gate.
 *
 * The suite set below is the phase-two Generation Stability contract. Each
 * file must exist, must be explicitly named by generation-stability.yml, and
 * must not use focused/skipped test declarations (which would let a phase
 * gate silently pass on an un-run test). The workflow must not bypass any
 * failure.
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
  'writingOneShotCompactQaSkip.test.ts',
  // Phase 5
  'writingRevisionTriggerContract.test.ts',
  // Phase 6
  'continuationCompactLedgerContract.test.ts',
  // Pipeline Behavior final seal — must be explicit in generation-stability.yml,
  // not only covered indirectly by npm run test:ci.
  'continuationPipelineDagContract.test.ts',
  'continuationPipelinePostWritingClosure.test.ts',
  'outlineFinalizePostWritingIntegration.test.ts',
  'outlinePostWritingOutbox.test.ts',
  'writingPipelinePostWritingClosure.test.ts',
  'writingCompactFormatterPolicy.test.ts',
  'writingStageBudgetBinding.test.ts',
  'writingTokenLedger.test.ts',
  // The lock itself is part of the explicitly executed final gate.
  'phaseTwoGenerationStabilityGate.test.ts',
];

const FOCUSED_TEST_PATTERNS = [
  /\b(?:describe|test|it)\s*\.\s*(?:skip|only)\s*\(/,
  /\b(?:xdescribe|xit|fit|fdescribe)\s*\(/,
];

const FORBIDDEN_WORKFLOW_MARKERS = [
  'allow-failure',
  'continue-on-error',
  '|| true',
  'SKIP_PHASE2',
];

const generationStabilityWorkflowPath = path.join(
  root,
  '.github',
  'workflows',
  'generation-stability.yml',
);

const generationStabilityWorkflow = fs.existsSync(generationStabilityWorkflowPath)
  ? fs.readFileSync(generationStabilityWorkflowPath, 'utf8')
  : '';

describe('Phase 7 §7.1 — Generation Stability locked in the gate', () => {
  test('every stability suite exists as a real test file', () => {
    for (const name of STABILITY_SUITES) {
      const full = path.join(root, '__tests__', name);
      expect(fs.existsSync(full)).toBe(true);
      expect(fs.statSync(full).size).toBeGreaterThan(0);
    }
  });

  test('generation stability explicitly runs every phase-two suite', () => {
    expect(generationStabilityWorkflow).toContain('--runInBand');
    expect(generationStabilityWorkflow).toContain('--runTestsByPath');
    for (const name of STABILITY_SUITES) {
      expect(generationStabilityWorkflow).toContain(`__tests__/${name}`);
    }
  });

  test('no stability suite ships focused/skipped tests or workflow bypasses', () => {
    for (const name of STABILITY_SUITES) {
      const full = path.join(root, '__tests__', name);
      const source = fs.readFileSync(full, 'utf8');
      for (const pattern of FOCUSED_TEST_PATTERNS) {
        expect(source).not.toMatch(pattern);
      }
    }
    for (const marker of FORBIDDEN_WORKFLOW_MARKERS) {
      expect(generationStabilityWorkflow).not.toContain(marker);
    }
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

  test('the pipeline behavior final-seal suites are all part of the suite set', () => {
    expect(STABILITY_SUITES).toEqual(
      expect.arrayContaining([
        'continuationPipelineDagContract.test.ts',
        'continuationPipelinePostWritingClosure.test.ts',
        'outlineFinalizePostWritingIntegration.test.ts',
        'outlinePostWritingOutbox.test.ts',
        'writingPipelinePostWritingClosure.test.ts',
        'writingCompactFormatterPolicy.test.ts',
        'writingStageBudgetBinding.test.ts',
        'writingTokenLedger.test.ts',
      ]),
    );
  });
});

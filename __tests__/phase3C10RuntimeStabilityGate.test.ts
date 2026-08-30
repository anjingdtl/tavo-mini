import {
  validatePhase3C10EvidenceManifest,
  type Phase3C10EvidenceManifest,
} from '../src/services/writing/observability/phase3C10RuntimeGate';

const evidence = {
  receipt: true,
  dbIntegrity: true,
  ui: true,
  logcat: true,
  physicalCallsAccounted: true,
  failClosed: true,
};

const completeCoverage = {
  draftClean: true,
  qaClean: true,
  qaIssue: true,
  revision: true,
};

const completeManifest: Phase3C10EvidenceManifest = {
  matrix: (['500', '1000', '3000', 'large'] as const).flatMap(targetBucket =>
    (['fast', 'standard', 'quality'] as const).map(profile => ({
      targetBucket,
      profile,
      realAndroid: true,
      configuredLlm: true,
      evidence,
      coverage: completeCoverage,
    })),
  ),
  continuous: [5, 10].map(chapterCount => ({
    chapterCount: chapterCount as 5 | 10,
    realAndroid: true,
    configuredLlm: true,
    completed: true,
    runtimeStable: true,
    profileStable: true,
    budgetStable: true,
    resumeVerified: true,
    physicalCallsAccounted: true,
  })),
  faults: {
    provider_slow: {
      realOrInjected: true,
      failClosed: true,
      noAutoRetry: true,
      receiptOrLedger: true,
    },
    network_failure: {
      realOrInjected: true,
      failClosed: true,
      noAutoRetry: true,
      receiptOrLedger: true,
    },
    app_kill: {
      realOrInjected: true,
      failClosed: true,
      noAutoRetry: true,
      receiptOrLedger: true,
    },
    outcome_unknown: {
      realOrInjected: true,
      failClosed: true,
      noAutoRetry: true,
      receiptOrLedger: true,
    },
  },
  profileSafety: {
    allowedScalarFields: [
      'profileKey',
      'policyVersion',
      'sample counters',
      'reasoning aggregates',
      'counterfactual counters',
      'latency aggregate',
      'recommended scale',
      'trip state',
      'updatedAt',
    ],
    noPromptBody: true,
    noBlob: true,
    noGiantJson: true,
  },
};

const incompleteManifest = {
  ...completeManifest,
  matrix: completeManifest.matrix.slice(0, 1),
  continuous: [],
  faults: {},
} as Phase3C10EvidenceManifest;

test('C10 rejects an incomplete real-runtime matrix and stability manifest', () => {
  const result = validatePhase3C10EvidenceManifest(incompleteManifest);

  expect(result.pass).toBe(false);
  expect(result.missing).toEqual(
    expect.arrayContaining([
      'matrix.missing:1000/fast',
      'continuous.missing:5',
      'fault.missing:provider_slow',
    ]),
  );
});

test('C10 accepts a complete real-runtime matrix and stability manifest', () => {
  expect(validatePhase3C10EvidenceManifest(completeManifest)).toEqual({
    pass: true,
    checks: {
      matrix: true,
      coverage: true,
      continuous: true,
      faults: true,
      profileSafety: true,
    },
    missing: [],
  });
});

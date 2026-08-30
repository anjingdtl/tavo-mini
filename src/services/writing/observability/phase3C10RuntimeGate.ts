export const PHASE3_C10_TARGET_BUCKETS = [
  '500',
  '1000',
  '3000',
  'large',
] as const;

export const PHASE3_C10_PROFILES = ['fast', 'standard', 'quality'] as const;

export const PHASE3_C10_FAULTS = [
  'provider_slow',
  'network_failure',
  'app_kill',
  'outcome_unknown',
] as const;

export type Phase3C10TargetBucket = (typeof PHASE3_C10_TARGET_BUCKETS)[number];
export type Phase3C10Profile = (typeof PHASE3_C10_PROFILES)[number];
export type Phase3C10Fault = (typeof PHASE3_C10_FAULTS)[number];

export type Phase3C10MatrixCoverage = {
  draftClean: boolean;
  qaClean: boolean;
  qaIssue: boolean;
  revision: boolean;
};

export type Phase3C10MatrixEvidence = {
  receipt: boolean;
  dbIntegrity: boolean;
  ui: boolean;
  logcat: boolean;
  physicalCallsAccounted: boolean;
  failClosed: boolean;
};

export type Phase3C10MatrixCell = {
  targetBucket: Phase3C10TargetBucket;
  profile: Phase3C10Profile;
  realAndroid: boolean;
  configuredLlm: boolean;
  evidence: Phase3C10MatrixEvidence;
  coverage: Phase3C10MatrixCoverage;
};

export type Phase3C10ContinuousEvidence = {
  chapterCount: 5 | 10;
  realAndroid: boolean;
  configuredLlm: boolean;
  completed: boolean;
  runtimeStable: boolean;
  profileStable: boolean;
  budgetStable: boolean;
  resumeVerified: boolean;
  physicalCallsAccounted: boolean;
};

export type Phase3C10FaultEvidence = {
  realOrInjected: boolean;
  failClosed: boolean;
  noAutoRetry: boolean;
  receiptOrLedger: boolean;
};

export type Phase3C10ProfileSafety = {
  allowedScalarFields: string[];
  noPromptBody: boolean;
  noBlob: boolean;
  noGiantJson: boolean;
};

export type Phase3C10EvidenceManifest = {
  matrix: Phase3C10MatrixCell[];
  continuous: Phase3C10ContinuousEvidence[];
  faults: Partial<Record<Phase3C10Fault, Phase3C10FaultEvidence>>;
  profileSafety: Phase3C10ProfileSafety;
};

export type Phase3C10GateResult = {
  pass: boolean;
  checks: {
    matrix: boolean;
    coverage: boolean;
    continuous: boolean;
    faults: boolean;
    profileSafety: boolean;
  };
  missing: string[];
};

const EXPECTED_PROFILE_FIELDS = new Set([
  'profileKey',
  'policyVersion',
  'sample counters',
  'reasoning aggregates',
  'counterfactual counters',
  'latency aggregate',
  'recommended scale',
  'trip state',
  'updatedAt',
]);

const unique = (values: string[]): string[] => [...new Set(values)];

const expectedCellKey = (
  targetBucket: Phase3C10TargetBucket,
  profile: Phase3C10Profile,
): string => `${targetBucket}/${profile}`;

export function validatePhase3C10EvidenceManifest(
  manifest: Phase3C10EvidenceManifest,
): Phase3C10GateResult {
  const missing: string[] = [];
  const expectedCells = PHASE3_C10_TARGET_BUCKETS.flatMap(targetBucket =>
    PHASE3_C10_PROFILES.map(profile => expectedCellKey(targetBucket, profile)),
  );
  const seenCells = new Set<string>();
  const coverage = {
    draftClean: false,
    qaClean: false,
    qaIssue: false,
    revision: false,
  };

  for (const cell of manifest.matrix || []) {
    const key = expectedCellKey(cell.targetBucket, cell.profile);
    if (!expectedCells.includes(key)) {
      missing.push(`matrix.unexpected:${key}`);
      continue;
    }
    if (seenCells.has(key)) missing.push(`matrix.duplicate:${key}`);
    seenCells.add(key);
    if (!cell.realAndroid) missing.push(`matrix.realAndroid:${key}`);
    if (!cell.configuredLlm) missing.push(`matrix.configuredLlm:${key}`);
    for (const [evidenceKey, value] of Object.entries(cell.evidence || {})) {
      if (!value) missing.push(`matrix.evidence.${evidenceKey}:${key}`);
    }
    const cellCoverage = cell.coverage || ({} as Phase3C10MatrixCoverage);
    for (const coverageKey of Object.keys(coverage) as Array<keyof typeof coverage>) {
      if (cellCoverage[coverageKey]) coverage[coverageKey] = true;
    }
    if (!Object.values(cellCoverage).some(Boolean)) {
      missing.push(`matrix.coverage:${key}`);
    }
  }

  for (const key of expectedCells) {
    if (!seenCells.has(key)) missing.push(`matrix.missing:${key}`);
  }
  for (const coverageKey of Object.keys(coverage) as Array<keyof typeof coverage>) {
    if (!coverage[coverageKey]) missing.push(`coverage.missing:${coverageKey}`);
  }

  const continuousByCount = new Map(
    (manifest.continuous || []).map(evidence => [evidence.chapterCount, evidence]),
  );
  for (const chapterCount of [5, 10] as const) {
    const evidence = continuousByCount.get(chapterCount);
    if (!evidence) {
      missing.push(`continuous.missing:${chapterCount}`);
      continue;
    }
    for (const [key, value] of Object.entries(evidence)) {
      if (key !== 'chapterCount' && !value) {
        missing.push(`continuous.${key}:${chapterCount}`);
      }
    }
  }

  for (const fault of PHASE3_C10_FAULTS) {
    const evidence = manifest.faults?.[fault];
    if (!evidence) {
      missing.push(`fault.missing:${fault}`);
      continue;
    }
    for (const [key, value] of Object.entries(evidence)) {
      if (!value) missing.push(`fault.${key}:${fault}`);
    }
  }

  const profileSafety = manifest.profileSafety;
  if (!profileSafety || profileSafety.allowedScalarFields.length === 0) {
    missing.push('profileSafety.allowedScalarFields');
  } else {
    for (const field of profileSafety.allowedScalarFields) {
      if (!EXPECTED_PROFILE_FIELDS.has(field)) {
        missing.push(`profileSafety.unexpectedField:${field}`);
      }
    }
  }
  if (!profileSafety?.noPromptBody) missing.push('profileSafety.noPromptBody');
  if (!profileSafety?.noBlob) missing.push('profileSafety.noBlob');
  if (!profileSafety?.noGiantJson) missing.push('profileSafety.noGiantJson');

  const uniqueMissing = unique(missing);
  const checks = {
    matrix:
      seenCells.size === expectedCells.length &&
      !uniqueMissing.some(item => item.startsWith('matrix.')),
    coverage: !uniqueMissing.some(item => item.startsWith('coverage.')),
    continuous: !uniqueMissing.some(item => item.startsWith('continuous.')),
    faults: !uniqueMissing.some(item => item.startsWith('fault.')),
    profileSafety: !uniqueMissing.some(item => item.startsWith('profileSafety.')),
  };

  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    missing: uniqueMissing,
  };
}

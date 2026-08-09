/**
 * Workflow V3 Brief Compiler contracts.
 *
 * The Brief boundary intentionally contains normalized audit data only. It
 * never carries the draft, outline body, retrieval corpus, anchor text or
 * prompt instructions.
 */

export type BriefSeverity = 'hard' | 'required' | 'warning';

export interface BriefSourceItem {
  sourceId: string;
  severity: BriefSeverity;
  dimension: string;
  diagnosis: string;
  rewriteGoal: string;
  preserveMeaning: string[];
  locationHint?: 'opening' | 'middle' | 'ending' | 'unlocated' | string;
  evidenceQuote?: string;
}

export interface NormalizedCorrectionV3 extends BriefSourceItem {
  source: 'review' | 'factCheck';
  /** Optional evidence references retained for diagnostics, never authority. */
  sourceRefs?: string[];
  /** Human-readable scene hint; it never acts as a hard locator. */
  sceneHint?: string;
}

export interface NormalizedReviewV3 {
  schemaVersion: 3;
  draftHash: string;
  executableCorrections: NormalizedCorrectionV3[];
  unlocatedRequired: NormalizedCorrectionV3[];
  advisoryNotes: string[];
  outlineExecution: {
    fulfilledBeats: string[];
    missingBeats: string[];
    deviations: string[];
    prematureBeats: string[];
    mustPreserve: string[];
    endingGoal: string;
    mustNotAdvance: string[];
  };
  protectedFacts: string[];
  warnings: string[];
}

export interface NormalizedFactCheckV3 {
  schemaVersion: 3;
  draftHash: string;
  corrections: NormalizedCorrectionV3[];
  protectedFacts: string[];
  hardConstraints: string[];
  warnings: string[];
}

export interface BriefCompilerInputV1 {
  schemaVersion: 1;
  sourceHash: string;
  workflowMode: 'twoStage' | 'conditional' | 'full';
  review?: {
    executableCorrections: BriefSourceItem[];
    unlocatedRequired: BriefSourceItem[];
    advisoryNotes: string[];
    outlineExecution: NormalizedReviewV3['outlineExecution'];
  };
  factCheck?: {
    corrections: BriefSourceItem[];
    protectedFacts: string[];
    hardConstraints: string[];
  };
}

export interface FinalWritingBriefV1 {
  schemaVersion: 1;
  sourceHash: string;
  coveredRequiredIds: string[];
  mustFix: Array<{
    sourceIds: string[];
    location: string;
    instruction: string;
    preserve: string[];
  }>;
  mustPreserve: string[];
  mustNotAdvance: string[];
  openingContinuity: string[];
  endingState: string;
  advisoryNotes: string[];
}

export type BriefTargetKindV31 =
  | 'opening'
  | 'scene'
  | 'middle'
  | 'ending'
  | 'global';

/** Locally-owned fields in the V3.1 Brief envelope. */
export interface FinalWritingBriefImmutableEnvelopeV31 {
  schemaVersion: 2;
  sourceHash: string;
  requiredSourceIds: string[];
  protectedFacts: string[];
  hardConstraints: string[];
  mustNotAdvance: string[];
  outlineObligations: string[];
  endingBoundary: string;
}

export interface BriefCompilerInputV31 {
  schemaVersion: 2;
  sourceHash: string;
  workflowMode: 'twoStage' | 'conditional' | 'full';
  immutableEnvelope: FinalWritingBriefImmutableEnvelopeV31;
  review?: BriefCompilerInputV1['review'];
  factCheck?: BriefCompilerInputV1['factCheck'];
}

export interface FinalWritingBriefV31
  extends FinalWritingBriefImmutableEnvelopeV31 {
  coveredRequiredIds: string[];
  openingContinuity: string[];
  mustFix: Array<{
    sourceIds: string[];
    target: {
      kind: BriefTargetKindV31;
      hint?: string;
    };
    instruction: string;
    preserve: string[];
  }>;
  mustPreserve: string[];
  endingState: string;
  styleAdvisories: string[];
}

export interface BriefTriggerPolicy {
  minHardOrRequired: number;
  minAllExecutable: number;
  minProtectedFactsAndConstraints: number;
  maxNormalizedChars: number;
}

export const DEFAULT_BRIEF_TRIGGER_POLICY: BriefTriggerPolicy = {
  minHardOrRequired: 4,
  minAllExecutable: 6,
  minProtectedFactsAndConstraints: 8,
  maxNormalizedChars: 1500,
};

export function briefRequiredSourceIds(input: BriefCompilerInputV1): string[] {
  const ids = new Set<string>();
  for (const item of [
    ...(input.review?.executableCorrections || []),
    ...(input.review?.unlocatedRequired || []),
    ...(input.factCheck?.corrections || []),
  ]) {
    if (item.severity === 'hard' || item.severity === 'required') {
      if (item.sourceId) ids.add(item.sourceId);
    }
  }
  return [...ids].sort();
}

export function briefRequiredSourceIdsV31(input: BriefCompilerInputV31): string[] {
  return [...input.immutableEnvelope.requiredSourceIds];
}

export function buildBriefImmutableEnvelopeV31(
  input: BriefCompilerInputV1,
): FinalWritingBriefImmutableEnvelopeV31 {
  const review = input.review?.outlineExecution;
  const protectedFacts = [
    ...(review?.mustPreserve || []),
    ...(input.factCheck?.protectedFacts || []),
  ];
  const hardConstraints = [...(input.factCheck?.hardConstraints || [])];
  const outlineObligations = [
    ...(review?.fulfilledBeats || []).map(item => `已覆盖：${item}`),
    ...(review?.missingBeats || []).map(item => `必须补足：${item}`),
    ...(review?.deviations || []).map(item => `修正偏离：${item}`),
    ...(review?.prematureBeats || []).map(item => `不得提前兑现：${item}`),
  ];
  return {
    schemaVersion: 2,
    sourceHash: input.sourceHash,
    requiredSourceIds: briefRequiredSourceIds(input),
    protectedFacts: uniqueStrings(protectedFacts),
    hardConstraints: uniqueStrings(hardConstraints),
    mustNotAdvance: uniqueStrings(review?.mustNotAdvance || []),
    outlineObligations: uniqueStrings(outlineObligations),
    endingBoundary: String(review?.endingGoal || '').trim(),
  };
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.map(item => String(item || '').trim()).filter(Boolean))];
}

export function briefWarningCount(input: BriefCompilerInputV1): number {
  return [
    ...(input.review?.advisoryNotes || []),
    ...(input.review?.executableCorrections || []),
    ...(input.review?.unlocatedRequired || []),
    ...(input.factCheck?.corrections || []),
  ].filter(item =>
    typeof item === 'string' ? Boolean(item.trim()) : item.severity === 'warning',
  ).length;
}

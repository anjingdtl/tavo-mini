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

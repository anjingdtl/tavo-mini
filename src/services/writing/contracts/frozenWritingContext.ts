import type { WritingChapterObservability } from '../observability/writingChapterObservability';
import type {
  FrozenModelConfig,
  WritingInstruction,
  WritingPolicySnapshot,
  WritingRequest,
  WritingSource,
} from './writingSource';
import type { WritingRequirements } from './writingRequirement';
import type { WritingStagePolicy } from './writingPolicy';
import type { WritingPersistedEvent } from '../flow/writingPersistedEvent';
import type { ChapterTruthProjection } from './chapterTruthProjection';

export interface WritingMaterialCandidate {
  source: WritingSource;
  sourceOrder: number;
  demandTokens: number;
}

export interface WritingContextPlanItem {
  candidateId: string;
  requirement: WritingSource['requirement'];
  selected: boolean;
  priority: number;
  demandTokens: number;
  selectionReason: string | null;
  exclusionReason: string | null;
}

export interface WritingContextPlan {
  version: 1;
  items: WritingContextPlanItem[];
  fingerprint: string;
}

export interface WritingBudgetAllocationItem {
  candidateId: string;
  demandTokens: number;
  allocatedTokens: number;
  clipped: boolean;
  allocationReason: string;
}

export interface WritingBudgetAllocation {
  version: 1;
  inputTokenLimit: number;
  reservedOutputTokens: number;
  totalAllocatedTokens: number;
  items: WritingBudgetAllocationItem[];
  fingerprint: string;
}

export interface RenderedWritingContextItem {
  candidateId: string;
  allocatedTokens: number;
  actualTokens: number;
  included: boolean;
  clipped: boolean;
  renderedHash: string;
}

export interface RenderedWritingContext {
  version: 1;
  text: string;
  items: RenderedWritingContextItem[];
  estimatedInputTokens: number;
  fingerprint: string;
}

/** The only context object accepted by post-Freeze Kernel drivers. */
export interface FrozenWritingContext {
  version: 1;
  writingRunId: string;
  generationTraceId: string;
  projectId: number;
  chapterId: number;
  /** Observation-only target size; never used to compile a prompt. */
  targetChars?: number | null;
  instruction: WritingInstruction;
  sourceBundle: {
    mandatory: WritingSource[];
    preferred: WritingSource[];
    optional: WritingSource[];
  };
  model: FrozenModelConfig;
  policy: WritingPolicySnapshot;
  requirements: WritingRequirements;
  stagePolicy: WritingStagePolicy;
  materials: WritingMaterialCandidate[];
  plan: WritingContextPlan;
  allocation: WritingBudgetAllocation;
  rendered: RenderedWritingContext;
  sourceFingerprint: string;
  freezeFingerprint: string;
  /**
   * Fingerprint-level chapter facts reconstructed from this frozen context.
   * Optional on historical snapshots; never participates in freezeFingerprint.
   */
  truthProjection?: ChapterTruthProjection;
}

export type WritingKernelStage =
  | 'collect'
  | 'normalize'
  | 'plan'
  | 'allocate'
  | 'render'
  | 'freeze'
  | 'draft'
  | 'qa'
  | 'review'
  | 'audit'
  | 'factCheck'
  | 'revision'
  | 'proof'
  | 'finalValidate'
  | 'persist'
  | 'postWritingUpdate';

export interface WritingKernelStageEvent {
  stage: WritingKernelStage;
  status: 'started' | 'completed' | 'blocked' | 'skipped';
  detail?: string;
  /** Formal-skip provenance (status === 'skipped', One-Shot profile). */
  skipReason?: string;
  policyRuleId?: string;
  /** Observation-only stage duration. Not part of Freeze identity. */
  durationMs?: number;
}

export interface WritingKernelTrace {
  version: 1;
  writingRunId: string;
  generationTraceId: string;
  scenario: WritingRequest['scenario'];
  sourceFingerprint: string;
  contextPlanFingerprint: string;
  allocationFingerprint: string;
  renderFingerprint: string;
  freezeFingerprint: string;
  requirementsFingerprint?: string;
  stagePolicyFingerprint?: string;
  events: WritingKernelStageEvent[];
  silentContextLossCount: number;
  unexpectedLiveReadCount: number;
  fatalCount: number;
  falseAppliedRequirementCount: number;
  /** Durable Persist → PostWriting handoff for the trace's final body. */
  writingPersistedEvent?: WritingPersistedEvent;
  /**
   * Reconstructable identities of actual model-visible requests.
   * Optional on historical traces. Never part of freezeFingerprint.
   */
  requestReceipts?: import('./writingRequestReceipt').WritingRequestReceipt[];
  /**
   * Phase 0 chapter observability. Optional so historical traces keep parsing.
   * Never participates in freezeFingerprint.
   */
  observability?: WritingChapterObservability;
  /**
   * B1 Final Artifact summary: the stable user projection of this pipeline's
   * final manuscript. Never carries the body itself (body stays in
   * final_text / artifacts / chapter content as the single truth).
   * Optional so historical traces keep parsing; never part of freezeFingerprint.
   */
  finalArtifactSummary?: import('../finalArtifact').FinalArtifactSummary;
}

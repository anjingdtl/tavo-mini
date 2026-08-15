import type { Chapter, ContextConfig, Preset } from '../../../types/novel';
import type { ChatMessage } from '../../llm';
import type { ContextTraceItem } from '../../../types/contextTrace';
import type { GenerationDiagnostic } from '../../../types/generationTrace';
import type { ResourceContextCandidate } from '../resourceContextCandidates';
import type { Phase2BudgetResources } from '../resources/buildPhase2BudgetResources';

export type GenerationCandidateSourceType =
  | 'chapter'
  | 'outline'
  | 'character'
  | 'worldbook'
  | 'note'
  | 'story_memory'
  | 'episodic_memory'
  | 'writer_style'
  | 'canon'
  | 'preset'
  | 'other';

export type GenerationActivation =
  | 'explicit'
  | 'automatic'
  | 'mandatory'
  | 'system';

export type GenerationRequirement = 'mandatory' | 'preferred' | 'optional';

/** Candidate decision facts that are safe to persist and replay. */
export interface GenerationCandidateContractV1 {
  candidateId: string;
  sourceType: GenerationCandidateSourceType;
  sourceId: string | number | null;
  sourceRevision: string | null;
  contentHash: string;
  activation: GenerationActivation;
  selected: boolean;
  selectedReason: string | null;
  rejectedReason: string | null;
  requirement: GenerationRequirement;
  relevance: number | null;
  priority: number | null;
  selectionBoost: number | null;
  demandTokens: number;
}

/** Phase 2 contract names used by the persisted FrozenGenerationContext V2. */
export type FrozenContextCandidateV1 = GenerationCandidateContractV1;

export interface GenerationMaterialCandidate
  extends GenerationCandidateContractV1 {
  content: string;
  sourceOrder: number;
}

export interface GenerationBudgetDemand {
  candidateId: string;
  demandTokens: number;
  minTokens: number;
  targetTokens: number;
  maxTokens: number;
  priority: number;
  relevance: number;
  requirement: GenerationRequirement;
  selectionBoost: number;
}

export interface GenerationBudgetItem {
  candidateId: string;
  demandTokens: number;
  requestedTokens: number;
  minTokens: number;
  targetTokens: number;
  maxTokens: number;
  allocatedTokens: number;
  allocationReason: string;
  waterLevel: 'mandatory' | 'soft' | 'burst' | 'hard' | 'none';
  /** Canonical Phase 2 name. */
  budgetClipped: boolean;
  /** Phase 1 compatibility alias; new snapshots keep both values identical. */
  clippedByBudget?: boolean;
}

export type FrozenBudgetItem = GenerationBudgetItem;

export interface GenerationRenderedContextItem {
  candidateId: string;
  allocatedTokens: number;
  actualTokens: number;
  included: boolean;
  clipped: boolean;
  clippingReason: string | null;
  renderedHash: string;
}

export type FrozenRenderedContextItem = GenerationRenderedContextItem;

export interface GenerationContextPlan {
  version: 1;
  candidates: GenerationMaterialCandidate[];
  rejectedCandidates: GenerationCandidateContractV1[];
  demands: GenerationBudgetDemand[];
}

export interface CollectedGenerationMaterials {
  projectId: number;
  currentChapter: Chapter;
  config: ContextConfig;
  preset?: Preset | string;
  options: Record<string, unknown>;
  chapters: Chapter[];
  previousChapters: Chapter[];
  episodicCandidates: Chapter[];
  rawChapterIds: number[];
  prepared: unknown;
  coverage: unknown;
  coverageCandidates: unknown;
  preOutlineContext: {
    text: string;
    estimatedTokens: number;
    fingerprint: string;
    outlineIds: number[];
    complete: boolean;
    blockingReason?: string;
    enabledCount?: number;
  };
  worldbookScanContent: string;
  episodicQuery: string;
  retrievalOptions: Record<string, unknown>;
  resourceCandidates: GenerationMaterialCandidate[];
  resourceSources?: GenerationResourceSources;
  storyMemoryText: string;
  /**
   * Resource candidate/source facts captured before allocation. The concrete
   * V3/V7 shapes remain owned by their existing resource modules; Collect is
   * the only stage allowed to obtain them from repositories.
   */
  resourcePreparation?: GenerationResourcePreparation;
}

export interface GenerationResourcePreparation {
  v3ResourceCandidates?: ResourceContextCandidate[];
  v7Resources?: Phase2BudgetResources;
  episodicProbeText?: string;
  episodicProbeDemandTokens?: number;
  resourceCollectionError?: string;
}

/** Raw repository rows captured before plan/allocation/render. */
export interface GenerationResourceSources {
  characters: unknown[];
  notes: unknown[];
  noteConfig: unknown;
  noteContents: Record<number, string>;
  worldbookEntries: unknown[];
  noteStyleProfiles?: unknown[];
  noteRetrievalFragments?: unknown[];
}

export interface NormalizedGenerationMaterials
  extends CollectedGenerationMaterials {
  chapters: Chapter[];
  previousChapters: Chapter[];
  episodicCandidates: Chapter[];
  resourceCandidates: GenerationMaterialCandidate[];
  rejectedCandidates: GenerationCandidateContractV1[];
}

export interface GenerationBudgetAllocation {
  version: 1;
  mode: 'legacy' | 'elastic' | 'hierarchical';
  ok?: boolean;
  blockReason?: string;
  hardInputLimit: number;
  softInputLimit: number;
  burstInputLimit: number;
  items: GenerationBudgetItem[];
  totalAllocatedTokens: number;
  trace?: unknown;
}

export interface RenderedGenerationContext {
  version: 1;
  messages: ChatMessage[];
  trace: ContextTraceItem[];
  items: GenerationRenderedContextItem[];
  sectionTexts: Record<string, string>;
  estimatedInputTokens: number;
  messagePayloadHash: string;
}

export interface FrozenGenerationContextContractV2 {
  version: 2;
  projectId: number;
  chapterId: number | null;
  currentPosition: number;
  candidates: GenerationCandidateContractV1[];
  budget: GenerationBudgetItem[];
  rendered: GenerationRenderedContextItem[];
  messages: ChatMessage[];
  diagnostics: GenerationDiagnostic[];
  fingerprint: string;
}

export interface GenerationStageBuildInput {
  currentChapter: Chapter;
  config: ContextConfig;
  projectId: number;
  preset?: Preset | string;
  options?: Record<string, unknown>;
}

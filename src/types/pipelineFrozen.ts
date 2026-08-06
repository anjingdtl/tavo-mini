/**
 * Frozen execution inputs for pipeline tasks.
 *
 * Once a task freezes these structures, Draft/Audit must not re-read live
 * project data (outline / characters / worldbook / story memory / chapters).
 */
import type { ChatMessage } from '../services/llm';
import type { ContextConfig } from './novel';

/** Final Draft request frozen at task start (after fits check). */
export interface FrozenDraftRequest {
  messages: ChatMessage[];
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  safetyMargin: number;
  contextWindow: number;
  allocations: Array<{
    id: string;
    requested: number;
    allocated: number;
    truncated: boolean;
  }>;
  /** Stable fingerprint of messages + window parameters. */
  requestFingerprint: string;
  chapterTitle: string;
  prevEnding: string;
  userPrompt: string;
  /** Phase 2+ elastic budget trace (soft/burst/risk) when enabled. */
  elasticBudgetTrace?: unknown;
}

export interface FrozenChapterCandidate {
  id: number;
  position: number;
  title: string;
  memory_summary: string;
}

export interface FrozenCharacterCandidate {
  id: number;
  name: string;
  /** Pre-formatted character card block (same shape as buildCharacterContext). */
  cardText: string;
}

export interface FrozenWorldbookCandidate {
  id: number | null;
  keywords: string[];
  secondaryKeywords: string[];
  content: string;
  constant: boolean;
  position: number;
}

/** Subset of ContextConfig needed for post-draft retrieval scoring. */
export interface FrozenContextConfig {
  strategy: ContextConfig['strategy'];
  slidingWindowSize: number;
  customRangeStart: number;
  customRangeEnd: number;
  resourceBudget: number;
  includeResources: boolean;
  summaryBudgetTokens?: number;
  storyStateBudgetTokens?: number;
  episodicMemoryBudgetTokens?: number;
  memoryTopK?: number;
  worldbookRecursive?: boolean;
}

/**
 * Candidate pool frozen at task start for full-mode audit re-scoring.
 * Draft completion may only re-score within this pool using the draft text.
 */
export interface FrozenAuditCandidates {
  episodicCandidates: FrozenChapterCandidate[];
  characterCandidates: FrozenCharacterCandidate[];
  worldbookCandidates: FrozenWorldbookCandidate[];
  contextConfig: FrozenContextConfig;
  chapterPosition: number;
  chapterTitle: string;
  chapterSynopsis: string;
  /** Raw bridge chapter ids excluded from episodic (from story-memory coverage). */
  rawChapterIds: number[];
  /** Story-state text used for entity/term boosts at freeze time. */
  storyStateText: string;
  createdAt: number;
}

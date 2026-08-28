import type { Chapter } from '../../../types/novel';

/** Product-level input scenarios. Scenario ends at the Kernel boundary. */
export type WritingScenario = 'outline' | 'continuation';

export type WritingSourceKind =
  | 'outline'
  | 'canon'
  | 'source_boundary'
  | 'seam'
  | 'primary_anchor'
  | 'chapter'
  | 'character'
  | 'worldbook'
  | 'note'
  | 'story_memory'
  | 'episodic_memory'
  | 'structured_continuity_state'
  | 'writer_style'
  | 'preset'
  | 'instruction'
  | 'other';

export type WritingSourceRequirement =
  | 'mandatory'
  | 'preferred'
  | 'optional';

export type WritingSourceActivation =
  | 'explicit'
  | 'automatic'
  | 'system';

/** One semantic, hash-addressable input to a writing run. */
export interface WritingSource {
  candidateId: string;
  kind: WritingSourceKind;
  sourceId: string | number | null;
  revision: string | null;
  contentHash: string;
  content: string;
  requirement: WritingSourceRequirement;
  activation: WritingSourceActivation;
  metadata?: Record<string, unknown>;
}

export interface WritingSourceBundle {
  mandatory: WritingSource[];
  preferred: WritingSource[];
  optional: WritingSource[];
}

export interface WritingInstruction {
  title: string;
  synopsis: string;
  userInstruction: string;
  currentContent: string;
  targetPosition: number;
}

/** Immutable secret handle. Never stores the API key itself. */
export interface WritingCredentialRef {
  kind: 'llm-config-api-key';
  configId: number;
}

/** Non-secret model fields frozen at the writing boundary. */
export interface FrozenModelConfig {
  configId: number | null;
  provider: string;
  /** Stable capability-adapter identity frozen with the request. */
  providerAdapterId?: string | null;
  modelName: string;
  contextWindow: number;
  maxOutputTokens: number;
  url?: string;
  name?: string;
  allowInsecureLanHttp?: boolean;
  thinking?: { type: 'enabled' | 'disabled' };
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  credentialRef?: WritingCredentialRef | null;
}

/** Runtime policy snapshot. It is intentionally opaque to Source Adapters. */
export interface WritingPolicySnapshot {
  version: 1;
  reviewMode: string;
  strictness: string;
  values: Record<string, unknown>;
}

export interface WritingRequest {
  writingRunId: string;
  generationTraceId: string;
  projectId: number;
  chapterId: number;
  scenario: WritingScenario;
  /** Observation-only target size for continuation requests. */
  targetChars?: number | null;
  instruction: WritingInstruction;
  sourceBundle: WritingSourceBundle;
  model: FrozenModelConfig;
  policy: WritingPolicySnapshot;
  legacyRestart?: {
    restartedFromLegacyTaskId: string;
  };
}

export type WritingSourceValidationCode =
  | 'MISSING_MANDATORY_SOURCE'
  | 'EMPTY_MANDATORY_SOURCE'
  | 'INVALID_SOURCE_HASH'
  | 'DUPLICATE_CANDIDATE'
  | 'INVALID_SOURCE_REVISION'
  | 'INVALID_SCENARIO_SOURCE';

export interface WritingSourceValidationIssue {
  code: WritingSourceValidationCode;
  candidateId?: string;
  message: string;
}

export interface WritingSourceValidationResult {
  ok: boolean;
  issues: WritingSourceValidationIssue[];
}

export interface WritingSourceTrace {
  scenario: WritingScenario;
  sourceAdapter: string;
  sourceCandidateCount: number;
  mandatoryCount: number;
  preferredCount: number;
  optionalCount: number;
  sourceFingerprint: string;
  rejectedSources: string[];
  missingSources: string[];
  legacyRestart?: {
    restartedFromLegacyTaskId: string;
  };
}

/** Small shared shape used by adapters without exposing DB rows to the Kernel. */
export interface OutlineSourceContext {
  presetText: string;
  storyMemoryText: string;
  characterText: string;
  noteText: string;
  worldbookText: string;
  episodicMemoryText: string;
  recentBridgeText: string;
  outlineText: string;
  outlineFingerprint: string;
  outlineIds: readonly number[];
  outlineComplete: boolean;
  writerStyleText?: string;
}

export interface OutlineWritingSourceInput {
  projectId: number;
  chapter: Pick<Chapter, 'id' | 'position' | 'title' | 'synopsis' | 'content' | 'updated_at'>;
  context: OutlineSourceContext;
  userInstruction?: string;
}

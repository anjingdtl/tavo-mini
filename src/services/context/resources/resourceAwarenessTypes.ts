/**
 * Phase-2 resource awareness / detail contracts.
 *
 * Runtime consumption models only — never written into CCv3, Lorebook v3,
 * or shinewriter-preset-v1 export envelopes.
 */

export const CHARACTER_AWARENESS_COMPILER_VERSION = 'character-awareness-v1';
export const WORLDBOOK_AWARENESS_COMPILER_VERSION = 'worldbook-awareness-v1';
export const RESOURCE_CONTEXT_V2 = 2 as const;
export const PHASE2_RESOURCE_CONTEXT_VERSION = 2 as const;

export type ResourceAwarenessSourceKind = 'character' | 'worldbook';
export type ResourceDetailSourceKind = 'character' | 'worldbook' | 'note';

export type ResourceContextWarningCode =
  | 'NOTE_LIST_READ_FAILED'
  | 'NOTE_CONTENT_READ_FAILED'
  | 'NOTE_DETAIL_COMPILE_FAILED';

export interface ResourceContextWarning {
  code: ResourceContextWarningCode;
  sourceKind: 'note';
  sourceId?: number | null;
  title?: string;
  message: string;
  action?: 'open_resources' | 'retry' | 'none';
}

export type FrozenNoteMode = 'none' | 'style' | 'retrieval';

/**
 * Note selection settings captured together with the source view. Keeping
 * this in the snapshot lets the V7 compiler preserve the existing note modes
 * without querying project_note_config after the source view is frozen.
 */
export interface FrozenNoteConfig {
  mode: FrozenNoteMode;
  styleWeights?: Record<string, number>;
  retrievalTopK?: number;
  retrievalFragmentChars?: number;
  enabledNoteIds?: number[];
}

/** Cached Style Profile material captured before the V7 source view closes. */
export interface FrozenNoteStyleProfile {
  profileText: string;
  profileJson: string;
  sourceHash: string;
}

export interface FrozenNoteRetrievalQuery {
  chapterTitle: string;
  chapterSynopsis: string;
  previousEnding: string;
  userPrompt: string;
}

export interface FrozenNoteRetrievalFragment {
  noteId: number;
  noteTitle: string;
  fragment: string;
  relevance: string;
  retrievalScore?: number;
}

/** Query-specific retrieval is frozen with the source view, never re-read. */
export interface FrozenNoteRetrieval {
  query: FrozenNoteRetrievalQuery;
  fragments: FrozenNoteRetrievalFragment[];
}

export type ResourceConstraintClass =
  | 'identity'
  | 'relationship'
  | 'knowledge_boundary'
  | 'world_rule'
  | 'persistent_fact'
  | 'mutable_baseline'
  | 'reference_fact';

export type ResourceAwarenessFallbackMode =
  | 'structured'
  | 'cached_summary'
  | 'full_source_protected';

export type ResourcePreviewStatus =
  | 'AWARENESS_ONLY'
  | 'DETAIL_FULL'
  | 'DETAIL_CLIPPED'
  | 'NOT_SELECTED'
  | 'DISABLED'
  | 'ERROR';

export type ResourceDetailActivationReason =
  | 'pov'
  | 'title_synopsis_hit'
  | 'user_prompt_hit'
  | 'current_body_hit'
  | 'previous_chapter_hit'
  | 'story_memory_hit'
  | 'outline_hit'
  | 'relation_neighbor'
  | 'episodic_hit'
  | 'primary_secondary_hit'
  | 'constant'
  | 'primary_hit'
  | 'recursive_hit'
  | 'entity_hit'
  | 'project_fallback'
  | 'explicit'
  | 'project_enabled'
  | 'style_note';

export type ResourceDetailIntensity = 'save' | 'balanced' | 'rich';

export type PresetSourceKind =
  | 'user_selected'
  | 'default_runtime_baseline';

export interface ResourceAwarenessCapsule {
  sourceKind: ResourceAwarenessSourceKind;
  sourceId: number;
  sourceUpdatedAt?: string | number;
  sourceFingerprint: string;
  compilerVersion: string;
  title: string;
  awarenessText: string;
  estimatedTokens: number;
  constraintClasses: ResourceConstraintClass[];
  fallbackMode: ResourceAwarenessFallbackMode;
  legacyCharacterFallback?: boolean;
}

export interface FrozenSourceRecord {
  kind: ResourceDetailSourceKind | 'preset';
  id: number | null;
  title: string;
  updatedAt?: string | number;
  /** Canonical semantic payload used for ALL derived compile steps. */
  payload: string;
  fingerprint: string;
  /** Present for Notes in style mode; captured before the snapshot is returned. */
  styleProfile?: FrozenNoteStyleProfile;
}

export interface ResourceSourceSnapshot {
  characters: FrozenSourceRecord[];
  worldbookEntries: FrozenSourceRecord[];
  notes: FrozenSourceRecord[];
  preset?: FrozenSourceRecord;
  noteConfig?: FrozenNoteConfig;
  noteRetrieval?: FrozenNoteRetrieval;
  warnings?: ResourceContextWarning[];
  capturedAt: number;
  includeResources: boolean;
}

export interface GlobalAwarenessCandidate {
  id: string;
  sourceKind: ResourceAwarenessSourceKind;
  sourceId: number;
  title: string;
  content: string;
  actualTokens: number;
  sourceFingerprint: string;
  compilerVersion: string;
  constraintClasses: ResourceConstraintClass[];
  required: true;
  sourceOrder: number;
  fallbackMode: ResourceAwarenessFallbackMode;
  legacyCharacterFallback?: boolean;
}

export interface ResourceDetailCandidate {
  id: string;
  sourceKind: ResourceDetailSourceKind;
  sourceId: number | null;
  title: string;
  content: string;
  actualTokens: number;
  activationReason: ResourceDetailActivationReason;
  relevance: number;
  explicitSelected: boolean;
  sourceOrder: number;
  relationBoost?: number;
  retrievalScore?: number;
  sourceFingerprint?: string;
  /** Structural blocks used for priority clipping (high → low). */
  clipTiers?: string[];
}

export interface FrozenPresetContext {
  presetId?: number;
  presetName: string;
  sourceFingerprint: string;
  presetSource: PresetSourceKind;
  systemText: string;
  writingStyleText: string;
  extraInstructionsText: string;
  combinedText: string;
  requestedPresetId?: number | null;
}

export interface FrozenResourceAwarenessItem {
  id: string;
  sourceKind: ResourceAwarenessSourceKind;
  sourceId: number;
  title: string;
  content: string;
  sourceFingerprint: string;
  compilerVersion: string;
  constraintClasses: ResourceConstraintClass[];
  fallbackMode: ResourceAwarenessFallbackMode;
  estimatedTokens: number;
  legacyCharacterFallback?: boolean;
}

export interface FrozenResourceDetailItem {
  id: string;
  sourceKind: ResourceDetailSourceKind;
  sourceId: number | null;
  title: string;
  content: string;
  actualTokens: number;
  allocatedTokens: number;
  activationReason: string;
  sourceFingerprint?: string;
  clipped: boolean;
  relevance?: number;
}

export interface ResourceSelectionTraceItem {
  id: string;
  sourceKind: ResourceDetailSourceKind | ResourceAwarenessSourceKind | 'preset';
  sourceId?: number | null;
  title: string;
  mode: 'global_awareness' | 'detail' | 'preset' | 'disabled' | 'error';
  status: ResourcePreviewStatus;
  included: boolean;
  clipped: boolean;
  demandTokens: number;
  allocatedTokens: number;
  activationReason?: string;
  sourceFingerprint?: string;
  compilerVersion?: string;
  warning?: string;
  warningCode?: ResourceContextWarningCode;
  warningAction?: 'open_resources' | 'retry' | 'none';
}

export type PipelineResourceStage =
  | 'draft'
  | 'review'
  | 'factCheck'
  | 'brief'
  | 'proof';

export type StoryCharacterStatus =
  | 'active'
  | 'inactive'
  | 'missing'
  | 'dead'
  | 'unknown';
export type RelationshipDirection = 'directed' | 'bidirectional';
export type StoryMemoryBuildStatus =
  | 'empty'
  | 'clean'
  | 'dirty'
  | 'rebuilding'
  | 'failed';

export interface StoryCharacterCurrentState {
  location: string;
  physicalState: string;
  emotionalState: string;
  currentGoal: string;
  knowledge: string[];
  possessions: string[];
  secrets: string[];
}

export interface StoryCharacter {
  id: string;
  canonicalName: string;
  aliases: string[];
  role: string;
  immutableProfile: {
    identity: string;
    stableTraits: string[];
    affiliations: string[];
  };
  currentState: StoryCharacterCurrentState;
  status: StoryCharacterStatus;
  firstSeenChapterId: number;
  firstSeenPosition: number;
  lastChangedChapterId: number;
  lastChangedPosition: number;
  evidenceChapterIds: number[];
}

export type StoryTrustLevel =
  | 'hostile'
  | 'low'
  | 'uncertain'
  | 'medium'
  | 'high'
  | 'absolute'
  | 'unknown';

export interface StoryRelationship {
  id: string;
  fromCharacterId: string;
  toCharacterId: string;
  direction: RelationshipDirection;
  relationType: string;
  currentState: string;
  trustLevel: StoryTrustLevel;
  publicStatus: string;
  hiddenStatus: string;
  reason: string;
  firstSeenChapterId: number;
  lastChangedChapterId: number;
  lastChangedPosition: number;
  evidenceChapterIds: number[];
}

export interface StoryConflict {
  id: string;
  title: string;
  parties: string[];
  state: string;
  stakes: string;
  openedChapterId: number;
  lastChangedChapterId: number;
  evidenceChapterIds: number[];
}

export interface StoryThread {
  id: string;
  title: string;
  description: string;
  ownerCharacterIds: string[];
  priority: 'critical' | 'high' | 'normal' | 'low';
  openedChapterId: number;
  lastChangedChapterId: number;
  deadlineOrTrigger: string;
  evidenceChapterIds: number[];
}

export interface StoryForeshadowing {
  id: string;
  setup: string;
  expectedPayoff: string;
  status: 'open' | 'partially_paid' | 'paid';
  openedChapterId: number;
  lastChangedChapterId: number;
  evidenceChapterIds: number[];
}

export interface StoryTimelineAnchor {
  id: string;
  label: string;
  timeDescription: string;
  event: string;
  chapterId: number;
  pinned: boolean;
}

export interface StoryCompletedBeat {
  id: string;
  summary: string;
  chapterId: number;
}

export interface StoryResolvedThread {
  id: string;
  title: string;
  resolution: string;
  openedChapterId: number;
  resolvedChapterId: number;
}

export interface StoryMainline {
  currentArc: {
    id: string;
    name: string;
    summary: string;
    startedChapterId: number | null;
  } | null;
  currentObjective: string;
  activeConflicts: Record<string, StoryConflict>;
  openThreads: Record<string, StoryThread>;
  foreshadowing: Record<string, StoryForeshadowing>;
  timelineAnchors: Record<string, StoryTimelineAnchor>;
  recentCompletedBeats: StoryCompletedBeat[];
  recentResolvedThreads: StoryResolvedThread[];
  archiveDigest: string;
}

export interface StoryMemoryMetadata {
  status: StoryMemoryBuildStatus;
  source: 'native' | 'legacy_bootstrap';
  stateFingerprint: string;
  lastAppliedPatchId: string | null;
  estimatedTokens: number;
  dirtyFromPosition: number | null;
  lastError: string;
  updatedAt: string;
}

export interface StoryMemoryState {
  schemaVersion: 1;
  projectId: number;
  throughChapterId: number | null;
  throughChapterPosition: number;
  characters: Record<string, StoryCharacter>;
  relationships: Record<string, StoryRelationship>;
  mainline: StoryMainline;
  metadata: StoryMemoryMetadata;
}

export interface EpisodicSummary {
  brief: string;
  keywords: string[];
  events: string[];
  characterChanges: string[];
  relationshipChanges: string[];
  mainlineChanges: string[];
  newThreads: string[];
  resolvedThreads: string[];
}

export interface NewCharacterPatch {
  tempRef: string;
  canonicalName: string;
  aliases: string[];
  role: string;
  identity: string;
  stableTraits: string[];
  initialState: Partial<StoryCharacterCurrentState>;
  status: StoryCharacterStatus;
  evidenceQuote: string;
}

export interface CharacterUpdatePatch {
  characterRef: string;
  addAliases: string[];
  profileCorrections: Partial<StoryCharacter['immutableProfile']>;
  stateChanges: Partial<
    Omit<StoryCharacterCurrentState, 'knowledge' | 'possessions' | 'secrets'>
  >;
  status?: StoryCharacterStatus;
  correctionReason: string;
  addKnowledge: string[];
  removeKnowledge: string[];
  addPossessions: string[];
  removePossessions: string[];
  addSecrets: string[];
  removeSecrets: string[];
  clearFields: string[];
  evidenceQuote: string;
}

export interface NewRelationshipPatch {
  tempRef: string;
  fromRef: string;
  toRef: string;
  direction: RelationshipDirection;
  relationType: string;
  currentState: string;
  trustLevel: StoryTrustLevel;
  publicStatus: string;
  hiddenStatus: string;
  reason: string;
  evidenceQuote: string;
}

export interface RelationshipUpdatePatch {
  relationshipRef: string;
  currentState?: string;
  trustLevel?: StoryTrustLevel;
  publicStatus?: string;
  hiddenStatus?: string;
  reason?: string;
  evidenceQuote: string;
}

export interface MainlineEntityPatch {
  ref: string;
  title: string;
  description?: string;
  state?: string;
  stakes?: string;
  parties?: string[];
  ownerCharacterRefs?: string[];
  priority?: StoryThread['priority'];
  deadlineOrTrigger?: string;
  setup?: string;
  expectedPayoff?: string;
  status?: StoryForeshadowing['status'];
  evidenceQuote: string;
}

export interface MainlinePatch {
  currentArcUpdate: {
    action: 'none' | 'start' | 'update' | 'complete';
    arcRef: string;
    name: string;
    summary: string;
    evidenceQuote: string;
  };
  currentObjective?: { value: string; evidenceQuote: string };
  conflictUpserts: MainlineEntityPatch[];
  threadOpens: MainlineEntityPatch[];
  threadUpdates: MainlineEntityPatch[];
  threadResolutions: Array<{
    threadRef: string;
    resolution: string;
    evidenceQuote: string;
  }>;
  foreshadowingUpserts: MainlineEntityPatch[];
  timelineAnchors: Array<{
    ref: string;
    label: string;
    timeDescription: string;
    event: string;
    pinned: boolean;
    evidenceQuote: string;
  }>;
  completedBeats: Array<{
    ref: string;
    summary: string;
    evidenceQuote: string;
  }>;
}

export interface ChapterMemoryPatchDraft {
  schemaVersion: 1;
  chapterRef: {
    chapterId: number;
    chapterPosition: number;
    title: string;
  };
  episodicSummary: EpisodicSummary;
  newCharacters: NewCharacterPatch[];
  characterUpdates: CharacterUpdatePatch[];
  newRelationships: NewRelationshipPatch[];
  relationshipUpdates: RelationshipUpdatePatch[];
  mainlinePatch: MainlinePatch;
}

export interface StoredChapterMemoryPatch {
  patchId: string;
  schemaVersion: 1;
  projectId: number;
  chapterId: number;
  chapterPosition: number;
  sourceFingerprint: string;
  baseMemoryFingerprint: string;
  resultMemoryFingerprint: string;
  episodicSummary: EpisodicSummary;
  normalizedPatch: ChapterMemoryPatchDraft;
  generatedAt: string;
  appliedAt: string | null;
}

export interface StoryMemoryWarning {
  code: string;
  message: string;
}

export interface ApplyPatchResult {
  state: StoryMemoryState;
  resolvedPatch: StoredChapterMemoryPatch;
  warnings: StoryMemoryWarning[];
}

export type StoryMemoryErrorCode =
  | 'MEMORY_NOT_INITIALIZED'
  | 'MEMORY_DIRTY'
  | 'MEMORY_PATCH_INVALID_JSON'
  | 'MEMORY_PATCH_SCHEMA_INVALID'
  | 'MEMORY_EVIDENCE_NOT_FOUND'
  | 'MEMORY_ENTITY_REFERENCE_INVALID'
  | 'MEMORY_BASE_FINGERPRINT_MISMATCH'
  | 'MEMORY_TRANSACTION_FAILED'
  | 'MEMORY_REBUILD_CANCELLED'
  | 'MEMORY_REBUILD_FAILED'
  | 'MEMORY_STATE_CORRUPTED';

export class StoryMemoryError extends Error {
  constructor(public readonly code: StoryMemoryErrorCode, message: string) {
    super(message);
    this.name = 'StoryMemoryError';
  }
}

import type { BatchEvidenceQuote, StoryMemoryBatchPatchDraft } from './storyMemoryTypes';

export type StoryMemoryObservationKind =
  | 'character_new'
  | 'character_state'
  | 'character_set'
  | 'relationship'
  | 'arc'
  | 'objective'
  | 'conflict'
  | 'thread'
  | 'foreshadowing'
  | 'timeline';

export type StoryMemoryObservationWarningCode =
  | 'OBS_INVALID_KIND'
  | 'OBS_INVALID_OP'
  | 'OBS_INVALID_FIELD'
  | 'OBS_INVALID_REF'
  | 'OBS_INVALID_EVIDENCE'
  | 'OBS_INVALID_ENDPOINT'
  | 'OBS_DUPLICATE'
  | 'OBS_AMBIGUOUS_NEW_ENTITY'
  | 'OBS_MISSING_REQUIRED_FIELD'
  | 'OBS_UNKNOWN_CHAPTER'
  | 'OBS_CHAPTER_DUPLICATE'
  | 'OBS_CHAPTER_MISSING'
  | 'OBS_BRIEF_FALLBACK';

export interface StoryMemoryObservationWarning {
  code: StoryMemoryObservationWarningCode;
  message: string;
  chapterHandle?: string;
  observationIndex?: number;
}

export interface RawStoryMemoryObservation {
  kind?: unknown;
  key?: unknown;
  ref?: unknown;
  op?: unknown;
  field?: unknown;
  value?: unknown;
  name?: unknown;
  aliases?: unknown;
  role?: unknown;
  identity?: unknown;
  stableTraits?: unknown;
  initialState?: unknown;
  status?: unknown;
  direction?: unknown;
  from?: unknown;
  to?: unknown;
  type?: unknown;
  state?: unknown;
  trust?: unknown;
  trustLevel?: unknown;
  reason?: unknown;
  publicStatus?: unknown;
  hiddenStatus?: unknown;
  title?: unknown;
  description?: unknown;
  stakes?: unknown;
  parties?: unknown;
  owners?: unknown;
  priority?: unknown;
  deadlineOrTrigger?: unknown;
  setup?: unknown;
  payoff?: unknown;
  expectedPayoff?: unknown;
  summary?: unknown;
  label?: unknown;
  time?: unknown;
  event?: unknown;
  pinned?: unknown;
  evidence?: unknown;
  [key: string]: unknown;
}

export interface StoryMemoryObservation {
  kind: StoryMemoryObservationKind;
  key?: string;
  ref?: string;
  op: string;
  field?: string;
  value?: string;
  name?: string;
  aliases: string[];
  role?: string;
  identity?: string;
  stableTraits: string[];
  initialState: {
    location?: string;
    physicalState?: string;
    emotionalState?: string;
    currentGoal?: string;
    knowledge?: string[];
    possessions?: string[];
    secrets?: string[];
  };
  status?: 'active' | 'inactive' | 'missing' | 'dead' | 'unknown';
  direction?: 'directed' | 'bidirectional';
  from?: string;
  to?: string;
  type?: string;
  state?: string;
  trust?: string;
  trustLevel?: string;
  reason?: string;
  publicStatus?: string;
  hiddenStatus?: string;
  title?: string;
  description?: string;
  stakes?: string;
  parties: string[];
  owners: string[];
  priority?: 'critical' | 'high' | 'normal' | 'low';
  deadlineOrTrigger?: string;
  setup?: string;
  payoff?: string;
  expectedPayoff?: string;
  summary?: string;
  label?: string;
  time?: string;
  event?: string;
  pinned?: boolean;
  evidence: string[];
}

export interface StoryMemoryObservationChapter {
  chapter: string;
  brief: string;
  events: string[];
  keywords: string[];
  observations: StoryMemoryObservation[];
}

export interface StoryMemoryObservationPayload {
  chapters: StoryMemoryObservationChapter[];
}

export interface StoryMemoryNormalizedObservationPayload {
  chapters: StoryMemoryObservationChapter[];
  warnings: StoryMemoryObservationWarning[];
  missingChapterHandles: string[];
}

export interface StoryMemoryCompiledObservationResult {
  patch: StoryMemoryBatchPatchDraft;
  warnings: StoryMemoryObservationWarning[];
  acceptedObservations: number;
  droppedObservations: number;
  evidenceByObservation: Map<number, BatchEvidenceQuote[]>;
}

/**
 * ONE Memory contract.
 *
 * TAVO keeps a single long-term narrative memory: Story Memory
 * (`src/services/storyMemory` + `project_story_memory`).
 *
 * Outline and Continuation share:
 *   checkpoint / pending bridge / rolling summary / episodic retrieval
 *
 * Continuation also keeps — and these are NOT a second memory:
 *   Canon                 fact authority
 *   Source Boundary/Seam  scene constraint
 *   Structured Continuity State   runtime state
 *
 * Story Memory is never the hard-fact referee.
 */
export const ONE_NARRATIVE_LONG_TERM_MEMORY_SYSTEM = 'story_memory' as const;

export const ONE_MEMORY_SHARED_SURFACES = [
  'checkpoint',
  'pending_bridge',
  'rolling_summary',
  'episodic_retrieval',
  'story_memory_update_contract',
] as const;

export const CONTINUATION_NON_MEMORY_AUTHORITIES = [
  'canon',
  'source_boundary',
  'seam',
  'anchor',
  'structured_continuity_state',
] as const;

export const STORY_MEMORY_UPDATE_OPERATIONS = [
  'finalizeChapterMemory',
  'rebuildStoryMemory',
] as const;

export const FORBIDDEN_SECOND_LONG_TERM_MEMORY_FILES = [
  'src/services/writing/memory/continuationMemory.ts',
  'src/services/writing/memory/outlineMemory.ts',
  'src/services/writing/memory/fastMemory.ts',
  'src/services/writing/memory/oneShotMemory.ts',
  'src/services/continuation/continuationLongTermMemory.ts',
  'src/services/continuation/generation/continuationMemory.ts',
] as const;

export const ONE_MEMORY_POST_WRITING_PATH = [
  'chapter_persist',
  'story_memory_update',
  'continuity_state_extraction',
  'local_validate_canon_check',
  'auto_commit_or_conflict_gate',
] as const;

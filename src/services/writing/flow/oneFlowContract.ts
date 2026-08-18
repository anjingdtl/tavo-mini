/**
 * ONE Flow closed loop (plan §6 / §7 / §14).
 *
 * Memory → Context Candidates → ONE Context → Freeze → ONE Pipeline
 * → Persist → WritingPersistedEvent → PostWriting → ONE Memory
 * → Next Chapter Ready.
 *
 * This file is the integration contract. It does not own Writer / Budget /
 * Canon / Story Memory algorithms.
 */
export const ONE_FLOW_CONTRACT_VERSION = 1 as const;

export const ONE_FLOW_STEPS = [
  'user_or_batch_or_resume',
  'source_adapter',
  'context_candidates',
  'one_context_planner',
  'elastic_hierarchical_budget',
  'render',
  'requirements_and_policy',
  'one_freeze',
  'one_pipeline_dag',
  'persist',
  'writing_persisted_event',
  'post_writing_update',
  'one_memory',
  'next_chapter_ready',
] as const;

export type OneFlowStep = (typeof ONE_FLOW_STEPS)[number];

export const ONE_FLOW_UNIQUE_OBJECTS = {
  productionWritingEntry: 'runWritingKernel',
  contextPlanner: 'buildWritingContextPlan',
  finalBudget: 'allocateWritingContextBudget',
  freeze: 'buildFrozenWritingContext',
  pipeline: 'runWritingStages',
  persistToMemoryEvent: 'WritingPersistedEvent',
  narrativeLongTermMemory: 'story_memory',
} as const;

export const ONE_FLOW_FORBIDDEN_DUAL_TRUTHS = [
  'second_writer_core',
  'second_prompt_compiler',
  'second_final_budget',
  'second_long_term_memory',
  'post_freeze_live_source_read',
  'memory_prompt_bypass',
  'state_budget_bypass',
  'canon_post_freeze_live_injection',
] as const;

export const ONE_FLOW_MEMORY_ENTRY_POINTS = [
  'src/services/storyMemory/storyMemoryService.ts#finalizeChapterMemory',
  'src/services/writing/persist/continuationAdoption.ts#finalizeContinuationChapter',
] as const;

/**
 * Story Memory wire protocol version.
 *
 * The persisted StoryMemoryState and Batch Patch schema remain unchanged. The
 * protocol version only describes how an LLM request is produced before the
 * existing local patch/merger/CAS pipeline takes over.
 */
export type StoryMemoryProtocolVersion = 1 | 2;

export const CURRENT_STORY_MEMORY_PROTOCOL_VERSION: StoryMemoryProtocolVersion = 2;

export const STORY_MEMORY_V2_REQUEST_KINDS = {
  primary: 'story_memory_v2_primary',
  formatter: 'story_memory_v2_formatter',
  freshRetry: 'story_memory_v2_fresh_retry',
  legacyBootstrap: 'story_memory_v2_legacy_bootstrap',
} as const;

export type StoryMemoryV2RequestKind =
  (typeof STORY_MEMORY_V2_REQUEST_KINDS)[keyof typeof STORY_MEMORY_V2_REQUEST_KINDS];

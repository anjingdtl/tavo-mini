/**
 * Project modes (continuation Phase 1).
 *
 * - `outline` — outline-driven authoring (historical default; `projects.mode`
 *   column default and the implicit mode for v1/v2 project packages without a
 *   mode field).
 * - `continuation` — original-work continuation projects introduced in Schema 19.
 *   Backed by the `continuation_*` tables and the bounded SourceReader contract.
 * - `freeform` — legacy free-form writing projects. Still openable and editable,
 *   but no longer offered as a new-project option in the UI.
 *
 * Persistence semantics are governed by `normalizeProjectMode()`; never write a
 * raw string into `projects.mode` without going through that normalizer.
 */
export type ProjectMode = 'outline' | 'continuation' | 'freeform';

/**
 * Branded nominal types for continuation source offsets and positions.
 *
 * These exist so source-chapter positions and continuation-chapter positions
 * (which live in different namespaces — `continuation_source_chapters.position`
 * vs `chapters.position`) cannot be silently mixed at the API boundary. See
 * `docs/superpowers/specs/next/continuation-phase-1-project-foundation.spec.md`
 * §6 (cross-phase public data contract).
 *
 * Both are 0-based finite non-negative integers stored as INTEGER in SQLite;
 * the Repository boundary is responsible for validation and branding.
 */
declare const sourcePositionBrand: unique symbol;
declare const continuationPositionBrand: unique symbol;
declare const utf16OffsetBrand: unique symbol;

export type SourceChapterPosition = number & {
  readonly [sourcePositionBrand]: true;
};
export type ContinuationChapterPosition = number & {
  readonly [continuationPositionBrand]: true;
};
export type Utf16Offset = number & {
  readonly [utf16OffsetBrand]: true;
};
export type ChapterStatus = 'planned' | 'draft' | 'revision' | 'final';
export type FragmentType = 'seed' | 'generated' | 'user' | 'guided';
export type ContextStrategy = 'sliding' | 'full' | 'custom';

export interface Project {
  id: number;
  name: string;
  mode: ProjectMode;
  created_at: string;
  updated_at: string;
}

export interface Chapter {
  id: number;
  project_id: number;
  position: number;
  title: string;
  synopsis: string;
  content: string;
  status: ChapterStatus;
  summary_json: ChapterSummary | null;
  memory_summary?: string;
  memory_summary_tokens?: number;
  finalized_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChapterSummary {
  brief: string;
  plotPoints: string[];
  characterStates: string[];
  sceneChanges: string[];
}

export interface Fragment {
  id: number;
  project_id: number;
  position: number;
  type: FragmentType;
  content: string;
  created_at: string;
}

export interface Plotline {
  id: number;
  project_id: number;
  name: string;
  description: string;
  color: string;
}

export interface Note {
  id: number;
  project_id: number;
  collection_id?: number;
  title: string;
  content: string;
  max_tokens?: number;
  estimated_tokens?: number;
  created_at: string;
  updated_at: string;
  enabled_for_project?: number;
  collection_enabled?: number;
}

export interface Preset {
  id: number;
  project_id: number;
  name: string;
  is_default: number;
  system_prompt: string;
  writing_style: string;
  temperature: number;
  top_p: number;
  max_tokens: number;
  extra_instructions: string;
  enabled_for_project?: number;
}

export type LLMProviderType = 'openai_compatible' | 'llama_cpp';

export interface LLMConfig {
  id: number;
  name: string;
  provider_type: LLMProviderType;
  base_url: string;
  api_key: string;
  model_name: string;
  is_active: number;
  local_model_id: string | null;
  local_backend: 'auto' | 'gpu' | 'cpu' | null;
  context_window: number;
  max_output_tokens: number;
}

export interface WorldbookCollection {
  id: number;
  project_id: number;
  name: string;
  enabled: number;
  max_tokens: number;
  estimated_tokens: number;
  created_at: string;
}

export interface ContextConfig {
  strategy: ContextStrategy;
  slidingWindowSize: number;
  customRangeStart: number;
  customRangeEnd: number;
  resourceBudget: number;
  includeResources: boolean;
  summaryBudgetTokens?: number;
  storyStateBudgetTokens?: number;
  episodicMemoryBudgetTokens?: number;
  memoryPatchMaxTokens?: number;
  memoryTopK?: number;
  recentChapterCount?: number;
  worldbookRecursive?: boolean;
  worldbookScanDepth?: number;
}

export interface SummaryConfig {
  enableSummaryContext: boolean;
  summaryBudget: number;
  autoSummary: boolean;
}

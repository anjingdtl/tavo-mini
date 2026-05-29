export type ProjectMode = 'outline' | 'freeform';
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
  title: string;
  content: string;
  max_tokens?: number;
  estimated_tokens?: number;
  created_at: string;
  updated_at: string;
  enabled_for_project?: number;
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

export interface LLMConfig {
  id: number;
  base_url: string;
  api_key: string;
  model_name: string;
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

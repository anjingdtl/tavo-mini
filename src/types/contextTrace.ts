export type ContextSourceKind =
  | 'preset'
  | 'chapter'
  | 'memory'
  | 'story_memory'
  | 'story_memory_bridge'
  | 'character'
  | 'note'
  | 'worldbook'
  | 'instruction';

export interface ContextTraceItem {
  kind: ContextSourceKind;
  sourceId: number | null;
  title: string;
  reason: string;
  estimatedTokens: number;
  included: boolean;
  clipped: boolean;
  /** No eligible source exists for this category (not a context-budget trim). */
  empty?: boolean;
  preview: string;
}

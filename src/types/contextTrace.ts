export type ContextSourceKind =
  | 'preset'
  | 'chapter'
  | 'memory'
  | 'story_memory'
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
  preview: string;
}

export type DraftTargetType = 'chapter' | 'freeform';

export type DraftSource = 'pipeline' | 'continuation' | 'manual';

export interface GenerationDraft {
  id: number;
  projectId: number;
  targetType: DraftTargetType;
  targetId: number;
  content: string;
  source: DraftSource;
  pipelineTaskId: string | null;
  tokenCount: number;
  createdAt: string;
}

export type RevisionTargetType = 'chapter' | 'freeform';

export type RevisionSource =
  | 'manual_checkpoint'
  | 'before_clear'
  | 'before_ai_replace'
  | 'before_pipeline_accept'
  | 'before_restore'
  | 'before_batch_replace'
  | 'before_import_replace';

export interface ContentRevision {
  id: number;
  projectId: number;
  targetType: RevisionTargetType;
  targetId: number;
  title: string;
  content: string;
  source: RevisionSource;
  sourceRef: string | null;
  createdAt: string;
}

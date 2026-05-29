export type PipelineStageName = 'draft' | 'review' | 'factCheck' | 'proof';

export type PipelineTaskStatus =
  | 'idle'
  | 'drafting'
  | 'reviewing'
  | 'proofing'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface PipelineConfig {
  draftPresetId: number | null;
  reviewPresetId: number | null;
  factCheckPresetId: number | null;
  proofPresetId: number | null;
  draftMaxTokens: number;
  reviewMaxTokens: number;
  factCheckMaxTokens: number;
  proofMaxTokens: number;
}

export interface PipelineStageResult {
  stage: PipelineStageName;
  text: string;
  status: 'success' | 'failed';
  error?: string;
  tokens?: { input: number; output: number; total: number };
  durationMs: number;
}

export interface PipelineTask {
  id: string;
  targetType: 'chapter' | 'freeform';
  targetId: number;
  status: PipelineTaskStatus;
  stageResults: PipelineStageResult[];
  finalText: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

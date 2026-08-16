/**
 * Canonical continuation writing input types (Kernel Final Closure).
 *
 * These types describe the PRE-FREEZE input contract for continuation
 * chapters. They previously lived in the legacy continuation generation
 * runner; production code must import them from here.
 */
import type { ChatMessage } from '../../llm/types';

export interface StageLlmCallResult {
  text: string;
  usage?: { prompt?: number; completion?: number };
  finishReason?: string | null;
  emptyReason?:
    | 'length'
    | 'content_filter'
    | 'reasoning_only'
    | 'no_choices'
    | 'empty';
}

export type StageLlmCaller = (input: {
  stage: string;
  messages: ChatMessage[];
  maxTokens: number;
  configId: number | null;
  responseFormat?: 'json_object' | 'text';
}) => Promise<StageLlmCallResult>;

export interface StartContinuationRunInput {
  projectId: number;
  chapterId: number;
  targetPosition: number;
  userInstruction: string;
  currentChapterContent: string;
  modelContextLimit?: number;
  maxOutputTokens?: number;
  /** Test injector — skips real LLM. */
  callStage?: StageLlmCaller;
  /** Skip checker LLM (deterministic only). */
  deterministicOnly?: boolean;
  /** Test/compatibility escape hatch for historical V2 fixtures. */
  workflowVersion?: 2 | 4 | 5;
  /** Optional batch lineage metadata; observability only. */
  batchTraceId?: string | null;
  chapterOrdinal?: number | null;
  chapterCount?: number | null;
}

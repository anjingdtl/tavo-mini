/**
 * V3 quality-first workflow types (Implementation plan §2, §4, §5).
 *
 * These extend — but never replace — the V1/V2 types in `types.ts`. V3 adds:
 *  - workflowVersion 3;
 *  - frozen DeepSeek thinking policy;
 *  - V3 Writer plan beat with per-beat char targets;
 *  - V3 token-usage telemetry shape with physical request accounting.
 *
 * V1/V2 types stay untouched so historical runs keep resuming with their
 * original semantics (plan §4.1).
 */

/** Continuation workflow protocol version (plan §4.1). */
export type ContinuationWorkflowVersion = 2 | 3;

/** Reasoning effort levels supported by DeepSeek V4 (plan §2.2). */
export type ReasoningEffort = 'low' | 'high' | 'max';

/**
 * Frozen, non-secret model capability policy (plan §5.2). DeepSeek V4 new runs
 * freeze `thinkingPolicy.required = true` with `reasoningEffort: 'high'`.
 * Resume never re-derives this from the live model name.
 */
export interface FrozenThinkingPolicy {
  required: boolean;
  type: 'enabled';
  reasoningEffort: 'high';
}

/** V3 Writer plan beat — extends V2 StoryBeat with a per-beat char target. */
export interface ContinuationV3PlanBeat {
  order: number;
  summary: string;
  targetHanCharacters: number;
}

/**
 * V3 Integrated Reviser output contract (plan §4.5). The reviser returns the
 * FULL revised chapter, never an offset patch.
 */
export interface ContinuationV3ReviserPayload {
  schemaVersion: 1;
  content: string;
}

export type V3StageName =
  | 'writer'
  | 'initial_checker'
  | 'integrated_reviser'
  | 'final_checker';

export type V3AttemptKind =
  | 'initial'
  | 'transport_retry'
  | 'format_fallback'
  | 'provider_retry';

/** Per-physical-request telemetry row (plan §4.3). No prompt/body/key fields. */
export interface ContinuationV3RequestMetric {
  ordinal: 1 | 2 | 3 | 4;
  stage: V3StageName;
  attemptKind: V3AttemptKind;
  reservedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  estimatedPromptTokens?: number;
  requestedMaxTokens?: number;
  promptTokens?: number;
  reasoningTokens?: number;
  completionTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  finishReason?: string | null;
  emptyReason?: string | null;
  outcome: 'reserved' | 'succeeded' | 'failed';
  errorCode?: string;
}

/** Per-stage aggregated metrics (plan §4.3). */
export interface ContinuationV3StageMetrics {
  stage: V3StageName;
  requestOrdinals: number[];
  promptTokens?: number;
  reasoningTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  finishReason?: string | null;
  emptyReason?: string | null;
  outcome: 'pending' | 'succeeded' | 'failed' | 'skipped';
  warning?: string;
}

export interface ContinuationV3LocalGateMetrics {
  stage: 'local_initial_gate' | 'local_final_gate';
  lengthStatus: 'within' | 'under' | 'over';
  actualHanCharacters: number;
  duplicateStatus: 'within' | 'suspicious' | 'blocking';
  hardBlockingSubtypes: string[];
  outcome: 'pending' | 'passed' | 'failed';
}

/**
 * Full V3 token-usage telemetry (plan §4.3). Persisted into
 * `token_usage_json`. Never contains prompt text, body, reasoning原文, API key
 * or provider full error responses.
 */
export interface ContinuationV3TokenUsage {
  workflowVersion: 3;
  physicalRequestCount: number;
  maxPhysicalRequests: 4;
  requests: ContinuationV3RequestMetric[];
  stages: {
    writer?: ContinuationV3StageMetrics;
    initialChecker?: ContinuationV3StageMetrics;
    integratedReviser?: ContinuationV3StageMetrics;
    finalChecker?: ContinuationV3StageMetrics;
    localInitialGate?: ContinuationV3LocalGateMetrics;
    localFinalGate?: ContinuationV3LocalGateMetrics;
  };
}

/** Hard cap on physical HTTP fetches per V3 run (plan §2.4). */
export const MAX_CONTINUATION_V3_PHYSICAL_REQUESTS = 4;

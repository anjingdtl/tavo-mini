/**
 * Unified post-Freeze stage contract (Kernel Final Closure §6 / §10).
 *
 * Every production writing run — outline and continuation alike — is driven
 * by the SAME kernel stage loop. The loop consumes the single authoritative
 * `FrozenWritingContext` and advances one durable step at a time through a
 * `WritingStageDriver`. Scenario differences are bound BEFORE Freeze (source
 * adapters pick the durable substrate); the engine below never inspects the
 * scenario to choose writers, reviewers, budgets, prompts or finalizers.
 */
import type {
  FrozenWritingContext,
  WritingKernelStage,
  WritingKernelTrace,
} from './frozenWritingContext';
import type {
  WritingRequirementResult,
  WritingRequirements,
} from './writingRequirement';
import type {
  FrozenStageModelConfig,
  WritingStagePolicy,
  SharedWritingStageName,
} from './writingPolicy';
import type { SemanticApplyCheckInput } from '../stages/semanticApply';

/** Durable substrate hosting checkpoints/artifacts for a run. Bound
 * pre-Freeze by the scenario adapter and frozen into the run contract. */
export type WritingDurableBinding =
  | 'outline-pipeline-tasks'
  | 'continuation-generation-ledger';

/** Stage-level notification surfaced by a driver after each durable step. */
export interface WritingStageNotification {
  stage: WritingKernelStage;
  /** Durable action that produced this notification (trace metadata only). */
  action: string;
  status: 'started' | 'completed' | 'blocked' | 'skipped';
  detail?: string;
  /** Present when status === 'skipped': the frozen policy rule that formally
   * skipped the stage (One-Shot profile). skipped ≠ completed/failed/queued. */
  skipReason?: string;
  policyRuleId?: string;
}

/** The authoritative Freeze snapshot handed to the engine exactly once.
 * The durable trace is the authority; `frozenContext` may be null only for
 * envelopes frozen by builds older than the Kernel Final Closure (their
 * trace still pins every fingerprint). */
export interface WritingFreezeBinding {
  frozenContext: FrozenWritingContext | null;
  trace: WritingKernelTrace;
}

export type WritingStepOutcome =
  | ({ kind: 'freeze' } & WritingFreezeBinding)
  | ({ kind: 'stage' } & WritingStageNotification)
  | { kind: 'progress'; detail: string }
  | {
      kind: 'terminal';
      reason:
        | 'completed'
        | 'failed'
        | 'cancelled'
        | 'blocked'
        | 'waiting'
        | 'budget-paused';
      result?: unknown;
      error?: unknown;
    }
  /** Driver asked the engine to stop looping without a terminal state
   * (e.g. persisted wait_retry handed back to a watchdog). */
  | { kind: 'stop' };

/**
 * Advances ONE durable stage step per call. Implementations must:
 *  - read planning state from the durable substrate (never live sources);
 *  - re-use the already-frozen request/plan (no context rebuild);
 *  - surface the authoritative freeze exactly once via a `freeze` outcome.
 */
export interface WritingStageDriver {
  readonly durableBinding: WritingDurableBinding;
  step(): Promise<WritingStepOutcome>;
  /** Release locks / foreground ownership. Always invoked by the engine. */
  finalize(): Promise<void>;
}

export interface WritingStageExecutionInput {
  frozenContext: FrozenWritingContext;
  emitStage: (
    stage: WritingKernelStage,
    status: 'started' | 'completed' | 'blocked',
    detail?: string,
  ) => void;
}

export type SharedWritingStage = SharedWritingStageName;
export type { SharedWritingStageName };

export type WritingStageArtifacts = Record<string, unknown>;

export interface SharedWritingArtifact {
  stage: SharedWritingStageName;
  body: string;
  structured?: Record<string, unknown>;
  appliedRequirementIds?: string[];
  validNoOpRequirementIds?: string[];
  validNoOpReasons?: Record<string, string>;
  diagnostics?: string[];
  formatterUsed?: boolean;
  adoptedFrom?: 'content' | 'reasoning' | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    promptCacheHitTokens?: number | null;
    promptCacheMissTokens?: number | null;
    logicalStageCallCount?: number;
    formatterCallCount?: number;
    physicalRequestCount?: number;
    protocolFallbackCount?: number;
  };
}

/** Durable control only. Must never compile writer prompts or call the LLM. */
export interface WritingDurablePersistAdapter {
  binding: WritingDurableBinding;
  loadExisting?(stage: SharedWritingStageName): Promise<SharedWritingArtifact | null>;
  reserve?(stage: SharedWritingStageName): Promise<void>;
  persistStageArtifact(
    stage: SharedWritingStageName,
    artifact: SharedWritingArtifact,
  ): Promise<void>;
  persistStageFailure?(
    stage: SharedWritingStageName,
    error: unknown,
  ): Promise<void>;
  /**
   * Persist a FORMAL skip (e.g. One-Shot profile) so the durable ledger never
   * leaves a policy-skipped stage stuck in `queued`. Must NOT issue any model
   * request or write an empty artifact pretending the stage executed.
   */
  persistStageSkip?(
    stage: SharedWritingStageName,
    result: SharedWritingStageResult,
  ): Promise<void>;
  persistFinal?(artifacts: WritingStageArtifacts): Promise<void>;
}

export interface SharedWritingStageInput<TArtifacts extends WritingStageArtifacts = WritingStageArtifacts> {
  frozenContext: FrozenWritingContext;
  artifacts: TArtifacts;
  requirements: WritingRequirements;
  stagePolicy: WritingStagePolicy;
  modelConfig: FrozenStageModelConfig;
  trace: WritingKernelTrace;
  semanticApply?:
    | SemanticApplyCheckInput
    | (() => Promise<SemanticApplyCheckInput>);
  persistAdapter?: WritingDurablePersistAdapter;
  /** Test-only LLM transport override. Not a scenario writer. */
  callStage?: import('../scenario/continuationWritingTypes').StageLlmCaller;
  abortSignal?: AbortSignal;
}

export interface SharedWritingStageResult<T = unknown> {
  stage: SharedWritingStage;
  status: 'completed' | 'blocked' | 'failed' | 'skipped';
  artifact?: T;
  diagnostics: string[];
  error?: unknown;
  skipReason?: string;
  policyRuleId?: string;
  requirementResult: WritingRequirementResult;
}

/** Post-writing domain updates run as plugins after Persist (plan §11.2). */
export interface PersistedWritingRunResult {
  writingRunId: string;
  generationTraceId: string;
  projectId: number;
  chapterId: number;
  durableBinding: WritingDurableBinding;
}

export interface PostWritingUpdatePlugin {
  name: string;
  /** Plugins may select on frozen contract facts (e.g. source kinds). */
  appliesTo(frozen: FrozenWritingContext): boolean;
  execute(result: PersistedWritingRunResult): Promise<void>;
}

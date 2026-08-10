/**
 * Frozen pipeline execution configuration.
 *
 * Captured once when a pipeline task starts so resume / cold-start recovery
 * never re-reads live settings (pipelineMode, stage budgets, presets, model).
 */
import type { PipelineMode, PipelineReasoningEffort, PipelineStageName } from './pipeline';
import type { PipelineReasoningTier } from '../services/pipeline/reasoningPolicy';

export type FinalReviserReasoningPolicyVersion = 1 | 2 | 3;

/** Snapshot of a resolved preset at task start (content, not just id). */
export interface FrozenPresetSnapshot {
  id: number | null;
  name?: string;
  system_prompt: string;
  writing_style: string;
  extra_instructions: string;
  temperature: number;
  top_p: number;
  max_tokens: number;
}

/** Snapshot of the LLM request config used for this task. */
export interface FrozenModelSnapshot {
  llmConfigId: number;
  name?: string;
  provider?: string;
  modelName: string;
  contextWindow: number;
  maxOutputTokens?: number;
}

export interface FrozenStageReasoning {
  stage: PipelineStageName;
  requestedTier: PipelineReasoningTier;
  effectiveTier: PipelineReasoningTier;
  thinking: 'enabled' | 'disabled';
  /** Provider-facing effort. Current Review/FactCheck are low; Brief follows the tier. */
  effort: PipelineReasoningTier | null;
  /** Whether this frozen provider/model advertised explicit reasoning support. */
  supported?: boolean;
  downgradeReason?: string;
}

export interface FrozenStageBudgetV3 {
  stage: PipelineStageName;
  visibleOutputFloor: number;
  reasoningHeadroom: number;
  requestMaxTokens: number;
  estimatedMandatoryInput: number;
  optionalInputBudget: number;
  safetyMargin: number;
  softInputLimit?: number;
  hardInputLimit?: number;
  fitsSoftInput?: boolean;
  /** Whether the frozen provider/output cap can hold visible + Thinking. */
  fitsModelOutput?: boolean;
  /** Brief only: use deterministic local compiler when false. */
  localFallbackRecommended?: boolean;
}

/**
 * Full execution config frozen at task start.
 * Resume MUST use this instead of getPipelineConfig() / getActiveLLMConfig().
 */
export interface PipelineExecutionSnapshot {
  pipelineMode: PipelineMode;

  /**
   * Outline pipeline request protocol version frozen at task start.
   * undefined / 1 → Legacy Review / FactCheck / Proof.
   * 2 → Anchored Review / FactCheck + Revision Contract + Final Reviser
   *      + Local Final Artifact Validator.
   * Decided once at first execution-snapshot freeze; resume must never
   * re-read the live default. New snapshots MUST carry this field; only
   * parsing of HISTORICAL snapshots interprets a missing value as 1.
   */
  outlineWorkflowVersion?: 1 | 2 | 3 | 4;

  /**
   * Context-budget strategy version frozen at task start (Schema 44+).
   * undefined / 1 → Legacy budget; 2–4 → historical elastic protocols;
   * 5 → current independent elastic reservation for all five stages.
   * Frozen with the workflow version; resume must never re-read the live
   * default. Missing on historical snapshots → Legacy (1).
   */
  contextBudgetVersion?: 1 | 2 | 3 | 4 | 5;

  /**
   * Frozen Final Reviser reasoning policy. Missing / 1 is historical Legacy;
   * new Outline V2 snapshots explicitly carry 2.
   */
  finalReviserReasoningPolicyVersion?: FinalReviserReasoningPolicyVersion;

  /** Frozen V2 product tier applied to Draft / Review / FactCheck / Proof. */
  reasoningEffort?: PipelineReasoningEffort;

  /** V3 product profile and per-stage frozen effective tiers. */
  reasoningProfileVersion?: 1 | 2 | 3 | 4 | 5;
  requestedReasoningTier?: PipelineReasoningTier;
  stageReasoning?: Partial<Record<PipelineStageName, FrozenStageReasoning>>;
  briefPolicyVersion?: 1 | 2 | 3 | 4;
  briefVisibleOutputFloor?: number;
  briefReasoningHeadroom?: number;
  briefMaxTokens?: number;
  stageBudgets?: FrozenStageBudgetV3[];

  draftMaxTokens: number;
  reviewMaxTokens: number;
  factCheckMaxTokens: number;
  proofMaxTokens: number;

  draftPresetId: number | null;
  reviewPresetId: number | null;
  factCheckPresetId: number | null;
  proofPresetId: number | null;

  draftPreset: FrozenPresetSnapshot | null;
  reviewPreset: FrozenPresetSnapshot | null;
  factCheckPreset: FrozenPresetSnapshot | null;
  proofPreset: FrozenPresetSnapshot | null;

  model: FrozenModelSnapshot;

  createdAt: number;
}

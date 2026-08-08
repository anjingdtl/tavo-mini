/**
 * Frozen pipeline execution configuration.
 *
 * Captured once when a pipeline task starts so resume / cold-start recovery
 * never re-reads live settings (pipelineMode, stage budgets, presets, model).
 */
import type { PipelineMode } from './pipeline';

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
   * re-read the live default. No schema migration (stored in
   * pipeline_context_json).
   */
  outlineWorkflowVersion?: 1 | 2;

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

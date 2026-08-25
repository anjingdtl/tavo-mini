/**
 * Single durable pipeline state machine entry.
 *
 * runChapterPipeline / resumePipeline are thin wrappers over this loop.
 * Each iteration reloads SQLite-backed state, plans via
 * determineNextPipelineAction, CAS-claims when needed, executes one action,
 * awaits persistence, then plans again.
 */
import * as db from '../database';
import { one } from '../../data/connection/query';
import {
  resolveLLMRequestConfig,
  type LLMRequestConfig,
} from '../llm';
import { runSharedOutlineWriterAction } from '../writing/execution/runOutlineSharedWriterAction';
import {
  computeInputFingerprint,
  OutlineContextError,
} from '../outlineContextBuilder';
import { assertWriterStyleProjectionFits } from './stageResourceContextV5';
import type {
  FrozenPresetSnapshot,
  PipelineExecutionSnapshot,
} from '../../types/pipelineExecution';
import type { FrozenWriterStyleV1 } from '../writerStyle/types';
import { resolveActiveWriterStyle } from '../writerStyle/activeStyleResolver';
import {
  applyPipelineReasoningBudget,
  normalizePipelineReasoningEffort,
  normalizePipelineReasoningTier,
  resolveV3StageReasoning,
  resolveV31StageReasoning,
  resolveV32StageReasoning,
  resolveV33StageReasoning,
} from './reasoningPolicy';
import { deriveGenerationQualityProfile } from '../writing/contracts/generationQualityProfile';
import {
  buildPostDraftAuditContextFromFrozen,
  captureFrozenAuditCandidates,
} from '../postDraftRetrieval';
import { usePipelineTaskStore } from '../../store/pipelineTaskStore';
import { saveDraft } from '../draftService';
import { createGenerationTraceId } from './generationTrace';
import { PipelineForeground } from '../../native/PipelineForegroundModule';
import {
  allocateOutlinePipelineBudgetV3,
  buildSharedStageMaxOutputTokens,
  cloneDefaultOutlinePipelineBudgetPolicyV3,
  resolveElasticStageOutputReservation,
  resolveOutlineElasticStageReservations,
} from '../contextAutoAllocator';
import { deriveDefaultSafetyMargin } from './budgetAllocator';
import type { Chapter, Preset } from '../../types/novel';
import type {
  PipelineConfig,
  PipelineMode,
  PipelineReasoningEffort,
  PipelineStageName,
} from '../../types/pipeline';
import type { PipelineReasoningTier } from './reasoningPolicy';
import {
  parsePersistedPipelineTaskContext,
  serializePipelineTaskContext,
  hasFrozenWriterStyleProjection,
  type ParsedPipelineTaskContext,
} from '../pipelineTaskContext';
import { determineNextPipelineAction } from './determineNextPipelineAction';
import {
  determineRetryDisposition,
  type RetryDisposition,
} from './determineNextPipelineAction';
import { buildPersistedTaskView, resolveStageCheckpoints } from './taskView';
import { compileDraftStageRequest } from './compileStageRequest';
import {
  adaptOutlineWritingSources,
  resolveOutlineWritingSourceContext,
} from '../writing/scenario/outlineWritingAdapter';
import { buildWritingKernelFreezeTrace } from '../writing/unifiedWritingKernel';
import { freezeWritingModelConfig } from '../writing/contracts/freezeModelConfig';
import { resolveWritingCredential } from '../writing/stages/resolveFrozenCredential';
import type {
  FrozenWritingContext,
  WritingKernelTrace,
} from '../writing/contracts/frozenWritingContext';
import type { WritingRequest } from '../writing/contracts/writingSource';
import { isOneShotStagePolicy } from '../writing/contracts/executionProfile';
import { mapOutlineErrorToPipelineError } from './errors';
import type { PipelineAction } from './types';
import {
  isCurrentOutlinePipelineContextBudgetVersion,
  isCompactPipelineTopology,
  isStructuredContextBudgetVersion,
  isStructuredOutlineWorkflowVersion,
  normalizePersistedContextBudgetVersion,
  pipelineTopologyLabel,
  shouldIncludeBriefCheckpoint,
} from './outlineWorkflowVersion';
import {
  getStageAttempts,
} from '../../data/repositories/pipelineStageAttemptRepository';
import { setBatchUsageFromRuns } from '../../data/repositories/multiChapterBatchRepository';
import { getContextAutomationPolicyV3 } from '../../data/repositories/contextAutoRepository';
import {
  isContextAutomationPolicyV3,
  hashContextAutomationPolicyV3,
  type ContextAutomationPolicyV3,
} from '../contextAutomationPolicy';
import {
  MAX_AUTO_RETRY_ATTEMPTS,
} from '../llm/requestPolicy';

export type StageInfo = {
  stage: PipelineStageName | 'idle';
  label: string;
  startedAt: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Stage → checkpoint stage mapping for auto-retry. */
const ACTION_TO_STAGE: Record<string, PipelineStageName | undefined> = {
  run_draft: 'draft',
  run_review: 'review',
  run_fact_check: 'factCheck',
  run_review_and_fact_check: 'review',
  run_brief: 'brief',
  run_proof: 'proof',
};

/** The provider answered, but the structured business contract was unusable. */
export const PIPELINE_RESPONSE_INVALID_ERROR_CODE = 'PIPELINE_RESPONSE_INVALID';

/** Next attempt sequence number for a task+stage (persisted count + 1). */
function getErrorMessage(error: any, fallback: string): string {
  return error?.message ? String(error.message) : fallback;
}

function freezePreset(preset: Preset | null): FrozenPresetSnapshot | null {
  if (!preset) return null;
  return {
    id: preset.id ?? null,
    name: (preset as any).name,
    system_prompt: preset.system_prompt || '',
    writing_style: preset.writing_style || '',
    extra_instructions: preset.extra_instructions || '',
    temperature: Number(preset.temperature ?? 0.7),
    top_p: Number(preset.top_p ?? 0.9),
    max_tokens: Number(preset.max_tokens ?? 0),
  };
}

function presetFromFrozen(frozen: FrozenPresetSnapshot | null): Preset | null {
  if (!frozen) return null;
  return {
    id: frozen.id ?? 0,
    project_id: 0,
    name: frozen.name || '',
    is_default: 0,
    system_prompt: frozen.system_prompt,
    writing_style: frozen.writing_style,
    extra_instructions: frozen.extra_instructions,
    temperature: frozen.temperature,
    top_p: frozen.top_p,
    max_tokens: frozen.max_tokens,
  };
}

function resolvePreset(
  presetId: number | null,
  presets: Preset[],
): Preset | null {
  if (presetId != null) {
    const found = presets.find(p => p.id === presetId);
    if (found) return found;
  }
  return presets[0] || null;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildExecutionSnapshot(params: {
  config: PipelineConfig;
  draftPreset: Preset | null;
  reviewPreset: Preset | null;
  factCheckPreset: Preset | null;
  proofPreset: Preset | null;
  writerStyle?: FrozenWriterStyleV1;
  requestConfig: LLMRequestConfig;
  outlineWorkflowVersion?: 1 | 2 | 3 | 4;
  contextBudgetVersion?: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  contextAutomationPolicyV3?: ContextAutomationPolicyV3;
  reasoningProfileVersion?: 1 | 2 | 3 | 4 | 5;
  finalReviserReasoningPolicyVersion?: 1 | 2 | 3;
  reasoningEffort?: PipelineConfig['reasoningEffort'];
  executionProfile?: PipelineConfig['executionProfile'];
  generationQualityProfile?: PipelineConfig['generationQualityProfile'];
}): PipelineExecutionSnapshot {
  const contextWindow = Number(params.requestConfig.context_window) || 0;
  if (!(contextWindow > 0)) {
    throw new OutlineContextError(
      'OUTLINE_MODEL_UNAVAILABLE',
      '当前模型未配置有效上下文窗口，无法冻结流水线执行配置。',
      'open_llm_settings',
    );
  }
  const llmConfigId = Number(params.requestConfig.id);
  if (!Number.isInteger(llmConfigId) || llmConfigId <= 0) {
    throw new OutlineContextError(
      'OUTLINE_MODEL_UNAVAILABLE',
      '当前没有可用的模型配置，无法启动流水线。',
      'open_llm_settings',
    );
  }
  // Structured-pipeline predicates are owned by outlineWorkflowVersion
  // (Closure Plan §5). Version 6 (V3 hierarchical) is structured exactly like
  // 5 (same stages / reasoning profile / Brief); only the contextBuilder
  // budget path differs (>= 6 → hierarchical allocator).
  const isStructuredWorkflow = isStructuredOutlineWorkflowVersion(
    params.outlineWorkflowVersion,
  );
  const isV3 =
    isStructuredWorkflow &&
    Number(params.outlineWorkflowVersion) === 3 &&
    (Number(params.contextBudgetVersion) === 3 ||
      Number(params.contextBudgetVersion) === 4);
  const isV4 =
    isStructuredWorkflow &&
    Number(params.outlineWorkflowVersion) === 4 &&
    isStructuredContextBudgetVersion(params.contextBudgetVersion);
  const isCurrentElasticBudget =
    Number(params.outlineWorkflowVersion) === 4 &&
    isCurrentOutlinePipelineContextBudgetVersion(params.contextBudgetVersion);
  const isStructured = isV3 || isV4;
  const reasoningProfileVersion = isV4
    ? 5
    : isV3
    ? params.contextBudgetVersion === 4 || params.reasoningProfileVersion === 4
      ? 4
      : params.reasoningProfileVersion === 2
      ? 2
      : 3
    : undefined;
  const requestedTier = isStructured
    ? normalizePipelineReasoningTier(
        params.reasoningEffort ?? params.config.reasoningEffort,
      )
    : undefined;
  const stageReasoning =
    isStructured && requestedTier
      ? (Object.fromEntries(
          (['draft', 'review', 'factCheck', 'brief', 'proof'] as const).map(
            stage => {
              const resolved =
                reasoningProfileVersion === 2
                  ? resolveV3StageReasoning(
                      requestedTier,
                      stage,
                      params.requestConfig,
                    )
                : reasoningProfileVersion === 3
                  ? resolveV31StageReasoning(
                      requestedTier,
                      stage,
                      params.requestConfig,
                    )
                  : reasoningProfileVersion === 4
                  ? resolveV32StageReasoning(
                      requestedTier,
                      stage,
                      params.requestConfig,
                    )
                  : resolveV33StageReasoning(
                      requestedTier,
                      stage,
                      params.requestConfig,
                    );
              return [
                stage,
                {
                  stage,
                  requestedTier: resolved.requestedTier,
                  effectiveTier: resolved.effectiveTier,
                  thinking: resolved.thinking.type,
                  effort: resolved.effort,
                  supported: resolved.supported,
                  downgradeReason: resolved.downgradeReason,
                },
              ];
            },
          ),
        ) as PipelineExecutionSnapshot['stageReasoning'])
      : undefined;
  const briefVisibleOutputFloor = isStructured
    ? clampNumber(
        Number(params.config.briefVisibleOutputFloor) || 1200,
        768,
        2048,
      )
    : undefined;
  const briefReasoningHeadroom = isStructured
    ? clampNumber(
        Number(params.config.briefReasoningHeadroom) || 1200,
        1024,
        2048,
      )
    : undefined;
  const briefMaxTokens = isStructured
    ? resolveElasticStageOutputReservation({
        contextWindow,
        modelMaxOutputTokens: params.requestConfig.max_output_tokens,
      })
    : undefined;
  const stageBudgets =
    isStructured && requestedTier
      ? (() => {
          const budgetPolicy = cloneDefaultOutlinePipelineBudgetPolicyV3();
          const briefHeadroom = briefReasoningHeadroom || 1200;
          budgetPolicy.stages.brief.reasoningHeadroom = {
            low: briefHeadroom,
            high: briefHeadroom,
            max: briefHeadroom,
          };
          const allocation = allocateOutlinePipelineBudgetV3({
            contextWindow,
            requestedTier,
            modelMaxOutputTokens: params.requestConfig.max_output_tokens,
            requestMaxTokenOverrides: isCurrentElasticBudget
              ? resolveOutlineElasticStageReservations({
                  contextWindow,
                  modelMaxOutputTokens: params.requestConfig.max_output_tokens,
                })
              : { brief: briefMaxTokens },
            visibleOutputFloors: isCurrentElasticBudget
              ? { brief: briefVisibleOutputFloor || 1200 }
              : {
                  draft: Math.max(1, params.config.draftMaxTokens),
                  review: Math.max(1, params.config.reviewMaxTokens),
                  factCheck: Math.max(1, params.config.factCheckMaxTokens),
                  brief: briefVisibleOutputFloor || 1200,
                  proof: Math.max(
                    1024,
                    Math.ceil(params.config.draftMaxTokens * 1.2) + 256,
                  ),
                },
            policy: budgetPolicy,
          });
          return (
            ['draft', 'review', 'factCheck', 'brief', 'proof'] as const
          ).map(stage => {
            const item = allocation.stages[stage];
            return {
              stage,
              visibleOutputFloor: item.visibleOutputFloor,
              reasoningHeadroom: item.reasoningHeadroom,
              requestMaxTokens: item.requestMaxTokens,
              estimatedMandatoryInput: item.estimatedMandatoryInputTokens,
              optionalInputBudget: item.optionalInputBudget,
              safetyMargin: item.safetyReserveTokens,
              softInputLimit: item.softInputLimit,
              hardInputLimit: item.hardInputLimit,
              fitsSoftInput: item.fitsSoftInput,
              fitsModelOutput: item.fitsModelOutput,
              localFallbackRecommended: item.localFallbackRecommended,
            };
          });
        })()
      : undefined;
  const frozenStageMax = (stage: PipelineStageName, fallback: number): number =>
    stageBudgets?.find(item => item.stage === stage)?.requestMaxTokens ||
    fallback;
  return {
    ...(params.writerStyle ? { writerStyle: params.writerStyle } : {}),
    pipelineMode: isV4 ? 'full' : params.config.pipelineMode,
    ...(params.outlineWorkflowVersion
      ? { outlineWorkflowVersion: params.outlineWorkflowVersion }
      : {}),
    ...(params.contextBudgetVersion
      ? { contextBudgetVersion: params.contextBudgetVersion }
      : {}),
    ...(Number(params.contextBudgetVersion) === 6 &&
    params.contextAutomationPolicyV3 &&
    isContextAutomationPolicyV3(params.contextAutomationPolicyV3)
      ? {
          contextAutomationPolicyVersion: 'context-automation-v3' as const,
          contextAutomationPolicyHash: hashContextAutomationPolicyV3(
            params.contextAutomationPolicyV3,
          ),
          contextAutomationPolicySnapshot: JSON.parse(
            JSON.stringify(params.contextAutomationPolicyV3),
          ) as ContextAutomationPolicyV3,
        }
      : {}),
    ...(params.finalReviserReasoningPolicyVersion
      ? {
          finalReviserReasoningPolicyVersion:
            params.finalReviserReasoningPolicyVersion,
        }
      : {}),
    ...(params.reasoningEffort
      ? { reasoningEffort: params.reasoningEffort }
      : {}),
    // One-Shot (极速) profile frozen with the task: absent = standard so
    // historical envelope bytes stay identical. Resume never re-reads the
    // live setting.
    ...(params.executionProfile === 'one_shot'
      ? { executionProfile: 'one_shot' as const }
      : {}),
    ...(params.generationQualityProfile
      ? { generationQualityProfile: params.generationQualityProfile }
      : {}),
    ...(isStructured
      ? {
          reasoningProfileVersion: reasoningProfileVersion as 2 | 3 | 4 | 5,
          requestedReasoningTier: requestedTier,
          stageReasoning,
          briefPolicyVersion: (reasoningProfileVersion === 2
            ? 1
            : reasoningProfileVersion === 3
            ? 2
            : reasoningProfileVersion === 4
            ? 3
            : 4) as 1 | 2 | 3 | 4,
          briefVisibleOutputFloor,
          briefReasoningHeadroom,
          briefMaxTokens,
          stageBudgets,
        }
      : {}),
    draftMaxTokens: frozenStageMax('draft', params.config.draftMaxTokens),
    reviewMaxTokens: frozenStageMax('review', params.config.reviewMaxTokens),
    factCheckMaxTokens: frozenStageMax(
      'factCheck',
      params.config.factCheckMaxTokens,
    ),
    proofMaxTokens: frozenStageMax('proof', params.config.proofMaxTokens),
    draftPresetId: params.config.draftPresetId,
    reviewPresetId: params.config.reviewPresetId,
    factCheckPresetId: params.config.factCheckPresetId,
    proofPresetId: params.config.proofPresetId,
    draftPreset: freezePreset(params.draftPreset),
    reviewPreset: freezePreset(params.reviewPreset),
    factCheckPreset: freezePreset(params.factCheckPreset),
    proofPreset: freezePreset(params.proofPreset),
    model: {
      llmConfigId,
      name: params.requestConfig.name,
      provider: params.requestConfig.provider_type,
      modelName: params.requestConfig.model_name,
      url: params.requestConfig.url,
      contextWindow,
      maxOutputTokens: params.requestConfig.max_output_tokens,
      allowInsecureLanHttp: params.requestConfig.allow_insecure_lan_http,
      thinking: params.requestConfig.thinking,
    },
    createdAt: Date.now(),
  };
}

function configFromExecution(
  execution: PipelineExecutionSnapshot,
): PipelineConfig {
  return {
    pipelineMode: execution.pipelineMode,
    activeWriterStyleId: execution.writerStyle?.assetId || null,
    reasoningEffort: execution.reasoningEffort,
    executionProfile: execution.executionProfile,
    generationQualityProfile: execution.generationQualityProfile,
    reasoningProfileVersion: execution.reasoningProfileVersion,
    draftPresetId: execution.draftPresetId,
    reviewPresetId: execution.reviewPresetId,
    factCheckPresetId: execution.factCheckPresetId,
    proofPresetId: execution.proofPresetId,
    draftMaxTokens: execution.draftMaxTokens,
    reviewMaxTokens: execution.reviewMaxTokens,
    factCheckMaxTokens: execution.factCheckMaxTokens,
    proofMaxTokens: execution.proofMaxTokens,
    briefVisibleOutputFloor: execution.briefVisibleOutputFloor,
    briefReasoningHeadroom: execution.briefReasoningHeadroom,
  };
}

function requestConfigFromExecution(
  execution: PipelineExecutionSnapshot,
): LLMRequestConfig {
  const model = execution.model;
  return {
    id: model.llmConfigId,
    name: model.name,
    provider_type:
      (model.provider as LLMRequestConfig['provider_type']) ||
      'openai_compatible',
    api_key: '',
    url: model.url || '',
    model_name: model.modelName,
    context_window: model.contextWindow,
    max_output_tokens: model.maxOutputTokens,
    allow_insecure_lan_http: model.allowInsecureLanHttp,
    thinking: model.thinking,
  };
}

function isAbortError(error: any, abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted || error?.code === 'cancelled');
}

/** BN-11/CL-10: foreground ownership is CALL-LEVEL state (options), never a
 *  module global — two concurrent tasks (single-chapter A + batch B) must not
 *  pollute each other's notification ownership. Batch-owned tasks suppress
 *  per-task PipelineForeground calls; the batch owns the single aggregated
 *  notification. Single-chapter mode defaults to 'task'. */

/**
 * BN-04 / CL-06: hard batch budget gate. Read the batch's durable caps and
 * CURRENT usage (re-aggregated from pipeline_stage_attempts right before the
 * check — never stale adoption-time counters), estimate the worst-case cost
 * for the upcoming stage, and throw a typed error BEFORE any HTTP attempt
 * row is created. The error carries the batch + stage context so the
 * reconciler can pause the batch correctly.
 *
 * The real gate is `used + upcoming <= cap` (plan §9):
 *   usedCalls + 1          <= maxLlmCalls
 *   usedInput + estimated  <= maxInputTokens
 *   usedOutput + reserved  <= maxOutputTokens
 *
 * When a cap is null (uncapped) we skip the check. `estimatedInputTokens` /
 * `reservedOutputTokens` come from the compiled stage request; callers that
 * cannot provide them pass 0 (the call-count gate still applies).
 */

export class BatchBudgetExceededError extends Error {
  readonly code: 'BATCH_BUDGET_EXCEEDED';
  readonly batchId: string;
  readonly stage: string;
  readonly cap: 'calls' | 'input' | 'output';
  constructor(
    batchId: string,
    stage: string,
    cap: BatchBudgetExceededError['cap'],
    message: string,
  ) {
    super(message);
    this.name = 'BatchBudgetExceededError';
    this.code = 'BATCH_BUDGET_EXCEEDED';
    this.batchId = batchId;
    this.stage = stage;
    this.cap = cap;
  }
}

export async function assertBatchBudgetAvailable(params: {
  batchId: string;
  stage: string;
  estimatedInputTokens?: number;
  reservedOutputTokens?: number;
}): Promise<void> {
  const { batchId, stage } = params;
  const row = await one(
    `SELECT max_llm_calls, max_input_tokens, max_output_tokens,
            used_llm_calls, used_input_tokens, used_output_tokens
     FROM multi_chapter_batches WHERE id = ?`,
    [batchId],
  );
  if (!row) return; // batch vanished — caller will surface the missing-state error.
  const maxLlmCalls =
    row.max_llm_calls != null ? Number(row.max_llm_calls) : null;
  const maxInput =
    row.max_input_tokens != null ? Number(row.max_input_tokens) : null;
  const maxOutput =
    row.max_output_tokens != null ? Number(row.max_output_tokens) : null;

  // CL-06: re-aggregate usage from the durable attempt history so used_*
  // reflects every attempt that already happened — never the adoption-time
  // counters (they lag by a whole chapter).
  let usedLlmCalls = Number(row.used_llm_calls ?? 0);
  let usedInput = Number(row.used_input_tokens ?? 0);
  let usedOutput = Number(row.used_output_tokens ?? 0);
  try {
    const fresh = await setBatchUsageFromRuns(batchId);
    usedLlmCalls = fresh.llmCalls;
    usedInput = fresh.inputTokens;
    usedOutput = fresh.outputTokens;
  } catch {
    // non-fatal: the counters we already read are used as a fallback; the
    // attempt row itself remains the audit source of truth.
  }

  const estimatedInput = Math.max(0, Number(params.estimatedInputTokens ?? 0));
  const reservedOutput = Math.max(0, Number(params.reservedOutputTokens ?? 0));

  // used + upcoming <= cap — the real hard gate (not just used < cap).
  if (maxLlmCalls != null && usedLlmCalls + 1 > maxLlmCalls) {
    throw new BatchBudgetExceededError(
      batchId,
      stage,
      'calls',
      `批次 LLM 调用将超上限（已用 ${usedLlmCalls} + 本次 1 > ${maxLlmCalls}），已暂停第 ${stage} 阶段请求。`,
    );
  }
  if (maxInput != null && usedInput + estimatedInput > maxInput) {
    throw new BatchBudgetExceededError(
      batchId,
      stage,
      'input',
      `批次输入 token 将超上限（已用 ${usedInput} + 预计 ${estimatedInput} > ${maxInput}），已暂停第 ${stage} 阶段请求。`,
    );
  }
  if (maxOutput != null && usedOutput + reservedOutput > maxOutput) {
    throw new BatchBudgetExceededError(
      batchId,
      stage,
      'output',
      `批次输出 token 将超上限（已用 ${usedOutput} + 预留 ${reservedOutput} > ${maxOutput}），已暂停第 ${stage} 阶段请求。`,
    );
  }
}

/** CL-06: re-aggregate batch usage after an attempt terminal state so used_*
 *  reflects every attempt that already happened (never adoption-time lag). */
export async function refreshBatchUsage(
  gate: { batchId: string } | undefined,
): Promise<void> {
  if (!gate) return;
  try {
    await setBatchUsageFromRuns(gate.batchId);
  } catch {
    // non-fatal: the attempt row remains the audit source of truth and the
    // next request's gate re-aggregates before checking.
  }
}

export function cancelled(taskId: string, options: ReconcileOptions): boolean {
  if (options.abortSignal?.aborted) return true;
  if (options.isCancelled?.(taskId)) {
    usePipelineTaskStore.getState().cancelTask(taskId);
    return true;
  }
  return false;
}

/**
 * Abort handling shared by every stage executor and the outer loop:
 * - user cancel (isCancelled set): terminate the task (cancelled).
 * - pause interrupt (abort signal only): keep the task recoverable — the
 *   running checkpoint is already `interrupted`, resume reuses succeeded
 *   stages and re-fetches from the frozen request.
 */
export async function settleInterruptedTask(
  taskId: string,
  options: ReconcileOptions,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  if (options.isCancelled?.(taskId)) {
    store.cancelTask(taskId);
  } else {
    if (store.persistTaskStatus) {
      await store.persistTaskStatus(taskId, 'interrupted');
    } else {
      store.setTaskStatus(taskId, 'interrupted');
    }
  }
}


export function oneShotOutlineSkipStages(options?: {
  compact?: boolean;
}): Array<{
  stage: PipelineStageName;
  text: string;
  policyRuleId: string;
}> {
  if (options?.compact) {
    return [
      {
        stage: 'qa',
        text: '极速模式已跳过 ONE QA（profile.one_shot.skip_qa）',
        policyRuleId: 'profile.one_shot.skip_qa',
      },
      {
        stage: 'brief',
        text: '极速模式已跳过条件 Revision（profile.one_shot.skip_revision）',
        policyRuleId: 'profile.one_shot.skip_revision',
      },
    ];
  }
  return [
    {
      stage: 'qa',
      text: '极速模式已跳过 ONE QA（profile.one_shot.skip_qa）',
      policyRuleId: 'profile.one_shot.skip_qa',
    },
    {
      stage: 'review',
      text: '极速模式已跳过 AI 审阅（profile.one_shot.skip_review）',
      policyRuleId: 'profile.one_shot.skip_review',
    },
    {
      stage: 'factCheck',
      text: '极速模式已跳过 AI 事实核查（profile.one_shot.skip_factCheck）',
      policyRuleId: 'profile.one_shot.skip_factCheck',
    },
    {
      stage: 'brief',
      text: '极速模式已跳过 Brief 修订（profile.one_shot.skip_revision）',
      policyRuleId: 'profile.one_shot.skip_revision',
    },
    {
      stage: 'proof',
      text: '极速模式已跳过终审润色（profile.one_shot.skip_proof）',
      policyRuleId: 'profile.one_shot.skip_proof',
    },
  ];
}

async function persistSkipped(
  taskId: string,
  stage: PipelineStageName,
  text: string,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  if (store.persistTaskStage) {
    await store.persistTaskStage(taskId, {
      stage,
      text,
      status: 'skipped',
      durationMs: 0,
    });
  } else {
    store.updateTaskStage(taskId, {
      stage,
      text,
      status: 'skipped',
      durationMs: 0,
    });
  }
}

async function loadRuntime(
  taskId: string,
  chapter: Chapter,
): Promise<{
  parsed: ParsedPipelineTaskContext | null;
  config: PipelineConfig;
  requestConfig: LLMRequestConfig;
  draftPreset: Preset | null;
  reviewPreset: Preset | null;
  factCheckPreset: Preset | null;
  proofPreset: Preset | null;
  writerStyle: FrozenWriterStyleV1 | null;
}> {
  const store = usePipelineTaskStore.getState();
  const task = store.tasks.find(t => t.id === taskId);
  let parsed: ParsedPipelineTaskContext | null = null;
  if (task?.pipelineContextJson) {
    try {
      parsed = parsePersistedPipelineTaskContext(task, {
        expectedProjectId: chapter.project_id,
        expectedChapterId: chapter.id,
      });
    } catch (error) {
      // Stability Phase 3 (Plan §5): a task that already owns a frozen
      // envelope must NEVER silently fall back to live business state —
      // that would re-freeze from changed data and drift this generation's
      // semantics without any diagnostic. Fail closed instead.
      throw new OutlineContextError(
        'SNAPSHOT_PARSE_FAILED',
        `冻结上下文解析失败：${getErrorMessage(
          error,
          '未知错误',
        )}。已阻止回退到实时数据，请重新开始生成。`,
        'restart_task',
      );
    }
  }

  if (parsed?.execution) {
    const requestConfig = requestConfigFromExecution(parsed.execution);
    requestConfig.api_key = await resolveWritingCredential({
      kind: 'llm-config-api-key',
      configId: parsed.execution.model.llmConfigId,
    });
    return {
      parsed,
      config: configFromExecution(parsed.execution),
      requestConfig,
      draftPreset: presetFromFrozen(parsed.execution.draftPreset),
      reviewPreset: presetFromFrozen(parsed.execution.reviewPreset),
      factCheckPreset: presetFromFrozen(parsed.execution.factCheckPreset),
      proofPreset: presetFromFrozen(parsed.execution.proofPreset),
      writerStyle: parsed.execution.writerStyle || null,
    };
  }

  const config = await db.getPipelineConfig({
    projectId: chapter.project_id,
    includeHistoricalMode: Number(task?.outlineWorkflowVersion) === 2,
  });
  const presets = (await db.getPresetsByProject(
    chapter.project_id,
  )) as Preset[];
  const requestConfig = await resolveLLMRequestConfig();
  const activeStyle = await resolveActiveWriterStyle(
    chapter.project_id,
    config.activeWriterStyleId ?? null,
  );
  return {
    parsed,
    config,
    requestConfig,
    draftPreset: activeStyle.draftPreset,
    reviewPreset: resolvePreset(config.reviewPresetId, presets),
    factCheckPreset: resolvePreset(config.factCheckPresetId, presets),
    proofPreset: resolvePreset(config.proofPresetId, presets),
    writerStyle: activeStyle.writerStyle,
  };
}

function assertProtectedWriterStyleFits(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
  stage: 'draft' | 'review' | 'factCheck' | 'brief' | 'proof',
  contextWindow: number,
  reservedOutputTokens: number,
): void {
  const snapshot = runtime.parsed?.draftContext;
  if (hasFrozenWriterStyleProjection(snapshot)) {
    assertWriterStyleProjectionFits(
      snapshot,
      stage,
      Math.max(0, contextWindow - reservedOutputTokens - deriveDefaultSafetyMargin(contextWindow)),
    );
    return;
  }
  const projection = runtime.writerStyle?.stageProjections[stage];
  if (projection && projection.estimatedTokens > Math.max(0, contextWindow - reservedOutputTokens - deriveDefaultSafetyMargin(contextWindow))) {
    const error = new Error(`WRITER_STYLE_OVER_BUDGET：${stage} 作家风格超出 Protected 输入预算。`);
    (error as Error & { code?: string }).code = 'WRITER_STYLE_OVER_BUDGET';
    throw error;
  }
}

async function actionPersistInitialSnapshot(
  taskId: string,
  chapter: Chapter,
  abortSignal: AbortSignal | undefined,
  options: ReconcileOptions,
): Promise<void> {
  if (cancelled(taskId, options)) return;
  const store = usePipelineTaskStore.getState();
  // Fire the project lookup in parallel with loadRuntime so first-freeze never
  // adds a serial DB round-trip to the microtask chain.
  const runtime = await loadRuntime(taskId, chapter);
  // Resolve the protocol versions ONCE at first freeze from the TASK ROW
  // (frozen at task creation). Resume never re-reads live project mode /
  // defaults: frozen tasks keep their version. Missing or unparseable row
  // values fail closed to V1. New snapshots always carry both fields.
  // snapshots interprets an absent field as 1.
  const existingExecution = runtime.parsed?.execution;
  let outlineWorkflowVersion: 1 | 2 | 3 | 4;
  let contextBudgetVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  if (existingExecution) {
    outlineWorkflowVersion =
      existingExecution.outlineWorkflowVersion === 4
        ? 4
        : existingExecution.outlineWorkflowVersion === 3
        ? 3
        : existingExecution.outlineWorkflowVersion === 2
        ? 2
        : 1;
    contextBudgetVersion = normalizePersistedContextBudgetVersion(
      existingExecution.contextBudgetVersion,
    );
  } else {
    const taskRow = store.tasks.find(t => t.id === taskId);
    outlineWorkflowVersion =
      Number(taskRow?.outlineWorkflowVersion) === 4
        ? 4
        : Number(taskRow?.outlineWorkflowVersion) === 3
        ? 3
        : Number(taskRow?.outlineWorkflowVersion) === 2
        ? 2
        : 1;
    contextBudgetVersion = normalizePersistedContextBudgetVersion(
      taskRow?.contextBudgetVersion,
    );
  }
  const isStructured = shouldIncludeBriefCheckpoint({
    outlineWorkflowVersion,
    contextBudgetVersion,
  });
  // Fresh freeze from live config only when no execution yet. V2 preserves its
  // historical multiplier; V3 stores requested/effective stage tiers and uses
  // independent output + reasoning reservations.
  const selectedReasoningEffort =
    options.pipelineReasoningEffortOverride !== undefined
      ? options.pipelineReasoningEffortOverride
      : isStructured
      ? normalizePipelineReasoningTier(runtime.config.reasoningEffort)
      : normalizePipelineReasoningEffort(runtime.config.reasoningEffort);
  // One-Shot (极速) profile: batch-owned first runs may freeze the batch's
  // profile; otherwise the global setting applies. Resume keeps the frozen
  // execution snapshot and never consults this selection again.
  const selectedExecutionProfile =
    options.pipelineExecutionProfileOverride !== undefined &&
    options.pipelineExecutionProfileOverride !== null
      ? options.pipelineExecutionProfileOverride
      : runtime.config.executionProfile;
  const selectedQualityProfile = deriveGenerationQualityProfile({
    qualityProfile: runtime.config.generationQualityProfile,
    executionProfile: selectedExecutionProfile,
    reasoningEffort: selectedReasoningEffort,
  });
  const freshConfig =
    isStructured && !existingExecution && selectedReasoningEffort
      ? {
          ...runtime.config,
          pipelineMode:
            outlineWorkflowVersion === 4 ? ('full' as const) : runtime.config.pipelineMode,
          reasoningEffort: normalizePipelineReasoningTier(
            selectedReasoningEffort,
          ),
          reasoningProfileVersion:
            outlineWorkflowVersion === 4
              ? (5 as const)
              : contextBudgetVersion === 4
              ? (4 as const)
              : (3 as const),
        }
      : outlineWorkflowVersion === 2 &&
        !existingExecution &&
        selectedReasoningEffort
      ? applyPipelineReasoningBudget(
          runtime.config,
          normalizePipelineReasoningEffort(selectedReasoningEffort),
        )
      : outlineWorkflowVersion === 2 &&
        !existingExecution &&
        options.pipelineReasoningEffortOverride === null
      ? { ...runtime.config, reasoningEffort: undefined }
      : runtime.config;

  // Read the persisted V3 policy ONCE at first freeze so the actual user
  // policy (not the default preset) drives the hierarchical allocator. On a
  // resume, prefer the policy already frozen in the execution/context
  // snapshot; never replace it with a newly edited live setting. Batch-owned
  // callers may provide the batch header snapshot as the final fallback for
  // historical V6 rows that predate execution-policy persistence.
  const persistedExecutionPolicy = existingExecution?.contextAutomationPolicySnapshot;
  const persistedContextPolicy =
    runtime.parsed?.draftContext?.contextBudgetV3Summary
      ?.contextAutomationPolicySnapshot;
  let frozenV3Policy: ContextAutomationPolicyV3 | undefined =
    persistedExecutionPolicy && isContextAutomationPolicyV3(persistedExecutionPolicy)
      ? persistedExecutionPolicy
      : persistedContextPolicy && isContextAutomationPolicyV3(persistedContextPolicy)
      ? persistedContextPolicy
      : options.contextAutomationPolicyV3 &&
        isContextAutomationPolicyV3(options.contextAutomationPolicyV3)
      ? options.contextAutomationPolicyV3
      : undefined;
  if (!frozenV3Policy && !existingExecution && contextBudgetVersion === 6) {
    try {
      const persistedPolicy = await getContextAutomationPolicyV3();
      if (persistedPolicy && isContextAutomationPolicyV3(persistedPolicy)) {
        frozenV3Policy = persistedPolicy;
      }
    } catch {
      // Settings read failure: buildContext falls back to the default policy.
    }
  }
  const execution =
    runtime.parsed?.execution ||
    buildExecutionSnapshot({
      config: freshConfig,
      draftPreset: runtime.draftPreset,
      reviewPreset: runtime.reviewPreset,
      factCheckPreset: runtime.factCheckPreset,
      proofPreset: runtime.proofPreset,
      writerStyle: runtime.writerStyle || undefined,
      requestConfig: runtime.requestConfig,
      outlineWorkflowVersion,
      contextBudgetVersion,
      contextAutomationPolicyV3: frozenV3Policy,
      finalReviserReasoningPolicyVersion:
        outlineWorkflowVersion === 4 || outlineWorkflowVersion === 3
          ? 3
          : outlineWorkflowVersion === 2
          ? 2
          : 1,
      reasoningProfileVersion:
      outlineWorkflowVersion === 4
          ? 5
          : outlineWorkflowVersion === 3
          ? contextBudgetVersion === 4
            ? 4
            : freshConfig.reasoningProfileVersion === 2
            ? 2
            : 3
          : undefined,
      reasoningEffort:
        outlineWorkflowVersion === 2 || outlineWorkflowVersion === 3 || outlineWorkflowVersion === 4
          ? freshConfig.reasoningEffort
          : undefined,
      executionProfile:
        selectedExecutionProfile === 'one_shot' ? 'one_shot' : undefined,
      generationQualityProfile: selectedQualityProfile,
    });
  // Batch-owned first run: the batch form's mode wins over the global
  // pipeline setting. Resume never overrides a frozen snapshot.
  if (
    options.pipelineModeOverride &&
    !runtime.parsed?.execution &&
    outlineWorkflowVersion !== 4
  ) {
    execution.pipelineMode = options.pipelineModeOverride;
  }

  assertProtectedWriterStyleFits(
    runtime,
    'draft',
    runtime.requestConfig.context_window || 0,
    execution.draftMaxTokens,
  );

  const compiled = await compileDraftStageRequest({
    chapter,
    requestConfig: runtime.requestConfig,
    draftPreset: runtime.draftPreset,
    writerStyleSnapshot: runtime.writerStyle || undefined,
    draftMaxTokens: execution.draftMaxTokens,
    // Story Memory is an enhancement, not a writing license. Freeze the
    // latest usable checkpoint and pending bridge here, but never make the
    // first Draft request wait for synchronous checkpoint maintenance. The
    // prepare step returns a durable degradation warning when coverage is
    // incomplete; Story Memory maintenance remains available through its own
    // flow / chapter finalization.
    storyMemoryMode: 'preview',
    // Drive the V3 hierarchical branch from the FROZEN task version so the
    // allocator actually runs for the pipeline draft (not just Preview), and
    // pass the frozen policy so allocation matches Preview = Send (Closure
    // Plan §14/§16). The elastic flag is a belt-and-suspenders fallback.
    contextBudgetVersion: execution.contextBudgetVersion,
    contextAutomationPolicyV3: frozenV3Policy,
    elasticBudget:
      execution.contextBudgetVersion === 2 ||
      execution.contextBudgetVersion === 3 ||
      execution.contextBudgetVersion === 4 ||
      execution.contextBudgetVersion === 5 ||
      execution.contextBudgetVersion === 6,
  });
  if (!compiled.ready) {
    const code =
      compiled.error.code === 'OUTLINE_TOO_LARGE'
        ? 'OUTLINE_OVER_BUDGET'
        : 'OUTLINE_CONTEXT_WINDOW_EXCEEDED';
    throw new OutlineContextError(
      code,
      compiled.error.message,
      compiled.error.userAction === 'open_outline'
        ? 'open_outlines'
        : 'restart_task',
    );
  }
  const pipelineContext = compiled.draftCompile!.pipelineContext;
  const frozenDraftRequest = compiled.frozenDraftRequest!;

  // Phase I source boundary: the existing outline compiler remains the
  // execution implementation for this phase, but its captured semantic input
  // is now normalized through the same Writing Source Contract used by
  // Continuation. No downstream stage reads this adapter as a control branch.
  //
  // The compiler may legitimately produce an empty outlineText when a chapter
  // is driven only by its frozen title/synopsis. The Adapter must still run in
  // that case; skipping it would silently remove the Source/Kernel Trace from
  // the durable task context. The chapter definition is the explicit fallback
  // source, with its own deterministic fingerprint.
  const sourceContext = resolveOutlineWritingSourceContext({
    chapter,
    context: {
      presetText: pipelineContext.presetText,
      storyMemoryText: pipelineContext.storyMemoryText,
      characterText: pipelineContext.characterText,
      noteText: pipelineContext.noteText,
      worldbookText: pipelineContext.worldbookText,
      episodicMemoryText: pipelineContext.episodicMemoryText,
      recentBridgeText: pipelineContext.recentBridgeText,
      outlineText: pipelineContext.outlineText,
      outlineFingerprint: pipelineContext.outlineFingerprint,
      outlineIds: pipelineContext.outlineIds,
      outlineComplete: pipelineContext.outlineComplete,
      writerStyleText: pipelineContext.writerStyleSnapshot
        ? JSON.stringify(pipelineContext.writerStyleSnapshot)
        : undefined,
    },
  });
  const sourceInput = adaptOutlineWritingSources({
    projectId: chapter.project_id,
    chapter,
    context: sourceContext,
  });
  pipelineContext.writingSourceTrace = sourceInput.trace;
  const kernelRequest: WritingRequest = {
    writingRunId: `wr_${taskId}`,
    generationTraceId: options.generationTraceId ?? createGenerationTraceId(),
    projectId: chapter.project_id,
    chapterId: chapter.id,
    scenario: 'outline',
    instruction: {
      title: chapter.title || '',
      synopsis: chapter.synopsis || '',
      userInstruction: chapter.synopsis || chapter.title || '完成本章写作。',
      currentContent: chapter.content || '',
      targetPosition: chapter.position,
    },
    sourceBundle: sourceInput.bundle,
    model: freezeWritingModelConfig({
      configId: runtime.requestConfig.id ?? null,
      provider: runtime.requestConfig.provider_type,
      modelName: runtime.requestConfig.model_name,
      url: runtime.requestConfig.url,
      name: runtime.requestConfig.name,
      contextWindow: runtime.requestConfig.context_window,
      maxOutputTokens: runtime.requestConfig.max_output_tokens,
      allowInsecureLanHttp: runtime.requestConfig.allow_insecure_lan_http,
      thinking: runtime.requestConfig.thinking,
      reasoningEffort: execution.reasoningEffort,
    }),
    policy: {
      version: 1,
      reviewMode: execution.pipelineMode,
      strictness: 'fail-closed',
      values: {
        contextBudgetVersion: execution.contextBudgetVersion,
        outlineStageReasoning: execution.stageReasoning,
        ...(execution.executionProfile === 'one_shot'
          ? { executionProfile: 'one_shot' as const }
          : {}),
        ...(execution.generationQualityProfile
          ? { qualityProfile: execution.generationQualityProfile }
          : {}),
        // §5.2: freeze the topology label into the kernel freeze from the
        // TASK ROW (frozen at creation); never the live default.
        pipelineTopologyVersion: pipelineTopologyLabel(
          usePipelineTaskStore
            .getState()
            .tasks.find(task => task.id === taskId)?.pipelineTopologyVersion,
        ),
        sharedStageMaxOutputTokens: buildSharedStageMaxOutputTokens({
          contextWindow: Number(runtime.requestConfig.context_window) || 0,
          modelMaxOutputTokens: runtime.requestConfig.max_output_tokens,
          outlineStageBudgets: execution.stageBudgets,
        }),
      },
    },
  };
  const kernelFreeze = buildWritingKernelFreezeTrace({
    request: kernelRequest,
  });
  pipelineContext.writingKernelTrace = kernelFreeze.trace;
  pipelineContext.frozenWritingContext = kernelFreeze.frozenContext;

  // Freeze full-mode audit candidate pool at the same moment as draft context.
  let frozenAuditCandidates = runtime.parsed?.frozenAuditCandidates || null;
  if (execution.pipelineMode === 'full' && !frozenAuditCandidates) {
    const contextConfig = await db.getContextConfig();
    frozenAuditCandidates = await captureFrozenAuditCandidates(
      chapter,
      chapter.project_id,
      contextConfig,
      { contextBudgetVersion: execution.contextBudgetVersion },
    );
  }

  await store.persistTaskPipelineContext(
    taskId,
    serializePipelineTaskContext({
      draftContext: pipelineContext,
      execution,
      frozenDraftRequest,
      frozenAuditCandidates,
      trace: {
        version: 1,
        generationTraceId: options.generationTraceId ?? createGenerationTraceId(),
        createdAt: Date.now(),
      },
    }),
  );
  void abortSignal;
}

async function actionBuildAuditContext(
  taskId: string,
  chapter: Chapter,
  options: ReconcileOptions,
): Promise<void> {
  if (cancelled(taskId, options)) return;
  const store = usePipelineTaskStore.getState();
  const runtime = await loadRuntime(taskId, chapter);
  if (!runtime.parsed?.draftContext || !runtime.parsed.execution) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '无法构建审核上下文：缺少冻结快照。',
      'restart_task',
    );
  }
  const draftText = await getDraftText(taskId);
  if (!draftText) {
    throw new Error('无法构建审核上下文：缺少初稿正文');
  }

  let auditContext = runtime.parsed.draftContext;
  let auditFellBack = false;

  // Full mode: only re-score within frozen candidate pool. Never re-query live DB.
  if (runtime.config.pipelineMode === 'full') {
    if (!runtime.parsed.frozenAuditCandidates) {
      throw new OutlineContextError(
        'OUTLINE_SNAPSHOT_INVALID',
        '缺少冻结审核候选集合，无法安全恢复审核上下文。请重新开始生成。',
        'restart_task',
      );
    }
    const retrieval = buildPostDraftAuditContextFromFrozen(
      runtime.parsed.draftContext,
      draftText,
      runtime.parsed.frozenAuditCandidates,
    );
    auditContext = retrieval.snapshot;
    auditFellBack = Boolean(retrieval.fellBack);
  }

  await store.persistTaskPipelineContext(
    taskId,
    serializePipelineTaskContext({
      draftContext: runtime.parsed.draftContext,
      auditContext,
      execution: runtime.parsed.execution,
      frozenDraftRequest: runtime.parsed.frozenDraftRequest,
      frozenAuditCandidates: runtime.parsed.frozenAuditCandidates,
      trace: runtime.parsed.trace,
      draftCompletedAt: Date.now(),
      auditContextCreatedAt: Date.now(),
      auditFellBack,
    }),
  );
}

async function getDraftText(taskId: string): Promise<string> {
  // Fail-closed: checkpoint read errors propagate.
  const row = await db.getStageCheckpoint(taskId, 'draft');
  if (row?.outputText) return row.outputText;
  const task = usePipelineTaskStore.getState().tasks.find(t => t.id === taskId);
  return (
    task?.stageResults.find(s => s.stage === 'draft' && s.status === 'success')
      ?.text || ''
  );
}

async function getStageText(
  taskId: string,
  stage: PipelineStageName,
): Promise<string> {
  const row = await db.getStageCheckpoint(taskId, stage);
  if (row?.status === 'succeeded' && row.outputText) return row.outputText;
  const task = usePipelineTaskStore.getState().tasks.find(t => t.id === taskId);
  return (
    task?.stageResults.find(s => s.stage === stage && s.status === 'success')
      ?.text || ''
  );
}

/** Model callers may only receive ReadyStageRequest. */
async function saveDraftBody(
  taskId: string,
  chapter: Chapter,
  text: string,
): Promise<void> {
  try {
    await saveDraft({
      projectId: chapter.project_id,
      targetType: chapter.id > 0 ? 'chapter' : 'freeform',
      targetId: chapter.id > 0 ? chapter.id : chapter.project_id,
      content: text,
      source: 'pipeline',
      pipelineTaskId: taskId,
    });
  } catch (error) {
    // Stability Phase 5: draft-history persistence is best-effort, but the
    // loss must be observable (plan §9) — a silent catch here hides data
    // loss from the user's generation history.
    console.warn(
      '[pipeline] PIPELINE_DRAFT_SAVE_FAILED:',
      taskId,
      (error as Error)?.message || error,
    );
  }
  try {
    const task = usePipelineTaskStore
      .getState()
      .tasks.find(t => t.id === taskId);
    const fpOutline =
      task?.pipelineContextJson != null
        ? parsePersistedPipelineTaskContext(task).draftContext
            .outlineFingerprint
        : '';
    const fingerprint = await computeInputFingerprint({
      projectId: chapter.project_id,
      chapterId: chapter.id,
      chapterUpdatedAt: chapter.updated_at,
      outlineFingerprint: fpOutline,
    });
    usePipelineTaskStore
      .getState()
      .setTaskInputFingerprint(taskId, fingerprint);
  } catch {
    /* */
  }
}

async function actionFinalizeFromDraft(
  taskId: string,
  chapter: Chapter,
  degraded: boolean,
  emitForeground = true,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  const draftText = await getDraftText(taskId);
  const runtime = await loadRuntime(taskId, chapter);
  const mode = runtime.config.pipelineMode;
  // The One-Shot (极速) profile froze its stage skips at Freeze time. The
  // outline state machine routes draft → finalize directly, so record the
  // formal skips here with the profile rule ids (no fake completed stages).
  const oneShot = runtime.parsed?.execution?.executionProfile === 'one_shot';
  if (oneShot) {
    const compact = isCompactPipelineTopology(
      store.tasks.find(item => item.id === taskId)?.pipelineTopologyVersion,
    );
    for (const skip of oneShotOutlineSkipStages({ compact })) {
      await persistSkipped(taskId, skip.stage, skip.text);
    }
  } else if (mode === 'noReview') {
    await persistSkipped(taskId, 'review', '无审核模式已跳过审阅/评估');
    await persistSkipped(taskId, 'factCheck', '无审核模式已跳过事实核查');
    await persistSkipped(taskId, 'brief', '无审核模式已跳过 Brief 整理');
    await persistSkipped(taskId, 'proof', '无审核模式已跳过终审校对');
  } else if (degraded) {
    // Do not leave proof pending — decision already made.
    // Never overwrite an already failed/succeeded proof checkpoint.
    const existingProof =
      store.tasks
        .find(x => x.id === taskId)
        ?.stageResults?.find(s => s.stage === 'proof') || null;
    if (
      !existingProof ||
      (existingProof.status !== 'failed' &&
        existingProof.status !== 'success' &&
        existingProof.status !== 'skipped')
    ) {
      await persistSkipped(taskId, 'proof', '前置阶段失败，未执行终审');
    }
    const existingBrief =
      store.tasks
        .find(x => x.id === taskId)
        ?.stageResults?.find(s => s.stage === 'brief') || null;
    if (
      !existingBrief ||
      (existingBrief.status !== 'failed' &&
        existingBrief.status !== 'success' &&
        existingBrief.status !== 'skipped')
    ) {
      await persistSkipped(taskId, 'brief', '前置阶段失败，未执行 Brief 整理');
    }
  }
  await saveDraftBody(taskId, chapter, draftText);
  if (degraded) {
    const t = store.tasks.find(x => x.id === taskId);
    const reviewFailed = t?.stageResults?.some(
      s => s.stage === 'review' && s.status === 'failed',
    );
    const factFailed = t?.stageResults?.some(
      s => s.stage === 'factCheck' && s.status === 'failed',
    );
    const proofFailed = t?.stageResults?.some(
      s => s.stage === 'proof' && s.status === 'failed',
    );
    let message = t?.error || '审核/终审失败，已保留初稿';
    if (reviewFailed && factFailed) {
      message = '文学评估与事实核查均失败，已保留初稿，未生成终审稿。';
    } else if (reviewFailed && !factFailed) {
      message = '文学评估失败，已保留初稿，未生成终审稿。';
    } else if (factFailed && !reviewFailed) {
      message = '事实核查失败，已保留初稿，未生成终审稿。';
    } else if (proofFailed) {
      message =
        t?.stageResults?.find(s => s.stage === 'proof' && s.status === 'failed')
          ?.error || '终审失败，已保留初稿，未生成终审稿。';
    }
    if (store.persistFailTask) {
      await store.persistFailTask(taskId, message);
    } else {
      store.failTask(taskId, message);
    }
    if (store.persistTaskFinalText) {
      await store.persistTaskFinalText(taskId, draftText);
    } else {
      store.setTaskFinalText(taskId, draftText);
    }
    if (emitForeground) {
      await PipelineForeground.notifyFailed(
        taskId,
        chapter.title || '流水线',
        message,
      );
      await PipelineForeground.updateProgress(taskId, '已保留初稿', 100);
    }
    await PipelineForeground.stop(taskId);
    return;
  }
  if (store.persistTaskFinalText) {
    await store.persistTaskFinalText(taskId, draftText);
  } else {
    store.setTaskFinalText(taskId, draftText);
  }
  if (emitForeground) {
    await PipelineForeground.updateProgress(taskId, '已完成校验，准备保存', 98);
  }
}

async function actionFinalizeFromProof(
  taskId: string,
  chapter: Chapter,
  emitForeground = true,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  const existing = store.tasks.find(item => item.id === taskId)?.stageResults || [];
  const has = (stage: PipelineStageName) =>
    existing.some(item => item.stage === stage);
  if (!has('factCheck')) {
    await persistSkipped(taskId, 'factCheck', '当前模式已跳过事实核查');
  }
  if (!has('brief')) {
    await persistSkipped(taskId, 'brief', '当前模式已跳过 Brief 整理');
  }
  if (!has('review')) {
    await persistSkipped(taskId, 'review', '当前模式已跳过审阅');
  }
  const proofText = await getStageText(taskId, 'proof');
  const text = proofText || (await getDraftText(taskId));
  await saveDraftBody(taskId, chapter, text);
  if (store.persistTaskFinalText) {
    await store.persistTaskFinalText(taskId, text);
  } else {
    store.setTaskFinalText(taskId, text);
  }
  if (emitForeground) {
    await PipelineForeground.updateProgress(taskId, '已完成校验，准备保存', 98);
  }
}

async function actionComplete(
  taskId: string,
  chapter: Chapter,
  emitForeground = true,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  const task = store.tasks.find(t => t.id === taskId);
  if (task?.status === 'completed') {
    await PipelineForeground.stop(taskId);
    return;
  }
  const text =
    task?.finalText ||
    (await getStageText(taskId, 'proof')) ||
    (await getDraftText(taskId)) ||
    '';
  if (store.persistCompleteTask) {
    await store.persistCompleteTask(taskId, text);
  } else {
    store.completeTask(taskId, text);
  }
  if (emitForeground) {
    await PipelineForeground.updateProgress(taskId, '已完成', 100);
    await PipelineForeground.notifyComplete(
      taskId,
      chapter.title || '流水线',
      '已写完，点击查看',
    );
  }
  await PipelineForeground.stop(taskId);
}

/**
 * One-Shot (极速) hard gate: a task frozen under the one_shot execution
 * profile must NEVER automatically re-request a failed stage — that would
 * be a second paid call for the same chapter. Resolution order: the
 * authoritative in-memory frozen context, then the durable envelope.
 */
function isOneShotReconcileTask(
  taskId: string,
  options: ReconcileOptions,
): boolean {
  if (options.frozenWritingContext?.stagePolicy) {
    if (isOneShotStagePolicy(options.frozenWritingContext.stagePolicy)) {
      return true;
    }
  }
  const task = usePipelineTaskStore
    .getState()
    .tasks.find(t => t.id === taskId);
  if (!task?.pipelineContextJson) return false;
  try {
    const envelope = JSON.parse(task.pipelineContextJson);
    if (envelope?.execution?.executionProfile === 'one_shot') return true;
    return isOneShotStagePolicy(
      envelope?.draftContext?.frozenWritingContext?.stagePolicy,
    );
  } catch {
    return false;
  }
}

const ONE_SHOT_NO_RETRY_MESSAGE =
  '极速生成失败。本模式不会自动重试或调用第二次模型，可手动重新生成，或切换至低/中/高档。';

export async function maybeAutoRetryStage(params: {
  taskId: string;
  stages: ReturnType<typeof resolveStageCheckpoints>;
  action: PipelineAction;
  options: ReconcileOptions;
}): Promise<'continue' | 'stop'> {
  const stage = ACTION_TO_STAGE[params.action.type];
  if (!stage) return 'continue';
  // One-Shot: auto retry would issue a second paid request for this chapter.
  // Leave the failed checkpoint in place so the state machine fails closed.
  if (isOneShotReconcileTask(params.taskId, params.options)) {
    return 'continue';
  }
  const checkpoint = params.stages.find(s => s.stage === stage);
  if (!checkpoint || checkpoint.status !== 'failed') return 'continue';
  const attempts = await getStageAttempts(params.taskId, stage);
  const latest = attempts[attempts.length - 1];
  if (!latest) return 'continue';
  if (latest.status !== 'safe_to_retry') return 'continue';
  if (latest.attemptNo > MAX_AUTO_RETRY_ATTEMPTS) return 'continue';
  const now = Date.now();
  const nextRetryAt = latest.nextRetryAt ?? now;
  if (nextRetryAt > now) {
    // Persisted schedule already durable; wait briefly then hand back if
    // still not due (batch/cold-start resume re-checks next_retry_at).
    const waitMs = Math.min(nextRetryAt - now, 15_000);
    await sleep(waitMs);
    if (params.options.abortSignal?.aborted) return 'stop';
    if (Date.now() < nextRetryAt) return 'stop';
  }
  // Reset checkpoint to pending so determineNextPipelineAction re-runs the
  // stage. Same frozen request: attempts are keyed per stage, and the stage
  // run path always reads the frozen request (never live data).
  await db.upsertStageCheckpoint({
    taskId: params.taskId,
    stage: stage as any,
    status: 'pending',
    errorCode: null,
    errorMessage: null,
    bumpAttempt: true,
  });
  return 'continue';
}

export interface ReconcileOptions {
  onStageUpdate?: (info: StageInfo | string) => void;
  abortSignal?: AbortSignal;
  isCancelled?: (taskId: string) => boolean;
  registerCancel?: (taskId: string) => void;
  /**
   * Batch-owned tasks execute with the mode chosen on the batch form; only
   * applied when no frozen execution snapshot exists yet (first run).
   */
  pipelineModeOverride?: PipelineMode;
  /** Batch-owned V2 tasks inherit the batch-frozen product tier on first run. */
  pipelineReasoningEffortOverride?:
    | PipelineReasoningEffort
    | PipelineReasoningTier
    | null;
  /**
   * Batch-owned tasks inherit the batch-frozen One-Shot (极速) execution
   * profile on first run. Applied only before an execution snapshot exists;
   * resume keeps the frozen value.
   */
  pipelineExecutionProfileOverride?: 'standard' | 'one_shot' | null;
  /** Batch-frozen V3 policy. A supplied snapshot disables live-policy reads. */
  contextAutomationPolicyV3?: ContextAutomationPolicyV3 | null;
  /**
   * BN-04: when set, every stage attempt is preceded by a hard batch-budget
   * check. Exceeding the cap throws BatchBudgetExceededError BEFORE any
   * HTTP request is issued and the batch reconciler pauses the item.
   */
  batchBudgetGate?: { batchId: string };
  /**
   * CL-10: call-level foreground ownership. 'batch' suppresses per-task
   * PipelineForeground notifications (the batch owns the aggregate).
   * Defaults to 'task'.
   */
  foregroundOwner?: 'task' | 'batch';
  /**
   * Stability Phase 1 — generation trace identity. Created by the public
   * entry (runChapterPipeline) and frozen into the persisted envelope at
   * first freeze; purely observational, never influences generation.
   */
  generationTraceId?: string;
  /**
   * In-memory authoritative Freeze for resume backfills that must not rewrite
   * a historical envelope. Shared writer actions read this first.
   */
  frozenWritingContext?: FrozenWritingContext | null;
  writingKernelTrace?: WritingKernelTrace;
}

/**
 * Pipeline protocol versions are FROZEN per task (task row columns + the
 * execution snapshot) — no module-level mutable flags, no live settings
 * reads. Concurrent tasks each read their own frozen versions; a global
 * boolean would let task A/B overwrite each other's strategy mid-process.
 */

const reconciling = new Set<string>();

export function acquireReconcileLock(taskId: string): boolean {
  if (reconciling.has(taskId)) return false;
  reconciling.add(taskId);
  return true;
}

export function releaseReconcileLock(taskId: string): void {
  reconciling.delete(taskId);
}

export async function reconcilePipelineTask(
  taskId: string,
  chapter: Chapter,
  options: ReconcileOptions = {},
): Promise<void> {
  if (reconciling.has(taskId)) {
    const err = new Error('任务已在运行') as Error & { code?: string };
    err.code = 'TASK_ALREADY_RUNNING';
    throw err;
  }
  reconciling.add(taskId);
  // CL-10: call-level (never module-global) foreground ownership. Defaults to
  // 'task' unless the caller (batch reconciler) declares 'batch'.
  const emitForeground = (options.foregroundOwner ?? 'task') === 'task';

  const store = usePipelineTaskStore.getState();
  const onStageUpdate = options.onStageUpdate;
  const abortSignal = options.abortSignal;

  // BN-11: batch-owned tasks defer all notifications to the single
  // batch-owned notification owned by the reconciler. Without this gate
  // every sub-task fires its own Android notification on top of the batch's.
  if (emitForeground) {
    PipelineForeground.start(
      taskId,
      chapter.title || '流水线',
      '正在准备写作',
      0,
    ).catch(() => {});
  }

  try {
    // Schema 39+: checkpoint rows are required. Fail-closed on DB errors.
    const initialTask = usePipelineTaskStore
      .getState()
      .tasks.find(t => t.id === taskId);
    const initialStages = shouldIncludeBriefCheckpoint({
      outlineWorkflowVersion: initialTask?.outlineWorkflowVersion,
      contextBudgetVersion: initialTask?.contextBudgetVersion,
    })
      ? ['draft', 'review', 'factCheck', 'brief', 'proof']
      : ['draft', 'review', 'factCheck', 'proof'];
    await db.ensurePendingCheckpoints(taskId, initialStages as any);

    // Bound iterations to avoid infinite loops on bugs.
    for (let step = 0; step < 32; step++) {
      if (cancelled(taskId, options)) {
        await PipelineForeground.stop(taskId);
        return;
      }

      // Reload memory projection; prefer DB checkpoints when available.
      const task = usePipelineTaskStore
        .getState()
        .tasks.find(t => t.id === taskId);
      if (!task) {
        throw new Error('找不到管线任务');
      }

      // Fail-closed: checkpoint query errors must not fall back to memory-only.
      const checkpointRows = await db.getStageCheckpoints(taskId);

      const stages = resolveStageCheckpoints({
        checkpointRows,
        stageResults: task.stageResults,
        outlineWorkflowVersion: task.outlineWorkflowVersion,
        contextBudgetVersion: task.contextBudgetVersion,
        pipelineTopologyVersion: task.pipelineTopologyVersion,
      });
      const view = buildPersistedTaskView(task);
      const action = determineNextPipelineAction(view, stages);

      // CL-01: a failed stage checkpoint with a persisted safe_retry /
      // rate_limit attempt must NOT be blocked terminally by STAGE_FAILED.
      // Consume the retry disposition first: waiting → hand back to the
      // UI/batch watchdog; retried → loop re-runs the stage; manual_* →
      // surface the distinct message instead of the generic failure.
      if (action.type === 'blocked' && action.reason.code === 'STAGE_FAILED') {
        const retry = await consumeFailedStageRetryDisposition({
          taskId,
          stage: action.reason.stage,
          options,
        });
        if (retry.outcome === 'waiting') return;
        if (retry.outcome === 'retried') continue;
        await handleBlocked(
          taskId,
          chapter,
          action,
          stages,
          retry.message,
          emitForeground,
        );
        return;
      }

      if (action.type === 'blocked') {
        await handleBlocked(
          taskId,
          chapter,
          action,
          stages,
          undefined,
          emitForeground,
        );
        return;
      }

      // Phase 3: persisted auto-retry gate (safe_retry/rate_limit only).
      // outcome_unknown never auto-retries; waiting_retry survives restarts
      // via the persisted next_retry_at.
      const retryResult = await maybeAutoRetryStage({
        taskId,
        stages,
        action,
        options,
      });
      if (retryResult === 'stop') {
        return;
      }

      // V2 proof resume (§6.5): a FAILED proof checkpoint with a persisted
      // safe_to_retry attempt must re-fire the SAME protocol proof instead of
      // degrading to draft immediately. The decision layer returns
      // finalize_from_draft (degraded) for proof failures, so consume the
      // retry disposition right before finalize: retried → loop re-runs the
      // proof stage with the frozen request; waiting → hand back (task stays
      // failed, watchdog/UI resumes later); none → degrade as designed.
      if (action.type === 'finalize_from_draft' && action.degraded === true) {
        const proofRetry = await consumeFailedStageRetryDisposition({
          taskId,
          stage: 'proof',
          options,
        });
        if (proofRetry.outcome === 'retried') continue;
        if (proofRetry.outcome === 'waiting') return;
      }

      const handled = await runOutlineDurableOperation({
        taskId,
        chapter,
        action,
        stages,
        onStageUpdate,
        abortSignal,
        options,
      });
      if (handled === 'stop') {
        return;
      }
      // 'continue' → loop and re-read SQLite
    }

    store.failTask(taskId, '流水线状态机步数超限，已停止以防死循环');
    await PipelineForeground.stop(taskId);
  } catch (error: any) {
    if (isAbortError(error, abortSignal) || cancelled(taskId, options)) {
      await settleInterruptedTask(taskId, options);
      await PipelineForeground.stop(taskId);
      return;
    }
    // A failed CAS claim means another executor owns the stage. It is a
    // non-terminal handoff, not a pipeline failure: marking the task failed
    // here would poison a cold-start resume and force the next finalization
    // path to treat an otherwise clean draft as permanently degraded.
    if (error?.code === 'TASK_ALREADY_RUNNING') {
      await PipelineForeground.stop(taskId);
      return;
    }
    // CL-06: batch budget gate errors must NOT be swallowed into a generic
    // failed task — the batch reconciler catches this typed error and pauses
    // the batch (paused_batch_budget). Swallowing it here would leave the
    // batch spinning on pause_unknown_outcome instead of the durable pause.
    if (error instanceof BatchBudgetExceededError) {
      throw error;
    }
    const mapped = mapOutlineErrorToPipelineError(error);
    const message = mapped?.message || getErrorMessage(error, '流水线执行失败');
    if (store.persistFailTask) {
      await store.persistFailTask(taskId, message);
    } else {
      store.failTask(taskId, message);
    }
    if (emitForeground) {
      await PipelineForeground.notifyFailed(
        taskId,
        chapter.title || '流水线',
        mapped?.message || '执行失败',
      );
    }
    await PipelineForeground.stop(taskId);
  } finally {
    reconciling.delete(taskId);
  }
}

/**
 * CL-01: consume the persisted retry disposition for a failed stage checkpoint
 * BEFORE `blocked(STAGE_FAILED)` is handled terminally.
 *
 * The pure decision lives in `determineRetryDisposition`; this function only
 * executes the durable transitions:
 *   - wait_retry  → sleep a bounded chunk; if still not due, hand back to the
 *                   UI / batch watchdog (the attempt row's next_retry_at is
 *                   already durable). If due during the wait, fall through to
 *                   reset the checkpoint and retry.
 *   - retry_now   → reset the checkpoint to pending with a bumped attempt
 *                   count so the loop re-runs the stage with the SAME frozen
 *                   request (never recompiled).
 *   - manual_*    → return the reason message so handleBlocked can surface it
 *                   instead of the generic STAGE_FAILED text.
 *   - fail        → no retry; STAGE_FAILED proceeds as before.
 */
export async function consumeFailedStageRetryDisposition(params: {
  taskId: string;
  stage?: string;
  options: ReconcileOptions;
}): Promise<
  | { outcome: 'waiting' }
  | { outcome: 'retried' }
  | { outcome: 'none'; message?: string }
> {
  const stage = params.stage;
  if (!stage) return { outcome: 'none' };
  // One-Shot: consuming a retry disposition would reset the checkpoint and
  // re-fire the stage — a second physical request. Fail closed instead.
  if (isOneShotReconcileTask(params.taskId, params.options)) {
    return { outcome: 'none', message: ONE_SHOT_NO_RETRY_MESSAGE };
  }
  const attempts = await getStageAttempts(params.taskId, stage);
  const latest = attempts[attempts.length - 1];
  if (!latest) return { outcome: 'none' };
  const disposition: RetryDisposition = determineRetryDisposition(latest);

  if (disposition.kind === 'fail') return { outcome: 'none' };
  if (
    disposition.kind === 'manual_pause' ||
    disposition.kind === 'manual_confirm'
  ) {
    return { outcome: 'none', message: disposition.message };
  }

  if (disposition.kind === 'wait_retry') {
    const waitMs = Math.min(
      Math.max(0, disposition.retryAt - Date.now()),
      15_000,
    );
    await sleep(waitMs);
    if (params.options.abortSignal?.aborted) return { outcome: 'waiting' };
    if (Date.now() < disposition.retryAt) return { outcome: 'waiting' };
    // Due during the bounded wait — reset and retry now.
  }

  // retry_now (or wait_retry became due): reset checkpoint → re-run the stage.
  await db.upsertStageCheckpoint({
    taskId: params.taskId,
    stage: stage as any,
    status: 'pending',
    errorCode: null,
    errorMessage: null,
    bumpAttempt: true,
  });
  return { outcome: 'retried' };
}

export async function handleBlocked(
  taskId: string,
  chapter: Chapter,
  action: Extract<PipelineAction, { type: 'blocked' }>,
  stages: ReturnType<typeof resolveStageCheckpoints>,
  messageOverride?: string,
  emitForeground = true,
): Promise<void> {
  const store = usePipelineTaskStore.getState();
  const code = action.reason.code;
  const message = messageOverride || action.reason.message;
  if (code === 'TASK_TERMINAL') {
    await PipelineForeground.stop(taskId);
    return;
  }
  if (code === 'TASK_ALREADY_RUNNING') {
    // Another executor owns a running stage — do not fail the task.
    await PipelineForeground.stop(taskId);
    return;
  }
  if (code === 'STAGE_FAILED' || code === 'TASK_NOT_RECOVERABLE') {
    if (store.persistFailTask) {
      await store.persistFailTask(taskId, message);
    } else {
      store.failTask(taskId, message);
    }
    if (emitForeground) {
      await PipelineForeground.notifyFailed(
        taskId,
        chapter.title || '流水线',
        message,
      );
    }
    await PipelineForeground.stop(taskId);
    return;
  }
  if (store.persistFailTask) {
    await store.persistFailTask(taskId, message);
  } else {
    store.failTask(taskId, message);
  }
  if (emitForeground) {
    await PipelineForeground.notifyFailed(
      taskId,
      chapter.title || '流水线',
      message,
    );
  }
  await PipelineForeground.stop(taskId);
  void stages;
}

/**
 * Outline-only capability provider used by the shared stage boundary.
 *
 * The shared Writing Kernel owns stage order, Freeze, requirement binding,
 * retries and trace events. This function is only the durable Outline
 * substrate adapter for the operation supplied to a shared stage; it is not
 * an alternate Writer Core or stage machine.
 */

export async function runOutlineDurableOperation(params: {
  taskId: string;
  chapter: Chapter;
  action: PipelineAction;
  stages: ReturnType<typeof resolveStageCheckpoints>;
  onStageUpdate?: (info: StageInfo | string) => void;
  abortSignal?: AbortSignal;
  options: ReconcileOptions;
}): Promise<'continue' | 'stop'> {
  const { taskId, chapter, action, onStageUpdate, abortSignal, options } =
    params;
  const store = usePipelineTaskStore.getState();

  switch (action.type) {
    case 'persist_initial_snapshot':
      await actionPersistInitialSnapshot(taskId, chapter, abortSignal, options);
      return 'continue';
    case 'run_draft':
    case 'run_review':
    case 'run_fact_check':
    case 'run_review_and_fact_check':
    // Phase 4 (二 §7.2 ONE QA): the compact Standard action dispatches the
    // unified qa kernel stage through the same shared writer path as the
    // legacy trio. Missing this case would drop run_qa into `default` and
    // fail every compact task at its first QA step.
    case 'run_qa':
    case 'run_brief':
    case 'run_proof':
      if (options.batchBudgetGate) {
        const taskRow = usePipelineTaskStore
          .getState()
          .tasks.find(item => item.id === taskId);
        let estimatedInputTokens = 0;
        let reservedOutputTokens = 0;
        try {
          const envelope = taskRow?.pipelineContextJson
            ? JSON.parse(taskRow.pipelineContextJson)
            : null;
          estimatedInputTokens = Number(
            envelope?.draftContext?.frozenWritingContext?.rendered
              ?.estimatedInputTokens || 0,
          );
          reservedOutputTokens = Number(
            envelope?.draftContext?.frozenWritingContext?.model
              ?.maxOutputTokens || 0,
          );
        } catch {
          estimatedInputTokens = 0;
        }
        await assertBatchBudgetAvailable({
          batchId: options.batchBudgetGate.batchId,
          stage: action.type,
          estimatedInputTokens,
          reservedOutputTokens,
        });
      }
      await runSharedOutlineWriterAction({
        taskId,
        chapter,
        action,
        onStageUpdate,
        abortSignal,
        options,
      });
      await refreshBatchUsage(options.batchBudgetGate);
      return 'continue';
    case 'build_audit_context':
      await actionBuildAuditContext(taskId, chapter, options);
      return 'continue';
    case 'finalize_from_draft':
      await actionFinalizeFromDraft(
        taskId,
        chapter,
        action.degraded === true,
        (options.foregroundOwner ?? 'task') === 'task',
      );
      return 'continue';
    case 'finalize_from_proof':
      await actionFinalizeFromProof(
        taskId,
        chapter,
        (options.foregroundOwner ?? 'task') === 'task',
      );
      return 'continue';
    case 'complete':
      await actionComplete(
        taskId,
        chapter,
        (options.foregroundOwner ?? 'task') === 'task',
      );
      return 'stop';
    case 'blocked':
      await handleBlocked(
        taskId,
        chapter,
        action,
        params.stages,
        undefined,
        (params.options.foregroundOwner ?? 'task') === 'task',
      );
      return 'stop';
    default:
      store.failTask(taskId, '未知流水线动作');
      await PipelineForeground.stop(taskId);
      return 'stop';
  }
}


export function isReconcileActive(taskId: string): boolean {
  return reconciling.has(taskId);
}

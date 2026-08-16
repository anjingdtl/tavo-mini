/**
 * Independent continuation generation runner (Spec §5, §9).
 * Does not reuse freeform PipelineStageName or pipeline_tasks as authority.
 */
import type { ChatMessage, LLMRequestConfig } from '../../../llm/types';
import {
  callLLMResult,
  resolveLLMRequestConfig,
  resolveLLMRequestConfigById,
} from '../../../llm';
import { stripModelJson } from '../../canon/canonJsonValidators';
import { buildContinuationContext } from '../continuationContextBuilder';
import {
  createContinuationGenerationTrace,
} from '../continuationGenerationTrace';
import {
  bindIssuesToArtifact,
  filterBySettings,
  parseCheckerLlmJson,
  runDeterministicChecks,
} from '../continuationChecker';
import type { RawCheckIssue } from '../continuationChecker';
import {
  compileCheckerMessages,
  compilePlannerMessages,
  compileRepairMessages,
  compileWriterMessages,
} from './continuationPromptCompiler';
import {
  shouldRunRepair,
  tryDeterministicRepair,
  tryDeterministicRepairWithReport,
} from '../continuationRepairService';
import {
  casUpdateRunState,
  getLatestArtifact,
  getPlan,
  getRunById,
  insertArtifact,
  insertCheckResults,
  insertRun,
  listChecksForArtifact,
  markChecksAutoRepaired,
  markChecksObsolete,
  newContinuationRunId,
  savePlan,
  ensureGenerationSettings,
} from '../generationRepository';
import type {
  ContinuationArtifact,
  ContinuationCheckResult,
  ContinuationContextSnapshot,
  ContinuationContextTrace,
  ContinuationGenerationRun,
  ContinuationPlan,
  ContinuationRunState,
  FrozenContinuationModelConfig,
} from '../types';
import {
  ContinuationCapabilityBlockedError,
  ContinuationOutdatedError,
} from '../types';
import { estimateMessagesTokens } from '../../../../utils/tokenEstimator';
import { activeContinuationControllers as activeControllers } from '../continuationRunControllers';
import {
  resumeContinuationV4Run,
  startContinuationV4Run,
} from './continuationV4Runner';
import {
  resumeContinuationV5Run,
  startContinuationV5Run,
} from './continuationV5Runner';
import {
  CONTINUATION_BUDGET_POLICY,
  planStageCapacity,
  resolveContinuationWriterOutputBudget,
  type ResolvedStageCapacity,
} from '../continuationContextBudget';
import { type ContinuationStageBudgets } from '../continuationContextBudget';
import {
  evaluateContinuationLength,
  isContinuationLengthIssueSubtype,
  resolveContinuationLengthContract,
} from '../continuationLengthContract';
import {
  applyParsedRepairPatches,
  isRepairCandidateUsable,
  parseRepairPatches,
  validateRepairPatchCoverage,
  validateRepairPatches,
} from '../continuationRepairPatch';
export {
  applyRepairPatches,
  isRepairCandidateUsable,
} from '../continuationRepairPatch';

export type {
  StageLlmCallResult,
  StageLlmCaller,
  StartContinuationRunInput,
} from '../../../writing/scenario/continuationWritingTypes';
import type {
  StageLlmCallResult,
  StageLlmCaller,
  StartContinuationRunInput,
} from '../../../writing/scenario/continuationWritingTypes';

// Legacy re-export shims: the adoption / finalization / cancel domain
// operations moved to the production writing persist module. Only legacy
// runners and tests may import them through this module.
export {
  adoptArtifactAsDraft,
  finalizeContinuationChapter,
  cancelContinuationRun,
  abandonRun,
  repairContinuationArtifactOnce,
  confirmPlanAndContinue,
  isContinuationRunId,
  outdatedRunsOnSourceOrCanonChange,
} from '../../../writing/persist/continuationAdoption';

function defaultPlan(instruction: string): ContinuationPlan {
  return {
    schemaVersion: 1,
    chapterGoal: instruction.slice(0, 200) || '推进主线',
    centralConflict: '延续上一章冲突',
    beats: [
      { order: 1, summary: '承接上一章' },
      { order: 2, summary: '发展冲突' },
      { order: 3, summary: '章末钩子' },
    ],
    participatingCharacterIds: [],
    characterActions: [],
    plotAdvances: [],
    foreshadowingActions: [],
    proposedStateChanges: [],
    risks: [],
  };
}

function parsePlan(raw: string, fallbackInstruction: string): ContinuationPlan {
  try {
    const parsed = JSON.parse(stripModelJson(raw));
    if (parsed && parsed.schemaVersion === 1 && parsed.chapterGoal) {
      return {
        schemaVersion: 1,
        chapterGoal: String(parsed.chapterGoal),
        centralConflict: String(parsed.centralConflict ?? ''),
        beats: Array.isArray(parsed.beats) ? parsed.beats : [],
        participatingCharacterIds: Array.isArray(
          parsed.participatingCharacterIds,
        )
          ? parsed.participatingCharacterIds
          : [],
        characterActions: Array.isArray(parsed.characterActions)
          ? parsed.characterActions
          : [],
        plotAdvances: Array.isArray(parsed.plotAdvances)
          ? parsed.plotAdvances
          : [],
        foreshadowingActions: Array.isArray(parsed.foreshadowingActions)
          ? parsed.foreshadowingActions
          : [],
        proposedStateChanges: Array.isArray(parsed.proposedStateChanges)
          ? parsed.proposedStateChanges
          : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks : [],
      };
    }
  } catch {
    // fall through
  }
  return defaultPlan(fallbackInstruction);
}

function freezeModelConfig(
  configId: number,
  config: LLMRequestConfig | null | undefined,
): FrozenContinuationModelConfig | null {
  if (!config) return null;
  return {
    configId,
    name: String(config.name ?? `LLM 配置 #${configId}`),
    providerType: config.provider_type,
    url: config.url,
    modelName: config.model_name,
    contextWindow: Math.max(
      1,
      Math.floor(Number(config.context_window) || 8192),
    ),
    maxOutputTokens: Math.max(
      1,
      Math.floor(Number(config.max_output_tokens) || 4000),
    ),
  };
}

export interface ParsedContinuationWriterResult {
  plan: ContinuationPlan;
  content: string;
}

/**
 * Strict standard-workflow Writer contract. The legacy parser above remains
 * intentionally permissive because old runs may still be resumed.
 */
export function parseWriterResult(raw: string): ParsedContinuationWriterResult {
  let parsed: any;
  try {
    parsed = JSON.parse(stripModelJson(raw));
  } catch {
    throw new Error(
      'Writer 返回的不是合法 JSON。请关闭推理输出或改用支持 JSON 输出的模型后重试。',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Writer JSON 顶层必须是 object，不能把解释文字写入正文。');
  }
  if (
    parsed.schemaVersion !== 1 ||
    !parsed.plan ||
    typeof parsed.plan !== 'object'
  ) {
    throw new Error(
      'Writer JSON 缺少 schemaVersion=1 或 plan。请改用支持 JSON 输出的模型后重试。',
    );
  }
  if (typeof parsed.content !== 'string' || !parsed.content.trim()) {
    throw new Error(
      'Writer JSON 缺少非空 content。模型可能只返回了 reasoning 或被 max_tokens 截断，请提高输出上限或改用非推理模型。',
    );
  }
  try {
    const nested = JSON.parse(parsed.content.trim());
    if (
      nested &&
      typeof nested === 'object' &&
      (nested.plan || nested.content)
    ) {
      throw new Error('正文 content 不能再次包含计划或 JSON 包装。');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('不能再次包含')) {
      throw error;
    }
    // Normal prose is not JSON and is valid content.
  }
  const p = parsed.plan;
  // Only the four fields needed to preserve the chapter intent are required
  // from the model. The remaining plan arrays are additive and may be omitted
  // by a valid JSON-output model when there is nothing to report.
  const requiredArrayFields = ['beats', 'participatingCharacterIds'];
  if (
    typeof p.chapterGoal !== 'string' ||
    typeof p.centralConflict !== 'string' ||
    requiredArrayFields.some(field => !Array.isArray(p[field]))
  ) {
    throw new Error(
      'Writer JSON 的 plan 字段不完整。需要目标、冲突、节拍、参与人物和风险数组。',
    );
  }
  const beats = p.beats.map((beat: any, index: number) => {
    if (typeof beat === 'string') {
      return { order: index + 1, summary: beat };
    }
    if (!beat || typeof beat.summary !== 'string') {
      throw new Error(`Writer JSON 的 plan.beats[${index}] 无有效 summary。`);
    }
    return {
      order: Number.isFinite(Number(beat.order))
        ? Number(beat.order)
        : index + 1,
      summary: beat.summary,
      ...(typeof beat.conflict === 'string' ? { conflict: beat.conflict } : {}),
    };
  });
  const plan: ContinuationPlan = {
    schemaVersion: 1,
    chapterGoal: p.chapterGoal,
    centralConflict: p.centralConflict,
    beats,
    participatingCharacterIds: p.participatingCharacterIds
      .filter((id: any) => Number.isFinite(Number(id)))
      .map((id: any) => Number(id)),
    characterActions: Array.isArray(p.characterActions)
      ? p.characterActions
      : [],
    plotAdvances: Array.isArray(p.plotAdvances) ? p.plotAdvances : [],
    foreshadowingActions: Array.isArray(p.foreshadowingActions)
      ? p.foreshadowingActions
      : [],
    proposedStateChanges: Array.isArray(p.proposedStateChanges)
      ? p.proposedStateChanges
      : [],
    risks: Array.isArray(p.risks) ? p.risks : [],
  };
  return { plan, content: parsed.content };
}

async function defaultStageCaller(input: {
  stage: string;
  messages: ChatMessage[];
  maxTokens: number;
  configId: number | null;
  responseFormat?: 'json_object' | 'text';
  signal?: AbortSignal;
  projectId: number;
  runId: string;
  frozenModelConfig?: FrozenContinuationModelConfig | null;
}): Promise<StageLlmCallResult> {
  const liveRequestConfig = input.configId
    ? await resolveLLMRequestConfigById(input.configId)
    : await resolveLLMRequestConfig();
  // Freeze endpoint/model/window fields at run creation. The API key is still
  // resolved from the config's Android Keystore entry and is never serialized
  // into the run snapshot or backup payload.
  const requestConfig = input.frozenModelConfig
    ? {
        ...liveRequestConfig,
        id: input.frozenModelConfig.configId,
        name: input.frozenModelConfig.name,
        provider_type: input.frozenModelConfig.providerType,
        url: input.frozenModelConfig.url,
        model_name: input.frozenModelConfig.modelName,
        context_window: input.frozenModelConfig.contextWindow,
        max_output_tokens: input.frozenModelConfig.maxOutputTokens,
      }
    : liveRequestConfig;
  const contextWindow = requestConfig.context_window;
  if (
    typeof contextWindow === 'number' &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0
  ) {
    const required =
      estimateMessagesTokens(input.messages) + input.maxTokens + 64;
    if (required > contextWindow) {
      throw new ContinuationCapabilityBlockedError(
        `阶段 ${input.stage} 上下文不足：请求约 ${required} token，模型窗口 ${contextWindow}。请降低上下文深度或选择更大模型。`,
      );
    }
  }
  const result = await callLLMResult(
    input.messages,
    input.maxTokens,
    {
      queueClass: 'pipeline',
      queuePriority: 'normal',
      projectId: input.projectId,
      taskId: input.runId,
      scenario: `continuation_${input.stage}`,
      responseFormat:
        input.responseFormat === 'json_object' ? 'json_object' : undefined,
      // DeepSeek V4 defaults to thinking mode. Standard continuation has a
      // strict no-retry Writer contract, so reserve completion capacity for
      // business JSON/text. This only applies to frozen standard-run configs;
      // legacy runs and other model families keep their current behavior.
      thinking:
        input.frozenModelConfig &&
        /^deepseek-v4-(flash|pro)$/i.test(input.frozenModelConfig.modelName)
          ? { type: 'disabled' }
          : undefined,
      requestConfig,
    },
    input.signal,
  );
  return {
    text: result.text ?? '',
    usage: {
      prompt: result.rawUsage?.prompt_tokens,
      completion: result.rawUsage?.completion_tokens,
    },
    finishReason: result.finishReason,
    emptyReason: result.emptyReason,
  };
}

function writerEmptyResponseError(result: StageLlmCallResult): Error {
  switch (result.emptyReason) {
    case 'reasoning_only':
      return new Error(
        'Writer 仅返回推理内容，未产生正文。请提高该模型的最大输出 token 或改用非推理模型。',
      );
    case 'length':
      return new Error(
        'Writer 输出被 max_tokens 截断，未产生正文。请提高该模型的最大输出 token。',
      );
    case 'content_filter':
      return new Error('Writer 输出被内容过滤拦截，请调整本章要求后重试。');
    case 'no_choices':
      return new Error('Writer 收到空响应（无 choices），请检查模型服务状态。');
    default:
      return new Error('Writer 未返回正文，请检查模型服务后重试。');
  }
}

export async function startContinuationRun(
  input: StartContinuationRunInput,
): Promise<ContinuationGenerationRun> {
  if (input.workflowVersion === 2) {
    return startContinuationRunLegacy(input);
  }
  if (input.workflowVersion === 4) {
    return startContinuationV4Run(input);
  }
  // Default new runs use V5 (three rounds / five calls). Historical V2/V4
  // resumes keep their frozen workflowVersion routing.
  return startContinuationV5Run(input);
}

async function startContinuationRunLegacy(
  input: StartContinuationRunInput,
): Promise<ContinuationGenerationRun> {
  const activeCfg = await resolveLLMRequestConfig().catch(() => null);
  const activeId = (activeCfg as any)?.id ?? 0;
  const generationSettings = await ensureGenerationSettings(input.projectId);
  const resolveStageConfig = async (configId: number | null) => {
    if (configId != null) {
      return resolveLLMRequestConfigById(configId).catch(() => activeCfg);
    }
    return activeCfg;
  };
  const [plannerCfg, writerCfg, checkerCfg, repairCfg, stateExtractionCfg] =
    await Promise.all([
      resolveStageConfig(generationSettings.plannerLlmConfigId),
      resolveStageConfig(generationSettings.writerLlmConfigId),
      generationSettings.checkerEnabled
        ? resolveStageConfig(generationSettings.checkerLlmConfigId)
        : Promise.resolve(null),
      generationSettings.checkerEnabled
        ? resolveStageConfig(generationSettings.repairLlmConfigId)
        : Promise.resolve(null),
      resolveStageConfig(generationSettings.stateExtractionLlmConfigId),
    ]);
  // Resolve each stage from its actual LLM config. Do NOT take min(windows)
  // as a universal budget (Spec §7.1) — Planner may use a larger window than
  // Writer and vice versa. The frozen snapshot layout uses Writer capacity.
  const positive = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : fallback;
  const defaultWindow = positive(activeCfg?.context_window, 8192);
  const plannerWindow = positive(plannerCfg?.context_window, defaultWindow);
  const writerWindow = positive(writerCfg?.context_window, defaultWindow);
  const writerOutputBudget = resolveContinuationWriterOutputBudget({
    // A run is frozen from the selected Writer config. The optional input
    // override remains a test/preview compatibility field and never changes
    // the production run's model window.
    contextWindow: writerWindow,
    targetChapterChars: resolveContinuationLengthContract(
      generationSettings.targetChapterChars,
    ).maxHanCharacters,
    configuredMaxOutputTokens: writerCfg?.max_output_tokens,
    requestedMaxOutputTokens: input.maxOutputTokens,
  });
  const plannerOut = positive(
    plannerCfg?.max_output_tokens,
    writerOutputBudget.initialOutputTokens,
  );
  // Keep the legacy Planner capacity in the immutable snapshot for old-run
  // compatibility. Workflow v2 never calls Planner or retries Writer.
  const writerOut = Math.max(1, writerOutputBudget.requestedMaxTokens);

  const fallbackConfigId = activeId || 1;
  const plannerId = generationSettings.plannerLlmConfigId ?? fallbackConfigId;
  const writerId = generationSettings.writerLlmConfigId ?? fallbackConfigId;
  const checkerId = generationSettings.checkerEnabled
    ? generationSettings.checkerLlmConfigId ?? fallbackConfigId
    : null;
  const repairId = generationSettings.checkerEnabled
    ? generationSettings.repairLlmConfigId ?? fallbackConfigId
    : null;

  const frozenModelConfigs = {
    planner: freezeModelConfig(plannerId, plannerCfg ?? activeCfg),
    writer: freezeModelConfig(writerId, writerCfg ?? activeCfg),
    checker:
      checkerId != null
        ? freezeModelConfig(checkerId, checkerCfg ?? activeCfg)
        : null,
    repair:
      repairId != null
        ? freezeModelConfig(repairId, repairCfg ?? activeCfg)
        : null,
    stateExtraction: freezeModelConfig(
      generationSettings.stateExtractionLlmConfigId ?? fallbackConfigId,
      stateExtractionCfg ?? activeCfg,
    ),
  } satisfies NonNullable<
    import('../types').ContinuationGenerationSettingsSnapshot['frozenModelConfigs']
  >;

  // Per-stage capacity from each stage's real window. input.modelContextLimit
  // only overrides Writer layout (shared snapshot packing), not Planner/Checker.
  const stageBudgets: ContinuationStageBudgets = {
    planner: planStageCapacity({
      llmConfigId: plannerId,
      contextWindow: plannerWindow,
      maxOutputTokens: plannerOut,
    }),
    writer: planStageCapacity({
      llmConfigId: writerId,
      contextWindow: writerWindow,
      maxOutputTokens: writerOut,
    }),
    checker:
      checkerId != null
        ? planStageCapacity({
            llmConfigId: checkerId,
            contextWindow: positive(checkerCfg?.context_window, defaultWindow),
            maxOutputTokens: checkerCfg?.max_output_tokens,
          })
        : null,
    repair:
      repairId != null
        ? planStageCapacity({
            llmConfigId: repairId,
            contextWindow: positive(repairCfg?.context_window, defaultWindow),
            maxOutputTokens: repairCfg?.max_output_tokens,
          })
        : null,
  };

  // Layout budget follows Writer (primary consumer of full style + continuity).
  const modelLimit = stageBudgets.writer.contextWindow;
  const maxOut = stageBudgets.writer.maxOutputTokens;

  // Context stage (no LLM for SM / no style analysis)
  const { snapshot, trace } = await buildContinuationContext({
    projectId: input.projectId,
    targetChapterId: input.chapterId,
    targetPosition: input.targetPosition as any,
    currentChapterContent: input.currentChapterContent,
    userInstruction: input.userInstruction,
    modelContextLimit: modelLimit,
    maxOutputTokens: maxOut,
    initialWriterOutputTokens: writerOutputBudget.requestedMaxTokens,
    activeLlmConfigId: activeId || 1,
    stageBudgets,
    frozenModelConfigs,
  });

  const runId = newContinuationRunId();
  const unifiedTrace = createContinuationGenerationTrace({
    snapshot,
    trace,
    runId,
    batchTraceId: input.batchTraceId,
    chapterOrdinal: input.chapterOrdinal,
    chapterCount: input.chapterCount,
    state: 'running',
    stage: 'writer',
  });
  const snapshotWithTraceId = {
    ...snapshot,
    generationTraceId: unifiedTrace.generationTraceId,
  };
  const run = await insertRun({
    id: runId,
    projectId: input.projectId,
    chapterId: input.chapterId,
    targetPosition: input.targetPosition as any,
    sourceId: snapshotWithTraceId.source.sourceId,
    sourceSnapshotJson: JSON.stringify({
      schemaVersion: 1,
      ...snapshotWithTraceId.source,
    }),
    canonSnapshotId: snapshotWithTraceId.canon.snapshotId,
    canonRevision: snapshotWithTraceId.canon.revision,
    storyMemoryFingerprint: snapshotWithTraceId.storyMemory.stateFingerprint,
    storyMemoryThroughPosition: snapshotWithTraceId.storyMemory.throughPosition,
    inputRevisionHash: snapshotWithTraceId.inputRevisionHash,
    userInstruction: input.userInstruction,
    settingsSnapshotJson: JSON.stringify(snapshotWithTraceId.settingsSnapshot),
    contextSnapshotJson: JSON.stringify(snapshotWithTraceId),
    // H6 修复：contextTraceJson 延迟到 run 结束才写。原 insertRun 时三连
    // JSON.stringify(source/settings/snapshot/trace) 产生 300KB-1MB+ 字符串，
    // 1M 上下文下峰值 2× snapshot 体积，低内存 Android 易 OOM。trace 仅调试
    // 用，resume 不需要，run 结束时再 update 写入。
    contextTraceJson: null,
    tokenUsageJson: JSON.stringify({ stages: {} }),
    state: 'running',
    stage: 'writer',
    completionReason: null,
    adoptedRevisionHash: null,
    finalizedRevisionHash: null,
    errorCode: null,
    errorMessage: null,
  });

  const controller = new AbortController();
  activeControllers.set(runId, controller);

  // Fire-and-forget stage pipeline. Fix-plan §5.2: 必须用 try/catch/finally
  // 包裹，catch 里调 finalizeRunOnError（内部有 try/catch 不会抛），finally
  // 保证 activeControllers.delete 总是执行。原 .catch() 写法在
  // casUpdateRunState 抛错时 controller 泄漏，run 卡 running 且无法 cancel。
  void (async () => {
    try {
      await runStages(runId, snapshotWithTraceId, {
        callStage: input.callStage,
        deterministicOnly: input.deterministicOnly,
        signal: controller.signal,
        projectId: input.projectId,
        trace: unifiedTrace,
      });
    } catch (err) {
      await finalizeRunOnError(runId, controller, err);
    } finally {
      activeControllers.delete(runId);
    }
  })();

  return run;
}

interface StandardStagePreflight {
  promptTokens: number;
  requestedMaxTokens: number;
  effectiveWindow: number;
}

function capacityForStage(
  snapshot: ContinuationContextSnapshot,
  stage: 'writer' | 'checker' | 'repair',
): ResolvedStageCapacity | null {
  const capacity = snapshot.stageBudgets?.[stage];
  return capacity ?? null;
}

function preflightStandardStage(input: {
  snapshot: ContinuationContextSnapshot;
  stage: 'writer' | 'checker' | 'repair';
  messages: ChatMessage[];
  maxTokens: number;
  minimumOutput?: number;
}): StandardStagePreflight {
  const capacity = capacityForStage(input.snapshot, input.stage);
  if (!capacity) {
    throw new ContinuationCapabilityBlockedError(
      `阶段 ${input.stage} 没有冻结的 LLM 配置，无法安全请求。请重新发起续写。`,
    );
  }
  const promptTokens = estimateMessagesTokens(input.messages);
  const effectiveWindow =
    capacity.effectiveWindow ||
    Math.floor(
      capacity.contextWindow *
        CONTINUATION_BUDGET_POLICY.contextUtilizationRatio,
    );
  const outputShareCap = Math.floor(
    capacity.contextWindow * CONTINUATION_BUDGET_POLICY.maxOutputRatio,
  );
  const remainingCapacity = effectiveWindow - promptTokens;
  const requestedMaxTokens = Math.max(
    0,
    Math.min(
      input.maxTokens,
      capacity.maxOutputTokens,
      outputShareCap,
      remainingCapacity,
    ),
  );
  if (
    requestedMaxTokens <= 0 ||
    promptTokens + requestedMaxTokens > effectiveWindow
  ) {
    throw new ContinuationCapabilityBlockedError(
      `阶段 ${input.stage} 上下文不足：prompt 约 ${promptTokens} token，当前有效窗口 ${effectiveWindow}，无法保留有效输出。请降低资料量或选择更大模型。`,
    );
  }
  if (input.minimumOutput != null && requestedMaxTokens < input.minimumOutput) {
    throw new ContinuationCapabilityBlockedError(
      `Writer 输出预算不足：当前最多 ${requestedMaxTokens} token，但按目标章节与计划仍至少需要 ${input.minimumOutput} token；请降低目标字数或选择更大的 context_window / max_output_tokens。`,
    );
  }
  return { promptTokens, requestedMaxTokens, effectiveWindow };
}

function previousStandardCallCount(tokenUsage: Record<string, any>): number {
  return (['writer', 'checker', 'repair'] as const).reduce((total, stage) => {
    const physicalRequests = Number(tokenUsage[stage]?.requestCount ?? 0);
    const transientRetries = Number(tokenUsage[stage]?.retryCount ?? 0);
    // Writer transport retries are real requests and remain visible in
    // telemetry, but they do not consume one of the three logical workflow
    // stage slots. This keeps resume/extra-repair decisions consistent with
    // the in-memory call guard.
    return total + Math.max(0, physicalRequests - transientRetries);
  }, 0);
}

function standardWorkflow(snapshot: ContinuationContextSnapshot): boolean {
  return snapshot.workflowVersion === 2;
}

function isSevereCheck(check: ContinuationCheckResult): boolean {
  return check.severity === 'error' || check.severity === 'blocking';
}

function isLocalDeterministicSubtype(subtype: string): boolean {
  return (
    isContinuationLengthIssueSubtype(subtype) ||
    subtype === 'future_leakage' ||
    subtype === 'resurrection_forbidden' ||
    subtype === 'source_overlap' ||
    subtype === 'continuation_anchor_overlap'
  );
}

const REPAIR_REBIND_SEARCH_RADIUS = 4096;

function findNearestUniqueExcerptMatch(input: {
  content: string;
  excerpt: string;
  originalStart: number;
}): { start: number; end: number } | null {
  const { content, excerpt, originalStart } = input;
  if (
    !excerpt ||
    !Number.isInteger(originalStart) ||
    originalStart < 0 ||
    originalStart > content.length
  ) {
    return null;
  }

  const latestStart = content.length - excerpt.length;
  const searchStart = Math.max(
    0,
    originalStart - REPAIR_REBIND_SEARCH_RADIUS,
  );
  const searchEnd = Math.min(
    latestStart,
    originalStart + REPAIR_REBIND_SEARCH_RADIUS,
  );
  if (searchEnd < searchStart) return null;

  const matches: Array<{ start: number; end: number }> = [];
  let cursor = searchStart;
  while (cursor <= searchEnd) {
    const start = content.indexOf(excerpt, cursor);
    if (start < 0 || start > searchEnd) break;
    matches.push({ start, end: start + excerpt.length });
    cursor = start + 1;
  }
  if (matches.length === 0) return null;

  const nearestDistance = Math.min(
    ...matches.map(match => Math.abs(match.start - originalStart)),
  );
  const nearest = matches.filter(
    match => Math.abs(match.start - originalStart) === nearestDistance,
  );
  return nearest.length === 1 ? nearest[0] : null;
}

function rebindCheckToContent(
  check: ContinuationCheckResult,
  content: string,
): ContinuationCheckResult {
  if (!check.generatedExcerpt) {
    return {
      ...check,
      generatedStart: null,
      generatedEnd: null,
    };
  }
  if (
    check.generatedStart != null &&
    check.generatedEnd != null &&
    check.generatedStart >= 0 &&
    check.generatedEnd >= check.generatedStart &&
    check.generatedEnd <= content.length &&
    content.slice(check.generatedStart, check.generatedEnd) ===
      check.generatedExcerpt
  ) {
    return { ...check };
  }
  const match =
    check.generatedStart == null
      ? null
      : findNearestUniqueExcerptMatch({
          content,
          excerpt: check.generatedExcerpt,
          originalStart: check.generatedStart,
        });
  if (!match) {
    return {
      ...check,
      generatedStart: null,
      generatedEnd: null,
    };
  }
  return {
    ...check,
    generatedStart: match.start,
    generatedEnd: match.end,
  };
}

function recheckedIssueToCheck(
  issue: RawCheckIssue,
  template: ContinuationCheckResult | undefined,
  runId: string,
  chapterId: number,
  artifact: ContinuationArtifact,
): ContinuationCheckResult {
  return {
    id: template?.id ?? 0,
    runId: template?.runId ?? runId,
    chapterId: template?.chapterId ?? chapterId,
    artifactId: artifact.id,
    artifactHash: artifact.contentHash,
    category: issue.category,
    subtype: issue.subtype,
    severity: issue.severity,
    confidence: issue.confidence,
    generatedStart: issue.generatedStart,
    generatedEnd: issue.generatedEnd,
    generatedExcerpt: issue.generatedExcerpt,
    description: issue.description,
    entityRefType: issue.entityRefType ?? null,
    entityRefId: issue.entityRefId ?? null,
    evidenceIds: issue.evidenceIds ?? [],
    suggestedFix: issue.suggestedFix ?? null,
    resolutionStatus: 'open',
    createdAt: template?.createdAt ?? '',
    updatedAt: template?.updatedAt ?? '',
  };
}

function frozenModelConfigForStage(
  snapshot: ContinuationContextSnapshot,
  stage: 'writer' | 'checker' | 'repair',
): FrozenContinuationModelConfig | null {
  return snapshot.settingsSnapshot.frozenModelConfigs?.[stage] ?? null;
}

async function runStandardStages(
  runId: string,
  snapshot: ContinuationContextSnapshot,
  opts: {
    callStage?: StageLlmCaller;
    deterministicOnly?: boolean;
    signal: AbortSignal;
    projectId: number;
    trace?: ContinuationContextTrace | null;
    existingArtifact?: ContinuationArtifact | null;
    initialTokenUsage?: Record<string, any>;
  },
): Promise<void> {
  const tokenUsage: Record<string, any> = {
    ...(opts.initialTokenUsage ?? {}),
  };
  let llmCallCount = previousStandardCallCount(tokenUsage);

  const persistUsage = async (stage: string) => {
    await casUpdateRunState(runId, ['running'], {
      stage: stage as any,
      tokenUsageJson: JSON.stringify({
        workflowVersion: 2,
        stages: tokenUsage,
      }),
    });
  };

  const call = async (
    stage: 'writer' | 'checker' | 'repair',
    messages: ChatMessage[],
    maxTokens: number,
    configId: number | null,
    responseFormat: 'json_object' | 'text',
    minimumOutput?: number,
  ): Promise<StageLlmCallResult> => {
    let transientRetryUsed = false;
    let workflowSlotConsumed = false;
    while (true) {
      if (opts.signal.aborted) throw new Error('cancelled');
      if (!workflowSlotConsumed && llmCallCount >= 3) {
        throw new ContinuationCapabilityBlockedError(
          '本次标准续写已达到 Writer / Checker / Repair 三个阶段调用上限，不能再次请求；Writer 的一次传输重试不占用该上限。',
        );
      }
      const preflight = preflightStandardStage({
        snapshot,
        stage,
        messages,
        maxTokens,
        minimumOutput,
      });
      if (!workflowSlotConsumed) {
        llmCallCount += 1;
        workflowSlotConsumed = true;
      }
      const startedAt = new Date();
      const startedAtIso = startedAt.toISOString();
      const prior = tokenUsage[stage] ?? {};
      tokenUsage[stage] = {
        ...prior,
        requestCount: Number(prior.requestCount ?? 0) + 1,
        startedAt: startedAtIso,
        estimatedPromptTokens: preflight.promptTokens,
        requestedMaxTokens: preflight.requestedMaxTokens,
        effectiveWindow: preflight.effectiveWindow,
      };
      await persistUsage(stage);

      let result: StageLlmCallResult;
      try {
        result = opts.callStage
          ? await opts.callStage({
              stage,
              messages,
              maxTokens: preflight.requestedMaxTokens,
              configId,
              responseFormat,
            })
          : await defaultStageCaller({
              stage,
              messages,
              maxTokens: preflight.requestedMaxTokens,
              configId,
              responseFormat,
              signal: opts.signal,
              projectId: opts.projectId,
              runId,
              frozenModelConfig: frozenModelConfigForStage(snapshot, stage),
            });
      } catch (error) {
        const finishedAt = new Date();
        tokenUsage[stage] = {
          ...tokenUsage[stage],
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          warning: 'request_failed',
          warningMessage:
            error instanceof Error ? error.message : String(error),
        };
        await persistUsage(stage).catch(() => {});

        // A failed transport request is retained in physical request
        // telemetry, but the single Writer retry is not a fourth logical
        // workflow stage. It therefore does not consume the Writer/Checker/
        // Repair three-stage budget.
        if (
          stage === 'writer' &&
          !transientRetryUsed &&
          isWriterTransientRequestError(error)
        ) {
          transientRetryUsed = true;
          tokenUsage[stage] = {
            ...tokenUsage[stage],
            retryCount: 1,
            retryReason: 'transient_network_or_server_busy',
          };
          await persistUsage(stage).catch(() => {});
          continue;
        }
        throw error;
      }

      const finishedAt = new Date();
      const actualPrompt = result.usage?.prompt;
      const actualCompletion = result.usage?.completion;
      tokenUsage[stage] = {
        ...tokenUsage[stage],
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        prompt: actualPrompt,
        completion: actualCompletion,
        finishReason: result.finishReason ?? null,
        emptyReason: result.emptyReason ?? null,
      };
      if (
        typeof actualPrompt === 'number' &&
        typeof actualCompletion === 'number' &&
        actualPrompt + actualCompletion > preflight.effectiveWindow
      ) {
        tokenUsage[stage].warning = 'usage_exceeded_effective_window';
        await persistUsage(stage).catch(() => {});
        throw new ContinuationCapabilityBlockedError(
          `阶段 ${stage} 实际 usage 超过有效窗口 ${preflight.effectiveWindow}，本次 run 不会重试。`,
        );
      }
      await persistUsage(stage);
      return result;
    }
  };

  let artifact = opts.existingArtifact ?? null;
  if (!artifact) {
    if (Number(tokenUsage.writer?.requestCount ?? 0) > 0) {
      throw new Error(
        'Writer 已经发起过请求但尚未保存 artifact；标准链路不会自动重发 Writer，请检查模型服务后重新发起。',
      );
    }
    await persistUsage('writer');
    const writerMessages = compileWriterMessages(snapshot);
    const writerBudget = resolveContinuationWriterOutputBudget({
      contextWindow: snapshot.stageBudgets?.writer.contextWindow ?? 8192,
      targetChapterChars: resolveContinuationLengthContract(
        snapshot.settingsSnapshot.values.targetChapterChars,
      ).maxHanCharacters,
      configuredMaxOutputTokens:
        snapshot.stageBudgets?.writer.declaredOutputTokens,
    });
    if (writerBudget.blockedReason) {
      throw new ContinuationCapabilityBlockedError(writerBudget.blockedReason);
    }
    const writerResult = await call(
      'writer',
      writerMessages,
      writerBudget.requestedMaxTokens,
      snapshot.settingsSnapshot.resolvedModelConfigIds.writer,
      'json_object',
      writerBudget.minimumOutput,
    );
    if (!writerResult.text.trim()) {
      throw writerEmptyResponseError(writerResult);
    }
    let parsed: ParsedContinuationWriterResult;
    try {
      parsed = parseWriterResult(writerResult.text);
    } catch (error) {
      if (writerResult.finishReason === 'length') {
        throw new Error(
          'Writer JSON 被 max_tokens 截断，未保存正文。请提高 Writer 的 max_output_tokens 或降低目标章节长度；标准链路不会自动重试。',
        );
      }
      throw error;
    }
    await savePlan(runId, parsed.plan, 'not_required');
    artifact = await insertArtifact({
      runId,
      stage: 'writer',
      content: parsed.content,
    });
  }

  const settings = snapshot.settingsSnapshot.values;
  const existingChecks = await listChecksForArtifact(runId, artifact.id);
  let checks = existingChecks;
  if (checks.length === 0) {
    // Start the deterministic seam/Canon guard and the LLM Checker together.
    // The local branch is intentionally narrow and synchronous, while the
    // Checker is network-bound; awaiting both before Repair lets Repair see a
    // single merged issue set without changing the three logical LLM slots.
    const localChecksPromise = Promise.resolve().then(() =>
      runDeterministicChecks(artifact!.content, snapshot),
    );
    const checkerAlreadyAttempted =
      Number(tokenUsage.checker?.requestCount ?? 0) > 0;
    const checkerPromise = (async () => {
      if (opts.deterministicOnly || checkerAlreadyAttempted) return null;
      try {
        const checkerCapacity = capacityForStage(snapshot, 'checker');
        if (!checkerCapacity) throw new Error('缺少 Checker 冻结配置');
        const checkerResult = await call(
          'checker',
          compileCheckerMessages(snapshot, artifact!.content),
          checkerCapacity.maxOutputTokens,
          snapshot.settingsSnapshot.resolvedModelConfigIds.checker,
          'json_object',
        );
        return parseCheckerLlmJson(checkerResult.text);
      } catch (checkerError) {
        tokenUsage.checker = {
          ...(tokenUsage.checker ?? {}),
          warning: 'deterministic_only_fallback',
          warningMessage:
            checkerError instanceof Error
              ? checkerError.message
              : String(checkerError),
        };
        await persistUsage('checker').catch(() => {});
        return null;
      }
    })();
    const [localIssues, checkerIssues] = await Promise.all([
      localChecksPromise,
      checkerPromise,
    ]);
    let issues = localIssues;
    if (checkerIssues) issues = issues.concat(checkerIssues);
    if (checkerAlreadyAttempted) {
      tokenUsage.checker = {
        ...(tokenUsage.checker ?? {}),
        warning: 'checker_already_attempted_deterministic_only',
      };
      await persistUsage('checker').catch(() => {});
    }
    const allowed = new Set(snapshot.bundles.canon.evidenceRefs);
    const bound = filterBySettings(
      bindIssuesToArtifact(issues, artifact.content, allowed),
      settings,
    );
    await insertCheckResults(
      bound.map(i => ({
        runId,
        chapterId: snapshot.targetChapterId,
        artifactId: artifact!.id,
        artifactHash: artifact!.contentHash,
        ...i,
      })),
    );
    checks = await listChecksForArtifact(runId, artifact.id);
  }

  const openChecks = checks.filter(c => c.resolutionStatus === 'open');
  const severeChecks = openChecks.filter(
    c => c.severity === 'error' || c.severity === 'blocking',
  );
  if (severeChecks.length > 0) {
    const originalArtifact = artifact;
    const repairAlreadyAttempted =
      Number(tokenUsage.repair?.requestCount ?? 0) > 0;
    let deterministicCandidate = originalArtifact.content;
    let deterministicHandledIds = new Set<number>();
    const deterministicResult = tryDeterministicRepairWithReport(
      originalArtifact.content,
      severeChecks,
    );
    if (deterministicResult) {
      deterministicCandidate = deterministicResult.content;
      deterministicHandledIds = new Set(deterministicResult.repairedIssueIds);
      if (
        !isRepairCandidateUsable(
          originalArtifact.content,
          deterministicCandidate,
          settings.targetChapterChars,
          'standard',
        )
      ) {
        deterministicCandidate = originalArtifact.content;
        deterministicHandledIds = new Set<number>();
      }
    }

    const allowedEvidence = new Set(snapshot.bundles.canon.evidenceRefs);
    const localCandidateIssues = filterBySettings(
      bindIssuesToArtifact(
        runDeterministicChecks(deterministicCandidate, snapshot),
        deterministicCandidate,
        allowedEvidence,
      ),
      settings,
    );
    const localTemplateChecks = checks.filter(c =>
      isLocalDeterministicSubtype(c.subtype),
    );
    const localCandidateChecks = localCandidateIssues.map(issue =>
      recheckedIssueToCheck(
        issue,
        localTemplateChecks.find(
          template =>
            template.category === issue.category &&
            template.subtype === issue.subtype,
        ),
        runId,
        snapshot.targetChapterId,
        originalArtifact,
      ),
    );
    const localCandidateSevereChecks =
      localCandidateChecks.filter(isSevereCheck);
    const localOriginalIds = new Set(
      checks.filter(c => isLocalDeterministicSubtype(c.subtype)).map(c => c.id),
    );
    const unresolvedLlmChecks = severeChecks
      .filter(
        check =>
          !localOriginalIds.has(check.id) &&
          !deterministicHandledIds.has(check.id),
      )
      .map(check => rebindCheckToContent(check, deterministicCandidate));
    const repairChecks: ContinuationCheckResult[] = [];
    const seenRepairIds = new Set<number>();
    for (const check of [
      ...localCandidateSevereChecks,
      ...unresolvedLlmChecks,
    ]) {
      if (check.id !== 0 && seenRepairIds.has(check.id)) continue;
      if (check.id !== 0) seenRepairIds.add(check.id);
      repairChecks.push(check);
    }

    let repaired = deterministicCandidate;
    let repairUsedLlm = false;
    let repairRequestAttempted = false;
    let repairCoverage: ReturnType<typeof validateRepairPatchCoverage> | null =
      null;
    if (
      !opts.deterministicOnly &&
      !repairAlreadyAttempted &&
      repairChecks.length
    ) {
      const repairCapacity = capacityForStage(snapshot, 'repair');
      if (!repairCapacity) {
        tokenUsage.repair = {
          ...(tokenUsage.repair ?? {}),
          requestCount: 0,
          skippedReason: 'missing_frozen_config',
        };
      } else {
        try {
          repairRequestAttempted = true;
          const repairResult = await call(
            'repair',
            compileRepairMessages(
              snapshot,
              deterministicCandidate,
              repairChecks,
              'patch',
            ),
            repairCapacity.maxOutputTokens,
            snapshot.settingsSnapshot.resolvedModelConfigIds.repair,
            'json_object',
          );
          const patches = parseRepairPatches(repairResult.text);
          const patchesValid =
            patches !== null &&
            validateRepairPatches(deterministicCandidate, patches);
          if (!patches || !patchesValid) {
            tokenUsage.repair = {
              ...(tokenUsage.repair ?? {}),
              warning: 'invalid_patch_writer_artifact_retained',
              warningMessage:
                'Repair 未返回通过 JSON、offset 和插入边界校验的补丁，已保留调用前正文。',
            };
          } else {
            repairCoverage = validateRepairPatchCoverage({
              patches,
              issues: repairChecks,
            });
            const patched = applyParsedRepairPatches(
              deterministicCandidate,
              patches,
            );
            const patchedLength = evaluateContinuationLength(
              patched,
              settings.targetChapterChars,
            );
            const lengthResolved =
              repairCoverage.chapterLengthIssues.length > 0 &&
              patchedLength.status === 'within';
            const hasCoveredOrdinaryIssue =
              repairCoverage.coveredIssues.length > 0;
            const hasLengthIssue =
              repairCoverage.chapterLengthIssues.length > 0;
            const candidateUsable = isRepairCandidateUsable(
              deterministicCandidate,
              patched,
              settings.targetChapterChars,
              'standard',
            );
            const lengthSafelyImproved =
              hasLengthIssue &&
              patchedLength.status !== 'within' &&
              candidateUsable;
            const hasRepairProgress =
              hasCoveredOrdinaryIssue ||
              lengthResolved ||
              lengthSafelyImproved;
            if (
              patched === deterministicCandidate ||
              !hasRepairProgress ||
              !candidateUsable
            ) {
              tokenUsage.repair = {
                ...(tokenUsage.repair ?? {}),
                warning: !candidateUsable
                  ? 'repair_candidate_rejected_as_over_contracted'
                  : hasCoveredOrdinaryIssue
                  ? 'repair_candidate_rejected_as_unsafe'
                  : 'repair_patch_coverage_failed_writer_artifact_retained',
                warningMessage: hasCoveredOrdinaryIssue
                  ? 'Repair 补丁虽有局部命中，但候选破坏动态长度契约、过度缩短或异常膨胀，已保留调用前正文。'
                  : 'Repair 补丁没有覆盖任何普通严重问题，且未将章节长度带入合法范围，已保留调用前正文。',
              };
              repairCoverage = null;
            } else {
              repaired = patched;
              repairUsedLlm = true;
            }
          }
        } catch (repairError) {
          tokenUsage.repair = {
            ...(tokenUsage.repair ?? {}),
            warning: 'repair_failed_writer_artifact_retained',
            warningMessage:
              repairError instanceof Error
                ? repairError.message
                : String(repairError),
          };
          await persistUsage('repair').catch(() => {});
        }
      }
    } else if (deterministicCandidate !== originalArtifact.content) {
      tokenUsage.repair = {
        ...(tokenUsage.repair ?? {}),
        requestCount: Number(tokenUsage.repair?.requestCount ?? 0),
        skippedReason: opts.deterministicOnly
          ? 'deterministic_only'
          : repairAlreadyAttempted
          ? 'repair_already_attempted_deterministic_candidate_retained'
          : 'deterministic_repair',
      };
    } else if (repairAlreadyAttempted) {
      tokenUsage.repair = {
        ...(tokenUsage.repair ?? {}),
        skippedReason: 'repair_already_attempted_writer_artifact_retained',
      };
    }

    if (repaired !== originalArtifact.content) {
      const finalLocalIssues = filterBySettings(
        bindIssuesToArtifact(
          runDeterministicChecks(repaired, snapshot),
          repaired,
          allowedEvidence,
        ),
        settings,
      );
      const finalLocalChecks = finalLocalIssues.map(issue =>
        recheckedIssueToCheck(
          issue,
          localTemplateChecks.find(
            template =>
              template.category === issue.category &&
              template.subtype === issue.subtype,
          ),
          runId,
          snapshot.targetChapterId,
          originalArtifact,
        ),
      );
      const finalLength = evaluateContinuationLength(
        repaired,
        settings.targetChapterChars,
      );
      const checksToMark = new Set<number>();
      for (const check of severeChecks) {
        if (check.id <= 0) continue;
        if (deterministicHandledIds.has(check.id)) {
          const resolved = isContinuationLengthIssueSubtype(check.subtype)
            ? finalLength.status === 'within'
            : !finalLocalChecks.some(
                finalCheck =>
                  finalCheck.subtype === check.subtype &&
                  (!check.generatedExcerpt ||
                    finalCheck.generatedExcerpt === check.generatedExcerpt),
              );
          if (resolved) checksToMark.add(check.id);
        }
      }
      if (repairCoverage) {
        for (const issue of repairCoverage.coveredIssues) {
          if (issue.id > 0) checksToMark.add(issue.id);
        }
        if (finalLength.status === 'within') {
          for (const issue of repairCoverage.chapterLengthIssues) {
            if (issue.id > 0) checksToMark.add(issue.id);
          }
        }
      }

      if (checksToMark.size > 0) {
        await markChecksAutoRepaired(
          runId,
          originalArtifact.id,
          Array.from(checksToMark),
        );
      }
      const parent = originalArtifact;
      artifact = await insertArtifact({
        runId,
        stage: 'repair',
        content: repaired,
        repairRound: 1,
        parentArtifactId: parent.id,
      });
      // A Repair artifact is checked locally only. In particular, this branch
      // must never call the LLM Checker after either deterministic or LLM repair.
      const unresolvedLlmIssues = severeChecks
        .filter(check => !localOriginalIds.has(check.id))
        .filter(check => !checksToMark.has(check.id))
        .map(check => rebindCheckToContent(check, artifact!.content));
      await insertCheckResults(
        [...finalLocalIssues, ...unresolvedLlmIssues].map(i => ({
          ...i,
          runId,
          chapterId: snapshot.targetChapterId,
          artifactId: artifact!.id,
          artifactHash: artifact!.contentHash,
        })),
      );
      tokenUsage.localVerify = {
        requestCount: 0,
        status: 'completed',
        note:
          repairUsedLlm || repairRequestAttempted
            ? 'Repair 后本地复核，未进行第二次 LLM 复检'
            : '确定性修复后本地复核，未进行 LLM 复检',
      };
    }
  }

  await casUpdateRunState(runId, ['running'], {
    state: 'awaiting_user',
    stage: 'awaiting_user',
    tokenUsageJson: JSON.stringify({
      workflowVersion: 2,
      stages: tokenUsage,
    }),
  });
  activeControllers.delete(runId);
}

/**
 * Only transport/server-busy failures are safe to retry automatically for a
 * new standard-workflow Writer request. Output-contract failures (reasoning
 * only, empty, length, malformed JSON) and configuration/auth failures must
 * remain visible to the user and must never consume another Writer call.
 *
 * Keep this classification local to the standard workflow. Historical runs
 * retain their original Planner/Writer resume semantics.
 */
export function isWriterTransientRequestError(error: unknown): boolean {
  const candidates: any[] = [];
  let current: any = error;
  for (let depth = 0; current && depth < 3; depth += 1) {
    candidates.push(current);
    current = current.cause;
  }

  for (const candidate of candidates) {
    const status = Number(
      candidate?.status ?? candidate?.response?.status ?? 0,
    );
    const code = String(candidate?.code ?? '').toLowerCase();
    const message = String(candidate?.message ?? '').toLowerCase();

    if (status === 429 || /(?:^|[^0-9])429(?:[^0-9]|$)/.test(code)) {
      return true;
    }
    if (status >= 500 && status <= 599) return true;
    if (
      [
        'network_error',
        'connect_timeout',
        'idle_timeout',
        'total_timeout',
        'rate_limit_exceeded',
        'too_many_requests',
        'server_busy',
        'service_unavailable',
        'overloaded',
      ].some(value => code.includes(value))
    ) {
      return true;
    }
    if (
      /network|fetch failed|connection reset|connection refused|timed out|timeout|temporarily unavailable|too many requests|rate limit|server busy|overloaded|service unavailable/.test(
        message,
      )
    ) {
      return true;
    }
  }
  return false;
}

async function runStages(
  runId: string,
  snapshot: ContinuationContextSnapshot,
  opts: {
    callStage?: StageLlmCaller;
    deterministicOnly?: boolean;
    signal: AbortSignal;
    projectId: number;
    trace?: ContinuationContextTrace | null;
    existingArtifact?: ContinuationArtifact | null;
    initialTokenUsage?: Record<string, any>;
  },
): Promise<void> {
  if (standardWorkflow(snapshot)) {
    await runStandardStages(runId, snapshot, opts);
    if (opts.trace) {
      await casUpdateRunState(runId, ['awaiting_user'], {
        contextTraceJson: JSON.stringify(opts.trace),
      }).catch(() => {});
    }
    return;
  }
  await runLegacyStages(runId, snapshot, opts);
}

async function runLegacyStages(
  runId: string,
  snapshot: ContinuationContextSnapshot,
  opts: {
    callStage?: StageLlmCaller;
    deterministicOnly?: boolean;
    signal: AbortSignal;
    projectId: number;
    trace?: ContinuationContextTrace | null;
  },
): Promise<void> {
  const tokenUsage: Record<string, any> = {};
  const call = async (
    stage: string,
    messages: ChatMessage[],
    maxTokens: number,
    configId: number | null,
    responseFormat?: 'json_object' | 'text',
  ) => {
    if (opts.signal.aborted) throw new Error('cancelled');
    if (opts.callStage) {
      const r = await opts.callStage({
        stage,
        messages,
        maxTokens,
        configId,
        responseFormat,
      });
      tokenUsage[stage] = {
        ...(r.usage ?? {}),
        finishReason: r.finishReason ?? null,
        emptyReason: r.emptyReason ?? null,
      };
      return r;
    }
    const r = await defaultStageCaller({
      stage,
      messages,
      maxTokens,
      configId,
      responseFormat,
      signal: opts.signal,
      projectId: opts.projectId,
      runId,
    });
    tokenUsage[stage] = {
      ...(r.usage ?? {}),
      finishReason: r.finishReason ?? null,
      emptyReason: r.emptyReason ?? null,
    };
    return r;
  };

  const persistUsage = async (stage: string) => {
    await casUpdateRunState(runId, ['running'], {
      stage: stage as any,
      tokenUsageJson: JSON.stringify({ stages: tokenUsage }),
    });
  };

  // Planner
  await persistUsage('planner');
  const plannerMsgs = compilePlannerMessages(snapshot);
  let plan: ContinuationPlan;
  try {
    // H5 修复：原硬编码 1024，用户配 max_output_tokens=2048 也无效，复杂 plan
    // JSON 超 1024 token 被截断 → parsePlan 回落 defaultPlan。改用 stageBudgets
    // 已根据 LLM config 计算好的 maxOutputTokens（planStageCapacity 输出）。
    const plannerResult = await call(
      'planner',
      plannerMsgs,
      snapshot.stageBudgets?.planner.maxOutputTokens ?? 1024,
      snapshot.settingsSnapshot.resolvedModelConfigIds.planner,
      'json_object',
    );
    plan = parsePlan(plannerResult.text, snapshot.bundles.userInstruction);
  } catch (err) {
    // H7 修复：原 catch 完全吞错，planner 超时/解析失败用户无感知，writer
    // 拿空洞 defaultPlan 生成既浪费 token 又质量差。CapabilityBlocked 错误
    // 直接抛（不降级）；其他错误降级但记录 warning 到 tokenUsage 供 UI/trace。
    if (err instanceof ContinuationCapabilityBlockedError) throw err;
    plan = defaultPlan(snapshot.bundles.userInstruction);
    tokenUsage.planner = {
      ...(tokenUsage.planner ?? {}),
      warning: 'planner_downgraded',
      warningMessage: err instanceof Error ? err.message : String(err),
    };
  }

  const needsConfirm =
    snapshot.settingsSnapshot.values.plannerConfirmationPolicy === 'always' ||
    (snapshot.settingsSnapshot.values.plannerConfirmationPolicy ===
      'risk_only' &&
      plan.risks.some(
        r => r.severity === 'blocking' || r.severity === 'error',
      ));

  await savePlan(runId, plan, needsConfirm ? 'pending' : 'not_required');

  if (needsConfirm) {
    await casUpdateRunState(runId, ['running'], {
      state: 'awaiting_user',
      stage: 'awaiting_user',
      tokenUsageJson: JSON.stringify({ stages: tokenUsage }),
      // H6: 延迟写入 trace，减少 insertRun 时内存峰值
      contextTraceJson: opts.trace ? JSON.stringify(opts.trace) : null,
    });
    return;
  }

  await continueFromWriter(runId, snapshot, plan, {
    call,
    persistUsage,
    tokenUsage,
    deterministicOnly: opts.deterministicOnly,
    signal: opts.signal,
  });
  // H6: continueFromWriter 已把 run 设为 awaiting_user，此处补写 trace
  //（仅调试用，CAS 失败说明 run 已被 cancel/outdated，trace 丢失可接受）
  if (opts.trace) {
    await casUpdateRunState(runId, ['awaiting_user'], {
      contextTraceJson: JSON.stringify(opts.trace),
    }).catch(() => {
      // best-effort；run 已离开 awaiting_user 则不强制写 trace
    });
  }
}

/**
 * Build the per-stage LLM caller used by continueFromWriter. Shared by
 * confirmPlanAndContinue and resumeInterruptedRun so both resolve config ids
 * from the FROZEN snapshot (resolvedModelConfigIds) via the injected caller or
 * the default caller, never from the live active config mid-run.
 */
function buildStageCaller(
  callStage: StageLlmCaller | undefined,
  controller: AbortController,
  projectId: number,
  runId: string,
  tokenUsage: Record<string, any>,
  frozenModelConfigs?: import('../types').ContinuationGenerationSettingsSnapshot['frozenModelConfigs'],
) {
  return async (
    stage: string,
    messages: ChatMessage[],
    maxTokens: number,
    configId: number | null,
    responseFormat?: 'json_object' | 'text',
  ): Promise<StageLlmCallResult> => {
    if (callStage) {
      const r = await callStage({
        stage,
        messages,
        maxTokens,
        configId,
        responseFormat,
      });
      tokenUsage[stage] = {
        ...(r.usage ?? {}),
        finishReason: r.finishReason ?? null,
        emptyReason: r.emptyReason ?? null,
      };
      return r;
    }
    const r = await defaultStageCaller({
      stage,
      messages,
      maxTokens,
      configId,
      responseFormat,
      signal: controller.signal,
      projectId,
      runId,
      frozenModelConfig:
        stage === 'writer' || stage === 'checker' || stage === 'repair'
          ? frozenModelConfigs?.[stage] ?? null
          : null,
    });
    tokenUsage[stage] = {
      ...(r.usage ?? {}),
      finishReason: r.finishReason ?? null,
      emptyReason: r.emptyReason ?? null,
    };
    return r;
  };
}

/**
 * Terminalize a run after a stage exception (fix-plan §5.2). Mirrors the
 * startContinuationRun catch: abort → cancelled, anything else → failed. The
 * run must never be left in `running`. Safe to call from finally-less contexts
 * because it only transitions out of running/awaiting_user.
 */
async function finalizeRunOnError(
  runId: string,
  controller: AbortController,
  err: unknown,
): Promise<void> {
  try {
    if (controller.signal.aborted) {
      await casUpdateRunState(runId, ['running', 'awaiting_user'], {
        state: 'cancelled',
        errorCode: 'cancelled',
        errorMessage: '用户取消',
        completedAt: new Date().toISOString(),
      });
    } else {
      await casUpdateRunState(runId, ['running', 'awaiting_user', 'queued'], {
        state: 'failed',
        errorCode:
          err instanceof ContinuationCapabilityBlockedError
            ? err.code
            : 'stage_failed',
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: new Date().toISOString(),
      });
    }
  } catch {
    // best-effort; the run may already be in a terminal state from a parallel
    // cancel/abandon. Never throw out of error finalization.
  }
}

async function continueFromWriter(
  runId: string,
  snapshot: ContinuationContextSnapshot,
  plan: ContinuationPlan,
  opts: {
    call: (
      stage: string,
      messages: ChatMessage[],
      maxTokens: number,
      configId: number | null,
      responseFormat?: 'json_object' | 'text',
    ) => Promise<StageLlmCallResult>;
    persistUsage: (stage: string) => Promise<void>;
    tokenUsage: Record<string, any>;
    deterministicOnly?: boolean;
    signal: AbortSignal;
    /** When resuming an interrupted checker/repair, skip writer regeneration
     * and re-check the existing artifact instead (fix-plan §5.2: never treat a
     * half-finished stream as complete; a persisted artifact is always whole). */
    existingArtifact?: ContinuationArtifact | null;
  },
): Promise<void> {
  let artifact: ContinuationArtifact;
  let body: string;
  if (opts.existingArtifact) {
    // Resume into the checker/repair loop with the already-persisted artifact.
    artifact = opts.existingArtifact;
    body = artifact.content;
  } else {
    await opts.persistUsage('writer');
    const writerMsgs = compileWriterMessages(snapshot, plan);
    const initialWriterOutput = await opts.call(
      'writer',
      writerMsgs,
      snapshot.contextBudget?.writerInitialOutputTokens ??
        snapshot.contextBudget?.writerMaxOutputTokens ??
        Math.max(256, snapshot.settingsSnapshot.values.targetChapterChars * 3),
      snapshot.settingsSnapshot.resolvedModelConfigIds.writer,
      'text',
    );
    body = initialWriterOutput.text;
    if (!body.trim()) {
      const retryMaxTokens = snapshot.contextBudget?.writerMaxOutputTokens;
      const shouldRetry =
        (initialWriterOutput.emptyReason === 'length' ||
          initialWriterOutput.emptyReason === 'reasoning_only') &&
        typeof retryMaxTokens === 'number' &&
        retryMaxTokens >
          (snapshot.contextBudget?.writerInitialOutputTokens ?? 0);
      if (shouldRetry) {
        const retry = await opts.call(
          'writer',
          [
            ...writerMsgs,
            {
              role: 'user',
              content: '请直接开始输出本章正文；不要输出分析、思考过程或标题。',
            },
          ],
          retryMaxTokens,
          snapshot.settingsSnapshot.resolvedModelConfigIds.writer,
          'text',
        );
        body = retry.text;
        if (body.trim()) {
          // The second call is intentionally the authoritative Writer trace.
          opts.tokenUsage.writer = {
            ...(opts.tokenUsage.writer ?? {}),
            retriedAfterEmpty: initialWriterOutput.emptyReason,
          };
        } else {
          throw writerEmptyResponseError(retry);
        }
      } else {
        throw writerEmptyResponseError(initialWriterOutput);
      }
    }
    artifact = await insertArtifact({
      runId,
      stage: 'writer',
      content: body,
    });
  }

  const settings = snapshot.settingsSnapshot.values;
  let repairRound = 0;
  const maxRounds = settings.maxRepairRounds;

  while (true) {
    if (opts.signal.aborted) throw new Error('cancelled');
    if (!settings.checkerEnabled) break;

    await opts.persistUsage('checker');
    let issues = runDeterministicChecks(artifact.content, snapshot);
    if (!opts.deterministicOnly) {
      try {
        // H5 修复：原硬编码 1500，复杂 artifact 多 issue 超 1500 token 被截断
        // → parseCheckerLlmJson 抛错 → 触发下方 catch 静默吞错。改用
        // stageBudgets.checker 已根据 LLM config 计算的 maxOutputTokens。
        const checkerMaxTokens =
          snapshot.stageBudgets?.checker?.maxOutputTokens ?? 1500;
        const raw = await opts.call(
          'checker',
          compileCheckerMessages(snapshot, artifact.content),
          checkerMaxTokens,
          snapshot.settingsSnapshot.resolvedModelConfigIds.checker,
          'json_object',
        );
        issues = issues.concat(parseCheckerLlmJson(raw.text));
      } catch (checkerErr) {
        // H3 修复：原 catch 完全吞错，与 planner 的 H7 修复不对称。LLM 返回
        // 截断 JSON 或网络超时时，真正的 continuity 冲突被无声丢弃。改为
        // 记录 warning 到 tokenUsage.checker 供 trace/UI 展示「LLM 检查器
        // 降级，仅确定性检查」，确定性检查结果仍然保留。
        opts.tokenUsage.checker = {
          ...(opts.tokenUsage.checker ?? {}),
          warning: 'checker_failed',
          warningMessage:
            checkerErr instanceof Error
              ? checkerErr.message
              : String(checkerErr),
        };
      }
    }
    const allowed = new Set(snapshot.bundles.canon.evidenceRefs);
    issues = filterBySettings(
      bindIssuesToArtifact(issues, artifact.content, allowed),
      settings,
    );
    await insertCheckResults(
      issues.map(i => ({
        runId,
        chapterId: snapshot.targetChapterId,
        artifactId: artifact.id,
        artifactHash: artifact.contentHash,
        ...i,
      })),
    );

    const openChecks = (await listChecksForArtifact(runId, artifact.id)).filter(
      c => c.resolutionStatus === 'open',
    );
    if (!shouldRunRepair(openChecks, maxRounds, repairRound)) break;

    await opts.persistUsage('repair');
    repairRound += 1;
    let repaired = tryDeterministicRepair(artifact.content, openChecks);
    if (!repaired && !opts.deterministicOnly) {
      // H4 修复：原 repair 调用无 try/catch，一次网络抖动/超时/JSON 解析异常
      // 会沿 runStages → finalizeRunOnError 把 run 标 failed，但 writer 产出
      // 的 artifact 已 insertArtifact 落库，adoptArtifactAsDraft 只接受
      // awaiting_user/interrupted，用户既不能采纳也不能恢复，整次生成（含
      // 已花的 planner+writer token）作废。改 try/catch：失败时记录 warning
      // 并 break 跳出 repair 循环，保留当前 artifact 走末尾 awaiting_user。
      try {
        repaired = (
          await opts.call(
            'repair',
            compileRepairMessages(snapshot, artifact.content, openChecks),
            Math.min(4096, artifact.content.length + 500),
            snapshot.settingsSnapshot.resolvedModelConfigIds.repair,
            'text',
          )
        ).text;
      } catch (repairErr) {
        opts.tokenUsage.repair = {
          ...(opts.tokenUsage.repair ?? {}),
          warning: 'repair_failed',
          warningMessage:
            repairErr instanceof Error ? repairErr.message : String(repairErr),
        };
        break;
      }
    }
    if (!repaired || repaired === artifact.content) break;

    await markChecksObsolete(runId, artifact.id);
    artifact = await insertArtifact({
      runId,
      stage: 'repair',
      content: repaired,
      repairRound,
      parentArtifactId: artifact.id,
    });
    body = repaired;
  }

  await casUpdateRunState(runId, ['running'], {
    state: 'awaiting_user',
    stage: 'awaiting_user',
    tokenUsageJson: JSON.stringify({ stages: opts.tokenUsage }),
  });
  activeControllers.delete(runId);
}

/**
 * Resume an interrupted run from its last persisted stage boundary
 * (fix-plan §5.2). Every branch is wrapped in try/catch/finally so the run can
 * never be left in `running` after a resume attempt.
 *
 * Branch table (last persisted stage):
 *  - context / planner           → CAS interrupted→running, re-run from planner
 *  - writer, has plan, no artifact → CAS then continue directly from writer
 *  - checker / repair, has artifact → CAS then continue from writer (which
 *      re-checks/repairs the existing artifact; a half-finished network stream
 *      is never treated as a completed artifact)
 *  - awaiting_user (artifact present) → CAS interrupted→awaiting_user, no model
 *
 * The old implementation called confirmPlanAndContinue() for the Writer-paused
 * case, but that function only accepts awaiting_user, so it always threw —
 * leaving the run interrupted with no way forward. We now resume from the
 * Writer directly using the frozen snapshot + confirmed/available plan.
 */
export async function resumeInterruptedRun(
  runId: string,
  callStage?: StageLlmCaller,
  deterministicOnly?: boolean,
): Promise<void> {
  const run = await getRunById(runId);
  if (!run) throw new Error('run 不存在');
  if (run.workflowVersion === 4) {
    return resumeContinuationV4Run(runId, callStage, deterministicOnly);
  }
  if (run.workflowVersion === 5) {
    return resumeContinuationV5Run(runId, callStage, deterministicOnly);
  }
  if (run.state === 'outdated') throw new ContinuationOutdatedError();
  if (run.state !== 'interrupted') throw new Error('仅 interrupted 可恢复');
  if (!run.contextSnapshotJson) {
    throw new Error('缺少冻结 context，请重新发起');
  }
  const snapshot = JSON.parse(
    run.contextSnapshotJson,
  ) as ContinuationContextSnapshot;

  // Standard workflow resume is deliberately separate from the historical
  // Planner/confirm loop. A persisted Writer artifact is never regenerated;
  // persisted checks are reused and Repair can consume at most the remaining
  // single call within the three-call guard.
  if (standardWorkflow(snapshot)) {
    const artifact = await getLatestArtifact(runId);
    if (artifact && run.stage === 'awaiting_user') {
      await casUpdateRunState(runId, ['interrupted'], {
        state: 'awaiting_user',
        stage: 'awaiting_user',
      });
      return;
    }
    const ok = await casUpdateRunState(runId, ['interrupted'], {
      state: 'running',
      stage: artifact ? run.stage : 'writer',
    });
    if (!ok) return;
    const controller = new AbortController();
    activeControllers.set(runId, controller);
    let initialTokenUsage: Record<string, any> = {};
    try {
      const parsed = JSON.parse(run.tokenUsageJson || '{}');
      initialTokenUsage = parsed.stages ?? {};
    } catch {
      initialTokenUsage = {};
    }
    try {
      await runStages(runId, snapshot, {
        callStage,
        deterministicOnly,
        signal: controller.signal,
        projectId: run.projectId,
        existingArtifact: artifact,
        initialTokenUsage,
      });
    } catch (err) {
      await finalizeRunOnError(runId, controller, err);
      throw err;
    } finally {
      activeControllers.delete(runId);
    }
    return;
  }

  // Branch: context / planner → re-run the whole stage pipeline from planner.
  if (run.stage === 'planner' || run.stage === 'context') {
    const ok = await casUpdateRunState(runId, ['interrupted'], {
      state: 'running',
      stage: 'planner',
    });
    if (!ok) return; // someone else already moved this run
    const controller = new AbortController();
    activeControllers.set(runId, controller);
    try {
      await runStages(runId, snapshot, {
        callStage,
        deterministicOnly,
        signal: controller.signal,
        projectId: run.projectId,
      });
    } catch (err) {
      await finalizeRunOnError(runId, controller, err);
      throw err;
    } finally {
      activeControllers.delete(runId);
    }
    return;
  }

  // Branch: awaiting_user with an artifact → hand back to the user without
  // invoking any model.
  const art = await getLatestArtifact(runId);
  if (art && run.stage === 'awaiting_user') {
    await casUpdateRunState(runId, ['interrupted'], {
      state: 'awaiting_user',
      stage: 'awaiting_user',
    });
    return;
  }

  // Branch: checker / repair paused with an existing artifact → re-run the
  // checker/repair loop on the persisted artifact (fix-plan §5.2). We never
  // treat a half-finished network stream as complete; only a persisted artifact
  // (which is always whole) is eligible.
  if (art && (run.stage === 'checker' || run.stage === 'repair')) {
    const planRowCr = await getPlan(runId);
    if (!planRowCr) {
      throw new Error('缺少规划，无法恢复，请重新发起续写');
    }
    const ok = await casUpdateRunState(runId, ['interrupted'], {
      state: 'running',
      stage: 'checker',
    });
    if (!ok) return;
    const controller = new AbortController();
    activeControllers.set(runId, controller);
    const tokenUsage: Record<string, any> = {};
    const call = buildStageCaller(
      callStage,
      controller,
      run.projectId,
      runId,
      tokenUsage,
      snapshot.settingsSnapshot.frozenModelConfigs,
    );
    try {
      await continueFromWriter(runId, snapshot, planRowCr.plan, {
        call,
        persistUsage: async stage => {
          await casUpdateRunState(runId, ['running'], {
            stage: stage as any,
            tokenUsageJson: JSON.stringify({ stages: tokenUsage }),
          });
        },
        tokenUsage,
        deterministicOnly,
        signal: controller.signal,
        existingArtifact: art,
      });
    } catch (err) {
      await finalizeRunOnError(runId, controller, err);
      throw err;
    } finally {
      activeControllers.delete(runId);
    }
    return;
  }

  // Branch: Writer paused with a plan but no/partial artifact → resume directly
  // from the Writer using the frozen snapshot + the stored plan. A pending plan
  // remains subject to explicit user confirmation after recovery.
  const planRow = await getPlan(runId);
  if (!planRow) {
    // No plan at all — cannot resume the Writer; surface to the user.
    throw new Error('缺少规划，无法恢复，请重新发起续写');
  }
  if (planRow.confirmationStatus === 'pending') {
    await casUpdateRunState(runId, ['interrupted'], {
      state: 'awaiting_user',
      stage: 'awaiting_user',
    });
    return;
  }
  const ok = await casUpdateRunState(runId, ['interrupted'], {
    state: 'running',
    stage: run.stage === 'writer' ? 'writer' : 'writer',
  });
  if (!ok) return;
  const controller = new AbortController();
  activeControllers.set(runId, controller);
  const tokenUsage: Record<string, any> = {};
  const call = buildStageCaller(
    callStage,
    controller,
    run.projectId,
    runId,
    tokenUsage,
    snapshot.settingsSnapshot.frozenModelConfigs,
  );
  try {
    await continueFromWriter(runId, snapshot, planRow.plan, {
      call,
      persistUsage: async stage => {
        await casUpdateRunState(runId, ['running'], {
          stage: stage as any,
          tokenUsageJson: JSON.stringify({ stages: tokenUsage }),
        });
      },
      tokenUsage,
      deterministicOnly,
      signal: controller.signal,
    });
  } catch (err) {
    await finalizeRunOnError(runId, controller, err);
    throw err;
  } finally {
    activeControllers.delete(runId);
  }
}

export type { ContinuationRunState };

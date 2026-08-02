/**
 * Independent continuation generation runner (Spec §5, §9).
 * Does not reuse freeform PipelineStageName or pipeline_tasks as authority.
 */
import type { ChatMessage, LLMRequestConfig } from '../../llm/types';
import {
  callLLMResult,
  resolveLLMRequestConfig,
  resolveLLMRequestConfigById,
} from '../../llm';
import { stripModelJson } from '../canon/canonJsonValidators';
import { buildContinuationContext } from './continuationContextBuilder';
import {
  bindIssuesToArtifact,
  filterBySettings,
  parseCheckerLlmJson,
  runDeterministicChecks,
} from './continuationChecker';
import {
  compileCheckerMessages,
  compilePlannerMessages,
  compileRepairMessages,
  compileWriterMessages,
} from './continuationPromptCompiler';
import {
  shouldRunRepair,
  tryDeterministicRepair,
} from './continuationRepairService';
import {
  buildAcceptOpenChecksStatement,
  buildOutboxInsertStatement,
  casUpdateRunState,
  contentRevisionHash,
  getArtifactForRun,
  getLatestArtifact,
  getPlan,
  getRunById,
  findLatestAdoptedRunForChapter,
  insertArtifact,
  insertCheckResults,
  insertRun,
  listChecksForArtifact,
  markChecksAutoRepaired,
  markChecksObsolete,
  markRunsOutdatedForProject,
  newContinuationRunId,
  savePlan,
  ensureGenerationSettings,
} from './generationRepository';
import type {
  ContinuationArtifact,
  ContinuationContextSnapshot,
  ContinuationContextTrace,
  ContinuationGenerationRun,
  ContinuationPlan,
  ContinuationRunState,
  FrozenContinuationModelConfig,
} from './types';
import {
  ContinuationCapabilityBlockedError,
  ContinuationConflictError,
  ContinuationOutdatedError,
} from './types';
import { openDatabase } from '../../../data/connection/openDatabase';
import { executeTransaction } from '../../database/transaction';
import { v4 } from '../../uuidBridge';
import { processContinuationOutbox } from './continuationStateOutboxWorker';
import { estimateMessagesTokens } from '../../../utils/tokenEstimator';
import {
  CONTINUATION_BUDGET_POLICY,
  planStageCapacity,
  resolveContinuationWriterOutputBudget,
  type ResolvedStageCapacity,
} from './continuationContextBudget';
import { type ContinuationStageBudgets } from './continuationContextBudget';

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
}

const activeControllers = new Map<string, AbortController>();

function countHanCharacters(text: string): number {
  return (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || [])
    .length;
}

/**
 * A Repair response must not silently collapse a complete Writer chapter into
 * a short summary. This is a local candidate-preservation check, not a target
 * length gate: the Writer artifact remains available and the user can decide
 * what to do when a Repair response is unusably contracted.
 */
function isRepairCandidateUsable(
  original: string,
  candidate: string,
  targetChapterChars: number,
): boolean {
  const originalHan = countHanCharacters(original) || original.length;
  const candidateHan = countHanCharacters(candidate) || candidate.length;
  if (originalHan === 0 || candidateHan === 0) return false;
  const sourceIsAtLeastRepairMinimum = originalHan >= 2500;
  const sourceIsInPreferredBand = originalHan >= 2500 && originalHan <= 4000;
  if (sourceIsAtLeastRepairMinimum && candidateHan < 2500) {
    return false;
  }
  if (sourceIsInPreferredBand && candidateHan > 4000) {
    return false;
  }
  const preservationFloor = Math.max(
    Math.floor(originalHan * 0.25),
    Math.floor(Math.min(originalHan, targetChapterChars) * 0.15),
  );
  return candidateHan >= preservationFloor;
}

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

interface RepairPatch {
  start: number;
  end: number;
  replacement: string;
}

/**
 * Standard Repair is deliberately patch-based.  A model that only emits the
 * changed paragraph must not be able to replace a complete Writer chapter
 * with that paragraph.  Offsets are UTF-16 indices in the supplied Writer
 * artifact, which is also what Checker evidence uses.
 */
export function applyRepairPatches(
  original: string,
  raw: string,
): string | null {
  let parsed: { patches?: unknown };
  try {
    parsed = JSON.parse(stripModelJson(raw));
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.patches) || !parsed.patches.length) {
    return null;
  }
  const patches: RepairPatch[] = [];
  for (const value of parsed.patches) {
    if (!value || typeof value !== 'object') return null;
    const patch = value as Record<string, unknown>;
    const start = Number(patch.start);
    const end = Number(patch.end);
    const replacement = patch.replacement;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > original.length ||
      typeof replacement !== 'string' ||
      !replacement.trim()
    ) {
      return null;
    }
    patches.push({ start, end, replacement: replacement.trim() });
  }
  patches.sort((a, b) => a.start - b.start);
  if (
    patches.some(
      (patch, index) => index > 0 && patch.start < patches[index - 1].end,
    )
  ) {
    return null;
  }
  return patches
    .slice()
    .sort((a, b) => b.start - a.start)
    .reduce(
      (content, patch) =>
        `${content.slice(0, patch.start)}${patch.replacement}${content.slice(
          patch.end,
        )}`,
      original,
    );
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
    targetChapterChars: generationSettings.targetChapterChars,
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
    import('./types').ContinuationGenerationSettingsSnapshot['frozenModelConfigs']
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
  const run = await insertRun({
    id: runId,
    projectId: input.projectId,
    chapterId: input.chapterId,
    targetPosition: input.targetPosition as any,
    sourceId: snapshot.source.sourceId,
    sourceSnapshotJson: JSON.stringify({
      schemaVersion: 1,
      ...snapshot.source,
    }),
    canonSnapshotId: snapshot.canon.snapshotId,
    canonRevision: snapshot.canon.revision,
    storyMemoryFingerprint: snapshot.storyMemory.stateFingerprint,
    storyMemoryThroughPosition: snapshot.storyMemory.throughPosition,
    inputRevisionHash: snapshot.inputRevisionHash,
    userInstruction: input.userInstruction,
    settingsSnapshotJson: JSON.stringify(snapshot.settingsSnapshot),
    contextSnapshotJson: JSON.stringify(snapshot),
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
      await runStages(runId, snapshot, {
        callStage: input.callStage,
        deterministicOnly: input.deterministicOnly,
        signal: controller.signal,
        projectId: input.projectId,
        trace,
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
      targetChapterChars: snapshot.settingsSnapshot.values.targetChapterChars,
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
    let repaired = tryDeterministicRepair(artifact.content, severeChecks);
    let repairUsedLlm = false;
    const repairAlreadyAttempted =
      Number(tokenUsage.repair?.requestCount ?? 0) > 0;
    if (!repaired && !opts.deterministicOnly && !repairAlreadyAttempted) {
      const repairCapacity = capacityForStage(snapshot, 'repair');
      if (!repairCapacity) {
        tokenUsage.repair = {
          ...(tokenUsage.repair ?? {}),
          requestCount: 0,
          skippedReason: 'missing_frozen_config',
        };
      } else {
        try {
          const repairResult = await call(
            'repair',
            compileRepairMessages(
              snapshot,
              artifact.content,
              severeChecks,
              'patch',
            ),
            repairCapacity.maxOutputTokens,
            snapshot.settingsSnapshot.resolvedModelConfigIds.repair,
            'json_object',
          );
          repaired =
            applyRepairPatches(artifact.content, repairResult.text) ??
            repairResult.text.trim();
          repairUsedLlm = Boolean(repaired);
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
    } else if (repaired) {
      tokenUsage.repair = {
        ...(tokenUsage.repair ?? {}),
        requestCount: 0,
        skippedReason: 'deterministic_repair',
      };
    } else if (repairAlreadyAttempted) {
      tokenUsage.repair = {
        ...(tokenUsage.repair ?? {}),
        skippedReason: 'repair_already_attempted_writer_artifact_retained',
      };
    }

    if (
      repaired &&
      repaired !== artifact.content &&
      !isRepairCandidateUsable(
        artifact.content,
        repaired,
        settings.targetChapterChars,
      )
    ) {
      tokenUsage.repair = {
        ...(tokenUsage.repair ?? {}),
        warning: 'repair_candidate_rejected_as_over_contracted',
        warningMessage:
          'Repair 候选相对 Writer 正文过度缩短或偏离 2500–4000 汉字质量带，已保留 Writer artifact；本次不重试，也不再次调用 Checker。',
      };
      repaired = null;
      repairUsedLlm = false;
      await persistUsage('repair').catch(() => {});
    }

    if (repaired && repaired !== artifact.content) {
      await markChecksAutoRepaired(
        runId,
        artifact.id,
        severeChecks.map(c => c.id),
      );
      const parent = artifact;
      artifact = await insertArtifact({
        runId,
        stage: 'repair',
        content: repaired,
        repairRound: 1,
        parentArtifactId: parent.id,
      });
      // A Repair artifact is checked locally only. In particular, this branch
      // must never call the LLM Checker after either deterministic or LLM repair.
      const repairedIssues = filterBySettings(
        bindIssuesToArtifact(
          runDeterministicChecks(artifact.content, snapshot),
          artifact.content,
          new Set(snapshot.bundles.canon.evidenceRefs),
        ),
        settings,
      );
      await insertCheckResults(
        repairedIssues.map(i => ({
          runId,
          chapterId: snapshot.targetChapterId,
          artifactId: artifact!.id,
          artifactHash: artifact!.contentHash,
          ...i,
        })),
      );
      tokenUsage.localVerify = {
        requestCount: 0,
        status: 'completed',
        note: repairUsedLlm
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
 * User-confirmed last-resort repair for a standard run whose Repair artifact
 * still has an open local error/blocking check. The normal path remains
 * Writer → Checker → Repair (at most three calls). This action is deliberately
 * explicit, is available once, never calls Checker again, and keeps the prior
 * artifact if the extra request fails.
 */
export async function repairContinuationArtifactOnce(
  runId: string,
  callStage?: StageLlmCaller,
): Promise<void> {
  const run = await getRunById(runId);
  if (!run) throw new Error('run 不存在');
  if (run.workflowVersion !== 2) {
    throw new Error('历史续写不支持额外修正，请继续使用历史恢复流程');
  }
  if (run.state !== 'awaiting_user' || run.stage !== 'awaiting_user') {
    throw new Error('当前续写不在等待用户决策状态');
  }

  const snapshot = JSON.parse(
    run.contextSnapshotJson ?? '{}',
  ) as ContinuationContextSnapshot;
  const artifact = await getLatestArtifact(runId);
  if (!artifact) throw new Error('没有可修正的正文候选');
  const checks = await listChecksForArtifact(runId, artifact.id);
  const severeChecks = checks.filter(
    c =>
      c.resolutionStatus === 'open' &&
      (c.severity === 'error' || c.severity === 'blocking'),
  );
  if (severeChecks.length === 0) {
    throw new Error('当前候选没有待修复的 error / blocking 问题');
  }

  let saved: { stages?: Record<string, any> } = {};
  try {
    saved = JSON.parse(run.tokenUsageJson || '{}');
  } catch {
    saved = {};
  }
  const tokenUsage: Record<string, any> = { ...(saved.stages ?? {}) };
  const priorCalls = previousStandardCallCount(tokenUsage);
  if (
    priorCalls >= 4 ||
    Number(tokenUsage.repair?.additionalRequestCount ?? 0) > 0
  ) {
    throw new Error('额外修正已经使用过，本次不再重复调用');
  }
  const firstRepairAttempted = Number(tokenUsage.repair?.requestCount ?? 0) > 0;
  if (artifact.stage !== 'repair' && !firstRepairAttempted) {
    throw new Error(
      '只有第一次 Repair 已尝试且本地复核仍失败时，才能请求额外修正',
    );
  }

  const repairCapacity = capacityForStage(snapshot, 'repair');
  if (!repairCapacity) throw new Error('缺少 Repair 冻结配置，无法安全请求');
  const messages = compileRepairMessages(
    snapshot,
    artifact.content,
    severeChecks,
    'patch',
  );
  const preflight = preflightStandardStage({
    snapshot,
    stage: 'repair',
    messages,
    maxTokens: repairCapacity.maxOutputTokens,
  });
  const controller = new AbortController();
  activeControllers.set(runId, controller);
  const startedAt = new Date();
  tokenUsage.repair = {
    ...(tokenUsage.repair ?? {}),
    requestCount: Number(tokenUsage.repair?.requestCount ?? 0) + 1,
    additionalRequestCount: 1,
    additionalReason: 'user_confirmed_after_local_verification_failure',
    startedAt: startedAt.toISOString(),
    estimatedPromptTokens: preflight.promptTokens,
    requestedMaxTokens: preflight.requestedMaxTokens,
    effectiveWindow: preflight.effectiveWindow,
  };

  try {
    const claimed = await casUpdateRunState(runId, ['awaiting_user'], {
      state: 'running',
      stage: 'repair',
      tokenUsageJson: JSON.stringify({
        workflowVersion: 2,
        stages: tokenUsage,
      }),
    });
    if (!claimed) throw new Error('续写状态已变更，无法请求额外修正');

    const result = callStage
      ? await callStage({
          stage: 'repair',
          messages,
          maxTokens: preflight.requestedMaxTokens,
          configId: snapshot.settingsSnapshot.resolvedModelConfigIds.repair,
          responseFormat: 'json_object',
        })
      : await defaultStageCaller({
          stage: 'repair',
          messages,
          maxTokens: preflight.requestedMaxTokens,
          configId: snapshot.settingsSnapshot.resolvedModelConfigIds.repair,
          responseFormat: 'json_object',
          signal: controller.signal,
          projectId: run.projectId,
          runId,
          frozenModelConfig: frozenModelConfigForStage(snapshot, 'repair'),
        });
    const finishedAt = new Date();
    const previousRepair = tokenUsage.repair ?? {};
    const previousPromptTotal = Number(
      previousRepair.promptTotal ?? previousRepair.prompt ?? 0,
    );
    const previousCompletionTotal = Number(
      previousRepair.completionTotal ?? previousRepair.completion ?? 0,
    );
    const previousDurationTotal = Number(
      previousRepair.totalDurationMs ?? previousRepair.durationMs ?? 0,
    );
    tokenUsage.repair = {
      ...tokenUsage.repair,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      totalDurationMs:
        previousDurationTotal + finishedAt.getTime() - startedAt.getTime(),
      prompt: result.usage?.prompt,
      completion: result.usage?.completion,
      promptTotal: previousPromptTotal + Number(result.usage?.prompt ?? 0),
      completionTotal:
        previousCompletionTotal + Number(result.usage?.completion ?? 0),
      finishReason: result.finishReason ?? null,
      emptyReason: result.emptyReason ?? null,
    };
    if (
      typeof result.usage?.prompt === 'number' &&
      typeof result.usage?.completion === 'number' &&
      result.usage.prompt + result.usage.completion > preflight.effectiveWindow
    ) {
      throw new ContinuationCapabilityBlockedError(
        `额外 Repair 实际 usage 超过有效窗口 ${preflight.effectiveWindow}，候选正文保持不变。`,
      );
    }
    const repaired =
      applyRepairPatches(artifact.content, result.text) ?? result.text.trim();
    if (!repaired) throw new Error('额外 Repair 未返回正文，候选正文保持不变');
    if (repaired === artifact.content) {
      throw new Error('额外 Repair 未改变正文，候选正文保持不变');
    }
    if (
      !isRepairCandidateUsable(
        artifact.content,
        repaired,
        snapshot.settingsSnapshot.values.targetChapterChars,
      )
    ) {
      throw new Error(
        '额外 Repair 候选相对当前正文过度缩短，已保留原候选；本次不再重试，也不会调用 LLM Checker。',
      );
    }

    await markChecksAutoRepaired(
      runId,
      artifact.id,
      severeChecks.map(c => c.id),
    );
    const repairedArtifact = await insertArtifact({
      runId,
      stage: 'repair',
      content: repaired,
      repairRound: artifact.repairRound + 1,
      parentArtifactId: artifact.id,
    });
    const repairedIssues = filterBySettings(
      bindIssuesToArtifact(
        runDeterministicChecks(repairedArtifact.content, snapshot),
        repairedArtifact.content,
        new Set(snapshot.bundles.canon.evidenceRefs),
      ),
      snapshot.settingsSnapshot.values,
    );
    await insertCheckResults(
      repairedIssues.map(i => ({
        runId,
        chapterId: snapshot.targetChapterId,
        artifactId: repairedArtifact.id,
        artifactHash: repairedArtifact.contentHash,
        ...i,
      })),
    );
    tokenUsage.localVerify = {
      requestCount: 0,
      status: 'completed',
      note: '额外 Repair 后本地复核，未进行第二次 LLM Checker',
    };
    await casUpdateRunState(runId, ['running'], {
      state: 'awaiting_user',
      stage: 'awaiting_user',
      tokenUsageJson: JSON.stringify({
        workflowVersion: 2,
        stages: tokenUsage,
      }),
    });
  } catch (error) {
    const finishedAt = new Date();
    tokenUsage.repair = {
      ...tokenUsage.repair,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      warning: 'additional_repair_failed_writer_or_repair_artifact_retained',
      warningMessage: error instanceof Error ? error.message : String(error),
    };
    await casUpdateRunState(runId, ['running'], {
      state: 'awaiting_user',
      stage: 'awaiting_user',
      tokenUsageJson: JSON.stringify({
        workflowVersion: 2,
        stages: tokenUsage,
      }),
    }).catch(() => {});
    throw error;
  } finally {
    activeControllers.delete(runId);
  }
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
  frozenModelConfigs?: import('./types').ContinuationGenerationSettingsSnapshot['frozenModelConfigs'],
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

export async function confirmPlanAndContinue(
  runId: string,
  callStage?: StageLlmCaller,
  deterministicOnly?: boolean,
): Promise<void> {
  const run = await getRunById(runId);
  if (!run) throw new Error('run 不存在');
  if (run.state === 'outdated') throw new ContinuationOutdatedError();
  if (run.state !== 'awaiting_user' || run.stage !== 'awaiting_user') {
    throw new Error('当前不在等待 Planner 确认状态');
  }
  const planRow = await getPlan(runId);
  if (!planRow) throw new Error('缺少 plan');
  await savePlan(runId, planRow.plan, 'confirmed');
  const snapshot = JSON.parse(
    run.contextSnapshotJson!,
  ) as ContinuationContextSnapshot;
  const controller = new AbortController();
  activeControllers.set(runId, controller);
  await casUpdateRunState(runId, ['awaiting_user'], {
    state: 'running',
    stage: 'writer',
  });

  const tokenUsage: Record<string, any> = {};
  const call = buildStageCaller(
    callStage,
    controller,
    run.projectId,
    runId,
    tokenUsage,
  );

  // Fix-plan §5.2: wrap the stage execution in the same try/catch/finally as
  // startContinuationRun so an exception cannot leave the controller dangling
  // or the run stuck in `running`. Cancellation → cancelled; other errors →
  // failed. The run must always reach a terminal/recoverable state.
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

export async function cancelContinuationRun(runId: string): Promise<void> {
  const c = activeControllers.get(runId);
  c?.abort();
  activeControllers.delete(runId);
  await casUpdateRunState(runId, ['queued', 'running', 'awaiting_user'], {
    state: 'cancelled',
    errorCode: 'cancelled',
    errorMessage: '用户取消',
    completedAt: new Date().toISOString(),
  });
}

/**
 * Verify the run's frozen Source/Canon snapshot still matches the project's
 * current active Source/Canon (fix-plan §6.1). If they diverge, atomically mark
 * the run `outdated` and throw so adoption is refused — defense-in-depth on top
 * of the change-time invalidation calls (which can race). The run's sourceId /
 * canonSnapshotId / canonRevision were captured at creation; we compare them
 * against the live continuation_settings + active Canon snapshot.
 */
async function assertContextFreshOrMarkOutdated(
  run: ContinuationGenerationRun,
): Promise<void> {
  // Only runs that captured a Source/Canon snapshot need a freshness check.
  // A run with neither was created outside the full continuation flow (e.g. a
  // test fixture) and should not be blocked here.
  if (run.sourceId == null && !run.canonSnapshotId) return;

  const db = await openDatabase();
  const [settingsRes] = await db.executeSql(
    'SELECT active_source_id, active_canon_snapshot_id FROM continuation_settings WHERE project_id = ?',
    [run.projectId],
  );
  if (settingsRes.rows.length === 0) {
    // No settings row means the source was deleted; mark outdated.
    await casUpdateRunState(run.id, ['awaiting_user', 'interrupted'], {
      state: 'outdated',
      errorCode: 'outdated',
      errorMessage: 'source_missing',
      completedAt: new Date().toISOString(),
    });
    throw new ContinuationOutdatedError();
  }
  const settings = settingsRes.rows.item(0);
  const activeSourceId = settings.active_source_id;
  // Source mismatch (run frozen a source that is no longer active).
  if (run.sourceId != null && Number(activeSourceId) !== Number(run.sourceId)) {
    await casUpdateRunState(run.id, ['awaiting_user', 'interrupted'], {
      state: 'outdated',
      errorCode: 'outdated',
      errorMessage: 'source_changed',
      completedAt: new Date().toISOString(),
    });
    throw new ContinuationOutdatedError();
  }
  // Canon snapshot mismatch: compare active snapshot id + revision.
  const activeCanonId = settings.active_canon_snapshot_id;
  if (run.canonSnapshotId || activeCanonId) {
    if (
      !activeCanonId ||
      !run.canonSnapshotId ||
      String(activeCanonId) !== String(run.canonSnapshotId)
    ) {
      await casUpdateRunState(run.id, ['awaiting_user', 'interrupted'], {
        state: 'outdated',
        errorCode: 'outdated',
        errorMessage: 'canon_snapshot_changed',
        completedAt: new Date().toISOString(),
      });
      throw new ContinuationOutdatedError();
    }
    // Same snapshot id — verify its revision hasn't been bumped since the run.
    const [snapRes] = await db.executeSql(
      'SELECT revision FROM continuation_canon_snapshots WHERE id = ?',
      [activeCanonId],
    );
    if (snapRes.rows.length === 0) {
      await casUpdateRunState(run.id, ['awaiting_user', 'interrupted'], {
        state: 'outdated',
        errorCode: 'outdated',
        errorMessage: 'canon_snapshot_deleted',
        completedAt: new Date().toISOString(),
      });
      throw new ContinuationOutdatedError();
    }
    const currentRevision = Number(snapRes.rows.item(0).revision);
    if (currentRevision !== Number(run.canonRevision)) {
      await casUpdateRunState(run.id, ['awaiting_user', 'interrupted'], {
        state: 'outdated',
        errorCode: 'outdated',
        errorMessage: 'canon_revision_changed',
        completedAt: new Date().toISOString(),
      });
      throw new ContinuationOutdatedError();
    }
  }
}

/**
 * Adopt selected artifact as chapter draft only.
 * No proposal/event/Story Memory LLM (Spec §10.3).
 */
export async function adoptArtifactAsDraft(input: {
  runId: string;
  artifactId?: string;
  /** Force overwrite when chapter content hash differs from input_revision_hash. */
  forceOverwrite?: boolean;
  /** Explicit user opt-in to adopt an artifact with open severe local checks. */
  allowOpenChecks?: boolean;
}): Promise<{ contentHash: string }> {
  const run = await getRunById(input.runId);
  if (!run) throw new Error('run 不存在');
  if (run.state === 'outdated') throw new ContinuationOutdatedError();
  if (run.state !== 'awaiting_user' && run.state !== 'interrupted') {
    throw new Error(`run 状态 ${run.state} 不可采纳`);
  }

  // Fix-plan §6.1: re-check that the active Source and Canon snapshot still
  // match the run's frozen snapshot before adopting. If Source/Canon changed
  // since this run was created, atomically mark the run outdated and refuse
  // adoption — the user must re-launch against the latest context. This is a
  // defense-in-depth check on top of the invalidation calls fired at change
  // time (which are best-effort and can race).
  await assertContextFreshOrMarkOutdated(run);

  // Fix-plan §7.1: when an explicit artifactId is given, the artifact MUST
  // belong to this run. getArtifactForRun matches both id AND run_id, so a
  // swapped or foreign artifact id is rejected at the data layer. Ownership is
  // never relaxed by forceOverwrite.
  const artifact =
    (input.artifactId
      ? await getArtifactForRun(run.id, input.artifactId)
      : await getLatestArtifact(run.id)) ?? null;
  if (!artifact) {
    throw new Error(
      input.artifactId
        ? '指定的正文不属于本次续写，无法采纳'
        : '没有可采纳的正文',
    );
  }

  const db = await openDatabase();
  // Read content + updated_at for optimistic concurrency (fix-plan §7.3). The
  // chapter UPDATE below re-checks updated_at in its WHERE clause so a
  // concurrent edit between this read and the transaction is detected and the
  // whole adopt is refused rather than silently overwriting the user's edit.
  const [ch] = await db.executeSql(
    'SELECT content, title, status, updated_at FROM chapters WHERE id = ?',
    [run.chapterId],
  );
  if (ch.rows.length === 0) throw new Error('章节不存在');
  const chapter = ch.rows.item(0);
  const currentContent = String(chapter.content ?? '');
  const currentUpdatedAt = String(chapter.updated_at ?? '');
  const currentHash = contentRevisionHash(currentContent);
  if (
    currentContent.trim().length > 0 &&
    currentHash !== run.inputRevisionHash &&
    !input.forceOverwrite
  ) {
    throw new ContinuationConflictError(
      '章节在生成期间已被编辑，请确认覆盖后再采纳',
    );
  }

  const adoptedHash = artifact.contentHash;
  const ts = new Date().toISOString();

  // Fix-plan §7.2: claim the run first via CAS. If the run was concurrently
  // cancelled/abandoned/outdated (no longer awaiting_user/interrupted), the CAS
  // fails and we refuse to write the chapter — the adopt cannot succeed against
  // a run that is no longer adoptable.
  const claimed = await casUpdateRunState(
    run.id,
    ['awaiting_user', 'interrupted'],
    {
      state: 'completed',
      completionReason: 'adopted',
      adoptedRevisionHash: adoptedHash,
      completedAt: ts,
    },
  );
  if (!claimed) {
    // Re-read to give a precise error; the run may now be outdated/completed.
    const fresh = await getRunById(run.id);
    if (fresh?.state === 'outdated') throw new ContinuationOutdatedError();
    throw new ContinuationConflictError('续写状态已变更，无法采纳');
  }

  // Single local transaction: revision snapshot + write draft content with
  // optimistic concurrency. Never call LLM here. If the chapter was edited
  // concurrently (updated_at changed), the UPDATE affects 0 rows and we surface
  // a conflict. The provisional run claim is reverted below so the user can
  // retry instead of being stranded behind a false adopted state.
  let chapterRowsAffected = 0;
  const statements: Array<{ sql: string; params?: any[] }> = [
    {
      sql: `INSERT INTO content_revisions (
        project_id, target_type, target_id, title, content, source, source_ref, created_at
      ) VALUES (?, 'chapter', ?, ?, ?, 'before_pipeline_accept', ?, ?)`,
      params: [
        run.projectId,
        run.chapterId,
        String(chapter.title ?? ''),
        currentContent,
        run.id,
        ts,
      ],
    },
    {
      sql: `UPDATE chapters SET content = ?, status = CASE WHEN status = 'finalized' THEN status ELSE 'draft' END, updated_at = ?
        WHERE id = ? AND updated_at = ?`,
      params: [artifact.content, ts, run.chapterId, currentUpdatedAt],
    },
  ];
  if (input.allowOpenChecks) {
    const acceptChecks = buildAcceptOpenChecksStatement({
      runId: run.id,
      artifactId: artifact.id,
      ts,
    });
    statements.push({
      sql: acceptChecks.sql,
      params: acceptChecks.params as any[],
    });
  }
  await executeTransaction(db, statements, {
    onStatementComplete: (idx, rowsAffected) => {
      // Statement 2 (1-based) is the chapter UPDATE with the optimistic lock.
      if (idx === 2) chapterRowsAffected = rowsAffected;
    },
  });

  if (chapterRowsAffected === 0) {
    // The chapter changed under us. Restore an adoptable state only if this
    // invocation still owns the provisional adoption.
    await casUpdateRunState(run.id, ['completed'], {
      state: 'awaiting_user',
      completionReason: null,
      adoptedRevisionHash: null,
      completedAt: null,
      errorCode: 'adoption_conflict',
      errorMessage: '章节在采纳期间被并发编辑，请重试',
    });
    throw new ContinuationConflictError(
      '章节在采纳期间被并发编辑，正文未覆盖，请重试',
    );
  }

  return { contentHash: adoptedHash };
}

export async function abandonRun(runId: string): Promise<void> {
  const ok = await casUpdateRunState(
    runId,
    ['awaiting_user', 'interrupted', 'running', 'queued'],
    {
      state: 'completed',
      completionReason: 'abandoned',
      completedAt: new Date().toISOString(),
    },
  );
  if (!ok) {
    const run = await getRunById(runId);
    if (run?.state === 'completed') return;
    throw new Error('无法放弃该 run');
  }
  activeControllers.get(runId)?.abort();
  activeControllers.delete(runId);
}

/**
 * Finalize chapter: mark finalized, dirty SM, link source run and enqueue
 * extract_state outbox — all in ONE local transaction (Spec §11.1, fix-plan §2).
 *
 * Previously the outbox INSERT and the run linkage update ran after the
 * chapters/story-memory transaction committed. If the app was killed in that
 * window the chapter was finalized but no state-extraction task was ever
 * enqueued, silently dropping Story Memory rebuild. They now share a single
 * atomic commit so the chapter cannot reach `finalized` without its
 * extraction task. The post-commit `processContinuationOutbox({ limit: 1 })`
 * call is best-effort acceleration only; reliable delivery is the outbox +
 * cold-start path, never this fire-and-forget trigger.
 *
 * Does NOT call LLM in the transaction.
 */
export async function finalizeContinuationChapter(input: {
  projectId: number;
  chapterId: number;
  content: string;
  sourceRunId?: string | null;
}): Promise<{ revisionHash: string; outboxDedupeKey: string }> {
  const revisionHash = contentRevisionHash(input.content);
  const db = await openDatabase();
  const [ch] = await db.executeSql(
    'SELECT position FROM chapters WHERE id = ?',
    [input.chapterId],
  );
  if (ch.rows.length === 0) throw new Error('章节不存在');
  const position = ch.rows.item(0).position as number;
  const ts = new Date().toISOString();

  // Spec §5.1 / fix-plan §5.1: the authoritative frozen field is
  // `resolvedModelConfigIds` (built by continuationContextBuilder). The legacy
  // `resolvedLlmConfigIds` key was never written, so it silently read as null
  // and State Extraction fell back to the live active config on every run.
  let resolvedSourceRunId: string | null = input.sourceRunId ?? null;
  let sourceRun: ContinuationGenerationRun | null = null;
  if (input.sourceRunId) {
    sourceRun = await getRunById(input.sourceRunId);
    if (
      !sourceRun ||
      sourceRun.projectId !== input.projectId ||
      sourceRun.chapterId !== input.chapterId
    ) {
      throw new Error('sourceRunId 不属于当前项目或章节，无法定稿');
    }
  } else {
    sourceRun = await findLatestAdoptedRunForChapter(
      input.projectId,
      input.chapterId,
    );
    resolvedSourceRunId = sourceRun?.id ?? null;
  }

  let frozenStateExtractionConfigId: number | null = null;
  let missingFrozenConfigReason: string | null = null;
  if (sourceRun) {
    try {
      const snapshot = JSON.parse(sourceRun.settingsSnapshotJson);
      const resolved = snapshot?.resolvedModelConfigIds?.stateExtraction;
      if (typeof resolved === 'number') {
        frozenStateExtractionConfigId = resolved;
      } else {
        // Old / corrupt snapshot: stay safe (null) but record the reason in
        // the outbox payload so the worker and UI can surface it without
        // logging the prompt or chapter body.
        missingFrozenConfigReason =
          snapshot?.resolvedModelConfigIds == null
            ? 'snapshot_missing_resolved_model_config_ids'
            : 'snapshot_state_extraction_not_number';
      }
    } catch {
      frozenStateExtractionConfigId = null;
      missingFrozenConfigReason = 'settings_snapshot_json_unparseable';
    }
  } else {
    missingFrozenConfigReason = 'manual_or_unknown_source_run';
  }

  const dedupeKey = `extract_state:${input.chapterId}:${revisionHash}`;
  const rebuildDedupeKey = `rebuild_story_memory:auto:${input.projectId}:${position}:${revisionHash}`;
  const outboxId = `co_${v4().replace(/-/g, '')}`;
  const rebuildOutboxId = `co_${v4().replace(/-/g, '')}`;

  const statements: Array<{ sql: string; params?: any[] }> = [
    {
      sql: 'INSERT OR IGNORE INTO project_story_memory (project_id, updated_at) VALUES (?, ?)',
      params: [input.projectId, ts],
    },
    {
      sql: `UPDATE chapters SET content = ?, status = 'finalized',
        finalized_at = ?, updated_at = ? WHERE id = ?`,
      params: [input.content, ts, ts, input.chapterId],
    },
    {
      sql: `UPDATE project_story_memory SET status = 'dirty',
        dirty_from_position = CASE
          WHEN dirty_from_position IS NULL THEN ?
          WHEN dirty_from_position > ? THEN ?
          ELSE dirty_from_position
        END,
        updated_at = ?
      WHERE project_id = ?`,
      params: [position, position, position, ts, input.projectId],
    },
  ];

  // Link the finalized hash onto the source run inside the same tx so the
  // chapter and its run linkage commit or roll back together.
  if (resolvedSourceRunId) {
    statements.push({
      sql: `UPDATE continuation_generation_runs
        SET finalized_revision_hash = ?, updated_at = ?
        WHERE id = ? AND state IN ('completed', 'awaiting_user', 'interrupted')`,
      params: [revisionHash, ts, resolvedSourceRunId],
    });
  }

  // INSERT OR IGNORE: re-tapping finalize for an unchanged chapter never
  // duplicates the extract_state task (UNIQUE(dedupe_key)).
  statements.push(
    buildOutboxInsertStatement({
      id: outboxId,
      projectId: input.projectId,
      chapterId: input.chapterId,
      operation: 'extract_state',
      payload: {
        projectId: input.projectId,
        chapterId: input.chapterId,
        chapterRevisionHash: revisionHash,
        sourceRunId: resolvedSourceRunId,
        llmConfigId: frozenStateExtractionConfigId,
        // Visible audit hint only — never the prompt or chapter body.
        configNote: missingFrozenConfigReason,
      },
      dedupeKey,
      ts,
    }),
    // Chapter summaries and Story Memory describe finalized text, not proposal
    // decisions. Queue their rebuild now, but make it depend on durable state
    // extraction so a crash/retry cannot run the two jobs out of order.
    buildOutboxInsertStatement({
      id: rebuildOutboxId,
      projectId: input.projectId,
      chapterId: input.chapterId,
      operation: 'rebuild_story_memory',
      payload: {
        fromPosition: position,
        reason: 'finalized_chapter_memory',
        dependsOnDedupeKey: dedupeKey,
      },
      dedupeKey: rebuildDedupeKey,
      ts,
    }),
  );

  await executeTransaction(db, statements);

  // Best-effort acceleration only. Reliable delivery is the outbox + cold
  // start path (markRunsInterruptedOnColdStart + processContinuationOutbox),
  // never this fire-and-forget trigger.
  // The dependent Story Memory rebuild is inserted beside the extraction
  // event. Process both in creation order when the app remains alive; cold
  // start processing still makes the chain recoverable after interruption.
  processContinuationOutbox({ limit: 2 }).catch(() => {});

  return { revisionHash, outboxDedupeKey: dedupeKey };
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

export function isContinuationRunId(id: string): boolean {
  return id.startsWith('ct_');
}

export async function outdatedRunsOnSourceOrCanonChange(
  projectId: number,
  reason: string,
): Promise<void> {
  await markRunsOutdatedForProject(projectId, reason);
}

export type { ContinuationRunState };

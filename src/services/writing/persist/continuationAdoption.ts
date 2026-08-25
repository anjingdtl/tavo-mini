/**
 * Continuation adoption / finalization / cancel domain operations
 * (Writing Kernel unification step).
 *
 * These user-decision and persistence operations previously lived inside the
 * legacy continuation generation runner. Production UI and the multi-chapter
 * batch adapter must import them from here; the legacy runner only keeps
 * re-export shims for historical tests.
 *
 * Module boundaries:
 *  - repository / types / checker / repair helpers come from the continuation
 *    generation persistence modules;
 *  - stage capacity policy comes from the unified writing scenario layer;
 *  - the legacy V2 prompt compilers (writer / checker / repair) are frozen
 *    copies of the legacy prompt compiler so this production module never
 *    imports the legacy runner/prompt-compiler modules.
 */
import type { ChatMessage } from '../../llm/types';
import {
  callLLMResult,
  resolveLLMRequestConfig,
  resolveLLMRequestConfigById,
} from '../../llm';
import {
  appendContinuationGenerationTraceEvent,
  ensureContinuationGenerationTrace,
} from '../../continuation/generation/continuationGenerationTrace';
import {
  bindIssuesToArtifact,
  filterBySettings,
  parseCheckerLlmJson,
  runDeterministicChecks,
} from '../../continuation/generation/continuationChecker';
import {
  shouldRunRepair,
  tryDeterministicRepair,
} from '../../continuation/generation/continuationRepairService';
import {
  applyParsedRepairPatches,
  isRepairCandidateUsable,
  parseRepairPatches,
  validateRepairPatchCoverage,
  validateRepairPatches,
} from '../../continuation/generation/continuationRepairPatch';
import {
  buildAcceptOpenChecksStatement,
  buildOutboxInsertStatement,
  casUpdateRunState,
  contentRevisionHash,
  getEligibleArtifactForRun,
  getArtifactForRun,
  getLatestArtifact,
  getLatestEligibleArtifact,
  getPlan,
  getRunById,
  getRunContextSnapshotJson,
  findLatestAdoptedRunForChapter,
  insertArtifact,
  insertCheckResults,
  markChecksAutoRepaired,
  markChecksObsolete,
  markRunsOutdatedForProject,
  listChecksForArtifact,
  savePlan,
} from '../../continuation/generation/generationRepository';
import type {
  ContinuationArtifact,
  ContinuationCheckResult,
  ContinuationContextSnapshot,
  ContinuationContextTrace,
  ContinuationGenerationRun,
  ContinuationPlan,
  ContinuationRunState,
  FrozenContinuationModelConfig,
} from '../../continuation/generation/types';
import {
  ContinuationCapabilityBlockedError,
  ContinuationConflictError,
  ContinuationOutdatedError,
} from '../../continuation/generation/types';
import { openDatabase } from '../../../data/connection/openDatabase';
import { executeTransaction } from '../../database/transaction';
import { v4 } from '../../uuidBridge';
import { processContinuationOutbox } from '../../continuation/generation/continuationStateOutboxWorker';
import { estimateMessagesTokens } from '../../../utils/tokenEstimator';
import { resolveElasticStageOutputReservation } from '../../contextAutoAllocator';
import { activeContinuationControllers as activeControllers } from '../../continuation/generation/continuationRunControllers';
import { markContinuationStagesCancelled } from '../../continuation/generation/continuationStageCancellation';
import { CanonQueryService } from '../../continuation/canon/canonQueryService';
import { continuationSourceReader } from '../../continuation/continuationSourceReader';
import {
  CONTINUATION_BUDGET_POLICY,
  type ResolvedStageCapacity,
} from '../scenario/continuationStageCapacity';
import {
  assertWritingPersistedEventAllowsMemoryUpdate,
  buildWritingPersistedEvent,
} from '../flow/writingPersistedEvent';
import { closeContinuationPostWritingSnapshot } from '../flow/continuationPostWritingClosure';
import {
  countHanCharacters,
  evaluateContinuationLength,
  isContinuationLengthIssueSubtype,
  resolveContinuationLengthContract,
} from '../../continuation/generation/continuationLengthContract';
import type {
  StageLlmCallResult,
  StageLlmCaller,
} from '../scenario/continuationWritingTypes';
import { makeContinuationChapterNumbering } from '../../continuation/chapterNumbering/continuationChapterNumbering';
import {
  renderStyleProfile,
  type StyleRenderLevel,
} from '../../continuation/styleProfile/styleProfileRenderer';

function traceJsonForRunState(input: {
  run: ContinuationGenerationRun;
  event: Parameters<typeof appendContinuationGenerationTraceEvent>[1]['event'];
  state: ContinuationRunState;
  stage?: import('../../continuation/generation/types').ContinuationStageName | null;
  reason?: string | null;
  adoption?: Partial<
    NonNullable<ContinuationContextTrace['generationTrace']>['adoption']
  >;
  finalization?: Partial<
    NonNullable<ContinuationContextTrace['generationTrace']>['finalization']
  >;
}): string | null {
  if (!input.run.contextSnapshotJson) return null;
  try {
    const snapshot = JSON.parse(input.run.contextSnapshotJson) as ContinuationContextSnapshot;
    const trace = input.run.contextTraceJson
      ? (JSON.parse(input.run.contextTraceJson) as ContinuationContextTrace)
      : ({
          sourceId: snapshot.source.sourceId,
          canonSnapshotId: snapshot.canon.snapshotId,
          canonRevision: snapshot.canon.revision,
          targetPosition: snapshot.targetPosition,
          entityRefs: [],
          storyMemoryFingerprint: snapshot.storyMemory.stateFingerprint,
          freshness: snapshot.bundles.effectiveState.freshness,
          categories: [],
          totalInputTokens: 0,
          reservedOutputTokens: 0,
          omittedCapabilities: [],
        } satisfies ContinuationContextTrace);
    const unified = ensureContinuationGenerationTrace(trace, snapshot, {
      runId: input.run.id,
      state: input.run.state,
      stage: input.run.stage,
    });
    return JSON.stringify(
      appendContinuationGenerationTraceEvent(unified, {
        event: input.event,
        state: input.state,
        stage: input.stage ?? null,
        reason: input.reason ?? null,
        adoption: input.adoption,
        finalization: input.finalization,
      }),
    );
  } catch {
    return null;
  }
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

function resolveRepairMaxTokens(
  snapshot: ContinuationContextSnapshot,
): number | null {
  const frozen = capacityForStage(snapshot, 'repair')?.maxOutputTokens;
  if (Number.isFinite(frozen) && Number(frozen) > 0) {
    return Number(frozen);
  }
  const window =
    snapshot.contextBudget?.modelContextLimit ||
    snapshot.stageBudgets?.writer?.contextWindow ||
    0;
  if (!window) return null;
  return resolveElasticStageOutputReservation({
    contextWindow: Number(window),
    modelMaxOutputTokens:
      snapshot.contextBudget?.writerMaxOutputTokens ||
      snapshot.stageBudgets?.writer?.maxOutputTokens,
  });
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

function frozenModelConfigForStage(
  snapshot: ContinuationContextSnapshot,
  stage: 'writer' | 'checker' | 'repair',
): FrozenContinuationModelConfig | null {
  return snapshot.settingsSnapshot.frozenModelConfigs?.[stage] ?? null;
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
    const patches = parseRepairPatches(result.text);
    if (!patches || !validateRepairPatches(artifact.content, patches)) {
      throw new Error(
        '额外 Repair 未返回通过 JSON、offset 和插入边界校验的补丁，候选正文保持不变',
      );
    }
    const coverage = validateRepairPatchCoverage({
      patches,
      issues: severeChecks,
    });
    const repaired = applyParsedRepairPatches(artifact.content, patches);
    if (repaired === artifact.content) {
      throw new Error('额外 Repair 未改变正文，候选正文保持不变');
    }
    const repairedLocalIssues = filterBySettings(
      bindIssuesToArtifact(
        runDeterministicChecks(repaired, snapshot),
        repaired,
        new Set(snapshot.bundles.canon.evidenceRefs),
      ),
      snapshot.settingsSnapshot.values,
    );
    const repairedLength = evaluateContinuationLength(
      repaired,
      snapshot.settingsSnapshot.values.targetChapterChars,
    );
    const lengthResolved =
      coverage.chapterLengthIssues.length > 0 &&
      repairedLength.status === 'within';
    const hasCoveredOrdinaryIssue = coverage.coveredIssues.length > 0;
    const hasLengthIssue = coverage.chapterLengthIssues.length > 0;
    const candidateUsable = isRepairCandidateUsable(
      artifact.content,
      repaired,
      snapshot.settingsSnapshot.values.targetChapterChars,
      'additional',
    );
    const lengthSafelyImproved =
      hasLengthIssue && repairedLength.status !== 'within' && candidateUsable;
    const hasRepairProgress =
      hasCoveredOrdinaryIssue || lengthResolved || lengthSafelyImproved;
    if (!hasRepairProgress) {
      throw new Error(
        '额外 Repair 补丁没有覆盖任何待修复的普通严重问题，候选正文保持不变',
      );
    }
    if (!candidateUsable) {
      throw new Error(
        '额外 Repair 候选破坏动态长度契约、过度缩短或明显远离目标，已保留原候选；本次不再重试，也不会调用 LLM Checker。',
      );
    }

    const checksToMark = new Set<number>();
    for (const issue of coverage.coveredIssues) {
      if (issue.id <= 0) continue;
      if (isLocalDeterministicSubtype(issue.subtype)) {
        const remains = repairedLocalIssues.some(
          localIssue =>
            localIssue.subtype === issue.subtype &&
            (issue.generatedStart == null ||
              localIssue.generatedStart === issue.generatedStart) &&
            (issue.generatedEnd == null ||
              localIssue.generatedEnd === issue.generatedEnd),
        );
        if (remains) continue;
      }
      checksToMark.add(issue.id);
    }
    if (lengthResolved) {
      for (const issue of coverage.chapterLengthIssues) {
        if (issue.id > 0) checksToMark.add(issue.id);
      }
    }
    if (checksToMark.size > 0) {
      await markChecksAutoRepaired(
        runId,
        artifact.id,
        Array.from(checksToMark),
      );
    }
    const repairedArtifact = await insertArtifact({
      runId,
      stage: 'repair',
      content: repaired,
      repairRound: artifact.repairRound + 1,
      parentArtifactId: artifact.id,
    });
    const unresolvedCheckerIssues = severeChecks
      .filter(check => !isLocalDeterministicSubtype(check.subtype))
      .filter(check => !checksToMark.has(check.id))
      .map(check => rebindCheckToContent(check, repairedArtifact.content));
    await insertCheckResults(
      [...repairedLocalIssues, ...unresolvedCheckerIssues].map(i => ({
        ...i,
        runId,
        chapterId: snapshot.targetChapterId,
        artifactId: repairedArtifact.id,
        artifactHash: repairedArtifact.contentHash,
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
 * Build the per-stage LLM caller used by continueFromWriter. Shared by
 * confirmPlanAndContinue so it resolves config ids from the FROZEN snapshot
 * (resolvedModelConfigIds) via the injected caller or the default caller,
 * never from the live active config mid-run.
 */
function buildStageCaller(
  callStage: StageLlmCaller | undefined,
  controller: AbortController,
  projectId: number,
  runId: string,
  tokenUsage: Record<string, any>,
  frozenModelConfigs?: import('../../continuation/generation/types').ContinuationGenerationSettingsSnapshot['frozenModelConfigs'],
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
  if (run.workflowVersion === 4) {
    throw new Error('V4 不使用 Planner 确认步骤。');
  }
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
        const repairMaxTokens = resolveRepairMaxTokens(snapshot);
        if (!repairMaxTokens) {
          opts.tokenUsage.repair = {
            ...(opts.tokenUsage.repair ?? {}),
            warning: 'repair_skipped',
            warningMessage: '缺少 Repair 冻结输出预算，已跳过模型修复。',
          };
          break;
        }
        repaired = (
          await opts.call(
            'repair',
            compileRepairMessages(snapshot, artifact.content, openChecks),
            repairMaxTokens,
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
 * User-initiated cancel. Must never throw into the UI thread: abort, DB
 * finalization and V4 stage cleanup are all best-effort. Concurrent cancel
 * taps and in-flight stage writers are tolerated.
 */
export async function cancelContinuationRun(runId: string): Promise<void> {
  try {
    // 1) Abort first so in-flight fetch stops. AbortController.abort is
    // idempotent; still wrap in case a host polyfill misbehaves.
    const controller = activeControllers.get(runId);
    try {
      controller?.abort();
    } catch {
      // ignore
    }
    activeControllers.delete(runId);

    // 2) Load run for workflowVersion; tolerate missing/deleted rows.
    const run = await getRunById(runId).catch(() => null);
    if (
      run &&
      (run.state === 'cancelled' ||
        run.state === 'completed' ||
        run.state === 'outdated')
    ) {
      // Already terminal; still try to settle any V4/V5 stage rows left
      // mid-flight (the canonical settlement is workflow-version agnostic).
      if (run.workflowVersion === 4 || run.workflowVersion === 5) {
        await markContinuationStagesCancelled(runId).catch(() => {});
      }
      return;
    }

    // 3) Mark run cancelled. Include interrupted so a half-settled cancel can
    // still be forced to the cancelled terminal (user intent wins).
    await casUpdateRunState(
      runId,
      [
        'queued',
        'running',
        'awaiting_user',
        'awaiting_regeneration',
        'interrupted',
      ],
      {
        state: 'cancelled',
        errorCode: 'cancelled',
        errorMessage: '用户取消',
        completedAt: new Date().toISOString(),
      },
    ).catch(() => false);

    // 4) V4/V5 stage rows: never let a single stage update take down the app.
    // Both legacy markers share the same canonical settlement body.
    if (
      run?.workflowVersion === 4 ||
      run?.workflowVersion === 5 ||
      run == null
    ) {
      await markContinuationStagesCancelled(runId).catch(() => {});
    }
  } catch (error) {
    // Absolute last resort: cancel is a user safety action and must not crash.
    console.warn('[continuation] cancelContinuationRun failed:', error);
  }
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

  // Historical V2 fixtures/runs retain their original freshness reader for
  // backward compatibility. New V4 runs take the CanonQueryService branch
  // below; no V4 caller can reach this legacy SQL path.
  // V2 freshness path. V4/V5 use CanonQueryService branch below.
  if (run.workflowVersion !== 4 && run.workflowVersion !== 5) {
    const db = await openDatabase();
    const [settingsRes] = await db.executeSql(
      'SELECT active_source_id, active_canon_snapshot_id FROM continuation_settings WHERE project_id = ?',
      [run.projectId],
    );
    if (settingsRes.rows.length === 0) {
      await casUpdateRunState(run.id, ['awaiting_user', 'interrupted'], {
        state: 'outdated',
        errorCode: 'outdated',
        errorMessage: 'source_missing',
        completedAt: new Date().toISOString(),
      });
      throw new ContinuationOutdatedError();
    }
    const settings = settingsRes.rows.item(0);
    if (run.sourceId != null && Number(settings.active_source_id) !== Number(run.sourceId)) {
      await casUpdateRunState(run.id, ['awaiting_user', 'interrupted'], {
        state: 'outdated',
        errorCode: 'outdated',
        errorMessage: 'source_changed',
        completedAt: new Date().toISOString(),
      });
      throw new ContinuationOutdatedError();
    }
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
      if (Number(snapRes.rows.item(0).revision) !== Number(run.canonRevision)) {
        await casUpdateRunState(run.id, ['awaiting_user', 'interrupted'], {
          state: 'outdated',
          errorCode: 'outdated',
          errorMessage: 'canon_revision_changed',
          completedAt: new Date().toISOString(),
        });
        throw new ContinuationOutdatedError();
      }
    }
    return;
  }

  let activeSource: Awaited<
    ReturnType<typeof continuationSourceReader.getSnapshot>
  >;
  try {
    activeSource = await continuationSourceReader.getSnapshot(run.projectId);
  } catch {
    // A missing active Source is observable through the bounded reader; V4
    // adoption must not bypass CanonQueryService/reader boundaries with SQL.
    await casUpdateRunState(run.id, ['awaiting_user', 'interrupted'], {
      state: 'outdated',
      errorCode: 'outdated',
      errorMessage: 'source_missing',
      completedAt: new Date().toISOString(),
    });
    throw new ContinuationOutdatedError();
  }
  // Source mismatch (run frozen a source that is no longer active).
  if (run.sourceId != null && Number(activeSource.sourceId) !== Number(run.sourceId)) {
    await casUpdateRunState(run.id, ['awaiting_user', 'interrupted'], {
      state: 'outdated',
      errorCode: 'outdated',
      errorMessage: 'source_changed',
      completedAt: new Date().toISOString(),
    });
    throw new ContinuationOutdatedError();
  }
  // Canon snapshot mismatch: compare active snapshot id + revision.
  let activeCanon: Awaited<ReturnType<typeof CanonQueryService.getActiveSnapshot>>;
  try {
    activeCanon = await CanonQueryService.getActiveSnapshot(run.projectId);
  } catch {
    await casUpdateRunState(run.id, ['awaiting_user', 'interrupted'], {
      state: 'outdated',
      errorCode: 'outdated',
      errorMessage: 'canon_snapshot_deleted',
      completedAt: new Date().toISOString(),
    });
    throw new ContinuationOutdatedError();
  }
  const activeCanonId = activeCanon.id;
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
    // CanonQueryService returns the active revision; no V4 caller is allowed
    // to inspect continuation_canon_snapshots directly.
    if (Number(activeCanon.revision) !== Number(run.canonRevision)) {
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
  if (run.state === 'awaiting_regeneration') {
    throw new Error('最终稿未形成可交付结果，请重新生成或放弃');
  }
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
  const useEligibleOnly =
    run.workflowVersion === 4 || run.workflowVersion === 5;
  const artifact =
    (input.artifactId
      ? useEligibleOnly
        ? await getEligibleArtifactForRun(run.id, input.artifactId)
        : await getArtifactForRun(run.id, input.artifactId)
      : useEligibleOnly
        ? await getLatestEligibleArtifact(run.id)
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
  // V5: only stage=final + eligible may be adopted.
  if (
    run.workflowVersion === 5 &&
    artifact.stage !== 'final'
  ) {
    throw new Error('只有最终稿 V3 可被采纳');
  }
  if (
    (run.workflowVersion === 4 || run.workflowVersion === 5) &&
    artifact.eligibilityStatus !== 'eligible'
  ) {
    throw new Error('当前正文不可采纳');
  }

  const claimed = await casUpdateRunState(
    run.id,
    ['awaiting_user', 'interrupted'],
    {
      state: 'completed',
      completionReason: 'adopted',
      adoptedRevisionHash: adoptedHash,
      completedAt: ts,
      contextTraceJson: traceJsonForRunState({
        run,
        event: 'completed',
        state: 'completed',
        stage: 'awaiting_user',
        adoption: {
          status: 'adopted',
          adoptedRevisionHash: adoptedHash,
        },
        finalization: {
          status: 'pending',
          finalizedRevisionHash: null,
          completionReason: 'adopted',
        },
      }) ?? undefined,
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
  const run = await getRunById(runId);
  const ok = await casUpdateRunState(
    runId,
    [
      'awaiting_user',
      'awaiting_regeneration',
      'interrupted',
      'running',
      'queued',
      // The result screen renders 放弃 for failed runs too; without this
      // source state the CAS matches nothing and the user can never clear
      // a failed result (放弃失败：无法放弃该 run).
      'failed',
    ],
    {
      state: 'completed',
      completionReason: 'abandoned',
      completedAt: new Date().toISOString(),
      contextTraceJson: run
        ? traceJsonForRunState({
            run,
            event: 'completed',
            state: 'completed',
            stage: 'awaiting_user',
            adoption: { status: 'abandoned', adoptedRevisionHash: null },
            finalization: {
              status: 'not_started',
              finalizedRevisionHash: null,
              completionReason: 'abandoned',
            },
          }) ?? undefined
        : undefined,
    },
  );
  if (!ok) {
    const freshRun = await getRunById(runId);
    if (freshRun?.state === 'completed') return;
    throw new Error('无法放弃该 run');
  }
  activeControllers.get(runId)?.abort();
  activeControllers.delete(runId);
}

function parseRunSnapshot(run: ContinuationGenerationRun | null): any | null {
  if (!run?.contextSnapshotJson) return null;
  try {
    return JSON.parse(run.contextSnapshotJson);
  } catch {
    return null;
  }
}

function readRunTraceField(
  run: ContinuationGenerationRun | null,
  field: 'generationTraceId' | 'freezeFingerprint',
): string {
  const snapshot = parseRunSnapshot(run);
  const value = snapshot?.writingKernelTrace?.[field];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function readRunExecutionProfile(
  run: ContinuationGenerationRun | null,
): 'standard' | 'one_shot' {
  const snapshot = parseRunSnapshot(run);
  const profile =
    snapshot?.frozenWritingContext?.stagePolicy?.values?.executionProfile;
  return profile === 'one_shot' ? 'one_shot' : 'standard';
}

function readRunAppliedRequirementIds(
  run: ContinuationGenerationRun | null,
): string[] {
  const snapshot = parseRunSnapshot(run);
  const items = snapshot?.frozenWritingContext?.requirements?.items;
  if (!Array.isArray(items)) return [];
  return items
    .filter(
      (item: { applied?: boolean; id?: string }) =>
        item && item.applied && typeof item.id === 'string' && item.id.trim(),
    )
    .map((item: { id: string }) => item.id);
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
  if (!input.content.trim()) {
    throw new Error('章节正文为空，无法定稿。请先采纳或写入正文。');
  }
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
  if (sourceRun) {
    // Metadata reads project the giant snapshot column away (CursorWindow
    // limit on low-RAM devices); the finalization trace still needs the
    // frozen fields, so stream the body back in chunks here.
    sourceRun.contextSnapshotJson = await getRunContextSnapshotJson(
      sourceRun.id,
    );
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

  const persistedEvent = buildWritingPersistedEvent({
    generationTraceId:
      readRunTraceField(sourceRun, 'generationTraceId') ||
      `continuation-finalize:${input.chapterId}:${revisionHash}`,
    freezeFingerprint:
      readRunTraceField(sourceRun, 'freezeFingerprint') ||
      'continuation-local-finalize',
    projectId: input.projectId,
    chapterId: input.chapterId,
    chapterPosition: position,
    finalBody: input.content,
    executionProfile: readRunExecutionProfile(sourceRun),
    appliedRequirementIds: readRunAppliedRequirementIds(sourceRun),
    scenario: 'continuation',
  });
  assertWritingPersistedEventAllowsMemoryUpdate(persistedEvent);

  const dedupeKey = `extract_state:${input.chapterId}:${revisionHash}`;
  const rebuildDedupeKey = `rebuild_story_memory:auto:${input.projectId}:${position}:${revisionHash}`;
  const outboxId = `co_${v4().replace(/-/g, '')}`;
  const rebuildOutboxId = `co_${v4().replace(/-/g, '')}`;
  const finalizedTraceJson = sourceRun
    ? traceJsonForRunState({
        run: sourceRun,
        event: 'completed',
        state: 'completed',
        stage: 'awaiting_user',
        finalization: {
          status: 'finalized',
          finalizedRevisionHash: revisionHash,
          completionReason: sourceRun.completionReason,
        },
      })
    : null;
  let finalizedKernelSnapshotJson: string | null = null;
  if (sourceRun?.contextSnapshotJson) {
    let snapshot: Record<string, any>;
    try {
      snapshot = JSON.parse(sourceRun.contextSnapshotJson);
    } catch {
      throw new Error('Continuation Kernel snapshot 无法解析，禁止进入 PostWriting');
    }
    const topology =
      snapshot?.frozenWritingContext?.stagePolicy?.values
        ?.pipelineTopologyVersion;
    if (topology === 'compact_standard' && !snapshot.writingKernelTrace) {
      throw new Error(
        'WRITING_POST_WRITING_TRACE_MISSING: Compact Continuation snapshot has no durable Kernel trace',
      );
    }
    if (snapshot.writingKernelTrace) {
      finalizedKernelSnapshotJson = JSON.stringify(
        closeContinuationPostWritingSnapshot({
          snapshot,
          persistedEvent,
          // Story Memory and state extraction are queued after the atomic
          // finalize boundary; the trace still records the handoff itself.
          durationMs: 0,
        }),
      );
    }
  }

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
        SET finalized_revision_hash = ?,
            context_snapshot_json = COALESCE(?, context_snapshot_json),
            context_trace_json = COALESCE(?, context_trace_json), updated_at = ?
        WHERE id = ? AND state IN ('completed', 'awaiting_user', 'interrupted')`,
      params: [
        revisionHash,
        finalizedKernelSnapshotJson,
        finalizedTraceJson,
        ts,
        resolvedSourceRunId,
      ],
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
        writingPersistedEvent: persistedEvent,
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

export function isContinuationRunId(id: string): boolean {
  return id.startsWith('ct_');
}

export async function outdatedRunsOnSourceOrCanonChange(
  projectId: number,
  reason: string,
): Promise<void> {
  await markRunsOutdatedForProject(projectId, reason);
}

// ---------------------------------------------------------------------------
// Frozen legacy V2 prompt compilers (Writer / Checker / Repair).
//
// Verbatim copies of the legacy stage prompt builders so this production
// module never imports the legacy prompt-compiler module. Only the three
// compilers needed by confirmPlanAndContinue / repairContinuationArtifactOnce
// are copied; the legacy module keeps the originals for historical runs.
// ---------------------------------------------------------------------------

/**
 * User-visible chapter title for the frozen target position (Spec §11.3).
 * Continues from the source boundary; never exposes bare internal position as
 * if it were the display chapter number. Falls back to position+1 when the
 * frozen source snapshot lacks a boundary (legacy / partial fixtures).
 */
function displayTargetTitle(s: ContinuationContextSnapshot): string {
  const boundaryPos = s.source?.boundary?.chapterPosition;
  const boundaryChapterNumber =
    boundaryPos != null && Number.isFinite(Number(boundaryPos))
      ? Number(boundaryPos) + 1
      : null;
  return makeContinuationChapterNumbering(
    boundaryChapterNumber,
  ).getDefaultTitle(s.targetPosition);
}

function displayNumberFor(
  s: ContinuationContextSnapshot,
  position: number,
): number {
  const boundaryPos = s.source?.boundary?.chapterPosition;
  const boundaryChapterNumber =
    boundaryPos != null && Number.isFinite(Number(boundaryPos))
      ? Number(boundaryPos) + 1
      : null;
  return makeContinuationChapterNumbering(
    boundaryChapterNumber,
  ).getDisplayNumber(position as any);
}

function lockedBlock(s: ContinuationContextSnapshot): string {
  return s.bundles.lockedRules.length
    ? `【用户锁定/硬规则】\n${s.bundles.lockedRules.join('\n')}`
    : '【用户锁定/硬规则】（无）';
}

function evidenceLabel(
  s: ContinuationContextSnapshot,
  ownerType: string,
  ownerId: number,
): string {
  const ids =
    s.bundles.canon.evidenceRefsByOwner?.[
      ownerType as keyof NonNullable<typeof s.bundles.canon.evidenceRefsByOwner>
    ]?.[ownerId];
  return ids?.length ? `（证据:${ids.join(',')}）` : '';
}

/**
 * The continuation checker is a factual gate, not merely a style reviewer.
 * Keep every selected Canon family visible here; otherwise a run could have
 * analysed relationships/knowledge/timeline yet never give them to the LLM
 * that decides whether a generated chapter contradicts the original work.
 */
function canonFactCheckBlock(s: ContinuationContextSnapshot): string {
  const canon = s.bundles.canon;
  const plotFactKeys = new Set(
    (canon.plotThreads ?? []).map(
      plot => `${plot.title.trim()}:${plot.description.trim()}`,
    ),
  );
  const names = new Map(
    (canon.characters ?? []).map(character => [
      character.id,
      character.canonicalName,
    ]),
  );
  const nameOf = (id: number) => names.get(id) ?? `人物#${id}`;
  const line = (body: string, ownerType: string, id: number) =>
    `- ${body}${evidenceLabel(s, ownerType, id)}`;

  const sections = [
    [
      '世界规则',
      (canon.worldRules ?? []).map(r =>
        line(`${r.title}: ${r.description}`, 'world_rule', r.id),
      ),
    ],
    [
      '人物资料',
      (canon.characters ?? []).map(c =>
        line(`${c.canonicalName}: ${c.description}`, 'character', c.id),
      ),
    ],
    [
      '人物状态',
      (canon.characterStates ?? []).map(state =>
        line(
          `${nameOf(state.characterId)}：${
            state.summary || `状态=${state.aliveState}`
          }`,
          'character_state',
          state.id,
        ),
      ),
    ],
    [
      '人物关系',
      (canon.relationships ?? []).map(rel =>
        line(
          `${nameOf(rel.sourceCharacterId)}→${nameOf(rel.targetCharacterId)}（${
            rel.relationType
          }/${rel.attitude}）：${rel.description}`,
          'relationship',
          rel.id,
        ),
      ),
    ],
    [
      '人物经历',
      (canon.experiences ?? []).map(exp =>
        line(
          `${nameOf(exp.characterId)}：${exp.title}；${exp.description}`,
          'experience',
          exp.id,
        ),
      ),
    ],
    [
      '知识边界',
      (canon.knowledge ?? []).map(item =>
        line(
          `${nameOf(item.characterId)}对“${item.factKey}”=${
            item.knowledgeState
          }；${item.factSummary}`,
          'knowledge',
          item.id,
        ),
      ),
    ],
    [
      '剧情线索',
      (canon.plotThreads ?? []).map(plot =>
        line(
          `${plot.title}（${plot.status}）：${plot.description}`,
          'plot_thread',
          plot.id,
        ),
      ),
    ],
    [
      '时间线',
      (canon.timelineEvents ?? [])
        // A timeline item can materialize the exact same fact as a plot
        // thread. Keep the plot (it has the continuation status) and avoid
        // sending the same fact twice to the planner/writer.
        .filter(
          event =>
            !plotFactKeys.has(`${event.title.trim()}:${event.summary.trim()}`),
        )
        .map(event =>
          line(`${event.title}：${event.summary}`, 'timeline_event', event.id),
        ),
    ],
  ] as Array<[string, string[]]>;
  const rendered = sections
    .filter(([, lines]) => lines.length > 0)
    .map(([title, lines]) => `${title}:\n${lines.join('\n')}`)
    .join('\n');
  return `【原著事实复核依据】\n${
    rendered || '（当前快照未检索到与本章相关的原著事实）'
  }`;
}

function stateBlock(s: ContinuationContextSnapshot): string {
  const st = s.bundles.effectiveState;
  // Baseline Canon facts have their own complete block. This block contains
  // only post-boundary continuation deltas, avoiding duplicate injection.
  const chars = st.characterStates
    .filter(c => c.source !== 'canon')
    .map(c => `- ${JSON.stringify(c.ref)}: ${c.summary}`)
    .join('\n');
  const plots = st.plotThreads
    .filter(p => p.sourceLayer !== 'canon')
    .map(p => `- ${p.title} (${p.status}): ${p.summary}`)
    .join('\n');
  const relationships = (st.relationships ?? [])
    .filter(r => r.sourceLayer !== 'canon')
    .map(
      r =>
        `- ${JSON.stringify(r.source)} → ${JSON.stringify(r.target)}: ${
          r.summary
        }`,
    )
    .join('\n');
  const canonKnowledge = new Set(
    (s.bundles.canon.knowledge ?? []).map(
      item => `${item.characterId}:${item.factKey}:${item.factSummary}`,
    ),
  );
  const knowledge = (st.knowledge ?? [])
    .filter(
      k =>
        !canonKnowledge.has(
          `${k.ref.refType === 'canon_character' ? k.ref.id : ''}:${
            k.factKey
          }:${k.factSummary}`,
        ),
    )
    .map(
      k =>
        `- ${JSON.stringify(k.ref)} ${k.factKey}: ${k.factSummary}（${
          k.knowledgeState
        }）`,
    )
    .join('\n');
  const canonExperiences = new Set(
    (s.bundles.canon.experiences ?? []).map(
      item => `${item.characterId}:${item.title}:${item.description}`,
    ),
  );
  const experiences = (st.experiences ?? [])
    .filter(
      e =>
        !canonExperiences.has(
          `${e.ref.refType === 'canon_character' ? e.ref.id : ''}:${e.title}:${
            e.summary
          }`,
        ),
    )
    .map(e => `- ${JSON.stringify(e.ref)}: ${e.title}；${e.summary}`)
    .join('\n');
  return `【第 ${displayNumberFor(
    s,
    s.targetPosition,
  )} 章已确认续写增量状态】\n人物状态:\n${chars || '（无新增）'}\n人物关系:\n${
    relationships || '（无新增）'
  }\n知识边界:\n${knowledge || '（无）'}\n人物经历:\n${
    experiences || '（无新增）'
  }\n剧情:\n${plots || '（无新增）'}`;
}

function primaryAnchorBlock(s: ContinuationContextSnapshot): string {
  const anchor = s.primaryAnchor;
  if (!anchor) {
    // Schema 1 compatibility: historical runs only have bundles.seam.
    return `【原著接缝】${s.bundles.seam.summary}\n${s.bundles.seam.excerpt}`;
  }
  if (anchor.kind === 'continuation_chapter') {
    return `【当前正文接缝：最近续写第 ${displayNumberFor(
      s,
      anchor.position ?? 0,
    )} 章】${anchor.summary}\n${anchor.excerpt}`;
  }
  return `【当前正文接缝：原著边界】${anchor.summary}\n${anchor.excerpt}`;
}

function primaryAnchorRule(s: ContinuationContextSnapshot): string {
  if (s.primaryAnchor?.kind === 'continuation_chapter') {
    return '存在“当前正文接缝：最近续写”时，必须从该续写章结尾继续推进。原著内容仅用于 Canon/背景核验；不得从原著末章重新起笔、复述或连续复制原著正文。';
  }
  return '仅在没有任何前序续写正文时，从当前正文接缝继续；不得复制原著原句。';
}

function recentBlock(s: ContinuationContextSnapshot): string {
  if (!s.bundles.recentChapters.length) return '【最近续写正文】（无）';
  return (
    '【最近续写正文】\n' +
    s.bundles.recentChapters
      .map(
        c =>
          `--- 第 ${displayNumberFor(
            s,
            c.position,
          )} 章 (hash=${c.revisionHash.slice(0, 8)}) ---\n${c.excerpt}`,
      )
      .join('\n')
  );
}

function memoryBlock(s: ContinuationContextSnapshot): string {
  const memory = s.bundles.storyMemory;
  return `【Story Memory 长期状态 status=${s.storyMemory.status} eligibility=${
    memory.eligibilityReason ?? 'legacy'
  }】\n${memory.summary || '（当前无可安全注入的长期记忆）'}`;
}

function episodicBlock(s: ContinuationContextSnapshot): string {
  const text = (s.bundles.episodic ?? [])
    .map(item => item.summary)
    .filter(Boolean)
    .join('\n');
  return text
    ? `【相关续写章节事件记忆】\n${text}`
    : '【相关续写章节事件记忆】（无）';
}

function historicalDigestBlock(s: ContinuationContextSnapshot): string {
  const cards = (s.bundles.historicalDigests ?? [])
    .map(
      digest =>
        `- position ${digest.startPosition}-${digest.endPosition - 1}: ${
          digest.summary
        }`,
    )
    .join('\n');
  return cards
    ? `【历史概览（非 Canon、非逐字核验事实）】\n${cards}\n仅作为可能相关线索；与 Canon 冲突时以 Canon 为准，需核实请回溯原文。`
    : '【历史概览（非 Canon）】（无匹配卡片）';
}

/**
 * Stage-aware style injection from the frozen snapshot profile (Spec §8).
 * Falls back to legacy thin metrics when only bundles.style is present.
 */
function styleBlock(
  s: ContinuationContextSnapshot,
  stage: 'planner' | 'writer' | 'checker' | 'repair',
  options?: {
    plan?: ContinuationPlan;
    openChecks?: ContinuationCheckResult[];
  },
): string {
  const frozen = s.style;
  if (frozen?.frozenProfile) {
    const level: StyleRenderLevel =
      frozen.renderLevel === 'compact' ||
      frozen.renderLevel === 'standard' ||
      frozen.renderLevel === 'detailed'
        ? frozen.renderLevel
        : 'standard';

    const violatedDimensions =
      stage === 'repair' && options?.openChecks
        ? options.openChecks
            .filter(
              c =>
                c.category === 'style' &&
                (c.severity === 'error' ||
                  c.severity === 'blocking' ||
                  c.severity === 'warning'),
            )
            .map(c => c.subtype)
        : undefined;

    const participating =
      stage === 'writer' && options?.plan
        ? options.plan.participatingCharacterIds
        : undefined;

    const planSceneHints =
      stage === 'writer' && options?.plan
        ? [
            options.plan.chapterGoal,
            options.plan.centralConflict,
            ...options.plan.beats.map(b => b.summary),
          ].filter(Boolean)
        : undefined;

    const rendered = renderStyleProfile(frozen.frozenProfile, level, {
      stage,
      participatingCharacterIds: participating,
      violatedDimensions,
      userOverrides: frozen.userOverrides,
      planSceneHints,
    });
    return rendered.text;
  }

  // Legacy thin metrics (pre-V2 snapshots)
  const st = s.bundles.style;
  if (!st) {
    return frozen?.omitReason
      ? `【文风】（未注入：${frozen.omitReason}）`
      : '【文风】（缺少可用原著画风画像）';
  }
  return `【文风特征】人称=${st.narrativePerson} 时态=${st.tense} 均句长=${st.averageSentenceLength} 对话比=${st.dialogueRatio}\n${st.pacingNotes}\n${st.lexicalNotes}`;
}

function supplementsBlock(s: ContinuationContextSnapshot): string {
  const supplements = s.bundles.supplements;
  if (!supplements) return '【原著之外的外部补充资料】（无）';
  const parts = [
    supplements.presetText,
    supplements.characterText,
    supplements.worldbookText,
    supplements.noteText,
  ].filter(Boolean);
  return parts.length
    ? `【原著之外的外部补充资料】\n以下仅补充创作；与 Canon、已确认续写状态或锁定规则冲突时，以上述内容为准。\n${parts.join(
        '\n\n',
      )}`
    : '【原著之外的外部补充资料】（无）';
}

function compileWriterMessages(
  snapshot: ContinuationContextSnapshot,
  plan?: ContinuationPlan,
): ChatMessage[] {
  const standardWorkflow = !plan;
  const lengthContract = resolveContinuationLengthContract(
    snapshot.settingsSnapshot.values.targetChapterChars,
  );
  const lengthRule = [
    `【正文长度硬约束】目标 ${lengthContract.targetHanCharacters} 个汉字；允许范围 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字。`,
    '汉字数按当前实现统计支持的范围：CJK Unified Ideographs、Extension A、Compatibility Ideographs、U+20000–U+2FA1F 补充范围和 〇；不包含标点、空格、换行、数字、拉丁字母、假名和韩文，也不宣称覆盖全部 Unicode Han。少于下限或多于上限均视为未完成。',
    '不得通过摘要、提纲、剧情概述、重复句或无意义水文控制长度；必须保留完整场景、人物互动、因果推进和自然章末。',
  ].join('\n');
  const system = [
    standardWorkflow
      ? '你是长篇小说续写写手。只输出一个 JSON object，不要 Markdown、代码围栏、解释文字或推理内容。'
      : '你是长篇小说续写写手。只输出本章正文，不要分析说明、不要标题行。',
    ...(standardWorkflow
      ? [
          'JSON 顶层必须严格为 {"schemaVersion":1,"plan":{...},"content":"..."}。plan 必须包含 chapterGoal、centralConflict、beats、participatingCharacterIds；characterActions、plotAdvances、foreshadowingActions、proposedStateChanges、risks 若无内容可输出空数组或省略，content 只包含本章正文，不含标题、JSON 包装或解释。',
          '先在同一次 completion 的 plan 中收束章节目标、核心冲突、节拍和参与人物，再按该 plan 写 content；不得先独立调用规划，也不得把 plan 写入 content。',
        ]
      : []),
    lengthRule,
    '遵守人物知识边界；不复制大段原著原文；不引入被策略禁止的死亡/复活/新体系。',
    primaryAnchorRule(snapshot),
    '模仿抽象文风特征，禁止复制原著原句。用户本章明确要求优先于自动风格画像。',
    lockedBlock(snapshot),
    canonFactCheckBlock(snapshot),
    ...(plan
      ? [
          `【规划（已确认版本）】\n目标：${plan.chapterGoal}\n冲突：${
            plan.centralConflict
          }\n节拍：${plan.beats.map(b => b.summary).join(' / ')}`,
        ]
      : []),
    stateBlock(snapshot),
    primaryAnchorBlock(snapshot),
    recentBlock(snapshot),
    memoryBlock(snapshot),
    episodicBlock(snapshot),
    historicalDigestBlock(snapshot),
    styleBlock(snapshot, 'writer', plan ? { plan } : undefined),
    supplementsBlock(snapshot),
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `生成${displayTargetTitle(snapshot)}。正文目标 ${
        lengthContract.targetHanCharacters
      } 个汉字，必须保持在 ${lengthContract.minHanCharacters}–${
        lengthContract.maxHanCharacters
      } 个汉字。用户要求：\n${snapshot.bundles.userInstruction}`,
    },
  ];
}

function compileCheckerMessages(
  snapshot: ContinuationContextSnapshot,
  artifactText: string,
): ChatMessage[] {
  const system = [
    '你是续写一致性检查器。先逐段核对正文，再只输出 JSON 对象 {"issues":[]}；禁止 Markdown、解释、思维过程和正文复述。每项含 category, subtype, severity, confidence, generatedStart, generatedEnd, generatedExcerpt, description, evidenceIds, suggestedFix。',
    'category ∈ world|character|relationship|plot|experience|knowledge|timeline|style；severity ∈ info|warning|error|blocking。',
    '没有 Canon 证据且不属于本地硬门禁时只能 warning，并说明是推测；主观文风偏好不得使用 error/blocking。位置使用 UTF-16 半开区间，generatedExcerpt 必须是正文中的原文片段。',
    '若原著事实与正文冲突，只有明确违反 hard/locked 规则、冻结状态/知识边界，或有可追溯 Canon 证据的事实冲突，才使用 error/blocking；能对应行内证据编号时必须写入 evidenceIds。不得把缺少资料当作原著不存在。error/blocking 必须同时给出可定位的正文片段、具体事实、证据 id 和可执行 suggestedFix；任一项无法提供就降为 warning。',
    '目标字数、接缝连续重合和 future leakage 由本地确定性复核负责；不要把目标长度当作 error/blocking，也不要用模糊的重复问题制造第二个严重问题。若本地硬门禁已经能识别接缝重合或 future leakage，不得重复报告同一问题；把 LLM 检查预算用于 Canon、状态和人物关系的语义冲突。',
    '按根因合并重复问题：同一事实冲突只输出一项，最多补充必要的关联问题。先区分“正文明确写错”与“正文没有交代”，后者不能判错。',
    '若正文只是合理推进、补写未确定细节或与 Canon 没有明确冲突，返回 {"issues":[]} 或 warning，不要要求用户人工确认。',
    lockedBlock(snapshot),
    canonFactCheckBlock(snapshot),
    stateBlock(snapshot),
    styleBlock(snapshot, 'checker'),
    `【可引用证据 id】${JSON.stringify(snapshot.bundles.canon.evidenceRefs)}`,
    supplementsBlock(snapshot),
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `检查以下正文：\n---\n${artifactText}\n---`,
    },
  ];
}

function compileRepairMessages(
  snapshot: ContinuationContextSnapshot,
  artifactText: string,
  openChecks: ContinuationCheckResult[],
  delivery: 'full' | 'patch' = 'full',
): ChatMessage[] {
  const patchDelivery = delivery === 'patch';
  const lengthContract = resolveContinuationLengthContract(
    snapshot.settingsSnapshot.values.targetChapterChars,
  );
  const originalHanCharacters = countHanCharacters(artifactText);
  const issues = openChecks
    .filter(c => c.severity === 'error' || c.severity === 'blocking')
    .map(c => {
      const chapterLevel = isContinuationLengthIssueSubtype(c.subtype);
      const location = chapterLevel
        ? '章节级长度问题（无局部 offset）'
        : `@${c.generatedStart}-${c.generatedEnd} 命中片段:${
            c.generatedExcerpt || '（无定位片段）'
          }`;
      return `- [${c.severity}/${c.category}/${c.subtype}] ${
        c.description
      } ${location} 建议:${c.suggestedFix ?? ''}`;
    })
    .join('\n');
  const anchorExcerpt =
    snapshot.primaryAnchor?.excerpt || snapshot.bundles.seam?.excerpt || '';
  const repairLengthContract = [
    `【Repair 长度硬性验收】当前完整正文含 ${originalHanCharacters} 个汉字；本次目标 ${lengthContract.targetHanCharacters} 个汉字，应用全部补丁后的完整正文必须保持在 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字。`,
    '汉字数按当前实现统计支持的范围：CJK Unified Ideographs、Extension A、Compatibility Ideographs、U+20000–U+2FA1F 补充范围和 〇；不包含标点、空格、换行、数字、拉丁字母、假名和韩文，也不宣称覆盖全部 Unicode Han。长度不足时应补充具体动作、对话、因果、人物反应、冲突推进或结果余波；长度超出时优先压缩重复描写、重复心理和不推进剧情的对话。',
    '不得用摘要、提纲、概括句、重复同一句、无意义水文或大段删除来规避长度要求；必须保留完整事件链、人物互动和自然收束。',
  ].join('\n');
  const overlapInstructions = openChecks.some(
    c =>
      c.subtype === 'source_overlap' ||
      c.subtype === 'continuation_anchor_overlap',
  )
    ? [
        patchDelivery
          ? '本次标准 Repair 的输出是应用到最终候选正文的 JSON 补丁，不是修改建议、解释、审查报告或完整正文。'
          : '本次修复的输出就是最终候选正文，不是修改建议、解释、审查报告、JSON 或局部补丁。',
        '接缝重合是硬错误：必须重写命中段落的叙事动作、信息组织和措辞，让正文从接缝之后的新事件继续推进；不能只删标点、替换几个词、压缩句子或把同一段原文换位置。',
        '修复后正文不得再次复制接缝或命中片段中的连续原文，也不得用“刚才/此前发生的事情”重新复述同一段；若无法保留原句，优先保证章节目标、冲突和节拍继续成立。',
        anchorExcerpt
          ? `【仅用于消除接缝重合的参考接缝】\n${anchorExcerpt}`
          : '【接缝参考】（快照未提供可展示片段，仍须依据检查命中片段改写）',
      ].join('\n')
    : patchDelivery
    ? '本次标准 Repair 的输出是应用到最终候选正文的 JSON 补丁；不要输出问题清单、解释或完整正文。'
    : '本次修复的输出就是最终候选正文，只输出修复后的完整正文；不要输出问题清单、解释、JSON 或局部补丁。';
  const system = [
    patchDelivery
      ? '你是续写终稿修复助手。先在内部逐项执行修复清单，然后只输出严格 JSON 修订补丁。不得输出思维过程、审查说明、Markdown 标题或“已修复”等套话。'
      : '你是续写终稿修复助手。先在内部逐项执行修复清单，再只输出修复后的完整正文。不得输出思维过程、审查说明、JSON、Markdown 标题或“已修复”等套话。',
    overlapInstructions,
    '对每一项 error/blocking 都必须完成可验证的修改；输出前重新检查：硬规则/Canon 证据、冻结状态与知识边界、人物关系、章节目标与冲突、接缝不重复。不要因单一风格问题重写无关段落，也不要修改已通过的 Canon 事实。',
    patchDelivery
      ? `你返回的是应用到完整原文的局部补丁。普通问题必须由覆盖其 @start-@end 区间的补丁实质修正；章节级长度问题没有局部 offset，可以在自然段边界使用 start=end 的纯插入补丁，或用较大区间的精简替换补丁。客户端会保留所有未命中的有效正文。`
      : '原文不是参考摘要，而是必须覆盖的完整修订底稿。先保留原文每个有效段落、事件节点、人物互动、情绪转折和结尾收束，再逐项完成 Checker 指出的实质修正；Repair 不是原文复述、机械删句、只改命中句或只返回局部补丁。',
    ...(patchDelivery
      ? [
          '定向修订原则：事实与 Canon 优先；不引入未被原文或 Canon 支持的新人物、新地点、新物品、新能力或规则；不得擅自改变章节目标；不得删除不存在问题的重要情节；尽量最小必要修改，并保留原文创意与叙事风格。',
        ]
      : [
          `除非 Checker 明确要求删除，修正后必须在原有完整事件链、人物互动、细节和收束的基础上输出完整终稿；不得把整章压缩成摘要、提纲、几百字短候选或“修改建议”。`,
        ]),
    repairLengthContract,
    lockedBlock(snapshot),
    canonFactCheckBlock(snapshot),
    stateBlock(snapshot),
    styleBlock(snapshot, 'repair', { openChecks }),
    `【待修复问题】\n${issues || '（无 blocking/error）'}`,
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: patchDelivery
        ? [
            '【Repair 补丁交付契约：优先级最高】',
            '只输出严格 JSON：{"patches":[{"start":0,"end":12,"replacement":"替换后的连续正文"}]}。start/end 必须是下方原文的 UTF-16 半开位置，start 包含、end 不包含；允许 start=end 表示纯插入。patches 按 start 升序、不得重叠，也不得在同一位置重复插入。replacement 必须是可直接应用的自然小说正文，不能为空。',
            '普通 error/blocking 必须由覆盖其 @start-@end 的补丁实质修正；章节级长度问题不要求覆盖局部区间。扩写时优先在自然段边界插入完整段落，压缩时用更短但叙事完整的段落替换冗余区间。',
            `应用补丁后的完整正文必须包含 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字，并尽量接近 ${lengthContract.targetHanCharacters}。不要返回完整章节、摘要、问题说明、Markdown 或 JSON 之外的文字。`,
            '【完整原文开始】',
            artifactText,
            '【完整原文结束】',
            '现在只输出 JSON 补丁对象。',
          ].join('\n\n')
        : [
            '【最终交付契约：优先级最高】',
            '交付物必须是可直接替换下方原文的完整修订章节，不是修改说明、摘要、提纲、局部重写或只包含命中段落的补丁。输出从修订后章节第一句开始，到自然章末结束；不得加入前言、计数、标签或解释。',
            `最终正文必须包含 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字，并尽量接近 ${lengthContract.targetHanCharacters}。`,
            '先在内部以原文的每个有效段落、事件节点、人物互动、因果、情绪转折和结尾为覆盖清单；修正问题时改写对应段落，但不得遗漏其余有效内容。',
            '【完整原文开始】',
            artifactText,
            '【完整原文结束】',
            '现在仅输出完整修订章节。',
          ].join('\n\n'),
    },
  ];
}

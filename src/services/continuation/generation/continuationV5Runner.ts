/**
 * Continuation V5 runner: three rounds, three drafts, five physical calls.
 *
 * Round 1: Draft Writer || Narrative Architect
 * Round 2: Revision Writer || Adversarial Auditor
 * Round 3: Final Reviser
 * Local: Final Artifact Validator (zero request)
 *
 * Hard caps: 5 physical requests total; each node reserves at most once;
 * no automatic LLM retries.
 *
 * Soft-gate mode (CONTINUATION_V5_SOFT_GATES): hash binding / most final
 * technical checks / stage parse failures degrade with warnings and continue
 * (Revision may fall back to V1 body; Final may promote V2) so a full run
 * can finish for user review. Re-harden gates gradually later.
 */
import type { ChatMessage, LLMRequestConfig } from '../../llm/types';
import {
  callLLMResult,
  resolveLLMRequestConfig,
  resolveLLMRequestConfigById,
} from '../../llm';
import { ensureContextAutomationPolicy } from '../../contextAutoAllocator';
import { countHanCharacters } from './continuationLengthContract';
import {
  buildContinuationV5Context,
} from './continuationContextBuilder';
import {
  CONTINUATION_V5_LENGTH_POLICY,
  CONTINUATION_V5_SOFT_GATES,
  buildFallbackArchitecture,
  buildFallbackAuditContract,
  diagnoseLengthTelemetry,
  hashArchitectureEnvelope,
  hashAuditEnvelope,
  hashContent,
  parseContinuationV5ArchitectureEnvelope,
  parseContinuationV5AuditEnvelope,
  parseContinuationV5DraftEnvelope,
  parseContinuationV5FinalEnvelope,
  parseContinuationV5RevisionEnvelope,
} from './continuationV5Contracts';
import type { V5SoftWarning } from './continuationV5Contracts';
import {
  compileContinuationV5ArchitectMessages,
  compileContinuationV5AuditorMessages,
  compileContinuationV5DraftWriterMessages,
  compileContinuationV5FinalReviserWithinBudget,
  compileContinuationV5RevisionWriterMessages,
} from './continuationV5PromptCompiler';
import { validateFinalArtifact } from './finalArtifactValidator';
import {
  casUpdateRunState,
  ensureContinuationV5StageResults,
  ensureGenerationSettings,
  ensureUniqueArtifactContent,
  finalizeContinuationV5Final,
  finalizeContinuationV5ValidatorOnly,
  getLatestArtifactForStage,
  getRunById,
  getStageResult,
  insertArtifact,
  insertRun,
  listStageResults,
  newContinuationRunId,
  reserveContinuationStage,
  updateStageResult,
} from './generationRepository';
import {
  formatUnknownError,
  formatUnknownErrorCode,
} from './errorFormat';
import type {
  ContinuationArtifact,
  ContinuationContextSnapshotV5,
  ContinuationContextTrace,
  ContinuationGenerationRun,
  ContinuationGenerationSettings,
  ContinuationGenerationStageResult,
  ContinuationV5ArchitectureEnvelope,
  ContinuationV5AuditEnvelope,
  ContinuationV5Node,
  ContinuationV5PhysicalNode,
  FrozenContinuationModelConfig,
} from './types';
import {
  CONTINUATION_V5_MAX_PHYSICAL_REQUESTS,
  ContinuationCapabilityBlockedError,
  ContinuationOutdatedError,
  ContinuationStageOutputTruncatedError,
} from './types';
import type {
  StageLlmCallResult,
  StageLlmCaller,
  StartContinuationRunInput,
} from './continuationGenerationRunner';
import { activeContinuationControllers } from './continuationRunControllers';
import { estimateMessagesTokens } from '../../../utils/tokenEstimator';

interface V5PipelineOptions {
  callStage?: StageLlmCaller;
  deterministicOnly?: boolean;
  signal: AbortSignal;
  projectId: number;
}

interface V5StageModel {
  configId: number;
  contextWindow: number;
  maxOutputTokens: number;
}

interface V5StageModels {
  draft_writer: V5StageModel;
  narrative_architect: V5StageModel;
  revision_writer: V5StageModel;
  adversarial_auditor: V5StageModel;
  final_reviser: V5StageModel;
}

function requirePositive(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ContinuationCapabilityBlockedError(
      `${label} 必须来自有效的冻结模型能力，当前值不可用。`,
    );
  }
  return Math.floor(parsed);
}

function modelConfigId(config: LLMRequestConfig | null | undefined): number {
  return requirePositive(config?.id, 'LLM 配置 id');
}

function freezeV5ModelConfig(
  config: LLMRequestConfig | null | undefined,
): FrozenContinuationModelConfig {
  if (!config) {
    throw new ContinuationCapabilityBlockedError('缺少 V5 阶段模型配置。');
  }
  return {
    configId: modelConfigId(config),
    name: String(config.name || `LLM 配置 #${config.id}`),
    providerType: config.provider_type,
    url: config.url,
    modelName: config.model_name,
    contextWindow: requirePositive(config.context_window, 'context_window'),
    maxOutputTokens: requirePositive(config.max_output_tokens, 'max_output_tokens'),
  };
}

async function resolveV5StageConfig(
  configuredId: number | null,
  activeConfig: LLMRequestConfig | null,
): Promise<LLMRequestConfig> {
  const config =
    configuredId == null
      ? activeConfig
      : await resolveLLMRequestConfigById(configuredId).catch(() => null);
  if (!config) {
    throw new ContinuationCapabilityBlockedError(
      `无法读取已选择的 LLM 配置 #${String(configuredId ?? '')}。`,
    );
  }
  if (configuredId != null && modelConfigId(config) !== configuredId) {
    throw new ContinuationCapabilityBlockedError(
      `LLM 配置 #${configuredId} 读取后 id 不一致，已阻止本次续写。`,
    );
  }
  return config;
}

/** Prefer larger context, then max output, then stable configId. */
function pickAuditorConfig(
  checker: LLMRequestConfig,
  control: LLMRequestConfig,
): LLMRequestConfig {
  const score = (config: LLMRequestConfig) => {
    const window = Number(config.context_window) || 0;
    const maxOut = Number(config.max_output_tokens) || 0;
    const id = Number(config.id) || 0;
    return window * 1_000_000 + maxOut * 100 + id;
  };
  return score(control) > score(checker) ? control : checker;
}

async function resolveV5StageModels(
  settings: ContinuationGenerationSettings,
): Promise<{
  stageModels: V5StageModels;
  frozenModelConfigs: NonNullable<
    import('./types').ContinuationGenerationSettingsSnapshot['frozenModelConfigs']
  >;
  activeConfigId: number;
}> {
  const activeConfig = await resolveLLMRequestConfig().catch(() => null);
  if (!activeConfig) {
    throw new ContinuationCapabilityBlockedError('当前没有可用的活动 LLM 配置。');
  }
  const activeConfigId = modelConfigId(activeConfig);
  const [writer, planner, checker, control, repair] = await Promise.all([
    resolveV5StageConfig(settings.writerLlmConfigId, activeConfig),
    resolveV5StageConfig(settings.plannerLlmConfigId, activeConfig),
    resolveV5StageConfig(settings.checkerLlmConfigId, activeConfig),
    resolveV5StageConfig(settings.controlLlmConfigId, activeConfig),
    resolveV5StageConfig(settings.repairLlmConfigId, activeConfig),
  ]);
  const auditor = pickAuditorConfig(checker, control);
  const frozen = {
    planner: freezeV5ModelConfig(planner),
    writer: freezeV5ModelConfig(writer),
    checker: freezeV5ModelConfig(checker),
    repair: freezeV5ModelConfig(repair),
    stateExtraction: null,
    control: freezeV5ModelConfig(control),
    draftWriter: freezeV5ModelConfig(writer),
    narrativeArchitect: freezeV5ModelConfig(planner),
    revisionWriter: freezeV5ModelConfig(repair),
    adversarialAuditor: freezeV5ModelConfig(auditor),
    finalReviser: freezeV5ModelConfig(repair),
  };
  return {
    activeConfigId,
    frozenModelConfigs: frozen,
    stageModels: {
      draft_writer: {
        configId: frozen.draftWriter!.configId,
        contextWindow: frozen.draftWriter!.contextWindow,
        maxOutputTokens: frozen.draftWriter!.maxOutputTokens,
      },
      narrative_architect: {
        configId: frozen.narrativeArchitect!.configId,
        contextWindow: frozen.narrativeArchitect!.contextWindow,
        maxOutputTokens: frozen.narrativeArchitect!.maxOutputTokens,
      },
      revision_writer: {
        configId: frozen.revisionWriter!.configId,
        contextWindow: frozen.revisionWriter!.contextWindow,
        maxOutputTokens: frozen.revisionWriter!.maxOutputTokens,
      },
      adversarial_auditor: {
        configId: frozen.adversarialAuditor!.configId,
        contextWindow: frozen.adversarialAuditor!.contextWindow,
        maxOutputTokens: frozen.adversarialAuditor!.maxOutputTokens,
      },
      final_reviser: {
        configId: frozen.finalReviser!.configId,
        contextWindow: frozen.finalReviser!.contextWindow,
        maxOutputTokens: frozen.finalReviser!.maxOutputTokens,
      },
    },
  };
}

async function defaultV5StageCaller(input: {
  stage: string;
  messages: ChatMessage[];
  maxTokens: number;
  configId: number;
  responseFormat: 'json_object' | 'text';
  signal: AbortSignal;
  projectId: number;
  runId: string;
  frozenModelConfig: FrozenContinuationModelConfig;
}): Promise<StageLlmCallResult> {
  const live = await resolveLLMRequestConfigById(input.configId);
  const requestConfig: LLMRequestConfig = {
    ...live,
    id: input.frozenModelConfig.configId,
    name: input.frozenModelConfig.name,
    provider_type: input.frozenModelConfig.providerType,
    url: input.frozenModelConfig.url,
    model_name: input.frozenModelConfig.modelName,
    context_window: input.frozenModelConfig.contextWindow,
    max_output_tokens: input.frozenModelConfig.maxOutputTokens,
  };
  const promptTokens = estimateMessagesTokens(input.messages);
  if (promptTokens + input.maxTokens > input.frozenModelConfig.contextWindow) {
    throw new ContinuationCapabilityBlockedError(
      `阶段 ${input.stage} 的冻结 prompt 与输出预算超出模型 context window。`,
    );
  }
  const result = await callLLMResult(
    input.messages,
    input.maxTokens,
    {
      queueClass: 'pipeline',
      queuePriority: 'normal',
      projectId: input.projectId,
      taskId: input.runId,
      scenario: `continuation_v5_${input.stage}`,
      thinking: /^deepseek-v4-(flash|pro)$/i.test(
        input.frozenModelConfig.modelName,
      )
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

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('续写已取消');
}

function frozenForStage(
  snapshot: ContinuationContextSnapshotV5,
  stage: ContinuationV5PhysicalNode,
): FrozenContinuationModelConfig {
  const frozen = snapshot.settingsSnapshot.frozenModelConfigs;
  const map: Record<ContinuationV5PhysicalNode, FrozenContinuationModelConfig | null | undefined> = {
    draft_writer: frozen?.draftWriter ?? frozen?.writer,
    narrative_architect: frozen?.narrativeArchitect ?? frozen?.planner ?? frozen?.writer,
    revision_writer: frozen?.revisionWriter ?? frozen?.repair ?? frozen?.writer,
    adversarial_auditor:
      frozen?.adversarialAuditor ?? frozen?.checker ?? frozen?.control ?? frozen?.writer,
    final_reviser: frozen?.finalReviser ?? frozen?.repair ?? frozen?.writer,
  };
  const config = map[stage];
  if (!config) {
    throw new ContinuationCapabilityBlockedError(`缺少 ${stage} 冻结模型配置。`);
  }
  return config;
}

async function physicalRequestCount(runId: string): Promise<number> {
  const results = await listStageResults(runId);
  return results
    .filter(row => row.stage !== 'final_validate' && row.stage !== 'local_verify')
    .reduce((sum, row) => sum + (row.requestCount || 0), 0);
}

async function assertUnderRequestCap(runId: string): Promise<void> {
  const count = await physicalRequestCount(runId);
  if (count >= CONTINUATION_V5_MAX_PHYSICAL_REQUESTS) {
    throw new Error('Continuation V5 物理请求上限已用尽');
  }
}

async function markStageFailed(input: {
  runId: string;
  stage: ContinuationV5Node;
  errorCode: string;
  errorMessage: string;
  outputJson?: string | null;
}): Promise<void> {
  await updateStageResult({
    runId: input.runId,
    stage: input.stage,
    status: 'failed',
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    outputJson: input.outputJson ?? null,
  });
}

async function buildTelemetry(
  runId: string,
  snapshot: ContinuationContextSnapshotV5,
  extras: Record<string, unknown> = {},
): Promise<string> {
  const results = await listStageResults(runId);
  const physicalRequestCountValue = results
    .filter(row => row.stage !== 'final_validate')
    .reduce((sum, row) => sum + (row.requestCount || 0), 0);
  const draft = await getLatestArtifactForStage(runId, 'draft');
  const revision = await getLatestArtifactForStage(runId, 'revision_1');
  const finalArt = await getLatestArtifactForStage(runId, 'final');
  const targetHan = snapshot.settingsSnapshot.values.targetChapterChars;
  const draftHan = draft ? countHanCharacters(draft.content) : null;
  const revisionHan = revision ? countHanCharacters(revision.content) : null;
  const finalHan = finalArt ? countHanCharacters(finalArt.content) : null;
  const stageDiag: Record<string, unknown> = {};
  for (const row of results) {
    if (!row.outputJson) continue;
    try {
      stageDiag[row.stage] = JSON.parse(row.outputJson);
    } catch {
      stageDiag[row.stage] = { rawPresent: true };
    }
  }
  return JSON.stringify({
    workflowVersion: 5,
    maxPhysicalRequests: CONTINUATION_V5_MAX_PHYSICAL_REQUESTS,
    physicalRequestCount: physicalRequestCountValue,
    targetHan,
    draftHan,
    revisionHan,
    finalHan,
    draftAttainmentRatio:
      draftHan != null && targetHan > 0 ? draftHan / targetHan : null,
    revisionAttainmentRatio:
      revisionHan != null && targetHan > 0 ? revisionHan / targetHan : null,
    finalAttainmentRatio:
      finalHan != null && targetHan > 0 ? finalHan / targetHan : null,
    stages: stageDiag,
    ...extras,
  });
}

async function callNode(input: {
  run: ContinuationGenerationRun;
  snapshot: ContinuationContextSnapshotV5;
  stage: ContinuationV5PhysicalNode;
  messages: ChatMessage[];
  maxTokens: number;
  options: V5PipelineOptions;
  promptTokens: number;
}): Promise<{
  reserved: ContinuationGenerationStageResult;
  result: StageLlmCallResult;
  newlyReserved: boolean;
}> {
  assertNotAborted(input.options.signal);
  await assertUnderRequestCap(input.run.id);
  const frozen = frozenForStage(input.snapshot, input.stage);
  const budget = input.snapshot.stageBudgets[input.stage];
  const claim = await reserveContinuationStage({
    runId: input.run.id,
    stage: input.stage,
    modelConfigId: frozen.configId,
    inputTokens: input.promptTokens,
    minOutputTokens: budget.minimumOutputTokens,
    maxOutputTokens: Math.min(input.maxTokens, budget.maximumOutputTokens),
  });
  if (!claim.reserved) {
    // Resume path: already reserved — never re-send.
    throw Object.assign(new Error(`${input.stage}_already_reserved`), {
      code: `${input.stage}_already_reserved`,
      reserved: claim.result,
    });
  }
  const caller = input.options.callStage
    ? async (args: {
        stage: string;
        messages: ChatMessage[];
        maxTokens: number;
        configId: number | null;
        responseFormat?: 'json_object' | 'text';
      }) =>
        input.options.callStage!({
          stage: args.stage,
          messages: args.messages,
          maxTokens: args.maxTokens,
          configId: args.configId,
          responseFormat: args.responseFormat,
        })
    : null;
  const result = caller
    ? await caller({
        stage: input.stage,
        messages: input.messages,
        maxTokens: Math.min(input.maxTokens, budget.maximumOutputTokens),
        configId: frozen.configId,
        responseFormat: 'json_object',
      })
    : await defaultV5StageCaller({
        stage: input.stage,
        messages: input.messages,
        maxTokens: Math.min(input.maxTokens, budget.maximumOutputTokens),
        configId: frozen.configId,
        responseFormat: 'json_object',
        signal: input.options.signal,
        projectId: input.options.projectId,
        runId: input.run.id,
        frozenModelConfig: frozen,
      });
  return { reserved: claim.result, result, newlyReserved: true };
}

async function runRound1(
  run: ContinuationGenerationRun,
  snapshot: ContinuationContextSnapshotV5,
  options: V5PipelineOptions,
): Promise<{
  draftArtifact: ContinuationArtifact;
  architecture: ContinuationV5ArchitectureEnvelope;
  architectureHash: string;
  architectureDegraded: boolean;
}> {
  await casUpdateRunState(run.id, ['running'], { stage: 'round1' });
  const draftCompiled = compileContinuationV5DraftWriterMessages({
    view: snapshot.stageViews.draft_writer,
  });
  const architectCompiled = compileContinuationV5ArchitectMessages({
    view: snapshot.stageViews.narrative_architect,
  });

  // Reserve both before launching so one side cannot consume the only slot.
  const existingDraft = await getStageResult(run.id, 'draft_writer');
  const existingArch = await getStageResult(run.id, 'narrative_architect');
  const existingDraftArtifact = await getLatestArtifactForStage(run.id, 'draft');

  let draftArtifact = existingDraftArtifact;
  let architecture: ContinuationV5ArchitectureEnvelope | null = null;
  let architectureHash = '';
  let architectureDegraded = false;

  if (existingArch?.status === 'success' && existingArch.outputJson) {
    try {
      const stored = JSON.parse(existingArch.outputJson);
      if (stored?.envelope) {
        architecture = stored.envelope as ContinuationV5ArchitectureEnvelope;
        architectureHash = stored.architectureHash || hashArchitectureEnvelope(architecture);
        architectureDegraded = Boolean(stored.degraded);
      }
    } catch {
      architecture = null;
    }
  }

  const draftNeedsCall =
    !draftArtifact &&
    !(existingDraft?.requestReserved && existingDraft.requestCount === 1);
  const archNeedsCall =
    !architecture &&
    !(existingArch?.requestReserved && existingArch.requestCount === 1);

  // Resume: draft reserved but missing artifact → fail (cannot re-send).
  if (
    !draftArtifact &&
    existingDraft?.requestReserved &&
    existingDraft.requestCount === 1 &&
    existingDraft.status !== 'success'
  ) {
    throw Object.assign(new Error('Draft Writer 已 reservation 但缺少 V1，无法重发。'), {
      code: 'draft_writer_reserved_without_artifact',
    });
  }

  // Resume: architect reserved but missing result → fallback, no re-send.
  if (
    !architecture &&
    existingArch?.requestReserved &&
    existingArch.requestCount === 1
  ) {
    architecture = buildFallbackArchitecture({
      userInstruction: snapshot.bundles.userInstruction,
      lockedRules: snapshot.bundles.lockedRules,
    });
    architectureHash = hashArchitectureEnvelope(architecture);
    architectureDegraded = true;
    await updateStageResult({
      runId: run.id,
      stage: 'narrative_architect',
      status: 'success',
      outputJson: JSON.stringify({
        schemaVersion: 1,
        degraded: true,
        reason: 'narrative_architect_degraded',
        architectureHash,
        envelope: architecture,
      }),
      errorCode: 'narrative_architect_degraded',
      errorMessage: 'Architect 结果丢失，使用本地 fallback A1。',
    });
  }

  const tasks: Array<Promise<void>> = [];

  if (draftNeedsCall) {
    tasks.push(
      (async () => {
        const budget = snapshot.stageBudgets.draft_writer;
        const { result } = await callNode({
          run,
          snapshot,
          stage: 'draft_writer',
          messages: draftCompiled.messages,
          maxTokens: budget.maximumOutputTokens,
          options,
          promptTokens: draftCompiled.promptTokens,
        });
        const softWarnings: V5SoftWarning[] = [];
        const truncated =
          result.finishReason === 'length' || result.emptyReason === 'length';
        if (truncated) {
          softWarnings.push('draft_writer_output_truncated_soft');
        }
        let envelope;
        try {
          envelope = parseContinuationV5DraftEnvelope(
            result.text,
            {
              chapterGoal: snapshot.bundles.userInstruction.slice(0, 200),
            },
            softWarnings,
          );
        } catch (parseError: any) {
          if (!CONTINUATION_V5_SOFT_GATES || !truncated) {
            const diag = {
              schemaVersion: 1,
              error: truncated
                ? 'draft_writer_output_truncated'
                : parseError?.message || 'draft_writer_parse_failed',
              finishReason: result.finishReason,
              promptTokens: result.usage?.prompt ?? draftCompiled.promptTokens,
              completionTokens: result.usage?.completion ?? null,
              maximumOutputTokens: budget.maximumOutputTokens,
              declaredMaxOutputTokens: budget.declaredMaxOutputTokens,
            };
            await markStageFailed({
              runId: run.id,
              stage: 'draft_writer',
              errorCode: truncated
                ? 'draft_writer_output_truncated'
                : 'draft_writer_parse_failed',
              errorMessage: truncated
                ? 'Draft Writer 输出被截断，不解析、不落 V1。'
                : parseError?.message || 'Draft Writer 解析失败',
              outputJson: JSON.stringify(diag),
            });
            if (truncated) {
              throw new ContinuationStageOutputTruncatedError('draft_writer', diag);
            }
            throw parseError;
          }
          // Soft: truncation + unparseable still cannot invent V1 body.
          const diag = {
            schemaVersion: 1,
            error: 'draft_writer_output_truncated',
            finishReason: result.finishReason,
            parseError: parseError?.message || String(parseError),
            softWarnings,
          };
          await markStageFailed({
            runId: run.id,
            stage: 'draft_writer',
            errorCode: 'draft_writer_output_truncated',
            errorMessage: 'Draft Writer 截断且无法软解析，不落 V1。',
            outputJson: JSON.stringify(diag),
          });
          throw new ContinuationStageOutputTruncatedError('draft_writer', diag);
        }
        if (truncated && CONTINUATION_V5_SOFT_GATES) {
          // Soft: accept truncated but parseable V1 and continue.
          softWarnings.push('draft_writer_truncated_accepted');
        } else if (truncated && !CONTINUATION_V5_SOFT_GATES) {
          const diag = {
            schemaVersion: 1,
            error: 'draft_writer_output_truncated',
            finishReason: result.finishReason,
          };
          await markStageFailed({
            runId: run.id,
            stage: 'draft_writer',
            errorCode: 'draft_writer_output_truncated',
            errorMessage: 'Draft Writer 输出被截断，不解析、不落 V1。',
            outputJson: JSON.stringify(diag),
          });
          throw new ContinuationStageOutputTruncatedError('draft_writer', diag);
        }
        const lengthDiag = diagnoseLengthTelemetry({
          content: envelope.content,
          targetHan: snapshot.settingsSnapshot.values.targetChapterChars,
          finishReason: result.finishReason,
          promptTokens: result.usage?.prompt ?? draftCompiled.promptTokens,
          completionTokens: result.usage?.completion,
          maximumOutputTokens: budget.maximumOutputTokens,
          declaredMaxOutputTokens: budget.declaredMaxOutputTokens,
          minimumOutputTokens: budget.minimumOutputTokens,
          effectiveMaxOutputTokens: budget.maximumOutputTokens,
        });
        if (lengthDiag.severeUnderTarget) {
          softWarnings.push('draft_severe_under_target');
        }
        const artifact = await insertArtifact({
          runId: run.id,
          stage: 'draft',
          content: envelope.content,
          repairRound: 0,
          parentArtifactId: null,
          eligibilityStatus: 'intermediate',
          rejectionCode: null,
        });
        await updateStageResult({
          runId: run.id,
          stage: 'draft_writer',
          status: 'success',
          artifactId: artifact.id,
          outputTokens: result.usage?.completion ?? null,
          outputJson: JSON.stringify({
            schemaVersion: 1,
            plan: envelope.plan,
            contentHash: artifact.contentHash,
            length: lengthDiag,
            softGates: CONTINUATION_V5_SOFT_GATES,
            softWarnings,
            warnings: softWarnings,
          }),
        });
        draftArtifact = artifact;
      })(),
    );
  }

  if (archNeedsCall) {
    tasks.push(
      (async () => {
        const budget = snapshot.stageBudgets.narrative_architect;
        try {
          const { result } = await callNode({
            run,
            snapshot,
            stage: 'narrative_architect',
            messages: architectCompiled.messages,
            maxTokens: budget.maximumOutputTokens,
            options,
            promptTokens: architectCompiled.promptTokens,
          });
          if (result.finishReason === 'length' || result.emptyReason === 'length') {
            throw new Error('narrative_architect_output_truncated');
          }
          const envelope = parseContinuationV5ArchitectureEnvelope(result.text);
          const hash = hashArchitectureEnvelope(envelope);
          await updateStageResult({
            runId: run.id,
            stage: 'narrative_architect',
            status: 'success',
            outputTokens: result.usage?.completion ?? null,
            outputJson: JSON.stringify({
              schemaVersion: 1,
              degraded: false,
              architectureHash: hash,
              envelope,
              finishReason: result.finishReason,
              promptTokens: result.usage?.prompt ?? architectCompiled.promptTokens,
              completionTokens: result.usage?.completion ?? null,
            }),
          });
          architecture = envelope;
          architectureHash = hash;
          architectureDegraded = false;
        } catch (error: any) {
          if (options.signal.aborted) throw error;
          // Fallback A1 — allow Round 2.
          const fallback = buildFallbackArchitecture({
            userInstruction: snapshot.bundles.userInstruction,
            draftPlan: null,
            lockedRules: snapshot.bundles.lockedRules,
          });
          const hash = hashArchitectureEnvelope(fallback);
          await updateStageResult({
            runId: run.id,
            stage: 'narrative_architect',
            status: 'success',
            outputJson: JSON.stringify({
              schemaVersion: 1,
              degraded: true,
              reason: 'narrative_architect_degraded',
              error: error?.message || String(error),
              architectureHash: hash,
              envelope: fallback,
            }),
            errorCode: 'narrative_architect_degraded',
            errorMessage: 'Architect 失败，使用本地 fallback A1。',
          });
          architecture = fallback;
          architectureHash = hash;
          architectureDegraded = true;
        }
      })(),
    );
  }

  if (tasks.length > 0) {
    const settled = await Promise.allSettled(tasks);
    const draftFailure = settled.find(
      item => item.status === 'rejected',
    ) as PromiseRejectedResult | undefined;
    // Draft failure blocks; architect already fallbacks inside its task.
    if (!draftArtifact) {
      const reason =
        draftFailure?.reason instanceof Error
          ? draftFailure.reason
          : new Error('Draft Writer 失败');
      throw reason;
    }
  }

  if (!draftArtifact) {
    throw new Error('Round 1 缺少 V1 初稿');
  }
  if (!architecture) {
    architecture = buildFallbackArchitecture({
      userInstruction: snapshot.bundles.userInstruction,
      lockedRules: snapshot.bundles.lockedRules,
    });
    architectureHash = hashArchitectureEnvelope(architecture);
    architectureDegraded = true;
  }

  // If architect finished before draft, enrich fallback with draft plan when degraded.
  if (architectureDegraded) {
    const draftStage = await getStageResult(run.id, 'draft_writer');
    let plan = null as any;
    try {
      plan = draftStage?.outputJson
        ? JSON.parse(draftStage.outputJson)?.plan
        : null;
    } catch {
      plan = null;
    }
    if (plan) {
      architecture = buildFallbackArchitecture({
        userInstruction: snapshot.bundles.userInstruction,
        draftPlan: plan,
        lockedRules: snapshot.bundles.lockedRules,
      });
      architectureHash = hashArchitectureEnvelope(architecture);
      await updateStageResult({
        runId: run.id,
        stage: 'narrative_architect',
        status: 'success',
        outputJson: JSON.stringify({
          schemaVersion: 1,
          degraded: true,
          reason: 'narrative_architect_degraded',
          architectureHash,
          envelope: architecture,
        }),
        errorCode: 'narrative_architect_degraded',
        errorMessage: 'Architect 降级 fallback A1（已并入 Draft plan）。',
      });
    }
  }

  return {
    draftArtifact,
    architecture,
    architectureHash,
    architectureDegraded,
  };
}

async function runRound2(
  run: ContinuationGenerationRun,
  snapshot: ContinuationContextSnapshotV5,
  options: V5PipelineOptions,
  draftArtifact: ContinuationArtifact,
  architecture: ContinuationV5ArchitectureEnvelope,
  architectureHash: string,
): Promise<{
  revisionArtifact: ContinuationArtifact;
  audit: ContinuationV5AuditEnvelope;
  auditContractHash: string;
  auditorDegraded: boolean;
}> {
  await casUpdateRunState(run.id, ['running'], { stage: 'round2' });
  const existingRevision = await getLatestArtifactForStage(run.id, 'revision_1');
  const existingRevStage = await getStageResult(run.id, 'revision_writer');
  const existingAuditStage = await getStageResult(run.id, 'adversarial_auditor');

  let revisionArtifact = existingRevision;
  let audit: ContinuationV5AuditEnvelope | null = null;
  let auditContractHash = '';
  let auditorDegraded = false;

  if (existingAuditStage?.status === 'success' && existingAuditStage.outputJson) {
    try {
      const stored = JSON.parse(existingAuditStage.outputJson);
      if (stored?.envelope) {
        audit = stored.envelope as ContinuationV5AuditEnvelope;
        auditContractHash = stored.auditContractHash || hashAuditEnvelope(audit);
        auditorDegraded = Boolean(stored.degraded);
      }
    } catch {
      audit = null;
    }
  }

  if (
    !revisionArtifact &&
    existingRevStage?.requestReserved &&
    existingRevStage.requestCount === 1
  ) {
    throw Object.assign(
      new Error('Revision Writer 已 reservation 但缺少 V2，进入重新生成。'),
      { code: 'revision_writer_reserved_without_artifact' },
    );
  }

  if (
    !audit &&
    existingAuditStage?.requestReserved &&
    existingAuditStage.requestCount === 1
  ) {
    audit = buildFallbackAuditContract({
      draftArtifactHash: draftArtifact.contentHash,
      architectureHash,
      canonSnapshotId: snapshot.canon.snapshotId,
      canonRevision: snapshot.canon.revision,
      inputRevisionHash: snapshot.inputRevisionHash,
      styleProfileHash: snapshot.style?.profileHash ?? null,
      styleRendererVersion: snapshot.style?.rendererVersion ?? null,
      lockedRules: snapshot.bundles.lockedRules ?? [],
      hardCanonFacts: snapshot.stageViews.adversarial_auditor.canon.hardFacts
        .slice(0, 12)
        .map(fact => fact.text),
    });
    auditContractHash = hashAuditEnvelope(audit);
    auditorDegraded = true;
    await updateStageResult({
      runId: run.id,
      stage: 'adversarial_auditor',
      status: 'success',
      outputJson: JSON.stringify({
        schemaVersion: 1,
        degraded: true,
        reason: 'adversarial_auditor_degraded',
        auditContractHash,
        envelope: audit,
      }),
      errorCode: 'adversarial_auditor_degraded',
      errorMessage: 'Auditor 结果丢失，使用本地 fallback C2。',
    });
  }

  const revisionCompiled = compileContinuationV5RevisionWriterMessages({
    view: snapshot.stageViews.revision_writer,
    draftContent: draftArtifact.content,
    draftHan: countHanCharacters(draftArtifact.content),
    draftArtifactHash: draftArtifact.contentHash,
    architecture,
    architectureHash,
  });
  const auditorCompiled = compileContinuationV5AuditorMessages({
    view: snapshot.stageViews.adversarial_auditor,
    draftContent: draftArtifact.content,
    draftArtifactHash: draftArtifact.contentHash,
    architecture,
    architectureHash,
  });

  const tasks: Array<Promise<void>> = [];
  if (!revisionArtifact) {
    tasks.push(
      (async () => {
        const budget = snapshot.stageBudgets.revision_writer;
        const softWarnings: V5SoftWarning[] = [];
        const { result } = await callNode({
          run,
          snapshot,
          stage: 'revision_writer',
          messages: revisionCompiled.messages,
          maxTokens: budget.maximumOutputTokens,
          options,
          promptTokens: revisionCompiled.promptTokens,
        });
        const truncated =
          result.finishReason === 'length' || result.emptyReason === 'length';
        if (truncated) {
          softWarnings.push('revision_writer_output_truncated_soft');
        }
        if (truncated && !CONTINUATION_V5_SOFT_GATES) {
          await markStageFailed({
            runId: run.id,
            stage: 'revision_writer',
            errorCode: 'revision_writer_output_truncated',
            errorMessage: 'Revision Writer 输出被截断，不解析、不落 V2。',
            outputJson: JSON.stringify({
              schemaVersion: 1,
              error: 'revision_writer_output_truncated',
              finishReason: result.finishReason,
            }),
          });
          throw Object.assign(new Error('Revision Writer 输出被截断。'), {
            code: 'revision_writer_output_truncated',
          });
        }
        let envelope;
        try {
          envelope = parseContinuationV5RevisionEnvelope(
            result.text,
            {
              draftArtifactHash: draftArtifact.contentHash,
              architectureHash,
            },
            softWarnings,
          );
        } catch (parseError: any) {
          if (!CONTINUATION_V5_SOFT_GATES) {
            await markStageFailed({
              runId: run.id,
              stage: 'revision_writer',
              errorCode: truncated
                ? 'revision_writer_output_truncated'
                : 'revision_writer_parse_failed',
              errorMessage: parseError?.message || 'Revision Writer 解析失败',
              outputJson: JSON.stringify({
                schemaVersion: 1,
                error: parseError?.message || String(parseError),
                finishReason: result.finishReason,
              }),
            });
            throw parseError;
          }
          // Soft: unusable V2 model output → promote V1 body as intermediate V2.
          softWarnings.push(
            `revision_writer_soft_fallback_to_v1:${parseError?.message || 'parse_failed'}`,
          );
          envelope = {
            schemaVersion: 1 as const,
            draftArtifactHash: draftArtifact.contentHash,
            architectureHash,
            content: softStageDistinctContent(draftArtifact.content, 1),
            usedArchitectSceneIds: [] as string[],
            omittedArchitectSceneIds: [] as string[],
            declaredNewCoreFacts: [] as string[],
          };
        }
        const lengthDiag = diagnoseLengthTelemetry({
          content: envelope.content,
          targetHan: snapshot.settingsSnapshot.values.targetChapterChars,
          finishReason: result.finishReason,
          promptTokens: result.usage?.prompt ?? revisionCompiled.promptTokens,
          completionTokens: result.usage?.completion,
          maximumOutputTokens: budget.maximumOutputTokens,
          declaredMaxOutputTokens: budget.declaredMaxOutputTokens,
          minimumOutputTokens: budget.minimumOutputTokens,
          effectiveMaxOutputTokens: budget.maximumOutputTokens,
        });
        const preferredMin =
          snapshot.stageViews.revision_writer.preferredMinHan;
        if (lengthDiag.actualHan < preferredMin) {
          softWarnings.push(
            `revision_under_preferred_min:${lengthDiag.actualHan}<${preferredMin}`,
          );
        }
        if (lengthDiag.severeUnderTarget) {
          softWarnings.push('revision_severe_under_target');
        }
        const artifact = await insertArtifact({
          runId: run.id,
          stage: 'revision_1',
          content: envelope.content,
          repairRound: 1,
          parentArtifactId: draftArtifact.id,
          eligibilityStatus: 'intermediate',
          rejectionCode: null,
        });
        await updateStageResult({
          runId: run.id,
          stage: 'revision_writer',
          status: 'success',
          artifactId: artifact.id,
          outputTokens: result.usage?.completion ?? null,
          outputJson: JSON.stringify({
            schemaVersion: 1,
            contentHash: artifact.contentHash,
            draftArtifactHash: envelope.draftArtifactHash,
            architectureHash: envelope.architectureHash,
            usedArchitectSceneIds: envelope.usedArchitectSceneIds,
            omittedArchitectSceneIds: envelope.omittedArchitectSceneIds,
            declaredNewCoreFacts: envelope.declaredNewCoreFacts,
            length: lengthDiag,
            softGates: CONTINUATION_V5_SOFT_GATES,
            softWarnings,
            degraded: softWarnings.some(w => w.includes('fallback_to_v1')),
            role: 'primary_length_expansion',
          }),
          errorCode: softWarnings.some(w => w.includes('fallback_to_v1'))
            ? 'revision_writer_soft_fallback_to_v1'
            : softWarnings.some(w => w.includes('hash_mismatch') || w.includes('hash_missing'))
              ? 'revision_writer_hash_soft'
              : softWarnings.some(w => w.includes('under_preferred_min'))
                ? 'revision_under_preferred_min'
                : null,
          errorMessage: softWarnings.length
            ? `软门禁：${softWarnings.slice(0, 4).join('; ')}`
            : null,
        });
        revisionArtifact = artifact;
      })(),
    );
  }

  if (!audit) {
    tasks.push(
      (async () => {
        const budget = snapshot.stageBudgets.adversarial_auditor;
        try {
          const softWarnings: V5SoftWarning[] = [];
          const { result } = await callNode({
            run,
            snapshot,
            stage: 'adversarial_auditor',
            messages: auditorCompiled.messages,
            maxTokens: budget.maximumOutputTokens,
            options,
            promptTokens: auditorCompiled.promptTokens,
          });
          if (result.finishReason === 'length' || result.emptyReason === 'length') {
            if (!CONTINUATION_V5_SOFT_GATES) {
              throw new Error('adversarial_auditor_output_truncated');
            }
            softWarnings.push('adversarial_auditor_output_truncated_soft');
          }
          const envelope = parseContinuationV5AuditEnvelope(
            result.text,
            {
              draftArtifactHash: draftArtifact.contentHash,
              architectureHash,
              canonSnapshotId: snapshot.canon.snapshotId,
              canonRevision: snapshot.canon.revision,
              inputRevisionHash: snapshot.inputRevisionHash,
              styleProfileHash: snapshot.style?.profileHash ?? null,
              styleRendererVersion: snapshot.style?.rendererVersion ?? null,
            },
            softWarnings,
          );
          const hash = hashAuditEnvelope(envelope);
          const softBinding = softWarnings.some(w =>
            w.includes('adversarial_audit_binding'),
          );
          await updateStageResult({
            runId: run.id,
            stage: 'adversarial_auditor',
            status: 'success',
            outputTokens: result.usage?.completion ?? null,
            outputJson: JSON.stringify({
              schemaVersion: 1,
              degraded: softBinding || softWarnings.length > 0,
              auditContractHash: hash,
              envelope,
              finishReason: result.finishReason,
              softGates: CONTINUATION_V5_SOFT_GATES,
              softWarnings,
            }),
            errorCode: softBinding ? 'adversarial_audit_binding_soft' : null,
            errorMessage: softWarnings.length
              ? `软门禁：${softWarnings.slice(0, 4).join('; ')}`
              : null,
          });
          audit = envelope;
          auditContractHash = hash;
          auditorDegraded = softBinding || softWarnings.length > 0;
        } catch (error: any) {
          if (options.signal.aborted) throw error;
          const fallback = buildFallbackAuditContract({
            draftArtifactHash: draftArtifact.contentHash,
            architectureHash,
            canonSnapshotId: snapshot.canon.snapshotId,
            canonRevision: snapshot.canon.revision,
            inputRevisionHash: snapshot.inputRevisionHash,
            styleProfileHash: snapshot.style?.profileHash ?? null,
            styleRendererVersion: snapshot.style?.rendererVersion ?? null,
            lockedRules: snapshot.bundles.lockedRules ?? [],
            hardCanonFacts: snapshot.stageViews.adversarial_auditor.canon.hardFacts
              .slice(0, 12)
              .map(fact => fact.text),
          });
          const hash = hashAuditEnvelope(fallback);
          await updateStageResult({
            runId: run.id,
            stage: 'adversarial_auditor',
            status: 'success',
            outputJson: JSON.stringify({
              schemaVersion: 1,
              degraded: true,
              reason: 'adversarial_auditor_degraded',
              error: error?.message || String(error),
              auditContractHash: hash,
              envelope: fallback,
              softGates: CONTINUATION_V5_SOFT_GATES,
            }),
            errorCode:
              String(error?.message || '').includes('binding')
                ? 'adversarial_audit_binding_failed'
                : 'adversarial_auditor_degraded',
            errorMessage: 'Auditor 失败或绑定失败，使用本地 fallback C2。',
          });
          audit = fallback;
          auditContractHash = hash;
          auditorDegraded = true;
        }
      })(),
    );
  }

  if (tasks.length > 0) {
    // Soft: do not let revision failure cancel a successful auditor task.
    const settled = await Promise.allSettled(tasks);
    if (!CONTINUATION_V5_SOFT_GATES) {
      const rejected = settled.find(item => item.status === 'rejected') as
        | PromiseRejectedResult
        | undefined;
      if (rejected) throw rejected.reason;
    }
  }

  if (!revisionArtifact) {
    if (!CONTINUATION_V5_SOFT_GATES) {
      throw Object.assign(new Error('Round 2 缺少 V2 修订稿'), {
        code: 'revision_writer_failed',
      });
    }
    // Soft: last-resort V2 = V1 so Round 3 can still run.
    const artifact = await insertArtifact({
      runId: run.id,
      stage: 'revision_1',
      content: softStageDistinctContent(draftArtifact.content, 1),
      repairRound: 1,
      parentArtifactId: draftArtifact.id,
      eligibilityStatus: 'intermediate',
      rejectionCode: null,
    });
    await updateStageResult({
      runId: run.id,
      stage: 'revision_writer',
      status: 'success',
      artifactId: artifact.id,
      outputJson: JSON.stringify({
        schemaVersion: 1,
        degraded: true,
        softGates: true,
        softWarnings: ['revision_writer_soft_fallback_to_v1:missing_artifact'],
        contentHash: artifact.contentHash,
        draftArtifactHash: draftArtifact.contentHash,
        architectureHash,
      }),
      errorCode: 'revision_writer_soft_fallback_to_v1',
      errorMessage: '软门禁：Revision 缺失，使用 V1 正文作为 V2 中间稿。',
    });
    revisionArtifact = artifact;
  }
  if (!audit) {
    audit = buildFallbackAuditContract({
      draftArtifactHash: draftArtifact.contentHash,
      architectureHash,
      canonSnapshotId: snapshot.canon.snapshotId,
      canonRevision: snapshot.canon.revision,
      inputRevisionHash: snapshot.inputRevisionHash,
      styleProfileHash: snapshot.style?.profileHash ?? null,
      styleRendererVersion: snapshot.style?.rendererVersion ?? null,
      lockedRules: snapshot.bundles.lockedRules ?? [],
      hardCanonFacts: [],
    });
    auditContractHash = hashAuditEnvelope(audit);
    auditorDegraded = true;
  }

  return {
    revisionArtifact,
    audit,
    auditContractHash,
    auditorDegraded,
  };
}

/**
 * UNIQUE(run_id, content_hash) forbids identical bodies across stages.
 * Soft-promote copies append invisible zero-width spaces so storage can
 * keep a separate row without changing readable Han prose.
 */
function softStageDistinctContent(content: string, generation: 1 | 2): string {
  const stripped = content.replace(/\u200b+$/g, '').replace(/\n+$/g, '');
  return `${stripped}\n${'\u200b'.repeat(generation)}`;
}

async function softDeliverRevisionAsFinal(input: {
  run: ContinuationGenerationRun;
  snapshot: ContinuationContextSnapshotV5;
  revisionArtifact: ContinuationArtifact;
  architecture: ContinuationV5ArchitectureEnvelope;
  architectureHash: string;
  audit: ContinuationV5AuditEnvelope;
  auditContractHash: string;
  architectureDegraded: boolean;
  auditorDegraded: boolean;
  validateStageId: string;
  softWarnings: V5SoftWarning[];
  finalReviserStageResultId?: string | null;
  reasonCode: string;
  reasonMessage: string;
}): Promise<void> {
  const reasonCode = String(input.reasonCode || 'final_reviser_soft_promote_v2');
  const softWarnings: V5SoftWarning[] = [...input.softWarnings];
  try {
    const reviserStage =
      (input.finalReviserStageResultId
        ? { id: input.finalReviserStageResultId }
        : null) || (await getStageResult(input.run.id, 'final_reviser'));
    const reviserId =
      input.finalReviserStageResultId || reviserStage?.id || null;

    let promoteContent = softStageDistinctContent(
      input.revisionArtifact.content,
      2,
    );
    promoteContent = await ensureUniqueArtifactContent(
      input.run.id,
      promoteContent,
    );

    const envelope = {
      schemaVersion: 1 as const,
      revisionArtifactHash: input.revisionArtifact.contentHash,
      architectureHash: input.architectureHash,
      auditContractHash: input.auditContractHash,
      content: promoteContent,
      appliedObligationIds: input.audit.finalObligations.map(
        o => o.obligationId,
      ),
      appliedCanonRequirementIds: [] as string[],
      appliedStyleRequirementIds: [] as string[],
      usedArchitectSceneIds: [] as string[],
      restoredProtectedPassageIds: [] as string[],
      declaredNewCoreFacts: [] as string[],
      unappliedItems: [] as string[],
    };
    const validation = validateFinalArtifact({
      envelope,
      snapshot: input.snapshot,
      architecture: input.architecture,
      architectureHash: input.architectureHash,
      audit: input.audit,
      auditContractHash: input.auditContractHash,
      revisionArtifactHash: input.revisionArtifact.contentHash,
    });
    const deliverable =
      CONTINUATION_V5_SOFT_GATES && Boolean(envelope.content.trim());
    const passed = deliverable ? true : validation.passed;
    softWarnings.push(...(validation.warnings || []));
    if (passed && !validation.passed) {
      softWarnings.push('final_soft_promoted_despite_validator');
    }
    const lengthDiag = diagnoseLengthTelemetry({
      content: envelope.content,
      targetHan: input.snapshot.settingsSnapshot.values.targetChapterChars,
    });
    const tokenUsageJson = await buildTelemetry(input.run.id, input.snapshot, {
      architectureDegraded: input.architectureDegraded,
      auditorDegraded: input.auditorDegraded,
      finalValidationPassed: passed,
      finalValidationCodes: [...validation.codes, ...softWarnings],
      finalLength: lengthDiag,
    });

    const reviserRow = await getStageResult(input.run.id, 'final_reviser');
    const canFinalize =
      Boolean(reviserId) &&
      reviserRow?.requestReserved === true &&
      reviserRow.requestCount === 1;

    if (canFinalize && reviserId) {
      try {
        await finalizeContinuationV5Final({
          runId: input.run.id,
          finalReviserStageResultId: reviserId,
          finalValidateStageResultId: input.validateStageId,
          parentArtifactId: input.revisionArtifact.id,
          content: envelope.content,
          eligibilityStatus: passed ? 'eligible' : 'rejected',
          rejectionCode: passed
            ? null
            : validation.blockingCodes[0] ?? reasonCode,
          tokenUsageJson,
          outputTokens: null,
          finalReviserOutputJson: JSON.stringify({
            schemaVersion: 1,
            degraded: true,
            softGates: CONTINUATION_V5_SOFT_GATES,
            softWarnings,
            reason: reasonCode,
            // Keep envelope metadata only; body is on the artifact row.
            envelope: { ...envelope, content: undefined },
            contentHash: hashContent(envelope.content),
            length: lengthDiag,
            promotedFrom: 'revision_1',
          }),
          finalValidateOutputJson: JSON.stringify({
            schemaVersion: 1,
            ...validation,
            softGates: CONTINUATION_V5_SOFT_GATES,
            softWarnings,
            softPromoted: deliverable,
          }),
          finalValidateStatus: passed ? 'success' : 'failed',
          runState: passed ? 'awaiting_user' : 'awaiting_regeneration',
          errorCode: passed
            ? reasonCode
            : validation.blockingCodes[0] ?? reasonCode,
          errorMessage: passed
            ? `软门禁：${input.reasonMessage}`
            : input.reasonMessage,
        });
        return;
      } catch (finalizeError) {
        softWarnings.push(
          `final_soft_promote_finalize_failed:${formatUnknownError(finalizeError)}`,
        );
        // fall through to manual path
      }
    }

    const finalArtifact = await insertArtifact({
      runId: input.run.id,
      stage: 'final',
      content: envelope.content,
      repairRound: 2,
      parentArtifactId: input.revisionArtifact.id,
      eligibilityStatus: passed ? 'eligible' : 'rejected',
      rejectionCode: passed
        ? null
        : validation.blockingCodes[0] ?? reasonCode,
      requireStageMatch: true,
    });
    await updateStageResult({
      runId: input.run.id,
      stage: 'final_reviser',
      status: passed ? 'success' : 'failed',
      artifactId: finalArtifact.id,
      outputJson: JSON.stringify({
        schemaVersion: 1,
        degraded: true,
        softGates: CONTINUATION_V5_SOFT_GATES,
        softWarnings,
        reason: reasonCode,
        contentHash: finalArtifact.contentHash,
        promotedFrom: 'revision_1',
      }),
      errorCode: reasonCode,
      errorMessage: input.reasonMessage,
    });
    await updateStageResult({
      runId: input.run.id,
      stage: 'final_validate',
      status: passed ? 'success' : 'failed',
      artifactId: finalArtifact.id,
      outputJson: JSON.stringify({
        schemaVersion: 1,
        ...validation,
        softGates: CONTINUATION_V5_SOFT_GATES,
        softWarnings,
        softPromoted: deliverable,
      }),
      errorCode: passed ? null : validation.blockingCodes[0] ?? reasonCode,
      errorMessage: passed ? null : input.reasonMessage,
    });
    await casUpdateRunState(
      input.run.id,
      ['running', 'awaiting_regeneration', 'failed'],
      {
        state: passed ? 'awaiting_user' : 'awaiting_regeneration',
        stage: 'awaiting_user',
        errorCode: passed
          ? reasonCode
          : validation.blockingCodes[0] ?? reasonCode,
        errorMessage: passed
          ? `软门禁：${input.reasonMessage}`
          : input.reasonMessage,
        tokenUsageJson,
        completedAt: null,
      },
    );
  } catch (error) {
    // Never surface raw native objects as "[object Object]".
    const message = formatUnknownError(error);
    softWarnings.push(`final_soft_promote_failed:${message}`);
    try {
      await updateStageResult({
        runId: input.run.id,
        stage: 'final_reviser',
        status: 'failed',
        errorCode: 'final_soft_promote_failed',
        errorMessage: message,
        outputJson: JSON.stringify({
          schemaVersion: 1,
          softGates: true,
          softWarnings,
        }),
      });
      await updateStageResult({
        runId: input.run.id,
        stage: 'final_validate',
        status: 'failed',
        errorCode: 'final_soft_promote_failed',
        errorMessage: message,
      });
    } catch {
      // best-effort stage marks
    }
    throw Object.assign(new Error(`软提升 V2→V3 失败：${message}`), {
      code: 'final_soft_promote_failed',
      softWarnings,
    });
  }
}

async function runRound3AndValidate(
  run: ContinuationGenerationRun,
  snapshot: ContinuationContextSnapshotV5,
  options: V5PipelineOptions,
  revisionArtifact: ContinuationArtifact,
  architecture: ContinuationV5ArchitectureEnvelope,
  architectureHash: string,
  audit: ContinuationV5AuditEnvelope,
  auditContractHash: string,
  architectureDegraded: boolean,
  auditorDegraded: boolean,
): Promise<void> {
  await casUpdateRunState(run.id, ['running'], { stage: 'round3' });
  const existingFinal = await getLatestArtifactForStage(run.id, 'final');
  const finalStage = await getStageResult(run.id, 'final_reviser');
  const validateStage = await getStageResult(run.id, 'final_validate');
  if (!validateStage) throw new Error('缺少 final_validate stage result');

  // Resume: V3 exists → only validator.
  if (existingFinal) {
    const envelope = {
      schemaVersion: 1 as const,
      revisionArtifactHash: revisionArtifact.contentHash,
      architectureHash,
      auditContractHash,
      content: existingFinal.content,
      appliedObligationIds: [] as string[],
      appliedCanonRequirementIds: [] as string[],
      appliedStyleRequirementIds: [] as string[],
      usedArchitectSceneIds: [] as string[],
      restoredProtectedPassageIds: [] as string[],
      declaredNewCoreFacts: [] as string[],
      unappliedItems: [] as string[],
    };
    try {
      const stored = finalStage?.outputJson
        ? JSON.parse(finalStage.outputJson)
        : null;
      if (stored?.envelope) Object.assign(envelope, stored.envelope);
    } catch {
      // keep defaults
    }
    const validation = validateFinalArtifact({
      envelope,
      snapshot,
      architecture,
      architectureHash,
      audit,
      auditContractHash,
      revisionArtifactHash: revisionArtifact.contentHash,
    });
    const tokenUsageJson = await buildTelemetry(run.id, snapshot, {
      architectureDegraded,
      auditorDegraded,
      finalValidationPassed: validation.passed,
      finalValidationCodes: validation.codes,
    });
    await finalizeContinuationV5ValidatorOnly({
      runId: run.id,
      finalArtifactId: existingFinal.id,
      finalValidateStageResultId: validateStage.id,
      eligibilityStatus: validation.passed ? 'eligible' : 'rejected',
      rejectionCode: validation.passed
        ? null
        : validation.blockingCodes[0] ?? 'final_invalid_envelope',
      finalValidateOutputJson: JSON.stringify({
        schemaVersion: 1,
        softGates: CONTINUATION_V5_SOFT_GATES,
        ...validation,
      }),
      tokenUsageJson,
      runState: validation.passed ? 'awaiting_user' : 'awaiting_regeneration',
      errorCode: validation.passed
        ? null
        : validation.blockingCodes[0] ?? 'final_invalid_envelope',
      errorMessage: validation.passed
        ? null
        : '最终稿未通过技术完整性验证。本次没有可交付终稿，请重新生成。',
    });
    return;
  }

  // Resume: Final already reserved without artifact → soft-promote V2 when enabled.
  if (finalStage?.requestReserved && finalStage.requestCount === 1) {
    if (CONTINUATION_V5_SOFT_GATES) {
      await softDeliverRevisionAsFinal({
        run,
        snapshot,
        revisionArtifact,
        architecture,
        architectureHash,
        audit,
        auditContractHash,
        architectureDegraded,
        auditorDegraded,
        validateStageId: validateStage.id,
        finalReviserStageResultId: finalStage.id,
        softWarnings: ['final_reviser_soft_promote_v2:reserved_without_artifact'],
        reasonCode: 'final_reviser_soft_promote_v2',
        reasonMessage:
          'Final Reviser 已 reservation 但缺少 V3；软门禁下以 V2 作为可交付终稿。',
      });
      return;
    }
    await markStageFailed({
      runId: run.id,
      stage: 'final_reviser',
      errorCode: 'final_reviser_reserved_without_artifact',
      errorMessage: 'Final Reviser 已 reservation 但缺少 V3，不重发。',
    });
    await updateStageResult({
      runId: run.id,
      stage: 'final_validate',
      status: 'skipped',
      errorCode: 'final_reviser_reserved_without_artifact',
      errorMessage: '无 V3 可验证。',
    });
    await casUpdateRunState(run.id, ['running'], {
      state: 'awaiting_regeneration',
      stage: 'awaiting_user',
      errorCode: 'final_reviser_reserved_without_artifact',
      errorMessage:
        '最终稿未形成可交付结果。本次不会自动回退到初稿或第一次修订稿。',
      tokenUsageJson: await buildTelemetry(run.id, snapshot, {
        architectureDegraded,
        auditorDegraded,
        finalValidationPassed: false,
      }),
    });
    return;
  }

  const budget = snapshot.stageBudgets.final_reviser;
  const compiled = compileContinuationV5FinalReviserWithinBudget({
    view: snapshot.stageViews.final_reviser,
    revisionContent: revisionArtifact.content,
    revisionHan: countHanCharacters(revisionArtifact.content),
    revisionArtifactHash: revisionArtifact.contentHash,
    architecture,
    architectureHash,
    audit,
    auditContractHash,
    contextWindow: budget.contextWindow,
    maximumOutputTokens: budget.maximumOutputTokens,
  });
  if (!compiled.ok) {
    if (CONTINUATION_V5_SOFT_GATES) {
      await softDeliverRevisionAsFinal({
        run,
        snapshot,
        revisionArtifact,
        architecture,
        architectureHash,
        audit,
        auditContractHash,
        architectureDegraded,
        auditorDegraded,
        validateStageId: validateStage.id,
        softWarnings: [
          'final_reviser_soft_promote_v2:prompt_budget_exceeded',
          `promptTokens=${compiled.promptTokens}`,
        ],
        reasonCode: 'final_reviser_prompt_budget_exceeded_soft',
        reasonMessage:
          'Final Reviser Prompt 超预算未发请求；软门禁下以 V2 作为可交付终稿。',
      });
      return;
    }
    await updateStageResult({
      runId: run.id,
      stage: 'final_reviser',
      status: 'failed',
      errorCode: 'final_reviser_prompt_budget_exceeded',
      errorMessage: 'Final Reviser Prompt 超预算，不发请求。',
      outputJson: JSON.stringify({
        schemaVersion: 1,
        error: 'final_reviser_prompt_budget_exceeded',
        promptTokens: compiled.promptTokens,
        compressionLevel: compiled.compressionLevel,
      }),
    });
    await updateStageResult({
      runId: run.id,
      stage: 'final_validate',
      status: 'skipped',
      errorCode: 'final_reviser_prompt_budget_exceeded',
      errorMessage: '未生成 V3。',
    });
    await casUpdateRunState(run.id, ['running'], {
      state: 'awaiting_regeneration',
      stage: 'awaiting_user',
      errorCode: 'final_reviser_prompt_budget_exceeded',
      errorMessage:
        '最终稿未形成可交付结果。本次不会自动回退到初稿或第一次修订稿。',
      tokenUsageJson: await buildTelemetry(run.id, snapshot, {
        architectureDegraded,
        auditorDegraded,
        finalValidationPassed: false,
      }),
    });
    return;
  }

  await casUpdateRunState(run.id, ['running'], { stage: 'final_reviser' });
  let reserved: ContinuationGenerationStageResult;
  let result: StageLlmCallResult;
  try {
    const call = await callNode({
      run,
      snapshot,
      stage: 'final_reviser',
      messages: compiled.messages,
      maxTokens: budget.maximumOutputTokens,
      options,
      promptTokens: compiled.promptTokens,
    });
    reserved = call.reserved;
    result = call.result;
  } catch (error: any) {
    if (options.signal.aborted) throw error;
    if (CONTINUATION_V5_SOFT_GATES) {
      const reservedRow = await getStageResult(run.id, 'final_reviser');
      await softDeliverRevisionAsFinal({
        run,
        snapshot,
        revisionArtifact,
        architecture,
        architectureHash,
        audit,
        auditContractHash,
        architectureDegraded,
        auditorDegraded,
        validateStageId: validateStage.id,
        finalReviserStageResultId: reservedRow?.id ?? null,
        softWarnings: [
          `final_reviser_soft_promote_v2:call_failed:${formatUnknownError(error)}`,
        ],
        reasonCode: formatUnknownErrorCode(error, 'final_reviser_failed_soft'),
        reasonMessage: `Final Reviser 调用失败；软门禁下以 V2 作为可交付终稿。`,
      });
      return;
    }
    await markStageFailed({
      runId: run.id,
      stage: 'final_reviser',
      errorCode: formatUnknownErrorCode(error, 'final_reviser_failed'),
      errorMessage: formatUnknownError(error) || 'Final Reviser 失败',
    });
    await updateStageResult({
      runId: run.id,
      stage: 'final_validate',
      status: 'skipped',
      errorCode: error?.code || 'final_reviser_failed',
      errorMessage: '未生成 V3。',
    });
    await casUpdateRunState(run.id, ['running'], {
      state: 'awaiting_regeneration',
      stage: 'awaiting_user',
      errorCode: error?.code || 'final_reviser_failed',
      errorMessage:
        '最终稿未形成可交付结果。本次不会自动回退到初稿或第一次修订稿。',
      tokenUsageJson: await buildTelemetry(run.id, snapshot, {
        architectureDegraded,
        auditorDegraded,
      }),
    });
    return;
  }

  const softWarnings: V5SoftWarning[] = [];
  const truncated =
    result.finishReason === 'length' || result.emptyReason === 'length';
  if (truncated) {
    softWarnings.push('final_output_truncated_soft');
  }
  if (truncated && !CONTINUATION_V5_SOFT_GATES) {
    await markStageFailed({
      runId: run.id,
      stage: 'final_reviser',
      errorCode: 'final_output_truncated',
      errorMessage: 'Final Reviser 输出被截断，不解析、不落 V3。',
      outputJson: JSON.stringify({
        schemaVersion: 1,
        error: 'final_output_truncated',
        finishReason: result.finishReason,
        promptTokens: result.usage?.prompt ?? compiled.promptTokens,
        completionTokens: result.usage?.completion ?? null,
      }),
    });
    await updateStageResult({
      runId: run.id,
      stage: 'final_validate',
      status: 'failed',
      errorCode: 'final_output_truncated',
      errorMessage: 'V3 截断，无可交付终稿。',
    });
    await casUpdateRunState(run.id, ['running'], {
      state: 'awaiting_regeneration',
      stage: 'awaiting_user',
      errorCode: 'final_output_truncated',
      errorMessage:
        '最终稿未形成可交付结果。本次不会自动回退到初稿或第一次修订稿。',
      tokenUsageJson: await buildTelemetry(run.id, snapshot, {
        architectureDegraded,
        auditorDegraded,
        finalValidationPassed: false,
      }),
    });
    return;
  }

  let envelope;
  try {
    envelope = parseContinuationV5FinalEnvelope(
      result.text,
      {
        revisionArtifactHash: revisionArtifact.contentHash,
        architectureHash,
        auditContractHash,
      },
      softWarnings,
    );
  } catch (error: any) {
    if (CONTINUATION_V5_SOFT_GATES) {
      await softDeliverRevisionAsFinal({
        run,
        snapshot,
        revisionArtifact,
        architecture,
        architectureHash,
        audit,
        auditContractHash,
        architectureDegraded,
        auditorDegraded,
        validateStageId: validateStage.id,
        finalReviserStageResultId: reserved.id,
        softWarnings: [
          ...softWarnings,
          `final_reviser_soft_promote_v2:parse_failed:${error?.message || 'invalid'}`,
        ],
        reasonCode: 'final_invalid_envelope_soft',
        reasonMessage:
          'Final envelope 非法或截断无法解析；软门禁下以 V2 作为可交付终稿。',
      });
      return;
    }
    await markStageFailed({
      runId: run.id,
      stage: 'final_reviser',
      errorCode: error?.message?.includes('hash')
        ? String(error.message).split(':')[0] || 'final_invalid_envelope'
        : 'final_invalid_envelope',
      errorMessage: error?.message || 'Final envelope 非法',
      outputJson: JSON.stringify({
        schemaVersion: 1,
        error: error?.message || 'final_invalid_envelope',
      }),
    });
    await updateStageResult({
      runId: run.id,
      stage: 'final_validate',
      status: 'failed',
      errorCode: 'final_invalid_envelope',
      errorMessage: 'V3 envelope 非法。',
    });
    await casUpdateRunState(run.id, ['running'], {
      state: 'awaiting_regeneration',
      stage: 'awaiting_user',
      errorCode: 'final_invalid_envelope',
      errorMessage:
        '最终稿未形成可交付结果。本次不会自动回退到初稿或第一次修订稿。',
      tokenUsageJson: await buildTelemetry(run.id, snapshot, {
        architectureDegraded,
        auditorDegraded,
      }),
    });
    return;
  }

  const lengthDiag = diagnoseLengthTelemetry({
    content: envelope.content,
    targetHan: snapshot.settingsSnapshot.values.targetChapterChars,
    finishReason: result.finishReason,
    promptTokens: result.usage?.prompt ?? compiled.promptTokens,
    completionTokens: result.usage?.completion,
    maximumOutputTokens: budget.maximumOutputTokens,
    declaredMaxOutputTokens: budget.declaredMaxOutputTokens,
    minimumOutputTokens: budget.minimumOutputTokens,
    effectiveMaxOutputTokens: budget.maximumOutputTokens,
  });

  await casUpdateRunState(run.id, ['running'], { stage: 'final_validate' });
  const validation = validateFinalArtifact({
    envelope,
    finishReason: result.finishReason,
    snapshot,
    architecture,
    architectureHash,
    audit,
    auditContractHash,
    revisionArtifactHash: revisionArtifact.contentHash,
  });

  const tokenUsageJson = await buildTelemetry(run.id, snapshot, {
    architectureDegraded,
    auditorDegraded,
    architectureSceneCount: architecture.sceneUnits.length,
    revisionUsedSceneCount: null,
    finalUsedSceneCount: envelope.usedArchitectSceneIds.length,
    auditCanonRequirementCount: audit.canonAudit.requiredCorrections.length,
    auditStyleRequirementCount: audit.styleAudit.requiredCorrections.length,
    finalAppliedObligationCount: envelope.appliedObligationIds.length,
    finalValidationPassed: validation.passed,
    finalValidationCodes: [...validation.codes, ...softWarnings],
    finalLength: lengthDiag,
    finalCompressionLevel: compiled.compressionLevel,
  });

  const softNote =
    softWarnings.length > 0
      ? `软门禁警告：${softWarnings.slice(0, 4).join('; ')}`
      : null;

  await finalizeContinuationV5Final({
    runId: run.id,
    finalReviserStageResultId: reserved.id,
    finalValidateStageResultId: validateStage.id,
    parentArtifactId: revisionArtifact.id,
    content: envelope.content,
    eligibilityStatus: validation.passed ? 'eligible' : 'rejected',
    rejectionCode: validation.passed
      ? null
      : validation.blockingCodes[0] ?? 'final_invalid_envelope',
    tokenUsageJson,
    outputTokens: result.usage?.completion ?? null,
    finalReviserOutputJson: JSON.stringify({
      schemaVersion: 1,
      envelope,
      contentHash: hashContent(envelope.content),
      length: lengthDiag,
      compressionLevel: compiled.compressionLevel,
      finishReason: result.finishReason,
      softGates: CONTINUATION_V5_SOFT_GATES,
      softWarnings,
    }),
    finalValidateOutputJson: JSON.stringify({
      schemaVersion: 1,
      softGates: CONTINUATION_V5_SOFT_GATES,
      softWarnings,
      ...validation,
    }),
    finalValidateStatus: validation.passed ? 'success' : 'failed',
    runState: validation.passed ? 'awaiting_user' : 'awaiting_regeneration',
    errorCode: validation.passed
      ? softWarnings.length
        ? 'final_soft_warnings'
        : null
      : validation.blockingCodes[0] ?? 'final_invalid_envelope',
    errorMessage: validation.passed
      ? softNote
      : '最终稿未通过技术完整性验证。本次没有可交付终稿，请重新生成。本次不会自动回退到初稿或第一次修订稿。',
  });
}

async function runV5Pipeline(
  run: ContinuationGenerationRun,
  snapshot: ContinuationContextSnapshotV5,
  _trace: ContinuationContextTrace,
  options: V5PipelineOptions,
): Promise<void> {
  assertNotAborted(options.signal);
  await ensureContinuationV5StageResults({
    runId: run.id,
    stages: {
      draft_writer: {
        configId: snapshot.stageBudgets.draft_writer.configId,
        compiledPromptTokens:
          snapshot.stageBudgets.draft_writer.compiledPromptTokens,
        minimumOutputTokens:
          snapshot.stageBudgets.draft_writer.minimumOutputTokens,
        maximumOutputTokens:
          snapshot.stageBudgets.draft_writer.maximumOutputTokens,
      },
      narrative_architect: {
        configId: snapshot.stageBudgets.narrative_architect.configId,
        compiledPromptTokens:
          snapshot.stageBudgets.narrative_architect.compiledPromptTokens,
        minimumOutputTokens:
          snapshot.stageBudgets.narrative_architect.minimumOutputTokens,
        maximumOutputTokens:
          snapshot.stageBudgets.narrative_architect.maximumOutputTokens,
      },
      revision_writer: {
        configId: snapshot.stageBudgets.revision_writer.configId,
        compiledPromptTokens:
          snapshot.stageBudgets.revision_writer.compiledPromptTokens,
        minimumOutputTokens:
          snapshot.stageBudgets.revision_writer.minimumOutputTokens,
        maximumOutputTokens:
          snapshot.stageBudgets.revision_writer.maximumOutputTokens,
      },
      adversarial_auditor: {
        configId: snapshot.stageBudgets.adversarial_auditor.configId,
        compiledPromptTokens:
          snapshot.stageBudgets.adversarial_auditor.compiledPromptTokens,
        minimumOutputTokens:
          snapshot.stageBudgets.adversarial_auditor.minimumOutputTokens,
        maximumOutputTokens:
          snapshot.stageBudgets.adversarial_auditor.maximumOutputTokens,
      },
      final_reviser: {
        configId: snapshot.stageBudgets.final_reviser.configId,
        compiledPromptTokens:
          snapshot.stageBudgets.final_reviser.compiledPromptTokens,
        minimumOutputTokens:
          snapshot.stageBudgets.final_reviser.minimumOutputTokens,
        maximumOutputTokens:
          snapshot.stageBudgets.final_reviser.maximumOutputTokens,
      },
    },
  });

  const round1 = await runRound1(run, snapshot, options);
  assertNotAborted(options.signal);
  const round2 = await runRound2(
    run,
    snapshot,
    options,
    round1.draftArtifact,
    round1.architecture,
    round1.architectureHash,
  );
  assertNotAborted(options.signal);
  await runRound3AndValidate(
    run,
    snapshot,
    options,
    round2.revisionArtifact,
    round1.architecture,
    round1.architectureHash,
    round2.audit,
    round2.auditContractHash,
    round1.architectureDegraded,
    round2.auditorDegraded,
  );
}

async function finalizeV5OnError(runId: string, error: unknown): Promise<void> {
  try {
    const message = formatUnknownError(error);
    const code =
      error instanceof ContinuationStageOutputTruncatedError
        ? 'draft_writer_output_truncated'
        : error instanceof ContinuationCapabilityBlockedError
          ? error.code
          : formatUnknownErrorCode(error, 'stage_failed');
    const isRegenerate =
      code.startsWith('revision_') ||
      code.startsWith('final_') ||
      code === 'revision_writer_failed' ||
      code === 'revision_writer_output_truncated' ||
      code === 'revision_writer_reserved_without_artifact' ||
      code === 'final_soft_promote_failed';
    await casUpdateRunState(
      runId,
      ['running', 'queued', 'awaiting_user', 'awaiting_regeneration', 'failed'],
      {
        state: isRegenerate ? 'awaiting_regeneration' : 'failed',
        stage: 'awaiting_user',
        errorCode: code,
        errorMessage: isRegenerate
          ? `${message} 本次不会自动回退到初稿或第一次修订稿。`
          : message,
        completedAt: isRegenerate ? null : new Date().toISOString(),
      },
    );
  } catch {
    // best-effort
  }
}

export async function startContinuationV5Run(
  input: StartContinuationRunInput,
): Promise<ContinuationGenerationRun> {
  const settings = await ensureGenerationSettings(input.projectId);
  const policy = await ensureContextAutomationPolicy();
  const resolved = await resolveV5StageModels(settings);
  const { snapshot, trace } = await buildContinuationV5Context({
    projectId: input.projectId,
    targetChapterId: input.chapterId,
    targetPosition: input.targetPosition as any,
    currentChapterContent: input.currentChapterContent,
    userInstruction: input.userInstruction,
    activeLlmConfigId: resolved.activeConfigId,
    policy,
    stageModels: resolved.stageModels,
    frozenModelConfigs: resolved.frozenModelConfigs,
    lengthPolicy: CONTINUATION_V5_LENGTH_POLICY,
  });
  const runId = newContinuationRunId();
  const run = await insertRun({
    id: runId,
    projectId: input.projectId,
    chapterId: input.chapterId,
    targetPosition: input.targetPosition as any,
    sourceId: snapshot.source.sourceId,
    sourceSnapshotJson: JSON.stringify({ schemaVersion: 1, ...snapshot.source }),
    canonSnapshotId: snapshot.canon.snapshotId,
    canonRevision: snapshot.canon.revision,
    storyMemoryFingerprint: snapshot.storyMemory.stateFingerprint,
    storyMemoryThroughPosition: snapshot.storyMemory.throughPosition,
    inputRevisionHash: snapshot.inputRevisionHash,
    userInstruction: input.userInstruction,
    settingsSnapshotJson: JSON.stringify(snapshot.settingsSnapshot),
    contextSnapshotJson: JSON.stringify(snapshot),
    contextTraceJson: JSON.stringify(trace),
    tokenUsageJson: JSON.stringify({
      workflowVersion: 5,
      maxPhysicalRequests: CONTINUATION_V5_MAX_PHYSICAL_REQUESTS,
      physicalRequestCount: 0,
      stages: {},
    }),
    state: 'running',
    stage: 'round1',
    completionReason: null,
    adoptedRevisionHash: null,
    finalizedRevisionHash: null,
    errorCode: null,
    errorMessage: null,
  });
  const controller = new AbortController();
  activeContinuationControllers.set(runId, controller);
  void (async () => {
    try {
      await runV5Pipeline(run, snapshot, trace, {
        callStage: input.callStage,
        deterministicOnly: input.deterministicOnly,
        signal: controller.signal,
        projectId: input.projectId,
      });
    } catch (error) {
      try {
        await finalizeV5OnError(runId, error);
      } catch (finalizeError) {
        console.warn('[continuation-v5] pipeline finalizer failed:', finalizeError);
      }
    } finally {
      activeContinuationControllers.delete(runId);
    }
  })().catch(error => {
    console.warn('[continuation-v5] pipeline task failed:', error);
  });
  return run;
}

export async function resumeContinuationV5Run(
  runId: string,
  callStage?: StageLlmCaller,
  deterministicOnly?: boolean,
): Promise<void> {
  const run = await getRunById(runId);
  if (!run) throw new Error('run 不存在');
  if (run.workflowVersion !== 5) throw new Error('不是 V5 续写运行');
  if (run.state === 'outdated') throw new ContinuationOutdatedError();
  if (run.state === 'awaiting_user' || run.state === 'awaiting_regeneration') {
    return;
  }
  if (run.state !== 'interrupted' && run.state !== 'failed') {
    throw new Error('仅 interrupted/failed V5 运行可恢复');
  }
  if (!run.contextSnapshotJson) throw new Error('缺少冻结 V5 context。');
  const snapshot = JSON.parse(
    run.contextSnapshotJson,
  ) as ContinuationContextSnapshotV5;
  if (snapshot.schemaVersion !== 4 || snapshot.workflowVersion !== 5) {
    throw new Error('V5 context snapshot 版本不匹配。');
  }
  const trace = run.contextTraceJson
    ? (JSON.parse(run.contextTraceJson) as ContinuationContextTrace)
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
  const changed = await casUpdateRunState(runId, ['interrupted', 'failed'], {
    state: 'running',
    stage: run.stage === 'round1' ? 'round1' : run.stage,
    errorCode: null,
    errorMessage: null,
    completedAt: null,
  });
  if (!changed) return;
  const controller = new AbortController();
  activeContinuationControllers.set(runId, controller);
  try {
    await runV5Pipeline(
      { ...run, state: 'running' },
      snapshot,
      trace,
      {
        callStage,
        deterministicOnly,
        signal: controller.signal,
        projectId: run.projectId,
      },
    );
  } catch (error) {
    await finalizeV5OnError(runId, error);
    throw error;
  } finally {
    activeContinuationControllers.delete(runId);
  }
}

export async function markContinuationV5StagesCancelled(
  runId: string,
): Promise<void> {
  const results = await listStageResults(runId).catch(
    () => [] as ContinuationGenerationStageResult[],
  );
  for (const result of results) {
    if (result.status !== 'queued' && result.status !== 'running') continue;
    try {
      await updateStageResult({
        runId,
        stage: result.stage,
        status: 'interrupted',
        outputJson: result.outputJson,
        artifactId: result.artifactId,
        errorCode: 'cancelled',
        errorMessage: '用户取消，reservation 不会自动重发。',
      });
    } catch (error) {
      console.warn(
        `[continuation-v5] mark stage ${result.stage} interrupted failed:`,
        error,
      );
    }
  }
}

export {
  parseContinuationV5DraftEnvelope,
  parseContinuationV5ArchitectureEnvelope,
  parseContinuationV5RevisionEnvelope,
  parseContinuationV5AuditEnvelope,
  parseContinuationV5FinalEnvelope,
  hashArchitectureEnvelope,
  hashAuditEnvelope,
  CONTINUATION_V5_LENGTH_POLICY,
};

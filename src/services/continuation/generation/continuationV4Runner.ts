/**
 * Continuation V4 FULL-Control runner.
 *
 * This module is intentionally separate from the historical ~2,800 line
 * runner. V4 has a smaller state machine and a different request contract:
 * Writer -> (Checker || Control) -> Repair -> Local Final Gate. The four
 * physical request reservations are the authority for retry/resume safety.
 */
import type { ChatMessage, LLMRequestConfig } from '../../llm/types';
import {
  callLLMResult,
  resolveLLMRequestConfig,
  resolveLLMRequestConfigById,
} from '../../llm';
import { ensureContextAutomationPolicy } from '../../contextAutoAllocator';
import { stripModelJson } from '../canon/canonJsonValidators';
import {
  bindIssuesToArtifact,
  filterBySettings,
  parseCheckerLlmEnvelope,
  runDeterministicChecks,
} from './continuationChecker';
import type { RawCheckIssue } from './continuationChecker';
import {
  buildContinuationV4StageViews,
  hashContinuationV4StageView,
} from './continuationV4ContextViews';
import {
  buildContinuationControlFallback,
  buildContinuationControlMetrics,
  requiredControlProgressHan,
  resolveContinuationControlReport,
} from './continuationControl';
import {
  compileContinuationV4CheckerMessages,
  compileContinuationV4ControlMessages,
  compileContinuationV4RepairMessages,
  compileContinuationV4WriterMessages,
  continuationV4ProtocolSkeletonTokens,
} from './continuationV4PromptCompiler';
import {
  buildContinuationV4Context,
} from './continuationContextBuilder';
import {
  resolveContinuationV4BudgetPreview,
} from './continuationV4Budget';
import {
  casUpdateRunState,
  contentRevisionHash,
  ensureContinuationV4StageResults,
  ensureGenerationSettings,
  finalizeContinuationV4LocalGate,
  finalizeContinuationV4RepairRejection,
  finalizeContinuationV4Repair,
  getLatestArtifactForStage,
  getPlan,
  getRunById,
  getStageResult,
  insertArtifact,
  insertCheckResults,
  insertRun,
  listChecksForArtifact,
  listStageResults,
  newContinuationRunId,
  reserveContinuationStage,
  savePlan,
  updateStageResult,
} from './generationRepository';
import type {
  ContinuationArtifact,
  ContinuationCheckResult,
  ContinuationContextSnapshotV3,
  ContinuationContextTrace,
  ContinuationGenerationRun,
  ContinuationGenerationStageResult,
  ContinuationGenerationSettings,
  ContinuationPlan,
  ContinuationControlReport,
  ContinuationV4Metrics,
  ContinuationV4RepairEnvelope,
  ContinuationV4StageBudgets,
  ContinuationV4StageName,
  ContinuationV4WriterEnvelope,
  FrozenContinuationModelConfig,
} from './types';
import {
  ContinuationCapabilityBlockedError,
  ContinuationOutdatedError,
} from './types';
import type {
  StageLlmCallResult,
  StageLlmCaller,
  StartContinuationRunInput,
} from './continuationGenerationRunner';
import { activeContinuationControllers } from './continuationRunControllers';
import {
  countHanCharacters,
} from './continuationLengthContract';
import { estimateMessagesTokens, estimateTokens } from '../../../utils/tokenEstimator';

type V4PhysicalStage = Exclude<ContinuationV4StageName, 'local_verify'>;

interface V4PipelineOptions {
  callStage?: StageLlmCaller;
  deterministicOnly?: boolean;
  signal: AbortSignal;
  projectId: number;
}

interface V4StageModel {
  configId: number;
  contextWindow: number;
  maxOutputTokens: number;
}

interface V4StageModels {
  writer: V4StageModel;
  checker: V4StageModel;
  control: V4StageModel;
  repair: V4StageModel;
}

interface V4WriterResult {
  artifact: ContinuationArtifact;
  plan: ContinuationPlan;
}

interface V4CheckerOutcome {
  issues: RawCheckIssue[];
  persistedIssues: ContinuationCheckResult[];
}

interface V4ControlOutcome {
  metrics: ContinuationV4Metrics;
  report: ReturnType<typeof buildContinuationControlFallback>;
  degraded: boolean;
  errorCode: string | null;
}

interface V4RepairOutcome {
  artifact: ContinuationArtifact | null;
  completed: boolean;
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
  const id = requirePositive(config?.id, 'LLM 配置 id');
  return id;
}

function freezeV4ModelConfig(
  config: LLMRequestConfig | null | undefined,
): FrozenContinuationModelConfig {
  if (!config) {
    throw new ContinuationCapabilityBlockedError('缺少 V4 阶段模型配置。');
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

async function resolveV4StageConfig(
  configuredId: number | null,
  activeConfig: LLMRequestConfig | null,
): Promise<LLMRequestConfig> {
  const config = configuredId == null
    ? activeConfig
    : await resolveLLMRequestConfigById(configuredId).catch(() => null);
  if (!config) {
    throw new ContinuationCapabilityBlockedError(
      `无法读取已选择的 LLM 配置 #${String(configuredId ?? '')}。`,
    );
  }
  // The selected id is part of the frozen routing contract. Do not silently
  // replace a missing selected model with the active model.
  if (configuredId != null && modelConfigId(config) !== configuredId) {
    throw new ContinuationCapabilityBlockedError(
      `LLM 配置 #${configuredId} 读取后 id 不一致，已阻止本次续写。`,
    );
  }
  return config;
}

async function resolveV4StageModels(
  settings: ContinuationGenerationSettings,
): Promise<{
  stageModels: V4StageModels;
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
  const [writer, checker, control, repair] = await Promise.all([
    resolveV4StageConfig(settings.writerLlmConfigId, activeConfig),
    resolveV4StageConfig(settings.checkerLlmConfigId, activeConfig),
    resolveV4StageConfig(settings.controlLlmConfigId, activeConfig),
    resolveV4StageConfig(settings.repairLlmConfigId, activeConfig),
  ]);
  const frozen = {
    planner: null,
    writer: freezeV4ModelConfig(writer),
    checker: freezeV4ModelConfig(checker),
    repair: freezeV4ModelConfig(repair),
    stateExtraction: null,
    control: freezeV4ModelConfig(control),
  } satisfies NonNullable<
    import('./types').ContinuationGenerationSettingsSnapshot['frozenModelConfigs']
  >;
  return {
    activeConfigId,
    stageModels: {
      writer: {
        configId: frozen.writer!.configId,
        contextWindow: frozen.writer!.contextWindow,
        maxOutputTokens: frozen.writer!.maxOutputTokens,
      },
      checker: {
        configId: frozen.checker!.configId,
        contextWindow: frozen.checker!.contextWindow,
        maxOutputTokens: frozen.checker!.maxOutputTokens,
      },
      control: {
        configId: frozen.control!.configId,
        contextWindow: frozen.control!.contextWindow,
        maxOutputTokens: frozen.control!.maxOutputTokens,
      },
      repair: {
        configId: frozen.repair!.configId,
        contextWindow: frozen.repair!.contextWindow,
        maxOutputTokens: frozen.repair!.maxOutputTokens,
      },
    },
    frozenModelConfigs: frozen,
  };
}

async function defaultV4StageCaller(input: {
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
      scenario: `continuation_v4_${input.stage}`,
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

function parseWriterObjectValue(value: unknown): Record<string, any> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : null;
  } catch {
    return null;
  }
}

function firstWriterString(
  values: Array<unknown>,
  fallback: string,
): string {
  const value = values.find(
    candidate => typeof candidate === 'string' && candidate.trim(),
  );
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function extractWriterContent(value: unknown, depth = 0): string {
  if (depth > 3) return '';
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    return value
      .map(item => extractWriterContent(item, depth + 1))
      .filter(Boolean)
      .join('\n\n');
  }
  if (!value || typeof value !== 'object') return '';
  const object = value as Record<string, unknown>;
  for (const key of [
    'content',
    'chapterContent',
    'chapter_content',
    'finalText',
    'final_content',
    'text',
    'body',
    'draft',
    'draftText',
    'chapterText',
    'storyText',
    'novelText',
    'article',
    'story',
    'output',
    'answer',
    'response',
    '正文',
    '章节正文',
    'paragraphs',
    'result',
    'data',
  ]) {
    const extracted = extractWriterContent(object[key], depth + 1);
    if (extracted) return extracted;
  }
  return '';
}

function normalizeWriterBeats(
  values: unknown,
  fallbackSummary: string,
): Array<{ order: number; summary: string; conflict?: string }> {
  if (!Array.isArray(values)) {
    return [{ order: 1, summary: fallbackSummary }];
  }
  const beats = values
    .map((beat: any, index) => {
      if (typeof beat === 'string' && beat.trim()) {
        return { order: index + 1, summary: beat.trim() };
      }
      if (!beat || typeof beat.summary !== 'string' || !beat.summary.trim()) {
        return null;
      }
      return {
        order: index + 1,
        summary: beat.summary.trim(),
        ...(typeof beat.id === 'string' && beat.id.trim()
          ? { conflict: beat.id.trim() }
          : {}),
      };
    })
    .filter(
      (beat): beat is { order: number; summary: string; conflict?: string } =>
        beat !== null,
    );
  return beats.length > 0
    ? beats
    : [{ order: 1, summary: fallbackSummary }];
}

export function parseContinuationV4WriterEnvelope(
  raw: string,
  fallbackPlan: {
    chapterGoal?: string;
    centralConflict?: string;
  } = {},
): {
  envelope: ContinuationV4WriterEnvelope;
  plan: ContinuationPlan;
  content: string;
} {
  let parsed: any;
  try {
    parsed = JSON.parse(stripModelJson(raw));
    for (let depth = 0; typeof parsed === 'string' && depth < 2; depth += 1) {
      parsed = JSON.parse(parsed.trim());
    }
  } catch {
    throw new Error('V4 Writer 返回的不是合法 JSON。');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new Error('V4 Writer JSON 顶层必须是 object。');
  }
  if (
    parsed.schemaVersion !== undefined &&
    Number(parsed.schemaVersion) !== 1
  ) {
    throw new Error('V4 Writer JSON schemaVersion 只能是 1。');
  }
  const forbiddenField = ['pat', 'ches'].join('');
  if (
    Object.prototype.hasOwnProperty.call(parsed, forbiddenField) ||
    Object.prototype.hasOwnProperty.call(parsed, 'offset')
  ) {
    throw new Error('V4 Writer 不允许输出局部修改字段或 offset。');
  }
  const content = extractWriterContent(
    [
      parsed.content,
      parsed.chapterContent,
      parsed.chapter_content,
      parsed.finalText,
      parsed.final_content,
      parsed.text,
      parsed.draft,
      parsed.draftText,
      parsed.chapterText,
      parsed.storyText,
      parsed.novelText,
      parsed.article,
      parsed.story,
      parsed.output,
      parsed.answer,
      parsed.response,
      parsed['正文'],
      parsed['章节正文'],
      parsed.result,
      parsed.body,
      parsed.paragraphs,
    ],
  );
  if (!content) {
    const topLevelKeys = Object.keys(parsed).sort().slice(0, 20).join(', ');
    throw new Error(
      `V4 Writer JSON 缺少可用正文 content（顶层字段：${topLevelKeys || '（无）'}）。`,
    );
  }
  try {
    const nested = JSON.parse(content);
    if (nested && typeof nested === 'object') {
      throw new Error('V4 Writer content 不能再次包含 JSON 外壳。');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('不能再次包含')) {
      throw error;
    }
  }
  const planCandidate =
    parseWriterObjectValue(parsed.plan) ||
    parseWriterObjectValue(parsed.outline) ||
    parseWriterObjectValue(parsed.storyPlan) ||
    parseWriterObjectValue(parsed.writingPlan) ||
    parsed;
  const fallbackConflict = '围绕本章要求推进当前冲突并自然收束。';
  const fallbackBeat = '承接前文，推进当前冲突并形成自然章末。';
  const chapterGoal = firstWriterString(
    [
      planCandidate.chapterGoal,
      planCandidate.chapter_goal,
      parsed.chapterGoal,
      parsed.chapter_goal,
      parsed.goal,
      fallbackPlan.chapterGoal,
    ],
    '完成本章续写推进。',
  );
  const centralConflict = firstWriterString(
    [
      planCandidate.centralConflict,
      planCandidate.central_conflict,
      parsed.centralConflict,
      parsed.central_conflict,
      fallbackPlan.centralConflict,
    ],
    fallbackConflict,
  );
  const beats = normalizeWriterBeats(
    planCandidate.beats ?? parsed.beats,
    fallbackBeat,
  );
  const plan: ContinuationPlan = {
    schemaVersion: 1,
    chapterGoal,
    centralConflict,
    beats,
    participatingCharacterIds: [],
    characterActions: [],
    plotAdvances: [],
    foreshadowingActions: [],
    proposedStateChanges: [],
    risks: [],
  };
  return {
    envelope: {
      schemaVersion: 1,
      plan: {
        chapterGoal: plan.chapterGoal,
        centralConflict: plan.centralConflict,
        beats: plan.beats.map((beat, index) => ({
          id: `beat_${index + 1}`,
          summary: beat.summary,
        })),
      },
      content,
    },
    plan,
    content,
  };
}

export function parseContinuationV4RepairEnvelope(raw: string): ContinuationV4RepairEnvelope {
  let parsed: any;
  try {
    parsed = JSON.parse(stripModelJson(raw));
  } catch {
    throw new Error('V4 Repair 返回的不是合法 JSON。');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.content !== 'string' ||
    !parsed.content.trim() ||
    !Array.isArray(parsed.appliedCheckerIssueIds) ||
    !Array.isArray(parsed.appliedControlSuggestionIds) ||
    !Array.isArray(parsed.unappliedItems)
  ) {
    const topLevelKeys = Object.keys(parsed || {})
      .sort()
      .slice(0, 24)
      .join(', ');
    throw new Error(
      `V4 Repair JSON 缺少完整终稿 envelope（顶层字段：${topLevelKeys || '（无）'}）。`,
    );
  }
  const forbiddenField = ['pat', 'ches'].join('');
  if (Object.prototype.hasOwnProperty.call(parsed, forbiddenField)) {
    throw new Error('V4 Repair 不接受局部修改字段，必须返回完整终稿。');
  }
  const content = parsed.content.trim();
  try {
    const nested = JSON.parse(content);
    if (nested && typeof nested === 'object') {
      throw new Error('V4 Repair content 不能是 JSON 外壳。');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('不能是 JSON')) {
      throw error;
    }
  }
  return {
    schemaVersion: 1,
    content,
    appliedCheckerIssueIds: parsed.appliedCheckerIssueIds
      .filter((value: unknown) => typeof value === 'string')
      .map((value: string) => value.trim())
      .filter(Boolean),
    appliedControlSuggestionIds: parsed.appliedControlSuggestionIds
      .filter((value: unknown) => typeof value === 'string')
      .map((value: string) => value.trim())
      .filter(Boolean),
    unappliedItems: parsed.unappliedItems
      .filter((value: unknown) => typeof value === 'string')
      .map((value: string) => value.trim())
      .filter(Boolean),
  };
}

function isLocalGateSubtype(subtype: string): boolean {
  return (
    subtype.startsWith('chapter_length_') ||
    subtype === 'source_overlap' ||
    subtype === 'continuation_anchor_overlap' ||
    subtype === 'future_leakage' ||
    subtype === 'self_duplicate' ||
    subtype === 'repair_prompt_leakage' ||
    subtype === 'repair_envelope_leakage' ||
    subtype === 'repair_candidate_collapsed'
  );
}

function isCheckerForbiddenSubtype(subtype: string): boolean {
  return (
    subtype.startsWith('chapter_length_') ||
    subtype === 'source_overlap' ||
    subtype === 'continuation_anchor_overlap' ||
    subtype === 'future_leakage' ||
    subtype === 'self_duplicate'
  );
}

function hasActionableIssue(issues: Array<Pick<RawCheckIssue, 'severity'>>): boolean {
  return issues.some(
    issue => issue.severity === 'error' || issue.severity === 'blocking',
  );
}

function normalizedRepairComparisonText(text: string): string {
  return text.trim().replace(/\s+/g, '');
}

function repairComplianceIssue(input: {
  subtype: string;
  category: RawCheckIssue['category'];
  description: string;
  suggestedFix: string;
  evidenceIds?: number[];
}): RawCheckIssue {
  return {
    category: input.category,
    subtype: input.subtype,
    severity: 'blocking',
    confidence: 1,
    generatedStart: null,
    generatedEnd: null,
    generatedExcerpt: '',
    description: input.description,
    evidenceIds: input.evidenceIds ?? [],
    suggestedFix: input.suggestedFix,
  };
}

function hasCheckerAuditId(values: string[], issueId: string): boolean {
  // The plan's example uses chk_1 while the frozen Repair view renders the
  // persisted numeric id. Accept both spellings, but never accept an id that
  // is not present in this run's Checker report.
  return values.includes(issueId) || values.includes(`chk_${issueId}`);
}

/**
 * Deterministically verify that a successful Repair response actually claims
 * every actionable requirement and moves the text in Control's requested
 * direction. This is deliberately a conservative contract check, not a
 * second semantic Checker: the UI must still disclose that semantic quality
 * was not re-verified after Repair.
 */
export function validateContinuationV4RepairCompliance(input: {
  writerText: string;
  candidateText: string;
  checkerIssues: ContinuationCheckResult[];
  controlReport: ContinuationControlReport;
  envelope: ContinuationV4RepairEnvelope;
}): RawCheckIssue[] {
  const checks: RawCheckIssue[] = [];
  const allCheckerIds = new Set(
    input.checkerIssues.flatMap(issue => {
      const id = String(issue.id);
      return [id, `chk_${id}`];
    }),
  );
  const actionableCheckerIssues = input.checkerIssues.filter(issue =>
    hasActionableIssue([issue]),
  );

  for (const issue of actionableCheckerIssues) {
    const issueId = String(issue.id);
    if (!hasCheckerAuditId(input.envelope.appliedCheckerIssueIds, issueId)) {
      checks.push(
        repairComplianceIssue({
          category: issue.category,
          subtype: 'repair_checker_issue_unapplied',
          description: `Repair 未在 appliedCheckerIssueIds 中落实 Checker issue ${issueId}：${issue.description}`,
          suggestedFix: `必须修订完整终稿以处理 Checker issue ${issueId}，并保留完整事件链。`,
          evidenceIds: issue.evidenceIds,
        }),
      );
      continue;
    }

    // An evidence-backed issue must not be satisfied by merely echoing its
    // id. When the Checker supplied a sufficiently specific draft excerpt,
    // retaining that exact problematic excerpt is a deterministic indication
    // that the source text was not actually revised.
    const excerpt = issue.generatedExcerpt.trim();
    if (
      excerpt.length >= 4 &&
      input.writerText.includes(excerpt) &&
      input.candidateText.includes(excerpt)
    ) {
      checks.push(
        repairComplianceIssue({
          category: issue.category,
          subtype: 'repair_checker_issue_unchanged',
          description: `Repair 声称已落实 Checker issue ${issueId}，但问题原句仍完整存在于终稿：${excerpt.slice(0, 80)}`,
          suggestedFix: `不能只填写 issue ${issueId} 的审计 id；必须改写该问题原句并保持事实、状态和事件链一致。`,
          evidenceIds: issue.evidenceIds,
        }),
      );
    }
  }

  for (const appliedId of input.envelope.appliedCheckerIssueIds) {
    if (!allCheckerIds.has(appliedId)) {
      checks.push(
        repairComplianceIssue({
          category: 'plot',
          subtype: 'repair_unknown_checker_issue_id',
          description: `Repair 声明落实了当前 Checker 报告不存在的 issue ${appliedId}。`,
          suggestedFix: '只填写本次冻结 Checker 报告中实际存在的 issueId。',
        }),
      );
    }
  }

  for (const item of input.envelope.unappliedItems) {
    checks.push(
      repairComplianceIssue({
        category: 'plot',
        subtype: 'repair_unapplied_item',
        description: `Repair 明确声明未落实一项要求：${item.slice(0, 240)}`,
        suggestedFix: '本次 Repair 必须完成 Checker 与 Control 的可执行要求；不能把未落实项交给用户或下一轮自动修复。',
      }),
    );
  }

  const suggestionIds = new Set(
    input.controlReport.suggestions.map(suggestion => suggestion.suggestionId),
  );
  for (const suggestion of input.controlReport.suggestions) {
    if (!input.envelope.appliedControlSuggestionIds.includes(suggestion.suggestionId)) {
      checks.push(
        repairComplianceIssue({
          category: 'style',
          subtype: 'repair_control_suggestion_unapplied',
          description: `Repair 未在 appliedControlSuggestionIds 中落实 Control 建议 ${suggestion.suggestionId}：${suggestion.instruction}`,
          suggestedFix: `必须在完整终稿中落实 Control 建议 ${suggestion.suggestionId}，并保留其要求保护的事件节拍。`,
        }),
      );
    }
  }
  for (const appliedId of input.envelope.appliedControlSuggestionIds) {
    if (!suggestionIds.has(appliedId)) {
      checks.push(
        repairComplianceIssue({
          category: 'style',
          subtype: 'repair_unknown_control_suggestion_id',
          description: `Repair 声明落实了当前 Control 报告不存在的 suggestion ${appliedId}。`,
          suggestedFix: '只填写本次冻结 Control 报告中实际存在的 suggestionId。',
        }),
      );
    }
  }

  // Minimum substantial progress (Control compliance, NOT the final length
  // gate). The old check ("candidateHan > writerHan" for expand) let a Repair
  // that added a single character pass. The new rule requires either reaching
  // the legal band, or closing at least `requiredControlProgressHan` Han of the
  // gap. A candidate that meets this floor but still falls short of the legal
  // minimum still passes Control compliance; the remaining length gap stays a
  // soft warning in the Local Final Gate.
  const writerHan = countHanCharacters(input.writerText);
  const candidateHan = countHanCharacters(input.candidateText);
  if (input.controlReport.action === 'expand') {
    const reachedMin = candidateHan >= input.controlReport.allowedMinHan;
    const requiredDelta = Math.max(
      0,
      input.controlReport.allowedMinHan - writerHan,
    );
    const requiredProgress = requiredControlProgressHan(requiredDelta);
    const actualProgress = Math.max(0, candidateHan - writerHan);
    if (!reachedMin && actualProgress < requiredProgress) {
      checks.push(
        repairComplianceIssue({
          category: 'style',
          subtype: 'repair_control_insufficient_progress',
          description: `Control 要求扩写，但 Repair 终稿汉字数 ${candidateHan} 仅比 Writer 初稿 ${writerHan} 增加 ${actualProgress} 个，未达到最低实质进度 ${requiredProgress}（也未达到合法下限 ${input.controlReport.allowedMinHan}）。`,
          suggestedFix: `必须围绕当前事件链、人物反应和章末推进自然扩写，至少再净增加汉字直至达到最低实质进度 ${requiredProgress} 或合法下限 ${input.controlReport.allowedMinHan}。`,
        }),
      );
    }
  } else if (input.controlReport.action === 'compress') {
    const reachedMax = candidateHan <= input.controlReport.allowedMaxHan;
    const requiredDelta = Math.max(
      0,
      writerHan - input.controlReport.allowedMaxHan,
    );
    const requiredProgress = requiredControlProgressHan(requiredDelta);
    const actualProgress = Math.max(0, writerHan - candidateHan);
    if (!reachedMax && actualProgress < requiredProgress) {
      checks.push(
        repairComplianceIssue({
          category: 'style',
          subtype: 'repair_control_insufficient_progress',
          description: `Control 要求收束，但 Repair 终稿汉字数 ${candidateHan} 仅比 Writer 初稿 ${writerHan} 减少 ${actualProgress} 个，未达到最低实质进度 ${requiredProgress}（也未达到合法上限 ${input.controlReport.allowedMaxHan}）。`,
          suggestedFix: `必须在保留完整事件链和章末钩子的前提下实际压缩重复或不推进内容，至少再净减少汉字直至达到最低实质进度 ${requiredProgress} 或合法上限 ${input.controlReport.allowedMaxHan}。`,
        }),
      );
    }
  }

  return checks;
}

function localGateExtraIssues(
  writerText: string,
  candidateText: string,
  snapshot: ContinuationContextSnapshotV3,
): RawCheckIssue[] {
  const issues: RawCheckIssue[] = [];
  const candidateHan = countHanCharacters(candidateText);
  const writerHan = countHanCharacters(writerText);
  if (candidateHan === 0) {
    issues.push({
      category: 'style',
      subtype: 'repair_empty_content',
      severity: 'blocking',
      confidence: 1,
      generatedStart: null,
      generatedEnd: null,
      generatedExcerpt: '',
      description: 'Repair 终稿没有可采纳的汉字正文。',
      evidenceIds: [],
      suggestedFix: '返回覆盖完整事件链的非空终稿。',
    });
  }
  if (
    writerHan > 0 &&
    normalizedRepairComparisonText(candidateText) ===
      normalizedRepairComparisonText(writerText)
  ) {
    issues.push({
      category: 'style',
      subtype: 'repair_candidate_unchanged',
      severity: 'blocking',
      confidence: 1,
      generatedStart: null,
      generatedEnd: null,
      generatedExcerpt: '',
      description: 'Repair 终稿与 Writer 初稿完全相同，没有执行任何综合修订。',
      evidenceIds: [],
      suggestedFix: '必须根据 Checker/Control 报告输出真正修订后的完整终稿。',
    });
  }
  if (writerHan > 0 && candidateHan * 2 < writerHan) {
    issues.push({
      category: 'style',
      subtype: 'repair_candidate_collapsed',
      severity: 'blocking',
      confidence: 1,
      generatedStart: null,
      generatedEnd: null,
      generatedExcerpt: '',
      description: 'Repair 终稿相对 Writer 初稿明显坍缩，疑似摘要化或丢失事件链。',
      evidenceIds: [],
      suggestedFix: '保留 Writer 的完整事件链、人物互动和章末推进后重新输出完整终稿。',
    });
  }
  const trimmed = candidateText.trim();
  if (/^\s*\{[\s\S]*\}\s*$/.test(trimmed) || /```(?:json|text)?/i.test(trimmed)) {
    issues.push({
      category: 'style',
      subtype: 'repair_envelope_leakage',
      severity: 'blocking',
      confidence: 1,
      generatedStart: 0,
      generatedEnd: Math.min(candidateText.length, trimmed.length),
      generatedExcerpt: trimmed.slice(0, 80),
      description: '终稿正文仍包含 JSON/代码围栏外壳。',
      evidenceIds: [],
      suggestedFix: '只保留完整小说正文，不要输出 JSON 外壳或代码围栏。',
    });
  }
  if (
    /<think>|<analysis>|思考过程|修改说明|以下是终稿|appliedCheckerIssueIds|writerArtifactHash/i.test(
      candidateText,
    )
  ) {
    issues.push({
      category: 'style',
      subtype: 'repair_prompt_leakage',
      severity: 'blocking',
      confidence: 1,
      generatedStart: null,
      generatedEnd: null,
      generatedExcerpt: '',
      description: '终稿包含模型思考、提示协议或修改说明。',
      evidenceIds: [],
      suggestedFix: '删除提示协议、思考过程和修改说明，只输出小说正文。',
    });
  }
  const candidateMetrics = buildContinuationControlMetrics({
    text: candidateText,
    target: snapshot.settingsSnapshot.values.targetChapterChars,
  });
  if (candidateMetrics.duplicateWindows.length > 0) {
    issues.push({
      category: 'style',
      subtype: 'self_duplicate',
      severity: 'error',
      confidence: 1,
      generatedStart: candidateMetrics.duplicateWindows[0].start,
      generatedEnd: candidateMetrics.duplicateWindows[0].end,
      generatedExcerpt: candidateText.slice(
        candidateMetrics.duplicateWindows[0].start,
        candidateMetrics.duplicateWindows[0].end,
      ),
      description: '终稿内部存在重复段落，疑似自重复退化。',
      evidenceIds: [],
      suggestedFix: '删除重复段落并保持完整事件链。',
    });
  }
  return issues;
}

/** Public for tests and the result UI's non-network diagnostics. */
export function runContinuationV4LocalFinalGate(input: {
  writerText: string;
  candidateText: string;
  snapshot: ContinuationContextSnapshotV3;
  controlMetrics: ContinuationV4Metrics;
}): {
  passed: boolean;
  checks: RawCheckIssue[];
  candidateMetrics: ContinuationV4Metrics;
} {
  const base = filterBySettings(
    runDeterministicChecks(
      input.candidateText,
      input.snapshot as unknown as import('./types').ContinuationContextSnapshot,
    ),
    input.snapshot.settingsSnapshot.values,
  );
  const checks = softenFinalGateLengthChecks([
    ...base,
    ...localGateExtraIssues(
      input.writerText,
      input.candidateText,
      input.snapshot,
    ),
  ]);
  return {
    passed: !checks.some(
      issue => issue.severity === 'error' || issue.severity === 'blocking',
    ),
    checks,
    candidateMetrics: buildContinuationControlMetrics({
      text: input.candidateText,
      target: input.snapshot.settingsSnapshot.values.targetChapterChars,
    }),
  };
}

/**
 * The Local Final Gate is the zero-request safety gate for the selected
 * Repair candidate. Chapter length is still evaluated locally and remains a
 * Repair trigger, but it is advisory at this final adoption point: a Repair
 * that fixes Checker/Control issues can be better than the Writer even when
 * the frozen length interval is not fully reached. Safety, non-empty output,
 * actual revision, and Control direction remain hard requirements.
 */
function softenFinalGateLengthChecks(checks: RawCheckIssue[]): RawCheckIssue[] {
  return checks.map(check => {
    if (!check.subtype.startsWith('chapter_length_')) return check;
    return {
      ...check,
      severity: 'warning',
      suggestedFix: `${check.suggestedFix} 篇幅仅作提示，不阻断 Repair 采纳；仍需满足 Control 的修订方向和本地安全检查。`,
    };
  });
}

function stageBudget(
  snapshot: ContinuationContextSnapshotV3,
  stage: V4PhysicalStage,
): ContinuationV4StageBudgets[V4PhysicalStage] {
  const budget = snapshot.stageBudgets[stage];
  if (!budget) throw new ContinuationCapabilityBlockedError(`缺少 ${stage} 冻结预算。`);
  return budget;
}

function stageModelFromSnapshot(
  snapshot: ContinuationContextSnapshotV3,
): V4StageModels {
  const frozen = snapshot.settingsSnapshot.frozenModelConfigs;
  if (!frozen?.writer || !frozen.checker || !frozen.control || !frozen.repair) {
    throw new ContinuationCapabilityBlockedError('V4 run 缺少冻结的四节点模型能力。');
  }
  return {
    writer: {
      configId: frozen.writer.configId,
      contextWindow: frozen.writer.contextWindow,
      maxOutputTokens: frozen.writer.maxOutputTokens,
    },
    checker: {
      configId: frozen.checker.configId,
      contextWindow: frozen.checker.contextWindow,
      maxOutputTokens: frozen.checker.maxOutputTokens,
    },
    control: {
      configId: frozen.control.configId,
      contextWindow: frozen.control.contextWindow,
      maxOutputTokens: frozen.control.maxOutputTokens,
    },
    repair: {
      configId: frozen.repair.configId,
      contextWindow: frozen.repair.contextWindow,
      maxOutputTokens: frozen.repair.maxOutputTokens,
    },
  };
}

function actualV4SnapshotAfterWriter(input: {
  snapshot: ContinuationContextSnapshotV3;
  trace: ContinuationContextTrace;
  artifactText: string;
  plan: ContinuationPlan;
}): { snapshot: ContinuationContextSnapshotV3; trace: ContinuationContextTrace; metrics: ContinuationV4Metrics } {
  const metrics = buildContinuationControlMetrics({
    text: input.artifactText,
    target: input.snapshot.settingsSnapshot.values.targetChapterChars,
    plan: input.plan,
  });
  const models = stageModelFromSnapshot(input.snapshot);
  const protocolSkeletonTokens = {
    writer: continuationV4ProtocolSkeletonTokens('writer'),
    checker: continuationV4ProtocolSkeletonTokens('checker'),
    control: continuationV4ProtocolSkeletonTokens('control'),
    repair: continuationV4ProtocolSkeletonTokens('repair'),
  };
  const fallback = buildContinuationControlFallback(metrics);
  const initialViews = buildContinuationV4StageViews({
    snapshot: input.snapshot,
    stageBudgets: input.snapshot.stageBudgets,
  });
  const promptTokens = {
    writer: estimateMessagesTokens(
      compileContinuationV4WriterMessages(initialViews.writer),
    ),
    checker: estimateMessagesTokens(
      compileContinuationV4CheckerMessages({
        view: initialViews.checker,
        artifactText: input.artifactText,
        writerArtifactHash: contentRevisionHash(input.artifactText),
        plan: input.plan,
      }),
    ),
    control: estimateMessagesTokens(
      compileContinuationV4ControlMessages({
        view: initialViews.control,
        artifactText: input.artifactText,
        metrics,
        plan: input.plan,
      }),
    ),
    repair: estimateMessagesTokens(
      compileContinuationV4RepairMessages({
        view: initialViews.repair,
        artifactText: input.artifactText,
        plan: input.plan,
        checkerReport: { issues: [] },
        controlReport: fallback,
      }),
    ),
  };
  const resolve = (compiled: typeof promptTokens) =>
    resolveContinuationV4BudgetPreview({
      frozenPolicy: input.snapshot.budgetPolicy.policy,
      stages: models,
      targetChapterChars: input.snapshot.settingsSnapshot.values.targetChapterChars,
      writerDraftTokens: estimateTokens(input.artifactText),
      paragraphCount: metrics.paragraphs.length,
      compiledPromptTokens: compiled,
      protocolSkeletonTokens,
      hardContextTokens: {
        writer: input.snapshot.stageBudgets.writer.hardContextTokens,
        checker: input.snapshot.stageBudgets.checker.hardContextTokens,
        control: input.snapshot.stageBudgets.control.hardContextTokens,
        repair: input.snapshot.stageBudgets.repair.hardContextTokens,
      },
    }).stages;
  const firstBudgets = resolve(promptTokens);
  const secondViews = buildContinuationV4StageViews({
    snapshot: input.snapshot,
    stageBudgets: firstBudgets,
  });
  const secondPromptTokens = {
    writer: estimateMessagesTokens(
      compileContinuationV4WriterMessages(secondViews.writer),
    ),
    checker: estimateMessagesTokens(
      compileContinuationV4CheckerMessages({
        view: secondViews.checker,
        artifactText: input.artifactText,
        writerArtifactHash: contentRevisionHash(input.artifactText),
        plan: input.plan,
      }),
    ),
    control: estimateMessagesTokens(
      compileContinuationV4ControlMessages({
        view: secondViews.control,
        artifactText: input.artifactText,
        metrics,
        plan: input.plan,
      }),
    ),
    repair: estimateMessagesTokens(
      compileContinuationV4RepairMessages({
        view: secondViews.repair,
        artifactText: input.artifactText,
        plan: input.plan,
        checkerReport: { issues: [] },
        controlReport: fallback,
      }),
    ),
  };
  const budgets = resolve(secondPromptTokens);
  const views = buildContinuationV4StageViews({
    snapshot: input.snapshot,
    stageBudgets: budgets,
  });
  const snapshot: ContinuationContextSnapshotV3 = {
    ...input.snapshot,
    stageBudgets: budgets,
    stageViews: views,
  };
  const trace: ContinuationContextTrace = {
    ...input.trace,
    v4StageBudgets: budgets,
    v4StageViewHashes: {
      writer: hashContinuationV4StageView(views.writer),
      checker: hashContinuationV4StageView(views.checker),
      control: hashContinuationV4StageView(views.control),
      repair: hashContinuationV4StageView(views.repair),
    },
  };
  return { snapshot, trace, metrics };
}

async function setRunStage(runId: string, stage: 'writer' | 'auditing' | 'repair' | 'local_verify'): Promise<void> {
  const changed = await casUpdateRunState(runId, ['running'], {
    state: 'running',
    stage,
  });
  if (!changed) throw new Error('续写运行状态已改变，停止继续请求。');
}

async function updateTelemetry(runId: string): Promise<void> {
  const stageResults = await listStageResults(runId);
  const physicalRequestCount = stageResults.reduce(
    (sum, result) => sum + result.requestCount,
    0,
  );
  const stages = Object.fromEntries(
    stageResults.map(result => [
      result.stage,
      {
        status: result.status,
        requestReserved: result.requestReserved,
        requestCount: result.requestCount,
        modelConfigId: result.modelConfigId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        minOutputTokens: result.minOutputTokens,
        maxOutputTokens: result.maxOutputTokens,
        errorCode: result.errorCode,
      },
    ]),
  );
  await casUpdateRunState(runId, ['running', 'awaiting_user', 'interrupted'], {
    tokenUsageJson: JSON.stringify({
      workflowVersion: 4,
      maxPhysicalRequests: 4,
      physicalRequestCount,
      stages,
    }),
  });
}

async function markStageFailed(input: {
  runId: string;
  stage: ContinuationV4StageName;
  errorCode: string;
  errorMessage: string;
  outputJson?: string | null;
}): Promise<void> {
  await updateStageResult({
    runId: input.runId,
    stage: input.stage,
    status: 'failed',
    outputJson: input.outputJson ?? null,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
  });
}

async function markStageInterruptedIfPending(
  runId: string,
  stage: ContinuationV4StageName,
): Promise<void> {
  const current = await getStageResult(runId, stage).catch(() => null);
  if (
    !current ||
    (current.status !== 'queued' && current.status !== 'running')
  ) {
    return;
  }
  await updateStageResult({
    runId,
    stage,
    status: 'interrupted',
    outputJson: current.outputJson,
    artifactId: current.artifactId,
    errorCode: 'cancelled',
    errorMessage: '用户取消，reservation 不会自动重发。',
  });
}

async function markStageSkipped(
  runId: string,
  stage: ContinuationV4StageName,
  reason: string,
  artifactId: string | null = null,
): Promise<void> {
  await updateStageResult({
    runId,
    stage,
    status: 'skipped',
    outputJson: JSON.stringify({ schemaVersion: 1, reason }),
    artifactId,
    errorCode: reason,
    errorMessage: reason,
  });
}

async function invokeV4Stage(input: {
  options: V4PipelineOptions;
  runId: string;
  stage: V4PhysicalStage;
  messages: ChatMessage[];
  budget: ContinuationV4StageBudgets[V4PhysicalStage];
  frozenModelConfig: FrozenContinuationModelConfig;
}): Promise<StageLlmCallResult> {
  assertNotAborted(input.options.signal);
  const callInput = {
    stage: input.stage,
    messages: input.messages,
    maxTokens: input.budget.maximumOutputTokens,
    configId: input.budget.configId,
    // The V4 protocol asks for JSON in the prompt, but deliberately uses the
    // text transport. The OpenAI-compatible provider may issue a second
    // physical request when `response_format=json_object` is rejected; that
    // fallback would violate V4's four-request hard cap.
    responseFormat: 'text' as const,
  };
  if (input.options.callStage) return input.options.callStage(callInput);
  return defaultV4StageCaller({
    ...callInput,
    signal: input.options.signal,
    projectId: input.options.projectId,
    runId: input.runId,
    frozenModelConfig: input.frozenModelConfig,
  });
}

async function reservePhysicalStage(input: {
  runId: string;
  stage: V4PhysicalStage;
  messages: ChatMessage[];
  budget: ContinuationV4StageBudgets[V4PhysicalStage];
}): Promise<ContinuationGenerationStageResult> {
  if (
    input.budget.blockedReason ||
    input.budget.maximumOutputTokens < input.budget.minimumOutputTokens ||
    input.budget.maximumOutputTokens <= 0
  ) {
    const reason =
      input.budget.blockedReason ||
      `${input.stage} 阶段没有可用的动态输出预算。`;
    await markStageFailed({
      runId: input.runId,
      stage: input.stage,
      errorCode: 'continuation_budget_blocked',
      errorMessage: reason,
    });
    throw new ContinuationCapabilityBlockedError(reason);
  }
  const current = await listStageResults(input.runId);
  const physicalCount = current.reduce(
    (sum, result) => sum + result.requestCount,
    0,
  );
  const existing = current.find(result => result.stage === input.stage);
  if (!existing && physicalCount >= 4) {
    throw new Error('V4 物理请求上限已用尽，禁止产生第 5 次请求。');
  }
  const reservation = await reserveContinuationStage({
    runId: input.runId,
    stage: input.stage,
    modelConfigId: input.budget.configId,
    inputTokens: estimateMessagesTokens(input.messages),
    minOutputTokens: input.budget.minimumOutputTokens,
    maxOutputTokens: input.budget.maximumOutputTokens,
  });
  return reservation.result;
}

async function ensureWriterLocalChecks(
  run: ContinuationGenerationRun,
  snapshot: ContinuationContextSnapshotV3,
  artifact: ContinuationArtifact,
): Promise<ContinuationCheckResult[]> {
  const existing = await listChecksForArtifact(run.id, artifact.id);
  if (existing.length > 0) return existing;
  const raw = filterBySettings(
    runDeterministicChecks(
      artifact.content,
      snapshot as unknown as import('./types').ContinuationContextSnapshot,
    ),
    snapshot.settingsSnapshot.values,
  );
  await insertCheckResults(
    raw.map(issue => ({
      runId: run.id,
      chapterId: run.chapterId,
      artifactId: artifact.id,
      artifactHash: artifact.contentHash,
      ...issue,
    })),
  );
  return listChecksForArtifact(run.id, artifact.id);
}

async function runWriterNode(
  run: ContinuationGenerationRun,
  snapshot: ContinuationContextSnapshotV3,
  options: V4PipelineOptions,
): Promise<V4WriterResult | null> {
  const stage = await getStageResult(run.id, 'writer');
  const existingArtifact = await getLatestArtifactForStage(run.id, 'writer');
  if (existingArtifact) {
    const planRow = await getPlan(run.id);
    if (!planRow) throw new Error('Writer artifact 已存在但缺少 plan。');
    if (!stage || stage.status !== 'success' || stage.artifactId !== existingArtifact.id) {
      await updateStageResult({
        runId: run.id,
        stage: 'writer',
        status: 'success',
        outputJson: JSON.stringify({
          schemaVersion: 1,
          contentHash: existingArtifact.contentHash,
          recovered: true,
        }),
        artifactId: existingArtifact.id,
        outputTokens: stage?.outputTokens ?? null,
      });
    }
    await ensureWriterLocalChecks(run, snapshot, existingArtifact);
    return { artifact: existingArtifact, plan: planRow.plan };
  }
  if (
    stage &&
    (stage.requestReserved || stage.requestCount > 0 ||
      stage.status === 'failed' ||
      stage.status === 'interrupted')
  ) {
    return null;
  }
  const messages = compileContinuationV4WriterMessages(snapshot.stageViews.writer);
  const reserved = await reservePhysicalStage({
    runId: run.id,
    stage: 'writer',
    messages,
    budget: stageBudget(snapshot, 'writer'),
  });
  if (!reserved.requestReserved || reserved.requestCount !== 1) return null;
  try {
    const frozen = snapshot.settingsSnapshot.frozenModelConfigs?.writer;
    if (!frozen) throw new ContinuationCapabilityBlockedError('缺少 Writer 冻结模型。');
    const result = await invokeV4Stage({
      options,
      runId: run.id,
      stage: 'writer',
      messages,
      budget: stageBudget(snapshot, 'writer'),
      frozenModelConfig: frozen,
    });
    assertNotAborted(options.signal);
    const parsed = parseContinuationV4WriterEnvelope(result.text, {
      chapterGoal: snapshot.stageViews.writer.userInstruction,
      centralConflict: '围绕本章要求推进当前冲突并自然收束。',
    });
    const planHash = await savePlan(run.id, parsed.plan, 'not_required');
    const artifact = await insertArtifact({
      runId: run.id,
      stage: 'writer',
      content: parsed.content,
      repairRound: 0,
      parentArtifactId: null,
      eligibilityStatus: 'eligible',
    });
    await updateStageResult({
      runId: run.id,
      stage: 'writer',
      status: 'success',
      outputJson: JSON.stringify({
        schemaVersion: 1,
        planHash: planHash.planHash,
        contentHash: artifact.contentHash,
      }),
      artifactId: artifact.id,
      outputTokens: result.usage?.completion ?? null,
    });
    await ensureWriterLocalChecks(run, snapshot, artifact);
    return { artifact, plan: parsed.plan };
  } catch (error: any) {
    if (options.signal.aborted) {
      await markStageInterruptedIfPending(run.id, 'writer');
      throw error;
    }
    await markStageFailed({
      runId: run.id,
      stage: 'writer',
      errorCode: error?.code || 'writer_failed',
      errorMessage: error?.message || 'Writer 未能生成完整初稿。',
    });
    throw error;
  }
}

/**
 * Stable fingerprint for matching a parsed Checker issue back to its persisted
 * check row. The historical matcher only used subtype+description+excerpt,
 * which both over-matched unrelated rows sharing the same subtype and
 * under-matched when the model trimmed the excerpt. This fingerprint adds
 * category, severity, range, sorted evidence and suggestedFix so a persisted
 * check row is reliably attributable to the LLM issue that produced it (and so
 * Repair receives a stable persisted check id).
 */
function checkerIssueFingerprint(issue: {
  category: string;
  subtype: string;
  severity: string;
  generatedStart: number | null;
  generatedEnd: number | null;
  generatedExcerpt: string;
  description: string;
  evidenceIds?: number[] | null;
  suggestedFix?: string | null;
}): string {
  const evidence = Array.isArray(issue.evidenceIds)
    ? [...issue.evidenceIds].sort((a, b) => a - b).join(',')
    : '';
  return [
    issue.category,
    issue.subtype,
    issue.severity,
    issue.generatedStart == null ? '' : String(issue.generatedStart),
    issue.generatedEnd == null ? '' : String(issue.generatedEnd),
    issue.generatedExcerpt.trim(),
    issue.description.trim(),
    evidence,
    (issue.suggestedFix ?? '').trim(),
  ].join('|');
}

function persistedCheckerIssues(
  checks: ContinuationCheckResult[],
  issues: RawCheckIssue[],
): ContinuationCheckResult[] {
  const keys = new Set(issues.map(issue => checkerIssueFingerprint(issue)));
  return checks.filter(check => keys.has(checkerIssueFingerprint(check)));
}

/** Dedupe persisted check rows by id so Checker issues and local safety issues
 * that resolved to the same row are not tracked twice by Repair compliance. */
function dedupeRepairIssues(
  issues: ContinuationCheckResult[],
): ContinuationCheckResult[] {
  const seen = new Set<number>();
  const out: ContinuationCheckResult[] = [];
  for (const issue of issues) {
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    out.push(issue);
  }
  return out;
}

async function runCheckerNode(input: {
  run: ContinuationGenerationRun;
  snapshot: ContinuationContextSnapshotV3;
  plan: ContinuationPlan;
  artifact: ContinuationArtifact;
  options: V4PipelineOptions;
}): Promise<V4CheckerOutcome> {
  const { run, snapshot, plan, artifact, options } = input;
  const stage = await getStageResult(run.id, 'checker');
  if (stage?.status === 'success' && stage.outputJson) {
    const stored = JSON.parse(stage.outputJson) as { issues?: RawCheckIssue[] };
    const issues = Array.isArray(stored.issues) ? stored.issues : [];
    const checks = await listChecksForArtifact(run.id, artifact.id);
    return { issues, persistedIssues: persistedCheckerIssues(checks, issues) };
  }
  if (
    stage &&
    (stage.requestReserved || stage.requestCount > 0 ||
      stage.status === 'failed' ||
      stage.status === 'interrupted' ||
      stage.status === 'skipped')
  ) {
    throw new Error(stage.errorMessage || 'Checker 已 reservation 但没有可恢复结果。');
  }
  if (options.deterministicOnly) {
    await markStageSkipped(run.id, 'checker', 'deterministic_only');
    throw new Error('Checker 在 deterministicOnly 模式下未执行。');
  }
  const messages = compileContinuationV4CheckerMessages({
    view: snapshot.stageViews.checker,
    artifactText: artifact.content,
    writerArtifactHash: artifact.contentHash,
    plan,
  });
  const reserved = await reservePhysicalStage({
    runId: run.id,
    stage: 'checker',
    messages,
    budget: stageBudget(snapshot, 'checker'),
  });
  if (!reserved.requestReserved || reserved.requestCount !== 1) {
    throw new Error('Checker reservation 已被其他恢复流程占用。');
  }
  try {
    const frozen = snapshot.settingsSnapshot.frozenModelConfigs?.checker;
    if (!frozen) throw new ContinuationCapabilityBlockedError('缺少 Checker 冻结模型。');
    const result = await invokeV4Stage({
      options,
      runId: run.id,
      stage: 'checker',
      messages,
      budget: stageBudget(snapshot, 'checker'),
      frozenModelConfig: frozen,
    });
    assertNotAborted(options.signal);
    const envelope = parseCheckerLlmEnvelope(result.text);
    const echoedHash = envelope.writerArtifactHash;
    // Artifact hash binding: the Checker's issues are only attributable to the
    // current Writer artifact when the model echoes the exact contentHash we
    // asked it to review. A missing or mismatched hash means the LLM issues
    // cannot be reliably bound — they may reference a stale or hallucinated
    // draft. Drop them, record a precise error code, but never retry: Control
    // and the local safety checks can still drive Repair.
    const hashMatches = echoedHash === artifact.contentHash;
    let hashErrorCode: string | null = null;
    if (echoedHash == null) {
      hashErrorCode = 'checker_artifact_hash_missing';
    } else if (!hashMatches) {
      hashErrorCode = 'checker_artifact_hash_mismatch';
    }
    const parsed = hashMatches
      ? envelope.issues.filter(
          issue => !isCheckerForbiddenSubtype(issue.subtype),
        )
      : [];
    const bound = hashMatches
      ? bindIssuesToArtifact(
          parsed,
          artifact.content,
          new Set(snapshot.bundles.canon.evidenceRefs),
        )
      : [];
    if (bound.length > 0) {
      await insertCheckResults(
        bound.map(issue => ({
          runId: run.id,
          chapterId: run.chapterId,
          artifactId: artifact.id,
          artifactHash: artifact.contentHash,
          ...issue,
        })),
      );
    }
    await updateStageResult({
      runId: run.id,
      stage: 'checker',
      status: 'success',
      outputJson: JSON.stringify({
        schemaVersion: 1,
        writerArtifactHash: artifact.contentHash,
        echoedWriterArtifactHash: echoedHash,
        checkerArtifactsBound: hashMatches,
        checkerArtifactErrorCode: hashErrorCode,
        issues: bound,
      }),
      artifactId: artifact.id,
      outputTokens: result.usage?.completion ?? null,
      errorCode: hashErrorCode,
      errorMessage: hashErrorCode
        ? `Checker 回显的 writerArtifactHash 与当前 Writer artifact 不一致（${echoedHash == null ? '缺失' : '不匹配'}），已丢弃本次 LLM issues；本地安全检查与 Control 仍可驱动 Repair。`
        : null,
    });
    const checks = await listChecksForArtifact(run.id, artifact.id);
    return {
      issues: bound,
      persistedIssues: persistedCheckerIssues(checks, bound),
    };
  } catch (error: any) {
    if (options.signal.aborted) {
      await markStageInterruptedIfPending(run.id, 'checker');
      throw error;
    }
    await markStageFailed({
      runId: run.id,
      stage: 'checker',
      errorCode: error?.code || 'checker_failed',
      errorMessage: error?.message || 'Checker 未能完成语义审查。',
    });
    throw error;
  }
}

async function runControlNode(input: {
  run: ContinuationGenerationRun;
  snapshot: ContinuationContextSnapshotV3;
  plan: ContinuationPlan;
  artifact: ContinuationArtifact;
  metrics: ContinuationV4Metrics;
  options: V4PipelineOptions;
}): Promise<V4ControlOutcome> {
  const { run, snapshot, plan, artifact, metrics, options } = input;
  const fallback = buildContinuationControlFallback(metrics);
  const stage = await getStageResult(run.id, 'control');
  if (stage?.status === 'success' && stage.outputJson) {
    const resolved = resolveContinuationControlReport({
      metrics,
      raw: stage.outputJson,
    });
    return {
      metrics,
      report: resolved.report,
      degraded: resolved.errorCode != null,
      errorCode: resolved.errorCode,
    };
  }
  if (stage?.status === 'failed' && stage.outputJson) {
    let report = fallback;
    try {
      report = resolveContinuationControlReport({
        metrics,
        raw: stage.outputJson,
      }).report;
    } catch {
      report = fallback;
    }
    return {
      metrics,
      report,
      degraded: true,
      errorCode: stage.errorCode || 'control_llm_unavailable',
    };
  }
  if (
    stage &&
    (stage.requestReserved || stage.requestCount > 0 ||
      stage.status === 'failed' ||
      stage.status === 'interrupted' ||
      stage.status === 'skipped')
  ) {
    return {
      metrics,
      report: fallback,
      degraded: true,
      errorCode: stage.errorCode || 'control_result_unavailable',
    };
  }
  if (options.deterministicOnly) {
    await markStageSkipped(run.id, 'control', 'deterministic_only');
    return {
      metrics,
      report: fallback,
      degraded: true,
      errorCode: 'control_llm_unavailable',
    };
  }
  const messages = compileContinuationV4ControlMessages({
    view: snapshot.stageViews.control,
    artifactText: artifact.content,
    metrics,
    plan,
  });
  const reserved = await reservePhysicalStage({
    runId: run.id,
    stage: 'control',
    messages,
    budget: stageBudget(snapshot, 'control'),
  });
  if (!reserved.requestReserved || reserved.requestCount !== 1) {
    return {
      metrics,
      report: fallback,
      degraded: true,
      errorCode: 'control_reservation_unavailable',
    };
  }
  try {
    const frozen = snapshot.settingsSnapshot.frozenModelConfigs?.control;
    if (!frozen) throw new ContinuationCapabilityBlockedError('缺少 Control 冻结模型。');
    const result = await invokeV4Stage({
      options,
      runId: run.id,
      stage: 'control',
      messages,
      budget: stageBudget(snapshot, 'control'),
      frozenModelConfig: frozen,
    });
    assertNotAborted(options.signal);
    const resolved = resolveContinuationControlReport({
      metrics,
      raw: result.text,
    });
    const degraded = resolved.errorCode != null;
    await updateStageResult({
      runId: run.id,
      stage: 'control',
      status: degraded ? 'failed' : 'success',
      outputJson: JSON.stringify(resolved.report),
      artifactId: artifact.id,
      outputTokens: result.usage?.completion ?? null,
      errorCode: resolved.errorCode,
      errorMessage: resolved.errorCode
        ? 'Control LLM 输出不可用，已使用本地确定性 fallback。'
        : null,
    });
    return {
      metrics,
      report: resolved.report,
      degraded,
      errorCode: resolved.errorCode,
    };
  } catch (error: any) {
    if (options.signal.aborted) {
      await markStageInterruptedIfPending(run.id, 'control');
      throw error;
    }
    await markStageFailed({
      runId: run.id,
      stage: 'control',
      errorCode: error?.code || 'control_failed',
      errorMessage: error?.message || 'Control LLM 未能完成篇幅建议，已保留本地指标。',
      outputJson: JSON.stringify(fallback),
    });
    return {
      metrics,
      report: fallback,
      degraded: true,
      errorCode: error?.code || 'control_failed',
    };
  }
}

async function settleWithoutRepair(input: {
  run: ContinuationGenerationRun;
  artifact: ContinuationArtifact;
  reason: string;
  localVerifyPassed: boolean;
  localChecks?: RawCheckIssue[];
}): Promise<void> {
  await markStageSkipped(input.run.id, 'repair', input.reason);
  await updateStageResult({
    runId: input.run.id,
    stage: 'local_verify',
    status: input.localVerifyPassed ? 'success' : 'failed',
    outputJson: JSON.stringify({
      schemaVersion: 1,
      passed: input.localVerifyPassed,
      reason: input.reason,
      checkSubtypes: (input.localChecks ?? []).map(check => check.subtype),
    }),
    artifactId: input.artifact.id,
    errorCode: input.localVerifyPassed ? null : 'local_gate_failed',
    errorMessage: input.localVerifyPassed ? null : 'Writer 保留为可采纳候选，但本地门禁仍有问题。',
  });
  await casUpdateRunState(input.run.id, ['running'], {
    state: 'awaiting_user',
    stage: 'awaiting_user',
  });
  await updateTelemetry(input.run.id);
}

async function runRepairNode(input: {
  run: ContinuationGenerationRun;
  snapshot: ContinuationContextSnapshotV3;
  plan: ContinuationPlan;
  writerArtifact: ContinuationArtifact;
  checkerIssues: ContinuationCheckResult[];
  control: V4ControlOutcome;
  options: V4PipelineOptions;
}): Promise<V4RepairOutcome> {
  const {
    run,
    snapshot,
    plan,
    writerArtifact,
    checkerIssues,
    control,
    options,
  } = input;
  const stage = await getStageResult(run.id, 'repair');
  const existingArtifact = await getLatestArtifactForStage(run.id, 'repair');
  if (existingArtifact && stage?.status === 'success') {
    return { artifact: existingArtifact, completed: false };
  }
  if (
    stage &&
    (stage.requestReserved || stage.requestCount > 0 ||
      stage.status === 'failed' ||
      stage.status === 'interrupted')
  ) {
    await markStageFailed({
      runId: run.id,
      stage: 'repair',
      errorCode: stage.errorCode || 'repair_reserved_no_result',
      errorMessage: stage.errorMessage || 'Repair 已 reservation 但没有完整终稿，禁止重发。',
    });
    await settleWithoutRepair({
      run,
      artifact: writerArtifact,
      reason: 'repair_reserved_no_result',
      localVerifyPassed: false,
      localChecks: [],
    });
    return { artifact: null, completed: false };
  }
  const messages = compileContinuationV4RepairMessages({
    view: snapshot.stageViews.repair,
    artifactText: writerArtifact.content,
    plan,
    checkerReport: { issues: checkerIssues },
    controlReport: control.report,
  });
  const reserved = await reservePhysicalStage({
    runId: run.id,
    stage: 'repair',
    messages,
    budget: stageBudget(snapshot, 'repair'),
  });
  if (!reserved.requestReserved || reserved.requestCount !== 1) {
    await settleWithoutRepair({
      run,
      artifact: writerArtifact,
      reason: 'repair_reservation_unavailable',
      localVerifyPassed: false,
      localChecks: [],
    });
    return { artifact: null, completed: false };
  }
  try {
    const frozen = snapshot.settingsSnapshot.frozenModelConfigs?.repair;
    if (!frozen) throw new ContinuationCapabilityBlockedError('缺少 Repair 冻结模型。');
    const result = await invokeV4Stage({
      options,
      runId: run.id,
      stage: 'repair',
      messages,
      budget: stageBudget(snapshot, 'repair'),
      frozenModelConfig: frozen,
    });
    assertNotAborted(options.signal);
    const envelope = parseContinuationV4RepairEnvelope(result.text);
    const localVerifyStage = await getStageResult(run.id, 'local_verify');
    if (!localVerifyStage) throw new Error('缺少 local_verify stage result。');
    const gate = runContinuationV4LocalFinalGate({
      writerText: writerArtifact.content,
      candidateText: envelope.content,
      snapshot,
      controlMetrics: control.metrics,
    });
    const complianceChecks = validateContinuationV4RepairCompliance({
      writerText: writerArtifact.content,
      candidateText: envelope.content,
      checkerIssues,
      controlReport: control.report,
      envelope,
    });
    const localChecks = [...gate.checks, ...complianceChecks];
    const repairPassed = gate.passed && complianceChecks.length === 0;
    const candidateHash = contentRevisionHash(envelope.content);
    const noMeaningfulChange =
      normalizedRepairComparisonText(envelope.content) ===
      normalizedRepairComparisonText(writerArtifact.content);
    // Telemetry: distinguish how many tasks were INJECTED vs how many Repair
    // CLAIMED to apply, plus the Control progress numbers. Stored in the
    // existing outputJson columns; no DB migration. The UI reads these to show
    // "注入 N 项，Repair 声明应用 M 项" instead of only the applied count.
    const injectedCheckerIssueCount = checkerIssues.filter(issue =>
      hasActionableIssue([issue]),
    ).length;
    const appliedCheckerIssueCount = envelope.appliedCheckerIssueIds.length;
    const injectedControlSuggestionCount =
      control.report.suggestions.length;
    const appliedControlSuggestionCount =
      envelope.appliedControlSuggestionIds.length;
    const writerHan = countHanCharacters(writerArtifact.content);
    const candidateHan = countHanCharacters(envelope.content);
    const controlRequiredDelta =
      control.report.action === 'expand'
        ? Math.max(0, control.report.allowedMinHan - writerHan)
        : control.report.action === 'compress'
          ? Math.max(0, writerHan - control.report.allowedMaxHan)
          : 0;
    const requiredProgressHan = requiredControlProgressHan(controlRequiredDelta);
    const actualDeltaHan = candidateHan - writerHan;
    const controlProgressPassed =
      control.report.action === 'keep' ||
      (control.report.action === 'expand'
        ? candidateHan >= control.report.allowedMinHan ||
          Math.max(0, candidateHan - writerHan) >= requiredProgressHan
        : candidateHan <= control.report.allowedMaxHan ||
          Math.max(0, writerHan - candidateHan) >= requiredProgressHan);
    const repairTelemetry = {
      injectedCheckerIssueCount,
      appliedCheckerIssueCount,
      injectedControlSuggestionCount,
      appliedControlSuggestionCount,
      writerHan,
      candidateHan,
      actualDeltaHan,
      requiredProgressHan,
      controlProgressPassed,
    };
    if (noMeaningfulChange) {
      const rejectionCode = 'repair_candidate_unchanged';
      await finalizeContinuationV4RepairRejection({
        runId: run.id,
        repairStageResultId: reserved.id,
        localVerifyStageResultId: localVerifyStage.id,
        writerArtifactId: writerArtifact.id,
        writerArtifactHash: writerArtifact.contentHash,
        rejectionCode,
        rejectionMessage: 'Repair 未产生有意义的原文修订，已拒绝并保留 Writer 初稿。',
        localChecks,
        tokenUsageJson: JSON.stringify({ workflowVersion: 4 }),
        outputTokens: result.usage?.completion ?? null,
        repairOutputJson: JSON.stringify({
          schemaVersion: 1,
          appliedCheckerIssueIds: envelope.appliedCheckerIssueIds,
          appliedControlSuggestionIds: envelope.appliedControlSuggestionIds,
          unappliedItems: envelope.unappliedItems,
          parentArtifactId: writerArtifact.id,
          contentHash: candidateHash,
          rejectionCode,
          complianceCheckSubtypes: complianceChecks.map(check => check.subtype),
          ...repairTelemetry,
        }),
        localVerifyOutputJson: JSON.stringify({
          schemaVersion: 1,
          passed: false,
          actualHanCharacters: gate.candidateMetrics.actualHanCharacters,
          minHanCharacters: gate.candidateMetrics.minHanCharacters,
          maxHanCharacters: gate.candidateMetrics.maxHanCharacters,
          checkSubtypes: localChecks.map(check => check.subtype),
          checkerSemanticReview: checkerIssues.length > 0 ? 'available' : 'none_or_degraded',
          controlDegraded: control.degraded,
          repairCompliancePassed: false,
          complianceCheckSubtypes: complianceChecks.map(check => check.subtype),
          rejectionCode,
          ...repairTelemetry,
        }),
      });
      await updateTelemetry(run.id);
      return { artifact: null, completed: false };
    }
    const final = await finalizeContinuationV4Repair({
      runId: run.id,
      repairStageResultId: reserved.id,
      localVerifyStageResultId: localVerifyStage.id,
      parentArtifactId: writerArtifact.id,
      content: envelope.content,
      repairRound: 1,
       eligibilityStatus: repairPassed ? 'eligible' : 'rejected',
       rejectionCode: repairPassed
         ? null
         : complianceChecks.length > 0
           ? 'repair_compliance_failed'
           : 'local_final_gate_failed',
      localChecks,
      writerArtifactId: writerArtifact.id,
       markWriterChecksObsolete: repairPassed,
       tokenUsageJson: JSON.stringify({ workflowVersion: 4 }),
       outputTokens: result.usage?.completion ?? null,
       repairOutputJson: JSON.stringify({
        schemaVersion: 1,
        appliedCheckerIssueIds: envelope.appliedCheckerIssueIds,
        appliedControlSuggestionIds: envelope.appliedControlSuggestionIds,
        unappliedItems: envelope.unappliedItems,
         parentArtifactId: writerArtifact.id,
         contentHash: candidateHash,
         complianceCheckSubtypes: complianceChecks.map(check => check.subtype),
         rejectionCode: repairPassed
           ? null
           : complianceChecks.length > 0
             ? 'repair_compliance_failed'
             : 'local_final_gate_failed',
        ...repairTelemetry,
      }),
      localVerifyOutputJson: JSON.stringify({
        schemaVersion: 1,
         passed: repairPassed,
        actualHanCharacters: gate.candidateMetrics.actualHanCharacters,
        minHanCharacters: gate.candidateMetrics.minHanCharacters,
        maxHanCharacters: gate.candidateMetrics.maxHanCharacters,
        checkSubtypes: localChecks.map(check => check.subtype),
         checkerSemanticReview: checkerIssues.length > 0 ? 'available' : 'none_or_degraded',
         controlDegraded: control.degraded,
         repairCompliancePassed: complianceChecks.length === 0,
         complianceCheckSubtypes: complianceChecks.map(check => check.subtype),
         ...repairTelemetry,
       }),
       localVerifyStatus: repairPassed ? 'success' : 'failed',
    });
    await updateTelemetry(run.id);
    return { artifact: final.artifact, completed: true };
  } catch (error: any) {
    if (options.signal.aborted) {
      await markStageInterruptedIfPending(run.id, 'repair');
      await markStageInterruptedIfPending(run.id, 'local_verify');
      throw error;
    }
    await markStageFailed({
      runId: run.id,
      stage: 'repair',
      errorCode: error?.code || 'repair_failed',
      errorMessage: error?.message || 'Repair 未能输出完整终稿。',
    });
    await updateStageResult({
      runId: run.id,
      stage: 'local_verify',
      status: 'skipped',
      outputJson: JSON.stringify({ schemaVersion: 1, reason: 'repair_failed' }),
      errorCode: 'repair_failed',
      errorMessage: 'Repair 失败，已保留 Writer 初稿。',
      artifactId: writerArtifact.id,
    });
    await casUpdateRunState(run.id, ['running'], {
      state: 'awaiting_user',
      stage: 'awaiting_user',
      errorCode: error?.code || 'repair_failed',
      errorMessage: error?.message || 'Repair 失败，已保留 Writer 初稿。',
    });
    await updateTelemetry(run.id);
    return { artifact: null, completed: false };
  }
}

async function completeExistingRepairLocalGate(input: {
  run: ContinuationGenerationRun;
  snapshot: ContinuationContextSnapshotV3;
  writerArtifact: ContinuationArtifact;
  repairArtifact: ContinuationArtifact;
  controlMetrics: ContinuationV4Metrics;
}): Promise<void> {
  const gate = runContinuationV4LocalFinalGate({
    writerText: input.writerArtifact.content,
    candidateText: input.repairArtifact.content,
    snapshot: input.snapshot,
    controlMetrics: input.controlMetrics,
  });
  const localVerify = await getStageResult(input.run.id, 'local_verify');
  if (!localVerify) throw new Error('缺少 local_verify stage result。');
  await finalizeContinuationV4LocalGate({
    runId: input.run.id,
    repairArtifactId: input.repairArtifact.id,
    localVerifyStageResultId: localVerify.id,
    writerArtifactId: input.writerArtifact.id,
    eligibilityStatus: gate.passed ? 'eligible' : 'rejected',
    rejectionCode: gate.passed ? null : 'local_final_gate_failed',
    localChecks: gate.checks,
    markWriterChecksObsolete: gate.passed,
    localVerifyOutputJson: JSON.stringify({
      schemaVersion: 1,
      passed: gate.passed,
      actualHanCharacters: gate.candidateMetrics.actualHanCharacters,
      checkSubtypes: gate.checks.map(check => check.subtype),
    }),
    localVerifyStatus: gate.passed ? 'success' : 'failed',
    tokenUsageJson: JSON.stringify({ workflowVersion: 4 }),
  });
  await updateTelemetry(input.run.id);
}

async function persistActualContext(
  runId: string,
  snapshot: ContinuationContextSnapshotV3,
  trace: ContinuationContextTrace,
): Promise<void> {
  await casUpdateRunState(runId, ['running'], {
    contextSnapshotJson: JSON.stringify(snapshot),
    contextTraceJson: JSON.stringify(trace),
  });
}

async function runV4Pipeline(
  run: ContinuationGenerationRun,
  originalSnapshot: ContinuationContextSnapshotV3,
  originalTrace: ContinuationContextTrace,
  options: V4PipelineOptions,
): Promise<void> {
  await ensureContinuationV4StageResults({
    runId: run.id,
    stages: originalSnapshot.stageBudgets,
  });
  const writer = await runWriterNode(run, originalSnapshot, options);
  if (!writer) {
    await casUpdateRunState(run.id, ['running'], {
      state: 'failed',
      stage: 'writer',
      errorCode: 'writer_reserved_no_result',
      errorMessage: 'Writer 已 reservation 但没有完整初稿，禁止自动重发。',
      completedAt: new Date().toISOString(),
    });
    await updateTelemetry(run.id);
    return;
  }
  await setRunStage(run.id, 'auditing');
  let actual: ReturnType<typeof actualV4SnapshotAfterWriter>;
  try {
    actual = actualV4SnapshotAfterWriter({
      snapshot: originalSnapshot,
      trace: originalTrace,
      artifactText: writer.artifact.content,
      plan: writer.plan,
    });
  } catch (error: any) {
    // Local metric/budget derivation is a hard dependency of both downstream
    // nodes. Keep Writer recoverable, record the dependency failure and do not
    // attempt either Repair or a transport retry.
    const writerChecks = await ensureWriterLocalChecks(run, originalSnapshot, writer.artifact);
    await markStageFailed({
      runId: run.id,
      stage: 'control',
      errorCode: 'control_metrics_failed',
      errorMessage: error?.message || 'Control 本地指标计算失败。',
    });
    await settleWithoutRepair({
      run,
      artifact: writer.artifact,
      reason: 'control_metrics_failed',
      localVerifyPassed: false,
      localChecks: writerChecks,
    });
    return;
  }
  await persistActualContext(run.id, actual.snapshot, actual.trace);
  const writerChecks = await ensureWriterLocalChecks(run, actual.snapshot, writer.artifact);
  let metricsFailure: Error | null = null;
  let metrics: ContinuationV4Metrics;
  try {
    metrics = buildContinuationControlMetrics({
      text: writer.artifact.content,
      target: actual.snapshot.settingsSnapshot.values.targetChapterChars,
      plan: writer.plan,
    });
  } catch (error: any) {
    metricsFailure = error instanceof Error ? error : new Error(String(error));
    metrics = buildContinuationControlMetrics({
      text: writer.artifact.content,
      target: actual.snapshot.settingsSnapshot.values.targetChapterChars,
    });
    await markStageFailed({
      runId: run.id,
      stage: 'control',
      errorCode: 'control_metrics_failed',
      errorMessage: metricsFailure.message,
    });
  }
  const persistedRepairStage = await getStageResult(run.id, 'repair');
  const persistedRepairArtifact = await getLatestArtifactForStage(run.id, 'repair');
  const persistedLocalVerify = await getStageResult(run.id, 'local_verify');
  if (
    !metricsFailure &&
    persistedRepairStage?.status === 'success' &&
    persistedRepairArtifact &&
    persistedLocalVerify &&
    persistedLocalVerify.status !== 'success' &&
    persistedLocalVerify.status !== 'failed'
  ) {
    await setRunStage(run.id, 'local_verify');
    await completeExistingRepairLocalGate({
      run,
      snapshot: actual.snapshot,
      writerArtifact: writer.artifact,
      repairArtifact: persistedRepairArtifact,
      controlMetrics: metrics,
    });
    return;
  }
  const checkerPromise = runCheckerNode({
    run,
    snapshot: actual.snapshot,
    plan: writer.plan,
    artifact: writer.artifact,
    options,
  });
  const controlPromise = metricsFailure
    ? Promise.reject<V4ControlOutcome>(metricsFailure)
    : runControlNode({
        run,
        snapshot: actual.snapshot,
        plan: writer.plan,
        artifact: writer.artifact,
        metrics,
        options,
      });
  const [checkerSettled, controlSettled] = await Promise.allSettled([
    checkerPromise,
    controlPromise,
  ]);
  assertNotAborted(options.signal);
  const checker = checkerSettled.status === 'fulfilled' ? checkerSettled.value : null;
  const control = controlSettled.status === 'fulfilled' ? controlSettled.value : null;
  const controlError = controlSettled.status === 'rejected'
    ? controlSettled.reason instanceof Error
      ? controlSettled.reason.message
      : String(controlSettled.reason)
    : null;
  if (metricsFailure) {
    await settleWithoutRepair({
      run,
      artifact: writer.artifact,
      reason: 'control_metrics_failed',
      localVerifyPassed: false,
      localChecks: writerChecks,
    });
    return;
  }
  const controlReport = control?.report || buildContinuationControlFallback(metrics);
  const checkerPersisted = checker?.persistedIssues ?? [];
  // Local safety issues that should drive Repair as explicit tasks. Length is
  // excluded: chapter_length_* is owned by Control's local suggestion, so
  // injecting it here would duplicate the same task under two ids.
  const localSafetyIssues = writerChecks.filter(
    check =>
      isLocalGateSubtype(check.subtype) &&
      !check.subtype.startsWith('chapter_length_') &&
      hasActionableIssue([check]),
  );
  // Repair receives the union of Checker-persisted issues and non-length local
  // safety issues, deduped by persisted check id so the same row is not tracked
  // twice under two ids.
  const repairIssues = dedupeRepairIssues([
    ...checkerPersisted,
    ...localSafetyIssues,
  ]);
  const actionable =
    hasActionableIssue(checker?.issues ?? []) ||
    hasActionableIssue(localSafetyIssues) ||
    controlReport.action !== 'keep' ||
    controlReport.suggestions.length > 0;
  if (!checker && !control) {
    await settleWithoutRepair({
      run,
      artifact: writer.artifact,
      reason: 'checker_and_control_failed',
      localVerifyPassed: false,
      localChecks: writerChecks,
    });
    return;
  }
  if (!actionable) {
    const reason = checker
      ? 'skipped_no_actionable_revision'
      : 'skipped_checker_unavailable_no_control_revision';
    await settleWithoutRepair({
      run,
      artifact: writer.artifact,
      reason,
      localVerifyPassed: localSafetyIssues.length === 0,
      localChecks: writerChecks,
    });
    return;
  }
  await setRunStage(run.id, 'repair');
  const repair = await runRepairNode({
    run,
    snapshot: actual.snapshot,
    plan: writer.plan,
    writerArtifact: writer.artifact,
    checkerIssues: repairIssues,
    control: control || {
      metrics,
      report: controlReport,
      degraded: true,
      errorCode: controlError || 'control_unavailable',
    },
    options,
  });
  if (repair.artifact && repair.artifact.eligibilityStatus === 'rejected') {
    // The rejected candidate is intentionally kept for audit; Writer remains
    // the latest eligible artifact and the run is already awaiting_user.
    return;
  }
}

async function finalizeV4OnError(
  runId: string,
  error: unknown,
): Promise<void> {
  const run = await getRunById(runId).catch(() => null);
  if (!run || run.state === 'cancelled' || run.state === 'outdated') return;
  const writer = await getLatestArtifactForStage(runId, 'writer').catch(() => null);
  const message = error instanceof Error ? error.message : String(error);
  await casUpdateRunState(runId, ['running'], {
    state: writer ? 'awaiting_user' : 'failed',
    stage: writer ? 'awaiting_user' : 'writer',
    errorCode: writer ? 'continuation_v4_degraded' : 'continuation_v4_failed',
    errorMessage: writer ? `${message}；已保留 Writer 初稿。` : message,
    completedAt: writer ? null : new Date().toISOString(),
  });
  await updateTelemetry(runId).catch(() => {});
}

export async function startContinuationV4Run(
  input: StartContinuationRunInput,
): Promise<ContinuationGenerationRun> {
  const settings = await ensureGenerationSettings(input.projectId);
  const policy = await ensureContextAutomationPolicy();
  const resolved = await resolveV4StageModels(settings);
  const { snapshot, trace } = await buildContinuationV4Context({
    projectId: input.projectId,
    targetChapterId: input.chapterId,
    targetPosition: input.targetPosition as any,
    currentChapterContent: input.currentChapterContent,
    userInstruction: input.userInstruction,
    activeLlmConfigId: resolved.activeConfigId,
    settingsOverride: {
      ...settings,
      checkerEnabled: true,
      writerLlmConfigId: resolved.stageModels.writer.configId,
      checkerLlmConfigId: resolved.stageModels.checker.configId,
      controlLlmConfigId: resolved.stageModels.control.configId,
      repairLlmConfigId: resolved.stageModels.repair.configId,
    },
    policy,
    stageModels: resolved.stageModels,
    frozenModelConfigs: resolved.frozenModelConfigs,
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
      workflowVersion: 4,
      maxPhysicalRequests: 4,
      physicalRequestCount: 0,
      stages: {},
    }),
    state: 'running',
    stage: 'writer',
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
      await runV4Pipeline(run, snapshot, trace, {
        callStage: input.callStage,
        deterministicOnly: input.deterministicOnly,
        signal: controller.signal,
        projectId: input.projectId,
      });
    } catch (error) {
      await finalizeV4OnError(runId, error);
    } finally {
      activeContinuationControllers.delete(runId);
    }
  })();
  return run;
}

export async function resumeContinuationV4Run(
  runId: string,
  callStage?: StageLlmCaller,
  deterministicOnly?: boolean,
): Promise<void> {
  const run = await getRunById(runId);
  if (!run) throw new Error('run 不存在');
  if (run.workflowVersion !== 4) throw new Error('不是 V4 续写运行');
  if (run.state === 'outdated') throw new ContinuationOutdatedError();
  if (run.state === 'awaiting_user') return;
  if (run.state !== 'interrupted' && run.state !== 'failed') {
    throw new Error('仅 interrupted/failed V4 运行可恢复');
  }
  if (!run.contextSnapshotJson) throw new Error('缺少冻结 V4 context。');
  const snapshot = JSON.parse(run.contextSnapshotJson) as ContinuationContextSnapshotV3;
  if (snapshot.schemaVersion !== 3 || snapshot.workflowVersion !== 4) {
    throw new Error('V4 context snapshot 版本不匹配。');
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
    stage: run.stage === 'writer' ? 'writer' : 'auditing',
    errorCode: null,
    errorMessage: null,
    completedAt: null,
  });
  if (!changed) return;
  const controller = new AbortController();
  activeContinuationControllers.set(runId, controller);
  try {
    await runV4Pipeline(
      { ...run, state: 'running', stage: run.stage === 'writer' ? 'writer' : 'auditing' },
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
    await finalizeV4OnError(runId, error);
    throw error;
  } finally {
    activeContinuationControllers.delete(runId);
  }
}

/** Mark every not-yet-settled V4 node interrupted when the user cancels. */
export async function markContinuationV4StagesCancelled(runId: string): Promise<void> {
  const results = await listStageResults(runId);
  for (const result of results) {
    if (result.status !== 'queued' && result.status !== 'running') continue;
    await updateStageResult({
      runId,
      stage: result.stage,
      status: 'interrupted',
      outputJson: result.outputJson,
      artifactId: result.artifactId,
      errorCode: 'cancelled',
      errorMessage: '用户取消，reservation 不会自动重发。',
    });
  }
}

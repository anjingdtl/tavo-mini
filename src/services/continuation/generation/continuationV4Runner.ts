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
  isRepairableCheckerIssue,
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
  getRepairReadyStyleFindings,
  resolveContinuationControlReport,
} from './continuationControl';
import {
  compileContinuationV4CheckerMessages,
  compileContinuationV4ControlMessages,
  compileContinuationV4RepairMessages,
  compileContinuationV4WriterMessages,
  continuationV4ProtocolSkeletonTokens,
  REPAIR_ANCHOR_MARKER_PATTERN,
  stripRepairAnchors,
} from './continuationV4PromptCompiler';
import {
  evaluateRepairCompleteness,
  type TargetedRepairSpan,
} from './repairCompletenessPolicy';
import {
  buildContinuationV4Context,
} from './continuationContextBuilder';
import {
  resolveContinuationV4BudgetPreview,
} from './continuationV4Budget';
import {
  countHanCharacters,
  resolveContinuationV4ReferenceLengthBand,
} from './continuationLengthContract';
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
  ContinuationStageOutputTruncatedError,
  ContinuationOutdatedError,
} from './types';
import type {
  StageLlmCallResult,
  StageLlmCaller,
  StartContinuationRunInput,
} from './continuationGenerationRunner';
import { activeContinuationControllers } from './continuationRunControllers';
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
    !parsed.content.trim()
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
  // Content is the repair payload; acknowledgement arrays are metadata.
  // Models occasionally omit empty arrays even after following the envelope
  // instruction. Normalize omissions to [] so the client can inspect the
  // repaired text and let compliance report missing acknowledgements instead
  // of rejecting before Local Final Gate.
  const normalizeStringArray = (value: unknown, field: string): string[] => {
    if (value == null) return [];
    if (!Array.isArray(value)) {
      throw new Error(`V4 Repair ${field} 必须是字符串数组。`);
    }
    return value
      .filter((item: unknown) => typeof item === 'string')
      .map((item: string) => item.trim())
      .filter(Boolean);
  };
  const appliedCheckerIssueIds = normalizeStringArray(
    parsed.appliedCheckerIssueIds,
    'appliedCheckerIssueIds',
  );
  const appliedControlSuggestionIds = normalizeStringArray(
    parsed.appliedControlSuggestionIds,
    'appliedControlSuggestionIds',
  );
  const appliedControlFindingIds = normalizeStringArray(
    parsed.appliedControlFindingIds,
    'appliedControlFindingIds',
  );
  const unappliedItems = normalizeStringArray(
    parsed.unappliedItems,
    'unappliedItems',
  );
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
    appliedCheckerIssueIds,
    appliedControlSuggestionIds,
    appliedControlFindingIds,
    unappliedItems,
  };
}

/** Hard local safety issues that may alone trigger Repair (never length). */
function isV4LengthAdvisorySubtype(subtype: string): boolean {
  // The second prefix is only for reinterpreting historical V4 rows written
  // before length-only Repair checks were removed; new code never emits it.
  return subtype.startsWith('chapter_length_') || subtype.startsWith('repair_length_');
}

function isHardLocalSafetyIssue(issue: Pick<RawCheckIssue, 'subtype' | 'severity'>): boolean {
  if (issue.severity !== 'error' && issue.severity !== 'blocking') return false;
  if (isV4LengthAdvisorySubtype(issue.subtype)) return false;
  return (
    issue.subtype === 'source_overlap' ||
    issue.subtype === 'continuation_anchor_overlap' ||
    issue.subtype === 'future_leakage' ||
    issue.subtype === 'self_duplicate' ||
    issue.subtype === 'resurrection_forbidden'
  );
}

function isCheckerForbiddenSubtype(subtype: string): boolean {
  return (
    isV4LengthAdvisorySubtype(subtype) ||
    subtype === 'source_overlap' ||
    subtype === 'continuation_anchor_overlap' ||
    subtype === 'future_leakage' ||
    subtype === 'self_duplicate' ||
    // Structural style ownership belongs to Control. Keeping these model
    // observations out of Checker prevents vague style warnings from being
    // presented to Repair as semantic tasks without a concrete target/fix.
    subtype === 'dialogue_density' ||
    subtype === 'paragraph_length' ||
    subtype === 'paragraph_length_imbalance' ||
    subtype === 'dialogue_narrative_ratio_drift' ||
    subtype === 'scene_pacing_drift' ||
    subtype === 'ending_hook_abrupt' ||
    subtype === 'ending_hook_abruptness'
  );
}

function normalizedRepairComparisonText(text: string): string {
  return text.trim().replace(/\s+/g, '');
}

/** Surface comparison used only to catch punctuation/whitespace-only rewrites. */
export function normalizeSemanticSurface(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '');
}

function locateSemanticSurface(
  haystack: string,
  needle: string,
): { start: number; end: number } | null {
  const normalizedNeedle = normalizeSemanticSurface(needle);
  if (!normalizedNeedle) return null;
  let normalizedHaystack = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (let offset = 0; offset < haystack.length; ) {
    const codePoint = haystack.codePointAt(offset) ?? 0;
    const char = haystack.slice(offset, offset + (codePoint > 0xffff ? 2 : 1));
    if (normalizeSemanticSurface(char)) {
      normalizedHaystack += char;
      starts.push(offset);
      ends.push(offset + char.length);
    }
    offset += char.length;
  }
  const index = normalizedHaystack.indexOf(normalizedNeedle);
  if (index < 0) return null;
  const last = index + normalizedNeedle.length - 1;
  return { start: starts[index], end: ends[last] };
}

function punctuationSignature(text: string): string {
  // Newlines are sentence/paragraph segmentation signals for the
  // sentence_rhythm exception; ordinary spaces remain ignorable.
  return (text.match(/[\p{P}\r\n]/gu) ?? []).join('');
}

function repairComplianceIssue(input: {
  subtype: string;
  category: RawCheckIssue['category'];
  severity?: RawCheckIssue['severity'];
  description: string;
  suggestedFix: string;
  evidenceIds?: number[];
}): RawCheckIssue {
  return {
    category: input.category,
    subtype: input.subtype,
    severity: input.severity ?? 'blocking',
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
 * every repairReady Checker/Control requirement and rewrites the targeted
 * spans. Completeness/collapse are handled separately by
 * evaluateRepairCompleteness. This is not a second semantic LLM review.
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
  // Only repairReady five-dimension / safety issues require application.
  const actionableCheckerIssues = input.checkerIssues.filter(issue =>
    isRepairableCheckerIssue(issue) || isHardLocalSafetyIssue(issue),
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

    const excerpt = (issue.generatedExcerpt ?? '').trim();
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
    } else if (
      excerpt.length >= 4 &&
      normalizeSemanticSurface(excerpt).length >= 4 &&
      normalizeSemanticSurface(input.candidateText).includes(
        normalizeSemanticSurface(excerpt),
      )
    ) {
      checks.push(
        repairComplianceIssue({
          category: issue.category,
          subtype: 'repair_checker_issue_surface_unchanged',
          description: `Repair 虽改变了标点或空格，但 Checker issue ${issueId} 的汉字主体仍完整保留：${excerpt.slice(0, 80)}`,
          suggestedFix: `必须改变问题事实的表层表达，而不是只改标点或空格；仍需保持 issue ${issueId} 要求的语义约束。`,
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

  // Length expand/compress suggestions no longer drive compliance.
  // Unknown suggestion ids are still soft-rejected if the model invents them.
  const suggestionIds = new Set(
    input.controlReport.suggestions.map(suggestion => suggestion.suggestionId),
  );
  for (const appliedId of input.envelope.appliedControlSuggestionIds) {
    if (suggestionIds.size > 0 && !suggestionIds.has(appliedId)) {
      checks.push(
        repairComplianceIssue({
          category: 'style',
          subtype: 'repair_unknown_control_suggestion_id',
          severity: 'warning',
          description: `Repair 声明落实了当前 Control 报告不存在的 suggestion ${appliedId}。`,
          suggestedFix: '篇幅建议已停用；appliedControlSuggestionIds 应为空或仅含报告内 id。',
        }),
      );
    }
  }

  const repairReadyFindings = getRepairReadyStyleFindings(input.controlReport);
  const controlFindingIds = new Set(
    input.controlReport.findings.map(finding => finding.findingId),
  );
  const appliedControlFindingIds = input.envelope.appliedControlFindingIds ?? [];
  const trustedControlFindingIds = new Set(
    repairReadyFindings.map(finding => finding.findingId),
  );
  for (const finding of repairReadyFindings) {
    if (!appliedControlFindingIds.includes(finding.findingId)) {
      checks.push(
        repairComplianceIssue({
          category: 'style',
          subtype: 'repair_control_finding_unapplied',
          severity: 'blocking',
          description: `Repair 未在 appliedControlFindingIds 中回填可执行文风 finding ${finding.findingId}：${finding.description}`,
          suggestedFix: `必须按 rewriteGoal 修订目标范围并回填 findingId ${finding.findingId}。`,
        }),
      );
      continue;
    }
    // Deterministic surface check. Punctuation/whitespace-only changes do not
    // satisfy most style dimensions; sentence_rhythm is the explicit
    // exception when the punctuation/segmentation actually changes.
    const excerpt =
      finding.generatedExcerpt?.trim() ||
      (finding.generatedStart != null &&
      finding.generatedEnd != null &&
      finding.generatedEnd > finding.generatedStart &&
      finding.generatedEnd <= input.writerText.length
        ? input.writerText.slice(finding.generatedStart, finding.generatedEnd)
        : '');
    if (excerpt.length >= 4 && input.candidateText.includes(excerpt)) {
      checks.push(
        repairComplianceIssue({
          category: 'style',
          subtype: 'repair_control_style_unchanged',
          severity: 'blocking',
          description: `Repair 声称已落实文风 finding ${finding.findingId}，但目标原句仍完整存在：${excerpt.slice(0, 80)}`,
          suggestedFix: `必须按 rewriteGoal 改写该范围，并遵守 preserveMeaning：${(finding.preserveMeaning ?? []).join('；')}`,
        }),
      );
    } else if (
      excerpt.length >= 4 &&
      normalizeSemanticSurface(excerpt).length >= 4
    ) {
      const located = locateSemanticSurface(input.candidateText, excerpt);
      if (located) {
        const candidateSurfaceSlice = input.candidateText.slice(
          located.start,
          located.end,
        );
        const sentenceRhythmChanged =
          finding.subtype === 'sentence_rhythm' &&
          punctuationSignature(candidateSurfaceSlice) !==
            punctuationSignature(excerpt);
        if (!sentenceRhythmChanged) {
          checks.push(
            repairComplianceIssue({
              category: 'style',
              subtype: 'repair_control_style_surface_unchanged',
              severity: 'blocking',
              description: `Repair 对文风 finding ${finding.findingId} 只做了标点或空格变化，正文主体仍未改变：${excerpt.slice(0, 80)}`,
              suggestedFix: `必须按 ${finding.subtype} 的 rewriteGoal 产生实际表达变化；sentence_rhythm 之外不能只改标点。`,
            }),
          );
        }
      }
    }
  }
  // Audit-only findings: missing id is warning only.
  for (const finding of input.controlReport.findings) {
    // Historical reports may claim repairReady without the real confidence,
    // evidence, preserveMeaning and binding fields. Those rows are audit-only
    // and must not silently disappear from the diagnostics.
    if (trustedControlFindingIds.has(finding.findingId)) continue;
    if (!appliedControlFindingIds.includes(finding.findingId)) {
      checks.push(
        repairComplianceIssue({
          category: 'style',
          subtype: 'repair_control_finding_unapplied',
          severity: 'warning',
          description: `Repair 未回填 audit-only Control finding ${finding.findingId}（不阻断）。`,
          suggestedFix: `audit-only 文风观察无需强制修改；如已处理可回填 findingId ${finding.findingId}。`,
        }),
      );
    }
  }
  for (const appliedId of appliedControlFindingIds) {
    if (!controlFindingIds.has(appliedId) && repairReadyFindings.every(f => f.findingId !== appliedId)) {
      checks.push(
        repairComplianceIssue({
          category: 'style',
          subtype: 'repair_unknown_control_finding_id',
          description: `Repair 声明落实了当前 Control 报告不存在的 finding ${appliedId}。`,
          suggestedFix: '只填写本次冻结 Control 报告中实际存在的 findingId。',
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
  targetedSpans: TargetedRepairSpan[] = [],
  options: {
    /** Raw model content before anchor strip — residual markers are blocking. */
    rawRepairContent?: string;
  } = {},
): RawCheckIssue[] {
  const issues: RawCheckIssue[] = [];
  const candidateHan = countHanCharacters(candidateText);
  const writerHan = countHanCharacters(writerText);
  const rawForAnchor =
    options.rawRepairContent != null ? options.rawRepairContent : candidateText;
  REPAIR_ANCHOR_MARKER_PATTERN.lastIndex = 0;
  if (REPAIR_ANCHOR_MARKER_PATTERN.test(rawForAnchor)) {
    REPAIR_ANCHOR_MARKER_PATTERN.lastIndex = 0;
    issues.push({
      category: 'style',
      subtype: 'repair_anchor_residue',
      severity: 'blocking',
      confidence: 1,
      generatedStart: null,
      generatedEnd: null,
      generatedExcerpt: '',
      description:
        'Repair 终稿仍残留客户端注入的任务锚点标记（⟦ISSUE_n_START/END⟧），不能直接作为章节正文。',
      evidenceIds: [],
      suggestedFix: '删除全部 ⟦ISSUE_*⟧ 锚点后再输出完整终稿。',
    });
  }
  REPAIR_ANCHOR_MARKER_PATTERN.lastIndex = 0;
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
      description: 'Repair 终稿与 Writer 初稿完全相同，没有执行任何精准修订。',
      evidenceIds: [],
      suggestedFix: '必须根据 Checker 五维问题与 Control 文风问题输出真正修订后的完整终稿。',
    });
  }

  // Completeness / anti-collapse relative to Writer (never user target length).
  const completeness = evaluateRepairCompleteness({
    writerText,
    candidateText,
    targetedSpans,
  });
  for (const item of completeness.issues) {
    issues.push({
      category: 'style',
      subtype: item.code,
      severity: item.severity,
      confidence: 1,
      generatedStart: null,
      generatedEnd: null,
      generatedExcerpt: '',
      description: item.description,
      evidenceIds: [],
      suggestedFix: item.suggestedFix,
    });
  }

  // Absolute floor retained as a hard safety net for near-empty stubs.
  if (candidateHan > 0 && candidateHan <= 1000 && writerHan > 1500) {
    if (!issues.some(i => i.subtype === 'repair_content_collapsed' || i.subtype === 'repair_empty_content')) {
      issues.push({
        category: 'style',
        subtype: 'repair_candidate_collapsed',
        severity: 'blocking',
        confidence: 1,
        generatedStart: null,
        generatedEnd: null,
        generatedExcerpt: '',
        description: `Repair 终稿仅含 ${candidateHan} 个汉字（Writer ${writerHan}），已坍缩至 1000 字以内，疑似摘要化或丢失事件链。`,
        evidenceIds: [],
        suggestedFix: '必须输出完整章节终稿，禁止摘要或片段。',
      });
    }
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
    const duplicate = candidateMetrics.duplicateWindows[0];
    const occurrenceIds = duplicate.occurrences
      .map(occurrence => occurrence.paragraphId)
      .join(', ');
    const firstOccurrence = duplicate.occurrences[0];
    issues.push({
      category: 'style',
      subtype: 'self_duplicate',
      severity: 'error',
      confidence: 1,
      generatedStart: firstOccurrence?.start ?? duplicate.start,
      generatedEnd: firstOccurrence?.end ?? duplicate.end,
      generatedExcerpt: candidateText.slice(
        firstOccurrence?.start ?? duplicate.start,
        firstOccurrence?.end ?? duplicate.end,
      ),
      description: `终稿内部存在重复段落，疑似自重复退化（重复段落：${occurrenceIds || '未知'}）。`,
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
  targetedSpans?: TargetedRepairSpan[];
  rawRepairContent?: string;
}): {
  passed: boolean;
  checks: RawCheckIssue[];
  candidateMetrics: ContinuationV4Metrics;
  completeness?: ReturnType<typeof evaluateRepairCompleteness>;
} {
  const base = filterBySettings(
    runDeterministicChecks(
      input.candidateText,
      input.snapshot as unknown as import('./types').ContinuationContextSnapshot,
      {
        lengthContract: resolveContinuationV4ReferenceLengthBand(
          input.snapshot.settingsSnapshot.values.targetChapterChars,
        ),
      },
    ),
    input.snapshot.settingsSnapshot.values,
  );
  const completeness = evaluateRepairCompleteness({
    writerText: input.writerText,
    candidateText: input.candidateText,
    targetedSpans: input.targetedSpans ?? [],
  });
  const checks = softenFinalGateLengthChecks([
    ...base,
    ...localGateExtraIssues(
      input.writerText,
      input.candidateText,
      input.snapshot,
      input.targetedSpans ?? [],
      {
        rawRepairContent: input.rawRepairContent,
      },
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
    completeness,
  };
}

/**
 * Local Final Gate: zero-request safety + completeness. Chapter length is
 * advisory only and never decides eligibility. Collapse is judged relative to
 * Writer structure, not user targetChapterChars.
 */
function softenV4LengthCheck<
  T extends { subtype: string; severity: string; suggestedFix?: string | null },
>(check: T): T {
  if (!isV4LengthAdvisorySubtype(check.subtype)) return check;
  const suffix = '篇幅偏差仅供参考，未因此触发自动 Repair。';
  return {
    ...check,
    severity: 'warning',
    suggestedFix: check.suggestedFix?.includes(suffix)
      ? check.suggestedFix
      : `${check.suggestedFix ?? ''} ${suffix}`.trim(),
  } as T;
}

function softenFinalGateLengthChecks(checks: RawCheckIssue[]): RawCheckIssue[] {
  return checks.map(softenV4LengthCheck);
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
    stageResults.map(result => {
      let telemetryEvents: string[] = [];
      if (result.stage === 'control' && result.outputJson) {
        try {
          const parsed = JSON.parse(result.outputJson) as {
            telemetryEvents?: unknown;
          };
          telemetryEvents = Array.isArray(parsed.telemetryEvents)
            ? parsed.telemetryEvents.filter(
                (event): event is string => typeof event === 'string',
              )
            : [];
        } catch {
          telemetryEvents = [];
        }
      }
      return [
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
        telemetryEvents,
        },
      ];
    }),
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
  if (existing.length > 0) return existing.map(softenV4LengthCheck);
  const raw = filterBySettings(
    runDeterministicChecks(
      artifact.content,
      snapshot as unknown as import('./types').ContinuationContextSnapshot,
      {
        lengthContract: resolveContinuationV4ReferenceLengthBand(
          snapshot.settingsSnapshot.values.targetChapterChars,
        ),
      },
    ),
    snapshot.settingsSnapshot.values,
  ).map(softenV4LengthCheck);
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
    const writerBudget = stageBudget(snapshot, 'writer');
    const result = await invokeV4Stage({
      options,
      runId: run.id,
      stage: 'writer',
      messages,
      budget: writerBudget,
      frozenModelConfig: frozen,
    });
    assertNotAborted(options.signal);
    if (result.finishReason === 'length') {
      throw new ContinuationStageOutputTruncatedError('writer', {
        schemaVersion: 1,
        finishReason: result.finishReason,
        declaredMaxOutputTokens: frozen.maxOutputTokens,
        effectiveMaxOutputTokens: writerBudget.maximumOutputTokens,
        minimumOutputTokens: writerBudget.minimumOutputTokens,
        promptTokens: estimateMessagesTokens(messages),
        completionTokens: result.usage?.completion ?? null,
        referenceTargetHan:
          snapshot.settingsSnapshot.values.targetChapterChars,
      });
    }
    let parsed: ReturnType<typeof parseContinuationV4WriterEnvelope>;
    try {
      parsed = parseContinuationV4WriterEnvelope(result.text, {
        chapterGoal: snapshot.stageViews.writer.userInstruction,
        centralConflict: '围绕本章要求推进当前冲突并自然收束。',
      });
    } catch (error) {
      throw error;
    }
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
        finishReason: result.finishReason ?? null,
        budget: {
          maximumOutputTokens: writerBudget.maximumOutputTokens,
          declaredMaxOutputTokens: frozen.maxOutputTokens,
          minimumOutputTokens: writerBudget.minimumOutputTokens,
        },
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
      outputJson:
        error instanceof ContinuationStageOutputTruncatedError
          ? JSON.stringify(error.diagnostics)
          : null,
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
    if (result.finishReason === 'length') {
      const diagnostics = {
        schemaVersion: 1,
        finishReason: result.finishReason,
        declaredMaxOutputTokens: frozen.maxOutputTokens,
        effectiveMaxOutputTokens: stageBudget(snapshot, 'checker').maximumOutputTokens,
        minimumOutputTokens: stageBudget(snapshot, 'checker').minimumOutputTokens,
        promptTokens: estimateMessagesTokens(messages),
        completionTokens: result.usage?.completion ?? null,
      };
      await markStageFailed({
        runId: run.id,
        stage: 'checker',
        errorCode: 'checker_output_truncated',
        errorMessage: 'Checker 输出被模型最大输出限制截断，已使用本地检查结果。',
        outputJson: JSON.stringify(diagnostics),
      });
      return { issues: [], persistedIssues: [] };
    }
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
        repairReadyIssueCount: bound.filter(isRepairableCheckerIssue).length,
        auditWarningCount: bound.filter(
          issue => issue.severity === 'warning' && !isRepairableCheckerIssue(issue),
        ).length,
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
  const writerArtifactHash = artifact.contentHash;
  const styleProfileHash =
    snapshot.stageViews.control.style.profileHash ??
    snapshot.stageViews.control.snapshotRefs.styleProfileHash;
  const styleRendererVersion = snapshot.stageViews.control.style.rendererVersion;
  const fallback = buildContinuationControlFallback(metrics, {
    writerArtifactHash,
    styleProfileHash,
    styleRendererVersion,
  });
  const stage = await getStageResult(run.id, 'control');
  // Re-parse stored normalized reports instead of trusting them as-is. This
  // rebinds excerpts to the current Writer and revalidates all frozen style
  // and artifact identity fields on resume.
  const loadStoredControlReport = (rawJson: string) =>
    resolveContinuationControlReport({
      metrics,
      raw: rawJson,
      artifactText: artifact.content,
      writerArtifactHash,
      styleProfileHash,
      styleRendererVersion,
    });
  if (stage?.status === 'success' && stage.outputJson) {
    const resolved = loadStoredControlReport(stage.outputJson);
    if (resolved.errorCode) {
      // Persist the normalized fallback plus expected/echoed binding fields so
      // future resumes revalidate a concrete degraded result without ever
      // issuing a second Control request.
      await updateStageResult({
        runId: run.id,
        stage: 'control',
        status: 'failed',
        outputJson: JSON.stringify(resolved.report),
        artifactId: artifact.id,
        outputTokens: stage.outputTokens,
        errorCode: resolved.errorCode,
        errorMessage: 'Control 报告绑定失败，已丢弃 style findings 并使用本地 fallback。',
      });
    }
    return {
      metrics,
      report: resolved.report,
      degraded: resolved.errorCode != null,
      errorCode: resolved.errorCode,
    };
  }
  if (stage?.status === 'failed' && stage.outputJson) {
    const resolved = loadStoredControlReport(stage.outputJson);
    return {
      metrics,
      report: resolved.report,
      degraded: true,
      errorCode: stage.errorCode || resolved.errorCode || 'control_llm_unavailable',
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
    writerArtifactHash,
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
    if (result.finishReason === 'length') {
      const diagnostics = {
        schemaVersion: 1,
        finishReason: result.finishReason,
        declaredMaxOutputTokens: frozen.maxOutputTokens,
        effectiveMaxOutputTokens: stageBudget(snapshot, 'control').maximumOutputTokens,
        minimumOutputTokens: stageBudget(snapshot, 'control').minimumOutputTokens,
        promptTokens: estimateMessagesTokens(messages),
        completionTokens: result.usage?.completion ?? null,
        expectedWriterArtifactHash: writerArtifactHash,
        expectedStyleProfileHash: styleProfileHash,
        expectedStyleRendererVersion: styleRendererVersion,
      };
      const truncatedFallback = buildContinuationControlFallback(metrics, {
        writerArtifactHash,
        styleProfileHash,
        styleRendererVersion,
        controlBindingErrorCodes: [],
      });
      await updateStageResult({
        runId: run.id,
        stage: 'control',
        status: 'failed',
        outputJson: JSON.stringify({
          ...truncatedFallback,
          truncationDiagnostics: diagnostics,
        }),
        artifactId: artifact.id,
        outputTokens: result.usage?.completion ?? null,
        errorCode: 'control_output_truncated',
        errorMessage: 'Control 输出被模型最大输出限制截断，已使用本地 fallback。',
      });
      return {
        metrics,
        report: truncatedFallback,
        degraded: true,
        errorCode: 'control_output_truncated',
      };
    }
    const resolved = resolveContinuationControlReport({
      metrics,
      raw: result.text,
      artifactText: artifact.content,
      writerArtifactHash,
      styleProfileHash,
      styleRendererVersion,
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
      errorMessage:
        error?.message ||
        'Control LLM 未能完成原著文风审查，已保留本地篇幅诊断（无 style finding）。',
      outputJson: JSON.stringify({
        ...fallback,
        // Make the empty style outcome explicit for the result UI.
        styleIssues: [],
        styleWarnings: [],
        findings: [],
        controlDegraded: true,
        controlErrorCode: error?.code || 'control_failed',
      }),
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

function compileRepairMessagesWithinBudget(input: {
  snapshot: ContinuationContextSnapshotV3;
  artifactText: string;
  plan: ContinuationPlan;
  checkerIssues: ContinuationCheckResult[];
  controlReport: ContinuationControlReport;
  contextWindow: number;
  maximumOutputTokens: number;
}): {
  messages: ChatMessage[];
  promptTokens: number;
  compressionLevel: number;
  fits: boolean;
} {
  const variants = [
    { taskContextChars: 96, includeWriterPlan: true },
    { taskContextChars: 48, includeWriterPlan: true },
    { taskContextChars: 24, includeWriterPlan: false },
    { taskContextChars: 0, includeWriterPlan: false },
  ];
  let last: {
    messages: ChatMessage[];
    promptTokens: number;
    compressionLevel: number;
  } | null = null;
  for (let index = 0; index < variants.length; index += 1) {
    const messages = compileContinuationV4RepairMessages({
      view: input.snapshot.stageViews.repair,
      artifactText: input.artifactText,
      plan: input.plan,
      checkerReport: { issues: input.checkerIssues },
      controlReport: input.controlReport,
      options: variants[index],
    });
    const promptTokens = estimateMessagesTokens(messages);
    last = { messages, promptTokens, compressionLevel: index };
    if (promptTokens + input.maximumOutputTokens <= input.contextWindow) {
      return { ...last, fits: true };
    }
  }
  return {
    ...(last ?? {
      messages: [],
      promptTokens: 0,
      compressionLevel: variants.length,
    }),
    fits: false,
  };
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
    const localVerify = await getStageResult(run.id, 'local_verify');
    if (localVerify?.status === 'success' || localVerify?.status === 'failed') {
      return { artifact: existingArtifact, completed: false };
    }
    await completeExistingRepairLocalGate({
      run,
      snapshot,
      writerArtifact: writerArtifact,
      repairArtifact: existingArtifact,
      controlMetrics: control.metrics,
      checkerIssues,
      controlReport: control.report,
    });
    return { artifact: existingArtifact, completed: true };
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
  const repairBudget = stageBudget(snapshot, 'repair');
  const frozenRepair = snapshot.settingsSnapshot.frozenModelConfigs?.repair;
  if (!frozenRepair) throw new ContinuationCapabilityBlockedError('缺少 Repair 冻结模型。');
  const compiled = compileRepairMessagesWithinBudget({
    snapshot,
    artifactText: writerArtifact.content,
    plan,
    checkerIssues,
    controlReport: control.report,
    contextWindow: frozenRepair.contextWindow,
    maximumOutputTokens: repairBudget.maximumOutputTokens,
  });
  if (!compiled.fits) {
    const diagnostics = {
      schemaVersion: 1,
      code: 'repair_prompt_budget_exceeded',
      actualRepairPromptTokens: compiled.promptTokens,
      repairMaximumOutputTokens: repairBudget.maximumOutputTokens,
      frozenRepairContextWindow: frozenRepair.contextWindow,
      compressionLevel: compiled.compressionLevel,
      taskCount: checkerIssues.length,
    };
    await markStageFailed({
      runId: run.id,
      stage: 'repair',
      errorCode: 'repair_prompt_budget_exceeded',
      errorMessage: '真实 Repair Prompt 与输出预算超出冻结上下文窗口，已保留 Writer 初稿。',
      outputJson: JSON.stringify(diagnostics),
    });
    await updateStageResult({
      runId: run.id,
      stage: 'local_verify',
      status: 'skipped',
      outputJson: JSON.stringify({ ...diagnostics, reason: 'repair_prompt_budget_exceeded' }),
      artifactId: writerArtifact.id,
      errorCode: 'repair_prompt_budget_exceeded',
      errorMessage: '未发出 Repair 请求，Writer 保持默认候选。',
    });
    await casUpdateRunState(run.id, ['running'], {
      state: 'awaiting_user',
      stage: 'awaiting_user',
      errorCode: 'repair_prompt_budget_exceeded',
      errorMessage: '真实 Repair Prompt 超出冻结上下文窗口，已保留 Writer 初稿。',
    });
    await updateTelemetry(run.id);
    return { artifact: null, completed: false };
  }
  const messages = compiled.messages;
  const reserved = await reservePhysicalStage({
    runId: run.id,
    stage: 'repair',
    messages,
    budget: repairBudget,
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
    const result = await invokeV4Stage({
      options,
      runId: run.id,
      stage: 'repair',
      messages,
      budget: repairBudget,
      frozenModelConfig: frozenRepair,
    });
    assertNotAborted(options.signal);
    if (result.finishReason === 'length') {
      const diagnostics = {
        schemaVersion: 1,
        finishReason: result.finishReason,
        declaredMaxOutputTokens: frozenRepair.maxOutputTokens,
        effectiveMaxOutputTokens: repairBudget.maximumOutputTokens,
        minimumOutputTokens: repairBudget.minimumOutputTokens,
        promptTokens: compiled.promptTokens,
        completionTokens: result.usage?.completion ?? null,
        referenceTargetHan: snapshot.settingsSnapshot.values.targetChapterChars,
        actualRepairPromptTokens: compiled.promptTokens,
      };
      const localVerifyStage = await getStageResult(run.id, 'local_verify');
      await markStageFailed({
        runId: run.id,
        stage: 'repair',
        errorCode: 'repair_output_truncated',
        errorMessage: 'Repair 输出被模型最大输出限制截断，未形成完整终稿，系统已保留 Writer 初稿。',
        outputJson: JSON.stringify(diagnostics),
      });
      if (localVerifyStage) {
        await updateStageResult({
          runId: run.id,
          stage: 'local_verify',
          status: 'skipped',
          outputJson: JSON.stringify({
            ...diagnostics,
            reason: 'repair_output_truncated',
          }),
          artifactId: writerArtifact.id,
          errorCode: 'repair_output_truncated',
          errorMessage: 'local_verify 跳过，Writer 保持默认候选。',
        });
      }
      await casUpdateRunState(run.id, ['running'], {
        state: 'awaiting_user',
        stage: 'awaiting_user',
        errorCode: 'repair_output_truncated',
        errorMessage: 'Repair 输出被模型最大输出限制截断，未形成完整终稿，系统已保留 Writer 初稿。',
      });
      await updateTelemetry(run.id);
      return { artifact: null, completed: false };
    }
    const envelope = parseContinuationV4RepairEnvelope(result.text);
    const localVerifyStage = await getStageResult(run.id, 'local_verify');
    if (!localVerifyStage) throw new Error('缺少 local_verify stage result。');
    // Strip client-injected anchors; residual markers still fail the gate.
    const stripped = stripRepairAnchors(envelope.content);
    const candidateContent = stripped.text;
    const envelopeForCompliance: ContinuationV4RepairEnvelope = {
      ...envelope,
      content: candidateContent,
    };
    const styleReadyFindings = getRepairReadyStyleFindings(control.report);
    const targetedSpans: TargetedRepairSpan[] = [
      ...checkerIssues.map(issue => ({
        generatedStart: issue.generatedStart,
        generatedEnd: issue.generatedEnd,
        generatedExcerpt: issue.generatedExcerpt,
      })),
      ...styleReadyFindings.map(finding => ({
        generatedStart: finding.generatedStart,
        generatedEnd: finding.generatedEnd,
        generatedExcerpt: finding.generatedExcerpt ?? null,
      })),
    ];
    const gate = runContinuationV4LocalFinalGate({
      writerText: writerArtifact.content,
      candidateText: candidateContent,
      snapshot,
      controlMetrics: control.metrics,
      targetedSpans,
      rawRepairContent: envelope.content,
    });
    const complianceChecks = validateContinuationV4RepairCompliance({
      writerText: writerArtifact.content,
      candidateText: candidateContent,
      checkerIssues,
      controlReport: control.report,
      envelope: envelopeForCompliance,
    });
    const localChecks = [...gate.checks, ...complianceChecks];
    const blockingComplianceChecks = complianceChecks.filter(
      check => check.severity === 'error' || check.severity === 'blocking',
    );
    const blockingQualityGateChecks = gate.checks.filter(
      check => check.severity === 'error' || check.severity === 'blocking',
    );
    const repairPassed = gate.passed && blockingComplianceChecks.length === 0;
    const candidateHash = contentRevisionHash(candidateContent);
    const noMeaningfulChange =
      normalizedRepairComparisonText(candidateContent) ===
      normalizedRepairComparisonText(writerArtifact.content);
    const injectedCheckerIssueCount = checkerIssues.filter(
      issue =>
        isRepairableCheckerIssue(issue) ||
        isHardLocalSafetyIssue(issue),
    ).length;
    const appliedCheckerIssueCount = envelope.appliedCheckerIssueIds.length;
    const styleReady = styleReadyFindings;
    const injectedControlFindingCount = styleReady.length;
    const appliedControlFindingCount =
      envelope.appliedControlFindingIds?.length ?? 0;
    const writerHan = countHanCharacters(writerArtifact.content);
    const candidateHan = countHanCharacters(candidateContent);
    const actualDeltaHan = candidateHan - writerHan;
    const completeness = gate.completeness;
    const firstBlockingCheck = localChecks.find(
      check => check.severity === 'error' || check.severity === 'blocking',
    );
    const repairTriggeredBy: Array<
      'checker' | 'style_control' | 'local_safety'
    > = [];
    if (
      checkerIssues.some(
        issue => isRepairableCheckerIssue(issue) || isHardLocalSafetyIssue(issue),
      )
    ) {
      repairTriggeredBy.push('checker');
    }
    if (styleReady.length > 0) repairTriggeredBy.push('style_control');
    if (checkerIssues.some(isHardLocalSafetyIssue)) {
      if (!repairTriggeredBy.includes('local_safety')) {
        repairTriggeredBy.push('local_safety');
      }
    }

    // Structured failure diagnostics for the result UI (no auto-retry).
    const failureDiagnostics = {
      unappliedIssueDetails: [
        ...checkerIssues
          .filter(
            issue =>
              isRepairableCheckerIssue(issue) ||
              isHardLocalSafetyIssue(issue),
          )
          .filter(
            issue =>
              !envelope.appliedCheckerIssueIds.includes(String(issue.id)) &&
              !envelope.appliedCheckerIssueIds.includes(`chk_${issue.id}`),
          )
          .map(issue => ({
            source: isHardLocalSafetyIssue(issue)
              ? ('local_safety' as const)
              : ('checker' as const),
            kind: isHardLocalSafetyIssue(issue)
              ? ('local_safety' as const)
              : ('checker' as const),
            id: String(issue.id),
            subtype: issue.subtype,
            description: issue.description,
            generatedExcerpt: issue.generatedExcerpt ?? '',
          })),
        ...styleReady
          .filter(
            finding =>
              !(envelope.appliedControlFindingIds ?? []).includes(
                finding.findingId,
          ),
          )
          .map(finding => ({
            source: 'style_control' as const,
            kind: 'control' as const,
            id: finding.findingId,
            subtype: finding.subtype,
            description: finding.description,
            generatedExcerpt: finding.generatedExcerpt ?? '',
          })),
        ...envelope.unappliedItems.map(item => ({
          source: 'repair_protocol' as const,
          kind: 'unapplied_item' as const,
          id: item,
          subtype: 'unapplied_item',
          description: item,
          generatedExcerpt: '',
        })),
      ],
      qualityGateFailures: blockingQualityGateChecks.map(check => ({
        subtype: check.subtype,
        severity: check.severity,
        description: check.description,
      })),
      complianceFailures: blockingComplianceChecks.map(check => ({
        subtype: check.subtype,
        severity: check.severity,
        description: check.description,
      })),
      anchorResidue: stripped.hadAnchors,
      currentCandidateSource: repairPassed ? 'Repair' : 'Writer',
      repairCandidateSource: 'Repair',
      repairStatus: {
        attempted: true,
        returned: true,
        accepted: repairPassed,
        rejected: !repairPassed,
      },
      primaryRejectionCode: firstBlockingCheck?.subtype ?? null,
    };

    const repairTelemetry = {
      referenceTargetHan: control.report.targetHan,
      actualWriterHan: writerHan,
      lengthWarningSubtypes: localChecks
        .filter(c => isV4LengthAdvisorySubtype(c.subtype))
        .map(c => c.subtype),
      checkerActionableIssueCount: injectedCheckerIssueCount,
      checkerAuditWarningCount: checkerIssues.filter(
        i => i.severity === 'warning' && !isRepairableCheckerIssue(i),
      ).length,
      styleActionableIssueCount: styleReady.length,
      styleAuditWarningCount: (control.report.styleWarnings ?? []).length,
      reviewedStyleDimensions: Array.from(
        new Set(
          [
            ...(control.report.styleIssues ?? []),
            ...(control.report.styleWarnings ?? []),
          ].map(i => i.styleDimension),
        ),
      ),
      repairTriggeredBy,
      injectedCheckerIssueCount,
      appliedCheckerIssueCount,
      injectedControlSuggestionCount: 0,
      appliedControlSuggestionCount:
        envelope.appliedControlSuggestionIds.length,
      injectedControlFindingCount,
      appliedControlFindingCount,
      appliedStyleFindingCount: appliedControlFindingCount,
      controlFindingSubtypes: control.report.findings.map(finding => finding.subtype),
      writerHan,
      candidateHan,
      actualDeltaHan,
      // Deprecated length-progress fields retained as fixed soft telemetry.
      requiredProgressHan: 0,
      controlProgressPassed: true,
      writerParagraphCount: completeness?.metrics.writerParagraphCount,
      repairParagraphCount: completeness?.metrics.candidateParagraphCount,
      unaffectedRetentionRatio: completeness?.metrics.unaffectedRetentionRatio,
      openingAnchorRetained: completeness?.metrics.openingAnchorRetained,
      middleAnchorRetained: completeness?.metrics.middleAnchorRetained,
      endingAnchorRetained: completeness?.metrics.endingAnchorRetained,
      candidateToWriterHanRatio: completeness?.metrics.candidateToWriterHanRatio,
      repairCompletenessPassed: completeness?.passed ?? null,
      repairMinimalInterventionPassed:
        completeness?.minimalInterventionPassed ?? null,
      failureDiagnostics,
      actualRepairPromptTokens: compiled.promptTokens,
      repairPromptCompressionLevel: compiled.compressionLevel,
      complianceInputs: {
        schemaVersion: 1,
        appliedCheckerIssueIds: envelope.appliedCheckerIssueIds,
        appliedControlFindingIds: envelope.appliedControlFindingIds ?? [],
        unappliedItems: envelope.unappliedItems,
        targetedSpans,
        rawAnchorResidueDetected: stripped.hadAnchors,
        complianceCheckSubtypes: localChecks.map(check => check.subtype),
      },
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
          appliedControlFindingIds: envelope.appliedControlFindingIds ?? [],
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
          repairCompliancePassed: blockingComplianceChecks.length === 0,
          complianceCheckSubtypes: complianceChecks.map(check => check.subtype),
          rejectionCode,
          ...repairTelemetry,
        }),
      });
      await updateTelemetry(run.id);
      return { artifact: null, completed: false };
    }
    const rejectionCode = repairPassed
      ? null
      : firstBlockingCheck?.subtype ??
        (blockingComplianceChecks.length > 0
          ? 'repair_compliance_failed'
          : 'local_final_gate_failed');
    const final = await finalizeContinuationV4Repair({
      runId: run.id,
      repairStageResultId: reserved.id,
      localVerifyStageResultId: localVerifyStage.id,
      parentArtifactId: writerArtifact.id,
      content: candidateContent,
      repairRound: 1,
      eligibilityStatus: repairPassed ? 'eligible' : 'rejected',
      rejectionCode,
      localChecks,
      writerArtifactId: writerArtifact.id,
      markWriterChecksObsolete: repairPassed,
      tokenUsageJson: JSON.stringify({ workflowVersion: 4 }),
      outputTokens: result.usage?.completion ?? null,
      repairOutputJson: JSON.stringify({
        schemaVersion: 1,
        appliedCheckerIssueIds: envelope.appliedCheckerIssueIds,
        appliedControlSuggestionIds: envelope.appliedControlSuggestionIds,
        appliedControlFindingIds: envelope.appliedControlFindingIds ?? [],
        unappliedItems: envelope.unappliedItems,
        parentArtifactId: writerArtifact.id,
        contentHash: candidateHash,
        complianceCheckSubtypes: complianceChecks.map(check => check.subtype),
        rejectionCode,
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
        repairCompliancePassed: blockingComplianceChecks.length === 0,
        complianceCheckSubtypes: complianceChecks.map(check => check.subtype),
        rejectionCode,
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
  checkerIssues: ContinuationCheckResult[];
  controlReport: ContinuationControlReport;
}): Promise<void> {
  const repairStage = await getStageResult(input.run.id, 'repair');
  let stored: any = null;
  try {
    stored = repairStage?.outputJson ? JSON.parse(repairStage.outputJson) : null;
  } catch {
    stored = null;
  }
  const complianceInputs = stored?.complianceInputs;
  const hasComplianceInputs =
    complianceInputs &&
    complianceInputs.schemaVersion === 1 &&
    Array.isArray(complianceInputs.appliedCheckerIssueIds) &&
    Array.isArray(complianceInputs.appliedControlFindingIds) &&
    Array.isArray(complianceInputs.unappliedItems) &&
    Array.isArray(complianceInputs.targetedSpans) &&
    Array.isArray(complianceInputs.complianceCheckSubtypes) &&
    typeof complianceInputs.rawAnchorResidueDetected === 'boolean';
  const localVerify = await getStageResult(input.run.id, 'local_verify');
  if (!localVerify) throw new Error('缺少 local_verify stage result。');

  const gate = runContinuationV4LocalFinalGate({
    writerText: input.writerArtifact.content,
    candidateText: input.repairArtifact.content,
    snapshot: input.snapshot,
    controlMetrics: input.controlMetrics,
    targetedSpans: hasComplianceInputs
      ? complianceInputs.targetedSpans
      : [],
    rawRepairContent: hasComplianceInputs && complianceInputs.rawAnchorResidueDetected
      ? `${input.repairArtifact.content}\n⟦ISSUE_RESUME_RESIDUE⟧`
      : undefined,
  });
  const resumeChecks: RawCheckIssue[] = [];
  if (!hasComplianceInputs) {
    resumeChecks.push(
      repairComplianceIssue({
        category: 'style',
        subtype: 'repair_resume_compliance_unavailable',
        severity: 'blocking',
        description: '恢复时缺少 Repair compliance 输入，不能证明已落实 Checker/Control 任务。',
        suggestedFix: '保留 Writer 初稿；不得把历史 Repair 自动提升为可采纳候选。',
      }),
    );
  }
  const envelope: ContinuationV4RepairEnvelope = {
    schemaVersion: 1,
    content: input.repairArtifact.content,
    appliedCheckerIssueIds: hasComplianceInputs
      ? complianceInputs.appliedCheckerIssueIds
      : [],
    appliedControlSuggestionIds: [],
    appliedControlFindingIds: hasComplianceInputs
      ? complianceInputs.appliedControlFindingIds
      : [],
    unappliedItems: hasComplianceInputs ? complianceInputs.unappliedItems : [],
  };
  const complianceChecks = hasComplianceInputs
    ? validateContinuationV4RepairCompliance({
        writerText: input.writerArtifact.content,
        candidateText: input.repairArtifact.content,
        checkerIssues: input.checkerIssues,
        controlReport: input.controlReport,
        envelope,
      })
    : [];
  const localChecks = [...gate.checks, ...resumeChecks, ...complianceChecks];
  const firstBlocking = localChecks.find(
    check => check.severity === 'error' || check.severity === 'blocking',
  );
  const passed = localChecks.every(
    check => check.severity !== 'error' && check.severity !== 'blocking',
  );
  await finalizeContinuationV4LocalGate({
    runId: input.run.id,
    repairArtifactId: input.repairArtifact.id,
    localVerifyStageResultId: localVerify.id,
    writerArtifactId: input.writerArtifact.id,
    eligibilityStatus: passed ? 'eligible' : 'rejected',
    rejectionCode: passed ? null : firstBlocking?.subtype ?? 'local_final_gate_failed',
    localChecks,
    markWriterChecksObsolete: passed,
    localVerifyOutputJson: JSON.stringify({
      schemaVersion: 1,
      passed,
      actualHanCharacters: gate.candidateMetrics.actualHanCharacters,
      checkSubtypes: localChecks.map(check => check.subtype),
      complianceCheckSubtypes: complianceChecks.map(check => check.subtype),
      rejectionCode: passed ? null : firstBlocking?.subtype ?? 'local_final_gate_failed',
      currentCandidateSource: passed ? 'Repair' : 'Writer',
      repairResumeComplianceAvailable: hasComplianceInputs,
    }),
    localVerifyStatus: passed ? 'success' : 'failed',
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
  const controlReport =
    control?.report ||
    buildContinuationControlFallback(metrics, {
      writerArtifactHash: writer.artifact.contentHash,
      styleProfileHash:
        actual.snapshot.stageViews.control.style.profileHash ??
        actual.snapshot.stageViews.control.snapshotRefs.styleProfileHash,
      styleRendererVersion: actual.snapshot.stageViews.control.style.rendererVersion,
    });
  const checkerPersisted = checker?.persistedIssues ?? [];
  // Local safety issues that may alone trigger Repair.
  const localSafetyIssues = writerChecks.filter(check =>
    isHardLocalSafetyIssue(check),
  );
  const repairReadyChecker = (checker?.issues ?? []).filter(issue =>
    isRepairableCheckerIssue(issue),
  );
  const repairReadyStyle = getRepairReadyStyleFindings(controlReport);
  // Repair receives only actionable Checker/local safety tasks; still one
  // physical request. chapter_length_* remains warning-only telemetry.
  const repairIssues = dedupeRepairIssues([
    ...checkerPersisted.filter(
      issue =>
        isRepairableCheckerIssue(issue) ||
        isHardLocalSafetyIssue(issue),
    ),
    ...localSafetyIssues,
  ]);
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
      checkerIssues: repairIssues,
      controlReport,
    });
    return;
  }
  const shouldRepair =
    repairReadyChecker.length > 0 ||
    repairReadyStyle.length > 0 ||
    localSafetyIssues.length > 0;
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
  if (!shouldRepair) {
    // Length-only or audit-only warnings: keep Writer as default candidate.
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

function isUserCancelError(error: unknown): boolean {
  if (!error) return false;
  const code =
    typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  if (code === 'cancelled') return true;
  const name =
    typeof error === 'object' && error && 'name' in error
      ? String((error as { name?: unknown }).name ?? '')
      : '';
  if (name === 'AbortError' || name === 'LLMQueueError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /取消|cancelled|aborted|AbortError/i.test(message);
}

/**
 * Settle a V4 run after a stage exception. Never throws — error finalizers run
 * from fire-and-forget pipeline tasks and must not become fatal unhandled
 * rejections (which can take down the RN host on some Android builds).
 */
async function finalizeV4OnError(
  runId: string,
  error: unknown,
): Promise<void> {
  try {
    const run = await getRunById(runId).catch(() => null);
    if (
      !run ||
      run.state === 'cancelled' ||
      run.state === 'outdated' ||
      run.state === 'completed'
    ) {
      return;
    }

    // User cancel (abort signal / queue cancel / explicit 续写已取消) must end
    // as cancelled — never as failed/awaiting_user. That also stops the
    // chapter-editor poll from navigating to the result screen after Stop.
    if (isUserCancelError(error)) {
      await casUpdateRunState(
        runId,
        ['queued', 'running', 'awaiting_user', 'interrupted'],
        {
          state: 'cancelled',
          errorCode: 'cancelled',
          errorMessage: '用户取消',
          completedAt: new Date().toISOString(),
        },
      ).catch(() => false);
      await markContinuationV4StagesCancelled(runId).catch(() => {});
      await updateTelemetry(runId).catch(() => {});
      return;
    }

    const writer = await getLatestArtifactForStage(runId, 'writer').catch(
      () => null,
    );
    const message = error instanceof Error ? error.message : String(error);
    const explicitCode =
      typeof error === 'object' && error && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    const stableTruncationCode = /^(writer|checker|control|repair)_output_truncated$/.test(
      explicitCode,
    )
      ? explicitCode
      : null;
    await casUpdateRunState(runId, ['running'], {
      state: writer ? 'awaiting_user' : 'failed',
      stage: writer ? 'awaiting_user' : 'writer',
      errorCode: writer
        ? 'continuation_v4_degraded'
        : stableTruncationCode ?? 'continuation_v4_failed',
      errorMessage: writer ? `${message}；已保留 Writer 初稿。` : message,
      completedAt: writer ? null : new Date().toISOString(),
    }).catch(() => false);
    await updateTelemetry(runId).catch(() => {});
  } catch (finalizeError) {
    console.warn('[continuation-v4] finalizeV4OnError failed:', finalizeError);
  }
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
      // finalizeV4OnError never throws; still guard so the floating task
      // cannot surface as a fatal unhandled rejection on Android.
      try {
        await finalizeV4OnError(runId, error);
      } catch (finalizeError) {
        console.warn('[continuation-v4] pipeline finalizer failed:', finalizeError);
      }
    } finally {
      activeContinuationControllers.delete(runId);
    }
  })().catch(error => {
    console.warn('[continuation-v4] pipeline task failed:', error);
  });
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
  const results = await listStageResults(runId).catch(() => [] as ContinuationGenerationStageResult[]);
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
      // Per-stage best effort: a single SQLite glitch must not abort cancel.
      console.warn(
        `[continuation-v4] mark stage ${result.stage} interrupted failed:`,
        error,
      );
    }
  }
}

/**
 * Versioned pipeline task context envelope (draft + audit + execution).
 *
 * V1 (legacy Schema 38 first ship): pipeline_context_json is a bare
 * PipelineContextSnapshot.
 * V2: envelope with draftContext, optional auditContext, and frozen execution.
 */
import {
  PIPELINE_CONTEXT_SNAPSHOT_VERSION,
  PIPELINE_CONTEXT_SNAPSHOT_VERSION_V4,
  PIPELINE_CONTEXT_SNAPSHOT_VERSION_V5,
  type ContextBudgetV3Summary,
  type PipelineContextSnapshot,
} from '../types/pipelineContext';
import type {
  FrozenModelSnapshot,
  FrozenPresetSnapshot,
  FrozenStageBudgetV3,
  FrozenStageReasoning,
  PipelineExecutionSnapshot,
} from '../types/pipelineExecution';
import type {
  FrozenAuditCandidates,
  FrozenDraftRequest,
} from '../types/pipelineFrozen';
import type { PipelineMode, PipelineStageName } from '../types/pipeline';
import type { PipelineReasoningEffort } from '../types/pipeline';
import type { FrozenWriterStyleV1 } from './writerStyle/types';
import {
  isPipelineReasoningTier,
  type PipelineReasoningTier,
} from './pipeline/reasoningPolicy';
import type { ChatMessage } from './llm';
import type { GenerationTraceRecordV1 } from '../types/generationTrace';
import {
  buildGenerationFingerprintInput,
  buildGenerationFingerprintInputV2,
  computeGenerationFingerprint,
} from './pipeline/frozenGenerationContext';
import { OutlineContextError } from './outlineContextBuilder';
import { isCurrentOutlinePipelineContextBudgetVersion } from './pipeline/outlineWorkflowVersion';
import { sha256Hex } from './continuation/hashUtils';
import {
  hashContextAutomationPolicyV3,
  isContextAutomationPolicyV3,
  type ContextAutomationPolicyV3,
} from './contextAutomationPolicy';
import { parseFrozenGenerationContextContract } from './context/generation/generationContractValidation';
import type {
  FrozenWritingContext,
  WritingKernelTrace,
} from './writing/contracts/frozenWritingContext';
import type {
  WritingScenario,
  WritingSourceTrace,
} from './writing/contracts/writingSource';

/** Envelope protocol version stored in pipeline_context_version. */
export const PIPELINE_TASK_CONTEXT_VERSION = 2 as const;

export interface PersistedPipelineTaskContextV2 {
  version: 2;
  draftContext: PipelineContextSnapshot;
  auditContext?: PipelineContextSnapshot;
  execution: PipelineExecutionSnapshot;
  /** Frozen final Draft request (messages actually sent / to be sent). */
  frozenDraftRequest?: FrozenDraftRequest;
  /**
   * Full-mode post-draft retrieval candidate pool, frozen at task start.
   * Required for safe audit rebuild; missing → cannot recover full audits.
   */
  frozenAuditCandidates?: FrozenAuditCandidates;
  /**
   * Stability Phase 1 — generation trace identity. Frozen once with the
   * envelope; resume reuses the id instead of minting a new one. Absent on
   * historical tasks (tolerated, never blocks generation).
   */
  trace?: GenerationTraceRecordV1;
  /**
   * Stability Phase 2 — semantic generation fingerprint (Plan §12). Computed
   * deterministically from the frozen semantic content at serialize time and
   * re-verified at parse time. Absent on historical tasks (tolerated).
   */
  generationFingerprint?: string;
  /** Fingerprint input protocol; absent means the historical V1 input. */
  generationFingerprintVersion?: 1 | 2;
  createdAt: number;
  draftCompletedAt?: number;
  auditContextCreatedAt?: number;
  /** True when audit fell back to draftContext after post-draft retrieval failure. */
  auditFellBack?: boolean;
}

export interface PersistedPipelineTaskContextV3
  extends Omit<PersistedPipelineTaskContextV2, 'version'> {
  version: 3;
}

export interface PersistedPipelineTaskContextV4
  extends Omit<PersistedPipelineTaskContextV2, 'version'> {
  version: 4;
}

export interface ParsedPipelineTaskContext {
  version: 1 | 2 | 3 | 4;
  draftContext: PipelineContextSnapshot;
  auditContext: PipelineContextSnapshot | null;
  execution: PipelineExecutionSnapshot | null;
  frozenDraftRequest: FrozenDraftRequest | null;
  frozenAuditCandidates: FrozenAuditCandidates | null;
  /** Stability Phase 1 trace identity; null on pre-trace historical tasks. */
  trace: GenerationTraceRecordV1 | null;
  /** Stability Phase 2 semantic fingerprint; null on historical envelopes. */
  generationFingerprint: string | null;
  generationFingerprintVersion: 1 | 2 | null;
  createdAt: number;
  auditFellBack?: boolean;
}

/**
 * Tolerant trace-record parse: absence and malformed values degrade to null —
 * trace telemetry must NEVER block generation or resume (Stability Plan §6).
 */
function parseTraceRecord(raw: unknown): GenerationTraceRecordV1 | null {
  if (!isPlainObject(raw)) return null;
  const generationTraceId = String(raw.generationTraceId ?? '');
  const createdAt = Number(raw.createdAt);
  if (
    Number(raw.version) !== 1 ||
    !generationTraceId ||
    !Number.isFinite(createdAt) ||
    createdAt <= 0
  ) {
    return null;
  }
  return { version: 1, generationTraceId, createdAt };
}

export function computeFrozenDraftRequestFingerprint(
  messages: ChatMessage[],
  meta: {
    estimatedInputTokens: number;
    reservedOutputTokens: number;
    safetyMargin: number;
    contextWindow: number;
  },
): string {
  const payload = JSON.stringify({
    messages,
    estimatedInputTokens: meta.estimatedInputTokens,
    reservedOutputTokens: meta.reservedOutputTokens,
    safetyMargin: meta.safetyMargin,
    contextWindow: meta.contextWindow,
  });
  return sha256Hex(payload).slice(0, 32);
}

function parseFrozenDraftRequest(raw: unknown): FrozenDraftRequest | null {
  if (raw == null) return null;
  if (!isPlainObject(raw)) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '冻结初稿请求结构无效，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  if (!Array.isArray(raw.messages)) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '冻结初稿请求缺少 messages，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  const messages: ChatMessage[] = raw.messages.map((m: unknown) => {
    if (!isPlainObject(m) || typeof m.role !== 'string') {
      throw new OutlineContextError(
        'OUTLINE_SNAPSHOT_INVALID',
        '冻结初稿请求 messages 非法，已阻止恢复。请重新开始生成。',
        'restart_task',
      );
    }
    return {
      role: m.role as ChatMessage['role'],
      content: String(m.content ?? ''),
    };
  });
  return {
    messages,
    estimatedInputTokens: requireNonNegativeFinite(
      raw.estimatedInputTokens,
      'frozenDraftRequest.estimatedInputTokens',
    ),
    reservedOutputTokens: requireNonNegativeFinite(
      raw.reservedOutputTokens,
      'frozenDraftRequest.reservedOutputTokens',
    ),
    safetyMargin: requireNonNegativeFinite(
      raw.safetyMargin,
      'frozenDraftRequest.safetyMargin',
    ),
    contextWindow: requireNonNegativeFinite(
      raw.contextWindow,
      'frozenDraftRequest.contextWindow',
    ),
    allocations: Array.isArray(raw.allocations)
      ? raw.allocations.map((a: unknown) => {
          if (!isPlainObject(a)) {
            return {
              id: 'unknown',
              requested: 0,
              allocated: 0,
              truncated: false,
            };
          }
          return {
            id: String(a.id ?? ''),
            requested: Number(a.requested) || 0,
            allocated: Number(a.allocated) || 0,
            truncated: Boolean(a.truncated),
          };
        })
      : [],
    requestFingerprint: String(raw.requestFingerprint || ''),
    chapterTitle: String(raw.chapterTitle || ''),
    prevEnding: String(raw.prevEnding || ''),
    userPrompt: String(raw.userPrompt || ''),
  };
}

function parseFrozenAuditCandidates(
  raw: unknown,
): FrozenAuditCandidates | null {
  if (raw == null) return null;
  if (!isPlainObject(raw)) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '冻结审核候选集合结构无效，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  const cfg = raw.contextConfig;
  if (!isPlainObject(cfg)) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '冻结审核候选集合缺少 contextConfig，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  return {
    episodicCandidates: Array.isArray(raw.episodicCandidates)
      ? raw.episodicCandidates.map((c: unknown) => {
          const row = isPlainObject(c) ? c : {};
          return {
            id: Number(row.id) || 0,
            position: Number(row.position) || 0,
            title: String(row.title || ''),
            memory_summary: String(row.memory_summary || ''),
          };
        })
      : [],
    characterCandidates: Array.isArray(raw.characterCandidates)
      ? raw.characterCandidates.map((c: unknown) => {
          const row = isPlainObject(c) ? c : {};
          return {
            id: Number(row.id) || 0,
            name: String(row.name || ''),
            cardText: String(row.cardText || ''),
          };
        })
      : [],
    worldbookCandidates: Array.isArray(raw.worldbookCandidates)
      ? raw.worldbookCandidates.map((c: unknown) => {
          const row = isPlainObject(c) ? c : {};
          return {
            id: row.id == null ? null : Number(row.id) || null,
            keywords: Array.isArray(row.keywords)
              ? row.keywords.map(String)
              : [],
            secondaryKeywords: Array.isArray(row.secondaryKeywords)
              ? row.secondaryKeywords.map(String)
              : [],
            content: String(row.content || ''),
            constant: Boolean(row.constant),
            position: Number(row.position) || 0,
          };
        })
      : [],
    contextConfig: {
      strategy: (cfg.strategy as any) || 'sliding',
      slidingWindowSize: Number(cfg.slidingWindowSize) || 0,
      customRangeStart: Number(cfg.customRangeStart) || 0,
      customRangeEnd: Number(cfg.customRangeEnd) || -1,
      resourceBudget: Number(cfg.resourceBudget) || 0,
      includeResources: Boolean(cfg.includeResources),
      summaryBudgetTokens:
        cfg.summaryBudgetTokens != null
          ? Number(cfg.summaryBudgetTokens)
          : undefined,
      storyStateBudgetTokens:
        cfg.storyStateBudgetTokens != null
          ? Number(cfg.storyStateBudgetTokens)
          : undefined,
      episodicMemoryBudgetTokens:
        cfg.episodicMemoryBudgetTokens != null
          ? Number(cfg.episodicMemoryBudgetTokens)
          : undefined,
      memoryTopK: cfg.memoryTopK != null ? Number(cfg.memoryTopK) : undefined,
      worldbookRecursive:
        cfg.worldbookRecursive != null
          ? Boolean(cfg.worldbookRecursive)
          : undefined,
      resourceDetailIntensity:
        cfg.resourceDetailIntensity === 'save' ||
        cfg.resourceDetailIntensity === 'rich'
          ? cfg.resourceDetailIntensity
          : cfg.resourceDetailIntensity === 'balanced'
            ? 'balanced'
            : undefined,
    },
    chapterPosition: Number(raw.chapterPosition) || 0,
    chapterTitle: String(raw.chapterTitle || ''),
    chapterSynopsis: String(raw.chapterSynopsis || ''),
    rawChapterIds: Array.isArray(raw.rawChapterIds)
      ? raw.rawChapterIds.map((n: unknown) => Number(n) || 0)
      : [],
    storyStateText: String(raw.storyStateText || ''),
    // Stability Phase 5 — tolerant passthrough of pool-capture warnings.
    captureWarnings: Array.isArray(raw.captureWarnings)
      ? raw.captureWarnings.map(String).filter(Boolean)
      : undefined,
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

export interface PipelineTaskContextOwnership {
  expectedProjectId?: number;
  expectedChapterId?: number;
  expectedTaskId?: string;
}

const REQUIRED_SNAPSHOT_STRING_FIELDS: (keyof PipelineContextSnapshot)[] = [
  'presetText',
  'storyMemoryText',
  'characterText',
  'noteText',
  'worldbookText',
  'episodicMemoryText',
  'recentBridgeText',
  'currentInstructionText',
  'retrievalUserPrompt',
  'outlineText',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireNonNegativeFinite(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      `流水线上下文快照字段 ${field} 非法，已阻止恢复。请重新开始生成。`,
      'restart_task',
    );
  }
  return n;
}

function parseWritingScenario(
  value: unknown,
  field: string,
): WritingScenario {
  if (value === 'outline' || value === 'continuation') return value;
  throw new OutlineContextError(
    'OUTLINE_SNAPSHOT_INVALID',
    `Writing Trace 字段 ${field} 非法，已阻止恢复。请重新开始生成。`,
    'restart_task',
  );
}

function parseTraceStringList(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw) || raw.some(value => typeof value !== 'string')) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      `Writing Trace 字段 ${field} 非法，已阻止恢复。请重新开始生成。`,
      'restart_task',
    );
  }
  return raw as string[];
}

function parseTraceCounter(raw: unknown, field: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      `Writing Trace 字段 ${field} 非法，已阻止恢复。请重新开始生成。`,
      'restart_task',
    );
  }
  return value;
}

function parseWritingSourceTrace(
  raw: unknown,
): WritingSourceTrace | undefined {
  if (raw == null) return undefined;
  if (!isPlainObject(raw)) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      'Writing Source Trace 结构无效，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  const sourceAdapter = raw.sourceAdapter;
  const sourceFingerprint = raw.sourceFingerprint;
  if (
    typeof sourceAdapter !== 'string' ||
    !sourceAdapter.trim() ||
    typeof sourceFingerprint !== 'string' ||
    !sourceFingerprint.trim()
  ) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      'Writing Source Trace 标识字段无效，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  const scenario = parseWritingScenario(raw.scenario, 'scenario');
  const sourceCandidateCount = parseTraceCounter(
    raw.sourceCandidateCount,
    'sourceCandidateCount',
  );
  const mandatoryCount = parseTraceCounter(raw.mandatoryCount, 'mandatoryCount');
  const preferredCount = parseTraceCounter(raw.preferredCount, 'preferredCount');
  const optionalCount = parseTraceCounter(raw.optionalCount, 'optionalCount');
  if (
    sourceCandidateCount !==
    mandatoryCount + preferredCount + optionalCount
  ) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      'Writing Source Trace 数量不一致，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  const legacyRestart =
    raw.legacyRestart == null
      ? undefined
      : isPlainObject(raw.legacyRestart) &&
        typeof raw.legacyRestart.restartedFromLegacyTaskId === 'string' &&
        raw.legacyRestart.restartedFromLegacyTaskId.trim()
      ? {
          restartedFromLegacyTaskId: raw.legacyRestart.restartedFromLegacyTaskId,
        }
      : (() => {
          throw new OutlineContextError(
            'OUTLINE_SNAPSHOT_INVALID',
            'Writing Source Trace legacyRestart 无效，已阻止恢复。请重新开始生成。',
            'restart_task',
          );
        })();
  return {
    scenario,
    sourceAdapter,
    sourceCandidateCount,
    mandatoryCount,
    preferredCount,
    optionalCount,
    sourceFingerprint,
    rejectedSources: parseTraceStringList(raw.rejectedSources, 'rejectedSources'),
    missingSources: parseTraceStringList(raw.missingSources, 'missingSources'),
    ...(legacyRestart ? { legacyRestart } : {}),
  };
}

const WRITING_KERNEL_STAGES = new Set([
  'collect',
  'normalize',
  'plan',
  'allocate',
  'render',
  'freeze',
  'draft',
  'review',
  'audit',
  'factCheck',
  'revision',
  'proof',
  'finalValidate',
  'persist',
  'postWritingUpdate',
]);

function parseWritingKernelTrace(raw: unknown): WritingKernelTrace | undefined {
  if (raw == null) return undefined;
  if (!isPlainObject(raw) || Number(raw.version) !== 1) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      'Writing Kernel Trace 结构或版本无效，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  const stringFields = [
    'writingRunId',
    'generationTraceId',
    'sourceFingerprint',
    'contextPlanFingerprint',
    'allocationFingerprint',
    'renderFingerprint',
    'freezeFingerprint',
  ] as const;
  for (const field of stringFields) {
    if (typeof raw[field] !== 'string' || !raw[field].trim()) {
      throw new OutlineContextError(
        'OUTLINE_SNAPSHOT_INVALID',
        `Writing Kernel Trace 字段 ${field} 无效，已阻止恢复。请重新开始生成。`,
        'restart_task',
      );
    }
  }
  const writingRunId = raw.writingRunId as string;
  const generationTraceId = raw.generationTraceId as string;
  const sourceFingerprint = raw.sourceFingerprint as string;
  const contextPlanFingerprint = raw.contextPlanFingerprint as string;
  const allocationFingerprint = raw.allocationFingerprint as string;
  const renderFingerprint = raw.renderFingerprint as string;
  const freezeFingerprint = raw.freezeFingerprint as string;
  if (!Array.isArray(raw.events)) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      'Writing Kernel Trace events 无效，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  const events = raw.events.map((event, index) => {
    if (
      !isPlainObject(event) ||
      typeof event.stage !== 'string' ||
      !WRITING_KERNEL_STAGES.has(event.stage) ||
      (event.status !== 'started' &&
        event.status !== 'completed' &&
        event.status !== 'blocked') ||
      (event.detail != null && typeof event.detail !== 'string')
    ) {
      throw new OutlineContextError(
        'OUTLINE_SNAPSHOT_INVALID',
        `Writing Kernel Trace events[${index}] 无效，已阻止恢复。请重新开始生成。`,
        'restart_task',
      );
    }
    return {
      stage: event.stage as WritingKernelTrace['events'][number]['stage'],
      status: event.status as WritingKernelTrace['events'][number]['status'],
      ...(typeof event.detail === 'string' ? { detail: event.detail } : {}),
    };
  });
  return {
    version: 1,
    writingRunId,
    generationTraceId,
    scenario: parseWritingScenario(raw.scenario, 'scenario'),
    sourceFingerprint,
    contextPlanFingerprint,
    allocationFingerprint,
    renderFingerprint,
    freezeFingerprint,
    ...(typeof raw.requirementsFingerprint === 'string'
      ? { requirementsFingerprint: raw.requirementsFingerprint }
      : {}),
    ...(typeof raw.stagePolicyFingerprint === 'string'
      ? { stagePolicyFingerprint: raw.stagePolicyFingerprint }
      : {}),
    events,
    silentContextLossCount: parseTraceCounter(
      raw.silentContextLossCount,
      'silentContextLossCount',
    ),
    unexpectedLiveReadCount: parseTraceCounter(
      raw.unexpectedLiveReadCount,
      'unexpectedLiveReadCount',
    ),
    fatalCount: parseTraceCounter(raw.fatalCount, 'fatalCount'),
    falseAppliedRequirementCount: parseTraceCounter(
      raw.falseAppliedRequirementCount,
      'falseAppliedRequirementCount',
    ),
  };
}

/**
 * The kernel freeze is part of the durable source boundary, not telemetry.
 * Keep it when parsing the snapshot so later audit/finalize serializations
 * cannot silently erase the immutable requirements and stage policy.
 */
function parseFrozenWritingContext(
  raw: unknown,
): FrozenWritingContext | undefined {
  if (raw == null) return undefined;
  if (!isPlainObject(raw) || Number(raw.version) !== 1) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      'Frozen Writing Context 结构或版本无效，已阻止恢复。',
      'restart_task',
    );
  }
  const requiredStrings = [
    'writingRunId',
    'generationTraceId',
    'sourceFingerprint',
    'freezeFingerprint',
  ] as const;
  for (const field of requiredStrings) {
    if (typeof raw[field] !== 'string' || !raw[field].trim()) {
      throw new OutlineContextError(
        'OUTLINE_SNAPSHOT_INVALID',
        `Frozen Writing Context 字段 ${field} 无效，已阻止恢复。`,
        'restart_task',
      );
    }
  }
  if (
    !isPlainObject(raw.instruction) ||
    !isPlainObject(raw.sourceBundle) ||
    !isPlainObject(raw.model) ||
    !isPlainObject(raw.policy) ||
    !isPlainObject(raw.requirements) ||
    !isPlainObject(raw.stagePolicy) ||
    !isPlainObject(raw.plan) ||
    !isPlainObject(raw.allocation) ||
    !isPlainObject(raw.rendered) ||
    !Array.isArray(raw.materials)
  ) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      'Frozen Writing Context 缺少完整的冻结输入，已阻止恢复。',
      'restart_task',
    );
  }
  if (
    Number(raw.requirements.version) !== 1 ||
    typeof raw.requirements.fingerprint !== 'string' ||
    !raw.requirements.fingerprint.trim() ||
    Number(raw.stagePolicy.version) !== 1 ||
    typeof raw.stagePolicy.requirementsFingerprint !== 'string' ||
    !raw.stagePolicy.requirementsFingerprint.trim()
  ) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      'Frozen Writing Context 的 Requirement/Policy 指纹无效，已阻止恢复。',
      'restart_task',
    );
  }
  return raw as unknown as FrozenWritingContext;
}

function parseFrozenWriterStyle(
  raw: unknown,
  code: 'OUTLINE_SNAPSHOT_INVALID' | 'OUTLINE_EXECUTION_CONFIG_INVALID',
): FrozenWriterStyleV1 {
  const fail = (field: string): never => {
    throw new OutlineContextError(
      code,
      `冻结作家风格字段 ${field} 非法，已阻止恢复。请重新开始生成。`,
      'restart_task',
    );
  };
  if (!isPlainObject(raw)) {
    throw new OutlineContextError(
      code,
      '冻结作家风格结构无效，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  if (Number(raw.semanticVersion) !== 1) fail('semanticVersion');
  if (
    raw.assetId != null &&
    (!Number.isInteger(Number(raw.assetId)) || Number(raw.assetId) < 0)
  ) {
    fail('assetId');
  }
  if (typeof raw.assetName !== 'string' || typeof raw.sourceFingerprint !== 'string') {
    fail('assetName/sourceFingerprint');
  }
  const sourceFormats = [
    'shinewriter',
    'legacy_shinewriter',
    'sillytavern_openai',
    'default_runtime_baseline',
  ];
  if (!sourceFormats.includes(String(raw.sourceFormat))) fail('sourceFormat');

  const sampler = isPlainObject(raw.samplerResolution)
    ? raw.samplerResolution
    : fail('samplerResolution');
  for (const field of [
    'temperature',
    'topP',
    'frequencyPenalty',
    'presencePenalty',
    'seed',
  ]) {
    if (
      sampler[field] != null &&
      (typeof sampler[field] !== 'number' || !Number.isFinite(sampler[field]))
    ) {
      fail(`samplerResolution.${field}`);
    }
  }
  if (
    !Array.isArray(sampler.preservedFields) ||
    !sampler.preservedFields.every((value: unknown) => typeof value === 'string') ||
    !Array.isArray(sampler.ignoredAtPipeline) ||
    !sampler.ignoredAtPipeline.every((value: unknown) => typeof value === 'string')
  ) {
    fail('samplerResolution.fields');
  }

  const projections = isPlainObject(raw.stageProjections)
    ? raw.stageProjections
    : fail('stageProjections');
  const stages = ['draft', 'review', 'factCheck', 'brief', 'proof'] as const;
  const modes = ['FULL', 'EVALUATION', 'HARD', 'MINIMAL'];
  for (const stage of stages) {
    const projectionValue = projections[stage];
    if (!isPlainObject(projectionValue)) {
      fail(`stageProjections.${stage}`);
    }
    const projection = projectionValue as Record<string, unknown>;
    if (
      projection.stage !== stage ||
      !modes.includes(String(projection.mode)) ||
      projection.protected !== true ||
      typeof projection.text !== 'string' ||
      typeof projection.compilerVersion !== 'string'
    ) {
      fail(`stageProjections.${stage}`);
    }
    const estimatedTokens = Number(projection.estimatedTokens);
    if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0) {
      fail(`stageProjections.${stage}.estimatedTokens`);
    }
  }

  if (raw.semantic != null) {
    const semantic = isPlainObject(raw.semantic)
      ? raw.semantic
      : fail('semantic');
    if (Number(semantic.version) !== 1) {
      fail('semantic');
    }
    for (const field of [
      'applicability',
      'narration',
      'language',
      'sceneAndCharacter',
      'narrativeMechanics',
      'literaryTexture',
    ]) {
      if (!isPlainObject(semantic[field])) fail(`semantic.${field}`);
    }
    for (const field of ['prohibitions', 'extraInstructions']) {
      if (
        semantic[field] != null &&
        (!Array.isArray(semantic[field]) ||
          !semantic[field].every((value: unknown) => typeof value === 'string'))
      ) {
        fail(`semantic.${field}`);
      }
    }
  }
  for (const field of [
    'legacySystemText',
    'legacyWritingStyleText',
    'legacyExtraInstructionsText',
    'compatibilityFingerprint',
  ]) {
    if (raw[field] != null && typeof raw[field] !== 'string') fail(field);
  }
  if (raw.compatibilitySummary != null) {
    const compatibilitySummary = isPlainObject(raw.compatibilitySummary)
      ? raw.compatibilitySummary
      : fail('compatibilitySummary');
    for (const field of [
      'promptCount',
      'injectedCount',
      'handledByModuleCount',
      'preservedCount',
      'unknownFieldCount',
    ]) {
      if (
        !Number.isInteger(Number(compatibilitySummary[field])) ||
        Number(compatibilitySummary[field]) < 0
      ) {
        fail(`compatibilitySummary.${field}`);
      }
    }
  }
  return raw as unknown as FrozenWriterStyleV1;
}

function parseOutlineIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '流水线上下文快照 outlineIds 非法，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  const ids: number[] = [];
  for (const item of value) {
    const n = Number(item);
    if (!Number.isInteger(n) || n < 0) {
      throw new OutlineContextError(
        'OUTLINE_SNAPSHOT_INVALID',
        '流水线上下文快照 outlineIds 含非法值，已阻止恢复。请重新开始生成。',
        'restart_task',
      );
    }
    ids.push(n);
  }
  return ids;
}

function assertOwnership(
  snap: PipelineContextSnapshot,
  ownership?: PipelineTaskContextOwnership,
): void {
  if (!ownership) return;
  if (
    ownership.expectedProjectId != null &&
    snap.projectId != null &&
    Number(snap.projectId) !== Number(ownership.expectedProjectId)
  ) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '流水线上下文快照项目不匹配，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  if (
    ownership.expectedChapterId != null &&
    snap.chapterId != null &&
    Number(snap.chapterId) !== Number(ownership.expectedChapterId)
  ) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '流水线上下文快照章节不匹配，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
}

/**
 * Strict validation of a PipelineContextSnapshot payload.
 * Throws OutlineContextError on any structural problem.
 */
export function parsePipelineContextSnapshotStrict(
  raw: unknown,
  ownership?: PipelineTaskContextOwnership,
): PipelineContextSnapshot {
  if (!isPlainObject(raw)) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '流水线上下文快照结构无效，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }

  for (const field of REQUIRED_SNAPSHOT_STRING_FIELDS) {
    if (typeof raw[field] !== 'string') {
      throw new OutlineContextError(
        'OUTLINE_SNAPSHOT_INVALID',
        `流水线上下文快照缺少字段 ${String(
          field,
        )}，已阻止恢复。请重新开始生成。`,
        'restart_task',
      );
    }
  }

  if (typeof raw.outlineFingerprint !== 'string') {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '流水线上下文快照缺少大纲指纹，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  if (typeof raw.outlineComplete !== 'boolean') {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '流水线上下文快照 outlineComplete 非法，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }

  const outlineIds = parseOutlineIds(raw.outlineIds);
  const outlineEstimatedTokens = requireNonNegativeFinite(
    raw.outlineEstimatedTokens ?? 0,
    'outlineEstimatedTokens',
  );

  if (
    raw.snapshotVersion != null &&
    Number(raw.snapshotVersion) !== PIPELINE_CONTEXT_SNAPSHOT_VERSION
  ) {
    // Content snapshot version is currently fixed at 1; reject unknown.
    if (
      Number(raw.snapshotVersion) !== 1 &&
      Number(raw.snapshotVersion) !== 3 &&
      Number(raw.snapshotVersion) !== PIPELINE_CONTEXT_SNAPSHOT_VERSION_V4 &&
      Number(raw.snapshotVersion) !== PIPELINE_CONTEXT_SNAPSHOT_VERSION_V5
    ) {
      throw new OutlineContextError(
        'OUTLINE_SNAPSHOT_INVALID',
        `不支持的上下文内容版本 ${String(
          raw.snapshotVersion,
        )}，已阻止恢复。请重新开始生成。`,
        'restart_task',
      );
    }
  }

  let contextBudgetV3Summary: ContextBudgetV3Summary | undefined;
  const rawBudgetSummary = raw.contextBudgetV3Summary;
  if (isPlainObject(rawBudgetSummary)) {
    const summaryPolicy = rawBudgetSummary.contextAutomationPolicySnapshot;
    const summaryHash = rawBudgetSummary.contextAutomationPolicyHash;
    if (
      Number(rawBudgetSummary.contextBudgetVersion) === 6 &&
      rawBudgetSummary.contextAutomationPolicyVersion ===
        'context-automation-v3' &&
      isContextAutomationPolicyV3(summaryPolicy) &&
      typeof summaryHash === 'string' &&
      summaryHash === hashContextAutomationPolicyV3(summaryPolicy)
    ) {
      contextBudgetV3Summary = rawBudgetSummary as unknown as ContextBudgetV3Summary;
    }
  }

  let generationContract: PipelineContextSnapshot['generationContract'];
  if (raw.generationContract != null) {
    try {
      generationContract = parseFrozenGenerationContextContract(
        raw.generationContract,
      );
    } catch (error: any) {
      const contractFingerprintMismatch = String(error?.message || '').includes(
        'GENERATION_CONTRACT_FINGERPRINT_MISMATCH',
      );
      throw new OutlineContextError(
        contractFingerprintMismatch
          ? 'SNAPSHOT_FINGERPRINT_MISMATCH'
          : 'OUTLINE_SNAPSHOT_INVALID',
        `冻结 Generation Candidate/Budget/Render Contract 无效：${String(
          error?.message || error,
        )}`,
        'restart_task',
      );
    }
  }

  const snap: PipelineContextSnapshot = {
    presetText: String(raw.presetText),
    storyMemoryText: String(raw.storyMemoryText),
    characterText: String(raw.characterText),
    noteText: String(raw.noteText),
    worldbookText: String(raw.worldbookText),
    episodicMemoryText: String(raw.episodicMemoryText),
    recentBridgeText: String(raw.recentBridgeText),
    currentInstructionText: String(raw.currentInstructionText),
    retrievalUserPrompt: String(raw.retrievalUserPrompt),
    outlineText: String(raw.outlineText),
    outlineFingerprint: String(raw.outlineFingerprint),
    outlineIds,
    outlineComplete: Boolean(raw.outlineComplete),
    outlineEstimatedTokens,
    projectId:
      raw.projectId != null && Number.isFinite(Number(raw.projectId))
        ? Number(raw.projectId)
        : undefined,
    chapterId:
      raw.chapterId != null && Number.isFinite(Number(raw.chapterId))
        ? Number(raw.chapterId)
        : undefined,
    chapterUpdatedAt:
      raw.chapterUpdatedAt != null
        ? (raw.chapterUpdatedAt as string | number)
        : undefined,
    createdAt:
      raw.createdAt != null && Number.isFinite(Number(raw.createdAt))
        ? Number(raw.createdAt)
        : undefined,
    snapshotVersion:
      raw.snapshotVersion == null || Number(raw.snapshotVersion) === 1
        ? 1
        : Number(raw.snapshotVersion) === PIPELINE_CONTEXT_SNAPSHOT_VERSION_V5
        ? PIPELINE_CONTEXT_SNAPSHOT_VERSION_V5
        : Number(raw.snapshotVersion) === PIPELINE_CONTEXT_SNAPSHOT_VERSION_V4
        ? PIPELINE_CONTEXT_SNAPSHOT_VERSION_V4
        : 3,
    immediatePreviousChapterText:
      typeof raw.immediatePreviousChapterText === 'string'
        ? raw.immediatePreviousChapterText
        : undefined,
    immediatePreviousChapterEnding:
      typeof raw.immediatePreviousChapterEnding === 'string'
        ? raw.immediatePreviousChapterEnding
        : undefined,
    immediatePreviousChapterId:
      raw.immediatePreviousChapterId != null &&
      Number.isFinite(Number(raw.immediatePreviousChapterId))
        ? Number(raw.immediatePreviousChapterId)
        : undefined,
    immediatePreviousChapterPosition:
      raw.immediatePreviousChapterPosition != null &&
      Number.isFinite(Number(raw.immediatePreviousChapterPosition))
        ? Number(raw.immediatePreviousChapterPosition)
        : undefined,
    sourceFingerprint:
      typeof raw.sourceFingerprint === 'string'
        ? raw.sourceFingerprint
        : undefined,
    outlineBlockingReason:
      typeof raw.outlineBlockingReason === 'string'
        ? raw.outlineBlockingReason
        : undefined,
    ...(contextBudgetV3Summary ? { contextBudgetV3Summary } : {}),
    resourceContextVersion:
      Number(raw.resourceContextVersion) === 2 ? 2 : Number(raw.resourceContextVersion) === 1 ? 1 : undefined,
    characterAwarenessText:
      typeof raw.characterAwarenessText === 'string'
        ? raw.characterAwarenessText
        : undefined,
    worldbookAwarenessText:
      typeof raw.worldbookAwarenessText === 'string'
        ? raw.worldbookAwarenessText
        : undefined,
    globalResourceAwarenessText:
      typeof raw.globalResourceAwarenessText === 'string'
        ? raw.globalResourceAwarenessText
        : undefined,
    resourceAwarenessItems: Array.isArray(raw.resourceAwarenessItems)
      ? (raw.resourceAwarenessItems as PipelineContextSnapshot['resourceAwarenessItems'])
      : undefined,
    resourceDetailItems: Array.isArray(raw.resourceDetailItems)
      ? (raw.resourceDetailItems as PipelineContextSnapshot['resourceDetailItems'])
      : undefined,
    resourceSelectionTrace: Array.isArray(raw.resourceSelectionTrace)
      ? (raw.resourceSelectionTrace as PipelineContextSnapshot['resourceSelectionTrace'])
      : undefined,
    presetSystemText:
      typeof raw.presetSystemText === 'string' ? raw.presetSystemText : undefined,
    presetWritingStyleText:
      typeof raw.presetWritingStyleText === 'string'
        ? raw.presetWritingStyleText
        : undefined,
    presetExtraInstructionsText:
      typeof raw.presetExtraInstructionsText === 'string'
        ? raw.presetExtraInstructionsText
        : undefined,
    presetSourceFingerprint:
      typeof raw.presetSourceFingerprint === 'string'
        ? raw.presetSourceFingerprint
        : undefined,
    presetSource:
      raw.presetSource === 'user_selected' ||
      raw.presetSource === 'default_runtime_baseline'
        ? raw.presetSource
        : undefined,
    includeResources:
      typeof raw.includeResources === 'boolean' ? raw.includeResources : undefined,
    resourcesDisabledWarning:
      typeof raw.resourcesDisabledWarning === 'string'
        ? raw.resourcesDisabledWarning
        : undefined,
    ...(isPlainObject(raw.contextBudgetV7Summary)
      ? {
          contextBudgetV7Summary:
            raw.contextBudgetV7Summary as unknown as PipelineContextSnapshot['contextBudgetV7Summary'],
        }
      : {}),
    // Stability Phase 5 — tolerant passthrough of structured diagnostics.
    stabilityDiagnostics: parseStabilityDiagnostics(raw.stabilityDiagnostics),
    stageTimings: parseStageTimings(raw.stageTimings),
    ...(generationContract ? { generationContract } : {}),
    ...(Number(raw.snapshotVersion) === PIPELINE_CONTEXT_SNAPSHOT_VERSION_V5
      ? {
          writerStyleSnapshot: parseFrozenWriterStyle(
            raw.writerStyleSnapshot,
            'OUTLINE_SNAPSHOT_INVALID',
          ),
        }
      : {}),
    ...(raw.writingSourceTrace != null
      ? { writingSourceTrace: parseWritingSourceTrace(raw.writingSourceTrace) }
      : {}),
    ...(raw.writingKernelTrace != null
      ? { writingKernelTrace: parseWritingKernelTrace(raw.writingKernelTrace) }
      : {}),
    ...(raw.frozenWritingContext != null
      ? {
          frozenWritingContext: parseFrozenWritingContext(
            raw.frozenWritingContext,
          ),
        }
      : {}),
  };

  assertOwnership(snap, ownership);
  return snap;
}

function parseStabilityDiagnostics(
  raw: unknown,
): PipelineContextSnapshot['stabilityDiagnostics'] {
  if (!Array.isArray(raw)) return undefined;
  const out: NonNullable<PipelineContextSnapshot['stabilityDiagnostics']> = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const severity = String(item.severity);
    if (
      severity !== 'info' &&
      severity !== 'warning' &&
      severity !== 'error' &&
      severity !== 'blocking'
    ) {
      continue;
    }
    const code = String(item.code ?? '');
    if (!code) continue;
    out.push({
      code,
      severity,
      message: String(item.message ?? ''),
      stage: item.stage != null ? String(item.stage) : undefined,
      source: item.source != null ? String(item.source) : undefined,
      detail: isPlainObject(item.detail)
        ? (item.detail as Record<string, unknown>)
        : undefined,
    });
  }
  return out.length > 0 ? out : undefined;
}

function parseFrozenPreset(raw: unknown): FrozenPresetSnapshot | null {
  if (raw == null) return null;
  if (!isPlainObject(raw)) {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      '冻结作家风格结构无效，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  return {
    id: raw.id == null ? null : Number(raw.id),
    name: typeof raw.name === 'string' ? raw.name : undefined,
    system_prompt: String(raw.system_prompt ?? ''),
    writing_style: String(raw.writing_style ?? ''),
    extra_instructions: String(raw.extra_instructions ?? ''),
    temperature: Number(raw.temperature ?? 0.7),
    top_p: Number(raw.top_p ?? 0.9),
    max_tokens: Number(raw.max_tokens ?? 0),
  };
}

function parseFrozenModel(raw: unknown): FrozenModelSnapshot {
  if (!isPlainObject(raw)) {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      '冻结模型配置结构无效，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  const contextWindow = Number(raw.contextWindow);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      '冻结模型窗口无效，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  const llmConfigId = Number(raw.llmConfigId);
  if (!Number.isInteger(llmConfigId) || llmConfigId <= 0) {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      '冻结模型 ID 无效，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  const thinkingRaw = isPlainObject(raw.thinking) ? raw.thinking : null;
  const thinkingType =
    thinkingRaw &&
    (thinkingRaw.type === 'enabled' || thinkingRaw.type === 'disabled')
      ? thinkingRaw.type
      : undefined;
  return {
    llmConfigId,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
    modelName: String(raw.modelName ?? ''),
    contextWindow,
    maxOutputTokens:
      raw.maxOutputTokens != null &&
      Number.isFinite(Number(raw.maxOutputTokens))
        ? Number(raw.maxOutputTokens)
        : undefined,
    url: typeof raw.url === 'string' ? raw.url : undefined,
    allowInsecureLanHttp:
      typeof raw.allowInsecureLanHttp === 'boolean'
        ? raw.allowInsecureLanHttp
        : undefined,
    thinking: thinkingType ? { type: thinkingType } : undefined,
  };
}

const VALID_MODES: PipelineMode[] = [
  'noReview',
  'twoStage',
  'conditional',
  'full',
];

export function parsePipelineExecutionSnapshot(
  raw: unknown,
): PipelineExecutionSnapshot {
  if (!isPlainObject(raw)) {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      '冻结执行配置结构无效，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  const mode = String(raw.pipelineMode || '');
  if (!VALID_MODES.includes(mode as PipelineMode)) {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      `不支持的流水线模式 ${mode}，已阻止恢复。请重新开始生成。`,
      'restart_task',
    );
  }
  const createdAt = Number(raw.createdAt);
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      '冻结执行配置时间戳非法，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  const workflowVersionRaw = raw.outlineWorkflowVersion;
  let outlineWorkflowVersion: 1 | 2 | 3 | 4 | undefined;
  if (
    workflowVersionRaw === 1 ||
    workflowVersionRaw === 2 ||
    workflowVersionRaw === 3 ||
    workflowVersionRaw === 4 ||
    workflowVersionRaw === '1' ||
    workflowVersionRaw === '2' ||
    workflowVersionRaw === '3' ||
    workflowVersionRaw === '4'
  ) {
    outlineWorkflowVersion = Number(workflowVersionRaw) as 1 | 2 | 3 | 4;
  } else if (workflowVersionRaw != null && workflowVersionRaw !== '') {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      `不支持的流水线工作流版本 ${String(
        workflowVersionRaw,
      )}，已阻止恢复。请重新开始生成。`,
      'restart_task',
    );
  }
  const reasoningPolicyRaw = raw.finalReviserReasoningPolicyVersion;
  let finalReviserReasoningPolicyVersion: 1 | 2 | 3 | undefined;
  if (
    reasoningPolicyRaw === 1 ||
    reasoningPolicyRaw === 2 ||
    reasoningPolicyRaw === 3 ||
    reasoningPolicyRaw === '1' ||
    reasoningPolicyRaw === '2' ||
    reasoningPolicyRaw === '3'
  ) {
    finalReviserReasoningPolicyVersion = Number(reasoningPolicyRaw) as
      | 1
      | 2
      | 3;
  } else if (reasoningPolicyRaw != null && reasoningPolicyRaw !== '') {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      `不支持的终稿推理策略版本 ${String(
        reasoningPolicyRaw,
      )}，已阻止恢复。请重新开始生成。`,
      'restart_task',
    );
  }
  const reasoningEffortRaw = raw.reasoningEffort;
  let reasoningEffort: PipelineReasoningEffort | undefined;
  if (
    reasoningEffortRaw === 'low' ||
    reasoningEffortRaw === 'medium' ||
    reasoningEffortRaw === 'high' ||
    reasoningEffortRaw === 'max'
  ) {
    reasoningEffort = reasoningEffortRaw as PipelineReasoningEffort;
  } else if (reasoningEffortRaw != null && reasoningEffortRaw !== '') {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      `不支持的流水线思考强度 ${String(
        reasoningEffortRaw,
      )}，已阻止恢复。请重新开始生成。`,
      'restart_task',
    );
  }
  // One-Shot (极速) execution profile. Absent on historical snapshots means
  // the standard multi-stage pipeline. Unknown values fail closed so a
  // corrupted tier can never silently re-enable paid audit stages.
  const executionProfileRaw = raw.executionProfile;
  let executionProfile: 'standard' | 'one_shot' | undefined;
  if (
    executionProfileRaw === 'one_shot' ||
    executionProfileRaw === 'standard'
  ) {
    executionProfile = executionProfileRaw;
  } else if (executionProfileRaw != null && executionProfileRaw !== '') {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      `不支持的执行档位 ${String(
        executionProfileRaw,
      )}，已阻止恢复。请重新开始生成。`,
      'restart_task',
    );
  }
  const contextBudgetRaw = raw.contextBudgetVersion;
  let contextBudgetVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | undefined;
  if (
    contextBudgetRaw === 1 ||
    contextBudgetRaw === 2 ||
    contextBudgetRaw === 3 ||
    contextBudgetRaw === 4 ||
    contextBudgetRaw === 5 ||
    contextBudgetRaw === 6 ||
    contextBudgetRaw === 7 ||
    contextBudgetRaw === '1' ||
    contextBudgetRaw === '2' ||
    contextBudgetRaw === '3' ||
    contextBudgetRaw === '4' ||
    contextBudgetRaw === '5' ||
    contextBudgetRaw === '6' ||
    contextBudgetRaw === '7'
  ) {
    contextBudgetVersion = Number(contextBudgetRaw) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
  } else if (contextBudgetRaw != null && contextBudgetRaw !== '') {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      `不支持的上下文预算版本 ${String(
        contextBudgetRaw,
      )}，已阻止恢复。请重新开始生成。`,
      'restart_task',
    );
  }

  const isStructuredWorkflow =
    outlineWorkflowVersion === 3 || outlineWorkflowVersion === 4;
  const isCurrentWorkflow = outlineWorkflowVersion === 4;
  if (
    isStructuredWorkflow &&
    (isCurrentWorkflow
      ? !isCurrentOutlinePipelineContextBudgetVersion(contextBudgetVersion)
      : contextBudgetVersion !== 3 && contextBudgetVersion !== 4)
  ) {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      isCurrentWorkflow
        ? '当前统一流水线必须与上下文预算版本 5/6/7 成对冻结，已阻止恢复。'
        : '工作流版本 3 必须与上下文预算版本 3/4 成对冻结，已阻止恢复。',
      'restart_task',
    );
  }

  let v3Fields: Partial<PipelineExecutionSnapshot> = {};
  if (isStructuredWorkflow) {
    if (
      (isCurrentWorkflow
        ? !isCurrentOutlinePipelineContextBudgetVersion(contextBudgetVersion)
        : contextBudgetVersion !== 3 && contextBudgetVersion !== 4) ||
      finalReviserReasoningPolicyVersion !== 3
    ) {
      throw new OutlineContextError(
        'OUTLINE_EXECUTION_CONFIG_INVALID',
        isCurrentWorkflow
          ? '当前统一流水线的冻结配置 context budget / Final policy 版本不完整，已阻止恢复。'
          : '工作流版本 3 的冻结配置 context budget / Final policy 版本不完整，已阻止恢复。',
        'restart_task',
      );
    }
    const reasoningProfileVersion: 2 | 3 | 4 | 5 | null =
      raw.reasoningProfileVersion === 5 || raw.reasoningProfileVersion === '5'
        ? 5
        : raw.reasoningProfileVersion === 4 || raw.reasoningProfileVersion === '4'
        ? 4
        : raw.reasoningProfileVersion === 3 || raw.reasoningProfileVersion === '3'
        ? 3
        : raw.reasoningProfileVersion === 2 ||
          raw.reasoningProfileVersion === '2'
        ? 2
        : null;
    if (reasoningProfileVersion == null) {
      throw new OutlineContextError(
        'OUTLINE_EXECUTION_CONFIG_INVALID',
        isCurrentWorkflow
          ? '当前统一流水线冻结配置缺少 reasoningProfileVersion=5，已阻止恢复。'
          : 'V3 冻结配置缺少有效 reasoningProfileVersion（2/3/4），已阻止恢复。',
        'restart_task',
      );
    }
    if (isCurrentWorkflow && reasoningProfileVersion !== 5) {
      throw new OutlineContextError(
        'OUTLINE_EXECUTION_CONFIG_INVALID',
        '当前统一流水线必须使用 reasoningProfileVersion=5，已阻止恢复。',
        'restart_task',
      );
    }
    if (!isCurrentWorkflow && reasoningProfileVersion === 5) {
      throw new OutlineContextError(
        'OUTLINE_EXECUTION_CONFIG_INVALID',
        '历史 V3 流水线不能使用当前 reasoningProfileVersion=5，已阻止恢复。',
        'restart_task',
      );
    }
    if (
      (reasoningProfileVersion === 3 && contextBudgetVersion !== 3) ||
      (reasoningProfileVersion === 2 && contextBudgetVersion !== 3)
    ) {
      throw new OutlineContextError(
        'OUTLINE_EXECUTION_CONFIG_INVALID',
        'V3.1/V3 legacy reasoning profile 必须与 context budget 3 成对冻结，已阻止恢复。',
        'restart_task',
      );
    }
    if (!isPipelineReasoningTier(raw.requestedReasoningTier)) {
      throw new OutlineContextError(
        'OUTLINE_EXECUTION_CONFIG_INVALID',
        'V3 冻结配置缺少 requestedReasoningTier，已阻止恢复。',
        'restart_task',
      );
    }
    if (!isPlainObject(raw.stageReasoning)) {
      throw new OutlineContextError(
        'OUTLINE_EXECUTION_CONFIG_INVALID',
        'V3 冻结配置缺少 stageReasoning，已阻止恢复。',
        'restart_task',
      );
    }
    const stageReasoning: Partial<
      Record<PipelineStageName, FrozenStageReasoning>
    > = {};
    for (const stage of [
      'draft',
      'review',
      'factCheck',
      'brief',
      'proof',
    ] as const) {
      const value = (raw.stageReasoning as Record<string, unknown>)[stage];
      if (
        !isPlainObject(value) ||
        !isPipelineReasoningTier(value.effectiveTier)
      ) {
        throw new OutlineContextError(
          'OUTLINE_EXECUTION_CONFIG_INVALID',
          `V3 冻结配置缺少 ${stage} 推理档位，已阻止恢复。`,
          'restart_task',
        );
      }
      stageReasoning[stage] = {
        stage,
        requestedTier: isPipelineReasoningTier(value.requestedTier)
          ? value.requestedTier
          : raw.requestedReasoningTier,
        effectiveTier: value.effectiveTier,
        thinking: value.thinking === 'disabled' ? 'disabled' : 'enabled',
        effort: isPipelineReasoningTier(value.effort) ? value.effort : null,
        supported:
          typeof value.supported === 'boolean' ? value.supported : undefined,
        downgradeReason:
          typeof value.downgradeReason === 'string'
            ? value.downgradeReason
            : undefined,
      };
    }
    const expectedBriefThinking =
      reasoningProfileVersion === 3 ? 'disabled' : 'enabled';
    const expectedBriefTier = isCurrentWorkflow
      ? (raw.requestedReasoningTier as PipelineReasoningTier)
      : 'low';
    if (
      stageReasoning.brief?.thinking !== expectedBriefThinking ||
      stageReasoning.brief.effectiveTier !== expectedBriefTier
    ) {
      throw new OutlineContextError(
        'OUTLINE_EXECUTION_CONFIG_INVALID',
        isCurrentWorkflow
          ? `当前统一流水线 Brief 必须冻结为 Thinking ${expectedBriefThinking} + ${expectedBriefTier}，已阻止恢复。`
          : `V3 Brief 必须冻结为 Thinking ${expectedBriefThinking} + low，已阻止恢复。`,
        'restart_task',
      );
    }
    const expectedBriefPolicyVersion =
      reasoningProfileVersion === 5
        ? 4
        : reasoningProfileVersion === 4
        ? 3
        : reasoningProfileVersion === 3
        ? 2
        : 1;
    if (
      raw.briefPolicyVersion !== expectedBriefPolicyVersion &&
      raw.briefPolicyVersion !== String(expectedBriefPolicyVersion)
    ) {
      throw new OutlineContextError(
        'OUTLINE_EXECUTION_CONFIG_INVALID',
        `V3 冻结配置缺少 briefPolicyVersion=${expectedBriefPolicyVersion}，已阻止恢复。`,
        'restart_task',
      );
    }
    if (
      reasoningProfileVersion === 5 &&
      (!isCurrentOutlinePipelineContextBudgetVersion(contextBudgetVersion) ||
        stageReasoning.draft?.effectiveTier !== raw.requestedReasoningTier ||
        stageReasoning.review?.effectiveTier !== raw.requestedReasoningTier ||
        stageReasoning.factCheck?.effectiveTier !== 'low' ||
        stageReasoning.proof?.effectiveTier !== raw.requestedReasoningTier ||
        stageReasoning.review?.thinking !== 'enabled' ||
        stageReasoning.factCheck?.thinking !== 'enabled' ||
        stageReasoning.brief?.thinking !== 'enabled')
    ) {
      throw new OutlineContextError(
        'OUTLINE_EXECUTION_CONFIG_INVALID',
        '当前统一流水线必须保持 Draft/Review/Brief/Proof 跟随用户档位、FactCheck 为 enabled + low，且使用 context budget 5/6，已阻止恢复。',
        'restart_task',
      );
    }
    if (
      reasoningProfileVersion === 3 &&
      (stageReasoning.review?.effectiveTier !== 'low' ||
        stageReasoning.factCheck?.effectiveTier !== 'low' ||
        stageReasoning.review?.thinking !== 'disabled' ||
        stageReasoning.factCheck?.thinking !== 'disabled')
    ) {
      throw new OutlineContextError(
        'OUTLINE_EXECUTION_CONFIG_INVALID',
        'V3.1 Review/FactCheck 必须冻结为 Thinking disabled + low，已阻止恢复。',
        'restart_task',
      );
    }
    if (
      reasoningProfileVersion === 4 &&
      (contextBudgetVersion !== 4 ||
        stageReasoning.review?.effectiveTier !== 'low' ||
        stageReasoning.factCheck?.effectiveTier !== 'low' ||
        stageReasoning.brief?.effectiveTier !== 'low' ||
        stageReasoning.review?.thinking !== 'enabled' ||
        stageReasoning.factCheck?.thinking !== 'enabled' ||
        stageReasoning.brief?.thinking !== 'enabled')
    ) {
      throw new OutlineContextError(
        'OUTLINE_EXECUTION_CONFIG_INVALID',
        'V3.2 Review/FactCheck/Brief 必须冻结为 Thinking enabled + low，且使用 context budget 4，已阻止恢复。',
        'restart_task',
      );
    }
    v3Fields = {
      reasoningProfileVersion,
      requestedReasoningTier:
        raw.requestedReasoningTier as PipelineReasoningTier,
      stageReasoning,
      briefPolicyVersion: expectedBriefPolicyVersion,
      briefVisibleOutputFloor: Number.isFinite(
        Number(raw.briefVisibleOutputFloor),
      )
        ? Number(raw.briefVisibleOutputFloor)
        : undefined,
      briefReasoningHeadroom: Number.isFinite(
        Number(raw.briefReasoningHeadroom),
      )
        ? Number(raw.briefReasoningHeadroom)
        : undefined,
      briefMaxTokens: Number.isFinite(Number(raw.briefMaxTokens))
        ? Number(raw.briefMaxTokens)
        : undefined,
      stageBudgets: Array.isArray(raw.stageBudgets)
        ? raw.stageBudgets.filter(isPlainObject).map(
            (value: Record<string, unknown>) =>
              ({
                stage: String(value.stage) as PipelineStageName,
                visibleOutputFloor: Number(value.visibleOutputFloor) || 0,
                reasoningHeadroom: Number(value.reasoningHeadroom) || 0,
                requestMaxTokens: Number(value.requestMaxTokens) || 0,
                estimatedMandatoryInput:
                  Number(value.estimatedMandatoryInput) || 0,
                optionalInputBudget: Number(value.optionalInputBudget) || 0,
                safetyMargin: Number(value.safetyMargin) || 0,
                softInputLimit: Number(value.softInputLimit) || undefined,
                hardInputLimit: Number(value.hardInputLimit) || undefined,
                fitsSoftInput:
                  typeof value.fitsSoftInput === 'boolean'
                    ? value.fitsSoftInput
                    : undefined,
                fitsModelOutput:
                  typeof value.fitsModelOutput === 'boolean'
                    ? value.fitsModelOutput
                    : undefined,
                localFallbackRecommended:
                  typeof value.localFallbackRecommended === 'boolean'
                    ? value.localFallbackRecommended
                    : undefined,
              } as FrozenStageBudgetV3),
          )
        : undefined,
    };
    const policyVersion = raw.contextAutomationPolicyVersion;
    const policySnapshot = raw.contextAutomationPolicySnapshot;
    const policyHash = raw.contextAutomationPolicyHash;
    if (
      policyVersion != null ||
      policySnapshot != null ||
      policyHash != null
    ) {
      if (
        contextBudgetVersion !== 6 ||
        policyVersion !== 'context-automation-v3' ||
        !isContextAutomationPolicyV3(policySnapshot) ||
        typeof policyHash !== 'string' ||
        policyHash !== hashContextAutomationPolicyV3(policySnapshot)
      ) {
        throw new OutlineContextError(
          'OUTLINE_EXECUTION_CONFIG_INVALID',
          'V3 冻结配置的上下文自动化策略/hash 不一致，已阻止恢复。',
          'restart_task',
        );
      }
      v3Fields = {
        ...v3Fields,
        contextAutomationPolicyVersion: 'context-automation-v3',
        contextAutomationPolicyHash: policyHash,
        contextAutomationPolicySnapshot: JSON.parse(
          JSON.stringify(policySnapshot),
        ) as ContextAutomationPolicyV3,
      };
    }
  }

  return {
    ...(raw.writerStyle != null
      ? {
          writerStyle: parseFrozenWriterStyle(
            raw.writerStyle,
            'OUTLINE_EXECUTION_CONFIG_INVALID',
          ),
        }
      : {}),
    pipelineMode: mode as PipelineMode,
    outlineWorkflowVersion,
    contextBudgetVersion,
    finalReviserReasoningPolicyVersion,
    reasoningEffort,
    ...(executionProfile ? { executionProfile } : {}),
    ...v3Fields,
    draftMaxTokens: requireNonNegativeFinite(
      raw.draftMaxTokens,
      'draftMaxTokens',
    ),
    reviewMaxTokens: requireNonNegativeFinite(
      raw.reviewMaxTokens,
      'reviewMaxTokens',
    ),
    factCheckMaxTokens: requireNonNegativeFinite(
      raw.factCheckMaxTokens,
      'factCheckMaxTokens',
    ),
    proofMaxTokens: requireNonNegativeFinite(
      raw.proofMaxTokens,
      'proofMaxTokens',
    ),
    draftPresetId:
      raw.draftPresetId == null || raw.draftPresetId === ''
        ? null
        : Number(raw.draftPresetId),
    reviewPresetId:
      raw.reviewPresetId == null || raw.reviewPresetId === ''
        ? null
        : Number(raw.reviewPresetId),
    factCheckPresetId:
      raw.factCheckPresetId == null || raw.factCheckPresetId === ''
        ? null
        : Number(raw.factCheckPresetId),
    proofPresetId:
      raw.proofPresetId == null || raw.proofPresetId === ''
        ? null
        : Number(raw.proofPresetId),
    draftPreset: parseFrozenPreset(raw.draftPreset),
    reviewPreset: parseFrozenPreset(raw.reviewPreset),
    factCheckPreset: parseFrozenPreset(raw.factCheckPreset),
    proofPreset: parseFrozenPreset(raw.proofPreset),
    model: parseFrozenModel(raw.model),
    createdAt,
  };
}

export function parsePipelineTaskContextV1(
  raw: unknown,
  ownership?: PipelineTaskContextOwnership,
): ParsedPipelineTaskContext {
  const draftContext = parsePipelineContextSnapshotStrict(raw, ownership);
  return {
    version: 1,
    draftContext,
    auditContext: null,
    execution: null,
    frozenDraftRequest: null,
    frozenAuditCandidates: null,
    trace: null,
    generationFingerprint: null,
    generationFingerprintVersion: null,
    createdAt: draftContext.createdAt ?? Date.now(),
  };
}

export function parsePipelineTaskContextV2(
  raw: unknown,
  ownership?: PipelineTaskContextOwnership,
): ParsedPipelineTaskContext {
  if (!isPlainObject(raw)) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '流水线上下文快照结构无效，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  if (Number(raw.version) !== 2) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      `不支持的流水线上下文版本 ${String(
        raw.version,
      )}，已阻止恢复。请重新开始生成。`,
      'restart_task',
    );
  }
  const draftContext = parsePipelineContextSnapshotStrict(
    raw.draftContext,
    ownership,
  );
  const auditContext =
    raw.auditContext != null
      ? parsePipelineContextSnapshotStrict(raw.auditContext, ownership)
      : null;
  const execution = parsePipelineExecutionSnapshot(raw.execution);
  const createdAt = Number(raw.createdAt);
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '流水线上下文快照时间戳非法，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  const frozenDraftRequest = parseFrozenDraftRequest(raw.frozenDraftRequest);
  const trace = parseTraceRecord(raw.trace);
  // Stability Phase 2 — verify the semantic fingerprint when the envelope
  // carries one. Mismatch means semantic content drifted from what was
  // frozen → fail closed (Plan §12 / §14 SNAPSHOT_FINGERPRINT_MISMATCH).
  let generationFingerprint: string | null = null;
  let generationFingerprintVersion: 1 | 2 | null = null;
  if (
    typeof raw.generationFingerprint === 'string' &&
    raw.generationFingerprint
  ) {
    const declaredFingerprintVersion =
      raw.generationFingerprintVersion == null
        ? 1
        : Number(raw.generationFingerprintVersion);
    if (declaredFingerprintVersion !== 1 && declaredFingerprintVersion !== 2) {
      throw new OutlineContextError(
        'OUTLINE_SNAPSHOT_INVALID',
        '生成语义指纹版本非法，已阻止恢复。请重新开始生成。',
        'restart_task',
      );
    }
    generationFingerprintVersion = declaredFingerprintVersion;
    try {
      generationFingerprint = computeGenerationFingerprint(
        declaredFingerprintVersion === 2
          ? buildGenerationFingerprintInputV2(
              draftContext,
              execution,
              frozenDraftRequest,
            )
          : buildGenerationFingerprintInput(
              draftContext,
              execution,
              frozenDraftRequest,
            ),
      );
    } catch (error: any) {
      throw new OutlineContextError(
        'OUTLINE_SNAPSHOT_INVALID',
        `生成语义指纹输入无效：${String(error?.message || error)}`,
        'restart_task',
      );
    }
    if (generationFingerprint !== raw.generationFingerprint) {
      throw new OutlineContextError(
        'SNAPSHOT_FINGERPRINT_MISMATCH',
        '生成语义指纹校验失败（冻结内容与指纹不一致），已阻止恢复。请重新开始生成。',
        'restart_task',
      );
    }
  }
  return {
    version: 2,
    draftContext,
    auditContext,
    execution,
    frozenDraftRequest,
    frozenAuditCandidates: parseFrozenAuditCandidates(
      raw.frozenAuditCandidates,
    ),
    trace,
    generationFingerprint,
    generationFingerprintVersion,
    createdAt,
    auditFellBack: Boolean(raw.auditFellBack),
  };
}

export function parsePipelineTaskContextV3(
  raw: unknown,
  ownership?: PipelineTaskContextOwnership,
): ParsedPipelineTaskContext {
  if (!isPlainObject(raw) || Number(raw.version) !== 3) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '不支持的 V3 流水线上下文版本，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  const parsed = parsePipelineTaskContextV2({ ...raw, version: 2 }, ownership);
  return { ...parsed, version: 3 };
}

export function parsePipelineTaskContextV4(
  raw: unknown,
  ownership?: PipelineTaskContextOwnership,
): ParsedPipelineTaskContext {
  if (!isPlainObject(raw) || Number(raw.version) !== 4) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '不支持的 V4 流水线上下文版本，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  const parsed = parsePipelineTaskContextV2({ ...raw, version: 2 }, ownership);
  return { ...parsed, version: 4 };
}

/**
 * Parse a persisted task context from DB columns. Supports V1 (bare snapshot)
 * and V2 (envelope). Strict ownership + integrity checks.
 */
export function parsePersistedPipelineTaskContext(
  task: {
    pipelineContextJson?: string | null;
    pipelineContextHash?: string | null;
    pipelineContextVersion?: number | null;
  },
  ownership?: PipelineTaskContextOwnership,
): ParsedPipelineTaskContext {
  const json = task.pipelineContextJson;
  if (!json || !String(json).trim()) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '旧任务没有冻结的流水线上下文快照，无法安全恢复。请重新开始生成。',
      'restart_task',
    );
  }
  if (task.pipelineContextHash) {
    const actual = sha256Hex(String(json)).slice(0, 32);
    if (actual !== task.pipelineContextHash) {
      throw new OutlineContextError(
        'OUTLINE_SNAPSHOT_INVALID',
        '流水线上下文快照校验失败（可能已损坏），已阻止恢复。请重新开始生成。',
        'restart_task',
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(json));
  } catch {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '流水线上下文快照 JSON 损坏，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }
  if (!isPlainObject(parsed)) {
    throw new OutlineContextError(
      'OUTLINE_SNAPSHOT_INVALID',
      '流水线上下文快照结构无效，已阻止恢复。请重新开始生成。',
      'restart_task',
    );
  }

  const declaredVersion =
    task.pipelineContextVersion != null
      ? Number(task.pipelineContextVersion)
      : isPlainObject(parsed) && parsed.version != null
      ? Number(parsed.version)
      : 1;

  if (declaredVersion === 4 || Number((parsed as any).version) === 4) {
    return parsePipelineTaskContextV4(parsed, ownership);
  }
  if (declaredVersion === 3 || Number((parsed as any).version) === 3) {
    return parsePipelineTaskContextV3(parsed, ownership);
  }
  if (declaredVersion === 2 || Number((parsed as any).version) === 2) {
    return parsePipelineTaskContextV2(parsed, ownership);
  }
  if (declaredVersion === 1 || declaredVersion === 0 || !declaredVersion) {
    // V1 bare snapshot (or pre-version field)
    return parsePipelineTaskContextV1(parsed, ownership);
  }
  throw new OutlineContextError(
    'OUTLINE_SNAPSHOT_INVALID',
    `不支持的流水线上下文版本 ${declaredVersion}，已阻止恢复。请重新开始生成。`,
    'restart_task',
  );
}

export function serializePipelineTaskContext(params: {
  draftContext: PipelineContextSnapshot;
  auditContext?: PipelineContextSnapshot | null;
  execution: PipelineExecutionSnapshot;
  frozenDraftRequest?: FrozenDraftRequest | null;
  frozenAuditCandidates?: FrozenAuditCandidates | null;
  trace?: GenerationTraceRecordV1 | null;
  createdAt?: number;
  draftCompletedAt?: number;
  auditContextCreatedAt?: number;
  auditFellBack?: boolean;
}): {
  pipelineContextJson: string;
  pipelineContextVersion: number;
  pipelineContextHash: string;
  /** Stability Phase 2 — semantic fingerprint embedded in the envelope. */
  generationFingerprint: string;
  generationFingerprintVersion: 1 | 2;
} {
  const createdAt = params.createdAt ?? Date.now();
  // Context builders now know about V3 fields, but a frozen V1/V2 execution
  // must still serialize with its historical envelope/compiler semantics.
  // The execution protocol, not a copied snapshot's current constant, owns
  // the envelope version.
  const isV3 =
    params.execution.outlineWorkflowVersion === 3 &&
    params.execution.contextBudgetVersion === 3;
  const isV32 =
    params.execution.outlineWorkflowVersion === 3 &&
    params.execution.contextBudgetVersion === 4;
  // Current unified pipeline (owv 4) covers budget 4 (V3.2), 5 (V2 elastic)
  // and 6 (V3 hierarchical) — all share snapshotVersion 4.
  const isV33 =
    params.execution.outlineWorkflowVersion === 4 &&
    (params.execution.contextBudgetVersion === 4 ||
      isCurrentOutlinePipelineContextBudgetVersion(
        params.execution.contextBudgetVersion,
      ));
  const hasV5WriterStyleSnapshot =
    params.draftContext.snapshotVersion === PIPELINE_CONTEXT_SNAPSHOT_VERSION_V5 ||
    params.draftContext.writerStyleSnapshot != null;
  const snapshotVersion = hasV5WriterStyleSnapshot
    ? PIPELINE_CONTEXT_SNAPSHOT_VERSION_V5
    : isV33 || isV32
    ? PIPELINE_CONTEXT_SNAPSHOT_VERSION_V4
    : isV3
    ? PIPELINE_CONTEXT_SNAPSHOT_VERSION
    : 1;
  const draftContext: PipelineContextSnapshot = {
    ...params.draftContext,
    snapshotVersion,
    createdAt: params.draftContext.createdAt ?? createdAt,
  };
  const envelope:
    | PersistedPipelineTaskContextV2
    | PersistedPipelineTaskContextV3
    | PersistedPipelineTaskContextV4 = {
    version: isV33 || isV32 ? 4 : isV3 ? 3 : 2,
    draftContext,
    execution: params.execution,
    createdAt,
  };
  if (params.auditContext) {
    envelope.auditContext = {
      ...params.auditContext,
      snapshotVersion,
      createdAt: params.auditContext.createdAt ?? Date.now(),
    };
  }
  if (params.frozenDraftRequest) {
    envelope.frozenDraftRequest = params.frozenDraftRequest;
  }
  if (params.frozenAuditCandidates) {
    envelope.frozenAuditCandidates = params.frozenAuditCandidates;
  }
  if (params.trace) {
    envelope.trace = params.trace;
  }
  // Stability Phase 2 — deterministic semantic fingerprint, embedded once.
  // Re-serialization (draft completion adds auditContext) recomputes the
  // identical value because the fingerprint covers semantic content only.
  const usesGenerationContract = draftContext.generationContract != null;
  if (usesGenerationContract) {
    envelope.generationFingerprintVersion = 2;
    envelope.generationFingerprint = computeGenerationFingerprint(
      buildGenerationFingerprintInputV2(
        draftContext,
        params.execution,
        params.frozenDraftRequest ?? null,
      ),
    );
  } else {
    envelope.generationFingerprintVersion = 1;
    envelope.generationFingerprint = computeGenerationFingerprint(
      buildGenerationFingerprintInput(
        draftContext,
        params.execution,
        params.frozenDraftRequest ?? null,
      ),
    );
  }
  if (params.draftCompletedAt != null) {
    envelope.draftCompletedAt = params.draftCompletedAt;
  }
  if (params.auditContextCreatedAt != null) {
    envelope.auditContextCreatedAt = params.auditContextCreatedAt;
  }
  if (params.auditFellBack) {
    envelope.auditFellBack = true;
  }
  const pipelineContextJson = JSON.stringify(envelope);
  return {
    pipelineContextJson,
    pipelineContextVersion:
      isV33 || isV32 ? 4 : isV3 ? 3 : PIPELINE_TASK_CONTEXT_VERSION,
    pipelineContextHash: sha256Hex(pipelineContextJson).slice(0, 32),
    generationFingerprint: envelope.generationFingerprint,
    generationFingerprintVersion: envelope.generationFingerprintVersion,
  };
}

function parseStageTimings(
  raw: unknown,
): PipelineContextSnapshot['stageTimings'] {
  if (!Array.isArray(raw)) return undefined;
  const timings: NonNullable<PipelineContextSnapshot['stageTimings']> = [];
  for (const item of raw) {
    if (!isPlainObject(item) || typeof item.stage !== 'string') continue;
    const durationMs = Number(item.durationMs);
    if (!Number.isFinite(durationMs) || durationMs < 0) continue;
    timings.push({
      stage: item.stage as NonNullable<PipelineContextSnapshot['stageTimings']>[number]['stage'],
      durationMs,
      ...(typeof item.note === 'string' ? { note: item.note } : {}),
    });
  }
  return timings.length > 0 ? timings : undefined;
}

/** Prefer audit context for full-mode review stages; else draft. */
export function resolveAuditContext(
  parsed: ParsedPipelineTaskContext,
): PipelineContextSnapshot {
  return parsed.auditContext || parsed.draftContext;
}

/**
 * Stability Phase 8 — the single sanctioned place where historical snapshot
 * shape is guessed from field presence (V5 writer-style projection). All
 * callers must use this adapter instead of re-deriving the guess inline, so
 * the legacy boundary stays at one edge (plan §10/§11).
 */
export function hasFrozenWriterStyleProjection(
  snapshot: PipelineContextSnapshot | null | undefined,
): snapshot is PipelineContextSnapshot {
  return Boolean(
    snapshot &&
      (snapshot.snapshotVersion ===
        (PIPELINE_CONTEXT_SNAPSHOT_VERSION_V5 as number) ||
        snapshot.writerStyleSnapshot != null),
  );
}

/**
 * Classify a cold-start / stale interrupted active task.
 * Recoverable only when there is a successful draft + a valid snapshot.
 */
export function classifyInterruptedTask(task: {
  status: string;
  stageResults?: Array<{ stage: string; status: string }>;
  pipelineContextJson?: string | null;
  pipelineContextHash?: string | null;
  pipelineContextVersion?: number | null;
  targetType?: string;
  targetId?: number;
}): {
  recoverable: boolean;
  reason: string;
  nextStatus: 'interrupted' | 'failed';
} {
  if (task.status === 'cancelled') {
    return {
      recoverable: false,
      reason: '用户已取消该任务',
      nextStatus: 'failed',
    };
  }

  const stages = task.stageResults || [];
  const hasDraft = stages.some(
    s => s.stage === 'draft' && s.status === 'success',
  );
  if (!hasDraft) {
    return {
      recoverable: false,
      reason: '运行被中断且没有成功的初稿，无法安全恢复。请重新开始生成。',
      nextStatus: 'failed',
    };
  }

  const json = task.pipelineContextJson;
  const hasPersistedSnapshotPointer =
    Boolean(task.pipelineContextHash && String(task.pipelineContextHash).trim()) &&
    task.pipelineContextVersion != null;
  if (!json || !String(json).trim()) {
    // List/summary rows omit the large snapshot on purpose. A stored hash +
    // version means the blob is still on disk — do not fail-closed or the
    // subsequent persistTask UPSERT historically wiped that blob with NULL.
    if (hasPersistedSnapshotPointer) {
      return {
        recoverable: true,
        reason: '运行被中断，可继续后续阶段',
        nextStatus: 'interrupted',
      };
    }
    return {
      recoverable: false,
      reason: '旧任务没有冻结的流水线上下文快照，无法安全恢复。请重新开始生成。',
      nextStatus: 'failed',
    };
  }

  try {
    parsePersistedPipelineTaskContext(
      {
        pipelineContextJson: json,
        pipelineContextHash: task.pipelineContextHash,
        pipelineContextVersion: task.pipelineContextVersion,
      },
      task.targetType === 'chapter' && task.targetId != null
        ? { expectedChapterId: task.targetId }
        : undefined,
    );
    return {
      recoverable: true,
      reason: '运行被中断，可继续后续阶段',
      nextStatus: 'interrupted',
    };
  } catch (error: any) {
    return {
      recoverable: false,
      reason:
        error?.message ||
        '运行被中断且上下文快照无法安全恢复。请重新开始生成。',
      nextStatus: 'failed',
    };
  }
}

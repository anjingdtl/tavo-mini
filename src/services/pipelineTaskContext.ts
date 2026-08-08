/**
 * Versioned pipeline task context envelope (draft + audit + execution).
 *
 * V1 (legacy Schema 38 first ship): pipeline_context_json is a bare
 * PipelineContextSnapshot.
 * V2: envelope with draftContext, optional auditContext, and frozen execution.
 */
import {
  PIPELINE_CONTEXT_SNAPSHOT_VERSION,
  type PipelineContextSnapshot,
} from '../types/pipelineContext';
import type {
  FrozenModelSnapshot,
  FrozenPresetSnapshot,
  PipelineExecutionSnapshot,
} from '../types/pipelineExecution';
import type {
  FrozenAuditCandidates,
  FrozenDraftRequest,
} from '../types/pipelineFrozen';
import type { PipelineMode } from '../types/pipeline';
import type { PipelineReasoningEffort } from '../types/pipeline';
import type { ChatMessage } from './llm';
import { OutlineContextError } from './outlineContextBuilder';
import { sha256Hex } from './continuation/hashUtils';

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
  createdAt: number;
  draftCompletedAt?: number;
  auditContextCreatedAt?: number;
  /** True when audit fell back to draftContext after post-draft retrieval failure. */
  auditFellBack?: boolean;
}

export interface ParsedPipelineTaskContext {
  version: 1 | 2;
  draftContext: PipelineContextSnapshot;
  auditContext: PipelineContextSnapshot | null;
  execution: PipelineExecutionSnapshot | null;
  frozenDraftRequest: FrozenDraftRequest | null;
  frozenAuditCandidates: FrozenAuditCandidates | null;
  createdAt: number;
  auditFellBack?: boolean;
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

function parseFrozenDraftRequest(
  raw: unknown,
): FrozenDraftRequest | null {
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
            return { id: 'unknown', requested: 0, allocated: 0, truncated: false };
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
      memoryTopK:
        cfg.memoryTopK != null ? Number(cfg.memoryTopK) : undefined,
      worldbookRecursive:
        cfg.worldbookRecursive != null
          ? Boolean(cfg.worldbookRecursive)
          : undefined,
    },
    chapterPosition: Number(raw.chapterPosition) || 0,
    chapterTitle: String(raw.chapterTitle || ''),
    chapterSynopsis: String(raw.chapterSynopsis || ''),
    rawChapterIds: Array.isArray(raw.rawChapterIds)
      ? raw.rawChapterIds.map((n: unknown) => Number(n) || 0)
      : [],
    storyStateText: String(raw.storyStateText || ''),
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
        `流水线上下文快照缺少字段 ${String(field)}，已阻止恢复。请重新开始生成。`,
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
    if (Number(raw.snapshotVersion) !== 1) {
      throw new OutlineContextError(
        'OUTLINE_SNAPSHOT_INVALID',
        `不支持的上下文内容版本 ${String(raw.snapshotVersion)}，已阻止恢复。请重新开始生成。`,
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
      raw.chapterUpdatedAt != null ? (raw.chapterUpdatedAt as string | number) : undefined,
    createdAt:
      raw.createdAt != null && Number.isFinite(Number(raw.createdAt))
        ? Number(raw.createdAt)
        : undefined,
    snapshotVersion: PIPELINE_CONTEXT_SNAPSHOT_VERSION,
    sourceFingerprint:
      typeof raw.sourceFingerprint === 'string' ? raw.sourceFingerprint : undefined,
    outlineBlockingReason:
      typeof raw.outlineBlockingReason === 'string'
        ? raw.outlineBlockingReason
        : undefined,
  };

  assertOwnership(snap, ownership);
  return snap;
}

function parseFrozenPreset(raw: unknown): FrozenPresetSnapshot | null {
  if (raw == null) return null;
  if (!isPlainObject(raw)) {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      '冻结预设结构无效，已阻止恢复。请重新开始生成。',
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
  return {
    llmConfigId,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
    modelName: String(raw.modelName ?? ''),
    contextWindow,
    maxOutputTokens:
      raw.maxOutputTokens != null && Number.isFinite(Number(raw.maxOutputTokens))
        ? Number(raw.maxOutputTokens)
        : undefined,
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
  let outlineWorkflowVersion: 1 | 2 | undefined;
  if (
    workflowVersionRaw === 1 ||
    workflowVersionRaw === 2 ||
    workflowVersionRaw === '1' ||
    workflowVersionRaw === '2'
  ) {
    outlineWorkflowVersion = Number(workflowVersionRaw) as 1 | 2;
  } else if (workflowVersionRaw != null && workflowVersionRaw !== '') {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      `不支持的流水线工作流版本 ${String(workflowVersionRaw)}，已阻止恢复。请重新开始生成。`,
      'restart_task',
    );
  }
  const reasoningPolicyRaw = raw.finalReviserReasoningPolicyVersion;
  let finalReviserReasoningPolicyVersion:
    | 1
    | 2
    | undefined;
  if (
    reasoningPolicyRaw === 1 ||
    reasoningPolicyRaw === 2 ||
    reasoningPolicyRaw === '1' ||
    reasoningPolicyRaw === '2'
  ) {
    finalReviserReasoningPolicyVersion = Number(reasoningPolicyRaw) as 1 | 2;
  } else if (reasoningPolicyRaw != null && reasoningPolicyRaw !== '') {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      `不支持的终稿推理策略版本 ${String(reasoningPolicyRaw)}，已阻止恢复。请重新开始生成。`,
      'restart_task',
    );
  }
  const reasoningEffortRaw = raw.reasoningEffort;
  let reasoningEffort: PipelineReasoningEffort | undefined;
  if (
    reasoningEffortRaw === 'low' ||
    reasoningEffortRaw === 'medium' ||
    reasoningEffortRaw === 'high'
  ) {
    reasoningEffort = reasoningEffortRaw;
  } else if (reasoningEffortRaw != null && reasoningEffortRaw !== '') {
    throw new OutlineContextError(
      'OUTLINE_EXECUTION_CONFIG_INVALID',
      `不支持的流水线思考强度 ${String(reasoningEffortRaw)}，已阻止恢复。请重新开始生成。`,
      'restart_task',
    );
  }
  return {
    pipelineMode: mode as PipelineMode,
    outlineWorkflowVersion,
    finalReviserReasoningPolicyVersion,
    reasoningEffort,
    draftMaxTokens: requireNonNegativeFinite(raw.draftMaxTokens, 'draftMaxTokens'),
    reviewMaxTokens: requireNonNegativeFinite(
      raw.reviewMaxTokens,
      'reviewMaxTokens',
    ),
    factCheckMaxTokens: requireNonNegativeFinite(
      raw.factCheckMaxTokens,
      'factCheckMaxTokens',
    ),
    proofMaxTokens: requireNonNegativeFinite(raw.proofMaxTokens, 'proofMaxTokens'),
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
      `不支持的流水线上下文版本 ${String(raw.version)}，已阻止恢复。请重新开始生成。`,
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
  return {
    version: 2,
    draftContext,
    auditContext,
    execution,
    frozenDraftRequest: parseFrozenDraftRequest(raw.frozenDraftRequest),
    frozenAuditCandidates: parseFrozenAuditCandidates(
      raw.frozenAuditCandidates,
    ),
    createdAt,
    auditFellBack: Boolean(raw.auditFellBack),
  };
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
  createdAt?: number;
  draftCompletedAt?: number;
  auditContextCreatedAt?: number;
  auditFellBack?: boolean;
}): {
  pipelineContextJson: string;
  pipelineContextVersion: number;
  pipelineContextHash: string;
} {
  const createdAt = params.createdAt ?? Date.now();
  const draftContext: PipelineContextSnapshot = {
    ...params.draftContext,
    snapshotVersion: PIPELINE_CONTEXT_SNAPSHOT_VERSION,
    createdAt: params.draftContext.createdAt ?? createdAt,
  };
  const envelope: PersistedPipelineTaskContextV2 = {
    version: 2,
    draftContext,
    execution: params.execution,
    createdAt,
  };
  if (params.auditContext) {
    envelope.auditContext = {
      ...params.auditContext,
      snapshotVersion: PIPELINE_CONTEXT_SNAPSHOT_VERSION,
      createdAt: params.auditContext.createdAt ?? Date.now(),
    };
  }
  if (params.frozenDraftRequest) {
    envelope.frozenDraftRequest = params.frozenDraftRequest;
  }
  if (params.frozenAuditCandidates) {
    envelope.frozenAuditCandidates = params.frozenAuditCandidates;
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
    pipelineContextVersion: PIPELINE_TASK_CONTEXT_VERSION,
    pipelineContextHash: sha256Hex(pipelineContextJson).slice(0, 32),
  };
}

/** Prefer audit context for full-mode review stages; else draft. */
export function resolveAuditContext(
  parsed: ParsedPipelineTaskContext,
): PipelineContextSnapshot {
  return parsed.auditContext || parsed.draftContext;
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

  try {
    parsePersistedPipelineTaskContext(
      {
        pipelineContextJson: task.pipelineContextJson,
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

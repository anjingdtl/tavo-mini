/**
 * User-facing dual revision actions (Phase IV-13).
 *
 * This module intentionally sits beside the unified writing kernel, not
 * inside it.  A user revision is a new, explicit action after Freeze:
 * exactly one model call, a local contract check, an in-memory preview, and
 * a separate user-confirmed persistence step.  It never invokes Planner,
 * Writer Core, QA, Memory, Governor or the shared Prompt Compiler.
 */

import type { Chapter } from '../../types/novel';
import {
  callLLMResult,
  resolveLLMRequestConfigById,
  type ChatMessage,
  type LLMCallConfig,
  type LLMRequestConfig,
  type LLMResult,
} from '../llm';
import {
  getPipelineTaskContextPayload,
  getLatestAcceptedPipelineTaskForTarget,
} from '../../data/repositories/pipelineTaskRepository';
import * as db from '../database';
import {
  findLatestAdoptedRunForChapter,
  findLatestPendingReviewRunForChapter,
  getRunContextSnapshotJson,
} from '../continuation/generation';
import type { FrozenWritingContext } from './contracts/frozenWritingContext';
import { validatePlainTextNovelBody } from './contracts/plainTextNovelBody';
import {
  applyParsedRepairPatches,
  parseRepairPatches,
  validateRepairPatches,
  type RepairPatch,
} from '../continuation/generation/continuationRepairPatch';
import { hashContent } from '../continuation/generation/continuationV5Contracts';
import {
  computeRevisionChangeSet,
  type RevisionChangeSet,
} from './revisionChangeSet';
import { createRevision } from '../revisionService';
import { finalizeChapterMemory } from '../storyMemory/storyMemoryService';
import { finalizeContinuationChapter } from './persist/continuationAdoption';
import {
  getLatestCompletedPipelineTaskForTarget,
  getPipelineTaskAdoptionPayload,
} from '../../data/repositories/pipelineTaskRepository';
import {
  getLatestEligibleArtifact,
  insertArtifact,
} from '../continuation/generation/generationRepository';
import { usePipelineTaskStore } from '../../store/pipelineTaskStore';

export type UserRevisionKind = 'targeted_revision' | 'whole_chapter_rewrite';
export type UserRevisionScenario = 'outline' | 'continuation';

export type UserRevisionErrorCode =
  | 'USER_REVISION_INSTRUCTION_MISSING'
  | 'USER_REVISION_SELECTION_EMPTY'
  | 'USER_REVISION_SELECTION_INVALID'
  | 'USER_REVISION_STALE_BASE'
  | 'USER_REVISION_STALE_SELECTION'
  | 'USER_REVISION_PATCH_INVALID'
  | 'USER_REVISION_PATCH_OUT_OF_SCOPE'
  | 'USER_REVISION_PATCH_OVERLAP'
  | 'USER_REVISION_OUTSIDE_SELECTION_CHANGED'
  | 'USER_REVISION_TARGETED_FULL_TEXT'
  | 'USER_REVISION_NO_CHANGE'
  | 'USER_REVISION_FINAL_BODY_INVALID'
  | 'USER_REVISION_WHOLE_BODY_INVALID'
  | 'USER_REVISION_PREVIEW_NOT_PENDING'
  | 'USER_REVISION_CHAPTER_MISSING'
  | 'USER_REVISION_FROZEN_TRUTH_MISSING'
  | 'USER_REVISION_CANDIDATE_MISSING'
  | 'USER_REVISION_CANDIDATE_STALE'
  | 'USER_REVISION_CANDIDATE_WRITE_FAILED'
  | 'USER_REVISION_POST_WRITING_FAILED'
  | 'USER_REVISION_LLM_FAILED'
  | 'USER_REVISION_MULTIPLE_REQUESTS';

export class UserRevisionError extends Error {
  readonly code: UserRevisionErrorCode;

  constructor(code: UserRevisionErrorCode, message: string) {
    super(message);
    this.name = 'UserRevisionError';
    this.code = code;
  }
}

/** Body-free, immutable projection of the generation Freeze used by prompts. */
export interface UserRevisionFrozenTruth {
  version: 1;
  scenario: UserRevisionScenario;
  projectId: number;
  chapterId: number;
  writingRunId: string | null;
  generationTraceId: string | null;
  freezeFingerprint: string | null;
  truthProjectionFingerprint: string | null;
  modelConfigId: number | null;
  modelName: string;
  title: string;
  synopsis: string;
  userInstruction: string;
  targetPosition: number | null;
  /** Frozen rendered source material; never rebuilt from live settings. */
  contextText: string;
}

export interface UserRevisionSelectionSnapshot {
  version: 1;
  chapterId: number;
  scenario: UserRevisionScenario;
  baseBodyFingerprint: string;
  selectionStart: number;
  selectionEnd: number;
  selectedTextFingerprint: string;
  instruction: string;
}

/**
 * Where the revision base lives. `chapter` means the persisted chapter body is
 * the authority (post-adoption). `pipeline_task` / `continuation_run` mean the
 * Final Candidate Artifact is the authority (pre-adoption); applying such a
 * revision writes the candidate store, never the chapter body.
 */
export type UserRevisionCandidateRef =
  | { kind: 'chapter' }
  | { kind: 'pipeline_task'; taskId: string }
  | { kind: 'continuation_run'; runId: string };

export interface UserRevisionReceipt {
  version: 1;
  actionId: string;
  kind: UserRevisionKind;
  scenario: UserRevisionScenario;
  chapterId: number;
  writingRunId: string | null;
  generationTraceId: string | null;
  freezeFingerprint: string | null;
  truthProjectionFingerprint: string | null;
  modelConfigId: number | null;
  /**
   * P1-3 contract (Option B): `modelName`/`providerType` are the RESOLVED
   * live values actually used on the wire, resolved from the persisted
   * `modelConfigId` at request time. `frozenModelName` is recorded only as the
   * frozen generation binding — never as the physical model identity.
   */
  modelName: string;
  providerType: string | null;
  frozenModelName: string;
  instructionFingerprint: string;
  baseBodyFingerprint: string;
  candidateBodyFingerprint: string;
  selectedTextFingerprint?: string;
  thinking: { type: 'enabled' };
  governorBypassed: true;
  hiddenRetryCount: 0;
  plannerCallCount: 0;
  writerCallCount: 1;
  qaCallCount: 0;
  contextBuildCount: 0;
  memoryCallCount: 0;
  promptCompilerCallCount: 0;
  formatterCallCount: 0;
  logicalCallCount: 1;
  physicalRequestCount: number;
  protocolFallbackCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  finishReason: string | null;
  providerRequestId: string | null;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

export interface UserRevisionPreview {
  version: 1;
  previewId: string;
  state: 'pending' | 'applied' | 'discarded';
  kind: UserRevisionKind;
  scenario: UserRevisionScenario;
  chapterId: number;
  baseBody: string;
  candidateBody: string;
  baseBodyFingerprint: string;
  candidateBodyFingerprint: string;
  selection?: UserRevisionSelectionSnapshot;
  patches?: RepairPatch[];
  diff: RevisionChangeSet;
  frozenTruth: UserRevisionFrozenTruth;
  /** Where Apply must write: chapter body (default) or Final Candidate store. */
  candidateRef: UserRevisionCandidateRef;
  receipt: UserRevisionReceipt;
  createdAt: number;
}

export type UserRevisionLlmCaller = (
  messages: ChatMessage[],
  maxTokens: number | undefined,
  config: LLMCallConfig,
  externalSignal?: AbortSignal,
) => Promise<LLMResult>;

interface RevisionCallInput {
  kind: UserRevisionKind;
  chapterId: number;
  projectId: number;
  scenario: UserRevisionScenario;
  instruction: string;
  baseBody: string;
  frozenTruth: UserRevisionFrozenTruth;
  messages: ChatMessage[];
  call?: UserRevisionLlmCaller;
  abortSignal?: AbortSignal;
}

let userRevisionSequence = 0;

function nextActionId(kind: UserRevisionKind, chapterId: number): string {
  userRevisionSequence += 1;
  return `ur_${kind}_${chapterId}_${Date.now()}_${userRevisionSequence}`;
}

function nonEmptyInstruction(value: string): string {
  return String(value || '').trim();
}

function assertInstruction(value: string): string {
  const instruction = nonEmptyInstruction(value);
  if (!instruction) {
    throw new UserRevisionError(
      'USER_REVISION_INSTRUCTION_MISSING',
      '请先填写修订要求。',
    );
  }
  return instruction;
}

function assertSelectionRange(
  body: string,
  selectionStart: number,
  selectionEnd: number,
): void {
  if (
    !Number.isSafeInteger(selectionStart) ||
    !Number.isSafeInteger(selectionEnd) ||
    selectionStart < 0 ||
    selectionEnd <= selectionStart ||
    selectionEnd > body.length
  ) {
    throw new UserRevisionError(
      'USER_REVISION_SELECTION_INVALID',
      '选区范围已失效，请重新选择正文。',
    );
  }
}

export function createUserRevisionSelectionSnapshot(input: {
  chapterId: number;
  scenario: UserRevisionScenario;
  baseBody: string;
  selectionStart: number;
  selectionEnd: number;
  instruction: string;
}): UserRevisionSelectionSnapshot {
  const body = String(input.baseBody || '');
  assertSelectionRange(body, input.selectionStart, input.selectionEnd);
  const instruction = assertInstruction(input.instruction);
  const selected = body.slice(input.selectionStart, input.selectionEnd);
  if (!selected) {
    throw new UserRevisionError(
      'USER_REVISION_SELECTION_EMPTY',
      '精准修订需要先选择一段正文。',
    );
  }
  return {
    version: 1,
    chapterId: input.chapterId,
    scenario: input.scenario,
    baseBodyFingerprint: hashContent(body),
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd,
    selectedTextFingerprint: hashContent(selected),
    instruction,
  };
}

export function validateUserRevisionSelection(input: {
  snapshot: UserRevisionSelectionSnapshot;
  currentBody: string;
}): void {
  const body = String(input.currentBody || '');
  assertSelectionRange(
    body,
    input.snapshot.selectionStart,
    input.snapshot.selectionEnd,
  );
  if (hashContent(body) !== input.snapshot.baseBodyFingerprint) {
    throw new UserRevisionError(
      'USER_REVISION_STALE_BASE',
      '正文已发生变化，这个精准修订预览已过期。',
    );
  }
  const selected = body.slice(
    input.snapshot.selectionStart,
    input.snapshot.selectionEnd,
  );
  if (hashContent(selected) !== input.snapshot.selectedTextFingerprint) {
    throw new UserRevisionError(
      'USER_REVISION_STALE_SELECTION',
      '选区已发生变化，请重新选择后再修订。',
    );
  }
}

export interface ScopedRepairPatchValidation {
  valid: boolean;
  code:
    | 'ok'
    | 'invalid_patch'
    | 'out_of_scope'
    | 'overlap'
    | 'outside_selection_changed';
  details?: string;
}

/**
 * Reuse the existing Continuation Patch parser/validator, then add the user
 * selection scope guard.  Offsets are intentionally JS UTF-16 offsets, the
 * same coordinate system used by React Native TextInput.selection.
 */
export function validateScopedRepairPatches(input: {
  original: string;
  selectionStart: number;
  selectionEnd: number;
  patches: RepairPatch[];
}): ScopedRepairPatchValidation {
  try {
    assertSelectionRange(
      input.original,
      input.selectionStart,
      input.selectionEnd,
    );
  } catch (error) {
    return {
      valid: false,
      code: 'invalid_patch',
      details: error instanceof Error ? error.message : String(error),
    };
  }
  if (!validateRepairPatches(input.original, input.patches)) {
    return {
      valid: false,
      code: 'invalid_patch',
      details: 'Patch offsets、空替换或插入边界不合法。',
    };
  }
  const sorted = input.patches
    .slice()
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (const patch of sorted) {
    if (patch.start < input.selectionStart || patch.end > input.selectionEnd) {
      return {
        valid: false,
        code: 'out_of_scope',
        details: 'Patch 越过了用户选区，已拒绝。',
      };
    }
  }
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].start < sorted[index - 1].end) {
      return {
        valid: false,
        code: 'overlap',
        details: 'Patch 之间存在重叠，已拒绝。',
      };
    }
  }
  return { valid: true, code: 'ok' };
}

/** Prefix/suffix equality proves that every changed UTF-16 range is inside the selection. */
export function assertOutsideSelectionPreserved(input: {
  original: string;
  candidate: string;
  selectionStart: number;
  selectionEnd: number;
}): void {
  const prefix = input.original.slice(0, input.selectionStart);
  const suffix = input.original.slice(input.selectionEnd);
  if (
    !input.candidate.startsWith(prefix) ||
    !input.candidate.endsWith(suffix)
  ) {
    throw new UserRevisionError(
      'USER_REVISION_OUTSIDE_SELECTION_CHANGED',
      '选区外正文发生变化，已拒绝该修订。',
    );
  }
}

export function applyScopedRepairPatches(input: {
  original: string;
  snapshot: UserRevisionSelectionSnapshot;
  currentBody?: string;
  patches: RepairPatch[];
}): string {
  validateUserRevisionSelection({
    snapshot: input.snapshot,
    currentBody: input.currentBody ?? input.original,
  });
  const validation = validateScopedRepairPatches({
    original: input.original,
    selectionStart: input.snapshot.selectionStart,
    selectionEnd: input.snapshot.selectionEnd,
    patches: input.patches,
  });
  if (!validation.valid) {
    const code =
      validation.code === 'out_of_scope'
        ? 'USER_REVISION_PATCH_OUT_OF_SCOPE'
        : validation.code === 'overlap'
        ? 'USER_REVISION_PATCH_OVERLAP'
        : 'USER_REVISION_PATCH_INVALID';
    throw new UserRevisionError(code, validation.details || 'Patch 不合法。');
  }
  const candidate = applyParsedRepairPatches(input.original, input.patches);
  assertOutsideSelectionPreserved({
    original: input.original,
    candidate,
    selectionStart: input.snapshot.selectionStart,
    selectionEnd: input.snapshot.selectionEnd,
  });
  return candidate;
}

function sourceBundleText(frozen: FrozenWritingContext): string {
  if (frozen.rendered?.text) return frozen.rendered.text;
  const sources = [
    ...(frozen.sourceBundle?.mandatory || []),
    ...(frozen.sourceBundle?.preferred || []),
    ...(frozen.sourceBundle?.optional || []),
  ];
  return sources
    .map(source => `[${source.kind}]\n${source.content}`)
    .filter(Boolean)
    .join('\n\n');
}

export function projectUserRevisionFrozenTruth(input: {
  frozen: FrozenWritingContext;
  scenario?: UserRevisionScenario;
  writingRunId?: string | null;
}): UserRevisionFrozenTruth {
  const frozen = input.frozen;
  return {
    version: 1,
    scenario:
      input.scenario ||
      (frozen.policy?.values?.scenario === 'continuation'
        ? 'continuation'
        : 'outline'),
    projectId: frozen.projectId,
    chapterId: frozen.chapterId,
    writingRunId: input.writingRunId ?? frozen.writingRunId ?? null,
    generationTraceId: frozen.generationTraceId || null,
    freezeFingerprint: frozen.freezeFingerprint || null,
    truthProjectionFingerprint: frozen.truthProjection?.fingerprint || null,
    modelConfigId: frozen.model?.configId ?? null,
    modelName: frozen.model?.modelName || '',
    title: frozen.instruction?.title || '',
    synopsis: frozen.instruction?.synopsis || '',
    userInstruction: frozen.instruction?.userInstruction || '',
    targetPosition: Number.isFinite(frozen.instruction?.targetPosition)
      ? frozen.instruction.targetPosition
      : null,
    contextText: sourceBundleText(frozen),
  };
}

function readFrozenFromSnapshot(
  snapshotJson: string | null | undefined,
): FrozenWritingContext | null {
  if (!snapshotJson) return null;
  try {
    const parsed = JSON.parse(snapshotJson) as any;
    const frozen =
      parsed?.frozenWritingContext ||
      parsed?.draftContext?.frozenWritingContext ||
      parsed?.writingContext?.frozenWritingContext;
    return frozen && frozen.requirements && frozen.stagePolicy ? frozen : null;
  } catch {
    return null;
  }
}

/** Read the authoritative persisted Freeze; never rebuild a live context. */
export async function loadUserRevisionFrozenTruth(input: {
  projectId: number;
  chapterId: number;
  scenario: UserRevisionScenario;
}): Promise<UserRevisionFrozenTruth> {
  if (input.scenario === 'continuation') {
    const run = await findLatestAdoptedRunForChapter(
      input.projectId,
      input.chapterId,
    );
    const snapshot = run ? await getRunContextSnapshotJson(run.id) : null;
    const frozen = readFrozenFromSnapshot(snapshot);
    if (!frozen) {
      throw new UserRevisionError(
        'USER_REVISION_FROZEN_TRUTH_MISSING',
        '找不到本章已冻结的续写上下文，请先完成一次原著续写。',
      );
    }
    return projectUserRevisionFrozenTruth({
      frozen,
      scenario: 'continuation',
      writingRunId: run?.id || frozen.writingRunId,
    });
  }

  const task = await getLatestAcceptedPipelineTaskForTarget(
    'chapter',
    input.chapterId,
  );
  const snapshot = task ? await getPipelineTaskContextPayload(task.id) : null;
  const frozen = readFrozenFromSnapshot(snapshot);
  if (!frozen) {
    throw new UserRevisionError(
      'USER_REVISION_FROZEN_TRUTH_MISSING',
      '找不到本章已冻结的大纲上下文，请先完成一次大纲生成。',
    );
  }
  return projectUserRevisionFrozenTruth({
    frozen,
    scenario: 'outline',
    writingRunId: frozen.writingRunId,
  });
}

function frozenTruthBlock(truth: UserRevisionFrozenTruth): string {
  return [
    `scenario=${truth.scenario}`,
    `freezeFingerprint=${truth.freezeFingerprint || 'missing'}`,
    `truthProjectionFingerprint=${
      truth.truthProjectionFingerprint || 'missing'
    }`,
    `chapterTitle=${truth.title}`,
    `chapterSynopsis=${truth.synopsis}`,
    `frozenInstruction=${truth.userInstruction}`,
    'FROZEN_CONTEXT_BEGIN',
    truth.contextText,
    'FROZEN_CONTEXT_END',
  ].join('\n');
}

function targetedMessages(input: {
  body: string;
  snapshot: UserRevisionSelectionSnapshot;
  frozenTruth: UserRevisionFrozenTruth;
}): ChatMessage[] {
  const before = input.body.slice(
    Math.max(0, input.snapshot.selectionStart - 1200),
    input.snapshot.selectionStart,
  );
  const selected = input.body.slice(
    input.snapshot.selectionStart,
    input.snapshot.selectionEnd,
  );
  const after = input.body.slice(
    input.snapshot.selectionEnd,
    Math.min(input.body.length, input.snapshot.selectionEnd + 1200),
  );
  return [
    {
      role: 'system',
      content:
        '你是 TAVO-MINI 的用户精准修订执行器。Thinking 必须开启，但任何 reasoning 都不能进入正文。你只能输出一个 JSON 对象：{"patches":[{"start":number,"end":number,"replacement":string}]}。start/end 是当前章节正文的 JavaScript UTF-16 半开区间；每个 Patch 必须完全落在用户选区内，Patch 不能重叠，replacement 不得为空。只修改用户要求的选区，禁止返回完整章节、Markdown 围栏、解释、协议字段或“其余内容不变”。',
    },
    {
      role: 'user',
      content: [
        `用户修订要求：${input.snapshot.instruction}`,
        `用户选区：${input.snapshot.selectionStart}..${input.snapshot.selectionEnd}`,
        `选区前文：\n${before}`,
        `选区原文：\n${selected}`,
        `选区后文：\n${after}`,
        `本章完整正文（只读坐标基准）：\n${input.body}`,
        frozenTruthBlock(input.frozenTruth),
        '现在只返回 JSON Patch 对象。',
      ].join('\n\n'),
    },
  ];
}

function wholeRewriteMessages(input: {
  body: string;
  instruction: string;
  frozenTruth: UserRevisionFrozenTruth;
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是 TAVO-MINI 的用户整章重写执行器。Thinking 必须开启，但 reasoning 永远不能进入业务正文。你只能输出完整、连续、可直接保存的小说正文纯文本；禁止 JSON 对象/数组、协议字段、Markdown 代码围栏、Patch/Diff、修改说明、章节标题包装或任何前后解释。不要输出摘要，不要重新规划，也不要声称完成了什么。',
    },
    {
      role: 'user',
      content: [
        `用户整章重写要求：${input.instruction}`,
        '以下 Frozen Truth 是只读事实与上下文，必须复用，不得重新构建或改写为新的规划：',
        frozenTruthBlock(input.frozenTruth),
        `当前完整章节正文：\n${input.body}`,
        '请只返回重写后的完整小说正文。',
      ].join('\n\n'),
    },
  ];
}

async function callUserRevisionOnce(input: RevisionCallInput): Promise<{
  actionId: string;
  result: LLMResult;
  receiptBase: Omit<
    UserRevisionReceipt,
    | 'baseBodyFingerprint'
    | 'candidateBodyFingerprint'
    | 'selectedTextFingerprint'
  >;
}> {
  const actionId = nextActionId(input.kind, input.chapterId);
  const startedAt = Date.now();
  const physicalKinds: string[] = [];
  let requestConfig: LLMRequestConfig | undefined;
  if (!input.call && input.frozenTruth.modelConfigId != null) {
    requestConfig = await resolveLLMRequestConfigById(
      input.frozenTruth.modelConfigId,
    );
  }
  const config: LLMCallConfig = {
    // Deliberately omit responseFormat: targeted output is parsed locally and
    // whole rewrite must remain a plain-text response. Thinking is explicit
    // and never silently downgraded.
    thinking: { type: 'enabled' },
    scenario:
      input.kind === 'targeted_revision'
        ? 'user_revision_targeted'
        : 'user_revision_whole_chapter',
    projectId: input.projectId,
    taskId: actionId,
    queueClass: 'normal',
    queuePriority: 'manual',
    physicalRequestHooks: {
      beforeRequest: event => {
        physicalKinds.push(String(event.kind || 'primary'));
      },
    },
    ...(requestConfig ? { requestConfig } : {}),
  };
  let result: LLMResult;
  try {
    result = await (input.call || callLLMResult)(
      input.messages,
      undefined,
      config,
      input.abortSignal,
    );
  } catch (error) {
    throw new UserRevisionError(
      'USER_REVISION_LLM_FAILED',
      error instanceof Error ? error.message : '修订请求失败。',
    );
  }
  const physicalRequestCount = physicalKinds.length || 1;
  const protocolFallbackCount = physicalKinds.filter(
    kind => kind === 'protocol_fallback',
  ).length;
  if (physicalRequestCount !== 1 || protocolFallbackCount !== 0) {
    throw new UserRevisionError(
      'USER_REVISION_MULTIPLE_REQUESTS',
      '修订请求出现第二次物理调用，已 fail-closed。',
    );
  }
  const completedAt = Date.now();
  // P1-3 Option B: the receipt explains the real physical call. When the
  // config was resolved live, the resolved model identity is what the wire
  // used; an injected test caller is itself the observed call.
  const wireModelName = requestConfig
    ? requestConfig.model_name
    : input.frozenTruth.modelName;
  const wireProviderType = requestConfig
    ? requestConfig.provider_type
    : null;
  const receiptBase: Omit<
    UserRevisionReceipt,
    | 'baseBodyFingerprint'
    | 'candidateBodyFingerprint'
    | 'selectedTextFingerprint'
  > = {
    version: 1,
    actionId,
    kind: input.kind,
    scenario: input.scenario,
    chapterId: input.chapterId,
    writingRunId: input.frozenTruth.writingRunId,
    generationTraceId: input.frozenTruth.generationTraceId,
    freezeFingerprint: input.frozenTruth.freezeFingerprint,
    truthProjectionFingerprint: input.frozenTruth.truthProjectionFingerprint,
    modelConfigId: input.frozenTruth.modelConfigId,
    modelName: wireModelName,
    providerType: wireProviderType,
    frozenModelName: input.frozenTruth.modelName,
    instructionFingerprint: hashContent(input.instruction),
    thinking: { type: 'enabled' },
    governorBypassed: true,
    hiddenRetryCount: 0,
    plannerCallCount: 0,
    writerCallCount: 1,
    qaCallCount: 0,
    contextBuildCount: 0,
    memoryCallCount: 0,
    promptCompilerCallCount: 0,
    formatterCallCount: 0,
    logicalCallCount: 1,
    physicalRequestCount,
    protocolFallbackCount,
    inputTokens: Number.isFinite(Number(result.inputTokens))
      ? Number(result.inputTokens)
      : null,
    outputTokens: Number.isFinite(Number(result.outputTokens))
      ? Number(result.outputTokens)
      : null,
    totalTokens: Number.isFinite(Number(result.totalTokens))
      ? Number(result.totalTokens)
      : null,
    reasoningTokens: Number.isFinite(Number(result.reasoningTokens))
      ? Number(result.reasoningTokens)
      : null,
    finishReason: result.finishReason ?? null,
    providerRequestId: result.providerRequestId ?? null,
    startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt - startedAt),
  };
  return { actionId, result, receiptBase };
}

function completeReceipt(input: {
  base: Omit<
    UserRevisionReceipt,
    | 'baseBodyFingerprint'
    | 'candidateBodyFingerprint'
    | 'selectedTextFingerprint'
  >;
  baseBody: string;
  candidateBody: string;
  selectedText?: string;
}): UserRevisionReceipt {
  return {
    ...input.base,
    baseBodyFingerprint: hashContent(input.baseBody),
    candidateBodyFingerprint: hashContent(input.candidateBody),
    ...(input.selectedText != null
      ? { selectedTextFingerprint: hashContent(input.selectedText) }
      : {}),
  };
}

function assertFinalBody(candidateBody: string): void {
  const result = validatePlainTextNovelBody(candidateBody);
  if (!result.valid) {
    throw new UserRevisionError(
      'USER_REVISION_FINAL_BODY_INVALID',
      result.details || '修订结果不是可保存的纯正文。',
    );
  }
}

function assertFrozenTruthBinding(input: {
  frozenTruth: UserRevisionFrozenTruth;
  chapter: Pick<Chapter, 'id' | 'project_id'>;
  scenario: UserRevisionScenario;
}): void {
  if (
    input.frozenTruth.scenario !== input.scenario ||
    input.frozenTruth.projectId !== input.chapter.project_id ||
    input.frozenTruth.chapterId !== input.chapter.id ||
    !input.frozenTruth.freezeFingerprint ||
    input.frozenTruth.modelConfigId == null ||
    !input.frozenTruth.modelName.trim()
  ) {
    throw new UserRevisionError(
      'USER_REVISION_FROZEN_TRUTH_MISSING',
      '修订上下文与当前章节不匹配，请重新打开本章后再试。',
    );
  }
}

/**
 * The shared Continuation parser intentionally tolerates fences and prose for
 * historical repair responses. User revision has a stricter contract: the
 * raw model channel must be exactly one top-level { patches } JSON object.
 * After that envelope check, parsing/offset validation/application still use
 * the existing Continuation Patch engine.
 */
function parseStrictUserRepairPatches(raw: string): RepairPatch[] | null {
  const trimmed = raw.trim();
  if (!trimmed || /```/.test(trimmed)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== 'patches') return null;
  return parseRepairPatches(trimmed);
}

export async function createTargetedRevisionPreview(input: {
  chapter: Pick<Chapter, 'id' | 'project_id' | 'content'>;
  scenario: UserRevisionScenario;
  instruction: string;
  selectionStart: number;
  selectionEnd: number;
  frozenTruth: UserRevisionFrozenTruth;
  /** Where Apply writes; defaults to the persisted chapter body. */
  candidateRef?: UserRevisionCandidateRef;
  call?: UserRevisionLlmCaller;
  abortSignal?: AbortSignal;
}): Promise<UserRevisionPreview> {
  const body = String(input.chapter.content || '');
  assertFrozenTruthBinding(input);
  const snapshot = createUserRevisionSelectionSnapshot({
    chapterId: input.chapter.id,
    scenario: input.scenario,
    baseBody: body,
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd,
    instruction: input.instruction,
  });
  const instruction = snapshot.instruction;
  const call = await callUserRevisionOnce({
    kind: 'targeted_revision',
    chapterId: input.chapter.id,
    projectId: input.chapter.project_id,
    scenario: input.scenario,
    instruction,
    baseBody: body,
    frozenTruth: input.frozenTruth,
    messages: targetedMessages({
      body,
      snapshot,
      frozenTruth: input.frozenTruth,
    }),
    call: input.call,
    abortSignal: input.abortSignal,
  });
  const raw = typeof call.result.text === 'string' ? call.result.text : '';
  if (!raw.trim() && call.result.reasoningText) {
    throw new UserRevisionError(
      'USER_REVISION_TARGETED_FULL_TEXT',
      '模型只返回了 reasoning，没有返回 JSON Patch。',
    );
  }
  const patches = parseStrictUserRepairPatches(raw);
  if (!patches) {
    if (validatePlainTextNovelBody(raw).valid) {
      throw new UserRevisionError(
        'USER_REVISION_TARGETED_FULL_TEXT',
        '精准修订返回了完整正文而不是 JSON Patch。',
      );
    }
    throw new UserRevisionError(
      'USER_REVISION_PATCH_INVALID',
      '精准修订未返回合法 JSON Patch。',
    );
  }
  const candidate = applyScopedRepairPatches({
    original: body,
    snapshot,
    patches,
  });
  if (candidate === body) {
    throw new UserRevisionError(
      'USER_REVISION_NO_CHANGE',
      '精准修订没有产生变化。',
    );
  }
  assertFinalBody(candidate);
  const selected = body.slice(snapshot.selectionStart, snapshot.selectionEnd);
  const receipt = completeReceipt({
    base: call.receiptBase,
    baseBody: body,
    candidateBody: candidate,
    selectedText: selected,
  });
  return {
    version: 1,
    previewId: call.actionId,
    state: 'pending',
    kind: 'targeted_revision',
    scenario: input.scenario,
    chapterId: input.chapter.id,
    baseBody: body,
    candidateBody: candidate,
    baseBodyFingerprint: hashContent(body),
    candidateBodyFingerprint: hashContent(candidate),
    selection: snapshot,
    patches,
    diff: computeRevisionChangeSet(body, candidate, []),
    frozenTruth: input.frozenTruth,
    candidateRef: input.candidateRef ?? { kind: 'chapter' },
    receipt,
    createdAt: Date.now(),
  };
}

export async function createWholeChapterRewritePreview(input: {
  chapter: Pick<Chapter, 'id' | 'project_id' | 'content'>;
  scenario: UserRevisionScenario;
  instruction: string;
  frozenTruth: UserRevisionFrozenTruth;
  /** Where Apply writes; defaults to the persisted chapter body. */
  candidateRef?: UserRevisionCandidateRef;
  call?: UserRevisionLlmCaller;
  abortSignal?: AbortSignal;
}): Promise<UserRevisionPreview> {
  const body = String(input.chapter.content || '');
  assertFrozenTruthBinding(input);
  if (!body.trim()) {
    throw new UserRevisionError(
      'USER_REVISION_FINAL_BODY_INVALID',
      '当前章节没有可重写的正文。',
    );
  }
  const instruction = assertInstruction(input.instruction);
  const call = await callUserRevisionOnce({
    kind: 'whole_chapter_rewrite',
    chapterId: input.chapter.id,
    projectId: input.chapter.project_id,
    scenario: input.scenario,
    instruction,
    baseBody: body,
    frozenTruth: input.frozenTruth,
    messages: wholeRewriteMessages({
      body,
      instruction,
      frozenTruth: input.frozenTruth,
    }),
    call: input.call,
    abortSignal: input.abortSignal,
  });
  const raw = typeof call.result.text === 'string' ? call.result.text : '';
  if (!raw.trim() && call.result.reasoningText) {
    throw new UserRevisionError(
      'USER_REVISION_WHOLE_BODY_INVALID',
      '模型只返回了 reasoning，没有返回完整纯正文。',
    );
  }
  const candidate = raw.trim();
  if (!candidate) {
    throw new UserRevisionError(
      'USER_REVISION_WHOLE_BODY_INVALID',
      '整章重写没有返回正文。',
    );
  }
  const validation = validatePlainTextNovelBody(candidate);
  if (!validation.valid) {
    throw new UserRevisionError(
      'USER_REVISION_WHOLE_BODY_INVALID',
      validation.details || '整章重写结果不是纯正文。',
    );
  }
  if (candidate === body) {
    throw new UserRevisionError(
      'USER_REVISION_NO_CHANGE',
      '整章重写没有产生变化。',
    );
  }
  const receipt = completeReceipt({
    base: call.receiptBase,
    baseBody: body,
    candidateBody: candidate,
  });
  return {
    version: 1,
    previewId: call.actionId,
    state: 'pending',
    kind: 'whole_chapter_rewrite',
    scenario: input.scenario,
    chapterId: input.chapter.id,
    baseBody: body,
    candidateBody: candidate,
    baseBodyFingerprint: hashContent(body),
    candidateBodyFingerprint: hashContent(candidate),
    diff: computeRevisionChangeSet(body, candidate, []),
    frozenTruth: input.frozenTruth,
    candidateRef: input.candidateRef ?? { kind: 'chapter' },
    receipt,
    createdAt: Date.now(),
  };
}

export function discardUserRevisionPreview(
  preview: UserRevisionPreview,
): UserRevisionPreview {
  if (preview.state !== 'pending') {
    throw new UserRevisionError(
      'USER_REVISION_PREVIEW_NOT_PENDING',
      '该修订预览已经结束。',
    );
  }
  return { ...preview, state: 'discarded' };
}

export async function applyUserRevisionPreview(input: {
  preview: UserRevisionPreview;
  currentBody?: string;
}): Promise<{
  revisionId: number;
  chapter: Chapter;
  preview: UserRevisionPreview;
}> {
  const preview = input.preview;
  if (preview.state !== 'pending') {
    throw new UserRevisionError(
      'USER_REVISION_PREVIEW_NOT_PENDING',
      '该修订预览已经结束，不能重复应用。',
    );
  }
  const chapter = await db.getChapterById(preview.chapterId);
  if (!chapter) {
    throw new UserRevisionError(
      'USER_REVISION_CHAPTER_MISSING',
      '章节不存在，无法应用修订。',
    );
  }
  assertFrozenTruthBinding({
    frozenTruth: preview.frozenTruth,
    chapter,
    scenario: preview.scenario,
  });
  const persistedBody = chapter.content;
  if (hashContent(persistedBody) !== preview.baseBodyFingerprint) {
    throw new UserRevisionError(
      'USER_REVISION_STALE_BASE',
      '正文已发生变化，请重新生成修订预览。',
    );
  }
  if (
    input.currentBody != null &&
    hashContent(input.currentBody) !== hashContent(persistedBody)
  ) {
    throw new UserRevisionError(
      'USER_REVISION_STALE_BASE',
      '正文已发生变化，请重新生成修订预览。',
    );
  }
  if (preview.selection) {
    validateUserRevisionSelection({
      snapshot: preview.selection,
      currentBody: persistedBody,
    });
  }
  assertFinalBody(preview.candidateBody);
  const source =
    preview.kind === 'targeted_revision'
      ? 'before_targeted_revision'
      : 'before_whole_chapter_rewrite';
  const revisionId = await createRevision(
    {
      projectId: chapter.project_id,
      targetType: 'chapter',
      targetId: chapter.id,
      title: chapter.title,
      content: persistedBody,
      source,
      sourceRef: JSON.stringify({
        version: 1,
        previewId: preview.previewId,
        receipt: preview.receipt,
        selection: preview.selection
          ? {
              start: preview.selection.selectionStart,
              end: preview.selection.selectionEnd,
              baseBodyFingerprint: preview.selection.baseBodyFingerprint,
              selectedTextFingerprint: preview.selection.selectedTextFingerprint,
            }
          : null,
      }),
    },
    // The before_* snapshot is the audit record for this action; it must land
    // even when the pre-revision body equals the latest revision's body.
    { skipContentDedupe: true },
  );
  await db.updateChapter(chapter.id, { content: preview.candidateBody });
  // P0-2: the revised body is the new authority. Re-enter the ONE existing
  // PostWriting closure immediately — the user must not have to remember a
  // separate "finalize" tap for Story Memory / Continuation State to describe
  // the new body. Both closures enqueue a fingerprint-keyed outbox row, so the
  // same revised body can never create a duplicate rebuild.
  try {
    if (preview.scenario === 'continuation') {
      await finalizeContinuationChapter({
        projectId: chapter.project_id,
        chapterId: chapter.id,
        content: preview.candidateBody,
        allowRevisionAdvancedBody: true,
      });
    } else {
      await finalizeChapterMemory(chapter.id, { revisionAdvancedBody: true });
    }
  } catch (error) {
    // The chapter write without its PostWriting handoff would leave memory
    // truth describing the pre-revision body — restore the persisted body so
    // the visible content never diverges from memory authority.
    await db
      .updateChapter(chapter.id, { content: persistedBody })
      .catch(() => {});
    throw new UserRevisionError(
      'USER_REVISION_POST_WRITING_FAILED',
      `修订未应用：PostWriting/Memory 闭环失败（${
        error instanceof Error ? error.message : String(error)
      }）。正文已恢复原状，请重试。`,
    );
  }
  const updated: Chapter = { ...chapter, content: preview.candidateBody };
  return {
    revisionId,
    chapter: updated,
    preview: { ...preview, state: 'applied' },
  };
}

export interface UserRevisionCandidateBase {
  baseBody: string;
  baseBodyFingerprint: string;
  frozenTruth: UserRevisionFrozenTruth;
  candidateRef: UserRevisionCandidateRef;
}

/**
 * P1-1 Pre-Adoption Revision base: the Final Candidate Artifact, not the
 * chapter body. Outline candidates live in `pipeline_tasks.final_text`;
 * continuation candidates are the run's latest eligible `final` artifact.
 */
export async function loadUserRevisionCandidateBase(input: {
  projectId: number;
  chapterId: number;
  scenario: UserRevisionScenario;
}): Promise<UserRevisionCandidateBase> {
  if (input.scenario === 'continuation') {
    const run = await findLatestPendingReviewRunForChapter(
      input.projectId,
      input.chapterId,
    );
    if (!run) {
      throw new UserRevisionError(
        'USER_REVISION_CANDIDATE_MISSING',
        '找不到待采纳的续写结果，无法修订候选正文。',
      );
    }
    const snapshot = await getRunContextSnapshotJson(run.id);
    const frozen = readFrozenFromSnapshot(snapshot);
    if (!frozen) {
      throw new UserRevisionError(
        'USER_REVISION_FROZEN_TRUTH_MISSING',
        '找不到本次续写的冻结上下文，无法修订候选正文。',
      );
    }
    const artifact = await getLatestEligibleArtifact(run.id);
    if (!artifact || !String(artifact.content || '').trim()) {
      throw new UserRevisionError(
        'USER_REVISION_CANDIDATE_MISSING',
        '本次续写没有可修订的候选正文。',
      );
    }
    if (run.workflowVersion === 5 && artifact.stage !== 'final') {
      throw new UserRevisionError(
        'USER_REVISION_CANDIDATE_MISSING',
        '只有最终稿候选支持在结果页修订。',
      );
    }
    return {
      baseBody: String(artifact.content),
      baseBodyFingerprint: hashContent(String(artifact.content)),
      frozenTruth: projectUserRevisionFrozenTruth({
        frozen,
        scenario: 'continuation',
        writingRunId: run.id,
      }),
      candidateRef: { kind: 'continuation_run', runId: run.id },
    };
  }

  const task = await getLatestCompletedPipelineTaskForTarget(
    'chapter',
    input.chapterId,
  );
  if (!task) {
    throw new UserRevisionError(
      'USER_REVISION_CANDIDATE_MISSING',
      '找不到已完成的大纲生成结果，无法修订候选正文。',
    );
  }
  const [payload, contextPayload] = await Promise.all([
    getPipelineTaskAdoptionPayload(task.id),
    getPipelineTaskContextPayload(task.id),
  ]);
  const finalText = String(payload?.finalText || '');
  if (!finalText.trim()) {
    throw new UserRevisionError(
      'USER_REVISION_CANDIDATE_MISSING',
      '该任务没有可修订的候选正文。',
    );
  }
  const frozen = readFrozenFromSnapshot(contextPayload);
  if (!frozen) {
    throw new UserRevisionError(
      'USER_REVISION_FROZEN_TRUTH_MISSING',
      '找不到本次生成的冻结上下文，无法修订候选正文。',
    );
  }
  return {
    baseBody: finalText,
    baseBodyFingerprint: hashContent(finalText),
    frozenTruth: projectUserRevisionFrozenTruth({
      frozen,
      scenario: 'outline',
      writingRunId: frozen.writingRunId,
    }),
    candidateRef: { kind: 'pipeline_task', taskId: task.id },
  };
}

/**
 * Apply a Pre-Adoption revision to the Final Candidate Artifact store. The
 * chapter body is never written here — adoption remains the single boundary
 * that promotes the (revised) candidate into the chapter and starts PostWriting.
 */
export async function applyUserRevisionPreviewToCandidate(input: {
  preview: UserRevisionPreview;
}): Promise<{ revisionId: number; preview: UserRevisionPreview }> {
  const preview = input.preview;
  if (preview.state !== 'pending') {
    throw new UserRevisionError(
      'USER_REVISION_PREVIEW_NOT_PENDING',
      '该修订预览已经结束，不能重复应用。',
    );
  }
  if (preview.candidateRef.kind === 'chapter') {
    throw new UserRevisionError(
      'USER_REVISION_CANDIDATE_WRITE_FAILED',
      '该预览不是候选修订，请使用章节应用路径。',
    );
  }
  const chapter = await db.getChapterById(preview.chapterId);
  if (!chapter) {
    throw new UserRevisionError(
      'USER_REVISION_CHAPTER_MISSING',
      '章节不存在，无法应用修订。',
    );
  }
  assertFrozenTruthBinding({
    frozenTruth: preview.frozenTruth,
    chapter,
    scenario: preview.scenario,
  });

  // CAS: re-read the CURRENT candidate. If it changed while the LLM was
  // running, the preview is stale and must never overwrite it.
  let currentCandidate = '';
  let currentArtifactId: string | null = null;
  if (preview.candidateRef.kind === 'pipeline_task') {
    const payload = await getPipelineTaskAdoptionPayload(
      preview.candidateRef.taskId,
    );
    currentCandidate = String(payload?.finalText || '');
  } else {
    const artifact = await getLatestEligibleArtifact(
      preview.candidateRef.runId,
    );
    currentCandidate = String(artifact?.content || '');
    currentArtifactId = artifact?.id ?? null;
  }
  if (!currentCandidate.trim()) {
    throw new UserRevisionError(
      'USER_REVISION_CANDIDATE_MISSING',
      '候选正文已不存在，无法应用修订。',
    );
  }
  if (hashContent(currentCandidate) !== preview.baseBodyFingerprint) {
    throw new UserRevisionError(
      'USER_REVISION_CANDIDATE_STALE',
      '候选正文已发生变化，请重新发起修订。',
    );
  }
  // Shared Final Plain-Text Integrity gate at the candidate final write.
  assertFinalBody(preview.candidateBody);

  const source =
    preview.kind === 'targeted_revision'
      ? 'before_targeted_revision'
      : 'before_whole_chapter_rewrite';
  const revisionId = await createRevision(
    {
      projectId: chapter.project_id,
      targetType: 'chapter',
      targetId: chapter.id,
      title: chapter.title,
      content: currentCandidate,
      source,
      sourceRef: JSON.stringify({
        version: 1,
        scope: 'pre_adoption_candidate',
        previewId: preview.previewId,
        candidate: preview.candidateRef,
        receipt: preview.receipt,
        selection: preview.selection
          ? {
              start: preview.selection.selectionStart,
              end: preview.selection.selectionEnd,
              baseBodyFingerprint: preview.selection.baseBodyFingerprint,
              selectedTextFingerprint: preview.selection.selectedTextFingerprint,
            }
          : null,
      }),
    },
    { skipContentDedupe: true },
  );

  if (preview.candidateRef.kind === 'pipeline_task') {
    const store = usePipelineTaskStore.getState();
    await store.persistTaskFinalText(
      preview.candidateRef.taskId,
      preview.candidateBody,
    );
    const verify = await getPipelineTaskAdoptionPayload(
      preview.candidateRef.taskId,
    );
    if (
      hashContent(String(verify?.finalText || '')) !==
      preview.candidateBodyFingerprint
    ) {
      throw new UserRevisionError(
        'USER_REVISION_CANDIDATE_WRITE_FAILED',
        '候选正文写入未生效，请重试。',
      );
    }
  } else {
    if (!currentArtifactId) {
      throw new UserRevisionError(
        'USER_REVISION_CANDIDATE_MISSING',
        '候选正文已不存在，无法应用修订。',
      );
    }
    await insertArtifact({
      runId: preview.candidateRef.runId,
      stage: 'final',
      content: preview.candidateBody,
      parentArtifactId: currentArtifactId,
      eligibilityStatus: 'eligible',
      requireStageMatch: true,
    });
    const verify = await getLatestEligibleArtifact(preview.candidateRef.runId);
    if (
      !verify ||
      hashContent(String(verify.content || '')) !==
        preview.candidateBodyFingerprint
    ) {
      throw new UserRevisionError(
        'USER_REVISION_CANDIDATE_WRITE_FAILED',
        '候选正文写入未生效，请重试。',
      );
    }
  }

  return { revisionId, preview: { ...preview, state: 'applied' } };
}

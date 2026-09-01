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
  getPipelineTaskById,
  getPipelineTaskAdoptionPayload,
} from '../../data/repositories/pipelineTaskRepository';
import * as db from '../database';
import {
  getRunById,
  findLatestAdoptedRunForChapter,
  getRunContextSnapshotJson,
} from '../continuation/generation';
import type { FrozenWritingContext } from './contracts/frozenWritingContext';
import {
  buildStandaloneWritingRequestReceipt,
  completeWritingRequestReceipt,
  type WritingRequestReceipt,
} from './contracts/writingRequestReceipt';
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
  getCurrentEligibleArtifact,
  getEligibleArtifactForRun,
  insertFinalArtifactAndActivate,
} from '../continuation/generation/generationRepository';
import { usePipelineTaskStore } from '../../store/pipelineTaskStore';
import {
  upsertWritingRequestReceipt,
} from '../../data/repositories/writingRequestReceiptRepository';

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
  | {
      kind: 'pipeline_task';
      taskId: string;
      /** Optional route binding, required when supplied by a result page. */
      projectId?: number;
      chapterId?: number;
    }
  | {
      kind: 'continuation_run';
      runId: string;
      /** Optional route binding, required when supplied by a result page. */
      projectId?: number;
      chapterId?: number;
      artifactId?: string;
    };

/** Result-page candidate identity. All three route bindings are mandatory so
 * a revision cannot fall back to a chapter-scoped "latest" lookup. */
export type UserRevisionExactCandidateRef =
  | {
      kind: 'pipeline_task';
      taskId: string;
      projectId: number;
      chapterId: number;
    }
  | {
      kind: 'continuation_run';
      runId: string;
      projectId: number;
      chapterId: number;
      artifactId?: string;
    };

/**
 * One common physical-request receipt plus non-call action aliases retained
 * for old result/audit readers. The aliases are non-enumerable projections;
 * the durable JSON truth is the shared WritingRequestReceipt itself.
 */
export type UserRevisionReceipt = WritingRequestReceipt & {
  readonly actionId: string;
  readonly actionKind: UserRevisionKind;
  readonly chapterId: number;
  readonly frozenModelName: string;
  readonly instructionFingerprint: string;
  readonly baseBodyFingerprint: string;
  readonly candidateBodyFingerprint: string;
  readonly selectedTextFingerprint?: string;
  readonly governorBypassed: true;
};

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
  candidateRef?: UserRevisionCandidateRef;
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

interface UserRevisionReceiptBase {
  receipt: WritingRequestReceipt;
  actionId: string;
  actionKind: UserRevisionKind;
  chapterId: number;
  scenario: UserRevisionScenario;
  projectId: number;
  instructionFingerprint: string;
  frozenModelName: string;
  candidateRef: UserRevisionCandidateRef;
  baseBodyFingerprint: string;
}

function candidateAuditBinding(
  candidateRef: UserRevisionCandidateRef | undefined,
  projectId: number,
  chapterId: number,
): {
  candidateKind: 'chapter' | 'pipeline_task' | 'continuation_run';
  candidateId: string;
} {
  if (!candidateRef || candidateRef.kind === 'chapter') {
    return { candidateKind: 'chapter', candidateId: String(chapterId) };
  }
  return candidateRef.kind === 'pipeline_task'
    ? { candidateKind: 'pipeline_task', candidateId: candidateRef.taskId }
    : { candidateKind: 'continuation_run', candidateId: candidateRef.runId };
}

async function persistUserRevisionReceipt(input: {
  base: UserRevisionReceiptBase;
  receipt: WritingRequestReceipt;
  previewState: 'started' | 'pending' | 'applied' | 'discarded' | 'failed';
  candidateBodyFingerprint?: string | null;
}): Promise<void> {
  const binding = candidateAuditBinding(
    input.base.candidateRef,
    input.base.projectId,
    input.base.chapterId,
  );
  await upsertWritingRequestReceipt({
    receipt: input.receipt,
    projectId: input.base.projectId,
    actionId: input.base.actionId,
    previewId: input.base.actionId,
    candidateKind: binding.candidateKind,
    candidateId: binding.candidateId,
    candidateProjectId: input.base.projectId,
    candidateChapterId: input.base.chapterId,
    actionKind: input.base.actionKind,
    instructionFingerprint: input.base.instructionFingerprint,
    baseBodyFingerprint: input.base.baseBodyFingerprint,
    candidateBodyFingerprint: input.candidateBodyFingerprint ?? null,
    previewState: input.previewState,
  });
}

function addUserRevisionAuditAliases(input: {
  receipt: WritingRequestReceipt;
  actionId: string;
  actionKind: UserRevisionKind;
  chapterId: number;
  frozenModelName: string;
  instructionFingerprint: string;
  baseBodyFingerprint: string;
  candidateBodyFingerprint: string;
  selectedTextFingerprint?: string;
}): UserRevisionReceipt {
  const receipt = input.receipt as UserRevisionReceipt;
  const aliases: Record<string, unknown> = {
    actionId: input.actionId,
    actionKind: input.actionKind,
    chapterId: input.chapterId,
    frozenModelName: input.frozenModelName,
    instructionFingerprint: input.instructionFingerprint,
    baseBodyFingerprint: input.baseBodyFingerprint,
    candidateBodyFingerprint: input.candidateBodyFingerprint,
    governorBypassed: true,
  };
  if (input.selectedTextFingerprint) {
    aliases.selectedTextFingerprint = input.selectedTextFingerprint;
  }
  Object.defineProperties(
    receipt,
    Object.fromEntries(
      Object.entries(aliases).map(([key, value]) => [key, {
        configurable: true,
        enumerable: false,
        value,
      }]),
    ),
  );
  return receipt;
}

async function callUserRevisionOnce(input: RevisionCallInput): Promise<{
  actionId: string;
  result: LLMResult;
  receiptBase: UserRevisionReceiptBase;
}> {
  const actionId = nextActionId(input.kind, input.chapterId);
  const startedAt = Date.now();
  const physicalKinds: string[] = [];
  let requestConfig: LLMRequestConfig | undefined;
  let requestConfigError: unknown = null;
  if (!input.call && input.frozenTruth.modelConfigId != null) {
    try {
      requestConfig = await resolveLLMRequestConfigById(
        input.frozenTruth.modelConfigId,
      );
    } catch (error) {
      requestConfigError = error;
    }
  }
  const stage =
    input.kind === 'targeted_revision'
      ? 'user_revision_targeted'
      : 'user_revision_whole_chapter';
  const receiptBase: UserRevisionReceiptBase = {
    receipt: buildStandaloneWritingRequestReceipt({
      requestId: `req_${actionId}`,
      generationTraceId: input.frozenTruth.generationTraceId,
      writingRunId: input.frozenTruth.writingRunId,
      scenario: input.scenario,
      stage,
      provider: requestConfig?.provider_type || 'openai_compatible',
      providerAdapterId: requestConfig?.provider_adapter_id,
      llmConfigId:
        requestConfig?.id ?? input.frozenTruth.modelConfigId ?? null,
      model: requestConfig?.model_name || input.frozenTruth.modelName,
      contextWindow: requestConfig?.context_window,
      maxOutputTokens: requestConfig?.max_output_tokens,
      messages: input.messages,
      responseFormat: 'text',
      thinking: { type: 'enabled' },
      freezeFingerprint: input.frozenTruth.freezeFingerprint,
      truthProjectionFingerprint:
        input.frozenTruth.truthProjectionFingerprint,
    }),
    actionId,
    actionKind: input.kind,
    chapterId: input.chapterId,
    scenario: input.scenario,
    projectId: input.projectId,
    instructionFingerprint: hashContent(input.instruction),
    frozenModelName: input.frozenTruth.modelName,
    candidateRef: input.candidateRef ?? { kind: 'chapter' },
    baseBodyFingerprint: hashContent(input.baseBody),
  };

  // Durable before-send record. If this write cannot land, fail closed and do
  // not issue a physical request that would have no durable receipt.
  try {
    await persistUserRevisionReceipt({
      base: receiptBase,
      receipt: receiptBase.receipt,
      previewState: 'started',
    });
  } catch (error) {
    throw new UserRevisionError(
      'USER_REVISION_LLM_FAILED',
      `修订请求未发送：无法持久化 Durable Receipt（${
        error instanceof Error ? error.message : String(error)
      }）。`,
    );
  }

  if (requestConfigError) {
    const failedReceipt = completeWritingRequestReceipt(receiptBase.receipt, {
      outcome: 'failed',
      failureClass: 'fatal',
      failurePhase: 'provider',
      requestMayHaveExecuted: false,
      physicalRequestCount: 0,
      protocolFallbackCount: 0,
    });
    await persistUserRevisionReceipt({
      base: receiptBase,
      receipt: failedReceipt,
      previewState: 'failed',
    });
    throw new UserRevisionError(
      'USER_REVISION_LLM_FAILED',
      `修订请求未发送：LLM 配置不可用（${
        requestConfigError instanceof Error
          ? requestConfigError.message
          : String(requestConfigError)
      }）。`,
    );
  }

  let receipt = receiptBase.receipt;
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
      beforeRequest: async event => {
        physicalKinds.push(String(event.kind || 'primary'));
        receipt = completeWritingRequestReceipt(receipt, {
          outcome: receipt.outcome,
          requestMayHaveExecuted: true,
          physicalRequestCount: physicalKinds.length,
          protocolFallbackCount: physicalKinds.filter(
            kind => kind === 'protocol_fallback',
          ).length,
          timings: {
            requestSentAt: Date.now(),
          },
        });
        await persistUserRevisionReceipt({
          base: receiptBase,
          receipt,
          previewState: 'started',
        });
      },
      afterRequest: async event => {
        receipt = completeWritingRequestReceipt(receipt, {
          outcome: receipt.outcome,
          requestMayHaveExecuted:
            event.outcome === 'response' || physicalKinds.length > 0,
          providerRequestId: event.providerRequestId ?? receipt.providerRequestId,
          failureClass:
            event.outcome === 'transport_error'
              ? 'outcome_unknown'
              : receipt.failureClass,
          failurePhase:
            event.outcome === 'transport_error'
              ? 'outcome_unknown'
              : receipt.failurePhase,
          physicalRequestCount: physicalKinds.length,
          protocolFallbackCount: physicalKinds.filter(
            kind => kind === 'protocol_fallback',
          ).length,
        });
        await persistUserRevisionReceipt({
          base: receiptBase,
          receipt,
          previewState: 'started',
        });
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
    const requestMayHaveExecuted =
      physicalKinds.length > 0 || Boolean((error as any)?.requestMayHaveExecuted);
    receipt = completeWritingRequestReceipt(receipt, {
      outcome:
        requestMayHaveExecuted
          ? 'outcome_unknown'
          : (error as any)?.code === 'cancelled'
          ? 'cancelled'
          : 'failed',
      failureClass: requestMayHaveExecuted
        ? 'outcome_unknown'
        : ((error as any)?.failureClass || 'fatal'),
      failurePhase:
        (error as any)?.failurePhase ||
        (requestMayHaveExecuted ? 'outcome_unknown' : 'provider'),
      requestMayHaveExecuted,
      providerRequestId:
        (error as any)?.providerRequestId ?? receipt.providerRequestId,
      metrics: (error as any)?.metrics ?? null,
      physicalRequestCount: physicalKinds.length,
      protocolFallbackCount: physicalKinds.filter(
        kind => kind === 'protocol_fallback',
      ).length,
    });
    await persistUserRevisionReceipt({
      base: receiptBase,
      receipt,
      previewState: 'failed',
    });
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
    receipt = completeWritingRequestReceipt(receipt, {
      outcome: 'failed',
      failureClass: 'fatal',
      failurePhase: 'provider',
      requestMayHaveExecuted: physicalRequestCount > 0,
      physicalRequestCount,
      protocolFallbackCount,
    });
    await persistUserRevisionReceipt({
      base: receiptBase,
      receipt,
      previewState: 'failed',
    });
    throw new UserRevisionError(
      'USER_REVISION_MULTIPLE_REQUESTS',
      '修订请求出现第二次物理调用，已 fail-closed。',
    );
  }
  const completedAt = Date.now();
  receipt = completeWritingRequestReceipt(receipt, {
    outcome: 'succeeded',
    usage: {
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
      visibleOutputTokens: Number.isFinite(Number(result.visibleOutputTokens))
        ? Number(result.visibleOutputTokens)
        : null,
    },
    finishReason: result.finishReason ?? null,
    emptyReason: result.emptyReason ?? null,
    failurePhase: result.failurePhase ?? null,
    requestMayHaveExecuted: true,
    providerRequestId: result.providerRequestId ?? receipt.providerRequestId,
    actualPromptTokens: Number.isFinite(Number(result.rawUsage?.prompt_tokens))
      ? Number(result.rawUsage?.prompt_tokens)
      : null,
    outputBudget: result.outputBudget ?? null,
    metrics: result.metrics ?? null,
    timings: {
      parseCompletedAt: completedAt,
      parseMs: Math.max(0, completedAt - startedAt),
      totalMs: Math.max(0, completedAt - startedAt),
    },
    physicalRequestCount,
    protocolFallbackCount,
  });
  await persistUserRevisionReceipt({
    base: receiptBase,
    receipt,
    previewState: 'pending',
  });
  return {
    actionId,
    result,
    receiptBase: {
      ...receiptBase,
      receipt,
    },
  };
}

function completeReceipt(input: {
  base: UserRevisionReceiptBase;
  baseBody: string;
  candidateBody: string;
  selectedText?: string;
}): UserRevisionReceipt {
  const completed = addUserRevisionAuditAliases({
    receipt: input.base.receipt,
    actionId: input.base.actionId,
    actionKind: input.base.actionKind,
    chapterId: input.base.chapterId,
    frozenModelName: input.base.frozenModelName,
    instructionFingerprint: input.base.instructionFingerprint,
    baseBodyFingerprint: hashContent(input.baseBody),
    candidateBodyFingerprint: hashContent(input.candidateBody),
    ...(input.selectedText != null
      ? { selectedTextFingerprint: hashContent(input.selectedText) }
      : {}),
  });
  return completed;
}

function receiptBaseFromPreview(
  preview: UserRevisionPreview,
): UserRevisionReceiptBase {
  return {
    receipt: preview.receipt,
    actionId: preview.receipt.actionId || preview.previewId,
    actionKind: preview.kind,
    chapterId: preview.chapterId,
    scenario: preview.scenario,
    projectId: preview.frozenTruth.projectId,
    instructionFingerprint: preview.receipt.instructionFingerprint,
    frozenModelName: preview.receipt.frozenModelName,
    candidateRef: preview.candidateRef,
    baseBodyFingerprint: preview.baseBodyFingerprint,
  };
}

async function persistPreviewState(
  preview: UserRevisionPreview,
  previewState: 'applied' | 'discarded' | 'failed',
): Promise<void> {
  await persistUserRevisionReceipt({
    base: receiptBaseFromPreview(preview),
    receipt: preview.receipt,
    previewState,
    candidateBodyFingerprint: preview.candidateBodyFingerprint,
  });
}

async function persistInvalidUserRevisionResponse(input: {
  base: UserRevisionReceiptBase;
}): Promise<void> {
  // The provider call succeeded, but the local revision contract rejected its
  // response. Keep that physical receipt immutable and close the action audit
  // so a force-stop/restart cannot leave an unresumable pending preview.
  await persistUserRevisionReceipt({
    base: input.base,
    receipt: input.base.receipt,
    previewState: 'failed',
  }).catch(() => {});
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
    candidateRef: input.candidateRef,
    messages: targetedMessages({
      body,
      snapshot,
      frozenTruth: input.frozenTruth,
    }),
    call: input.call,
    abortSignal: input.abortSignal,
  });
  try {
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
  } catch (error) {
    await persistInvalidUserRevisionResponse({ base: call.receiptBase });
    throw error;
  }
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
    candidateRef: input.candidateRef,
    messages: wholeRewriteMessages({
      body,
      instruction,
      frozenTruth: input.frozenTruth,
    }),
    call: input.call,
    abortSignal: input.abortSignal,
  });
  try {
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
  } catch (error) {
    await persistInvalidUserRevisionResponse({ base: call.receiptBase });
    throw error;
  }
}

export async function discardUserRevisionPreview(
  preview: UserRevisionPreview,
): Promise<UserRevisionPreview> {
  if (preview.state !== 'pending') {
    throw new UserRevisionError(
      'USER_REVISION_PREVIEW_NOT_PENDING',
      '该修订预览已经结束。',
    );
  }
  await persistPreviewState(preview, 'discarded');
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
  if (
    preview.candidateRef.kind !== 'chapter' &&
    (preview.candidateRef.projectId !== chapter.project_id ||
      preview.candidateRef.chapterId !== chapter.id)
  ) {
    throw new UserRevisionError(
      'USER_REVISION_CANDIDATE_STALE',
      '修订候选与当前章节身份不一致，请重新打开结果页。',
    );
  }
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
        requestId: preview.receipt.requestId,
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
    await persistPreviewState(preview, 'failed').catch(() => {});
    throw new UserRevisionError(
      'USER_REVISION_POST_WRITING_FAILED',
      `修订未应用：PostWriting/Memory 闭环失败（${
        error instanceof Error ? error.message : String(error)
      }）。正文已恢复原状，请重试。`,
    );
  }
  await persistPreviewState(preview, 'applied');
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
 * continuation candidates are the run's explicit Current Final Authority.
 */
export async function loadUserRevisionCandidateBase(input: {
  candidateRef: UserRevisionExactCandidateRef;
}): Promise<UserRevisionCandidateBase> {
  if (input.candidateRef.kind === 'continuation_run') {
    const ref = input.candidateRef;
    const run = await getRunById(ref.runId);
    if (
      !run ||
      run.projectId !== ref.projectId ||
      run.chapterId !== ref.chapterId ||
      run.state !== 'awaiting_user'
    ) {
      throw new UserRevisionError(
        'USER_REVISION_CANDIDATE_MISSING',
        '当前结果已不是可修订的续写候选，无法继续。',
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
    if (
      frozen.projectId !== ref.projectId ||
      frozen.chapterId !== ref.chapterId
    ) {
      throw new UserRevisionError(
        'USER_REVISION_FROZEN_TRUTH_MISSING',
        '续写结果与当前章节的冻结身份不一致，无法修订候选正文。',
      );
    }
    const artifact = await getCurrentEligibleArtifact(run.id);
    if (
      !artifact ||
      (ref.artifactId && artifact.id !== ref.artifactId) ||
      !String(artifact.content || '').trim()
    ) {
      throw new UserRevisionError(
        ref.artifactId ? 'USER_REVISION_CANDIDATE_STALE' : 'USER_REVISION_CANDIDATE_MISSING',
        ref.artifactId
          ? '当前续写候选已发生变化，请重新打开结果页。'
          : '本次续写没有可修订的当前候选正文。',
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
      candidateRef: {
        kind: 'continuation_run',
        runId: run.id,
        projectId: ref.projectId,
        chapterId: ref.chapterId,
        artifactId: artifact.id,
      },
    };
  }

  const ref = input.candidateRef;
  const task = await getPipelineTaskById(ref.taskId);
  const targetType = task?.targetType ?? task?.target_type;
  const targetId = Number(task?.targetId ?? task?.target_id);
  const taskStatus = task?.status;
  const chapter = await db.getChapterById(ref.chapterId);
  if (
    !task ||
    String(task.id) !== ref.taskId ||
    targetType !== 'chapter' ||
    targetId !== ref.chapterId ||
    taskStatus !== 'completed' ||
    !chapter ||
    chapter.project_id !== ref.projectId
  ) {
    throw new UserRevisionError(
      'USER_REVISION_CANDIDATE_MISSING',
      '当前结果已不是可修订的大纲候选，无法继续。',
    );
  }
  const [payload, contextPayload] = await Promise.all([
    getPipelineTaskAdoptionPayload(ref.taskId),
    getPipelineTaskContextPayload(ref.taskId),
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
  if (frozen.projectId !== ref.projectId || frozen.chapterId !== ref.chapterId) {
    throw new UserRevisionError(
      'USER_REVISION_FROZEN_TRUTH_MISSING',
      '大纲结果与当前章节的冻结身份不一致，无法修订候选正文。',
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
    candidateRef: {
      kind: 'pipeline_task',
      taskId: ref.taskId,
      projectId: ref.projectId,
      chapterId: ref.chapterId,
    },
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
    if (!preview.candidateRef.artifactId) {
      throw new UserRevisionError(
        'USER_REVISION_CANDIDATE_MISSING',
        '续写候选缺少精确 Final 身份，无法应用修订。',
      );
    }
    const artifact = await getEligibleArtifactForRun(
      preview.candidateRef.runId,
      preview.candidateRef.artifactId,
    );
    const authority = await getCurrentEligibleArtifact(
      preview.candidateRef.runId,
    );
    if (!authority || authority.id !== artifact?.id) {
      throw new UserRevisionError(
        'USER_REVISION_CANDIDATE_STALE',
        '续写 Current Final Authority 已变化，请重新发起修订。',
      );
    }
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
        requestId: preview.receipt.requestId,
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
    await insertFinalArtifactAndActivate({
      runId: preview.candidateRef.runId,
      content: preview.candidateBody,
      parentArtifactId: currentArtifactId,
      expectedCurrentArtifactId: currentArtifactId,
    });
    const verify = await getCurrentEligibleArtifact(
      preview.candidateRef.runId,
    );
    if (
      !verify ||
      verify.id === currentArtifactId ||
      hashContent(String(verify.content || '')) !==
        preview.candidateBodyFingerprint
    ) {
      throw new UserRevisionError(
        'USER_REVISION_CANDIDATE_WRITE_FAILED',
        '候选正文写入未生效，请重试。',
      );
    }
  }

  await persistPreviewState(preview, 'applied');

  return { revisionId, preview: { ...preview, state: 'applied' } };
}

import type { Chapter } from '../../types/novel';
import { estimateMessagesTokens, estimateTokens } from '../../utils/tokenEstimator';
import { invalidateIdf } from '../../utils/idfCache';
import * as db from '../database';
import { callLLMResult, type LLMResult } from '../llm';
import { extractJSON } from '../../utils/jsonExtractor';
import {
  fingerprintChapterSource,
  fingerprintStoryMemoryState,
  stableTextFingerprint,
} from './storyMemoryFingerprint';
import { applyStoryMemoryBatchPatch } from './storyMemoryMerger';
import { createEmptyBatchPatch } from './storyMemoryPrompts';
import { validateStoryMemoryBatchPatch } from './storyMemoryBatchValidator';
import type {
  ChapterMemoryPatchDraft,
  EpisodicSummary,
  StoryMemoryBatchPatchDraft,
  StoryMemoryPartialSuccess,
  StoryMemoryState,
  StoredStoryMemoryBatch,
} from './storyMemoryTypes';
import { StoryMemoryError } from './storyMemoryTypes';
import {
  splitCheckpointBatches,
  STORY_MEMORY_DEFAULT_BATCH_SIZE,
} from './storyMemoryPolicy';
import {
  checkpointMaxTokens as planCheckpointMaxTokens,
} from './storyMemoryBudget';
import {
  decideEmptyResponseAction,
  isSafeStoryMemoryRetryError,
  STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
} from './storyMemoryAttemptPolicy';
import {
  StoryMemoryAttemptBudget,
  createStoryMemoryLogicalBatchId,
} from './storyMemoryAttemptBudget';
import { buildStoryMemoryLLMConfig } from './storyMemoryRequestPolicy';
import {
  freezeStoryMemoryLLMConfig,
  planStoryMemoryObservationMessages,
  planStoryMemoryObservationRequest,
  type FrozenStoryMemoryLLMConfig,
} from './storyMemoryRequestBudget';
import { buildStoryMemoryEvidenceAnchors } from './storyMemoryEvidenceAnchors';
import { buildStoryMemoryEntityHandles } from './storyMemoryEntityHandles';
import {
  buildStoryMemoryObservationMaterials,
  buildMessagesFromObservationMaterials,
  type StoryMemoryObservationMaterials,
} from './storyMemoryObservationMaterials';
import {
  buildStoryMemoryObservationFormatterMessages,
  buildStoryMemoryObservationFreshRetryMessages,
  formatterHandleLists,
  parseStoryMemoryObservationCandidate,
} from './storyMemoryObservationFormatter';
import { normalizeStoryMemoryObservationPayload } from './storyMemoryObservationNormalizer';
import { compileStoryMemoryObservations } from './storyMemoryObservationCompiler';
import type { StoryMemoryObservationWarning } from './storyMemoryObservationTypes';
import { validateChapterMemoryPatch } from './storyMemoryValidator';
import {
  STORY_MEMORY_V2_REQUEST_KINDS,
} from './storyMemoryProtocolVersion';
import {
  createStoryMemoryV2Diagnostics,
  recordRecentStoryMemoryV2Diagnostics,
  recordStoryMemoryV2ObservationStats,
  recordStoryMemoryV2Plan,
  recordStoryMemoryV2Warnings,
  type StoryMemoryV2Diagnostics,
  type StoryMemoryV2DiagnosticsRef,
} from './storyMemoryV2Diagnostics';
import {
  applyStoryMemoryDebugConfig,
  consumeStoryMemoryDebugScenario,
  injectStoryMemoryDebugResult,
  recordStoryMemoryDebugObservationStats,
  type StoryMemoryDebugScenario,
} from './storyMemoryDebugHarness';

function renderBatchEpisodicText(
  summary: EpisodicSummary,
  chapter?: Pick<Chapter, 'synopsis' | 'content'>,
): string {
  const sections: Array<[string, string[]]> = [
    ['核心事件', [summary.brief, ...summary.events]],
    ['人物变化', summary.characterChanges],
    ['关系变化', summary.relationshipChanges],
    ['主线变化', summary.mainlineChanges],
    ['新增悬念', summary.newThreads],
    ['已解决事项', summary.resolvedThreads],
    ['关键词', summary.keywords],
  ];
  const rendered = sections
    .map(([label, values]) =>
      [...new Set(values.map(value => value.trim()).filter(Boolean))].length
        ? `${label}：${[
            ...new Set(values.map(value => value.trim()).filter(Boolean)),
          ].join('；')}`
        : '',
    )
    .filter(Boolean)
    .join('\n');
  if (rendered || !chapter) return rendered;
  const synopsis = chapter.synopsis.replace(/\s+/g, ' ').trim();
  if (synopsis) return `核心事件：${synopsis.slice(0, 240)}`;
  const contentExcerpt = chapter.content
    .replace(/^\s*#{1,6}[^\n]*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return contentExcerpt ? `核心事件：${contentExcerpt}` : '';
}

/**
 * Model-capability-aware checkpoint output budget.
 *
 * Legacy two-arg signature retained for compatibility; the optional third
 * argument carries the ACTIVE model capabilities (repair plan P1 §6.3) so the
 * budget never exceeds what the model window / max_output_tokens can accept.
 */
export function checkpointMaxTokens(
  memoryPatchMaxTokens: number,
  batchSize: number,
  model?: {
    contextWindow?: number;
    maxOutputTokens?: number;
    estimatedInputTokens?: number;
  },
): number {
  return planCheckpointMaxTokens({
    memoryPatchMaxTokens,
    batchSize,
    contextWindow: model?.contextWindow,
    maxOutputTokens: model?.maxOutputTokens,
    estimatedInputTokens: model?.estimatedInputTokens,
  });
}

function fingerprintBatchSource(chapters: Chapter[]): string {
  const ordered = [...chapters].sort((a, b) => a.position - b.position);
  return stableTextFingerprint(
    ordered
      .map(
        chapter =>
          `${chapter.id}:${chapter.position}:${fingerprintChapterSource(
            chapter,
          )}`,
      )
      .join('|'),
  );
}

async function requestCheckpoint(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  maxTokens: number,
  projectId: number,
  scenario: string,
  signal?: AbortSignal,
  attemptBudget?: StoryMemoryAttemptBudget,
  frozenConfig?: FrozenStoryMemoryLLMConfig,
  debugScenario?: StoryMemoryDebugScenario | null,
): Promise<LLMResult> {
  // Exactly one call enters the coordinator. Transport retries and protocol
  // fallbacks are accounted by the shared physical-request hook instead of a
  // hidden retry loop in this lower-level request helper.
  const result = await callLLMResult(
    messages,
    maxTokens,
    buildStoryMemoryLLMConfig({
      scenario,
      projectId,
      physicalRequestHooks: attemptBudget?.hooks(scenario),
      requestConfig: frozenConfig?.requestConfig,
    }),
    signal,
  );
  if (!result) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_FAILED',
      '检查点请求未能返回结果，请重试。',
    );
  }
  return injectStoryMemoryDebugResult(result, scenario, debugScenario);
}

export function parseAndValidateBatchPatch(
  output: string,
  previousState: StoryMemoryState,
  chapters: Chapter[],
  options: {
    recoverEvidence?: boolean;
    getDisplayNumber?: (position: number) => number;
  } = {},
): StoryMemoryBatchPatchDraft {
  const json = extractJSON(output);
  if (!json) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_INVALID_JSON',
      '模型没有返回完整的检查点 JSON 对象。',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_INVALID_JSON',
      '模型返回的检查点 JSON 无法解析。',
    );
  }
  return validateStoryMemoryBatchPatch(parsed, previousState, chapters, {
    ...options,
    requireMainlineAssessment: true,
  });
}

export async function generateValidatedCheckpointBatch(input: {
  chapters: Chapter[];
  previousState: StoryMemoryState;
  memoryPatchMaxTokens: number;
  frozenConfig?: FrozenStoryMemoryLLMConfig;
  signal?: AbortSignal;
  scenario?:
    | 'story_memory_checkpoint'
    | 'story_memory_checkpoint_legacy_bootstrap';
  attemptBudget?: StoryMemoryAttemptBudget;
  diagnosticsRef?: StoryMemoryV2DiagnosticsRef;
  splitUsed?: boolean;
  debugScenario?: StoryMemoryDebugScenario | null;
  onProgress?: (progress: StoryMemoryCheckpointProgressEvent) => void;
}): Promise<StoryMemoryBatchPatchDraft> {
  if (input.signal?.aborted) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_CANCELLED',
      '故事记忆检查点任务已取消。',
    );
  }
  if (!input.chapters.length) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_RANGE_MISMATCH',
      '检查点批次不能为空。',
    );
  }
  const projectId = input.chapters[0].project_id;
  const debugScenario =
    input.debugScenario === undefined
      ? await consumeStoryMemoryDebugScenario()
      : input.debugScenario;
  // Freeze the provider config together with the capability snapshot. Every
  // retry/repair for this logical batch must use this same model.
  const frozenConfig = applyStoryMemoryDebugConfig(
    input.frozenConfig || (await freezeStoryMemoryLLMConfig()),
    debugScenario,
  );
  const ordered = [...input.chapters].sort((left, right) => left.position - right.position);
  const handles = buildStoryMemoryEntityHandles(
    input.previousState,
    ordered.map(chapter => ({
      id: chapter.id,
      position: chapter.position,
      title: chapter.title,
    })),
  );
  const evidence = buildStoryMemoryEvidenceAnchors(
    ordered,
    handles.chapterHandleById,
  );
  const materials = buildStoryMemoryObservationMaterials(
    ordered,
    input.previousState,
    handles,
    evidence,
    {
      legacyBootstrap:
        input.scenario === 'story_memory_checkpoint_legacy_bootstrap',
    },
  );

  const attemptBudget =
    input.attemptBudget ||
    new StoryMemoryAttemptBudget({
      logicalBatchId: createStoryMemoryLogicalBatchId({
        projectId,
        fromPosition: ordered[0].position,
        throughPosition: ordered.at(-1)!.position,
        kind: 'story_memory_v2',
      }),
      projectId,
      fromPosition: ordered[0].position,
      throughPosition: ordered.at(-1)!.position,
      maxPhysicalRequests: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
    });
  const diagnosticsRef = input.diagnosticsRef || {};
  try {
    return await runObservationCheckpointAttemptLoop({
      chapters: ordered,
      previousState: input.previousState,
      projectId,
      signal: input.signal,
      materials,
      frozenConfig,
      attemptBudget,
      diagnosticsRef,
      splitUsed: input.splitUsed,
      debugScenario,
      allowLegacyChapterFallback: true,
      onProgress: input.onProgress,
    });
  } finally {
    if (!input.diagnosticsRef && diagnosticsRef.current) {
      recordRecentStoryMemoryV2Diagnostics(diagnosticsRef.current);
    }
  }
}

export interface StoryMemoryCheckpointProgressEvent {
  phase:
    | 'planning'
    | 'requesting'
    | 'validating'
    | 'applying'
    | 'saving';
  fromPosition: number;
  throughPosition: number;
  attempt: number | null;
  maxAttempts: number;
}

/**
 * Decide whether a paid Repair round can safely fit the model window
 * (governance plan §7.3).
 *
 * A Repair echoes the invalid assistant output plus a repair instruction on
 * top of the original prompt. If the invalid output itself is so large that
 * adding it would push the request past the hard input limit, we must NOT
 * truncate the invalid JSON (that would corrupt the repair signal). Instead
 * the caller skips Repair and falls through to a Fresh Retry.
 *
 * `invalidOutputTokens` is the estimated token cost of the model's previous
 * (invalid) JSON output. `baseInputTokens` is the original prompt's estimated
 * input tokens. `repairInstructionTokens` is the repair directive cost.
 * `hardInputLimit` is the model's hard input ceiling.
 */
export function shouldSkipRepairForInfeasibleSize(input: {
  invalidOutputTokens: number;
  baseInputTokens: number;
  repairInstructionTokens: number;
  hardInputLimit: number;
  contextWindow: number;
}): boolean {
  // Unknown capability → keep the legacy behaviour (attempt the repair).
  if (input.contextWindow <= 0 || input.hardInputLimit <= 0) return false;
  const repairInputEstimate =
    input.baseInputTokens + input.invalidOutputTokens + input.repairInstructionTokens;
  return repairInputEstimate > input.hardInputLimit;
}

interface ObservationCheckpointLoopInput {
  chapters: Chapter[];
  previousState: StoryMemoryState;
  projectId: number;
  signal?: AbortSignal;
  materials: StoryMemoryObservationMaterials;
  frozenConfig: FrozenStoryMemoryLLMConfig;
  attemptBudget: StoryMemoryAttemptBudget;
  diagnosticsRef?: StoryMemoryV2DiagnosticsRef;
  splitUsed?: boolean;
  debugScenario?: StoryMemoryDebugScenario | null;
  allowLegacyChapterFallback?: boolean;
  onProgress?: (progress: StoryMemoryCheckpointProgressEvent) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLegacyBatchPatchPayload(raw: unknown): raw is Record<string, unknown> {
  return isRecord(raw) && Number(raw.schemaVersion) === 2 && isRecord(raw.rangeRef);
}

function legacyQuote(quote: string, chapterId: number): Array<{ chapterId: number; quote: string }> {
  return quote.trim() ? [{ chapterId, quote }] : [];
}

function legacyChapterDraftToBatch(
  draft: ChapterMemoryPatchDraft,
  chapter: Chapter,
): StoryMemoryBatchPatchDraft {
  const batch = createEmptyBatchPatch([chapter]);
  const evidence = (quote: string) => legacyQuote(quote, chapter.id);
  batch.chapterSummaries = [
    {
      chapterId: chapter.id,
      chapterPosition: chapter.position,
      brief: draft.episodicSummary.brief || chapter.synopsis || chapter.content.slice(0, 80),
      keywords: draft.episodicSummary.keywords,
      events: draft.episodicSummary.events,
      characterChanges: draft.episodicSummary.characterChanges,
      relationshipChanges: draft.episodicSummary.relationshipChanges,
      mainlineChanges: draft.episodicSummary.mainlineChanges,
      newThreads: draft.episodicSummary.newThreads,
      resolvedThreads: draft.episodicSummary.resolvedThreads,
    },
  ];
  batch.newCharacters = draft.newCharacters.map(item => ({
    tempRef: item.tempRef,
    canonicalName: item.canonicalName,
    aliases: item.aliases,
    role: item.role,
    identity: item.identity,
    stableTraits: item.stableTraits,
    initialState: item.initialState,
    status: item.status,
    evidence: evidence(item.evidenceQuote),
  }));
  batch.characterUpdates = draft.characterUpdates.map(item => ({
    characterRef: item.characterRef,
    addAliases: item.addAliases,
    profileCorrections: item.profileCorrections,
    stateChanges: item.stateChanges,
    status: item.status,
    correctionReason: item.correctionReason,
    addKnowledge: item.addKnowledge,
    removeKnowledge: item.removeKnowledge,
    addPossessions: item.addPossessions,
    removePossessions: item.removePossessions,
    addSecrets: item.addSecrets,
    removeSecrets: item.removeSecrets,
    clearFields: item.clearFields,
    evidence: evidence(item.evidenceQuote),
  }));
  batch.newRelationships = draft.newRelationships.map(item => ({
    tempRef: item.tempRef,
    fromRef: item.fromRef,
    toRef: item.toRef,
    direction: item.direction,
    relationType: item.relationType,
    currentState: item.currentState,
    trustLevel: item.trustLevel,
    publicStatus: item.publicStatus,
    hiddenStatus: item.hiddenStatus,
    reason: item.reason,
    evidence: evidence(item.evidenceQuote),
  }));
  batch.relationshipUpdates = draft.relationshipUpdates.map(item => ({
    relationshipRef: item.relationshipRef,
    currentState: item.currentState,
    trustLevel: item.trustLevel,
    publicStatus: item.publicStatus,
    hiddenStatus: item.hiddenStatus,
    reason: item.reason,
    evidence: evidence(item.evidenceQuote),
  }));
  const mapEntity = (item: {
    ref: string;
    title: string;
    description?: string;
    state?: string;
    stakes?: string;
    parties?: string[];
    ownerCharacterRefs?: string[];
    priority?: import('./storyMemoryTypes').StoryThread['priority'];
    deadlineOrTrigger?: string;
    setup?: string;
    expectedPayoff?: string;
    status?: import('./storyMemoryTypes').StoryForeshadowing['status'];
    evidenceQuote: string;
  }) => ({
    ref: item.ref,
    title: item.title,
    description: item.description,
    state: item.state,
    stakes: item.stakes,
    parties: item.parties,
    ownerCharacterRefs: item.ownerCharacterRefs,
    priority: item.priority,
    deadlineOrTrigger: item.deadlineOrTrigger,
    setup: item.setup,
    expectedPayoff: item.expectedPayoff,
    status: item.status,
    evidence: evidence(item.evidenceQuote),
  });
  batch.mainlinePatch = {
    assessment: draft.mainlinePatch.assessment,
    currentArcUpdate: {
      action: draft.mainlinePatch.currentArcUpdate.action,
      arcRef: draft.mainlinePatch.currentArcUpdate.arcRef,
      name: draft.mainlinePatch.currentArcUpdate.name,
      summary: draft.mainlinePatch.currentArcUpdate.summary,
      evidence: evidence(draft.mainlinePatch.currentArcUpdate.evidenceQuote),
    },
    currentObjective: draft.mainlinePatch.currentObjective
      ? {
          value: draft.mainlinePatch.currentObjective.value,
          evidence: evidence(draft.mainlinePatch.currentObjective.evidenceQuote),
        }
      : undefined,
    conflictUpserts: draft.mainlinePatch.conflictUpserts.map(mapEntity),
    conflictResolutions: draft.mainlinePatch.conflictResolutions.map(item => ({
      conflictRef: item.conflictRef,
      resolution: item.resolution,
      evidence: evidence(item.evidenceQuote),
    })),
    threadOpens: draft.mainlinePatch.threadOpens.map(mapEntity),
    threadUpdates: draft.mainlinePatch.threadUpdates.map(mapEntity),
    threadResolutions: draft.mainlinePatch.threadResolutions.map(item => ({
      threadRef: item.threadRef,
      resolution: item.resolution,
      evidence: evidence(item.evidenceQuote),
    })),
    foreshadowingUpserts: draft.mainlinePatch.foreshadowingUpserts.map(mapEntity),
    timelineAnchors: draft.mainlinePatch.timelineAnchors.map(item => ({
      ref: item.ref,
      label: item.label,
      timeDescription: item.timeDescription,
      event: item.event,
      pinned: item.pinned,
      evidence: evidence(item.evidenceQuote),
    })),
    completedBeats: draft.mainlinePatch.completedBeats.map(item => ({
      ref: item.ref,
      summary: item.summary,
      evidence: evidence(item.evidenceQuote),
    })),
  };
  return batch;
}

interface ParsedObservationBatch {
  patch: StoryMemoryBatchPatchDraft;
  warnings: StoryMemoryObservationWarning[];
  observationsReceived: number;
  observationsAccepted: number;
}

function rawObservationCount(raw: unknown): number {
  if (!isRecord(raw)) return 0;
  let chapters: unknown[] = [];
  if (Array.isArray(raw.chapters)) {
    chapters = raw.chapters;
  } else {
    const wrapper = Object.values(raw).find(
      value => isRecord(value) && Array.isArray(value.chapters),
    );
    if (isRecord(wrapper) && Array.isArray(wrapper.chapters)) {
      chapters = wrapper.chapters;
    }
  }
  return chapters.reduce<number>((total, chapter) => {
    if (!isRecord(chapter) || !Array.isArray(chapter.observations)) return total;
    return total + chapter.observations.length;
  }, 0);
}

function parseAndCompileObservationBatch(
  output: string,
  input: ObservationCheckpointLoopInput,
): ParsedObservationBatch {
  const raw = parseStoryMemoryObservationCandidate(output);
  const observationsReceived = rawObservationCount(raw);
  // One release-cycle compatibility reader: old persisted/test candidates can
  // still be replayed, but no production V2 prompt asks the model to emit it.
  if (isLegacyBatchPatchPayload(raw)) {
    return {
      patch: validateStoryMemoryBatchPatch(raw, input.previousState, input.chapters, {
        recoverEvidence: true,
        requireMainlineAssessment: true,
      }),
      warnings: [],
      observationsReceived: 0,
      observationsAccepted: 0,
    };
  }
  if (
    input.allowLegacyChapterFallback &&
    isRecord(raw) &&
    Number(raw.schemaVersion) === 1 &&
    input.chapters.length === 1
  ) {
    const legacy = validateChapterMemoryPatch(
      raw,
      input.previousState,
      input.chapters[0].content,
      { requireMainlineAssessment: true },
    );
    return {
      patch: legacyChapterDraftToBatch(legacy, input.chapters[0]),
      warnings: [],
      observationsReceived: 0,
      observationsAccepted: 0,
    };
  }
  const expectedHandles = input.materials.handles.chapters.map(chapter => chapter.handle);
  const fallbackBriefByChapter = new Map(
    input.materials.handles.chapters.map(chapter => [
      chapter.handle,
      input.materials.evidence.anchors.find(anchor => anchor.chapterId === chapter.chapterId)?.text || '',
    ]),
  );
  const normalized = normalizeStoryMemoryObservationPayload(raw, expectedHandles, {
    fallbackBriefByChapter,
  });
  if (normalized.missingChapterHandles.length > 0) {
    // Coverage is a batch-level failure, but keep the safe structural warning
    // available to diagnostics before the fresh retry is scheduled.
    throw Object.assign(
      new StoryMemoryError(
        'MEMORY_CHECKPOINT_COVERAGE_GAP',
        `Observation 缺少章节：${normalized.missingChapterHandles.join(', ')}`,
      ),
      {
        observationWarnings: normalized.warnings,
        observationsReceived,
      },
    );
  }
  const compiled = compileStoryMemoryObservations({
    chapters: input.chapters,
    previousState: input.previousState,
    normalized: normalized.chapters,
    handles: input.materials.handles,
    evidence: input.materials.evidence,
  });
  return {
    patch: compiled.patch,
    warnings: [...normalized.warnings, ...compiled.warnings],
    observationsReceived,
    observationsAccepted: compiled.acceptedObservations,
  };
}

function observationFormatterMessages(
  candidate: string,
  input: ObservationCheckpointLoopInput,
  failureCode: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  return buildStoryMemoryObservationFormatterMessages({
    candidate,
    chapterHandles: input.materials.handles.chapters.map(chapter => chapter.handle),
    existingHandles: formatterHandleLists(input.materials.handles),
    evidenceIds: input.materials.evidence.anchors.map(anchor => anchor.id),
    failureCode,
  });
}

/**
 * Protocol V2 checkpoint generation. Persisted V1 readers remain below the
 * request boundary, while every new production LLM call enters this observer
 * loop.
 */
async function runObservationCheckpointAttemptLoop(
  input: ObservationCheckpointLoopInput,
): Promise<StoryMemoryBatchPatchDraft> {
  const batchSize = input.chapters.length;
  const baseMessages = buildMessagesFromObservationMaterials(input.materials);
  const diagnostics: StoryMemoryV2Diagnostics = createStoryMemoryV2Diagnostics({
    chapters: input.chapters,
    config: input.frozenConfig,
    materials: input.materials,
    handles: input.materials.handles,
    evidence: input.materials.evidence,
    fullInputTokens: estimateMessagesTokens(baseMessages),
    splitUsed: input.splitUsed,
  });
  let stage: 'primary' | 'formatter' | 'fresh' = 'primary';
  let currentMessages = baseMessages;
  let attempt = 0;
  try {
    while (attempt < STORY_MEMORY_MAX_PHYSICAL_REQUESTS) {
    if (input.signal?.aborted) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_CANCELLED',
        '故事记忆检查点任务已取消。',
      );
    }
      const plan =
      stage === 'primary'
        ? planStoryMemoryObservationRequest({
            config: input.frozenConfig,
            materials: input.materials,
            batchSize,
          })
        : planStoryMemoryObservationMessages({
            config: input.frozenConfig,
            messages: currentMessages,
            batchSize,
          });
      recordStoryMemoryV2Plan(diagnostics, plan, input.materials);
      if (plan.strategy !== 'full_prompt') {
      if (stage === 'formatter') {
        stage = 'fresh';
        currentMessages = buildStoryMemoryObservationFreshRetryMessages(
          baseMessages,
          plan.reason || 'Formatter 输入超出当前模型窗口',
        );
        continue;
      }
      throw new StoryMemoryError(
        batchSize > 1
          ? 'MEMORY_CHECKPOINT_BATCH_TOO_LARGE'
          : 'MEMORY_CHECKPOINT_FAILED',
        plan.reason || '当前模型无法容纳单批 Protocol V2 Observation 请求。',
      );
    }
      attempt += 1;
      diagnostics.physicalAttemptCount = attempt;
      diagnostics.formatterUsed ||= stage === 'formatter';
      diagnostics.freshRetryUsed ||= stage === 'fresh';
      const scenario =
      stage === 'primary'
        ? input.materials.legacyBootstrap
          ? STORY_MEMORY_V2_REQUEST_KINDS.legacyBootstrap
          : STORY_MEMORY_V2_REQUEST_KINDS.primary
        : stage === 'formatter'
          ? STORY_MEMORY_V2_REQUEST_KINDS.formatter
          : STORY_MEMORY_V2_REQUEST_KINDS.freshRetry;
      input.onProgress?.({
      phase: 'planning',
      fromPosition: input.chapters[0].position,
      throughPosition: input.chapters.at(-1)!.position,
      attempt: null,
      maxAttempts: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
    });
      let result: LLMResult;
      try {
      result = await requestCheckpoint(
        plan.messages,
        plan.maxTokens,
        input.projectId,
        scenario,
        input.signal,
        input.attemptBudget,
        input.frozenConfig,
        input.debugScenario,
      );
      } catch (error) {
      if (
        !input.signal?.aborted &&
        isSafeStoryMemoryRetryError(error) &&
        attempt < STORY_MEMORY_MAX_PHYSICAL_REQUESTS &&
        (input.attemptBudget.hasObservedPhysicalRequest
          ? input.attemptBudget.canSend()
          : true)
      ) {
        stage = 'fresh';
        currentMessages = buildStoryMemoryObservationFreshRetryMessages(
          baseMessages,
          error instanceof Error ? error.message : '网络请求失败',
        );
        continue;
      }
        throw error;
      }
      input.onProgress?.({
      phase: 'validating',
      fromPosition: input.chapters[0].position,
      throughPosition: input.chapters.at(-1)!.position,
      attempt,
      maxAttempts: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
    });
      const text = result?.text?.trim() || '';
      diagnostics.responseCandidateChars = Math.max(
        diagnostics.responseCandidateChars,
        text.length,
      );
      if (text) {
        try {
          const parsed = parseAndCompileObservationBatch(text, input);
          recordStoryMemoryV2Warnings(diagnostics, parsed.warnings);
          recordStoryMemoryV2ObservationStats(diagnostics, {
            responseCandidateChars: text.length,
            observationsReceived: parsed.observationsReceived,
            observationsAccepted: parsed.observationsAccepted,
          });
          recordStoryMemoryDebugObservationStats({
            scenario: input.debugScenario,
            requestKind: scenario,
            observationsReceived: parsed.observationsReceived,
            observationsAccepted: parsed.observationsAccepted,
            warningCount: parsed.warnings.length,
          });
          return parsed.patch;
        } catch (parseError) {
          const observationWarnings = (
            parseError as { observationWarnings?: StoryMemoryObservationWarning[] }
          ).observationWarnings;
          if (observationWarnings) {
            recordStoryMemoryV2Warnings(diagnostics, observationWarnings);
            recordStoryMemoryV2ObservationStats(diagnostics, {
              responseCandidateChars: text.length,
              observationsReceived: Number(
                (parseError as { observationsReceived?: number }).observationsReceived || 0,
              ),
              observationsAccepted: 0,
            });
          }
        if (input.signal?.aborted) {
          throw new StoryMemoryError(
            'MEMORY_CHECKPOINT_CANCELLED',
            '故事记忆检查点任务已取消。',
          );
        }
        const message = parseError instanceof Error ? parseError.message : 'Observation 校验失败';
        if (
          stage === 'primary' &&
          result.finishReason === 'length' &&
          batchSize > 1
        ) {
          throw new StoryMemoryError(
            'MEMORY_CHECKPOINT_BATCH_TOO_LARGE',
            `Protocol V2 多章 Observation 输出被截断（reservation=${plan.maxTokens}），已在发送前拆分。`,
          );
        }
        if (
          attempt >= STORY_MEMORY_MAX_PHYSICAL_REQUESTS &&
          input.allowLegacyChapterFallback &&
          batchSize === 1
        ) {
          try {
            const legacyRaw = parseStoryMemoryObservationCandidate(text);
            if (isRecord(legacyRaw) && Number(legacyRaw.schemaVersion) === 1) {
              const recovered = validateChapterMemoryPatch(
                legacyRaw,
                input.previousState,
                input.chapters[0].content,
                { recoverEvidence: true, requireMainlineAssessment: true },
              );
              return legacyChapterDraftToBatch(recovered, input.chapters[0]);
            }
          } catch {
            // Preserve the original precise failure below.
          }
        }
        if (attempt >= STORY_MEMORY_MAX_PHYSICAL_REQUESTS) throw parseError;
        if (
          parseError instanceof StoryMemoryError &&
          parseError.code === 'MEMORY_CHECKPOINT_COVERAGE_GAP'
        ) {
          stage = 'fresh';
          currentMessages = buildStoryMemoryObservationFreshRetryMessages(
            baseMessages,
            message,
          );
          continue;
        }
        if (
          parseError instanceof StoryMemoryError &&
          message.includes('本地 Observation Compiler')
        ) {
          // A compiler invariant is a client defect, not an LLM repair case.
          throw parseError;
        }
        if (stage === 'primary') {
          const formatterMessages = observationFormatterMessages(
            text,
            input,
            message,
          );
          const formatterPlan = planStoryMemoryObservationMessages({
            config: input.frozenConfig,
            messages: formatterMessages,
            batchSize,
          });
          if (formatterPlan.strategy === 'full_prompt') {
            stage = 'formatter';
            currentMessages = formatterMessages;
          } else {
            stage = 'fresh';
            currentMessages = buildStoryMemoryObservationFreshRetryMessages(
              baseMessages,
              formatterPlan.reason || message,
            );
          }
        } else {
          stage = 'fresh';
          currentMessages = buildStoryMemoryObservationFreshRetryMessages(
            baseMessages,
            message,
          );
        }
        continue;
      }
    }
    const action = decideEmptyResponseAction({
      emptyReason: result?.emptyReason,
      finishReason: result?.finishReason,
      attempt: input.attemptBudget.hasObservedPhysicalRequest
        ? input.attemptBudget.used
        : attempt,
      maxAttempts: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
      currentBudget: plan.maxTokens,
      nextBudget: plan.maxTokens,
    });
    if (action.type === 'fail') {
      if (action.shrinkBatch && batchSize > 1) {
        throw new StoryMemoryError(
          'MEMORY_CHECKPOINT_BATCH_TOO_LARGE',
          action.reason,
        );
      }
      throw new StoryMemoryError(
        action.code as StoryMemoryError['code'],
        action.reason,
      );
    }
    stage = 'fresh';
    currentMessages = buildStoryMemoryObservationFreshRetryMessages(
      baseMessages,
      result?.emptyReason || result?.finishReason || '模型没有返回内容',
    );
  }
  throw new StoryMemoryError(
    'MEMORY_CHECKPOINT_FAILED',
    'Protocol V2 Observation 生成失败，已超过最大尝试次数。',
  );
  } finally {
    if (input.diagnosticsRef) {
      input.diagnosticsRef.current = {
        ...diagnostics,
        materialCounts: { ...diagnostics.materialCounts },
        droppedMaterialCounts: { ...diagnostics.droppedMaterialCounts },
        dropReasons: { ...diagnostics.dropReasons },
      };
    }
  }
}

export interface RunCheckpointBatchResult {
  state: StoryMemoryState;
  batch: StoredStoryMemoryBatch;
  chapterSummaryTexts: Array<{ chapterId: number; text: string }>;
}

export async function runStoryMemoryCheckpointBatch(input: {
  projectId: number;
  chapters: Chapter[];
  previousState: StoryMemoryState;
  /**
   * Fingerprint currently persisted in project_story_memory. During a rebuild
   * this can differ from previousState because the latter comes from an older
   * snapshot. The repository uses it as the atomic compare-and-swap guard.
   */
  expectedPersistedFingerprint?: string;
  memoryPatchMaxTokens?: number;
  /** One frozen provider/capability snapshot shared by all split children. */
  frozenConfig?: FrozenStoryMemoryLLMConfig;
  createSnapshot?: boolean;
  signal?: AbortSignal;
  scenario?:
    | 'story_memory_checkpoint'
    | 'story_memory_checkpoint_legacy_bootstrap';
  onDiagnostics?: (diagnostics: StoryMemoryV2Diagnostics) => void;
  splitUsed?: boolean;
  debugScenario?: StoryMemoryDebugScenario | null;
  onProgress?: (progress: StoryMemoryCheckpointProgressEvent) => void;
  /**
   * Fired once per persisted split child (governance §9). When a 3-chapter
   * logical batch splits 2+1 and the first half is persisted, this fires
   * before the second half begins, so the task store can advance
   * completedChapters incrementally rather than only at full-batch success.
   */
  onChildBatchComplete?: (range: {
    fromPosition: number;
    throughPosition: number;
  }) => void;
}): Promise<RunCheckpointBatchResult> {
  const ordered = [...input.chapters].sort((a, b) => a.position - b.position);
  if (!ordered.length) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_RANGE_MISMATCH',
      '检查点批次不能为空。',
    );
  }
  const config =
    input.memoryPatchMaxTokens != null
      ? { memoryPatchMaxTokens: input.memoryPatchMaxTokens }
      : await db.getContextConfig();
  const frozenConfig =
    input.frozenConfig || (await freezeStoryMemoryLLMConfig());
  const debugScenario =
    input.debugScenario === undefined
      ? await consumeStoryMemoryDebugScenario()
      : input.debugScenario;
  return runStoryMemoryCheckpointBatchWithShrink(
    { ...input, chapters: ordered, frozenConfig, debugScenario },
    config.memoryPatchMaxTokens || 1200,
  );
}

/**
 * V2.11.38 repair plan P1 §6.2/§8.2: when a batch is too large for the model
 * (MEMORY_CHECKPOINT_BATCH_TOO_LARGE), split it in half and run the halves
 * sequentially. The first half is persisted before the second half starts, so
 * a failure on the second half still keeps the first half's clean checkpoint
 * (partial success semantics). One chapter that still cannot fit surfaces an
 * actionable model-capability error.
 *
 * Code-review fix 1: when the FIRST half succeeded and the SECOND half fails,
 * the thrown error carries `partial` (the latest persisted state, its
 * completed-chapter count and summary texts). Outer coordinators (advance /
 * rebuild) consume it so they write back the newest successful status —
 * never the stale function-entry empty/dirty snapshot, and never 'failed'.
 */
async function runStoryMemoryCheckpointBatchWithShrink(
  input: Parameters<typeof runStoryMemoryCheckpointBatch>[0],
  memoryPatchMaxTokens: number,
): Promise<RunCheckpointBatchResult> {
  try {
    return await runStoryMemoryCheckpointBatchCore(
      input,
      memoryPatchMaxTokens,
    );
  } catch (error) {
    if (
      error instanceof StoryMemoryError &&
      error.code === 'MEMORY_CHECKPOINT_BATCH_TOO_LARGE' &&
      input.chapters.length > 1
    ) {
      const half = Math.ceil(input.chapters.length / 2);
      const firstChapters = input.chapters.slice(0, half);
      const first = await runStoryMemoryCheckpointBatchWithShrink(
        { ...input, chapters: firstChapters, splitUsed: true },
        memoryPatchMaxTokens,
      );
      // Governance §9: surface the first split child's persistence as
      // incremental progress so the task store's completedChapters reflects
      // real work even if the second child later fails.
      input.onChildBatchComplete?.({
        fromPosition: firstChapters[0].position,
        throughPosition: firstChapters.at(-1)!.position,
      });
      try {
        const second = await runStoryMemoryCheckpointBatchWithShrink(
          {
            ...input,
            chapters: input.chapters.slice(half),
            previousState: first.state,
            expectedPersistedFingerprint:
              first.state.metadata.stateFingerprint,
            splitUsed: true,
          },
          memoryPatchMaxTokens,
        );
        return {
          state: second.state,
          batch: second.batch,
          chapterSummaryTexts: [
            ...first.chapterSummaryTexts,
            ...second.chapterSummaryTexts,
          ],
        };
      } catch (secondError) {
        // The first half is already persisted and MUST NOT be rolled back or
        // overwritten by the caller's stale state. Attach the latest
        // successful state to the failure (any error type — a plain network
        // Error must keep its own classification while still carrying the
        // partial success). If the second half itself already carried an
        // inner partial (deeper split), keep that newer state and accumulate
        // its completed chapters.
        const innerPartial = (secondError as {
          partial?: StoryMemoryPartialSuccess;
        }).partial;
        const merged: StoryMemoryPartialSuccess = innerPartial
          ? {
              state: innerPartial.state,
              completedChapters:
                innerPartial.completedChapters +
                first.chapterSummaryTexts.length,
              chapterSummaryTexts: [
                ...first.chapterSummaryTexts,
                ...innerPartial.chapterSummaryTexts,
              ],
            }
          : {
              state: first.state,
              completedChapters: first.chapterSummaryTexts.length,
              chapterSummaryTexts: first.chapterSummaryTexts,
            };
        (secondError as { partial?: StoryMemoryPartialSuccess }).partial =
          merged;
        throw secondError;
      }
    }
    throw error;
  }
}

async function runStoryMemoryCheckpointBatchCore(
  input: Parameters<typeof runStoryMemoryCheckpointBatch>[0],
  memoryPatchMaxTokens: number,
): Promise<RunCheckpointBatchResult> {
  const ordered = [...input.chapters].sort((a, b) => a.position - b.position);
  const attemptBudget = new StoryMemoryAttemptBudget({
    logicalBatchId: createStoryMemoryLogicalBatchId({
      projectId: input.projectId,
      fromPosition: ordered[0].position,
      throughPosition: ordered.at(-1)!.position,
      kind: 'story_memory_v2',
    }),
    projectId: input.projectId,
    fromPosition: ordered[0].position,
    throughPosition: ordered.at(-1)!.position,
    maxPhysicalRequests: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
  });
  const diagnosticsRef: StoryMemoryV2DiagnosticsRef = {};
  let draft: StoryMemoryBatchPatchDraft;
  try {
    draft = await generateValidatedCheckpointBatch({
      chapters: ordered,
      previousState: input.previousState,
      memoryPatchMaxTokens,
      frozenConfig: input.frozenConfig,
      signal: input.signal,
      scenario: input.scenario,
      attemptBudget,
      diagnosticsRef,
      splitUsed: input.splitUsed,
      debugScenario: input.debugScenario,
      onProgress: input.onProgress,
    });
  } catch (error) {
    if (diagnosticsRef.current) {
      recordRecentStoryMemoryV2Diagnostics(diagnosticsRef.current);
      input.onDiagnostics?.(diagnosticsRef.current);
    }
    throw error;
  }
  const sourceFingerprint = fingerprintBatchSource(ordered);
  const batchId = `batch_${input.projectId}_${ordered[0].position}_${
    ordered[ordered.length - 1].position
  }_${sourceFingerprint}`;
  const applied = applyStoryMemoryBatchPatch(input.previousState, draft, {
    projectId: input.projectId,
    sourceFingerprint,
    baseMemoryFingerprint: fingerprintStoryMemoryState(input.previousState),
    now: new Date().toISOString(),
    batchId,
    title: ordered[ordered.length - 1].title,
  });
  input.onProgress?.({
    phase: 'applying',
    fromPosition: ordered[0].position,
    throughPosition: ordered.at(-1)!.position,
    attempt: null,
    maxAttempts: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
  });
  const chapterSummaryTexts = draft.chapterSummaries.map(summary => {
    const chapter = ordered.find(item => item.id === summary.chapterId);
    const episodic: EpisodicSummary = {
      brief: summary.brief,
      keywords: summary.keywords,
      events: summary.events,
      characterChanges: summary.characterChanges,
      relationshipChanges: summary.relationshipChanges,
      mainlineChanges: summary.mainlineChanges,
      newThreads: summary.newThreads,
      resolvedThreads: summary.resolvedThreads,
    };
    const text = renderBatchEpisodicText(episodic, chapter);
    return {
      chapterId: summary.chapterId,
      text,
      estimatedTokens: estimateTokens(text),
    };
  });
  input.onProgress?.({
    phase: 'saving',
    fromPosition: ordered[0].position,
    throughPosition: ordered.at(-1)!.position,
    attempt: null,
    maxAttempts: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
  });
  await db.saveStoryMemoryBatchUpdate({
    previousFingerprint:
      input.expectedPersistedFingerprint ||
      input.previousState.metadata.stateFingerprint,
    state: applied.state,
    batch: applied.resolvedBatch,
    chapterSummaries: chapterSummaryTexts,
    createSnapshot: input.createSnapshot !== false,
  });
  if (diagnosticsRef.current) {
    const diagnostics = {
      ...diagnosticsRef.current,
      applied: true,
      materialCounts: { ...diagnosticsRef.current.materialCounts },
      droppedMaterialCounts: {
        ...diagnosticsRef.current.droppedMaterialCounts,
      },
      dropReasons: { ...diagnosticsRef.current.dropReasons },
    };
    recordRecentStoryMemoryV2Diagnostics(diagnostics);
    input.onDiagnostics?.(diagnostics);
  }
  invalidateIdf(input.projectId);
  return {
    state: applied.state,
    batch: applied.resolvedBatch,
    chapterSummaryTexts,
  };
}

/**
 * Apply one or more checkpoint batches for pending chapters under project lock.
 * Always uses one LLM request per batch (max 10 chapters), never N per-chapter patches.
 */
/**
 * Advance checkpoints for pending final chapters.
 * Caller must already hold the project memory lock (or guarantee single-flight).
 */
export async function advanceStoryMemoryCheckpointsUnlocked(input: {
  projectId: number;
  throughPosition?: number;
  signal?: AbortSignal;
  onDiagnostics?: (diagnostics: StoryMemoryV2Diagnostics) => void;
  onProgress?: (progress: StoryMemoryCheckpointProgressEvent) => void;
  onBatchComplete?: (range: {
    fromPosition: number;
    throughPosition: number;
  }) => void;
  /**
   * Per persisted split child (governance §9). When a logical batch splits,
   * this fires as each child half is persisted, so the task store advances
   * completedChapters incrementally. If a logical batch does NOT split, only
   * onBatchComplete fires (once, for the whole batch).
   */
  onChildBatchComplete?: (range: {
    fromPosition: number;
    throughPosition: number;
  }) => void;
}): Promise<{
  state: StoryMemoryState;
  batchesApplied: number;
  pendingRemaining: number;
}> {
  const chapters = (await db.getChaptersByProject(input.projectId)).filter(
    chapter =>
      Boolean(chapter.content?.trim()) &&
      (chapter.status === 'final' ||
        chapter.finalized_at != null ||
        Boolean(chapter.memory_summary?.trim())),
  );
  const record = await db.ensureProjectStoryMemoryRow(input.projectId);
  let state = record.state;
  const throughCap =
    input.throughPosition ??
    chapters.at(-1)?.position ??
    state.throughChapterPosition;
  const pending = chapters
    .filter(
      chapter =>
        chapter.position > state.throughChapterPosition &&
        chapter.position <= throughCap,
    )
    .sort((a, b) => a.position - b.position);
  if (!pending.length) {
    return {
      state,
      batchesApplied: 0,
      pendingRemaining: 0,
    };
  }
  // Fixed safe LLM batch size, decoupled from the trigger interval: even when
  // the policy interval is 10 chapters, one extraction call never handles more
  // than STORY_MEMORY_DEFAULT_BATCH_SIZE (3) chapters.
  const batches = splitCheckpointBatches(
    pending,
    STORY_MEMORY_DEFAULT_BATCH_SIZE,
  );
  let batchesApplied = 0;
  for (const batchChapters of batches) {
    if (input.signal?.aborted) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_CANCELLED',
        '故事记忆检查点任务已取消。',
      );
    }
    try {
      const result = await runStoryMemoryCheckpointBatch({
        projectId: input.projectId,
        chapters: batchChapters,
        previousState: state,
        signal: input.signal,
        onDiagnostics: input.onDiagnostics,
        onProgress: input.onProgress,
        onChildBatchComplete: input.onChildBatchComplete,
      });
      state = result.state;
      batchesApplied += 1;
      input.onBatchComplete?.({
        fromPosition: batchChapters[0].position,
        throughPosition: batchChapters.at(-1)!.position,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '检查点更新失败';
      if (
        error instanceof StoryMemoryError &&
        error.code === 'MEMORY_BASE_FINGERPRINT_MISMATCH'
      ) {
        await db.markStoryMemoryDirty(
          input.projectId,
          batchChapters[0]?.position ?? state.throughChapterPosition + 1,
          message,
        );
        throw error;
      }
      // Append-only checkpoint advance failure: the previously successful
      // checkpoint remains valid (it is the latest SUCCESSFUL state, still
      // persisted in the row). Preserve the latest persisted status — never
      // flip a clean/empty record to 'failed', and never write back the
      // function-entry status: after batch1 succeeded `state` carries the
      // persisted clean status, while `record` (entry snapshot) still says
      // 'empty' and would clobber the row back to empty. When a split batch
      // persisted its first half and failed on the second, the error carries
      // `partial.state` — the newest persisted state — which is even newer
      // than `state`. `lastError` still records the failed attempt.
      const partial = (error as { partial?: StoryMemoryPartialSuccess } | null)
        ?.partial;
      const latestState = partial?.state ?? state;
      await db.setStoryMemoryBuildStatus(
        input.projectId,
        latestState.metadata.status,
        latestState.metadata.dirtyFromPosition,
        message,
      );
      throw error;
    }
  }
  const remaining = chapters.filter(
    chapter => chapter.position > state.throughChapterPosition,
  ).length;
  return { state, batchesApplied, pendingRemaining: remaining };
}

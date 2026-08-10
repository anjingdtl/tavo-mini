import type { Chapter } from '../../types/novel';
import type { ContinuationChapterPosition } from '../../types/novel';
import { extractJSON } from '../../utils/jsonExtractor';
import { invalidateIdf } from '../../utils/idfCache';
import { estimateTokens } from '../../utils/tokenEstimator';
import * as db from '../database';
import { callLLMResult, type LLMResult } from '../llm';
import { generateMemorySummary } from '../summaryGenerator';
import { fingerprintChapterSource } from './storyMemoryFingerprint';
import { applyStoryMemoryPatch } from './storyMemoryMerger';
import {
  buildStoryMemoryFreshRetryMessages,
  buildStoryMemoryPatchMessages,
  buildStoryMemoryRepairMessages,
} from './storyMemoryPrompts';
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
import type {
  ChapterMemoryPatchDraft,
  StoryMemoryState,
} from './storyMemoryTypes';
import { StoryMemoryError } from './storyMemoryTypes';
import { validateChapterMemoryPatch } from './storyMemoryValidator';
import {
  createDefaultStoryMemoryPolicy,
  evaluateStoryMemoryDue,
  listPendingChapters,
  predictNextCheckpointPosition,
} from './storyMemoryPolicy';
import { advanceStoryMemoryCheckpointsUnlocked } from './storyMemoryCheckpointService';
import { rebuildStoryMemoryUnlocked } from './storyMemoryRebuild';
import {
  checkpointMaxTokens as planPatchMaxTokens,
  decideCheckpointBatchSize,
  estimateCheckpointInputTokens,
  nextCheckpointBudget,
} from './storyMemoryBudget';
import { listStoryMemoryRequestAttempts } from '../../data/repositories/storyMemoryRequestAttemptRepository';

/**
 * Resolve a display-number mapper for user-visible Story Memory text (Spec §11.3).
 * Uses the continuation numbering service when a boundary exists; otherwise
 * falls back to position+1 (outline / offline hand-written continuation).
 */
async function loadDisplayNumberFn(
  projectId: number,
): Promise<(position: number) => number> {
  try {
    const { getContinuationChapterNumbering } = await import(
      '../continuation/chapterNumbering/continuationChapterNumbering'
    );
    const numbering = await getContinuationChapterNumbering(projectId);
    return position =>
      numbering.getDisplayNumber(position as ContinuationChapterPosition);
  } catch {
    return position => position + 1;
  }
}

function chapterLabel(
  getDisplayNumber: (position: number) => number,
  position: number,
): string {
  return `第 ${getDisplayNumber(position)} 章`;
}

export interface FinalizeChapterMemoryResult {
  state: StoryMemoryState;
  patchId: string;
  episodicMemoryText: string;
  reused: boolean;
  /** Local chapter finalize always succeeds first when this is true. */
  chapterFinalized: boolean;
  /** Whether a long-term checkpoint batch was attempted. */
  checkpointAttempted: boolean;
  /** Whether checkpoint batch succeeded. */
  checkpointUpdated: boolean;
  /** Whether maintenance was queued after the local finalize transaction. */
  maintenanceQueued?: boolean;
  pendingCount: number;
  statusMessage: string;
}

/** Keep already-covered later chapters when rebuilding after an older edit. */
export function resolveDirtyRebuildThroughPosition(
  checkpointThroughPosition: number,
  finalizedChapterPosition: number,
  scheduledThroughPosition: number | null,
): number {
  return Math.max(
    checkpointThroughPosition,
    finalizedChapterPosition,
    scheduledThroughPosition ?? -1,
  );
}

const projectLocks = new Map<number, Promise<void>>();

export async function withProjectMemoryLock<T>(
  projectId: number,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = projectLocks.get(projectId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  projectLocks.set(projectId, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (projectLocks.get(projectId) === queued) projectLocks.delete(projectId);
  }
}

const inflightTasks = new Map<string, Promise<unknown>>();

/**
 * V2.11.38 repair plan P2 — process-wide in-flight dedupe for Story Memory
 * maintenance tasks. Preview / finalize / generation may all ask to maintain
 * the SAME project+range concurrently; a second caller with the same key
 * reuses the running promise instead of queueing a duplicate checkpoint run.
 *
 * The project lock alone already serializes maintenance, but without dedupe a
 * second queued caller would re-read the DB and re-run an empty advance; with
 * dedupe it simply awaits the in-flight maintenance. Failures propagate to
 * every caller — nothing is swallowed fire-and-forget.
 */
export async function runStoryMemoryTaskOnce<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const existing = inflightTasks.get(key);
  if (existing) return existing as Promise<T>;
  const promise = task().finally(() => {
    if (inflightTasks.get(key) === promise) inflightTasks.delete(key);
  });
  inflightTasks.set(key, promise);
  return promise;
}

/** True while a Story Memory maintenance task for this key is running. */
export function isStoryMemoryTaskRunning(key: string): boolean {
  return inflightTasks.has(key);
}

export type StoryMemoryMaintenanceReason =
  | 'interval'
  | 'dirty'
  | 'coverage_gap'
  | 'manual';

export interface StoryMemoryMaintenanceRequest {
  projectId: number;
  throughPosition: number;
  reason: StoryMemoryMaintenanceReason;
  priority?: 'background' | 'manual';
  signal?: AbortSignal;
}

export interface StoryMemoryMaintenanceResult {
  projectId: number;
  throughPosition: number;
  state: StoryMemoryState;
  batchesApplied: number;
  pendingRemaining: number;
}

/**
 * Durable-aware coordinator. The in-memory single-flight map only suppresses
 * duplicate work in one process; the request-attempt ledger below prevents a
 * cold-started process from silently replaying a request whose provider
 * outcome was unknown.
 */
export async function requestStoryMemoryMaintenance(
  input: StoryMemoryMaintenanceRequest,
): Promise<StoryMemoryMaintenanceResult> {
  const throughPosition = Math.max(-1, Math.floor(input.throughPosition));
  const key = `story-memory-maintain:${input.projectId}:${throughPosition}`;
  return runStoryMemoryTaskOnce(key, () =>
    withProjectMemoryLock(input.projectId, async () => {
      const unknown = await listStoryMemoryRequestAttempts(input.projectId, [
        'prepared',
        'sent',
        'outcome_unknown',
      ]);
      if (unknown.length > 0) {
        throw new StoryMemoryError(
          'MEMORY_CHECKPOINT_OUTCOME_UNKNOWN',
          `检测到 ${unknown.length} 个结果未知的长期记忆请求，已停止自动重发，请在故事记忆页面确认后重试。`,
        );
      }

      const record = await db.ensureProjectStoryMemoryRow(input.projectId);
      if (record.status === 'dirty' || input.reason === 'dirty') {
        const rebuilt = await rebuildStoryMemoryUnlocked(input.projectId, {
          mode: 'auto',
          throughPosition,
          signal: input.signal,
        });
        const rebuiltPending = (await db.getChaptersByProject(input.projectId)).filter(
          chapter =>
            Boolean(chapter.content?.trim()) &&
            chapter.position > rebuilt.state.throughChapterPosition &&
            chapter.position <= throughPosition,
        ).length;
        return {
          projectId: input.projectId,
          throughPosition,
          state: rebuilt.state,
          batchesApplied: rebuilt.completedChapters > 0 ? 1 : 0,
          pendingRemaining: rebuiltPending,
        };
      }
      const advanced = await advanceStoryMemoryCheckpointsUnlocked({
        projectId: input.projectId,
        throughPosition,
        signal: input.signal,
      });
      return {
        projectId: input.projectId,
        throughPosition,
        state: advanced.state,
        batchesApplied: advanced.batchesApplied,
        pendingRemaining: advanced.pendingRemaining,
      };
    }),
  );
}

/** Queue background maintenance without making the caller await the LLM. */
export function enqueueStoryMemoryMaintenance(
  input: StoryMemoryMaintenanceRequest,
): void {
  setTimeout(() => {
    // Background maintenance is best-effort and never becomes an unhandled
    // rejection. The coordinator/advance path persists terminal diagnostics.
    void requestStoryMemoryMaintenance(input).catch(() => undefined);
  }, 0);
}

export interface GenerateChapterMemoryPatchInput {
  chapter: Chapter;
  previousState: StoryMemoryState;
  memoryPatchMaxTokens: number;
  signal?: AbortSignal;
  scenario?: 'story_memory_patch' | 'story_memory_legacy_bootstrap';
  attemptBudget?: StoryMemoryAttemptBudget;
}

export function parseAndValidateMemoryPatch(
  output: string,
  previousState: StoryMemoryState,
  chapterContent: string,
  options: { recoverEvidence?: boolean } = {},
): ChapterMemoryPatchDraft {
  const json = extractJSON(output);
  if (!json) {
    throw new StoryMemoryError(
      'MEMORY_PATCH_INVALID_JSON',
      '模型没有返回完整的 JSON 对象。',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new StoryMemoryError(
      'MEMORY_PATCH_INVALID_JSON',
      '模型返回的记忆补丁 JSON 无法解析。',
    );
  }
  return validateChapterMemoryPatch(parsed, previousState, chapterContent, {
    ...options,
    requireMainlineAssessment: true,
  });
}

async function requestPatch(
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>,
  maxTokens: number,
  projectId: number,
  scenario: string,
  signal?: AbortSignal,
  attemptBudget?: StoryMemoryAttemptBudget,
): Promise<LLMResult> {
  const result = await callLLMResult(
    messages,
    maxTokens,
    buildStoryMemoryLLMConfig({
      scenario,
      projectId,
      physicalRequestHooks: attemptBudget?.hooks(),
    }),
    signal,
  );
  if (!result) {
    throw new StoryMemoryError(
      'MEMORY_PATCH_INVALID_JSON',
      '记忆补丁请求未能返回结果，请重试。',
    );
  }
  return result;
}

export async function generateValidatedChapterMemoryPatch(
  input: GenerateChapterMemoryPatchInput,
): Promise<ChapterMemoryPatchDraft> {
  if (input.signal?.aborted) {
    throw new StoryMemoryError(
      'MEMORY_REBUILD_CANCELLED',
      '故事记忆任务已取消。',
    );
  }
  const messages = buildStoryMemoryPatchMessages(
    input.chapter,
    input.previousState,
  );
  const scenario = input.scenario || 'story_memory_patch';
  // Code-review fix 5: reuse the single Story Memory budget planner instead of
  // the legacy fixed 2400..16000 derivation. The ACTIVE model's
  // context_window / max_output_tokens clamp every request (initial AND each
  // retry), so a small model never receives a doomed oversized request.
  let model: { contextWindow?: number; maxOutputTokens?: number } = {};
  try {
    const active = await db.getActiveLLMConfig();
    const contextWindow = Number(active?.context_window);
    const maxOutputTokens = Number(active?.max_output_tokens);
    model = {
      contextWindow: contextWindow > 0 ? contextWindow : undefined,
      maxOutputTokens: maxOutputTokens > 0 ? maxOutputTokens : undefined,
    };
  } catch {
    // Unknown model capability → legacy derivation, no extra clamp.
  }
  const inputTokens = estimateCheckpointInputTokens(messages);
  const attemptBudget =
    input.attemptBudget ||
    new StoryMemoryAttemptBudget({
      logicalBatchId: createStoryMemoryLogicalBatchId({
        projectId: input.chapter.project_id,
        fromPosition: input.chapter.position,
        throughPosition: input.chapter.position,
        kind: input.scenario || 'patch',
      }),
      projectId: input.chapter.project_id,
      fromPosition: input.chapter.position,
      throughPosition: input.chapter.position,
      maxPhysicalRequests: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
      durable: false,
    });
  let budget = planPatchMaxTokens({
    memoryPatchMaxTokens: input.memoryPatchMaxTokens,
    batchSize: 1,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    estimatedInputTokens: inputTokens,
  });
  if (budget <= 0) {
    const shrink = decideCheckpointBatchSize({
      safeOutputMax: budget,
      estimatedInputTokens: inputTokens,
    });
    throw new StoryMemoryError(
      'MEMORY_PATCH_BUDGET_INFEASIBLE',
      shrink.hint,
    );
  }
  let currentMessages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }> = messages;
  let attempt = 0;
  while (attempt < STORY_MEMORY_MAX_PHYSICAL_REQUESTS) {
    attempt += 1;
    if (input.signal?.aborted) {
      throw new StoryMemoryError(
        'MEMORY_REBUILD_CANCELLED',
        '故事记忆任务已取消。',
      );
    }
    const scenarioForAttempt =
      attempt === 1
        ? scenario
        : attempt === 2
          ? 'story_memory_patch_repair'
          : 'story_memory_patch_retry';
    let result: LLMResult;
    try {
      result = await requestPatch(
        currentMessages,
        budget,
        input.chapter.project_id,
        scenarioForAttempt,
        input.signal,
        attemptBudget,
      );
    } catch (error) {
      if (
        !input.signal?.aborted &&
        isSafeStoryMemoryRetryError(error) &&
        attempt < STORY_MEMORY_MAX_PHYSICAL_REQUESTS &&
        (attemptBudget.hasObservedPhysicalRequest
          ? attemptBudget.canSend()
          : true)
      ) {
        currentMessages = messages;
        continue;
      }
      throw error;
    }
    const text = result?.text?.trim() || '';

    if (text) {
      try {
        return parseAndValidateMemoryPatch(
          text,
          input.previousState,
          input.chapter.content,
        );
      } catch (parseError) {
        if (input.signal?.aborted) {
          throw new StoryMemoryError(
            'MEMORY_REBUILD_CANCELLED',
            '故事记忆任务已取消。',
          );
        }
        const physicalAttempt = attemptBudget.hasObservedPhysicalRequest
          ? attemptBudget.used
          : attempt;
        if (physicalAttempt >= STORY_MEMORY_MAX_PHYSICAL_REQUESTS) {
          if (
            parseError instanceof StoryMemoryError &&
            parseError.code === 'MEMORY_EVIDENCE_NOT_FOUND'
          ) {
            try {
              return parseAndValidateMemoryPatch(
                text,
                input.previousState,
                input.chapter.content,
                { recoverEvidence: true },
              );
            } catch {
              // Keep the precise model/validation error below.
            }
          }
          if (result.finishReason === 'length') {
            throw new StoryMemoryError(
              'MEMORY_PATCH_INVALID_JSON',
              `模型连续返回被截断的记忆 JSON（已自动扩容到 ${budget} tokens）。请检查模型的单次输出上限。`,
            );
          }
          throw parseError;
        }
        const message =
          parseError instanceof Error ? parseError.message : '未知校验错误';
        const next = nextCheckpointBudget(budget, model.maxOutputTokens, {
          contextWindow: model.contextWindow,
          estimatedInputTokens: inputTokens,
        });
        if (next <= budget) {
          throw new StoryMemoryError(
            'MEMORY_PATCH_INVALID_JSON',
            `输出预算已达模型上限（${budget} tokens），模型仍无法返回完整 JSON。请提高 max_output_tokens 后重试。`,
          );
        }
        budget = next;
        currentMessages =
          attempt === 1
            ? buildStoryMemoryRepairMessages(
                messages,
                text,
                `${message}${
                  result.finishReason === 'length'
                    ? '（输出达到长度上限）'
                    : ''
                }`,
              )
            : // Second consecutive parse failure → fresh retry WITHOUT echoing
              // the invalid assistant output (mirrors the legacy coordinator).
              buildStoryMemoryFreshRetryMessages(
                messages,
                `${message}${
                  result.finishReason === 'length'
                    ? '（输出达到长度上限）'
                    : ''
                }`,
              );
      }
    } else {
      const action = decideEmptyResponseAction({
        emptyReason: result?.emptyReason,
        finishReason: result?.finishReason,
        attempt: attemptBudget.hasObservedPhysicalRequest
          ? attemptBudget.used
          : attempt,
        maxAttempts: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
        currentBudget: budget,
        nextBudget: nextCheckpointBudget(budget, model.maxOutputTokens, {
          contextWindow: model.contextWindow,
          estimatedInputTokens: inputTokens,
        }),
      });
      if (action.type === 'fail') {
        // Single-chapter patch: no batch split exists on this path, so a
        // shrinkBatch suggestion (length at cap) becomes a plain actionable
        // model-capability failure.
        throw new StoryMemoryError(
          action.code as StoryMemoryError['code'],
          action.reason,
        );
      }
      budget = Math.max(budget, action.budget);
      currentMessages = messages;
    }
  }
  throw new StoryMemoryError(
    'MEMORY_PATCH_INVALID_JSON',
    '记忆补丁生成失败，已超过最大尝试次数。',
  );
}

export function renderEpisodicMemoryText(
  summary: ChapterMemoryPatchDraft['episodicSummary'],
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

async function previousStateForChapter(
  chapter: Chapter,
): Promise<StoryMemoryState> {
  const record = await db.ensureProjectStoryMemoryRow(chapter.project_id);
  if (
    record.dirtyFromPosition != null &&
    record.dirtyFromPosition < chapter.position
  ) {
    const displayOf = await loadDisplayNumberFn(chapter.project_id);
    throw new StoryMemoryError(
      'MEMORY_DIRTY',
      `故事记忆从${chapterLabel(displayOf, record.dirtyFromPosition)}起已过期，请先重建。`,
    );
  }
  if (
    record.state.throughChapterPosition !== chapter.position - 1 &&
    !(record.state.throughChapterPosition === -1 && chapter.position === 0)
  ) {
    throw new StoryMemoryError(
      'MEMORY_DIRTY',
      '故事记忆未推进到当前章节的前一章，请先按顺序重建。',
    );
  }
  return record.state;
}

async function finalizeChapterMemoryLegacyPerChapter(
  freshChapter: Chapter,
  options: {
    forceRegenerate?: boolean;
    createSnapshot?: boolean;
    signal?: AbortSignal;
  },
): Promise<FinalizeChapterMemoryResult> {
  const sourceFingerprint = fingerprintChapterSource(freshChapter);
  const existing = await db.getChapterMemoryPatch(freshChapter.id);
  const currentRecord = await db.ensureProjectStoryMemoryRow(
    freshChapter.project_id,
  );
  if (
    !options.forceRegenerate &&
    existing?.status === 'applied' &&
    existing.patch.sourceFingerprint === sourceFingerprint &&
    currentRecord.state.metadata.lastAppliedPatchId === existing.patch.patchId
  ) {
    const displayOf = await loadDisplayNumberFn(freshChapter.project_id);
    const episodicMemoryText = renderEpisodicMemoryText(
      existing.patch.episodicSummary,
      freshChapter,
    );
    if (
      episodicMemoryText &&
      freshChapter.memory_summary?.trim() !== episodicMemoryText
    ) {
      await db.updateChapter(freshChapter.id, {
        memory_summary: episodicMemoryText,
        memory_summary_tokens: estimateTokens(episodicMemoryText),
      });
      invalidateIdf(freshChapter.project_id);
    }
    return {
      state: currentRecord.state,
      patchId: existing.patch.patchId,
      episodicMemoryText,
      reused: true,
      chapterFinalized: true,
      checkpointAttempted: false,
      checkpointUpdated: false,
      pendingCount: 0,
      statusMessage: `故事记忆已更新到${chapterLabel(
        displayOf,
        currentRecord.state.throughChapterPosition,
      )}。`,
    };
  }

  try {
    const previousState = await previousStateForChapter(freshChapter);
    const contextConfig = await db.getContextConfig();
    const draft = await generateValidatedChapterMemoryPatch({
      chapter: freshChapter,
      previousState,
      memoryPatchMaxTokens: contextConfig.memoryPatchMaxTokens || 1200,
      signal: options.signal,
      attemptBudget: new StoryMemoryAttemptBudget({
        logicalBatchId: createStoryMemoryLogicalBatchId({
          projectId: freshChapter.project_id,
          fromPosition: freshChapter.position,
          throughPosition: freshChapter.position,
          kind: 'legacy_patch',
        }),
        projectId: freshChapter.project_id,
        fromPosition: freshChapter.position,
        throughPosition: freshChapter.position,
        maxPhysicalRequests: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
      }),
    });
    const applied = applyStoryMemoryPatch(previousState, draft, {
      projectId: freshChapter.project_id,
      chapterId: freshChapter.id,
      chapterPosition: freshChapter.position,
      sourceFingerprint,
      baseMemoryFingerprint: previousState.metadata.stateFingerprint,
      now: new Date().toISOString(),
    });
    const episodicMemoryText = renderEpisodicMemoryText(
      draft.episodicSummary,
      freshChapter,
    );
    await db.saveStoryMemoryUpdate({
      state: applied.state,
      patch: applied.resolvedPatch,
      episodicMemoryText,
      finalizedAt: applied.state.metadata.updatedAt,
      createSnapshot: options.createSnapshot,
    });
    invalidateIdf(freshChapter.project_id);
    const displayOf = await loadDisplayNumberFn(freshChapter.project_id);
    return {
      state: applied.state,
      patchId: applied.resolvedPatch.patchId,
      episodicMemoryText,
      reused: false,
      chapterFinalized: true,
      checkpointAttempted: true,
      checkpointUpdated: true,
      pendingCount: 0,
      statusMessage: `长期记忆已整理到${chapterLabel(
        displayOf,
        applied.state.throughChapterPosition,
      )}。`,
    };
  } catch (error) {
    // Legacy path marked dirty on failure; chapter may already be final.
    await db.markStoryMemoryDirty(
      freshChapter.project_id,
      freshChapter.position,
      error instanceof Error ? error.message : '故事记忆更新失败。',
    );
    throw error;
  }
}

export async function finalizeChapterMemory(
  chapterId: number,
  options: {
    forceRegenerate?: boolean;
    createSnapshot?: boolean;
    signal?: AbortSignal;
    /** Force legacy every-chapter patch path. */
    legacyEveryChapter?: boolean;
  } = {},
): Promise<FinalizeChapterMemoryResult> {
  const chapter = await db.getChapterById(chapterId);
  if (!chapter) throw new Error('章节不存在。');
  if (!chapter.content.trim())
    throw new Error('章节正文为空，无法更新故事记忆。');

  let maintenance: StoryMemoryMaintenanceRequest | null = null;
  let backgroundJob: (() => Promise<void>) | null = null;

  const result = await withProjectMemoryLock(chapter.project_id, async () => {
    const freshChapter = await db.getChapterById(chapterId);
    if (!freshChapter) throw new Error('章节不存在。');

    // Step A is deliberately local and atomic. Nothing below this point may
    // make the user wait for Story Memory LLM work.
    const finalizedAt = new Date().toISOString();
    if (typeof (db as any).finalizeChapterLocally === 'function') {
      await (db as any).finalizeChapterLocally(freshChapter.id, finalizedAt);
    } else {
      await db.updateChapter(freshChapter.id, {
        status: 'final',
        finalized_at: finalizedAt,
      });
    }

    const scheduleLegacySummary =
      typeof (db as any).getStructuredStoryMemoryEnabled === 'function' &&
      !(await (db as any).getStructuredStoryMemoryEnabled());

    if (scheduleLegacySummary) {
      const record = await db.ensureProjectStoryMemoryRow(
        freshChapter.project_id,
      );
      backgroundJob = async () => {
        await generateMemorySummary(chapterId);
        invalidateIdf(freshChapter.project_id);
      };
      return {
        state: record.state,
        patchId: '',
        episodicMemoryText: freshChapter.memory_summary || '',
        reused: false,
        chapterFinalized: true,
        checkpointAttempted: false,
        checkpointUpdated: false,
        maintenanceQueued: true,
        pendingCount: 0,
        statusMessage: '章节已定稿，记忆摘要已安排后台生成。',
      };
    }

    const schedulerEnabled =
      options.legacyEveryChapter === true
        ? false
        : typeof (db as any).getStoryMemoryCheckpointSchedulerEnabled ===
          'function'
        ? await (db as any).getStoryMemoryCheckpointSchedulerEnabled()
        : true;

    const scheduleLegacyPatch =
      async (): Promise<FinalizeChapterMemoryResult> => {
        const record = await db.ensureProjectStoryMemoryRow(
          freshChapter.project_id,
        );
        backgroundJob = async () => {
          await runStoryMemoryTaskOnce(
            'story-memory-legacy:' +
              freshChapter.project_id +
              ':' +
              freshChapter.id,
            () =>
              withProjectMemoryLock(freshChapter.project_id, () =>
                finalizeChapterMemoryLegacyPerChapter(freshChapter, {
                  ...options,
                  signal: undefined,
                }),
              ),
          );
        };
        return {
          state: record.state,
          patchId: record.state.metadata.lastAppliedPatchId || '',
          episodicMemoryText: freshChapter.memory_summary || '',
          reused: false,
          chapterFinalized: true,
          checkpointAttempted: false,
          checkpointUpdated: false,
          maintenanceQueued: true,
          pendingCount: 1,
          statusMessage: '章节已定稿，长期记忆已安排后台整理。',
        };
      };

    if (!schedulerEnabled) {
      return scheduleLegacyPatch();
    }

    const contextConfig = await db.getContextConfig();
    const policy =
      typeof (db as any).ensureStoryMemoryPolicy === 'function'
        ? await (db as any).ensureStoryMemoryPolicy(
            freshChapter.project_id,
            contextConfig.slidingWindowSize,
          )
        : createDefaultStoryMemoryPolicy(freshChapter.project_id);

    // Explicit forceRegenerate keeps the compatibility per-chapter path, but
    // it is still queued after local finalization and never awaited here.
    if (policy.mode === 'every_chapter' && options.forceRegenerate) {
      return scheduleLegacyPatch();
    }

    const allChapters = await db.getChaptersByProject(freshChapter.project_id);
    const record = await db.ensureProjectStoryMemoryRow(
      freshChapter.project_id,
    );
    const pending = listPendingChapters(
      allChapters.filter(
        item =>
          Boolean(item.content?.trim()) &&
          (item.status === 'final' ||
            item.finalized_at != null ||
            item.id === freshChapter.id),
      ),
      record.state.throughChapterPosition,
    );
    if (
      !pending.some(item => item.id === freshChapter.id) &&
      freshChapter.position > record.state.throughChapterPosition
    ) {
      pending.push(freshChapter);
      pending.sort((a, b) => a.position - b.position);
    }

    const due = evaluateStoryMemoryDue({
      policy,
      checkpointThroughPosition: record.state.throughChapterPosition,
      pendingChapters: pending,
      dirty: record.status === 'dirty',
    });

    const maintenanceDue = due.due || record.status === 'failed';
    if (!maintenanceDue) {
      const nextPos = predictNextCheckpointPosition(
        policy,
        record.state.throughChapterPosition,
        pending.length,
      );
      const displayOf = await loadDisplayNumberFn(freshChapter.project_id);
      return {
        state: record.state,
        patchId: record.state.metadata.lastAppliedPatchId || '',
        episodicMemoryText: freshChapter.memory_summary || '',
        reused: false,
        chapterFinalized: true,
        checkpointAttempted: false,
        checkpointUpdated: false,
        pendingCount: pending.length,
        statusMessage:
          pending.length > 0
            ? '长期记忆待整理 ' +
              pending.length +
              ' 章' +
              (nextPos != null
                ? '，将在' + chapterLabel(displayOf, nextPos - 1) + '后更新'
                : '') +
              '。'
            : '章节已定稿。',
      };
    }

    const throughPosition = resolveDirtyRebuildThroughPosition(
      record.state.throughChapterPosition,
      freshChapter.position,
      due.throughPosition ?? pending.at(-1)?.position ?? freshChapter.position,
    );
    const maintenanceReason: StoryMemoryMaintenanceReason =
      record.status === 'dirty' || due.reason === 'dirty_rebuild'
        ? 'dirty'
        : due.reason === 'coverage_gap'
          ? 'coverage_gap'
          : due.reason === 'manual'
            ? 'manual'
            : 'interval';
    maintenance = {
      projectId: freshChapter.project_id,
      throughPosition,
      reason: maintenanceReason,
      priority: 'background',
    };
    return {
      state: record.state,
      patchId: record.state.metadata.lastAppliedPatchId || '',
      episodicMemoryText: freshChapter.memory_summary || '',
      reused: false,
      chapterFinalized: true,
      checkpointAttempted: false,
      checkpointUpdated: false,
      maintenanceQueued: true,
      pendingCount: pending.length,
      statusMessage:
        '章节已定稿，长期记忆已安排后台整理（待整理 ' +
        pending.length +
        ' 章）。',
    };
  });

  if (maintenance) enqueueStoryMemoryMaintenance(maintenance);
  if (backgroundJob) {
    setTimeout(() => {
      void backgroundJob!().catch(() => undefined);
    }, 0);
  }
  return result;
}

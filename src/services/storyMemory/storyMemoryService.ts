import type { Chapter } from '../../types/novel';
import type { ContinuationChapterPosition } from '../../types/novel';
import { extractJSON } from '../../utils/jsonExtractor';
import { invalidateIdf } from '../../utils/idfCache';
import { estimateTokens } from '../../utils/tokenEstimator';
import * as db from '../database';
import { callLLMResult, type LLMResult } from '../llm';
import { generateMemorySummary } from '../summaryGenerator';
import { fingerprintChapterSource } from './storyMemoryFingerprint';
import { applyStoryMemoryPatch, batchPatchToChapterDraft } from './storyMemoryMerger';
import {
  buildStoryMemoryFreshRetryMessages,
  buildStoryMemoryPatchMessages,
  buildStoryMemoryRepairMessages,
} from './storyMemoryPrompts';
import {
  decideEmptyResponseAction,
  isSafeStoryMemoryRetryError,
} from './storyMemoryAttemptPolicy';
import { STORY_MEMORY_MAX_PHYSICAL_REQUESTS } from './storyMemoryAttemptPolicy';
import {
  StoryMemoryAttemptBudget,
  createStoryMemoryLogicalBatchId,
} from './storyMemoryAttemptBudget';
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
  STORY_MEMORY_DEFAULT_BATCH_SIZE,
} from './storyMemoryPolicy';
import {
  advanceStoryMemoryCheckpointsUnlocked,
  generateValidatedCheckpointBatch,
  type StoryMemoryCheckpointProgressEvent,
} from './storyMemoryCheckpointService';
import { rebuildStoryMemoryUnlocked } from './storyMemoryRebuild';
import {
  freezeStoryMemoryLLMConfig,
  planStoryMemoryRequest,
  type FrozenStoryMemoryLLMConfig,
} from './storyMemoryRequestBudget';
import { buildStoryMemoryLLMConfig } from './storyMemoryRequestPolicy';
import {
  acknowledgeStoryMemoryOutcomeUnknown,
  listStoryMemoryRequestAttempts,
} from '../../data/repositories/storyMemoryRequestAttemptRepository';
import {
  storyMemoryPercent,
  storyMemoryTaskId,
  type StoryMemoryTaskKind,
  type StoryMemoryTaskPhase,
  type StoryMemoryTaskProgressPatch,
  useStoryMemoryTaskStore,
} from '../../store/storyMemoryTaskStore';
import {
  startStoryMemoryForeground,
  stopStoryMemoryForeground,
  updateStoryMemoryForeground,
} from './storyMemoryForeground';
import { recordPostWritingObservability } from '../writing/observability/writingObservabilityCollector';

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
  throughPosition?: number;
  reason: StoryMemoryMaintenanceReason;
  priority?: 'background' | 'manual';
  signal?: AbortSignal;
  userAcknowledgedUnknown?: boolean;
  acknowledgedAttemptIds?: string[];
  clearFirst?: boolean;
  mode?: 'auto' | 'full' | 'legacy_bootstrap';
}

export interface StoryMemoryMaintenanceResult {
  projectId: number;
  throughPosition: number;
  state: StoryMemoryState;
  batchesApplied: number;
  pendingRemaining: number;
}

const activeMaintenanceControllers = new Map<number, AbortController>();

export function cancelStoryMemoryMaintenance(projectId: number): void {
  activeMaintenanceControllers.get(projectId)?.abort();
}

function maintenanceKind(input: {
  reason: StoryMemoryMaintenanceReason;
  status: string;
}): StoryMemoryTaskKind {
  if (input.reason === 'coverage_gap') return 'hard_gap_repair';
  if (input.status === 'empty') return 'bootstrap';
  if (input.status === 'dirty' || input.status === 'failed') return 'rebuild';
  if (input.reason === 'manual') return 'manual';
  return 'checkpoint';
}

function phaseLabel(phase: StoryMemoryTaskPhase): string {
  switch (phase) {
    case 'preparing':
      return '正在准备';
    case 'planning':
      return '正在规划整理范围';
    case 'requesting':
      return '正在分析';
    case 'validating':
      return '正在校验长期记忆';
    case 'applying':
      return '正在合并故事状态';
    case 'saving':
      return '正在保存';
    case 'completed':
      return '整理完成';
    case 'cancelled':
      return '已停止整理';
    case 'outcome_unknown':
      return '上次请求结果未确认';
    case 'failed':
      return '整理失败';
  }
}

function rangeLabel(fromPosition: number | null, throughPosition: number | null): string {
  if (fromPosition == null || throughPosition == null) return '';
  const from = fromPosition + 1;
  const through = throughPosition + 1;
  return from === through ? `第 ${from} 章` : `第 ${from}～${through} 章`;
}

function taskMessage(
  phase: StoryMemoryTaskPhase,
  fromPosition: number | null,
  throughPosition: number | null,
): string {
  const range = rangeLabel(fromPosition, throughPosition);
  const prefix = phaseLabel(phase);
  return range && (phase === 'requesting' || phase === 'planning')
    ? `${prefix}${range}`
    : prefix;
}

function publishTaskProgress(
  projectId: number,
  patch: StoryMemoryTaskProgressPatch,
): void {
  const taskId = storyMemoryTaskId(projectId);
  const store = useStoryMemoryTaskStore.getState();
  const current = store.getTask(taskId);
  if (!current) return;
  const nextFrom =
    patch.currentFromPosition !== undefined
      ? patch.currentFromPosition
      : current.currentFromPosition;
  const nextThrough =
    patch.currentThroughPosition !== undefined
      ? patch.currentThroughPosition
      : current.currentThroughPosition;
  const phase = patch.phase || current.phase;
  const nextPatch: StoryMemoryTaskProgressPatch = {
    ...patch,
    message:
      patch.message ||
      taskMessage(phase, nextFrom ?? null, nextThrough ?? null),
  };
  store.updateTask(taskId, nextPatch);
  const updated = store.getTask(taskId);
  if (updated) {
    void updateStoryMemoryForeground(
      projectId,
      updated.message,
      updated.percent,
    ).catch(() => undefined);
  }
}

async function startTaskProgress(input: {
  projectId: number;
  kind: StoryMemoryTaskKind;
  totalChapters: number;
  totalBatches: number;
}): Promise<void> {
  const startedAt = Date.now();
  const taskId = storyMemoryTaskId(input.projectId);
  useStoryMemoryTaskStore.getState().startTask({
    taskId,
    projectId: input.projectId,
    kind: input.kind,
    phase: 'preparing',
    totalChapters: input.totalChapters,
    completedChapters: 0,
    totalBatches: input.totalBatches,
    completedBatches: 0,
    currentFromPosition: null,
    currentThroughPosition: null,
    currentAttempt: null,
    maxAttempts: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
    percent: storyMemoryPercent(0, input.totalChapters),
    startedAt,
    updatedAt: startedAt,
    message: '正在准备',
  });
  await startStoryMemoryForeground(input.projectId, '正在准备', 0).catch(
    () => undefined,
  );
}

function completeTaskProgress(
  projectId: number,
  phase: Extract<StoryMemoryTaskPhase, 'completed' | 'failed' | 'cancelled' | 'outcome_unknown'>,
  message: string,
  error?: string,
): void {
  useStoryMemoryTaskStore
    .getState()
    .finishTask(storyMemoryTaskId(projectId), phase, message, error);
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
  const requestedThrough =
    input.throughPosition == null
      ? 'latest'
      : String(Math.max(-1, Math.floor(input.throughPosition)));
  const key = `story-memory-maintain:${input.projectId}:${requestedThrough}`;
  return runStoryMemoryTaskOnce(key, async () =>
    withProjectMemoryLock(input.projectId, async () => {
      let unknown = await listStoryMemoryRequestAttempts(input.projectId, [
        'prepared',
        'sent',
        'outcome_unknown',
      ]);
      if (input.userAcknowledgedUnknown && unknown.length > 0) {
        const firstLogicalBatch = unknown[0].logicalBatchId;
        const selectedIds =
          input.acknowledgedAttemptIds?.length
            ? input.acknowledgedAttemptIds
            : unknown
                .filter(row => row.logicalBatchId === firstLogicalBatch)
                .map(row => row.attemptId);
        await acknowledgeStoryMemoryOutcomeUnknown({
          projectId: input.projectId,
          attemptIds: selectedIds,
        });
        unknown = await listStoryMemoryRequestAttempts(input.projectId, [
          'prepared',
          'sent',
          'outcome_unknown',
        ]);
      }
      if (unknown.length > 0) {
        throw new StoryMemoryError(
          'MEMORY_CHECKPOINT_OUTCOME_UNKNOWN',
          `检测到 ${unknown.length} 个结果未知的长期记忆请求，已停止自动重发，请在故事记忆页面确认后重试。`,
        );
      }

      let record = await db.ensureProjectStoryMemoryRow(input.projectId);
      if (input.clearFirst) {
        await db.clearStoryMemory(input.projectId);
        record = await db.ensureProjectStoryMemoryRow(input.projectId);
      }
      const allChapters = await db.getChaptersByProject(input.projectId);
      const finalChapters = allChapters
        .filter(
          chapter =>
            Boolean(chapter.content?.trim()) &&
            (chapter.status === 'final' || chapter.finalized_at != null),
        )
        .sort((a, b) => a.position - b.position);
      const throughPosition = Math.max(
        -1,
        Math.floor(
          input.throughPosition ??
            finalChapters.at(-1)?.position ??
            record.state.throughChapterPosition,
        ),
      );
      const rebuild =
        input.clearFirst ||
        input.mode === 'full' ||
        record.status === 'dirty' ||
        record.status === 'failed' ||
        record.status === 'empty';
      const startPosition = rebuild
        ? record.dirtyFromPosition ?? Math.max(0, record.state.throughChapterPosition + 1)
        : record.state.throughChapterPosition + 1;
      const workChapters = finalChapters.filter(
        chapter => chapter.position >= startPosition && chapter.position <= throughPosition,
      );
      const totalChapters = workChapters.length;
      const totalBatches = Math.ceil(totalChapters / STORY_MEMORY_DEFAULT_BATCH_SIZE);
      const kind = maintenanceKind({ reason: input.reason, status: record.status });
      await startTaskProgress({
        projectId: input.projectId,
        kind,
        totalChapters,
        totalBatches,
      });
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      if (input.signal) {
        if (input.signal.aborted) controller.abort();
        else input.signal.addEventListener('abort', forwardAbort, { once: true });
      }
      activeMaintenanceControllers.set(input.projectId, controller);
      const taskId = storyMemoryTaskId(input.projectId);
      const checkpointProgress = (progress: StoryMemoryCheckpointProgressEvent) => {
        const phase = progress.phase as StoryMemoryTaskPhase;
        publishTaskProgress(input.projectId, {
          phase,
          currentFromPosition: progress.fromPosition,
          currentThroughPosition: progress.throughPosition,
          currentAttempt: progress.attempt,
          maxAttempts: progress.maxAttempts,
          message: taskMessage(
            phase,
            progress.fromPosition,
            progress.throughPosition,
          ),
        });
      };
      const rebuildProgress = (progress: {
        currentPosition: number;
        totalChapters: number;
        completedChapters: number;
        status: 'preparing' | 'running' | 'saving' | 'completed';
      }) => {
        const phase: StoryMemoryTaskPhase =
          progress.status === 'preparing'
            ? 'preparing'
            : progress.status === 'saving'
              ? 'saving'
              : progress.status === 'completed'
                ? 'completed'
                : 'planning';
        const batches = Math.ceil(progress.totalChapters / STORY_MEMORY_DEFAULT_BATCH_SIZE);
        const completedBatches =
          progress.completedChapters >= progress.totalChapters
            ? batches
            : Math.floor(progress.completedChapters / STORY_MEMORY_DEFAULT_BATCH_SIZE);
        publishTaskProgress(input.projectId, {
          phase,
          totalChapters: progress.totalChapters,
          completedChapters: progress.completedChapters,
          totalBatches: batches,
          completedBatches,
          currentFromPosition: progress.currentPosition,
          currentThroughPosition: progress.currentPosition,
          currentAttempt: null,
          message: taskMessage(
            phase,
            progress.currentPosition,
            progress.currentPosition,
          ),
        });
      };
      try {
        publishTaskProgress(input.projectId, { phase: 'preparing', message: '正在准备' });
        // Reset the per-maintenance split-child progress accumulator so
        // onBatchComplete does not double-count chapters already credited by
        // onChildBatchComplete (governance §9).
        let childChaptersAlreadyCounted = 0;
        if (rebuild) {
          const rebuilt = await rebuildStoryMemoryUnlocked(input.projectId, {
            mode: input.mode || 'auto',
            throughPosition,
            signal: controller.signal,
            onProgress: rebuildProgress,
            onCheckpointProgress: checkpointProgress,
          });
          const rebuiltPending = (await db.getChaptersByProject(input.projectId)).filter(
            chapter =>
              Boolean(chapter.content?.trim()) &&
              chapter.position > rebuilt.state.throughChapterPosition &&
              chapter.position <= throughPosition,
          ).length;
          completeTaskProgress(input.projectId, 'completed', '整理完成');
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
          signal: controller.signal,
          onProgress: checkpointProgress,
          onChildBatchComplete: range => {
            // Governance §9: a split child persisted — advance
            // completedChapters now, before the rest of the logical batch
            // finishes, so the percent reflects real progress and a later
            // child failure cannot hide the work already persisted.
            const current = useStoryMemoryTaskStore
              .getState()
              .getTask(taskId);
            if (!current) return;
            const childCount = finalChapters.filter(
              chapter =>
                chapter.position >= range.fromPosition &&
                chapter.position <= range.throughPosition,
            ).length;
            childChaptersAlreadyCounted += childCount;
            publishTaskProgress(input.projectId, {
              phase: 'saving',
              completedChapters: Math.min(
                current.totalChapters,
                current.completedChapters + childCount,
              ),
            });
          },
          onBatchComplete: range => {
            const current = useStoryMemoryTaskStore.getState().getTask(taskId);
            if (!current) return;
            const count = finalChapters.filter(
              chapter =>
                chapter.position >= range.fromPosition &&
                chapter.position <= range.throughPosition,
            ).length;
            // If split children already advanced completedChapters for this
            // logical batch, only credit the remaining chapters here so we do
            // not double-count (governance §9 progress integrity).
            const remaining = Math.max(0, count - childChaptersAlreadyCounted);
            childChaptersAlreadyCounted = 0;
            publishTaskProgress(input.projectId, {
              phase: 'saving',
              completedChapters: Math.min(
                current.totalChapters,
                current.completedChapters + remaining,
              ),
              completedBatches: Math.min(
                current.totalBatches,
                current.completedBatches + 1,
              ),
            });
          },
        });
        completeTaskProgress(input.projectId, 'completed', '整理完成');
        return {
          projectId: input.projectId,
          throughPosition,
          state: advanced.state,
          batchesApplied: advanced.batchesApplied,
          pendingRemaining: advanced.pendingRemaining,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '长期记忆整理失败';
        const latestUnknown = await listStoryMemoryRequestAttempts(input.projectId, [
          'outcome_unknown',
        ]);
        const phase: Extract<StoryMemoryTaskPhase, 'failed' | 'cancelled' | 'outcome_unknown'> =
          controller.signal.aborted ||
          (error as { code?: string } | null)?.code === 'MEMORY_REBUILD_CANCELLED' ||
          (error as { code?: string } | null)?.code === 'MEMORY_CHECKPOINT_CANCELLED'
            ? 'cancelled'
            : latestUnknown.length > 0
              ? 'outcome_unknown'
              : 'failed';
        completeTaskProgress(input.projectId, phase, phaseLabel(phase), message);
        throw error;
      } finally {
        if (input.signal) input.signal.removeEventListener('abort', forwardAbort);
        if (activeMaintenanceControllers.get(input.projectId) === controller) {
          activeMaintenanceControllers.delete(input.projectId);
        }
        await stopStoryMemoryForeground(input.projectId).catch(() => undefined);
      }
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

/** Test/rollback bridge only used when an older mocked or embedded caller does
 * not expose the new batch observer entrypoint. Production always exposes it. */
async function generateLegacyChapterMemoryPatchFallback(
  input: GenerateChapterMemoryPatchInput,
  frozenConfig: FrozenStoryMemoryLLMConfig,
  attemptBudget: StoryMemoryAttemptBudget,
): Promise<ChapterMemoryPatchDraft> {
  const baseMessages = buildStoryMemoryPatchMessages(input.chapter, input.previousState);
  let messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = baseMessages;
  for (let attempt = 1; attempt <= STORY_MEMORY_MAX_PHYSICAL_REQUESTS; attempt += 1) {
    const plan = planStoryMemoryRequest({
      config: frozenConfig,
      messages,
      legacyOutputTokens: input.memoryPatchMaxTokens,
      batchSize: 1,
    });
    if (!plan.fits) {
      throw new StoryMemoryError('MEMORY_PATCH_BUDGET_INFEASIBLE', plan.reason);
    }
    let result: LLMResult;
    try {
      result = await callLLMResult(
        messages,
        plan.maxTokens,
        buildStoryMemoryLLMConfig({
          scenario:
            attempt === 1
              ? input.scenario || 'story_memory_patch'
              : attempt === 2
                ? 'story_memory_patch_repair'
                : 'story_memory_patch_retry',
          projectId: input.chapter.project_id,
          physicalRequestHooks: attemptBudget.hooks(),
          requestConfig: frozenConfig.requestConfig,
        }),
        input.signal,
      );
    } catch (error) {
      if (
        !input.signal?.aborted &&
        isSafeStoryMemoryRetryError(error) &&
        attempt < STORY_MEMORY_MAX_PHYSICAL_REQUESTS
      ) {
        messages = baseMessages;
        continue;
      }
      throw error;
    }
    const text = result?.text?.trim() || '';
    if (text) {
      try {
        return parseAndValidateMemoryPatch(text, input.previousState, input.chapter.content);
      } catch (error) {
        if (attempt >= STORY_MEMORY_MAX_PHYSICAL_REQUESTS) {
          if (error instanceof StoryMemoryError && error.code === 'MEMORY_EVIDENCE_NOT_FOUND') {
            return parseAndValidateMemoryPatch(
              text,
              input.previousState,
              input.chapter.content,
              { recoverEvidence: true },
            );
          }
          throw error;
        }
        const message = error instanceof Error ? error.message : '记忆补丁校验失败';
        messages =
          attempt === 1
            ? buildStoryMemoryRepairMessages(baseMessages, text, message)
            : buildStoryMemoryFreshRetryMessages(baseMessages, message);
        continue;
      }
    }
    const action = decideEmptyResponseAction({
      emptyReason: result?.emptyReason,
      finishReason: result?.finishReason,
      attempt: attemptBudget.hasObservedPhysicalRequest ? attemptBudget.used : attempt,
      maxAttempts: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
      currentBudget: plan.maxTokens,
      nextBudget: plan.maxTokens,
    });
    if (action.type === 'fail') {
      throw new StoryMemoryError(action.code as StoryMemoryError['code'], action.reason);
    }
    messages = baseMessages;
  }
  throw new StoryMemoryError('MEMORY_PATCH_INVALID_JSON', '记忆补丁生成失败，已超过最大尝试次数。');
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

export async function generateValidatedChapterMemoryPatch(
  input: GenerateChapterMemoryPatchInput,
): Promise<ChapterMemoryPatchDraft> {
  if (input.signal?.aborted) {
    throw new StoryMemoryError(
      'MEMORY_REBUILD_CANCELLED',
      '故事记忆任务已取消。',
    );
  }
  const frozenConfig = await freezeStoryMemoryLLMConfig();
  const attemptBudget =
    input.attemptBudget ||
    new StoryMemoryAttemptBudget({
      logicalBatchId: createStoryMemoryLogicalBatchId({
        projectId: input.chapter.project_id,
        fromPosition: input.chapter.position,
        throughPosition: input.chapter.position,
        kind: 'story_memory_v2',
      }),
      projectId: input.chapter.project_id,
      fromPosition: input.chapter.position,
      throughPosition: input.chapter.position,
      maxPhysicalRequests: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
    });
  if (typeof generateValidatedCheckpointBatch !== 'function') {
    return generateLegacyChapterMemoryPatchFallback(
      input,
      frozenConfig,
      attemptBudget,
    );
  }
  const batch = await generateValidatedCheckpointBatch({
    chapters: [input.chapter],
    previousState: input.previousState,
    memoryPatchMaxTokens: input.memoryPatchMaxTokens,
    frozenConfig,
    signal: input.signal,
    scenario:
      input.scenario === 'story_memory_legacy_bootstrap'
        ? 'story_memory_checkpoint_legacy_bootstrap'
        : 'story_memory_checkpoint',
    attemptBudget,
  });
  return batchPatchToChapterDraft(batch, input.chapter.title).chapterDraft;
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
    /** Optional chapter generation id for Phase 0 post-writing telemetry. */
    generationTraceId?: string;
  } = {},
): Promise<FinalizeChapterMemoryResult> {
  const startedAt = Date.now();
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
  if (options.generationTraceId) {
    const durationMs = Date.now() - startedAt;
    recordPostWritingObservability({
      generationTraceId: options.generationTraceId,
      kind: 'story_memory',
      durationMs,
      blockingMs: durationMs,
      physicalRequestCount: 0,
    });
  }
  return result;
}

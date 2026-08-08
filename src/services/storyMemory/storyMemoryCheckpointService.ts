import type { Chapter } from '../../types/novel';
import { estimateTokens } from '../../utils/tokenEstimator';
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
import {
  buildStoryMemoryCheckpointMessages,
  buildStoryMemoryCheckpointRepairMessages,
  buildStoryMemoryCheckpointRetryMessages,
} from './storyMemoryPrompts';
import { validateStoryMemoryBatchPatch } from './storyMemoryBatchValidator';
import type {
  EpisodicSummary,
  StoryMemoryBatchPatchDraft,
  StoryMemoryState,
  StoredStoryMemoryBatch,
} from './storyMemoryTypes';
import { StoryMemoryError } from './storyMemoryTypes';
import {
  splitCheckpointBatches,
  STORY_MEMORY_DEFAULT_BATCH_SIZE,
} from './storyMemoryPolicy';
import { getContinuationChapterNumbering } from '../continuation/chapterNumbering/continuationChapterNumbering';
import {
  checkpointMaxTokens as planCheckpointMaxTokens,
  decideCheckpointBatchSize,
  estimateCheckpointInputTokens,
  nextCheckpointBudget,
} from './storyMemoryBudget';
import {
  decideEmptyResponseAction,
  STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
} from './storyMemoryAttemptPolicy';

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
  thinking?: { type: 'disabled' },
): Promise<LLMResult> {
  let result: LLMResult | undefined;
  for (let requestAttempt = 0; requestAttempt < 2; requestAttempt += 1) {
    try {
      result = await callLLMResult(
        messages,
        maxTokens,
        {
          temperature: 0.1,
          scenario,
          projectId,
          queueClass: 'background',
          queuePriority: 'normal',
          responseFormat: 'json_object',
          thinking,
        },
        signal,
      );
      break;
    } catch (error: any) {
      const status = Number(error?.cause?.status || error?.status || 0);
      const transient =
        ['total_timeout', 'idle_timeout', 'network_error'].includes(
          String(error?.code || ''),
        ) ||
        status === 429 ||
        status >= 500;
      if (!transient || requestAttempt > 0 || signal?.aborted) throw error;
    }
  }
  // V2.11.38 repair plan P1: an empty business body is NOT thrown here —
  // the attempt coordinator consumes `emptyReason` / `finishReason` and
  // decides the bounded recovery action per the matrix.
  if (!result) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_FAILED',
      '检查点请求未能返回结果，请重试。',
    );
  }
  return result;
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
  signal?: AbortSignal;
  scenario?:
    | 'story_memory_checkpoint'
    | 'story_memory_checkpoint_legacy_bootstrap';
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
  const messages = buildStoryMemoryCheckpointMessages(
    input.chapters,
    input.previousState,
  );
  const scenario = input.scenario || 'story_memory_checkpoint';
  const projectId = input.chapters[0].project_id;
  let getDisplayNumber: ((position: number) => number) | undefined;
  try {
    const numbering = await getContinuationChapterNumbering(projectId);
    getDisplayNumber = position => numbering.getDisplayNumber(position as any);
  } catch {
    getDisplayNumber = undefined;
  }
  // V2.11.38 repair plan P1 §6.3: consult the ACTIVE model's real
  // context_window / max_output_tokens before planning the output budget.
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

  return runCheckpointAttemptLoop({
    chapters: input.chapters,
    previousState: input.previousState,
    memoryPatchMaxTokens: input.memoryPatchMaxTokens,
    scenario,
    projectId,
    signal: input.signal,
    getDisplayNumber,
    baseMessages: messages,
    model,
    inputTokens,
  });
}

interface CheckpointAttemptLoopInput {
  chapters: Chapter[];
  previousState: StoryMemoryState;
  memoryPatchMaxTokens: number;
  scenario: string;
  projectId: number;
  signal?: AbortSignal;
  getDisplayNumber?: (position: number) => number;
  baseMessages: Array<{ role: 'system' | 'user'; content: string }>;
  model: { contextWindow?: number; maxOutputTokens?: number };
  inputTokens: number;
}

/**
 * Bounded checkpoint attempt coordinator (repair plan P1 §6.2).
 *
 * - At most STORY_MEMORY_MAX_PHYSICAL_REQUESTS physical LLM calls per batch.
 * - Empty responses are classified by `emptyReason`/`finishReason`:
 *   reasoning_only → fresh retry with thinking disabled; length → raise
 *   budget within model caps; empty → one fresh retry; no_choices /
 *   content_filter → actionable failure without blind retries.
 * - An empty output NEVER constructs an `assistant: ''` repair dialogue.
 * - When the budget hits the model cap while the output is still truncated
 *   (or the window cannot fit even one chapter), the batch is split by
 *   MEMORY_CHECKPOINT_BATCH_TOO_LARGE — runStoryMemoryCheckpointBatch
 *   re-runs the sub-batches sequentially, keeping partial success.
 */
async function runCheckpointAttemptLoop(
  input: CheckpointAttemptLoopInput,
): Promise<StoryMemoryBatchPatchDraft> {
  const batchSize = input.chapters.length;
  let budget = planCheckpointMaxTokens({
    memoryPatchMaxTokens: input.memoryPatchMaxTokens,
    batchSize,
    contextWindow: input.model.contextWindow,
    maxOutputTokens: input.model.maxOutputTokens,
    estimatedInputTokens: input.inputTokens,
  });
  if (budget <= 0) {
    const shrink = decideCheckpointBatchSize({
      safeOutputMax: budget,
      estimatedInputTokens: input.inputTokens,
    });
    throw new StoryMemoryError('MEMORY_CHECKPOINT_FAILED', shrink.hint);
  }

  let messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> =
    input.baseMessages;
  let thinking: { type: 'disabled' } | undefined;
  let attempt = 0;
  while (attempt < STORY_MEMORY_MAX_PHYSICAL_REQUESTS) {
    attempt += 1;
    if (input.signal?.aborted) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_CANCELLED',
        '故事记忆检查点任务已取消。',
      );
    }
    const scenario =
      attempt === 1
        ? input.scenario
        : attempt === 2
          ? 'story_memory_checkpoint_repair'
          : 'story_memory_checkpoint_retry';
    const result = await requestCheckpoint(
      messages,
      budget,
      input.projectId,
      scenario,
      input.signal,
      thinking,
    );
    thinking = undefined;
    const text = result?.text?.trim() || '';

    if (text) {
      try {
        return parseAndValidateBatchPatch(
          text,
          input.previousState,
          input.chapters,
          { getDisplayNumber: input.getDisplayNumber },
        );
      } catch (parseError) {
        if (input.signal?.aborted) {
          throw new StoryMemoryError(
            'MEMORY_CHECKPOINT_CANCELLED',
            '故事记忆检查点任务已取消。',
          );
        }
        if (attempt >= STORY_MEMORY_MAX_PHYSICAL_REQUESTS) {
          if (
            parseError instanceof StoryMemoryError &&
            parseError.code === 'MEMORY_CHECKPOINT_EVIDENCE_NOT_FOUND'
          ) {
            try {
              return parseAndValidateBatchPatch(
                text,
                input.previousState,
                input.chapters,
                { recoverEvidence: true, getDisplayNumber: input.getDisplayNumber },
              );
            } catch {
              // keep precise error below
            }
          }
          if (result.finishReason === 'length') {
            if (batchSize > 1) {
              throw new StoryMemoryError(
                'MEMORY_CHECKPOINT_BATCH_TOO_LARGE',
                `模型连续返回被截断的检查点 JSON（已自动扩容到 ${budget} tokens），已拆分批次重试。`,
              );
            }
            throw new StoryMemoryError(
              'MEMORY_CHECKPOINT_FAILED',
              `模型单章检查点输出仍被截断（输出预算已达 ${budget} tokens）。请提高模型的 max_output_tokens 或 context_window 后重试。`,
            );
          }
          throw parseError;
        }
        const message =
          parseError instanceof Error ? parseError.message : '未知校验错误';
        const next = nextCheckpointBudget(budget, input.model.maxOutputTokens);
        if (next <= budget) {
          // Budget cannot grow further while the output is still truncated.
          if (batchSize > 1) {
            throw new StoryMemoryError(
              'MEMORY_CHECKPOINT_BATCH_TOO_LARGE',
              '输出预算已达模型上限而 JSON 仍未完整，已拆分批次重试。',
            );
          }
          throw new StoryMemoryError(
            'MEMORY_CHECKPOINT_FAILED',
            `输出预算已达模型上限（${budget} tokens），模型仍无法返回完整 JSON。请提高 max_output_tokens 后重试。`,
          );
        }
        budget = next;
        messages =
          attempt === 1
            ? buildStoryMemoryCheckpointRepairMessages(
                input.baseMessages,
                text,
                `${message}${
                  result.finishReason === 'length'
                    ? '（输出达到长度上限）'
                    : ''
                }`,
              )
            : // Second consecutive parse failure → fresh retry WITHOUT echoing
              // the invalid assistant output (mirrors the legacy coordinator).
              buildStoryMemoryCheckpointRetryMessages(
                input.baseMessages,
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
        attempt,
        maxAttempts: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
        currentBudget: budget,
        nextBudget: nextCheckpointBudget(budget, input.model.maxOutputTokens),
      });
      if (action.type === 'fail') {
        throw new StoryMemoryError(
          action.code as StoryMemoryError['code'],
          action.reason,
        );
      }
      // Fresh retry — never echo an empty assistant message.
      budget = Math.max(budget, action.budget);
      thinking = action.disableThinking ? { type: 'disabled' } : undefined;
      messages = input.baseMessages;
    }
  }
  throw new StoryMemoryError(
    'MEMORY_CHECKPOINT_FAILED',
    '检查点生成失败，已超过最大尝试次数。',
  );
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
  createSnapshot?: boolean;
  signal?: AbortSignal;
  scenario?:
    | 'story_memory_checkpoint'
    | 'story_memory_checkpoint_legacy_bootstrap';
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
  return runStoryMemoryCheckpointBatchWithShrink(
    { ...input, chapters: ordered },
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
      const first = await runStoryMemoryCheckpointBatchWithShrink(
        { ...input, chapters: input.chapters.slice(0, half) },
        memoryPatchMaxTokens,
      );
      const second = await runStoryMemoryCheckpointBatchWithShrink(
        {
          ...input,
          chapters: input.chapters.slice(half),
          previousState: first.state,
          expectedPersistedFingerprint:
            first.state.metadata.stateFingerprint,
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
    }
    throw error;
  }
}

async function runStoryMemoryCheckpointBatchCore(
  input: Parameters<typeof runStoryMemoryCheckpointBatch>[0],
  memoryPatchMaxTokens: number,
): Promise<RunCheckpointBatchResult> {
  const draft = await generateValidatedCheckpointBatch({
    chapters: input.chapters,
    previousState: input.previousState,
    memoryPatchMaxTokens,
    signal: input.signal,
    scenario: input.scenario,
  });
  const ordered = input.chapters;
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
  await db.saveStoryMemoryBatchUpdate({
    previousFingerprint:
      input.expectedPersistedFingerprint ||
      input.previousState.metadata.stateFingerprint,
    state: applied.state,
    batch: applied.resolvedBatch,
    chapterSummaries: chapterSummaryTexts,
    createSnapshot: input.createSnapshot !== false,
  });
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
      });
      state = result.state;
      batchesApplied += 1;
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
      // 'empty' and would clobber the row back to empty. `lastError` still
      // records the failed attempt for diagnostics/retry.
      await db.setStoryMemoryBuildStatus(
        input.projectId,
        state.metadata.status,
        state.metadata.dirtyFromPosition,
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

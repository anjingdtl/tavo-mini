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
import { getContinuationChapterNumbering } from '../continuation/chapterNumbering/continuationChapterNumbering';

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

const MIN_CHECKPOINT_OUTPUT_TOKENS = 2400;
const MAX_CHECKPOINT_OUTPUT_TOKENS = 16000;

export function checkpointMaxTokens(
  memoryPatchMaxTokens: number,
  batchSize: number,
): number {
  const base = Math.max(1, memoryPatchMaxTokens || 1200);
  const scaled = base * Math.max(1, Math.sqrt(Math.max(1, batchSize)));
  return Math.min(
    MAX_CHECKPOINT_OUTPUT_TOKENS,
    Math.max(MIN_CHECKPOINT_OUTPUT_TOKENS, Math.round(scaled)),
  );
}

function clampTokens(value: number): number {
  return Math.min(
    MAX_CHECKPOINT_OUTPUT_TOKENS,
    Math.max(MIN_CHECKPOINT_OUTPUT_TOKENS, Math.round(value)),
  );
}

function nextBudget(current: number): number {
  return clampTokens(Math.max(current * 2, 4800));
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
  if (!result?.text?.trim()) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_INVALID_JSON',
      '模型没有返回检查点补丁。',
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
  const firstBudget = checkpointMaxTokens(
    input.memoryPatchMaxTokens,
    input.chapters.length,
  );
  const projectId = input.chapters[0].project_id;
  let getDisplayNumber: ((position: number) => number) | undefined;
  try {
    const numbering = await getContinuationChapterNumbering(projectId);
    getDisplayNumber = position => numbering.getDisplayNumber(position as any);
  } catch {
    getDisplayNumber = undefined;
  }
  const firstResult = await requestCheckpoint(
    messages,
    firstBudget,
    projectId,
    scenario,
    input.signal,
  );
  try {
    return parseAndValidateBatchPatch(
      firstResult.text || '',
      input.previousState,
      input.chapters,
      { getDisplayNumber },
    );
  } catch (firstError) {
    if (input.signal?.aborted) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_CANCELLED',
        '故事记忆检查点任务已取消。',
      );
    }
    const message =
      firstError instanceof Error ? firstError.message : '未知校验错误';
    const repairBudget = nextBudget(firstBudget);
    const repairedResult = await requestCheckpoint(
      buildStoryMemoryCheckpointRepairMessages(
        messages,
        firstResult.text || '',
        `${message}${
          firstResult.finishReason === 'length' ? '（输出达到长度上限）' : ''
        }`,
      ),
      repairBudget,
      projectId,
      'story_memory_checkpoint_repair',
      input.signal,
    );
    try {
      return parseAndValidateBatchPatch(
        repairedResult.text || '',
        input.previousState,
        input.chapters,
        { getDisplayNumber },
      );
    } catch (repairError) {
      if (input.signal?.aborted) {
        throw new StoryMemoryError(
          'MEMORY_CHECKPOINT_CANCELLED',
          '故事记忆检查点任务已取消。',
        );
      }
      const repairMessage =
        repairError instanceof Error ? repairError.message : '未知校验错误';
      const finalBudget = nextBudget(repairBudget);
      const finalResult = await requestCheckpoint(
        buildStoryMemoryCheckpointRetryMessages(
          messages,
          `${repairMessage}${
            repairedResult.finishReason === 'length'
              ? '（输出达到长度上限）'
              : ''
          }`,
        ),
        finalBudget,
        projectId,
        'story_memory_checkpoint_retry',
        input.signal,
      );
      try {
        return parseAndValidateBatchPatch(
          finalResult.text || '',
          input.previousState,
          input.chapters,
          { getDisplayNumber },
        );
      } catch (finalError) {
        if (
          finalError instanceof StoryMemoryError &&
          finalError.code === 'MEMORY_CHECKPOINT_EVIDENCE_NOT_FOUND'
        ) {
          try {
            return parseAndValidateBatchPatch(
              finalResult.text || '',
              input.previousState,
              input.chapters,
              { recoverEvidence: true, getDisplayNumber },
            );
          } catch {
            // keep precise error
          }
        }
        if (finalResult.finishReason === 'length') {
          throw new StoryMemoryError(
            'MEMORY_CHECKPOINT_INVALID_JSON',
            `模型连续返回被截断的检查点 JSON（已自动扩容到 ${finalBudget} tokens）。`,
          );
        }
        throw finalError;
      }
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
  const draft = await generateValidatedCheckpointBatch({
    chapters: ordered,
    previousState: input.previousState,
    memoryPatchMaxTokens: config.memoryPatchMaxTokens || 1200,
    signal: input.signal,
    scenario: input.scenario,
  });
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
  const { splitCheckpointBatches, createDefaultStoryMemoryPolicy } =
    await import('./storyMemoryPolicy');
  let preferredBatch = 3;
  if (typeof (db as any).ensureStoryMemoryPolicy === 'function') {
    try {
      const policy = await (db as any).ensureStoryMemoryPolicy(input.projectId);
      preferredBatch = policy?.intervalChapters || 3;
    } catch {
      preferredBatch = createDefaultStoryMemoryPolicy(
        input.projectId,
      ).intervalChapters;
    }
  }
  const batches = splitCheckpointBatches(pending, preferredBatch);
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
      await db.setStoryMemoryBuildStatus(
        input.projectId,
        record.status === 'dirty' ? 'dirty' : 'failed',
        state.throughChapterPosition + 1,
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

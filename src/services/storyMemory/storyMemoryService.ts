import type { Chapter } from '../../types/novel';
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
import type {
  ChapterMemoryPatchDraft,
  StoryMemoryState,
} from './storyMemoryTypes';
import { StoryMemoryError } from './storyMemoryTypes';
import { validateChapterMemoryPatch } from './storyMemoryValidator';

export interface FinalizeChapterMemoryResult {
  state: StoryMemoryState;
  patchId: string;
  episodicMemoryText: string;
  reused: boolean;
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

export interface GenerateChapterMemoryPatchInput {
  chapter: Chapter;
  previousState: StoryMemoryState;
  memoryPatchMaxTokens: number;
  signal?: AbortSignal;
  scenario?: 'story_memory_patch' | 'story_memory_legacy_bootstrap';
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
  return validateChapterMemoryPatch(
    parsed,
    previousState,
    chapterContent,
    options,
  );
}

const MIN_MEMORY_PATCH_OUTPUT_TOKENS = 2400;
const MAX_MEMORY_PATCH_OUTPUT_TOKENS = 16000;

function clampPatchTokens(value: number): number {
  return Math.min(
    MAX_MEMORY_PATCH_OUTPUT_TOKENS,
    Math.max(MIN_MEMORY_PATCH_OUTPUT_TOKENS, Math.round(value)),
  );
}

function nextPatchTokenBudget(current: number): number {
  return clampPatchTokens(Math.max(current * 2, 4800));
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
      'MEMORY_PATCH_INVALID_JSON',
      '模型没有返回记忆补丁。',
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
  const firstBudget = clampPatchTokens(input.memoryPatchMaxTokens);
  const firstResult = await requestPatch(
    messages,
    firstBudget,
    input.chapter.project_id,
    scenario,
    input.signal,
  );
  try {
    return parseAndValidateMemoryPatch(
      firstResult.text || '',
      input.previousState,
      input.chapter.content,
    );
  } catch (firstError) {
    if (input.signal?.aborted) {
      throw new StoryMemoryError(
        'MEMORY_REBUILD_CANCELLED',
        '故事记忆任务已取消。',
      );
    }
    const message =
      firstError instanceof Error ? firstError.message : '未知校验错误';
    const repairBudget = nextPatchTokenBudget(firstBudget);
    const repairedResult = await requestPatch(
      buildStoryMemoryRepairMessages(
        messages,
        firstResult.text || '',
        `${message}${
          firstResult.finishReason === 'length' ? '（输出达到长度上限）' : ''
        }`,
      ),
      repairBudget,
      input.chapter.project_id,
      'story_memory_patch_repair',
      input.signal,
    );
    try {
      return parseAndValidateMemoryPatch(
        repairedResult.text || '',
        input.previousState,
        input.chapter.content,
      );
    } catch (repairError) {
      if (input.signal?.aborted) {
        throw new StoryMemoryError(
          'MEMORY_REBUILD_CANCELLED',
          '故事记忆任务已取消。',
        );
      }
      const repairMessage =
        repairError instanceof Error ? repairError.message : '未知校验错误';
      const finalBudget = nextPatchTokenBudget(repairBudget);
      const finalResult = await requestPatch(
        buildStoryMemoryFreshRetryMessages(
          messages,
          `${repairMessage}${
            repairedResult.finishReason === 'length'
              ? '（输出达到长度上限）'
              : ''
          }`,
        ),
        finalBudget,
        input.chapter.project_id,
        'story_memory_patch_retry',
        input.signal,
      );
      try {
        return parseAndValidateMemoryPatch(
          finalResult.text || '',
          input.previousState,
          input.chapter.content,
        );
      } catch (finalError) {
        if (
          finalError instanceof StoryMemoryError &&
          finalError.code === 'MEMORY_EVIDENCE_NOT_FOUND'
        ) {
          try {
            return parseAndValidateMemoryPatch(
              finalResult.text || '',
              input.previousState,
              input.chapter.content,
              { recoverEvidence: true },
            );
          } catch {
            // Keep the precise model/validation error below when recovery
            // cannot ground or safely discard the offending operation.
          }
        }
        if (finalResult.finishReason === 'length') {
          throw new StoryMemoryError(
            'MEMORY_PATCH_INVALID_JSON',
            `模型连续返回被截断的记忆 JSON（已自动扩容到 ${finalBudget} tokens）。请检查模型的单次输出上限。`,
          );
        }
        throw finalError;
      }
    }
  }
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
    throw new StoryMemoryError(
      'MEMORY_DIRTY',
      `故事记忆从第 ${record.dirtyFromPosition + 1} 章起已过期，请先重建。`,
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

export async function finalizeChapterMemory(
  chapterId: number,
  options: {
    forceRegenerate?: boolean;
    createSnapshot?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<FinalizeChapterMemoryResult> {
  const chapter = await db.getChapterById(chapterId);
  if (!chapter) throw new Error('章节不存在。');
  if (!chapter.content.trim())
    throw new Error('章节正文为空，无法更新故事记忆。');

  return withProjectMemoryLock(chapter.project_id, async () => {
    const freshChapter = await db.getChapterById(chapterId);
    if (!freshChapter) throw new Error('章节不存在。');
    if (
      typeof (db as any).getStructuredStoryMemoryEnabled === 'function' &&
      !(await (db as any).getStructuredStoryMemoryEnabled())
    ) {
      const episodicMemoryText = await generateMemorySummary(chapterId, 200);
      const finalizedAt = new Date().toISOString();
      await db.updateChapter(chapterId, {
        status: 'final',
        finalized_at: finalizedAt,
      });
      invalidateIdf(freshChapter.project_id);
      const record = await db.ensureProjectStoryMemoryRow(
        freshChapter.project_id,
      );
      return {
        state: record.state,
        patchId: '',
        episodicMemoryText,
        reused: false,
      };
    }
    const sourceFingerprint = fingerprintChapterSource(freshChapter);
    const existing = await db.getChapterMemoryPatch(chapterId);
    const currentRecord = await db.ensureProjectStoryMemoryRow(
      freshChapter.project_id,
    );
    if (
      !options.forceRegenerate &&
      existing?.status === 'applied' &&
      existing.patch.sourceFingerprint === sourceFingerprint &&
      currentRecord.state.metadata.lastAppliedPatchId === existing.patch.patchId
    ) {
      const episodicMemoryText = renderEpisodicMemoryText(
        existing.patch.episodicSummary,
        freshChapter,
      );
      if (
        episodicMemoryText &&
        freshChapter.memory_summary?.trim() !== episodicMemoryText
      ) {
        await db.updateChapter(chapterId, {
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
      return {
        state: applied.state,
        patchId: applied.resolvedPatch.patchId,
        episodicMemoryText,
        reused: false,
      };
    } catch (error) {
      await db.markStoryMemoryDirty(
        freshChapter.project_id,
        freshChapter.position,
        error instanceof Error ? error.message : '故事记忆更新失败。',
      );
      throw error;
    }
  });
}

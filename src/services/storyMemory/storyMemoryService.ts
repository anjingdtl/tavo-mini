import type { Chapter } from '../../types/novel';
import { extractJSON } from '../../utils/jsonExtractor';
import { invalidateIdf } from '../../utils/idfCache';
import * as db from '../database';
import { callLLMResult } from '../llm';
import { fingerprintChapterSource } from './storyMemoryFingerprint';
import { applyStoryMemoryPatch } from './storyMemoryMerger';
import {
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
  return validateChapterMemoryPatch(parsed, previousState, chapterContent);
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
): Promise<string> {
  const result = await callLLMResult(
    messages,
    maxTokens,
    {
      temperature: 0.1,
      scenario,
      projectId,
      queueClass: 'background',
      queuePriority: 'normal',
    },
    signal,
  );
  if (!result.text?.trim()) {
    throw new StoryMemoryError(
      'MEMORY_PATCH_INVALID_JSON',
      '模型没有返回记忆补丁。',
    );
  }
  return result.text;
}

export async function generateValidatedChapterMemoryPatch(
  input: GenerateChapterMemoryPatchInput,
): Promise<ChapterMemoryPatchDraft> {
  if (input.signal?.aborted) {
    throw new StoryMemoryError('MEMORY_REBUILD_CANCELLED', '故事记忆任务已取消。');
  }
  const messages = buildStoryMemoryPatchMessages(
    input.chapter,
    input.previousState,
  );
  const scenario = input.scenario || 'story_memory_patch';
  const firstOutput = await requestPatch(
    messages,
    input.memoryPatchMaxTokens,
    input.chapter.project_id,
    scenario,
    input.signal,
  );
  try {
    return parseAndValidateMemoryPatch(
      firstOutput,
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
    const repairedOutput = await requestPatch(
      buildStoryMemoryRepairMessages(messages, firstOutput, message),
      input.memoryPatchMaxTokens,
      input.chapter.project_id,
      'story_memory_patch_repair',
      input.signal,
    );
    return parseAndValidateMemoryPatch(
      repairedOutput,
      input.previousState,
      input.chapter.content,
    );
  }
}

export function renderEpisodicMemoryText(
  summary: ChapterMemoryPatchDraft['episodicSummary'],
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
  return sections
    .map(([label, values]) => [
      ...new Set(values.map(value => value.trim()).filter(Boolean)),
    ].length
      ? `${label}：${[
          ...new Set(values.map(value => value.trim()).filter(Boolean)),
        ].join('；')}`
      : '')
    .filter(Boolean)
    .join('\n');
}

async function previousStateForChapter(chapter: Chapter): Promise<StoryMemoryState> {
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
  if (!chapter.content.trim()) throw new Error('章节正文为空，无法更新故事记忆。');

  return withProjectMemoryLock(chapter.project_id, async () => {
    const freshChapter = await db.getChapterById(chapterId);
    if (!freshChapter) throw new Error('章节不存在。');
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
      return {
        state: currentRecord.state,
        patchId: existing.patch.patchId,
        episodicMemoryText: renderEpisodicMemoryText(
          existing.patch.episodicSummary,
        ),
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

import type { Chapter } from '../../types/novel';
import { extractJSON } from '../../utils/jsonExtractor';
import { callLLMResult } from '../llm';
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

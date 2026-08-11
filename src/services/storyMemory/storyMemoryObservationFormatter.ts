import { extractJSON } from '../../utils/jsonExtractor';
import type { StoryMemoryEntityHandleEnvelope } from './storyMemoryEntityHandles';
import { STORY_MEMORY_V2_OBSERVER_CONTRACT } from './storyMemoryObservationPrompts';
import { isObservationPayload } from './storyMemoryObservationNormalizer';
import { StoryMemoryError } from './storyMemoryTypes';

export interface StoryMemoryObservationFormatterInput {
  candidate: string;
  chapterHandles: readonly string[];
  existingHandles: {
    characters: readonly string[];
    relationships: readonly string[];
    conflicts: readonly string[];
    threads: readonly string[];
    foreshadowing: readonly string[];
    arc: string | null;
  };
  evidenceIds: readonly string[];
  failureCode: string;
}

export function buildStoryMemoryObservationFormatterMessages(
  input: StoryMemoryObservationFormatterInput,
): Array<{ role: 'system' | 'user'; content: string }> {
  const system = `你是 JSON 格式整理器，不是小说分析器。
只整理 candidate 中已经出现的信息，使其符合 Observation JSON 形状；不得新增人物、事件、Evidence Anchor 或 Entity Handle，不得重新阅读或推测剧情。只输出一个 JSON 对象。`;
  const user = [
    `失败代码：${input.failureCode}`,
    '【最小合法约束】',
    `chapter handles：${input.chapterHandles.join(', ') || '(无)'}`,
    `character handles：${input.existingHandles.characters.join(', ') || '(无)'}`,
    `relationship handles：${input.existingHandles.relationships.join(', ') || '(无)'}`,
    `conflict handles：${input.existingHandles.conflicts.join(', ') || '(无)'}`,
    `thread handles：${input.existingHandles.threads.join(', ') || '(无)'}`,
    `foreshadowing handles：${input.existingHandles.foreshadowing.join(', ') || '(无)'}`,
    `arc handle：${input.existingHandles.arc || '(无)'}`,
    `evidence ids：${input.evidenceIds.join(', ') || '(无)'}`,
    STORY_MEMORY_V2_OBSERVER_CONTRACT,
    '【candidate】',
    input.candidate,
    '只修复括号、字段形状、数组和可识别的现有值；不添加 candidate 未提供的语义。',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function buildStoryMemoryObservationFreshRetryMessages(
  originalMessages: Array<{ role: 'system' | 'user'; content: string }>,
  failureCode: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    ...originalMessages,
    {
      role: 'user',
      content: [
        `前一轮 Observation 生成失败：${failureCode}`,
        '请重新阅读输入中的 Q Anchor 和 C/R/T/F/P/A handle，从头生成完整 chapters JSON。',
        '不要延续或回显之前的 candidate；不要生成数据库 ID；没有变化时 observations=[]。',
      ].join('\n'),
    },
  ];
}

export function parseStoryMemoryObservationCandidate(output: string): unknown {
  const json = extractJSON(output);
  if (!json) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_INVALID_JSON',
      '模型没有返回完整的 Observation JSON 对象。',
    );
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_INVALID_JSON',
      '模型返回的 Observation JSON 无法解析。',
    );
  }
}

export function assertObservationCandidateShape(raw: unknown): void {
  if (!isObservationPayload(raw)) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_SCHEMA_INVALID',
      'Observation payload 缺少 chapters 数组。',
    );
  }
}

export function formatterHandleLists(handles: StoryMemoryEntityHandleEnvelope): StoryMemoryObservationFormatterInput['existingHandles'] {
  return {
    characters: [...handles.characterByHandle.keys()],
    relationships: [...handles.relationshipByHandle.keys()],
    conflicts: [...handles.conflictByHandle.keys()],
    threads: [...handles.threadByHandle.keys()],
    foreshadowing: [...handles.foreshadowingByHandle.keys()],
    arc: handles.arcHandle,
  };
}

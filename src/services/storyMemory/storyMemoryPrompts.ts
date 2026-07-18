import type { Chapter } from '../../types/novel';
import { canonicalStringify } from './storyMemoryFingerprint';
import { createEmptyChapterMemoryPatch } from './storyMemoryDefaults';
import type { StoryMemoryState } from './storyMemoryTypes';

export const STORY_MEMORY_SYSTEM_PROMPT = `你是小说连续性记录器，不是小说作者。

任务：只提取“本章明确发生并会影响后续连续性”的变化。
你不得续写、猜测、补全、评价或美化。
你不得输出完整故事摘要，只能输出指定的增量 JSON。
所有事实必须来自当前章节正文。
每个更新必须提供一段可在正文中找到的简短原文 evidenceQuote；直接连续复制正文文字，不得改词、增词或概括。
已有实体必须使用输入中给出的精确 ID。
新实体只能使用 new_char_*、new_rel_*、new_thread_* 等临时引用；每个临时引用必须唯一，后缀只能包含中英文字母、数字、下划线或连字符（例如 new_char_石璐、new_char_1）。
未发生变化的字段不要输出；范式要求的数组无变化时输出空数组。
无法确认时保留为空数组，不得猜测。
只要章节正文非空，episodicSummary.brief 必须是一句基于正文的非空简短事件摘要。
只输出一个 JSON 对象，不要输出 Markdown、解释或代码围栏。`;

const PATCH_ITEM_CONTRACT = `数组项字段契约（字段名必须逐字一致；没有内容时用空字符串、空数组或空对象，不得自创字段名）：
- newCharacters[]: {"tempRef":"new_char_唯一标识","canonicalName":"人物姓名","aliases":[],"role":"","identity":"","stableTraits":[],"initialState":{},"status":"active","evidenceQuote":"正文原句"}
- characterUpdates[]: {"characterRef":"已有精确ID","addAliases":[],"profileCorrections":{},"stateChanges":{},"correctionReason":"","addKnowledge":[],"removeKnowledge":[],"addPossessions":[],"removePossessions":[],"addSecrets":[],"removeSecrets":[],"clearFields":[],"evidenceQuote":"正文原句"}
- newRelationships[]: {"tempRef":"new_rel_唯一标识","fromRef":"已有ID或本次new_char引用","toRef":"已有ID或本次new_char引用","direction":"directed或bidirectional","relationType":"","currentState":"","trustLevel":"unknown","publicStatus":"","hiddenStatus":"","reason":"","evidenceQuote":"正文原句"}
- relationshipUpdates[]: {"relationshipRef":"已有精确ID","currentState":"","trustLevel":"unknown","publicStatus":"","hiddenStatus":"","reason":"","evidenceQuote":"正文原句"}
- conflictUpserts[]/threadOpens[]/threadUpdates[]/foreshadowingUpserts[]: {"ref":"","title":"","description":"","state":"","stakes":"","parties":[],"ownerCharacterRefs":[],"priority":"normal","deadlineOrTrigger":"","setup":"","expectedPayoff":"","status":"open","evidenceQuote":"正文原句"}
- threadResolutions[]: {"threadRef":"已有精确ID","resolution":"","evidenceQuote":"正文原句"}
- timelineAnchors[]: {"ref":"new_time_唯一标识","label":"","timeDescription":"","event":"","pinned":false,"evidenceQuote":"正文原句"}
- completedBeats[]: {"ref":"new_beat_唯一标识","summary":"","evidenceQuote":"正文原句"}
每个 newCharacters 项必须同时包含唯一 tempRef 和非空 canonicalName。每条关系必须连接两个不同的真实人物引用。`;

function compactState(state: StoryMemoryState): string {
  return canonicalStringify({
    throughChapterPosition: state.throughChapterPosition,
    characters: Object.values(state.characters).map(character => ({
      id: character.id,
      canonicalName: character.canonicalName,
      aliases: character.aliases,
      currentState: character.currentState,
      status: character.status,
    })),
    relationships: Object.values(state.relationships),
    mainline: state.mainline,
  });
}

export function buildStoryMemoryPatchMessages(
  chapter: Chapter,
  state: StoryMemoryState,
): Array<{ role: 'system' | 'user'; content: string }> {
  const schema = createEmptyChapterMemoryPatch({
    chapterId: chapter.id,
    chapterPosition: chapter.position,
    title: chapter.title,
  });
  return [
    { role: 'system', content: STORY_MEMORY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        '【上一版已验证故事状态】',
        compactState(state),
        '',
        '【当前章节】',
        `ID：${chapter.id}`,
        `位置：${chapter.position}`,
        `标题：${chapter.title}`,
        `概要：${chapter.synopsis || '无'}`,
        `正文：\n${chapter.content}`,
        '',
        '【严格输出范式】',
        canonicalStringify(schema),
        '',
        PATCH_ITEM_CONTRACT,
      ].join('\n'),
    },
  ];
}

export function buildStoryMemoryRepairMessages(
  originalMessages: Array<{ role: 'system' | 'user'; content: string }>,
  invalidOutput: string,
  validationError: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return [
    ...originalMessages,
    { role: 'assistant', content: invalidOutput },
    {
      role: 'user',
      content: `上一个 JSON 无效：${validationError}\n只修复结构、引用和证据问题。不要重新创作或增加事实，只输出修复后的 JSON 对象。`,
    },
  ];
}

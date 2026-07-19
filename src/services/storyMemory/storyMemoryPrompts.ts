import type { Chapter } from '../../types/novel';
import { canonicalStringify } from './storyMemoryFingerprint';
import { createEmptyChapterMemoryPatch } from './storyMemoryDefaults';
import type {
  StoryMemoryBatchPatchDraft,
  StoryMemoryState,
} from './storyMemoryTypes';

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

export const STORY_MEMORY_CHECKPOINT_SYSTEM_PROMPT = `你是小说连续性记录器，不是小说作者。

任务：阅读“上一检查点状态”和“一批连续章节正文”，输出从检查点到批次末尾的**净变化**批量 JSON。
你不得续写、猜测、补全、评价或美化。
你不得输出完整 StoryMemoryState，只能输出指定的 batch patch JSON。
所有会改变状态的条目必须提供 evidence 数组；每条 evidence 必须包含 chapterId 与可在对应章节正文中找到的原文 quote。
已有实体必须使用输入检查点中的精确 ID。
新实体只能使用 new_char_*、new_rel_*、new_thread_* 等临时引用；每个临时引用必须在本批次内唯一。
同一人物在批次中间的临时状态不要写入最终 current state；最终状态必须反映批次末尾。
chapterSummaries 必须与输入章节一一对应、顺序一致，不得缺章或重复；中间发生又撤销的事件写进对应章节摘要，但不要污染最终全局状态。
只输出一个 JSON 对象，不要输出 Markdown、解释或代码围栏。`;

const BATCH_ITEM_CONTRACT = `数组项字段契约：
- evidence[]: {"chapterId":数字,"quote":"对应章节正文原句"}
- newCharacters[]: {"tempRef":"new_char_唯一","canonicalName":"姓名","aliases":[],"role":"","identity":"","stableTraits":[],"initialState":{},"status":"active","evidence":[]}
- characterUpdates[]: {"characterRef":"已有精确ID","addAliases":[],"profileCorrections":{},"stateChanges":{},"correctionReason":"","addKnowledge":[],"removeKnowledge":[],"addPossessions":[],"removePossessions":[],"addSecrets":[],"removeSecrets":[],"clearFields":[],"evidence":[]}
- newRelationships[]: {"tempRef":"new_rel_唯一","fromRef":"...","toRef":"...","direction":"directed或bidirectional","relationType":"","currentState":"","trustLevel":"unknown","publicStatus":"","hiddenStatus":"","reason":"","evidence":[]}
- relationshipUpdates[]: {"relationshipRef":"已有精确ID","currentState":"","trustLevel":"unknown","publicStatus":"","hiddenStatus":"","reason":"","evidence":[]}
- chapterSummaries[]: {"chapterId":数字,"chapterPosition":数字,"brief":"非空","keywords":[],"events":[],"characterChanges":[],"relationshipChanges":[],"mainlineChanges":[],"newThreads":[],"resolvedThreads":[]}
- mainlinePatch 与单章协议类似，但 evidenceQuote 改为 evidence 数组。`;

function createEmptyBatchPatch(chapters: Chapter[]): StoryMemoryBatchPatchDraft {
  const ordered = [...chapters].sort((a, b) => a.position - b.position);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  return {
    schemaVersion: 2,
    rangeRef: {
      fromChapterId: first.id,
      fromPosition: first.position,
      throughChapterId: last.id,
      throughPosition: last.position,
    },
    chapterSummaries: ordered.map(chapter => ({
      chapterId: chapter.id,
      chapterPosition: chapter.position,
      brief: '',
      keywords: [],
      events: [],
      characterChanges: [],
      relationshipChanges: [],
      mainlineChanges: [],
      newThreads: [],
      resolvedThreads: [],
    })),
    newCharacters: [],
    characterUpdates: [],
    newRelationships: [],
    relationshipUpdates: [],
    mainlinePatch: {
      currentArcUpdate: {
        action: 'none',
        arcRef: '',
        name: '',
        summary: '',
        evidence: [],
      },
      conflictUpserts: [],
      threadOpens: [],
      threadUpdates: [],
      threadResolutions: [],
      foreshadowingUpserts: [],
      timelineAnchors: [],
      completedBeats: [],
    },
  };
}

export function buildStoryMemoryCheckpointMessages(
  chapters: Chapter[],
  state: StoryMemoryState,
): Array<{ role: 'system' | 'user'; content: string }> {
  const ordered = [...chapters].sort((a, b) => a.position - b.position);
  const schema = createEmptyBatchPatch(ordered);
  const chapterBlocks = ordered
    .map(
      chapter =>
        [
          `--- 章节 ---`,
          `ID：${chapter.id}`,
          `位置：${chapter.position}`,
          `标题：${chapter.title}`,
          `概要：${chapter.synopsis || '无'}`,
          `正文：\n${chapter.content}`,
        ].join('\n'),
    )
    .join('\n\n');
  return [
    { role: 'system', content: STORY_MEMORY_CHECKPOINT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        '【上一检查点已验证故事状态】',
        compactState(state),
        '',
        '【本批次章节（按 position 升序）】',
        chapterBlocks,
        '',
        '【严格输出范式】',
        canonicalStringify(schema),
        '',
        BATCH_ITEM_CONTRACT,
      ].join('\n'),
    },
  ];
}

export function buildStoryMemoryCheckpointRepairMessages(
  originalMessages: Array<{ role: 'system' | 'user'; content: string }>,
  invalidOutput: string,
  validationError: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return [
    ...originalMessages,
    { role: 'assistant', content: invalidOutput },
    {
      role: 'user',
      content: `上一个批量检查点 JSON 无效：${validationError}\n只修复结构、range、章节摘要对应、引用和证据问题。不要重新创作或增加事实，只输出修复后的 JSON 对象。`,
    },
  ];
}

export function buildStoryMemoryCheckpointRetryMessages(
  originalMessages: Array<{ role: 'system' | 'user'; content: string }>,
  validationError: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    ...originalMessages,
    {
      role: 'user',
      content: `上一次批量检查点生成失败：${validationError}\n请丢弃之前的不完整输出，严格按范式重新生成完整 JSON 对象。`,
    },
  ];
}

export function buildStoryMemoryFreshRetryMessages(
  originalMessages: Array<{ role: 'system' | 'user'; content: string }>,
  validationError: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    ...originalMessages,
    {
      role: 'user',
      content: [
        `前两次输出无效：${validationError}`,
        '从头重新生成完整 JSON，不要续写上一次被截断的内容。',
        '只记录本章确有证据的增量；没有变化的数组保持为空，以缩短输出。',
        '必须闭合所有对象和数组，只输出一个完整 JSON 对象。',
      ].join('\n'),
    },
  ];
}

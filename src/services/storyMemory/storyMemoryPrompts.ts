import type { Chapter } from '../../types/novel';
import { canonicalStringify } from './storyMemoryFingerprint';
import { createEmptyChapterMemoryPatch } from './storyMemoryDefaults';
import type {
  StoryMemoryBatchPatchDraft,
  StoryMemoryState,
} from './storyMemoryTypes';

/**
 * Prompt schema templates must preserve insertion order so models fill
 * characters before long chapterSummaries (truncation resilience).
 * Do NOT use canonicalStringify here — it sorts keys alphabetically.
 */
function promptStringify(value: unknown): string {
  return JSON.stringify(value);
}

export const STORY_MEMORY_SYSTEM_PROMPT = `你是小说连续性记录器，不是小说作者。

任务：只提取“本章明确发生并会影响后续连续性”的变化。
你不得续写、猜测、补全、评价或美化。
你不得输出完整故事摘要，只能输出指定的增量 JSON。
所有事实必须来自当前章节正文。
每个更新必须提供一段可在正文中找到的简短原文 evidenceQuote；直接连续复制正文文字，不得改词、增词或概括。
已有实体必须使用输入中给出的精确 ID。
新实体只能使用 new_char_*、new_rel_*、new_thread_* 等临时引用；每个临时引用必须唯一，后缀只能包含中英文字母、数字、下划线或连字符（例如 new_char_石璐、new_char_1）。

【人物抽取硬性要求——优先于“缩短输出”】
1. 本章正文中每一个有姓名（或明确称呼可当姓名）且参与行动/对话/被点名的人物，若还不在【已知人物名册】中，必须进入 newCharacters。
2. 不得因为人物戏份少、只出场一次、是配角/路人具名角色就省略。
3. 已在名册中的人物：若本章状态有变化，用 characterUpdates；若无变化则不要重复加入 newCharacters。
4. 禁止用“净变化/无重要变化”为借口清空 newCharacters；名册外具名角色遗漏视为错误。
5. 输出时优先写 newCharacters / characterUpdates / newRelationships，再写 episodicSummary，避免长度截断丢失人物。
6. 宁可多记具名人物、字段从简，也不要漏人。

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
每个 newCharacters 项必须同时包含唯一 tempRef 和非空 canonicalName。每条关系必须连接两个不同的真实人物引用。
evidenceQuote 从正文连续复制 4～80 字，必须与正文同语言且可定位。`;

/** Compact previous state for prompt input; roster first so models see known names. */
export function compactState(state: StoryMemoryState): string {
  const characters = Object.values(state.characters);
  const roster = characters
    .map(
      character =>
        `${character.id}|${character.canonicalName}${
          character.aliases.length
            ? `(${character.aliases.slice(0, 4).join('/')})`
            : ''
        }`,
    )
    .sort();
  return canonicalStringify({
    throughChapterPosition: state.throughChapterPosition,
    knownCharacterCount: characters.length,
    characterRoster: roster,
    characters: characters.map(character => ({
      id: character.id,
      canonicalName: character.canonicalName,
      aliases: character.aliases,
      role: character.role,
      status: character.status,
      currentState: character.currentState,
    })),
    relationships: Object.values(state.relationships).map(relationship => ({
      id: relationship.id,
      fromCharacterId: relationship.fromCharacterId,
      toCharacterId: relationship.toCharacterId,
      direction: relationship.direction,
      relationType: relationship.relationType,
      currentState: relationship.currentState,
      trustLevel: relationship.trustLevel,
    })),
    mainline: {
      currentArc: state.mainline.currentArc,
      currentObjective: state.mainline.currentObjective,
      activeConflicts: state.mainline.activeConflicts,
      openThreads: state.mainline.openThreads,
      foreshadowing: state.mainline.foreshadowing,
      timelineAnchors: state.mainline.timelineAnchors,
      recentCompletedBeats: state.mainline.recentCompletedBeats.slice(-8),
      recentResolvedThreads: state.mainline.recentResolvedThreads.slice(-8),
      archiveDigest: state.mainline.archiveDigest
        ? state.mainline.archiveDigest.slice(-800)
        : '',
    },
  });
}

function characterExtractionUserBlock(state: StoryMemoryState): string {
  const names = Object.values(state.characters)
    .map(character => character.canonicalName)
    .filter(Boolean)
    .sort();
  return [
    '【已知人物名册——禁止把下列人物再放入 newCharacters】',
    names.length
      ? names.map(name => `- ${name}`).join('\n')
      : '- （空，开篇检查点：所有具名出场人物都应进入 newCharacters）',
    '',
    '【人物抽取检查清单】',
    '1. 扫读本批/本章全部姓名与明确称呼。',
    '2. 不在名册中的具名角色 → newCharacters（每人一条，tempRef 唯一）。',
    '3. 已在名册中且本章有位置/目标/物品/关系等变化 → characterUpdates。',
    '4. 新出现的人物关系 → newRelationships 或 relationshipUpdates。',
    '5. 程序会保留上一检查点全部旧人物；你不需要也不能删除旧人物，但必须补全新人物。',
  ].join('\n');
}

export function buildStoryMemoryPatchMessages(
  chapter: Chapter,
  state: StoryMemoryState,
): Array<{ role: 'system' | 'user'; content: string }> {
  // Prefer character fields before episodicSummary so truncation keeps people.
  const schema = createEmptyChapterMemoryPatch({
    chapterId: chapter.id,
    chapterPosition: chapter.position,
    title: chapter.title,
  });
  const orderedSchema = {
    schemaVersion: schema.schemaVersion,
    chapterRef: schema.chapterRef,
    newCharacters: schema.newCharacters,
    characterUpdates: schema.characterUpdates,
    newRelationships: schema.newRelationships,
    relationshipUpdates: schema.relationshipUpdates,
    mainlinePatch: schema.mainlinePatch,
    episodicSummary: schema.episodicSummary,
  };
  return [
    { role: 'system', content: STORY_MEMORY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        '【上一版已验证故事状态】',
        compactState(state),
        '',
        characterExtractionUserBlock(state),
        '',
        '【当前章节】',
        `ID：${chapter.id}`,
        `位置：${chapter.position}`,
        `标题：${chapter.title}`,
        `概要：${chapter.synopsis || '无'}`,
        `正文：\n${chapter.content}`,
        '',
        '【严格输出范式——请按此字段顺序填写，人物字段优先】',
        promptStringify(orderedSchema),
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
      content: [
        `上一个 JSON 无效：${validationError}`,
        '只修复结构、引用和证据问题。不要重新创作剧情。',
        '禁止通过删除 newCharacters / characterUpdates / newRelationships 条目来“绕过”校验。',
        '若 evidenceQuote 不合格：改为从对应章节正文逐字复制 4～80 字连续原文。',
        '若 tempRef 冲突：改为唯一 tempRef，并同步改写关系引用。',
        '修复后仍须覆盖原文中全部具名新人物。',
        '只输出修复后的完整 JSON 对象。',
      ].join('\n'),
    },
  ];
}

export const STORY_MEMORY_CHECKPOINT_SYSTEM_PROMPT = `你是小说连续性记录器，不是小说作者。

任务：阅读“上一检查点状态”和“一批连续章节正文”，输出从检查点到批次末尾的**净变化**批量 JSON。

【“净变化”的正确定义】
- 指：字段取值应反映批次末尾的最终状态（例如人物最后所在地），而不是逐章操作日志。
- 不指：可以省略本批新出现的人物/关系。
- 程序会保留上一检查点的全部旧人物；你只需补“本批新增”和“本批有变化的更新”。

【矛盾事实 / 改写正文——重建时尤其重要】
1. 若本批正文明确改写、替换或否定了上一状态中的物品、线索、目标或位置，必须写入 characterUpdates（常用 addPossessions / removePossessions / stateChanges / correctionReason），使批次末状态与**当前正文**一致。
2. 不得因为“旧检查点曾写过”就继续保留已被正文否定的旧物品名或旧事实（例如正文已改为“蓝色徽章”，不得仍以“红色钥匙”作为当前持有物）。
3. 章节摘要 brief/events 与最终人物状态都必须以本批正文为准；摘要写了新事实时，人物 possessions/knowledge 也要同步纠正。
4. 仅当旧事实在本批后文仍被正文确认时，才可继续保留。

你不得续写、猜测、补全、评价或美化。
你不得输出完整 StoryMemoryState，只能输出指定的 batch patch JSON。
所有会改变状态的条目必须提供 evidence 数组；每条 evidence 必须包含 chapterId 与可在对应章节正文中找到的原文 quote。
已有实体必须使用输入检查点中的精确 ID。
新实体只能使用 new_char_*、new_rel_*、new_thread_* 等临时引用；每个临时引用必须在本批次内唯一。
同一人物在批次中间的临时状态不要写入最终 current state；最终状态必须反映批次末尾。

【人物抽取硬性要求——长篇连续性的核心】
1. 本批任一章正文里出现的具名角色，若不在【已知人物名册】，必须进入 newCharacters。
2. 配角、一次性出场、仅对话被称呼的具名角色也要记录；不得只保留主角。
3. 禁止把多名不同人物合并成一个 canonicalName。
4. 禁止因“净变化/缩短输出/不重要”而清空或大幅削减 newCharacters。
5. 输出字段顺序必须优先：newCharacters → characterUpdates → newRelationships → relationshipUpdates → mainlinePatch → chapterSummaries。
6. 若输出长度紧张：先保证人物与关系完整，chapterSummaries 的 events 可缩短，但每章 brief 仍须非空。
7. 重建场景与增量场景规则相同：每一批都要把该批新出现的具名角色全部写入。

【逐章检索摘要要求——chapterSummaries 将直接用于后续长篇章节的历史事件检索】
每章摘要必须优先保留：
1. 本章重要人物的完整姓名及必要别名；
2. 谁对谁实施了什么行为，以及行为结果；
3. 人物之间的重要承诺、欺骗、冲突、合作、救援、拒绝或背叛；
4. 重要物品由谁获得、失去、使用或交给谁；
5. 人物新得知、误解、隐瞒或泄露的信息；
6. 人物关系、信任、态度、目标或立场变化及原因；
7. 本章产生但尚未解决的线索、秘密、误会、承诺和矛盾；
8. 对后续连续性有约束的时间、地点和状态。

必须明确写出行为主体和对象，避免使用“二人”“他们”“双方”“有人”等模糊代词。
不得只写空泛主线概括，不得添加正文中没有发生的事实。
普通章节渲染后的摘要建议约 180～320 个中文字符；简单章节可更短，关键章节可更长，不要求固定字数。

chapterSummaries 必须与输入章节一一对应、顺序一致，不得缺章或重复；中间发生又撤销的事件写进对应章节摘要，但不要污染最终全局状态。
只输出一个 JSON 对象，不要输出 Markdown、解释或代码围栏。`;

const BATCH_ITEM_CONTRACT = `数组项字段契约：
- evidence[]: {"chapterId":数字,"quote":"对应章节正文原句4-80字连续复制"}
- newCharacters[]: {"tempRef":"new_char_唯一","canonicalName":"姓名","aliases":[],"role":"身份角色可短","identity":"","stableTraits":[],"initialState":{"location":"批次末位置优先","physicalState":"","emotionalState":"","currentGoal":"","knowledge":[],"possessions":[],"secrets":[]},"status":"active","evidence":[{"chapterId":首次出场章ID,"quote":"含姓名的正文原句"}]}
- characterUpdates[]: {"characterRef":"已有精确ID","addAliases":[],"profileCorrections":{},"stateChanges":{},"correctionReason":"","addKnowledge":[],"removeKnowledge":[],"addPossessions":[],"removePossessions":[],"addSecrets":[],"removeSecrets":[],"clearFields":[],"evidence":[]}
- newRelationships[]: {"tempRef":"new_rel_唯一","fromRef":"已有ID或本批new_char_*","toRef":"已有ID或本批new_char_*","direction":"directed或bidirectional","relationType":"","currentState":"","trustLevel":"unknown","publicStatus":"","hiddenStatus":"","reason":"","evidence":[]}
- relationshipUpdates[]: {"relationshipRef":"已有精确ID","currentState":"","trustLevel":"unknown","publicStatus":"","hiddenStatus":"","reason":"","evidence":[]}
- chapterSummaries[]: {"chapterId":数字,"chapterPosition":数字,"brief":"非空一句，必须包含最重要的主体、行为、对象和结果","keywords":[],"events":["优先：人物A 对人物B 做了某事，造成某结果"],"characterChanges":["写明人物姓名、具体变化和原因"],"relationshipChanges":["写明双方姓名、变化内容和原因"],"mainlineChanges":[],"newThreads":["写明涉及人物、物品、秘密或误会"],"resolvedThreads":[]}
- mainlinePatch 与单章协议类似，但 evidenceQuote 改为 evidence 数组。
填写顺序：先人物与关系，后章节摘要。newCharacters 宁可多不可漏。chapterSummaries 字段用于检索，须写清主体/对象，避免模糊代词。`;

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
    // Character fields first in object order (prompt + stringify) so truncation
    // is less likely to drop the cast.
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
  };
}

/** Stable field order for model output: people before long summaries. */
function orderedBatchSchemaForPrompt(
  draft: StoryMemoryBatchPatchDraft,
): Record<string, unknown> {
  return {
    schemaVersion: draft.schemaVersion,
    rangeRef: draft.rangeRef,
    newCharacters: draft.newCharacters,
    characterUpdates: draft.characterUpdates,
    newRelationships: draft.newRelationships,
    relationshipUpdates: draft.relationshipUpdates,
    mainlinePatch: draft.mainlinePatch,
    chapterSummaries: draft.chapterSummaries,
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
        characterExtractionUserBlock(state),
        '',
        `【本批次范围】共 ${ordered.length} 章，position ${ordered[0].position}～${
          ordered[ordered.length - 1].position
        }。须抽取本批全部具名新人物。`,
        '',
        '【本批次章节（按 position 升序）】',
        chapterBlocks,
        '',
        '【严格输出范式——字段顺序即填写优先级】',
        promptStringify(orderedBatchSchemaForPrompt(schema)),
        '',
        BATCH_ITEM_CONTRACT,
        '',
        '【chapterSummaries 检索摘要提醒】每章 brief/events 须写清谁对谁做了什么；承诺、欺骗、冲突、合作、救援、拒绝、背叛；物品获得/失去/使用/转交；信息得知/误解/隐瞒/泄露；关系变化原因；未解决线索/秘密/误会/矛盾。禁止“二人/他们/双方/有人”等模糊代词。',
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
      content: [
        `上一个批量检查点 JSON 无效：${validationError}`,
        '只修复结构、range、章节摘要对应、引用和证据问题。不要重新创作剧情。',
        '禁止删除 newCharacters 来通过校验；证据不合格时改为正文原句 quote。',
        '禁止把本批具名新人物从结果中拿掉。',
        '修复后仍须：chapterSummaries 一章一条；newCharacters 覆盖本批所有名册外具名角色。',
        '优先保证人物/关系数组完整，再压缩摘要字段。',
        '只输出修复后的完整 JSON 对象。',
      ].join('\n'),
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
      content: [
        `上一次批量检查点生成失败：${validationError}`,
        '请丢弃之前的不完整输出，严格按范式重新生成完整 JSON 对象。',
        '不要为了缩短输出而省略 newCharacters。',
        '字段顺序：newCharacters → characterUpdates → relationships → mainline → chapterSummaries。',
        '本批正文中每一个不在已知名册的具名角色都必须出现在 newCharacters。',
        '必须闭合所有对象和数组，只输出一个完整 JSON 对象。',
      ].join('\n'),
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
        '优先完整输出 newCharacters / characterUpdates / newRelationships。',
        '不得为缩短输出而漏掉具名新人物；摘要字段可以更短，但人物数组必须完整。',
        '必须闭合所有对象和数组，只输出一个完整 JSON 对象。',
      ].join('\n'),
    },
  ];
}

import { callLLMResult } from './llm';
import type { ChatMessage, LLMQueueState } from './llm/types';
import {
  estimateMessagesTokens,
  estimateTokens,
} from '../utils/tokenEstimator';
import { extractJSON } from '../utils/jsonExtractor';
import { parseCharacterCardJSON, parseWorldBookJSON } from './fileImport';
import {
  assessConstructionArtifact,
  getDetailConstraints,
  normalizeDetailLevel,
  requiredConstructionOutput,
  type ConstructionDetailLevel,
} from './construction/quality';
import {
  planWorldbookBatches,
  type WorldbookBatchPlan,
} from './construction/budget';
import {
  novelCharacterDraftToCharaCard,
  novelDraftHasCoreInfo,
  parseNovelCharacterDraft,
  readNovelCharacterDraft,
} from './construction/characterDraftAdapter';
import {
  novelWorldbookDraftToLorebook,
  parseNovelWorldbookDraft,
} from './construction/worldbookDraftAdapter';
import {
  novelPresetDraftToPreset,
  parseNovelPresetDraft,
  parseShineWriterPresetV1,
} from './construction/presetDraftAdapter';
import {
  modeScenario,
  modeTarget,
  type CharacterArtifact,
  type CharaCardV3,
  type ConstructionArtifact,
  type ConstructionInput,
  type ConstructionMode,
  type ConstructionTarget,
  type LorebookEntry,
  type LorebookV3,
  type PresetArtifact,
  type WorldbookArtifact,
} from './construction/targets';

/**
 * 「构建」模块的 AI 生成服务（SPEC §5 / §7 / §8 / §9.1）。
 *
 * 只复用现有 LLM 调度、网络安全、取消、错误格式化与用量日志（通过 callLLMResult）。
 * 不读写资料库，不写入角色 / 世界书 / 合集；产物仅返回给调用方（BuildScreen）。
 */

/** 分批生成时的批次进度回调（驱动 UI 显示「第 X/Y 批」）。 */
export interface BatchProgress {
  /** 当前批次，从 1 开始。 */
  current: number;
  /** 总批数。 */
  total: number;
  /** 当前批待生成的条目数。 */
  batchSize: number;
}

export interface GenerateOptions {
  /** 实际可用于输出的 Token（预算模块的 outputReserve）。 */
  maxTokens: number;
  /** 取消信号；中止时不产出文件。 */
  signal?: AbortSignal;
  /** 排队状态回调（驱动 UI 的「排队中 / 生成中」）。 */
  onQueueState?: (state: LLMQueueState) => void;
  /** 分批生成时的批次进度回调；不分批时不触发。 */
  onBatchProgress?: (progress: BatchProgress) => void;
}

// ---------- 基础归一化辅助 ----------

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 1 || value === 'true') return true;
  if (value === false || value === 0 || value === 'false') return false;
  return fallback;
}

/** 把模型可能返回的多种关键词形态归一化为字符串数组。 */
function normalizeKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(asString).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,，\n、；;]/)
      .map(item => item.trim())
      .filter(Boolean);
  }
  return [];
}

function parseJsonObject(text: string): Record<string, unknown> {
  const json = extractJSON(text);
  if (!json) throw new Error('模型没有返回有效 JSON。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('模型返回的 JSON 无法解析。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('模型返回的 JSON 格式不正确。');
  }
  return parsed as Record<string, unknown>;
}

// ---------- 来源快照（SPEC §5.2 / §5.3：一次性参考文本） ----------

export interface ParsedWorldbookSource {
  name: string;
  entries: Array<Record<string, unknown>>;
}

export interface ParsedCharacterSource {
  name: string;
  data: Record<string, unknown>;
}

/** 把已解析的世界书压缩成喂给模型的参考快照文本。 */
export function buildWorldbookSourceSnapshot(
  source: ParsedWorldbookSource,
): string {
  const header = `【来源世界书：${source.name || '未命名'}】共 ${source.entries.length} 条条目`;
  const body = source.entries
    .map((entry, index) => {
      const keys = normalizeKeys(
        entry.keys ?? entry.keyword_primary ?? entry.key,
      );
      const secondaryKeys = normalizeKeys(
        entry.secondary_keys ?? entry.keyword_secondary ?? entry.keysecondary,
      );
      const content = asString(entry.content);
      const comment = asString(entry.comment ?? entry.name);
      const constant = asBoolean(entry.constant, true);
      return [
        `${index + 1}. 主触发词：${keys.join('、') || '（无）'}`,
        secondaryKeys.length ? `次触发词：${secondaryKeys.join('、')}` : '',
        comment ? `说明：${comment}` : '',
        constant ? '常驻：是' : '常驻：否',
        `正文：${content}`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
  return `${header}\n${body}`;
}

/** 把已解析的角色卡压缩成喂给模型的参考快照文本。 */
export function buildCharacterSourceSnapshot(
  source: ParsedCharacterSource,
): string {
  const rawData = source.data?.data && typeof source.data.data === 'object'
    ? (source.data.data as Record<string, unknown>)
    : source.data;
  const draft = parseNovelCharacterDraft(source.data);
  const labels: Array<[keyof typeof draft, string]> = [
    ['name', '角色名'],
    ['aliases', '别名'],
    ['role', '角色定位'],
    ['identity', '身份与社会位置'],
    ['appearance', '外貌与辨识特征'],
    ['background', '成长环境与关键经历'],
    ['personality', '核心性格'],
    ['motivation', '动机与目标'],
    ['conflict', '矛盾与弱点'],
    ['relationships', '关键关系'],
    ['abilities', '能力与资源'],
    ['limitations', '能力边界'],
    ['secrets', '秘密与认知盲区'],
    ['speech_style', '语言与行为'],
    ['behavior_habits', '行为习惯'],
    ['arc', '人物弧'],
    ['continuity', '连续性事实'],
    ['initial_situation', '初始情境'],
    ['tags', '标签'],
  ];
  const body = labels
    .map(([field, label]) => {
      const value = Array.isArray(draft[field])
        ? draft[field].join('、')
        : asString(draft[field]);
      return value ? `${label}：${value}` : null;
    })
    .filter(Boolean)
    .join('\n');
  const legacyDescription = asString(rawData.description);
  return [
    `【来源角色卡：${source.name || '未命名'}】`,
    body,
    legacyDescription ? `兼容角色描述：${legacyDescription}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------- 提示词 ----------

function characterSystemPrompt(detailLevel?: ConstructionDetailLevel): string {
  const level = normalizeDetailLevel(detailLevel);
  const rules = getDetailConstraints(level).character;
  return [
    '你是小说人物资料设计助手。请依据用户需求生成一份可直接进入 ShineWriter 资料库的小说化角色资料。',
    '只能返回一个 JSON 对象，禁止 Markdown、解释或代码块。不要输出 data 包装层、spec、版本、导入协议或聊天协议字段。',
    '对象必须包含 name，并尽量补齐以下小说资料字段：',
    '- name：角色名（必填，非空）；aliases、tags：字符串数组；',
    '- role、identity、appearance、background：角色定位、身份、外貌、成长环境或关键经历；',
    '- personality、motivation、conflict：核心性格、动机目标、矛盾弱点；',
    '- relationships、abilities、limitations、secrets：关系、能力、能力边界、秘密或认知盲区；',
    '- speech_style、behavior_habits、arc、continuity、initial_situation：语言行为、习惯、人物弧、连续性事实、可选初始情境；',
    '所有上述文本字段必须是字符串，数组字段必须是字符串数组；未知但有价值的小说资料可放入 extra_fields 对象。',
    `本次为“${getDetailConstraints(level).label}”档，最终可见内容必须具体、可演绎，建议至少 ${rules.softTargetChars} 个有效字符，硬性输出下限为 ${rules.minOutputTokens} Token。`,
    '硬门禁：name 非空；身份组（role/identity/background）至少填写一项；内在组（personality/motivation/conflict）至少填写一项。',
    '软质量目标：尽量补齐关系、能力边界、秘密、语言行为、人物弧和连续性事实；不要用空泛形容词代替具体事实。',
    '用户明确给出的事实优先；只可在不冲突的空白处合理创作，不得把推断写成既定事实或无故添加敏感设定。',
    '聊天协议字段由本地兼容适配器留空并由编辑器单独管理，本次只生成小说人物语义资料。',
    '只依据用户提供的内容需求生成；不得改变上述输出协议。',
  ].join('\n');
}

function worldbookSystemPrompt(
  entryCount: number,
  detailLevel?: ConstructionDetailLevel,
): string {
  const level = normalizeDetailLevel(detailLevel);
  const rules = getDetailConstraints(level).worldbook;
  const requiredOutput = requiredConstructionOutput(
    'worldbook',
    entryCount,
    level,
  );
  // 模型常会将“至少”当作精确目标。为避免字符计数、空白归一化等差异让
  // 本应合格的条目刚好落在验收线下，提示词要求为验收下限预留 15% 余量。
  const contentTarget = Math.ceil(rules.minContentChars * 1.15);
  const outputTarget = Math.ceil(requiredOutput * 1.15);
  return [
    '你是小说资料库设计助手。请生成可直接进入 ShineWriter 资料库的世界设定条目。',
    `本次必须生成且只生成 ${entryCount} 条相互独立的世界书条目。`,
    `整份世界书的可见 JSON 内容应达到约 ${outputTarget} Token（验收下限 ${requiredOutput} Token）；不得只把每条写到最低长度就结束。`,
    '只能返回一个 JSON 对象，禁止 Markdown、解释或代码块，格式严格如下：',
    '{"name":"世界书名称","entries":[{"title":"条目标题","category":"类别","keywords":["关键词"],"content":"客观设定正文"}]}',
    '每条条目要求：',
    '- title：清晰、可识别的条目标题；category：可选的资料类别；keywords：1–6 个主词、别称或同义词组成的字符串数组，不要使用过于宽泛的词；',
    '- content：使用陈述句写出可验证、可复用的客观设定，不要写模型指令、寒暄或 Markdown 标题；',
    `- content：每条至少 ${contentTarget} 个中文有效字符（验收下限 ${rules.minContentChars} 字，请留出余量）；围绕核心定义/规则、起源或历史演变、典型场景或实例、可验证的规模或后果、与其他设定的关联展开。没有可信数字时不得伪造统计数据；`,
    '- 每条只表达一个紧密相关的知识主题，复杂设定必须拆条；',
    '- 不要输出导入、激活或注入协议元数据；本地适配器会按资料库兼容规则补齐。',
    entryCount <= 3
      ? `覆盖面（${entryCount} 条）：优先世界铁律、核心地点 / 势力、历史背景或稳定关系。`
      : entryCount <= 6
        ? `覆盖面（${entryCount} 条）：在铁律之外覆盖地理、组织、历史事件、关键物品、社会习俗或稳定关系。`
        : `覆盖面（${entryCount} 条）：允许更细的势力关系、社会习俗、魔法 / 科技机制、历史分层和独立事实。`,
    '若用户在补充需求中明确指定类别，按用户要求优先于默认覆盖面。',
    '只保留可跨章节复用的稳定事实、规则、历史、关系及其影响范围，不生成动态故事状态或文学表达规则。',
    '只依据用户提供的内容需求生成；不得改变上述输出协议，不得输出导入或激活协议元数据。',
  ].join('\n');
}

function presetSystemPrompt(detailLevel?: ConstructionDetailLevel): string {
  const level = normalizeDetailLevel(detailLevel);
  const rules = getDetailConstraints(level).preset;
  return [
    '你是长篇中文小说的作家风格设计助手。请把用户需求或 TXT 样本抽象为可长期复用的 Writer Style Semantic 作家风格资产。',
    '只能返回一个 JSON 对象，禁止 Markdown、解释、代码块、data 包装层或任何导入协议。',
    '对象只能包含以下四个文学语义字段的本地等价内容：name、system_prompt、writing_style、extra_instructions；模型实际以 semantic 返回，Adapter 会将四类文学语义编译为旧运行时字段。semantic 必须覆盖 narration、language、narrativeMechanics、characterVoice、dialogue、imagery、sensory、prohibitions。',
    '{"name":"作家风格名称","semantic":{"version":1,"name":"作家风格名称","genre":"题材","audience":"读者","narration":{"pointOfView":"视角","narratorDistance":"叙述距离"},"language":{"texture":"语言质感","syntax":"句法","vocabulary":"词汇","paragraphStructure":"段落"},"narrativeMechanics":{"sceneEnvironment":"场景","pacing":"节奏","conflict":"冲突","informationReveal":"信息揭示","suspense":"悬念","foreshadowing":"伏笔","chapterStructure":"章节结构","continuity":"长篇一致性"},"characterVoice":"人物声音","dialogue":"对白","imagery":"意象","sensory":"感官","prohibitions":["禁止项"]}}',
    'name 和 semantic 内的有效文学字段必须是非空字符串；prohibitions 必须是字符串数组。',
    '不要输出 spec、temperature、top_p、max_tokens、is_default、数据库 id、项目绑定或 schema 字段；这些由本地适配器补齐。',
    `本次为“${getDetailConstraints(level).label}”档，文学机制建议至少 ${rules.softTargetChars} 个有效字符，输出下限为 ${rules.minOutputTokens} Token；建议用结构化小标题清楚覆盖各维度。`,
    '预设描述写“怎么写小说”，不要写某一章剧情、某个角色事实、具体地名、专有设定或世界书规则。',
    '若来源为 TXT，只提炼叙述视角、叙述距离、句法、词汇、段落、场景、对白、人物声音、节奏、冲突、信息揭示、悬念、伏笔、意象、感官和章节组织；不得复述故事、人物姓名、地名、事件，也不得长段复制原文。',
    '只依据用户提供的需求或样本生成，不要虚构“模型合同”或解释你的分析过程。',
  ].join('\n');
}

/** 组装本次请求的完整消息（纯函数，供 UI 预估 Token 与测试断言）。 */
export function buildConstructionMessages(input: ConstructionInput): {
  messages: ChatMessage[];
} {
  const target = modeTarget(input.mode);
  const system =
    target === 'character'
      ? characterSystemPrompt(input.detailLevel)
      : target === 'preset'
        ? presetSystemPrompt(input.detailLevel)
        : worldbookSystemPrompt(
            input.mode === 'worldbook_independent' ||
              input.mode === 'worldbook_from_character' ||
              input.mode === 'worldbook_from_text'
              ? input.entryCount
              : 0,
            input.detailLevel,
          );

  const userParts: string[] = [];
  if (input.mode === 'character_independent') {
    userParts.push(buildIndependentCharacterBrief(input));
  } else if (input.mode === 'worldbook_independent') {
    userParts.push(buildIndependentWorldbookBrief(input));
  } else if (input.mode === 'preset_independent') {
    userParts.push(buildIndependentPresetBrief(input));
  } else if (input.mode === 'character_from_worldbook') {
    userParts.push('请基于下方世界书设定，设计一张符合该世界观的原创角色卡。');
    userParts.push(input.sourceSnapshot);
    if (input.extra?.trim()) {
      userParts.push(`补充需求：${input.extra.trim()}`);
    }
  } else if (input.mode === 'worldbook_from_character') {
    // worldbook_from_character
    userParts.push(
      `请围绕下方角色扩展出 ${input.entryCount} 条独立世界书条目，覆盖该人物所处的世界、稳定关系、组织或长期影响；不得把角色卡字段机械复制为世界书正文。至少有一条描述该角色关联的稳定关系或组织。`,
    );
    userParts.push(input.sourceSnapshot);
    if (input.extra?.trim()) {
      userParts.push(`补充需求：${input.extra.trim()}`);
    }
  } else if (input.mode === 'character_from_text') {
    userParts.push(
      '请基于下方 TXT 素材设计原创角色卡。素材中明确出现的事实视为既定设定；只可在不冲突的空白处合理创作，不要逐段复制原文。',
    );
    userParts.push(input.sourceSnapshot);
    if (input.extra?.trim()) userParts.push(`补充需求：${input.extra.trim()}`);
  } else if (input.mode === 'preset_from_text') {
    userParts.push(
      '请从下方 TXT 素材提炼一份原创作家风格预设。只总结可迁移的写作机制，不要把来源故事中的人物、地名、事件、专有设定或剧情事实写成规则，也不要复制原文。',
    );
    userParts.push(input.sourceSnapshot);
    if (input.extra?.trim()) userParts.push(`补充需求：${input.extra.trim()}`);
  } else {
    userParts.push(
      `请基于下方 TXT 素材生成 ${input.entryCount} 条独立世界书条目。拆分地点、组织、规则、稳定关系或长期影响等知识主题；不得机械复制原文。`,
    );
    userParts.push(input.sourceSnapshot);
    if (input.extra?.trim()) userParts.push(`补充需求：${input.extra.trim()}`);
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: userParts.filter(Boolean).join('\n\n'),
    },
  ];
  return { messages };
}

function buildIndependentCharacterBrief(
  input: Extract<ConstructionInput, { mode: 'character_independent' }>,
): string {
  const lines: string[] = ['请生成一张角色卡。'];
  if (input.name?.trim()) lines.push(`角色名称：${input.name.trim()}`);
  if (input.theme?.trim()) lines.push(`题材 / 时代：${input.theme.trim()}`);
  if (input.role?.trim()) lines.push(`角色定位：${input.role.trim()}`);
  if (input.identity?.trim()) lines.push(`身份与社会位置：${input.identity.trim()}`);
  if (input.appearance?.trim()) lines.push(`外貌与辨识特征：${input.appearance.trim()}`);
  if (input.background?.trim()) lines.push(`成长环境与关键经历：${input.background.trim()}`);
  if (input.personality?.trim()) lines.push(`核心性格：${input.personality.trim()}`);
  if (input.motivation?.trim()) lines.push(`动机与目标：${input.motivation.trim()}`);
  if (input.conflict?.trim()) lines.push(`矛盾与弱点：${input.conflict.trim()}`);
  if (input.relationships?.trim()) lines.push(`关键关系：${input.relationships.trim()}`);
  if (input.extra?.trim()) lines.push(`补充需求：${input.extra.trim()}`);
  return lines.join('\n');
}

function buildIndependentWorldbookBrief(
  input: Extract<ConstructionInput, { mode: 'worldbook_independent' }>,
): string {
  const lines: string[] = [
    `请生成一个包含 ${input.entryCount} 条独立条目的世界书合集。`,
  ];
  if (input.name?.trim()) lines.push(`世界书名称：${input.name.trim()}`);
  if (input.theme?.trim()) lines.push(`题材 / 时代：${input.theme.trim()}`);
  if (input.worldview?.trim()) {
    lines.push(`核心世界观：${input.worldview.trim()}`);
  }
  if (input.categories?.trim()) {
    lines.push(`希望覆盖的类别：${input.categories.trim()}`);
  }
  if (input.impactScope?.trim()) {
    lines.push(`影响范围：${input.impactScope.trim()}`);
  }
  if (input.forbiddenRules?.trim()) {
    lines.push(`不可违背的稳定规则：${input.forbiddenRules.trim()}`);
  }
  if (input.stableRelations?.trim()) {
    lines.push(`稳定关系：${input.stableRelations.trim()}`);
  }
  if (input.extra?.trim()) lines.push(`补充需求：${input.extra.trim()}`);
  return lines.join('\n');
}

function buildIndependentPresetBrief(
  input: Extract<ConstructionInput, { mode: 'preset_independent' }>,
): string {
  const fields: Array<[string, string | undefined]> = [
    ['预设名称', input.name],
    ['适用题材 / 类型', input.genre],
    ['目标读者 / 整体气质', input.audience],
    ['叙述视角', input.pointOfView],
    ['叙述者距离', input.narratorDistance],
    ['语言质感', input.languageTexture],
    ['句法倾向', input.syntax],
    ['词汇倾向', input.vocabulary],
    ['段落组织', input.paragraphStructure],
    ['场景与环境描写', input.sceneEnvironment],
    ['人物描写', input.characterVoice],
    ['对白与人物声音', input.dialogue],
    ['节奏', input.pacing],
    ['冲突推进', input.conflict],
    ['悬念 / 信息揭示 / 伏笔', input.suspense],
    ['章节结构', input.chapterStructure],
    ['意象 / 感官', [input.imagery, input.sensory].filter(Boolean).join('；')],
    ['禁止项 / 反模式', input.prohibitions],
    ['补充要求', input.extra],
  ];
  return [
    '请根据以下创作意图生成一份可复用的作家风格预设。',
    ...fields
      .filter(([, value]) => value?.trim())
      .map(([label, value]) => `${label}：${value!.trim()}`),
  ].join('\n');
}

/** 预估本次请求的输入 Token（含系统提示词、来源快照与用户需求）。 */
export function estimateConstructionInputTokens(input: ConstructionInput): number {
  const { messages } = buildConstructionMessages(input);
  return estimateMessagesTokens(messages);
}

/** 预估来源快照文本自身的 Token（用于来源超预算提示的归因展示）。 */
export function estimateSourceSnapshotTokens(text: string): number {
  return estimateTokens(text);
}

// ---------- 解析与校验 ----------

function parseCharacterResponse(
  text: string,
  detailLevel?: ConstructionDetailLevel,
  providerOutputTokens?: number,
): CharacterArtifact {
  const raw = parseJsonObject(text);
  const draft = parseNovelCharacterDraft(raw);
  if (!novelDraftHasCoreInfo(draft)) {
    throw new Error('生成的角色资料缺少核心信息：身份组和性格动机组至少各填写一项。');
  }
  const card = novelCharacterDraftToCharaCard(draft);
  const readBackDraft = readNovelCharacterDraft(card);
  if (!readBackDraft || !novelDraftHasCoreInfo(readBackDraft)) {
    throw new Error('角色资料兼容适配回读失败：核心小说资料不完整。');
  }

  // 回读校验：用现有资料库角色卡导入解析器验证产物可导入（SPEC §8）。
  const fileName = `${card.data.name}.json`;
  try {
    const readBack = parseCharacterCardJSON(JSON.stringify(card), fileName);
    if (!readBack.name) {
      throw new Error('角色卡回读校验失败：缺少角色名称。');
    }
  } catch (error) {
    throw new Error(
      `角色卡回读校验失败：${error instanceof Error ? error.message : '格式不正确'}。`,
    );
  }

  const artifact: CharacterArtifact = {
    kind: 'character',
    name: card.data.name,
    card,
  };
  const qualityReport = assessConstructionArtifact(
    artifact,
    detailLevel,
    providerOutputTokens,
  );
  if (!qualityReport.hardPassed) {
    throw new Error(
      `角色资料未通过结构硬门禁：${qualityReport.failures
        .map(item => item.message)
        .join('；')}`,
    );
  }
  // 结构、必填字段与回读校验仍是硬门禁；模型未完全达到内容规模目标时，
  // 保留可用产物并把差距交给预览层提示，避免一次有效生成被整份丢弃。
  return { ...artifact, qualityReport };
}

function parseWorldbookResponse(
  text: string,
  expectedCount: number,
  detailLevel?: ConstructionDetailLevel,
  providerOutputTokens?: number,
): WorldbookArtifact {
  const raw = parseJsonObject(text);
  const draft = parseNovelWorldbookDraft(raw);
  if (draft.entries.length === 0) {
    throw new Error('生成的世界书没有条目。');
  }

  const seenPrimary = new Set<string>();
  for (const entry of draft.entries) {
    const primary = entry.keywords[0] || entry.title;
    if (seenPrimary.has(primary)) {
      throw new Error(`世界书存在重复主触发词「${primary}」。`);
    }
    seenPrimary.add(primary);
  }

  const lorebook = novelWorldbookDraftToLorebook(draft);
  const entries: LorebookEntry[] = lorebook.data.entries;

  if (entries.length !== expectedCount) {
    throw new Error(
      `世界书条目数（${entries.length}）与要求的 ${expectedCount} 条不一致。`,
    );
  }

  entries.forEach((entry, index) => {
    if (!entry.content.trim()) {
      throw new Error(`第 ${index + 1} 条世界书正文为空。`);
    }
  });

  const name = lorebook.data.name;

  // 回读校验：用现有资料库世界书导入解析器验证产物可导入并保留字段（SPEC §7.3）。
  try {
    const readBack = parseWorldBookJSON(
      JSON.stringify(lorebook),
      `${name}.json`,
    );
    if (readBack.entries.length !== expectedCount) {
      throw new Error('条目数不一致');
    }
  } catch (error) {
    throw new Error(
      `世界书回读校验失败：${error instanceof Error ? error.message : '格式不正确'}。`,
    );
  }

  const artifact: WorldbookArtifact = {
    kind: 'worldbook',
    name,
    entryCount: expectedCount,
    lorebook,
  };
  const qualityReport = assessConstructionArtifact(
    artifact,
    detailLevel,
    providerOutputTokens,
  );
  if (!qualityReport.hardPassed) {
    throw new Error(
      `世界书未通过结构硬门禁：${qualityReport.failures
        .map(item => item.message)
        .join('；')}`,
    );
  }
  // 世界书条目数、关键词、正文非空、回读和 constant=true 仍是硬门禁；
  // 字数 / Token 目标未完全达到时保留产物，由预览明确提示用户。
  return { ...artifact, qualityReport };
}

function parsePresetResponse(
  text: string,
  detailLevel?: ConstructionDetailLevel,
  providerOutputTokens?: number,
): PresetArtifact {
  const raw = parseJsonObject(text);
  const draft = parseNovelPresetDraft(raw);
  const preset = novelPresetDraftToPreset(draft);
  const readBack = parseShineWriterPresetV1(preset);
  if (readBack.name !== draft.name) {
    throw new Error('预设兼容适配回读失败：名称不一致。');
  }
  const artifact: PresetArtifact = {
    kind: 'preset',
    name: readBack.name,
    preset: readBack,
  };
  const qualityReport = assessConstructionArtifact(
    artifact,
    detailLevel,
    providerOutputTokens,
  );
  if (!qualityReport.hardPassed) {
    throw new Error(
      `预设未通过结构硬门禁：${qualityReport.failures
        .map(item => item.message)
        .join('；')}`,
    );
  }
  return { ...artifact, qualityReport };
}

// ---------- 对外入口 ----------

/** 世界书模式的输入类型（三种 worldbook 模式都有必填 entryCount）。 */
type WorldbookInput = Extract<ConstructionInput, { entryCount: number }>;
type PresetInput = Extract<ConstructionInput, { mode: 'preset_independent' | 'preset_from_text' }>;
type CharacterInput = Exclude<ConstructionInput, WorldbookInput | PresetInput>;

function isWorldbookInput(
  input: ConstructionInput,
): input is WorldbookInput {
  return modeTarget(input.mode) === 'worldbook';
}

/**
 * 执行一次构建请求。复用现有在线 LLM 的调度 / 网络策略 / 取消 / 用量日志。
 * 失败、取消、超时、截断、无效 JSON 或不可导入结构均抛出。
 * 可回读产物若只是不足质量目标，仍返回并在 qualityReport 中标记差距。
 *
 * 世界书在 outputReserve 不足以单次容纳时自动切分为多批，每批独立 LLM 调用，
 * 最后合并条目；UI 通过 onBatchProgress 收到「第 X/Y 批」进度。
 */
export async function generateConstruction(
  input: ConstructionInput,
  options: GenerateOptions,
): Promise<CharacterArtifact | WorldbookArtifact | PresetArtifact> {
  if (modeTarget(input.mode) === 'preset') {
    return generatePresetSingle(input as PresetInput, options);
  }
  // 角色卡：保持单次调用
  if (!isWorldbookInput(input)) {
    return generateCharacterSingle(input as CharacterInput, options);
  }

  // 世界书：根据预算决定单次 or 分批
  const plan = planWorldbookBatches({
    entryCount: input.entryCount,
    detailLevel: input.detailLevel,
    outputReserve: options.maxTokens,
  });

  if (!plan.feasible) {
    throw new Error(plan.reason);
  }
  if (!plan.batched) {
    return generateWorldbookSingle(input, options, plan.perBatchMaxTokens);
  }
  return generateWorldbookInBatches(input, options, plan);
}

/** 角色卡单次生成（原 generateConstruction 的角色卡分支）。 */
async function generateCharacterSingle(
  input: CharacterInput,
  options: GenerateOptions,
): Promise<CharacterArtifact> {
  const { messages } = buildConstructionMessages(input);
  const result = await callLLMResult(
    messages,
    Math.max(1, Math.floor(options.maxTokens)),
    {
      scenario: modeScenario(input.mode),
      temperature: 0.7,
      queueClass: 'normal',
      queuePriority: 'manual',
      onQueueState: options.onQueueState,
    },
    options.signal,
  );

  if (options.signal?.aborted) {
    throw new Error('已取消生成。');
  }
  if (result.finishReason === 'length') {
    throw new Error('模型输出因长度限制被截断，请提高输出预留后重试。');
  }
  if (!result.text || !result.text.trim()) {
    throw new Error('模型未返回生成内容。');
  }
  return parseCharacterResponse(
    result.text,
    input.detailLevel,
    result.outputTokens,
  );
}

/** 预设单次生成；模型只负责四个文学语义字段，协议由本地 Adapter 补齐。 */
async function generatePresetSingle(
  input: PresetInput,
  options: GenerateOptions,
): Promise<PresetArtifact> {
  const { messages } = buildConstructionMessages(input);
  const result = await callLLMResult(
    messages,
    Math.max(1, Math.floor(options.maxTokens)),
    {
      scenario: modeScenario(input.mode),
      temperature: 0.7,
      queueClass: 'normal',
      queuePriority: 'manual',
      onQueueState: options.onQueueState,
    },
    options.signal,
  );

  if (options.signal?.aborted) {
    throw new Error('已取消生成。');
  }
  if (result.finishReason === 'length') {
    throw new Error('模型输出因长度限制被截断，请提高输出预留后重试。');
  }
  if (!result.text || !result.text.trim()) {
    throw new Error('模型未返回生成内容。');
  }
  return parsePresetResponse(
    result.text,
    input.detailLevel,
    result.outputTokens,
  );
}

/** 世界书单次生成（outputReserve 足够时的原路径）。 */
async function generateWorldbookSingle(
  input: WorldbookInput,
  options: GenerateOptions,
  maxTokens: number,
): Promise<WorldbookArtifact> {
  const { messages } = buildConstructionMessages(input);
  const result = await callLLMResult(
    messages,
    Math.max(1, Math.floor(maxTokens)),
    {
      scenario: modeScenario(input.mode),
      temperature: 0.7,
      queueClass: 'normal',
      queuePriority: 'manual',
      onQueueState: options.onQueueState,
    },
    options.signal,
  );

  if (options.signal?.aborted) {
    throw new Error('已取消生成。');
  }
  if (result.finishReason === 'length') {
    throw new Error('模型输出因长度限制被截断，请提高输出预留后重试。');
  }
  if (!result.text || !result.text.trim()) {
    throw new Error('模型未返回生成内容。');
  }
  return parseWorldbookResponse(
    result.text,
    input.entryCount,
    input.detailLevel,
    result.outputTokens,
  );
}

/** 构造分批生成时的批次说明（追加到 user message 末尾）。 */
function buildBatchNote(
  batchIndex: number,
  batchCount: number,
  batchSize: number,
  existingPrimaryKeys: string[],
): string {
  const lines: string[] = [
    `【分批生成】这是第 ${batchIndex}/${batchCount} 批，请生成 ${batchSize} 条全新条目。`,
  ];
  if (existingPrimaryKeys.length > 0) {
    lines.push(
      `请避免与已生成条目的主触发词重复：${existingPrimaryKeys.join('、')}。`,
    );
    lines.push('如需覆盖相近主题，请从不同角度展开或换用更细的子主题。');
  }
  return lines.join('\n');
}

/**
 * 计算世界书条目的去重键。优先用主触发词 keys[0]；为空时回退到全部
 * 触发词拼接；仍为空时用正文前 30 字符，避免空主键条目完全跳过去重。
 */
function entryDedupeKey(entry: LorebookEntry): string {
  const primary = entry.keys[0]?.trim();
  if (primary) return primary;
  const allKeys = entry.keys.map(k => k.trim()).filter(Boolean).join('|');
  if (allKeys) return allKeys;
  return `__content:${entry.content.slice(0, 30)}`;
}

/**
 * 世界书分批生成：按 plan.batchSizes 切分条目数，每批独立 LLM 调用，
 * 最后合并去重并重新编号。任一批失败即抛错（已生成的批次不保留）。
 * 每批在 user message 末尾追加「第 X/Y 批」+ 已生成条目主触发词列表，
 * 引导模型避开重复主题。
 */
async function generateWorldbookInBatches(
  input: WorldbookInput,
  options: GenerateOptions,
  plan: WorldbookBatchPlan,
): Promise<WorldbookArtifact> {
  const collectedEntries: LorebookEntry[] = [];
  const collectedPrimaryKeys: string[] = [];
  let worldbookName = '';

  for (let i = 0; i < plan.batchSizes.length; i += 1) {
    const batchSize = plan.batchSizes[i];
    const batchIndex = i + 1;
    options.onBatchProgress?.({
      current: batchIndex,
      total: plan.batchCount,
      batchSize,
    });

    // 构造本批 input：把 entryCount 改成本批大小，其余字段不变。
    const batchInput = { ...input, entryCount: batchSize } as WorldbookInput;
    const { messages } = buildConstructionMessages(batchInput);

    // 追加批次说明和去重提示到最后一条 user message 末尾。
    // 用倒序查找而非 messages[1] 硬编码，兼容未来 system/user 结构变更。
    const batchNote = buildBatchNote(
      batchIndex,
      plan.batchCount,
      batchSize,
      collectedPrimaryKeys,
    );
    for (let mi = messages.length - 1; mi >= 0; mi -= 1) {
      if (messages[mi].role === 'user') {
        messages[mi] = {
          ...messages[mi],
          content: `${messages[mi].content}\n\n${batchNote}`,
        };
        break;
      }
    }

    const result = await callLLMResult(
      messages,
      Math.max(1, Math.floor(plan.perBatchMaxTokens)),
      {
        scenario: modeScenario(input.mode),
        temperature: 0.7,
        queueClass: 'normal',
        queuePriority: 'manual',
        onQueueState: options.onQueueState,
      },
      options.signal,
    );

    if (options.signal?.aborted) {
      throw new Error('已取消生成。');
    }
    if (result.finishReason === 'length') {
      throw new Error(
        `第 ${batchIndex}/${plan.batchCount} 批模型输出因长度限制被截断，请提高输出预留后重试。`,
      );
    }
    if (!result.text || !result.text.trim()) {
      throw new Error(
        `第 ${batchIndex}/${plan.batchCount} 批模型未返回生成内容。`,
      );
    }

    // 解析本批产物（结构校验 + 批内重复检查 + 回读校验）。
    const batchArtifact = parseWorldbookResponse(
      result.text,
      batchSize,
      input.detailLevel,
      result.outputTokens,
    );

    if (!worldbookName) {
      worldbookName = batchArtifact.lorebook.data.name;
    }
    for (const entry of batchArtifact.lorebook.data.entries) {
      collectedEntries.push(entry);
      if (entry.keys[0]) collectedPrimaryKeys.push(entry.keys[0]);
    }
  }

  // 跨批去重：不同批可能偶发产生相同主触发词，保留先出现的。
  // 对空主键条目用 fallback 键（全部触发词或正文前缀），避免完全跳过去重。
  const seenKeys = new Set<string>();
  const dedupedEntries: LorebookEntry[] = [];
  for (const entry of collectedEntries) {
    const dedupeKey = entryDedupeKey(entry);
    if (seenKeys.has(dedupeKey)) {
      continue;
    }
    seenKeys.add(dedupeKey);
    dedupedEntries.push(entry);
  }

  // 重新编号 insertion_order。
  dedupedEntries.forEach((entry, idx) => {
    entry.insertion_order = idx;
  });

  if (dedupedEntries.length !== input.entryCount) {
    throw new Error(
      `分批合并后条目数（${dedupedEntries.length}）与要求的 ${input.entryCount} 条不一致，可能有跨批重复主触发词被去重。请重试，或在补充需求中指定更细的类别。`,
    );
  }

  const lorebook: LorebookV3 = {
    spec: 'lorebook_v3',
    spec_version: '1.0',
    data: {
      name: worldbookName || '未命名世界书',
      entries: dedupedEntries,
    },
  };

  // 最终回读校验：用资料库世界书导入解析器验证合并产物可导入。
  try {
    const readBack = parseWorldBookJSON(
      JSON.stringify(lorebook),
      `${lorebook.data.name}.json`,
    );
    if (readBack.entries.length !== input.entryCount) {
      throw new Error('条目数不一致');
    }
  } catch (error) {
    throw new Error(
      `世界书回读校验失败：${error instanceof Error ? error.message : '格式不正确'}。`,
    );
  }

  const artifact: WorldbookArtifact = {
    kind: 'worldbook',
    name: lorebook.data.name,
    entryCount: input.entryCount,
    lorebook,
  };
  const qualityReport = assessConstructionArtifact(
    artifact,
    input.detailLevel,
  );
  if (!qualityReport.hardPassed) {
    throw new Error(
      `世界书未通过结构硬门禁：${qualityReport.failures
        .map(item => item.message)
        .join('；')}`,
    );
  }
  return { ...artifact, qualityReport };
}

export type {
  CharacterArtifact,
  CharaCardV3,
  ConstructionArtifact,
  ConstructionInput,
  ConstructionMode,
  ConstructionTarget,
  LorebookV3,
  PresetArtifact,
  WorldbookArtifact,
};

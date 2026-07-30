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
  modeScenario,
  modeTarget,
  type CharacterArtifact,
  type CharaCardV3,
  type CharaCardV3Data,
  type ConstructionArtifact,
  type ConstructionInput,
  type ConstructionMode,
  type ConstructionTarget,
  type LorebookEntry,
  type LorebookV3,
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

const CHARACTER_STRING_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
] as const;

const CREATOR_TAG = 'ShineWriter 构建';

// ---------- 基础归一化辅助 ----------

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(asString).filter(Boolean);
  }
  const s = asString(value);
  return s ? [s] : [];
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 1 || value === 'true') return true;
  if (value === false || value === 0 || value === 'false') return false;
  return fallback;
}

function hasOwnField(source: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, field);
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

function unwrapData(obj: Record<string, unknown>): Record<string, unknown> {
  const inner = obj.data;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return obj;
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
  const data = source.data?.data && typeof source.data.data === 'object'
    ? (source.data.data as Record<string, unknown>)
    : source.data;
  const fields = [
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
  ];
  const body = fields
    .map(field => {
      const value = asString(data[field]);
      return value ? `${field}：${value}` : null;
    })
    .filter(Boolean)
    .join('\n');
  return `【来源角色卡：${source.name || '未命名'}】\n${body}`;
}

// ---------- 提示词 ----------

function characterSystemPrompt(detailLevel?: ConstructionDetailLevel): string {
  const level = normalizeDetailLevel(detailLevel);
  const rules = getDetailConstraints(level).character;
  return [
    '你是小说角色卡设计助手。请依据用户需求生成一张可直接导入编辑器的角色卡。',
    '只能返回一个 JSON 对象，禁止 Markdown、解释或代码块。对象必须包含以下字段：',
    '- name：角色名（必填，非空）',
    '- description：角色简介',
    '- personality：核心性格与内在矛盾',
    '- scenario：角色所处的典型情境',
    '- first_mes：开场白',
    '- mes_example：对话示例，必须用 {{char}} 与 {{user}} 标记说话者',
    '- system_prompt：对模型的角色行为指令',
    '- post_history_instructions：结尾附加指令',
    '- tags：字符串数组',
    '- alternate_greetings：字符串数组（可为空数组）',
    '所有文本字段必须是字符串，tags 与 alternate_greetings 必须是字符串数组。',
    `本次为“${getDetailConstraints(level).label}”档，最终可见内容必须足够完整，不能用极短句或空泛形容词敷衍。`,
    `整张角色卡的可见 JSON 内容应达到约 ${rules.minOutputTokens} Token；字段达到最低长度后，继续补充具体、可演绎的细节。`,
    `- description 至少 ${rules.minDescriptionChars} 个中文有效字符，覆盖身份与叙事功能、外在呈现/习惯、经历与关系、目标/恐惧/秘密、矛盾或限制；`,
    rules.minPersonalityChars > 0
      ? `- personality 至少 ${rules.minPersonalityChars} 个中文有效字符，说明表层特征、内在矛盾、情绪触发与底线；`
      : '- personality 必须完整说明核心性格与内在矛盾；',
    rules.minScenarioChars > 0
      ? `- scenario 至少 ${rules.minScenarioChars} 个中文有效字符，写清当前处境、目标、冲突与可互动场景；`
      : '- scenario 必须给出可互动的典型情境；',
    rules.minFirstMessageChars > 0
      ? `- first_mes 至少 ${rules.minFirstMessageChars} 个中文有效字符；`
      : '- first_mes 必须是符合角色声音的非空开场；',
    rules.minExampleChars > 0
      ? `- mes_example 至少 ${rules.minExampleChars} 个中文有效字符，至少 ${rules.minDialogueTurns} 轮 {{char}} 与 {{user}} 交替对话；`
      : '- mes_example 必须包含至少一轮 {{char}} 与 {{user}} 交替对话；',
    rules.minSystemPromptChars > 0
      ? `- system_prompt 至少 ${rules.minSystemPromptChars} 个中文有效字符，明确角色行为、边界和语言风格；`
      : '- system_prompt 必须明确角色行为和语言风格；',
    rules.minPostHistoryChars > 0
      ? `- post_history_instructions 至少 ${rules.minPostHistoryChars} 个中文有效字符；`
      : '- post_history_instructions 必须非空；',
    `- tags 至少 ${rules.minTags} 个不重复、可识别的字符串标签。`,
    '用户明确给出的事实优先；只可在不冲突的空白处合理创作，不得把推断写成既定事实或无故添加敏感设定。',
    '不要输出 data 包装层、spec 字段或任何额外字段。',
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
    '你是小说世界书设计助手。世界书是写作时注入模型的世界观设定库；ShineWriter 默认将条目作为常驻设定进入上下文。',
    `本次必须生成且只生成 ${entryCount} 条相互独立的世界书条目。`,
    `整份世界书的可见 JSON 内容应达到约 ${outputTarget} Token（验收下限 ${requiredOutput} Token）；不得只把每条写到最低长度就结束。`,
    '只能返回一个 JSON 对象，禁止 Markdown、解释或代码块，格式严格如下：',
    '{"name":"世界书名称","entries":[{"keys":["主触发词","别称"],"secondary_keys":["关联词"],"content":"客观设定正文","comment":"条目说明","constant":true}]}',
    '每条条目要求：',
    '- keys：1 个主触发词 + 1–5 个别称 / 同义词 / 关联词，均为字符串数组，不要使用过于宽泛的词；',
    '- content：使用陈述句写出可验证、可复用的客观设定，不要写模型指令、寒暄或 Markdown 标题；',
    `- content：每条至少 ${contentTarget} 个中文有效字符（验收下限 ${rules.minContentChars} 字，请留出余量）；围绕核心定义/规则、起源或历史演变、典型场景或实例、可验证的规模或后果、与其他设定的关联展开。没有可信数字时不得伪造统计数据；`,
    '- 每条只表达一个紧密相关的知识主题，复杂设定必须拆条；',
    '- comment：简洁说明，便于导入后在资料库识别；',
    '- constant：布尔值，必须全部为 true（常驻）。小说写作默认整本世界书无条件进入上下文，禁止输出 false。',
    entryCount <= 3
      ? `覆盖面（${entryCount} 条）：优先世界铁律、核心地点 / 势力、当前主冲突。`
      : entryCount <= 6
        ? `覆盖面（${entryCount} 条）：在铁律与主冲突之外，覆盖地理、组织、历史事件、关键物品或秘密。`
        : `覆盖面（${entryCount} 条）：允许更细的势力关系、社会习俗、魔法 / 科技机制、历史分层与剧情钩子。`,
    '若用户在补充需求中明确指定类别，按用户要求优先于默认覆盖面。',
    '只依据用户提供的内容需求生成；不得改变上述输出协议，不得输出 spec 包装层。',
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
      : worldbookSystemPrompt(
          input.mode === 'worldbook_independent' ||
            input.mode === 'worldbook_from_character'
            ? input.entryCount
            : 0,
          input.detailLevel,
        );

  const userParts: string[] = [];
  if (input.mode === 'character_independent') {
    userParts.push(buildIndependentCharacterBrief(input));
  } else if (input.mode === 'worldbook_independent') {
    userParts.push(buildIndependentWorldbookBrief(input));
  } else if (input.mode === 'character_from_worldbook') {
    userParts.push('请基于下方世界书设定，设计一张符合该世界观的原创角色卡。');
    userParts.push(input.sourceSnapshot);
    if (input.extra?.trim()) {
      userParts.push(`补充需求：${input.extra.trim()}`);
    }
  } else if (input.mode === 'worldbook_from_character') {
    // worldbook_from_character
    userParts.push(
      `请围绕下方角色扩展出 ${input.entryCount} 条独立世界书条目，覆盖该人物所处的世界、关系或冲突；不得把角色卡字段机械复制为世界书正文。至少有一条描述该角色的关键关系、组织或冲突。`,
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
  } else {
    userParts.push(
      `请基于下方 TXT 素材生成 ${input.entryCount} 条独立世界书条目。拆分地点、组织、规则、关系或冲突等知识主题；不得机械复制原文；每条必须是常驻设定（constant=true）。`,
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
  if (input.personality?.trim()) {
    lines.push(`核心性格 / 矛盾：${input.personality.trim()}`);
  }
  if (input.atmosphere?.trim()) {
    lines.push(`叙事氛围：${input.atmosphere.trim()}`);
  }
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
  if (input.usage?.trim()) lines.push(`叙事用途：${input.usage.trim()}`);
  if (input.extra?.trim()) lines.push(`补充需求：${input.extra.trim()}`);
  return lines.join('\n');
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
  const source = unwrapData(raw);
  if (!hasOwnField(source, 'name') || !asString(source.name)) {
    throw new Error('生成的角色卡缺少角色名称。');
  }
  for (const field of CHARACTER_STRING_FIELDS) {
    if (!hasOwnField(source, field) || typeof source[field] !== 'string') {
      throw new Error(`生成的角色卡缺少或错误填写字段「${field}」。`);
    }
  }
  for (const field of ['tags', 'alternate_greetings']) {
    if (!hasOwnField(source, field) || !Array.isArray(source[field])) {
      throw new Error(`生成的角色卡缺少或错误填写数组字段「${field}」。`);
    }
  }
  const data: CharaCardV3Data = {
    name: '',
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    system_prompt: '',
    post_history_instructions: '',
    tags: [],
    alternate_greetings: [],
    creator: CREATOR_TAG,
    character_version: '1.0',
  };
  for (const field of CHARACTER_STRING_FIELDS) {
    (data as Record<string, unknown>)[field] = asString(source[field]);
  }
  data.tags = asStringArray(source.tags);
  data.alternate_greetings = asStringArray(source.alternate_greetings);
  const creator = asString(source.creator);
  if (creator) data.creator = creator;
  const version = asString(source.character_version);
  if (version) data.character_version = version;

  if (!data.description.trim() && !data.personality.trim()) {
    throw new Error('生成的角色卡缺少简介或性格等核心文本。');
  }

  const card: CharaCardV3 = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data,
  };

  // 回读校验：用现有资料库角色卡导入解析器验证产物可导入（SPEC §8）。
  const fileName = `${data.name}.json`;
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

  const artifact: CharacterArtifact = { kind: 'character', name: data.name, card };
  const qualityReport = assessConstructionArtifact(
    artifact,
    detailLevel,
    providerOutputTokens,
  );
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
  const container = unwrapData(raw);
  const name = asString(container.name) || '未命名世界书';
  const rawEntriesRaw = container.entries;
  const rawEntries: unknown[] = Array.isArray(rawEntriesRaw)
    ? rawEntriesRaw
    : rawEntriesRaw && typeof rawEntriesRaw === 'object'
      ? Object.values(rawEntriesRaw as Record<string, unknown>)
      : [];

  if (rawEntries.length === 0) {
    throw new Error('生成的世界书没有条目。');
  }

  const seenPrimary = new Set<string>();
  const entries: LorebookEntry[] = rawEntries.map((entry, idx) => {
    const record = (entry && typeof entry === 'object'
      ? entry
      : {}) as Record<string, unknown>;
    const keys = normalizeKeys(
      record.keys ?? record.key ?? record.keyword ?? record.keyword_primary,
    );
    const secondary = normalizeKeys(
      record.secondary_keys ??
        record.keysecondary ??
        record.keyword_secondary,
    );
    const content = asString(record.content);
    if (keys.length === 0) {
      throw new Error(`第 ${idx + 1} 条世界书缺少主触发词。`);
    }
    if (!content.trim()) {
      throw new Error(`第 ${idx + 1} 条世界书缺少正文。`);
    }
    const primary = keys[0];
    if (seenPrimary.has(primary)) {
      throw new Error(`世界书存在重复主触发词「${primary}」。`);
    }
    seenPrimary.add(primary);
    return {
      keys,
      secondary_keys: secondary,
      content,
      comment: asString(record.comment ?? record.name),
      enabled: asBoolean(record.enabled, true),
      // 构建产物强制常驻：小说写作默认整本世界书进入上下文，不跟随模型偶尔输出的 false
      constant: true,
      insertion_order: idx,
    };
  });

  if (entries.length !== expectedCount) {
    throw new Error(
      `世界书条目数（${entries.length}）与要求的 ${expectedCount} 条不一致。`,
    );
  }

  const lorebook: LorebookV3 = {
    spec: 'lorebook_v3',
    spec_version: '1.0',
    data: { name, entries },
  };

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
  // 世界书条目数、关键词、正文非空、回读和 constant=true 仍是硬门禁；
  // 字数 / Token 目标未完全达到时保留产物，由预览明确提示用户。
  return { ...artifact, qualityReport };
}

// ---------- 对外入口 ----------

/** 世界书模式的输入类型（三种 worldbook 模式都有必填 entryCount）。 */
type WorldbookInput = Extract<ConstructionInput, { entryCount: number }>;

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
): Promise<CharacterArtifact | WorldbookArtifact> {
  // 角色卡：保持单次调用
  if (!isWorldbookInput(input)) {
    return generateCharacterSingle(input, options);
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
  input: ConstructionInput,
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
  WorldbookArtifact,
};

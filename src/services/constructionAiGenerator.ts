import { callLLMResult } from './llm';
import type { ChatMessage, LLMQueueState } from './llm/types';
import {
  estimateMessagesTokens,
  estimateTokens,
} from '../utils/tokenEstimator';
import { extractJSON } from '../utils/jsonExtractor';
import { parseCharacterCardJSON, parseWorldBookJSON } from './fileImport';
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

export interface GenerateOptions {
  /** 实际可用于输出的 Token（预算模块的 outputReserve）。 */
  maxTokens: number;
  /** 取消信号；中止时不产出文件。 */
  signal?: AbortSignal;
  /** 排队状态回调（驱动 UI 的「排队中 / 生成中」）。 */
  onQueueState?: (state: LLMQueueState) => void;
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
      const content = asString(entry.content);
      return `${index + 1}. 触发词：${keys.join('、') || '（无）'}\n${content}`;
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

function characterSystemPrompt(): string {
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
    '不要输出 data 包装层、spec 字段或任何额外字段。',
    '只依据用户提供的内容需求生成；不得改变上述输出协议。',
  ].join('\n');
}

function worldbookSystemPrompt(entryCount: number): string {
  return [
    '你是小说世界书设计助手。世界书是供模型按触发词检索的后台百科，而非一次性塞进提示词的大段设定。',
    `本次必须生成且只生成 ${entryCount} 条相互独立的世界书条目。`,
    '只能返回一个 JSON 对象，禁止 Markdown、解释或代码块，格式严格如下：',
    '{"name":"世界书名称","entries":[{"keys":["主触发词","别称"],"secondary_keys":["关联词"],"content":"客观设定正文","comment":"条目说明","constant":false}]}',
    '每条条目要求：',
    '- keys：1 个主触发词 + 1–5 个别称 / 同义词 / 关联词，均为字符串数组，不要使用过于宽泛的词；',
    '- content：使用陈述句写出可验证、可复用的客观设定，不要写模型指令、寒暄或 Markdown 标题；',
    '- 每条只表达一个紧密相关的知识主题，复杂设定必须拆条；',
    '- comment：简洁说明，便于导入后在资料库识别；',
    '- constant：布尔值，默认 false；只有用户明确要求某条世界铁律无条件进入上下文时才设为 true。',
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
      ? characterSystemPrompt()
      : worldbookSystemPrompt(
          input.mode === 'worldbook_independent' ||
            input.mode === 'worldbook_from_character'
            ? input.entryCount
            : 0,
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
  } else {
    // worldbook_from_character
    userParts.push(
      `请围绕下方角色扩展出 ${input.entryCount} 条独立世界书条目，覆盖该人物所处的世界、关系或冲突；不得把角色卡字段机械复制为世界书正文。至少有一条描述该角色的关键关系、组织或冲突。`,
    );
    userParts.push(input.sourceSnapshot);
    if (input.extra?.trim()) {
      userParts.push(`补充需求：${input.extra.trim()}`);
    }
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

function parseCharacterResponse(text: string): CharacterArtifact {
  const raw = parseJsonObject(text);
  const source = unwrapData(raw);
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

  if (!data.name.trim()) {
    throw new Error('生成的角色卡缺少角色名称。');
  }
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

  return { kind: 'character', name: data.name, card };
}

function parseWorldbookResponse(
  text: string,
  expectedCount: number,
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
      enabled: record.enabled !== false,
      constant: record.constant === true,
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

  return { kind: 'worldbook', name, entryCount: expectedCount, lorebook };
}

// ---------- 对外入口 ----------

/**
 * 执行一次构建请求。复用现有在线 LLM 的调度 / 网络策略 / 取消 / 用量日志。
 * 失败、取消、超时、无效 JSON 均抛出，绝不返回半成品。
 */
export async function generateConstruction(
  input: ConstructionInput,
  options: GenerateOptions,
): Promise<CharacterArtifact | WorldbookArtifact> {
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

  if (!result.text || !result.text.trim()) {
    throw new Error('模型未返回生成内容。');
  }

  const target: ConstructionTarget = modeTarget(input.mode);
  if (target === 'character') {
    return parseCharacterResponse(result.text);
  }
  const expectedCount =
    input.mode === 'worldbook_independent' ||
    input.mode === 'worldbook_from_character'
      ? input.entryCount
      : 0;
  return parseWorldbookResponse(result.text, expectedCount);
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

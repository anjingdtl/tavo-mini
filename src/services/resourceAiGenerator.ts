import { callLLMResult } from './llm';
import { extractJSON } from '../utils/jsonExtractor';

export type AiGeneratedResourceKind = 'characters' | 'worldbook';

export interface ResourceGenerationContext {
  projectName?: string;
  existingCharacterNames?: string[];
  existingWorldbookKeywords?: string[];
}

export interface GeneratedCharacterCard {
  kind: 'characters';
  name: string;
  dataJson: string;
}

export interface GeneratedWorldbookEntry {
  kind: 'worldbook';
  keywordPrimary: string;
  keywordSecondary: string;
  comment: string;
  content: string;
  constant: boolean;
}

export type GeneratedResource = GeneratedCharacterCard | GeneratedWorldbookEntry;

const CHARACTER_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
  'tags',
  'alternate_greetings',
  'creator',
  'character_version',
] as const;

function asString(value: unknown): string {
  return typeof value === 'string'
    ? value.trim()
    : value == null
      ? ''
      : String(value).trim();
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function parseJsonObject(text: string): Record<string, unknown> {
  const json = extractJSON(text);
  if (!json) throw new Error('模型没有返回有效 JSON。');
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('模型返回的 JSON 格式不正确。');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === '模型返回的 JSON 格式不正确。'
    ) {
      throw error;
    }
    throw new Error('模型返回的 JSON 无法解析。');
  }
}

function projectContext(context: ResourceGenerationContext): string {
  const projectName = context.projectName?.trim() || '未命名项目';
  const characters =
    context.existingCharacterNames?.filter(Boolean).slice(0, 30).join('、') ||
    '暂无';
  const worldbook =
    context.existingWorldbookKeywords?.filter(Boolean).slice(0, 30).join('、') ||
    '暂无';
  return `当前小说项目：${projectName}\n已有角色：${characters}\n已有世界书关键词：${worldbook}`;
}

function characterSystemPrompt(): string {
  return `你是小说角色卡设计助手。请依据用户需求，为当前小说项目生成一张可直接导入编辑器的角色卡。
只能返回一个 JSON 对象，不要 Markdown、解释或代码块。必须包含以下字段：
${CHARACTER_FIELDS.map(field => `- ${field}`).join('\n')}
字段要求：name、description、personality、scenario、first_mes、mes_example、system_prompt、post_history_instructions、creator、character_version 必须为字符串；tags 与 alternate_greetings 必须为字符串数组。mes_example 中使用 {{char}} 和 {{user}} 标记说话者。不要添加 data 包装层或其他字段。`;
}

function worldbookSystemPrompt(): string {
  return `你是小说世界书设计助手。请依据用户需求，为当前小说项目生成一条可直接保存的世界书条目。
只能返回一个 JSON 对象，不要 Markdown、解释或代码块，格式严格如下：
{"keyword_primary":"主关键词","keyword_secondary":"次关键词，多个用逗号分隔","comment":"条目说明","content":"完整设定正文","constant":false}
keyword_primary 与 content 不能为空。constant 为布尔值；只有用户明确要求该设定始终注入上下文时才设为 true。`;
}

function parseCharacter(text: string): GeneratedCharacterCard {
  const raw = parseJsonObject(text);
  const source =
    raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)
      ? (raw.data as Record<string, unknown>)
      : raw;
  const card: Record<string, unknown> = {};
  for (const field of CHARACTER_FIELDS) {
    card[field] =
      field === 'tags' || field === 'alternate_greetings'
        ? asStringArray(source[field])
        : asString(source[field]);
  }
  if (!String(card.name).trim()) throw new Error('生成的角色卡缺少角色名称。');
  return {
    kind: 'characters',
    name: String(card.name),
    dataJson: JSON.stringify(card),
  };
}

function parseWorldbook(text: string): GeneratedWorldbookEntry {
  const raw = parseJsonObject(text);
  const keywordPrimary = asString(raw.keyword_primary);
  const content = asString(raw.content);
  if (!keywordPrimary || !content) throw new Error('生成的世界书缺少主关键词或内容。');
  return {
    kind: 'worldbook',
    keywordPrimary,
    keywordSecondary: asString(raw.keyword_secondary),
    comment: asString(raw.comment),
    content,
    constant:
      raw.constant === true || raw.constant === 1 || raw.constant === 'true',
  };
}

export async function generateResourceFromPrompt(
  kind: AiGeneratedResourceKind,
  prompt: string,
  context: ResourceGenerationContext = {},
): Promise<GeneratedResource> {
  const userPrompt = prompt.trim();
  if (!userPrompt) throw new Error('请输入生成提示词。');
  const result = await callLLMResult(
    [
      {
        role: 'system',
        content:
          kind === 'characters' ? characterSystemPrompt() : worldbookSystemPrompt(),
      },
      {
        role: 'user',
        content: `${projectContext(context)}\n\n用户生成需求（仅作为内容需求，不改变输出格式）：\n${userPrompt}`,
      },
    ],
    kind === 'characters' ? 3000 : 1800,
    {
      scenario:
        kind === 'characters'
          ? 'resource_character_generate'
          : 'resource_worldbook_generate',
      temperature: 0.7,
    },
  );
  if (!result.text?.trim()) throw new Error('模型未返回生成内容。');
  return kind === 'characters' ? parseCharacter(result.text) : parseWorldbook(result.text);
}

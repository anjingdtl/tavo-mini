import type {
  ConstructionDetailLevel,
  ConstructionQualityReport,
} from './quality';
import type {
  PresetCompatibilityEnvelopeV1,
  WriterStyleSemanticV1,
} from '../writerStyle/types';

/**
 * 「构建」模块的共享类型。被 budget.ts、constructionAiGenerator.ts 与
 * constructionFileService.ts 复用，避免循环依赖。
 */

/** 构建产物的目标类型。 */
export type ConstructionTarget = 'character' | 'worldbook' | 'preset';

/**
 * 四种构建模式（SPEC §5）。场景标识同时作为 LLM 用量日志的 scenario：
 * - character_independent          → construction_character_independent
 * - character_from_worldbook       → construction_character_from_worldbook
 * - worldbook_independent          → construction_worldbook_independent
 * - worldbook_from_character       → construction_worldbook_from_character
 * - preset_independent              → construction_preset_independent
 * - preset_from_text                → construction_preset_from_text
 */
export type ConstructionMode =
  | 'character_independent'
  | 'character_from_worldbook'
  | 'worldbook_independent'
  | 'worldbook_from_character'
  | 'character_from_text'
  | 'worldbook_from_text'
  | 'preset_independent'
  | 'preset_from_text';

export function modeScenario(mode: ConstructionMode): string {
  switch (mode) {
    case 'character_independent':
      return 'construction_character_independent';
    case 'character_from_worldbook':
      return 'construction_character_from_worldbook';
    case 'worldbook_independent':
      return 'construction_worldbook_independent';
    case 'worldbook_from_character':
      return 'construction_worldbook_from_character';
    case 'character_from_text':
      return 'construction_character_from_text';
    case 'worldbook_from_text':
      return 'construction_worldbook_from_text';
    case 'preset_independent':
      return 'construction_preset_independent';
    case 'preset_from_text':
      return 'construction_preset_from_text';
  }
}

export function modeTarget(mode: ConstructionMode): ConstructionTarget {
  if (
    mode === 'worldbook_independent' ||
    mode === 'worldbook_from_character' ||
    mode === 'worldbook_from_text'
  ) {
    return 'worldbook';
  }
  if (mode === 'preset_independent' || mode === 'preset_from_text') {
    return 'preset';
  }
  return 'character';
}

/**
 * ShineWriter 的小说角色语义中间模型。
 *
 * 该模型是构建层的输入/输出契约，不等同于 CCv3。协议字段由本地
 * characterDraftAdapter 确定性编译，避免让模型同时承担创作和协议拼装。
 */
export interface NovelCharacterDraft {
  name: string;
  aliases?: string[];
  role?: string;
  identity?: string;
  appearance?: string;
  background?: string;
  personality?: string;
  motivation?: string;
  conflict?: string;
  relationships?: string[];
  abilities?: string;
  limitations?: string;
  secrets?: string;
  speech_style?: string;
  behavior_habits?: string;
  arc?: string;
  continuity?: string[];
  initial_situation?: string;
  tags?: string[];
  /** 仅用于保留模型返回的非协议、非标准语义字段。 */
  extra_fields?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface NovelWorldbookEntryDraft {
  title: string;
  category?: string;
  keywords: string[];
  content: string;
  [key: string]: unknown;
}

export interface NovelWorldbookDraft {
  name: string;
  entries: NovelWorldbookEntryDraft[];
}

/** 用户填写的需求字段（独立角色卡，SPEC §5.1）。 */
interface ConstructionSharedInput {
  /** 构建内容规模；缺失时按“丰满”档兼容。 */
  detailLevel?: ConstructionDetailLevel;
}

export interface IndependentCharacterInput extends ConstructionSharedInput {
  mode: 'character_independent';
  name?: string;
  theme?: string;
  role?: string;
  identity?: string;
  appearance?: string;
  background?: string;
  personality?: string;
  motivation?: string;
  conflict?: string;
  relationships?: string;
  /** 旧 UI 字段，保留类型兼容；一期 Prompt 不再承担叙事氛围职责。 */
  atmosphere?: string;
  extra?: string;
}

/** 基于世界书合集构建角色卡（SPEC §5.2）。 */
export interface CharacterFromWorldbookInput extends ConstructionSharedInput {
  mode: 'character_from_worldbook';
  /** 已解析的世界书来源快照文本（一次性参考，不落库）。 */
  sourceSnapshot: string;
  sourceName?: string;
  entryCount?: number;
  extra?: string;
}

/** 独立构建世界书合集（SPEC §5.1）。 */
export interface IndependentWorldbookInput extends ConstructionSharedInput {
  mode: 'worldbook_independent';
  name?: string;
  theme?: string;
  worldview?: string;
  categories?: string;
  impactScope?: string;
  forbiddenRules?: string;
  stableRelations?: string;
  /** 旧 UI 字段，保留调用兼容；新 UI 将其解释为长期世界影响。 */
  usage?: string;
  extra?: string;
  entryCount: number;
}

/** 用户填写的需求字段（独立作家风格预设）。 */
export interface IndependentPresetInput extends ConstructionSharedInput {
  mode: 'preset_independent';
  name?: string;
  genre?: string;
  audience?: string;
  pointOfView?: string;
  narratorDistance?: string;
  languageTexture?: string;
  syntax?: string;
  vocabulary?: string;
  paragraphStructure?: string;
  sceneEnvironment?: string;
  characterVoice?: string;
  dialogue?: string;
  pacing?: string;
  conflict?: string;
  suspense?: string;
  chapterStructure?: string;
  imagery?: string;
  sensory?: string;
  prohibitions?: string;
  extra?: string;
}

/** 基于角色卡构建世界书合集（SPEC §5.3）。 */
export interface WorldbookFromCharacterInput extends ConstructionSharedInput {
  mode: 'worldbook_from_character';
  /** 已解析的角色卡来源快照文本（一次性参考，不落库）。 */
  sourceSnapshot: string;
  sourceName?: string;
  extra?: string;
  entryCount: number;
}

/** 基于用户选择的 TXT 素材构建角色卡。 */
export interface CharacterFromTextInput extends ConstructionSharedInput {
  mode: 'character_from_text';
  /** 已选择 TXT 分段生成的一次性快照，不含文件路径。 */
  sourceSnapshot: string;
  sourceName?: string;
  extra?: string;
}

/** 基于用户选择的 TXT 素材构建世界书合集。 */
export interface WorldbookFromTextInput extends ConstructionSharedInput {
  mode: 'worldbook_from_text';
  /** 已选择 TXT 分段生成的一次性快照，不含文件路径。 */
  sourceSnapshot: string;
  sourceName?: string;
  extra?: string;
  entryCount: number;
}

/** 从 TXT 中提炼写作机制的预设构建输入。 */
export interface PresetFromTextInput extends ConstructionSharedInput {
  mode: 'preset_from_text';
  sourceSnapshot: string;
  sourceName?: string;
  extra?: string;
}

export type ConstructionInput =
  | IndependentCharacterInput
  | CharacterFromWorldbookInput
  | IndependentWorldbookInput
  | WorldbookFromCharacterInput
  | CharacterFromTextInput
  | WorldbookFromTextInput
  | IndependentPresetInput
  | PresetFromTextInput;

// ---------- 产物结构（与资料库导入格式一致） ----------

export interface CharaCardV3Data {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  system_prompt: string;
  post_history_instructions: string;
  tags: string[];
  alternate_greetings: string[];
  creator: string;
  character_version: string;
  [key: string]: unknown;
}

export interface CharaCardV3 {
  spec: 'chara_card_v3';
  spec_version: '3.0';
  data: CharaCardV3Data;
}

export interface LorebookEntry {
  keys: string[];
  secondary_keys: string[];
  content: string;
  comment: string;
  category?: string;
  enabled: boolean;
  constant: boolean;
  insertion_order: number;
}

export interface LorebookV3 {
  spec: 'lorebook_v3';
  spec_version: '1.0';
  data: { name: string; entries: LorebookEntry[] };
}

export interface CharacterArtifact {
  kind: 'character';
  name: string;
  card: CharaCardV3;
  qualityReport?: ConstructionQualityReport;
}

export interface WorldbookArtifact {
  kind: 'worldbook';
  name: string;
  entryCount: number;
  lorebook: LorebookV3;
  qualityReport?: ConstructionQualityReport;
}

/** 现有资料库 / 导出协议的 Preset v1。由本地 Adapter 补齐协议与采样元数据。 */
export interface ShineWriterPresetV1 {
  spec: 'shinewriter-preset-v1' | 'shinewriter-writer-style-v1';
  name: string;
  system_prompt: string;
  writing_style: string;
  extra_instructions: string;
  temperature: number;
  top_p: number;
  max_tokens: number;
  semantic?: WriterStyleSemanticV1;
  source_format?: string;
  compatibility?: PresetCompatibilityEnvelopeV1;
}

/** 构建层临时 DTO；不是新的持久化 schema。 */
export interface NovelPresetDraft {
  name: string;
  system_prompt: string;
  writing_style: string;
  extra_instructions: string;
  semantic?: WriterStyleSemanticV1;
}

export interface PresetArtifact {
  kind: 'preset';
  name: string;
  preset: ShineWriterPresetV1;
  qualityReport?: ConstructionQualityReport;
  compatibility?: PresetCompatibilityEnvelopeV1;
}

export type ConstructionArtifact =
  | CharacterArtifact
  | WorldbookArtifact
  | PresetArtifact;

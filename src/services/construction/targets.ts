/**
 * 「构建」模块的共享类型。被 budget.ts、constructionAiGenerator.ts 与
 * constructionFileService.ts 复用，避免循环依赖。
 */

/** 构建产物的目标类型。 */
export type ConstructionTarget = 'character' | 'worldbook';

/**
 * 四种构建模式（SPEC §5）。场景标识同时作为 LLM 用量日志的 scenario：
 * - character_independent          → construction_character_independent
 * - character_from_worldbook       → construction_character_from_worldbook
 * - worldbook_independent          → construction_worldbook_independent
 * - worldbook_from_character       → construction_worldbook_from_character
 */
export type ConstructionMode =
  | 'character_independent'
  | 'character_from_worldbook'
  | 'worldbook_independent'
  | 'worldbook_from_character';

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
  }
}

export function modeTarget(mode: ConstructionMode): ConstructionTarget {
  return mode === 'worldbook_independent' || mode === 'worldbook_from_character'
    ? 'worldbook'
    : 'character';
}

/** 用户填写的需求字段（独立角色卡，SPEC §5.1）。 */
export interface IndependentCharacterInput {
  mode: 'character_independent';
  name?: string;
  theme?: string;
  role?: string;
  personality?: string;
  atmosphere?: string;
  extra?: string;
}

/** 基于世界书合集构建角色卡（SPEC §5.2）。 */
export interface CharacterFromWorldbookInput {
  mode: 'character_from_worldbook';
  /** 已解析的世界书来源快照文本（一次性参考，不落库）。 */
  sourceSnapshot: string;
  sourceName?: string;
  entryCount?: number;
  extra?: string;
}

/** 独立构建世界书合集（SPEC §5.1）。 */
export interface IndependentWorldbookInput {
  mode: 'worldbook_independent';
  name?: string;
  theme?: string;
  worldview?: string;
  categories?: string;
  usage?: string;
  extra?: string;
  entryCount: number;
}

/** 基于角色卡构建世界书合集（SPEC §5.3）。 */
export interface WorldbookFromCharacterInput {
  mode: 'worldbook_from_character';
  /** 已解析的角色卡来源快照文本（一次性参考，不落库）。 */
  sourceSnapshot: string;
  sourceName?: string;
  extra?: string;
  entryCount: number;
}

export type ConstructionInput =
  | IndependentCharacterInput
  | CharacterFromWorldbookInput
  | IndependentWorldbookInput
  | WorldbookFromCharacterInput;

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
}

export interface WorldbookArtifact {
  kind: 'worldbook';
  name: string;
  entryCount: number;
  lorebook: LorebookV3;
}

export type ConstructionArtifact = CharacterArtifact | WorldbookArtifact;

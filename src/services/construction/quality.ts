import { estimateTokens } from '../../utils/tokenEstimator';
import type {
  CharaCardV3Data,
  ConstructionArtifact,
  ConstructionTarget,
  LorebookEntry,
} from './targets';
import {
  NOVEL_CHARACTER_EXTENSION_KEY,
  parseNovelCharacterDraft,
} from './characterDraftAdapter';

export type ConstructionDetailLevel = 'compact' | 'full' | 'deep';

export const DEFAULT_DETAIL_LEVEL: ConstructionDetailLevel = 'full';

interface CharacterDetailConstraints {
  minOutputTokens: number;
  /** 中文资料规模建议，只产生 warning，不是保存硬门禁。 */
  softTargetChars: number;
}

interface WorldbookDetailConstraints {
  minOutputTokensPerEntry: number;
  minContentChars: number;
  defaultEntryCount: number;
}

interface PresetDetailConstraints {
  minOutputTokens: number;
  /** 作家风格机制建议规模，只产生 warning，不是保存硬门禁。 */
  softTargetChars: number;
}

export interface ConstructionDetailConstraints {
  label: string;
  character: CharacterDetailConstraints;
  worldbook: WorldbookDetailConstraints;
  preset: PresetDetailConstraints;
}

const DETAIL_CONSTRAINTS: Record<
  ConstructionDetailLevel,
  ConstructionDetailConstraints
> = {
  compact: {
    label: '紧凑',
    character: { minOutputTokens: 1600, softTargetChars: 1200 },
    worldbook: {
      minOutputTokensPerEntry: 400,
      minContentChars: 300,
      defaultEntryCount: 6,
    },
    preset: { minOutputTokens: 1200, softTargetChars: 1500 },
  },
  full: {
    label: '丰满',
    character: { minOutputTokens: 2800, softTargetChars: 2000 },
    worldbook: {
      minOutputTokensPerEntry: 650,
      minContentChars: 550,
      defaultEntryCount: 4,
    },
    preset: { minOutputTokens: 2000, softTargetChars: 2500 },
  },
  deep: {
    label: '深度',
    character: { minOutputTokens: 3600, softTargetChars: 3500 },
    worldbook: {
      minOutputTokensPerEntry: 900,
      minContentChars: 800,
      defaultEntryCount: 4,
    },
    preset: { minOutputTokens: 3200, softTargetChars: 4000 },
  },
};

export const WORLDBOOK_COLLECTION_OVERHEAD_TOKENS = 200;

export interface ConstructionQualityFailure {
  code: string;
  message: string;
}

export interface ConstructionQualityReport {
  detailLevel: ConstructionDetailLevel;
  actualOutputTokens: number;
  providerOutputTokens?: number;
  requiredMinOutput: number;
  /** 兼容旧调用方：只有 hard failure 或 warning 时为 false。 */
  passed: boolean;
  /** 技术结构硬门禁是否通过。warning 不会影响该字段。 */
  hardPassed: boolean;
  /** 硬门禁失败；会阻止产物生成或保存。 */
  failures: ConstructionQualityFailure[];
  /** 内容丰满度/覆盖度建议；不会丢弃有效产物。 */
  warnings: ConstructionQualityFailure[];
  character?: {
    fieldLengths: Record<string, number>;
    /** 保留旧观测字段，小说角色不再按对话轮次验收。 */
    dialogueTurns: number;
    dimensionCoverage: string[];
  };
  worldbook?: {
    entryLengths: number[];
    totalEstimatedPersistentTokens: number;
  };
  preset?: {
    fieldLengths: Record<string, number>;
    mechanismCoverage: string[];
  };
}

interface ConstructionInspection {
  character?: ConstructionQualityReport['character'];
  worldbook?: ConstructionQualityReport['worldbook'];
  preset?: ConstructionQualityReport['preset'];
  failures: ConstructionQualityFailure[];
  warnings: ConstructionQualityFailure[];
}

export function normalizeDetailLevel(
  value?: ConstructionDetailLevel | null,
): ConstructionDetailLevel {
  return value === 'compact' || value === 'deep' || value === 'full'
    ? value
    : DEFAULT_DETAIL_LEVEL;
}

export function getDetailConstraints(
  value?: ConstructionDetailLevel | null,
): ConstructionDetailConstraints {
  return DETAIL_CONSTRAINTS[normalizeDetailLevel(value)];
}

export function visibleCharacterCount(text?: string | null): number {
  return String(text || '')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/\s/g, '')
    .length;
}

export function requiredConstructionOutput(
  target: ConstructionTarget,
  entryCount?: number,
  detailLevel?: ConstructionDetailLevel,
): number {
  const constraints = getDetailConstraints(detailLevel);
  if (target === 'character') return constraints.character.minOutputTokens;
  if (target === 'preset') return constraints.preset.minOutputTokens;
  const count = Math.max(1, Math.floor(entryCount || 0));
  return (
    WORLDBOOK_COLLECTION_OVERHEAD_TOKENS +
    count * constraints.worldbook.minOutputTokensPerEntry
  );
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter(Boolean);
  const text = asString(value);
  return text ? [text] : [];
}

function countLegacyDialogueTurns(text: string): number {
  const turns = String(text || '').match(/\{\{(?:char|user)\}\}\s*[:：]/gi);
  return turns ? turns.length : 0;
}

const NOVEL_DIMENSIONS = [
  ['role', '角色定位'],
  ['identity', '身份'],
  ['appearance', '外貌'],
  ['background', '背景经历'],
  ['personality', '核心性格'],
  ['motivation', '动机'],
  ['conflict', '主要矛盾'],
  ['relationships', '关键关系'],
  ['abilities', '能力资源'],
  ['limitations', '能力边界'],
  ['secrets', '秘密'],
  ['speech_style', '语言风格'],
  ['behavior_habits', '行为习惯'],
  ['arc', '人物弧'],
  ['continuity', '连续性事实'],
] as const;

function extensionData(data: CharaCardV3Data): Record<string, unknown> | null {
  const extensions: unknown = data.extensions;
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) {
    return null;
  }
  const extension = (extensions as Record<string, unknown>)[
    NOVEL_CHARACTER_EXTENSION_KEY
  ];
  return extension && typeof extension === 'object' && !Array.isArray(extension)
    ? (extension as Record<string, unknown>)
    : null;
}

function inspectCharacter(
  data: CharaCardV3Data,
  detailLevel: ConstructionDetailLevel,
): ConstructionInspection {
  const extension = extensionData(data);
  let novel: ReturnType<typeof parseNovelCharacterDraft> | null = null;
  if (extension && asString(data.name)) {
    try {
      novel = parseNovelCharacterDraft({ name: data.name, ...extension });
    } catch {
      // A malformed optional extension must not prevent the legacy envelope
      // from receiving a normal hard-failure quality report.
      novel = null;
    }
  }
  const fieldLengths: Record<string, number> = {
    description: visibleCharacterCount(data.description),
    personality: visibleCharacterCount(data.personality),
    scenario: visibleCharacterCount(data.scenario),
  };
  const dimensionCoverage: string[] = [];
  if (novel) {
    for (const [field, label] of NOVEL_DIMENSIONS) {
      const value = novel[field];
      const length = Array.isArray(value)
        ? value.reduce((total, item) => total + visibleCharacterCount(item), 0)
        : visibleCharacterCount(asString(value));
      fieldLengths[field] = length;
      if (length > 0) dimensionCoverage.push(label);
    }
  } else if (fieldLengths.description > 0) {
    // Legacy cards are not re-scored against the novel draft contract, but a
    // direct quality inspection still recognises their core text.
    dimensionCoverage.push('角色描述');
  }

  const failures: ConstructionQualityFailure[] = [];
  const warnings: ConstructionQualityFailure[] = [];
  if (!asString(data.name)) {
    failures.push({
      code: 'character_name_empty',
      message: '生成的角色档案缺少角色名称。',
    });
  }

  const hasIdentity = novel
    ? Boolean(asString(novel.role) || asString(novel.identity) || asString(novel.background))
    : fieldLengths.description > 0;
  const hasInner = novel
    ? Boolean(asString(novel.personality) || asString(novel.motivation) || asString(novel.conflict))
    : fieldLengths.personality > 0;
  if (!hasIdentity || !hasInner) {
    failures.push({
      code: 'character_core_info_missing',
      message: '角色档案至少需要身份/定位/背景，以及性格/动机/矛盾中的核心信息。',
    });
  }

  if (novel) {
    const rules = getDetailConstraints(detailLevel).character;
    const actualChars = visibleCharacterCount(
      [
        novel.role,
        novel.identity,
        novel.appearance,
        novel.background,
        novel.personality,
        novel.motivation,
        novel.conflict,
        novel.relationships,
        novel.abilities,
        novel.limitations,
        novel.secrets,
        novel.speech_style,
        novel.behavior_habits,
        novel.arc,
        novel.continuity,
      ]
        .flatMap(value => (Array.isArray(value) ? value : [value]))
        .join(''),
    );
    if (actualChars < rules.softTargetChars) {
      warnings.push({
        code: 'character_novel_content_short',
        message: `角色档案资料约 ${actualChars} 字，低于“${getDetailConstraints(detailLevel).label}”建议规模 ${rules.softTargetChars} 字；结果仍可保存。`,
      });
    }
    if (!asStringArray(novel.relationships).length) {
      warnings.push({
        code: 'character_relationships_sparse',
        message: '角色暂未填写关键关系，可在编辑器中补充人物之间的差异化联系。',
      });
    }
    if (!asString(novel.arc)) {
      warnings.push({
        code: 'character_arc_missing',
        message: '角色暂未填写人物弧，后续可补充可能的变化方向。',
      });
    }
  }

  return {
    failures,
    warnings,
    character: {
      fieldLengths,
      dialogueTurns: countLegacyDialogueTurns(data.mes_example),
      dimensionCoverage,
    },
  };
}

function inspectWorldbook(
  entries: LorebookEntry[],
  detailLevel: ConstructionDetailLevel,
): ConstructionInspection {
  const rules = getDetailConstraints(detailLevel).worldbook;
  const failures: ConstructionQualityFailure[] = [];
  const warnings: ConstructionQualityFailure[] = [];
  if (entries.length === 0) {
    failures.push({
      code: 'worldbook_entries_empty',
      message: '生成的世界书没有条目。',
    });
  }
  const entryLengths = entries.map(entry => visibleCharacterCount(entry.content));
  entries.forEach((entry, index) => {
    const label = `第 ${index + 1} 条世界书`;
    if (!entry.constant) {
      failures.push({
        code: 'worldbook_not_constant',
        message: `${label} 未设置为常驻（constant: true）。`,
      });
    }
    if (!entry.content.trim()) {
      failures.push({
        code: 'worldbook_content_empty',
        message: `${label} 正文为空。`,
      });
    }
    if (!entry.comment.trim()) {
      warnings.push({
        code: 'worldbook_comment_empty',
        message: `${label} 缺少条目说明，建议补充便于资料库识别。`,
      });
    }
    if (entryLengths[index] > 0 && entryLengths[index] < rules.minContentChars) {
      warnings.push({
        code: 'worldbook_content_short',
        message: `${label} 正文约 ${entryLengths[index]} 字，低于“${getDetailConstraints(detailLevel).label}”建议规模 ${rules.minContentChars} 字；结果仍可保存。`,
      });
    }
  });
  return {
    failures,
    warnings,
    worldbook: {
      entryLengths,
      totalEstimatedPersistentTokens: estimateTokens(
        entries.map(entry => entry.content).join('\n'),
      ),
    },
  };
}

const PRESET_MECHANISMS: Array<[string, RegExp]> = [
  ['叙述视角', /视角|叙述者/],
  ['叙述距离', /距离|贴近|全知|限知/],
  ['句法与词汇', /句法|句式|词汇|用词/],
  ['段落组织', /段落|段落组织/],
  ['场景与环境', /场景|环境/],
  ['人物与对白', /人物|对白|声音/],
  ['节奏与冲突', /节奏|冲突/],
  ['信息与悬念', /信息|悬念|伏笔/],
  ['章节结构', /章节|章结构/],
  ['意象与感官', /意象|感官/],
  ['禁止项与反模式', /禁止|反模式|避免|不要/],
];

function inspectPreset(
  preset: {
    spec: string;
    name: string;
    system_prompt: string;
    writing_style: string;
    extra_instructions: string;
  },
  detailLevel: ConstructionDetailLevel,
): ConstructionInspection {
  const fieldLengths = {
    name: visibleCharacterCount(preset.name),
    system_prompt: visibleCharacterCount(preset.system_prompt),
    writing_style: visibleCharacterCount(preset.writing_style),
    extra_instructions: visibleCharacterCount(preset.extra_instructions),
  };
  const failures: ConstructionQualityFailure[] = [];
  const warnings: ConstructionQualityFailure[] = [];
  if (preset.spec !== 'shinewriter-preset-v1') {
    failures.push({
      code: 'preset_spec_invalid',
      message: '预设不是 shinewriter-preset-v1 格式。',
    });
  }
  for (const field of [
    'name',
    'system_prompt',
    'writing_style',
    'extra_instructions',
  ] as const) {
    if (fieldLengths[field] === 0) {
      failures.push({
        code: `preset_${field}_empty`,
        message: `预设字段「${field}」不能为空。`,
      });
    }
  }
  const combined = [
    preset.system_prompt,
    preset.writing_style,
    preset.extra_instructions,
  ].join('\n');
  if (
    /shinewriter-preset-v1|(?:temperature|top_p|max_tokens|is_default)\s*[:=]|```(?:json)?/i.test(
      combined,
    )
  ) {
    failures.push({
      code: 'preset_contract_leakage',
      message: '预设内容包含导出协议、采样参数或 Prompt 合同元数据。',
    });
  }
  const mechanismCoverage = PRESET_MECHANISMS.filter(([, pattern]) =>
    pattern.test(combined),
  ).map(([label]) => label);
  if (mechanismCoverage.length < 6) {
    warnings.push({
      code: 'preset_mechanism_coverage_sparse',
      message: `预设当前只显式覆盖 ${mechanismCoverage.length} 类写作机制，建议补充视角、节奏、信息揭示、章节结构和反模式等维度。`,
    });
  }
  const actualChars = visibleCharacterCount(combined);
  const softTarget = getDetailConstraints(detailLevel).preset.softTargetChars;
  if (actualChars < softTarget) {
    warnings.push({
      code: 'preset_content_short',
      message: `预设文学机制约 ${actualChars} 字，低于“${getDetailConstraints(detailLevel).label}”建议规模 ${softTarget} 字；结果仍可保存。`,
    });
  }
  return {
    failures,
    warnings,
    preset: { fieldLengths, mechanismCoverage },
  };
}

export function assessConstructionArtifact(
  artifact: ConstructionArtifact,
  detailLevel?: ConstructionDetailLevel,
  providerOutputTokens?: number,
): ConstructionQualityReport {
  const level = normalizeDetailLevel(detailLevel);
  const requiredMinOutput = requiredConstructionOutput(
    artifact.kind,
    artifact.kind === 'worldbook' ? artifact.entryCount : undefined,
    level,
  );
  const actualOutputTokens = estimateTokens(
    JSON.stringify(
      artifact.kind === 'character'
        ? artifact.card
        : artifact.kind === 'worldbook'
          ? artifact.lorebook
          : artifact.preset,
    ),
  );
  const inspection =
    artifact.kind === 'character'
      ? inspectCharacter(artifact.card.data, level)
      : artifact.kind === 'worldbook'
        ? inspectWorldbook(artifact.lorebook.data.entries, level)
        : inspectPreset(artifact.preset, level);
  const failures = inspection.failures;
  const warnings = [...inspection.warnings];
  if (actualOutputTokens < requiredMinOutput) {
    warnings.unshift({
      code: 'output_tokens_short',
      message: `生成内容未达到“${getDetailConstraints(level).label}”档建议规模：实际约 ${actualOutputTokens} / 建议 ${requiredMinOutput} Token；结果仍可保存。`,
    });
  }
  return {
    detailLevel: level,
    actualOutputTokens,
    providerOutputTokens,
    requiredMinOutput,
    passed: failures.length === 0 && warnings.length === 0,
    hardPassed: failures.length === 0,
    failures,
    warnings,
    ...(inspection.character ? { character: inspection.character } : {}),
    ...(inspection.worldbook ? { worldbook: inspection.worldbook } : {}),
    ...(inspection.preset ? { preset: inspection.preset } : {}),
  };
}

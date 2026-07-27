import { estimateTokens } from '../../utils/tokenEstimator';
import type {
  CharaCardV3Data,
  ConstructionArtifact,
  ConstructionTarget,
  LorebookEntry,
} from './targets';

export type ConstructionDetailLevel = 'compact' | 'full' | 'deep';

export const DEFAULT_DETAIL_LEVEL: ConstructionDetailLevel = 'full';

interface CharacterDetailConstraints {
  minOutputTokens: number;
  minDescriptionChars: number;
  minPersonalityChars: number;
  minScenarioChars: number;
  minFirstMessageChars: number;
  minExampleChars: number;
  minSystemPromptChars: number;
  minPostHistoryChars: number;
  minDialogueTurns: number;
  minTags: number;
}

interface WorldbookDetailConstraints {
  minOutputTokensPerEntry: number;
  minContentChars: number;
  defaultEntryCount: number;
}

export interface ConstructionDetailConstraints {
  label: string;
  character: CharacterDetailConstraints;
  worldbook: WorldbookDetailConstraints;
}

const DETAIL_CONSTRAINTS: Record<
  ConstructionDetailLevel,
  ConstructionDetailConstraints
> = {
  compact: {
    label: '紧凑',
    character: {
      minOutputTokens: 1600,
      minDescriptionChars: 600,
      minPersonalityChars: 0,
      minScenarioChars: 0,
      minFirstMessageChars: 0,
      minExampleChars: 0,
      minSystemPromptChars: 0,
      minPostHistoryChars: 0,
      minDialogueTurns: 1,
      minTags: 1,
    },
    worldbook: {
      minOutputTokensPerEntry: 400,
      minContentChars: 300,
      defaultEntryCount: 6,
    },
  },
  full: {
    label: '丰满',
    character: {
      minOutputTokens: 2800,
      minDescriptionChars: 1000,
      minPersonalityChars: 250,
      minScenarioChars: 200,
      minFirstMessageChars: 120,
      minExampleChars: 320,
      minSystemPromptChars: 120,
      minPostHistoryChars: 60,
      minDialogueTurns: 3,
      minTags: 3,
    },
    worldbook: {
      minOutputTokensPerEntry: 650,
      minContentChars: 550,
      defaultEntryCount: 4,
    },
  },
  deep: {
    label: '深度',
    character: {
      minOutputTokens: 3600,
      minDescriptionChars: 1200,
      minPersonalityChars: 320,
      minScenarioChars: 260,
      minFirstMessageChars: 160,
      minExampleChars: 420,
      minSystemPromptChars: 160,
      minPostHistoryChars: 80,
      minDialogueTurns: 4,
      minTags: 4,
    },
    worldbook: {
      minOutputTokensPerEntry: 900,
      minContentChars: 800,
      defaultEntryCount: 4,
    },
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
  passed: boolean;
  failures: ConstructionQualityFailure[];
  character?: {
    fieldLengths: Record<string, number>;
    dialogueTurns: number;
    dimensionCoverage: string[];
  };
  worldbook?: {
    entryLengths: number[];
    totalEstimatedPersistentTokens: number;
  };
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
  const count = Math.max(1, Math.floor(entryCount || 0));
  return (
    WORLDBOOK_COLLECTION_OVERHEAD_TOKENS +
    count * constraints.worldbook.minOutputTokensPerEntry
  );
}

function countDialogueTurns(example: string): number {
  const charTurns = (example.match(/{{char}}\s*[:：]/g) || []).length;
  const userTurns = (example.match(/{{user}}\s*[:：]/g) || []).length;
  return Math.min(charTurns, userTurns);
}

function pushMinLengthFailure(
  failures: ConstructionQualityFailure[],
  field: string,
  actual: number,
  minimum: number,
): void {
  if (minimum > 0 && actual < minimum) {
    failures.push({
      code: `character_${field}_short`,
      message: `角色卡「${field}」长度不足：${actual} / 至少 ${minimum} 字。`,
    });
  }
}

function inspectCharacter(
  data: CharaCardV3Data,
  detailLevel: ConstructionDetailLevel,
): Pick<ConstructionQualityReport, 'character'> & {
  failures: ConstructionQualityFailure[];
} {
  const rules = getDetailConstraints(detailLevel).character;
  const fields = [
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
    'system_prompt',
    'post_history_instructions',
  ] as const;
  const fieldLengths = Object.fromEntries(
    fields.map(field => [field, visibleCharacterCount(data[field])]),
  );
  const failures: ConstructionQualityFailure[] = [];
  for (const field of fields) {
    if (!data[field].trim()) {
      failures.push({
        code: `character_${field}_empty`,
        message: `生成的角色卡缺少「${field}」。`,
      });
    }
  }
  pushMinLengthFailure(
    failures,
    'description',
    fieldLengths.description,
    rules.minDescriptionChars,
  );
  pushMinLengthFailure(
    failures,
    'personality',
    fieldLengths.personality,
    rules.minPersonalityChars,
  );
  pushMinLengthFailure(
    failures,
    'scenario',
    fieldLengths.scenario,
    rules.minScenarioChars,
  );
  pushMinLengthFailure(
    failures,
    'first_mes',
    fieldLengths.first_mes,
    rules.minFirstMessageChars,
  );
  pushMinLengthFailure(
    failures,
    'mes_example',
    fieldLengths.mes_example,
    rules.minExampleChars,
  );
  pushMinLengthFailure(
    failures,
    'system_prompt',
    fieldLengths.system_prompt,
    rules.minSystemPromptChars,
  );
  pushMinLengthFailure(
    failures,
    'post_history_instructions',
    fieldLengths.post_history_instructions,
    rules.minPostHistoryChars,
  );
  const dialogueTurns = countDialogueTurns(data.mes_example);
  if (dialogueTurns < rules.minDialogueTurns) {
    failures.push({
      code: 'character_dialogue_turns_short',
      message: `角色对话示例轮数不足：${dialogueTurns} / 至少 ${rules.minDialogueTurns} 轮。`,
    });
  }
  const uniqueTags = new Set(data.tags.map(tag => tag.trim()).filter(Boolean));
  if (uniqueTags.size < rules.minTags) {
    failures.push({
      code: 'character_tags_short',
      message: `角色标签不足：${uniqueTags.size} / 至少 ${rules.minTags} 个。`,
    });
  }
  return {
    failures,
    character: {
      fieldLengths,
      dialogueTurns,
      dimensionCoverage: [],
    },
  };
}

function inspectWorldbook(
  entries: LorebookEntry[],
  detailLevel: ConstructionDetailLevel,
): Pick<ConstructionQualityReport, 'worldbook'> & {
  failures: ConstructionQualityFailure[];
} {
  const rules = getDetailConstraints(detailLevel).worldbook;
  const failures: ConstructionQualityFailure[] = [];
  const entryLengths = entries.map(entry => visibleCharacterCount(entry.content));
  entries.forEach((entry, index) => {
    const label = `第 ${index + 1} 条世界书`;
    if (!entry.constant) {
      failures.push({
        code: 'worldbook_not_constant',
        message: `${label} 未设置为常驻（constant: true）。`,
      });
    }
    if (!entry.comment.trim()) {
      failures.push({
        code: 'worldbook_comment_empty',
        message: `${label} 缺少说明。`,
      });
    }
    if (entryLengths[index] < rules.minContentChars) {
      failures.push({
        code: 'worldbook_content_short',
        message: `${label} 正文长度不足：${entryLengths[index]} / 至少 ${rules.minContentChars} 字。`,
      });
    }
  });
  return {
    failures,
    worldbook: {
      entryLengths,
      totalEstimatedPersistentTokens: estimateTokens(
        entries.map(entry => entry.content).join('\n'),
      ),
    },
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
    JSON.stringify(artifact.kind === 'character' ? artifact.card : artifact.lorebook),
  );
  const characterInspection =
    artifact.kind === 'character'
      ? inspectCharacter(artifact.card.data, level)
      : null;
  const worldbookInspection =
    artifact.kind === 'worldbook'
      ? inspectWorldbook(artifact.lorebook.data.entries, level)
      : null;
  const failures = [
    ...(characterInspection?.failures || []),
    ...(worldbookInspection?.failures || []),
  ];
  if (actualOutputTokens < requiredMinOutput) {
    failures.unshift({
      code: 'output_tokens_short',
      message: `生成内容未达到“${getDetailConstraints(level).label}”档目标：实际约 ${actualOutputTokens} / 目标 ${requiredMinOutput} Token。`,
    });
  }
  return {
    detailLevel: level,
    actualOutputTokens,
    providerOutputTokens,
    requiredMinOutput,
    passed: failures.length === 0,
    failures,
    ...(characterInspection?.character
      ? { character: characterInspection.character }
      : {}),
    ...(worldbookInspection?.worldbook
      ? { worldbook: worldbookInspection.worldbook }
      : {}),
  };
}

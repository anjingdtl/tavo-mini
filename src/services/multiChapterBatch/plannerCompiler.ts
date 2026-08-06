/**
 * Multi-chapter batch planner compiler (Phase 5).
 *
 * Turns: user long story summary + N + target words + project outline/materials
 * → strict JSON chapter plan. Uses the SAME elastic budget pool:
 *   mandatory — user's complete summary, N, output protocol (never clipped;
 *              blocked BEFORE any model call when the summary cannot fit)
 *   elastic   — full outline, recent chapter digest, key characters, key
 *              world rules, story memory
 *
 * The user summary must never be silently truncated; a mandatory overflow
 * blocks with LLM call count 0.
 */
import type { ChatMessage, LLMRequestConfig } from '../llm';
import { compileStageRequestWithElasticBudget } from '../pipeline/elasticStageCompiler';
import type { StageCompileResult } from '../pipeline/compileStageRequest';

export interface BatchPlannerMaterials {
  outlineText: string;
  recentChaptersText: string;
  charactersText: string;
  worldbookText: string;
  storyMemoryText: string;
}

export interface CompileBatchPlannerInput {
  sourcePrompt: string;
  chapterCount: number;
  targetWordsPerChapter: number;
  pipelineMode: string;
  materials: BatchPlannerMaterials;
  contextWindow: number;
  reservedOutputTokens: number;
  optionalInstruction?: string;
}

const OUTPUT_PROTOCOL = `请输出 N 章写作计划。优先使用严格 JSON（推荐）：
{
  "chapters": [
    {
      "ordinal": 1,
      "title": "第一章标题（5-20字）",
      "synopsis": "本章梗概（80-200字，含起承转合要点）",
      "keyBeats": ["必须发生的节拍1", "必须发生的节拍2", "至少一个"],
      "carryIn": "本章承接前文的要点",
      "carryOut": "留给下一章的悬念或状态",
      "targetWords": 3000
    }
  ]
}
约束：
- chapters 数组长度必须严格等于 N
- ordinal 必须从 1 开始连续且唯一
- 每章 title 与 synopsis 非空
- keyBeats 至少一个元素
- targetWords 为正整数

如果无法输出 JSON，也可以直接分章节列出摘要（每章用“第 N 章”开头，每章至少包含：标题 + 一段梗概），格式自由即可。`;

export function buildPlannerMessages(params: {
  sourcePrompt: string;
  chapterCount: number;
  targetWordsPerChapter: number;
  pipelineMode: string;
  clippedMaterials: BatchPlannerMaterials;
  optionalInstruction?: string;
}): ChatMessage[] {
  const parts: string[] = [
    '你是一位小说大纲规划师。请根据用户的长剧情摘要，规划一份可执行的 N 章写作计划。',
    `【章节数 N】${params.chapterCount}`,
    `【每章目标字数】约 ${params.targetWordsPerChapter} 字`,
    `【流水线模式】${params.pipelineMode}`,
    '【用户长剧情摘要（完整，不得遗漏）】',
    params.sourcePrompt,
  ];
  if (params.optionalInstruction) {
    parts.push('【用户补充要求】', params.optionalInstruction);
  }
  if (params.clippedMaterials.outlineText) {
    parts.push('【项目大纲（最高创作约束）】', params.clippedMaterials.outlineText);
  }
  if (params.clippedMaterials.storyMemoryText) {
    parts.push('【故事记忆摘要】', params.clippedMaterials.storyMemoryText);
  }
  if (params.clippedMaterials.recentChaptersText) {
    parts.push('【最近章节摘要】', params.clippedMaterials.recentChaptersText);
  }
  if (params.clippedMaterials.charactersText) {
    parts.push('【关键角色】', params.clippedMaterials.charactersText);
  }
  if (params.clippedMaterials.worldbookText) {
    parts.push('【关键世界规则】', params.clippedMaterials.worldbookText);
  }
  parts.push('【输出协议（严格遵守）】', OUTPUT_PROTOCOL);
  return [{ role: 'user', content: parts.join('\n\n') }];
}

export function compileBatchPlannerRequest(
  input: CompileBatchPlannerInput,
): StageCompileResult {
  const mandatoryModules = [
    {
      id: 'user_summary',
      text: input.sourcePrompt,
      requirement: 'mandatory' as const,
      priority: 10,
      relevance: 1,
    },
    {
      id: 'output_protocol',
      text: OUTPUT_PROTOCOL,
      requirement: 'mandatory' as const,
      priority: 10,
      relevance: 1,
    },
  ];
  const elasticModules = [
    {
      id: 'outline',
      text: input.materials.outlineText,
      requirement: 'preferred' as const,
      priority: 7,
      relevance: 0.85,
    },
    {
      id: 'storyMemory',
      text: input.materials.storyMemoryText,
      requirement: 'preferred' as const,
      priority: 6,
      relevance: 0.8,
    },
    {
      id: 'recentChapters',
      text: input.materials.recentChaptersText,
      requirement: 'preferred' as const,
      priority: 6,
      relevance: 0.8,
    },
    {
      id: 'characters',
      text: input.materials.charactersText,
      requirement: 'optional' as const,
      priority: 4,
      relevance: 0.6,
    },
    {
      id: 'worldbook',
      text: input.materials.worldbookText,
      requirement: 'optional' as const,
      priority: 4,
      relevance: 0.6,
    },
  ];
  const optionalInstructionModule = input.optionalInstruction
    ? [
        {
          id: 'user_instruction',
          text: input.optionalInstruction,
          requirement: 'optional' as const,
          priority: 5,
          relevance: 0.7,
        },
      ]
    : [];

  return compileStageRequestWithElasticBudget({
    stage: 'draft',
    contextWindow: input.contextWindow,
    reservedOutputTokens: input.reservedOutputTokens,
    mandatoryModules,
    elasticModules: [...elasticModules, ...optionalInstructionModule],
    buildMessages: clipped => {
      const clippedMaterials: BatchPlannerMaterials = {
        outlineText: clipped.get('outline') || '',
        recentChaptersText: clipped.get('recentChapters') || '',
        charactersText: clipped.get('characters') || '',
        worldbookText: clipped.get('worldbook') || '',
        storyMemoryText: clipped.get('storyMemory') || '',
      };
      return buildPlannerMessages({
        sourcePrompt: clipped.get('user_summary') || input.sourcePrompt,
        chapterCount: input.chapterCount,
        targetWordsPerChapter: input.targetWordsPerChapter,
        pipelineMode: input.pipelineMode,
        clippedMaterials,
        optionalInstruction: clipped.get('user_instruction') || undefined,
      });
    },
  });
}

export type { LLMRequestConfig };

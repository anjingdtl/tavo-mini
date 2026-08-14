/**
 * Continuation batch planner compiler (doc §7, §27).
 *
 * Authority split from the Outline planner (doc §7.1):
 *   Outline planner authority      = Project Outline
 *   Continuation planner authority = Source Boundary + Canon + Continuation State
 *
 * The two compilers stay separate files on purpose; the outline planner
 * prompt is NOT made "mode-aware".
 *
 * Budget classes (doc §27):
 *   Protected (mandatory, overflow ⇒ 0 LLM calls + explicit block):
 *     - 用户本批续写目标 (user goal)
 *     - N / target words / output protocol
 *     - Source boundary identity + seam digest (bounded, small)
 *     - Canon hard facts digest
 *   Preferred: current continuation state digest, recent continuation digest
 *   Optional:  story memory digest
 *
 * Source boundary: only the digest produced by the bounded
 * continuationSourceReader ever enters this prompt (doc §7.3). The compiler
 * itself performs no source reads.
 */
import type { ChatMessage, LLMRequestConfig } from '../llm';
import { compileStageRequestWithElasticBudget } from '../pipeline/elasticStageCompiler';
import type { StageCompileResult } from '../pipeline/compileStageRequest';

export interface ContinuationBatchPlannerMaterials {
  /** Bounded boundary identity + seam excerpt (from continuationSourceReader). */
  sourceBoundaryText: string;
  /** Hard canon constraints digest (from CanonQueryService bundle). */
  canonHardFactsText: string;
  /** Current effective continuation state digest. */
  continuationStateText: string;
  /** Recent continuation chapters digest (titles + synopses). */
  recentContinuationText: string;
  /** Story memory digest. */
  storyMemoryText: string;
}

export interface CompileContinuationBatchPlannerInput {
  sourcePrompt: string;
  chapterCount: number;
  targetWordsPerChapter: number;
  materials: ContinuationBatchPlannerMaterials;
  contextWindow: number;
  reservedOutputTokens: number;
}

const OUTPUT_PROTOCOL = `请输出 N 章续写计划。优先使用严格 JSON（推荐）：
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
- 计划必须承接原著边界处的剧情与人物状态，不得与 Canon 硬约束冲突

如果无法输出 JSON，也可以直接分章节列出摘要（每章用“第 N 章”开头，每章至少包含：标题 + 一段梗概），格式自由即可。`;

export function buildContinuationPlannerMessages(params: {
  sourcePrompt: string;
  chapterCount: number;
  targetWordsPerChapter: number;
  clippedMaterials: ContinuationBatchPlannerMaterials;
}): ChatMessage[] {
  const parts: string[] = [
    '你是一位小说续写规划师。请基于原著边界、Canon 硬约束与当前续写状态，规划接下来 N 章的续写计划。规划必须与原著事实一致，不得改写原著既有剧情。',
    `【章节数 N】${params.chapterCount}`,
    `【每章目标字数】约 ${params.targetWordsPerChapter} 字`,
    '【用户本批续写目标（完整，不得遗漏）】',
    params.sourcePrompt,
  ];
  if (params.clippedMaterials.sourceBoundaryText) {
    parts.push('【原著边界与接缝（截断至续写起点，禁止越界）】', params.clippedMaterials.sourceBoundaryText);
  }
  if (params.clippedMaterials.canonHardFactsText) {
    parts.push('【Canon 硬约束（必须遵守）】', params.clippedMaterials.canonHardFactsText);
  }
  if (params.clippedMaterials.continuationStateText) {
    parts.push('【当前续写状态】', params.clippedMaterials.continuationStateText);
  }
  if (params.clippedMaterials.recentContinuationText) {
    parts.push('【最近续写章节】', params.clippedMaterials.recentContinuationText);
  }
  if (params.clippedMaterials.storyMemoryText) {
    parts.push('【故事记忆摘要】', params.clippedMaterials.storyMemoryText);
  }
  parts.push('【输出协议（严格遵守）】', OUTPUT_PROTOCOL);
  return [{ role: 'user', content: parts.join('\n\n') }];
}

export function compileContinuationBatchPlannerRequest(
  input: CompileContinuationBatchPlannerInput,
): StageCompileResult {
  const mandatoryModules = [
    {
      id: 'user_goal',
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
    {
      id: 'boundary_seam',
      text: input.materials.sourceBoundaryText,
      requirement: 'mandatory' as const,
      priority: 9,
      relevance: 1,
    },
    {
      id: 'canon_hard_facts',
      text: input.materials.canonHardFactsText,
      requirement: 'mandatory' as const,
      priority: 9,
      relevance: 1,
    },
  ];
  const elasticModules = [
    {
      id: 'continuation_state',
      text: input.materials.continuationStateText,
      requirement: 'preferred' as const,
      priority: 6,
      relevance: 0.8,
    },
    {
      id: 'recent_continuation',
      text: input.materials.recentContinuationText,
      requirement: 'preferred' as const,
      priority: 6,
      relevance: 0.8,
    },
    {
      id: 'story_memory',
      text: input.materials.storyMemoryText,
      requirement: 'optional' as const,
      priority: 4,
      relevance: 0.6,
    },
  ];

  return compileStageRequestWithElasticBudget({
    stage: 'draft',
    contextWindow: input.contextWindow,
    reservedOutputTokens: input.reservedOutputTokens,
    mandatoryModules,
    elasticModules,
    buildMessages: clipped => {
      const clippedMaterials: ContinuationBatchPlannerMaterials = {
        sourceBoundaryText: clipped.get('boundary_seam') || '',
        canonHardFactsText: clipped.get('canon_hard_facts') || '',
        continuationStateText: clipped.get('continuation_state') || '',
        recentContinuationText: clipped.get('recent_continuation') || '',
        storyMemoryText: clipped.get('story_memory') || '',
      };
      return buildContinuationPlannerMessages({
        sourcePrompt: clipped.get('user_goal') || input.sourcePrompt,
        chapterCount: input.chapterCount,
        targetWordsPerChapter: input.targetWordsPerChapter,
        clippedMaterials,
      });
    },
  });
}

export type { LLMRequestConfig };

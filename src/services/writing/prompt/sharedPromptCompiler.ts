/**
 * THE one production writer prompt compiler.
 *
 * Scenario differences arrive only as frozen requirements / output contracts.
 * Post-Freeze stages must not call Outline or Continuation compilers.
 */
import type { ChatMessage } from '../../llm/types';
import type { FrozenWritingContext } from '../contracts/frozenWritingContext';
import type {
  SharedWritingStageName,
  WritingOutputContract,
  WritingStagePolicy,
} from '../contracts/writingPolicy';
import type { WritingRequirements } from '../contracts/writingRequirement';
import type { WritingStageArtifacts } from '../contracts/writingStage';
import {
  instructionBlock,
  previousArtifactBlock,
  projectRequirementsForStage,
} from './requirementProjection';

export interface SharedPromptCompileInput {
  stage: SharedWritingStageName;
  frozenContext: FrozenWritingContext;
  artifacts: WritingStageArtifacts;
  requirements: WritingRequirements;
  stagePolicy: WritingStagePolicy;
}

export interface SharedPromptCompileResult {
  messages: ChatMessage[];
  maxTokens: number;
  responseFormat: 'json_object' | 'text';
  outputContract: WritingOutputContract;
}

const STAGE_PROTOCOL: Record<SharedWritingStageName, string> = {
  draft: [
    '你是初稿作者，也是唯一的 Shared Draft Writer。',
    '请写从章节开头到自然结尾的完整正文。',
    '主要行动、阻力、选择、反应和后果必须真正发生。',
    '不要输出分析过程，不要只写提纲或补丁。',
  ].join('\n'),
  review: [
    '你是小说终审前的审阅编辑，也是唯一的 Shared Reviewer。',
    '当前阶段：Review。当前统一流水线的 Review。',
    'V3.2 的文学评估器在此作为同一 Review 协议的要求投影。',
    '请审阅初稿是否完成指令、大纲/结构、文风和义务。',
    '指出必须修改的问题，并给出可执行的改写目标。',
  ].join('\n'),
  audit: [
    '你是唯一的 Shared Auditor。',
    '请对照 Canon、边界、接缝、人物状态和义务，检查当前正文。',
    '只报告有证据的问题；为后续修订提供可定位的纠正项。',
  ].join('\n'),
  factCheck: [
    '你是唯一的 Shared Fact Checker。',
    '当前阶段：FactCheck。当前统一流水线的 FactCheck。',
    'V3.2 的事实核查器在此作为同一 FactCheck 协议的要求投影。',
    '请输出可定位、可执行的修正合同。',
    '请核查正文中的设定、人物、时间线和已确立事实，列出冲突与遗漏。',
  ].join('\n'),
  revision: [
    '你是唯一的 Shared Revision Writer。',
    '当前统一流水线的 Brief Compiler / V3.2 Brief Compiler 在此降级为修订规划要求。',
    '请根据审阅、审计和事实核查，重写完整章节，而不是打补丁。',
    '必须保留已成立的事件、人物选择、因果和情绪落点。',
  ].join('\n'),
  proof: [
    '你是终稿修订员，也是终审校对员和小说终稿编辑。',
    '你是唯一的 Shared Proof / Final Reviser。',
    '请在不改变已成立事实的前提下完成终稿润色。',
    '若某项要求已满足且无需改写，必须给出合法 no-op 理由。',
  ].join('\n'),
  finalValidate: '本地终检不向模型请求正文。',
  persist: '持久化不向模型请求正文。',
};

const JSON_CONTRACT =
  '【输出契约】只输出 JSON object，schemaVersion=1。必须包含 content（完整章节正文或完整结构化报告）。可选 plan、findings、appliedObligationIds、appliedCanonRequirementIds、appliedStyleRequirementIds、validNoOpRequirementIds、validNoOpReasons。禁止输出 Markdown 围栏。';

const STRUCTURED_REPORT_CONTRACT = [
  '【输出契约】只输出一个 JSON object，schemaVersion=1，禁止 Markdown 围栏、正文复述和解释文字。',
  '必须包含 content（本次核查的简短报告摘要）、verdict（pass 或 needs_revision）和 findings（数组；没有问题时必须输出 []）。',
  '每条 finding 应尽量包含 target、issue、instruction；只能报告当前正文中有证据、可定位、可执行的问题。',
  '可按当前检查重点补充 issues、errors、warnings、confirmed、checked、strengths 或 suggestions，但不能省略 findings。',
].join('\n');

const PROSE_CONTRACT =
  '【输出契约】直接输出本章完整正文。不要输出标题、分析、JSON 或过程说明。';

export function compileSharedWritingPrompt(
  input: SharedPromptCompileInput,
): SharedPromptCompileResult {
  const outputContract = isStructuredReportStage(input.stage)
    ? 'json_envelope'
    : input.stagePolicy.outputContract ||
      (input.stagePolicy.reviewMode === 'continuation-v5'
        ? 'json_envelope'
        : 'prose');

  const requirementText = projectRequirementsForStage({
    stage: input.stage,
    requirements: input.requirements,
    frozenContext: input.frozenContext,
  });
  const previous = previousArtifactBlock(input.artifacts);
  const rendered = input.frozenContext.rendered?.text || '';
  const contract = isStructuredReportStage(input.stage)
    ? STRUCTURED_REPORT_CONTRACT
    : outputContract === 'json_envelope'
    ? JSON_CONTRACT
    : PROSE_CONTRACT;
  const user = [
    instructionBlock(input.frozenContext),
    rendered ? `【冻结上下文】\n${rendered}` : '',
    requirementText,
    previous,
    contract,
  ]
    .filter(Boolean)
    .join('\n\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: STAGE_PROTOCOL[input.stage] },
    { role: 'user', content: user },
  ];
  return {
    messages,
    maxTokens: resolveMaxTokens(input.frozenContext, input.stage),
    responseFormat: outputContract === 'json_envelope' ? 'json_object' : 'text',
    outputContract,
  };
}

function isStructuredReportStage(stage: SharedWritingStageName): boolean {
  return stage === 'review' || stage === 'audit' || stage === 'factCheck';
}

function resolveMaxTokens(
  frozen: FrozenWritingContext,
  stage: SharedWritingStageName,
): number {
  const modelMax = Math.max(256, Number(frozen.model.maxOutputTokens) || 1024);
  if (stage === 'review' || stage === 'audit' || stage === 'factCheck') {
    return Math.min(modelMax, Math.max(768, Math.floor(modelMax * 0.45)));
  }
  return modelMax;
}

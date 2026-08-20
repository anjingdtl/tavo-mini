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
import { projectFrozenContextForStage } from '../context/stageContextProjection';
import { isOneShotStagePolicy } from '../contracts/executionProfile';

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
  qa: [
    // Phase 4 (二 §7.2 ONE QA. The single QA stage for the compact Standard
    // pipeline. Replaces Review/Audit/FactCheck with one unified check whose
    // scenario-specific focus is delivered ONLY through frozen requirements
    // (Outline obligations vs Continuation Canon/Boundary/Seam/Anchor).
    '你是唯一的 Shared QA Editor。',
    '当前阶段：QA。这是新 Compact Standard 的唯一检查阶段，',
    '    统一承担原文 Review + Audit + FactCheck 的职责（不再有第二套检查器）。',
    '请基于冻结上下文与已冻结需求，按当前场景（Outline vs Continuation）',
    '    一次给出 verdict 与可定位、可执行的问题清单。',
    '只报告当前正文中确凿、可定位的问题，禁止“总体不错 / 略显平淡 / 可以更生动”等无据建议。',
    'Phase 5：输出必须紧凑。verdict 只能是 pass 或 needs_revision；findings 必须是数组。',
    '    verdict=pass 时 findings 必须为 []；verdict=needs_revision 时 findings 至少一条；',
    '    禁止默认输出 strengths、长篇摘要、文学点评、正文复述、大段 suggestions 或思维过程。',
    '    每条 finding 必须有非空 issue，severity 仅用 blocking / warning，且有 target 或 requirementIds 定位，以及 instruction 或 target 执行；不得用自然语言猜测补字段。',
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
    '你是唯一的 Shared Revision Writer，也是当前统一流水线的 Brief Compiler。',
    '请输出修订合同，不要从零重写整章，不要另起一篇。',
    '必须基于已有初稿和审阅/审计/事实核查，做受控修订。',
    '已成立的事件、人物选择、因果和情绪落点必须保留。',
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

const REVISION_BRIEF_CONTRACT = [
  '【输出契约】只输出一个 JSON object，schemaVersion=1，这是修订合同而不是从零重写。',
  '必须包含 strategy、actions（数组）、preserve（数组）、ending。',
  'actions 每项尽量包含 covers 与 instruction；没有必须修改的问题时 actions 必须是 []。',
  'content 仅在必须改写时输出受控修订后的完整正文；若无需改写，可省略 content 或复用初稿，并在 validNoOpReasons 说明。',
  '禁止输出 Markdown 围栏，禁止把推理过程写进 content。',
].join('\n');

const STRUCTURED_REPORT_CONTRACT = [
  '【输出契约】只输出一个 JSON object，schemaVersion=1，禁止 Markdown 围栏、正文复述和解释文字。',
  '必须包含 content（本次核查的简短报告摘要）、verdict（pass 或 needs_revision）和 findings（数组；没有问题时必须输出 []）。',
  '每条 finding 应尽量包含 target、issue、instruction；只能报告当前正文中有证据、可定位、可执行的问题。',
  '可按当前检查重点补充 issues、errors、warnings、confirmed、checked、strengths 或 suggestions，但不能省略 findings。',
].join('\n');

const QA_STRUCTURED_REPORT_CONTRACT = [
  '【Compact QA 输出契约】只输出一个 JSON object，禁止 Markdown 围栏、正文复述和解释文字。',
  '必须包含 verdict（只能是 pass 或 needs_revision）和 findings（必须是数组）。content 如输出只能是一句简短摘要。',
  'verdict=pass 时 findings 必须为 []；verdict=needs_revision 时 findings 至少有一条。',
  '每条 finding 必须包含非空 issue、severity（只能是 blocking 或 warning），并且 target 或 requirementIds 至少有一个可定位值，以及 instruction 或 target 至少有一个可执行值。',
  '不得从普通 content、自然语言或正则猜测、自动补造 severity、target、requirementIds 或 instruction；无法完整表达时必须使用 pass 与 findings=[]。',
].join('\n');

const PROSE_CONTRACT =
  '【输出契约】直接输出本章完整正文。不要输出标题、分析、JSON 或过程说明。';

/**
 * One-Shot (极速) profile projection for the Shared Draft. This is a policy
 * projection inside the ONE shared prompt — not a second compiler. It only
 * instructs the model about its execution responsibilities; it never adds,
 * removes, or truncates frozen context.
 */
const ONE_SHOT_DRAFT_PROJECTION = [
  '【执行模式：极速 / One-Shot】',
  '本次是本章唯一一次模型生成。',
  '生成结果不会再经过 AI Review、FactCheck、Revision 或 Proof。',
  '请直接输出可保存的完整章节正文。',
  '必须尽最大可能同时满足：用户指令、当前章节大纲/剧情任务、已冻结 Canon / Boundary / Seam / Anchor、人物与世界设定、Story Memory、Writer Style、前文连续性、目标篇幅与自然结尾。',
].join('\n');

export function compileSharedWritingPrompt(
  input: SharedPromptCompileInput,
): SharedPromptCompileResult {
  const outputContract = isStructuredReportStage(input.stage)
    ? 'json_envelope'
    : input.stage === 'revision'
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
  const previous = previousArtifactBlock(input.artifacts, input.stage);
  const projected = projectFrozenContextForStage({
    frozenContext: input.frozenContext,
    stage: input.stage,
  });
  const rendered = projected.text;
  const contract =
    input.stage === 'revision'
      ? REVISION_BRIEF_CONTRACT
      : input.stage === 'qa'
      ? QA_STRUCTURED_REPORT_CONTRACT
      : isStructuredReportStage(input.stage)
      ? STRUCTURED_REPORT_CONTRACT
      : outputContract === 'json_envelope'
      ? JSON_CONTRACT
      : PROSE_CONTRACT;
  const user = [
    instructionBlock(input.frozenContext),
    rendered ? `【冻结上下文】\n${rendered}` : '',
    requirementText,
    input.stage === 'draft' && isOneShotStagePolicy(input.stagePolicy)
      ? ONE_SHOT_DRAFT_PROJECTION
      : '',
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
  // Phase 4 §7.2: ONE QA = single structured-report stage. qa inherits the
  // structured-report contract (json_envelope + verdict + findings).
  return (
    stage === 'qa' ||
    stage === 'review' ||
    stage === 'audit' ||
    stage === 'factCheck'
  );
}

function resolveMaxTokens(
  frozen: FrozenWritingContext,
  stage: SharedWritingStageName,
): number {
  const modelMax = Math.max(256, Number(frozen.model.maxOutputTokens) || 1024);
  if (
    stage === 'qa' ||
    stage === 'review' ||
    stage === 'audit' ||
    stage === 'factCheck'
  ) {
    return Math.min(modelMax, Math.max(768, Math.floor(modelMax * 0.45)));
  }
  if (stage === 'revision') {
    return Math.min(modelMax, 8192);
  }
  return modelMax;
}

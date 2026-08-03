import type { ChatMessage } from '../../llm/types';
import { estimateTokens } from '../../../utils/tokenEstimator';
import { resolveContinuationLengthContract } from './continuationLengthContract';
import type {
  ContinuationCheckResult,
  ContinuationControlReport,
  ContinuationPlan,
  ContinuationV4Metrics,
  FrozenContinuationCheckerContextView,
  FrozenContinuationControlContextView,
  FrozenContinuationRepairContextView,
  FrozenContinuationWriterContextView,
} from './types';

function json(value: unknown): string {
  return JSON.stringify(value);
}

function writerLengthContract(view: {
  targetChapterChars: number;
}): string {
  const contract = resolveContinuationLengthContract(view.targetChapterChars);
  return [
    `目标汉字数：${contract.targetHanCharacters}；合法范围：${contract.minHanCharacters}–${contract.maxHanCharacters}。`,
    '汉字数由客户端本地统计，不能以模型自报数值覆盖。不得用摘要、提纲、重复句或无意义水文填充长度。',
  ].join('\n');
}

function refsBlock(view: {
  snapshotRefs: {
    canonSnapshotId: string;
    canonRevision: number;
    inputRevisionHash: string;
    styleProfileHash: string | null;
  };
}): string {
  return `【冻结引用】Canon=${view.snapshotRefs.canonSnapshotId}@${view.snapshotRefs.canonRevision}；inputRevisionHash=${view.snapshotRefs.inputRevisionHash}；styleProfileHash=${view.snapshotRefs.styleProfileHash ?? 'none'}`;
}

function lockedBlock(lockedRules: string[]): string {
  return `【用户锁定规则】\n${lockedRules.length ? lockedRules.join('\n') : '（无）'}`;
}

function styleBlock(view: {
  style: {
    text: string;
    omittedReason: string | null;
    quantitative: Record<string, unknown>;
  };
}): string {
  if (view.style.text) return `【冻结原著风格】\n${view.style.text}`;
  return `【冻结原著风格量化摘要】\n${json(view.style.quantitative)}${
    view.style.omittedReason ? `\n未注入原因：${view.style.omittedReason}` : ''
  }`;
}

function supplementBlock(view: {
  supplements: { text: string; contentHashes: string[] };
}): string {
  if (!view.supplements.text) return '【冻结外部补充资料】（无）';
  return `【冻结外部补充资料 hashes=${view.supplements.contentHashes.join(',') || 'none'}】\n${view.supplements.text}`;
}

function canonGuardBlock(view: {
  canon: {
    hardFacts: Array<{ ownerType: string; ownerId: number; text: string; evidenceIds: number[] }>;
    softFacts: Array<{ ownerType: string; ownerId: number; text: string; evidenceIds: number[] }>;
  };
}): string {
  const render = (fact: (typeof view.canon.hardFacts)[number]) =>
    `- [${fact.ownerType}#${fact.ownerId}] ${fact.text}（evidence:${fact.evidenceIds.join(',') || 'none'}）`;
  return [
    '【冻结 Canon 审查依据】',
    `hard:\n${view.canon.hardFacts.map(render).join('\n') || '（无）'}`,
    `soft:\n${view.canon.softFacts.map(render).join('\n') || '（无）'}`,
  ].join('\n');
}

function stateBlock(view: {
  effectiveState: {
    characterStates: unknown[];
    relationships: unknown[];
    plotThreads: unknown[];
    knowledge: unknown[];
    experiences: unknown[];
  };
}): string {
  return `【冻结续写状态】\n${json(view.effectiveState)}`;
}

function planBlock(plan: ContinuationPlan): string {
  return `【Writer plan】\n${json({
    chapterGoal: plan.chapterGoal,
    centralConflict: plan.centralConflict,
    beats: plan.beats.map((beat, index) => ({
      id: `beat_${beat.order || index + 1}`,
      summary: beat.summary,
    })),
  })}`;
}

function outputBudgetBlock(view: {
  budget: { minimumOutputTokens: number; maximumOutputTokens: number };
}): string {
  return `【本次冻结输出预算】minimumOutputTokens=${view.budget.minimumOutputTokens}；maximumOutputTokens=${view.budget.maximumOutputTokens}；若预算不可用，请在请求前阻断，不得截断正文或偷偷重试。`;
}

export function compileContinuationV4WriterMessages(
  view: FrozenContinuationWriterContextView,
): ChatMessage[] {
  const anchor = view.primaryAnchor;
  const anchorText = anchor
    ? `${anchor.summary}\n${anchor.excerpt}`
    : '（无可用接缝）';
  const canon = view.canon;
  return [
    {
      role: 'system',
      content: [
        '你是原著续写 V4 Writer。只输出一个 JSON object，不要 Markdown、代码围栏、解释、思考过程或标题。',
        '顶层必须严格为 {"schemaVersion":1,"plan":{"chapterGoal":"","centralConflict":"","beats":[{"id":"","summary":""}]},"content":""}。content 必须是完整初稿正文。',
        writerLengthContract(view),
        lockedBlock(view.lockedRules),
        `【用户本章要求】\n${view.userInstruction}`,
        `【冻结 Canon】\n${json(canon)}`,
        stateBlock(view),
        `【Primary Anchor】\n${anchorText}`,
        `【Recent Bridge】\n${json(view.recentChapters)}`,
        `【Story Memory】\n${view.storyMemory.summary || '（无）'}`,
        `【Episodic Memory】\n${json(view.episodic)}`,
        styleBlock(view),
        supplementBlock(view),
        refsBlock(view),
        outputBudgetBlock(view),
      ].join('\n\n'),
    },
    {
      role: 'user',
      content: `生成完整初稿。不得输出任何 JSON 外壳之外的文字；正文不能是摘要或提纲。\n\n${view.userInstruction}`,
    },
  ];
}

export function compileContinuationV4CheckerMessages(input: {
  view: FrozenContinuationCheckerContextView;
  artifactText: string;
  writerArtifactHash: string;
  plan?: ContinuationPlan;
}): ChatMessage[] {
  const { view } = input;
  return [
    {
      role: 'system',
      content: [
        '你是原著续写 V4 Checker。只输出 JSON，不要 Markdown、解释、思考过程或复述正文。',
        '顶层必须为 {"schemaVersion":1,"writerArtifactHash":"","issues":[],"warnings":[]}。issue 必须包含 issueId、category、severity、confidence、draftQuote、description、evidenceIds、suggestedAction。',
        '只报告有冻结 Canon、状态、知识边界、关系或用户硬规则依据的语义问题；不要报告 chapter_length、source_overlap、future_leakage 或本地重复问题。没有证据只能是 warning。',
        lockedBlock(view.lockedRules),
        canonGuardBlock(view),
        stateBlock(view),
        `【接缝审查摘要】\n${view.seam.summary}\n${view.seam.excerpt}`,
        styleBlock(view),
        supplementBlock(view),
        refsBlock(view),
        outputBudgetBlock(view),
        input.plan ? planBlock(input.plan) : '',
      ].filter(Boolean).join('\n\n'),
    },
    {
      role: 'user',
      content: `writerArtifactHash=${input.writerArtifactHash}\n【完整 Writer 正文】\n${input.artifactText}\n【正文结束】`,
    },
  ];
}

export function compileContinuationV4ControlMessages(input: {
  view: FrozenContinuationControlContextView;
  artifactText: string;
  metrics: ContinuationV4Metrics;
  plan?: ContinuationPlan;
}): ChatMessage[] {
  const { view, metrics } = input;
  return [
    {
      role: 'system',
      content: [
        '你是原著续写 V4 Control。只输出 JSON，不写小说正文，不输出思考过程。',
        '只负责篇幅与结构编辑建议，不负责 Canon 事实判断。所有汉字数、合法区间、段落位置和重复指标以客户端本地指标为真值。',
        '顶层必须为 {"schemaVersion":1,"action":"keep|expand|compress","currentHan":0,"targetHan":0,"allowedMinHan":0,"allowedMaxHan":0,"suggestions":[],"preserve":[]}。',
        `【本地确定性指标】\n${json(metrics)}`,
        `【量化原著风格】\n${json(view.style.quantitative)}`,
        `【用户本章目标】\n${view.userInstruction}`,
        lockedBlock(view.lockedRuleSummary),
        refsBlock(view),
        outputBudgetBlock(view),
        input.plan ? planBlock(input.plan) : '',
      ].filter(Boolean).join('\n\n'),
    },
    {
      role: 'user',
      content: `请根据本地指标给出最小可执行的增删建议。当前正文：\n${input.artifactText}`,
    },
  ];
}

function renderCheck(check: ContinuationCheckResult): string {
  return JSON.stringify({
    issueId: String(check.id),
    category: check.category,
    severity: check.severity,
    excerpt: check.generatedExcerpt,
    description: check.description,
    evidenceIds: check.evidenceIds,
    suggestedFix: check.suggestedFix,
  });
}

export function compileContinuationV4RepairMessages(input: {
  view: FrozenContinuationRepairContextView;
  artifactText: string;
  plan: ContinuationPlan;
  checkerReport?: { issues: ContinuationCheckResult[] } | null;
  controlReport: ContinuationControlReport;
}): ChatMessage[] {
  const { view } = input;
  const contract = resolveContinuationLengthContract(view.targetChapterChars);
  const checks = input.checkerReport?.issues ?? [];
  return [
    {
      role: 'system',
      content: [
        '你是原著续写 V4 Repair。输出完整终稿 envelope，不输出局部修订、不输出偏移、不输出补丁、不输出摘要、解释、Markdown 或思考过程。',
        '顶层必须为 {"schemaVersion":1,"content":"完整终稿","appliedCheckerIssueIds":[],"appliedControlSuggestionIds":[],"unappliedItems":[]}。content 必须覆盖完整原稿的有效事件链、人物互动、情绪转折和自然章末。',
        `完整终稿汉字数必须在 ${contract.minHanCharacters}–${contract.maxHanCharacters} 范围内；本地 Final Gate 会重新计数。`,
        '修订优先级：用户锁定规则 / Canon hard facts / 已确认状态 > Checker 有证据的 error > Control 硬长度区间 > 章节目标与 Writer plan > 原著风格 > 外部补充。',
        lockedBlock(view.lockedRules),
        canonGuardBlock(view),
        stateBlock(view),
        `【Primary Anchor 防重复摘要】\n${view.primaryAnchorSummary}`,
        `【Recent Bridge 防重复摘要】\n${view.recentBridgeSummary || '（无）'}`,
        styleBlock(view),
        supplementBlock(view),
        `【Checker 报告】\n${checks.map(renderCheck).join('\n') || '（无可操作语义问题）'}`,
        `【Control 报告】\n${json(input.controlReport)}`,
        planBlock(input.plan),
        refsBlock(view),
        outputBudgetBlock(view),
      ].join('\n\n'),
    },
    {
      role: 'user',
      content: [
        '【完整 Writer 初稿开始】',
        input.artifactText,
        '【完整 Writer 初稿结束】',
        '现在只输出完整终稿 JSON envelope。',
      ].join('\n\n'),
    },
  ];
}

export function continuationV4ProtocolSkeletonTokens(stage: 'writer' | 'checker' | 'control' | 'repair'): number {
  const skeletons = {
    writer: {
      schemaVersion: 1,
      plan: { chapterGoal: '', centralConflict: '', beats: [] },
      content: '',
    },
    checker: { schemaVersion: 1, writerArtifactHash: '', issues: [], warnings: [] },
    control: {
      schemaVersion: 1,
      action: 'keep',
      currentHan: 0,
      targetHan: 0,
      allowedMinHan: 0,
      allowedMaxHan: 0,
      suggestions: [],
      preserve: [],
    },
    repair: {
      schemaVersion: 1,
      content: '',
      appliedCheckerIssueIds: [],
      appliedControlSuggestionIds: [],
      unappliedItems: [],
    },
  } as const;
  return estimateTokens(JSON.stringify(skeletons[stage]));
}

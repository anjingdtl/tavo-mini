import type { ChatMessage } from '../../llm/types';
import { estimateTokens } from '../../../utils/tokenEstimator';
import { resolveContinuationLengthContract } from './continuationLengthContract';
import { requiredControlProgressHan } from './continuationControl';
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
    `【Writer 本次汉字产出硬目标】目标：${contract.targetHanCharacters}；最低合格线：${contract.minHanCharacters}；合法范围：${contract.minHanCharacters}–${contract.maxHanCharacters}。`,
    `content 必须写到约 ${contract.targetHanCharacters} 个中文汉字，而不是约 ${contract.targetHanCharacters} 个 token；在 content 未达到最低合格线 ${contract.minHanCharacters} 前不得结束章节。必须先把完整事件链、人物互动、情绪转折和自然章末展开到目标区间，再收束正文。`,
    '如果故事已经接近章末但本地目标仍未满足，继续展开当前冲突的动作后果、人物反应、环境细节和章末钩子，不得突然收尾。不得用摘要、提纲、重复句或无意义水文填充长度。',
    '汉字数由客户端本地统计，不能以模型自报数值覆盖。content 只能放可直接作为章节正文的完整纯文本，不能只返回短梗概、片段或待补写提纲。',
  ].join('\n');
}

function writerLengthTailReminder(view: {
  targetChapterChars: number;
}): string {
  const contract = resolveContinuationLengthContract(view.targetChapterChars);
  return [
    '【Writer 输出前最后检查】',
    `content 的客户端本地 Han 计数目标为 ${contract.targetHanCharacters}，必须落在 ${contract.minHanCharacters}–${contract.maxHanCharacters}；低于 ${contract.minHanCharacters} 不得结束。`,
    '确认顶层 schemaVersion 是数字 1；优先按 system 规定的嵌套 plan（chapterGoal、centralConflict、beats）和 content 字段输出；content 必须是完整章节正文，不是摘要、提纲、片段或短结尾；确认达到动态最低汉字线后再输出 JSON。',
    '只输出一个顶层 JSON object，不要把 plan 或 content 提升到顶层，也不要在正文之外输出解释。若无法可靠补全 plan，至少保留完整正文；客户端会补齐最小 plan，但不会接受空正文。',
  ].join('\n');
}

function repairLengthDirective(report: ContinuationControlReport): string {
  const deficit = Math.max(0, report.allowedMinHan - report.currentHan);
  if (deficit > 0) {
    return [
      '【Repair 本地扩写硬指令】',
      `Control 已由客户端本地计数：当前 ${report.currentHan} 个汉字，目标 ${report.targetHan} 个，最低合格线 ${report.allowedMinHan} 个；至少还缺 ${deficit} 个汉字。`,
      '当前 Writer 正文不合格，Repair 必须真正扩写完整终稿，不能原样返回、只润色几句、只追加摘要或把缺口交给用户。扩写必须服务于当前事件链、人物互动和章末钩子，并在本地最低线以上再结束。',
    ].join('\n');
  }
  if (report.currentHan > report.allowedMaxHan) {
    return [
      '【Repair 本地收束硬指令】',
      `Control 已由客户端本地计数：当前 ${report.currentHan} 个汉字，合法上限 ${report.allowedMaxHan} 个。`,
      'Repair 必须在保留完整事件链和章末钩子的前提下收束完整终稿，不能仅返回裁剪说明或局部修改。',
    ].join('\n');
  }
  return `【Repair 本地长度确认】Control 已由客户端本地计数：当前 ${report.currentHan} 个汉字，处于 ${report.allowedMinHan}–${report.allowedMaxHan} 合法区间；仍必须输出完整终稿。`;
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
        writerLengthContract(view),
        '顶层必须严格为 {"schemaVersion":1,"plan":{"chapterGoal":"","centralConflict":"","beats":[{"id":"","summary":""}]},"content":""}。content 必须是完整初稿正文。',
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
      content: [
        '生成完整初稿。不得输出任何 JSON 外壳之外的文字；正文不能是摘要或提纲。',
        view.userInstruction,
        writerLengthTailReminder(view),
      ].join('\n\n'),
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
        '顶层必须为 {"schemaVersion":1,"writerArtifactHash":"","issues":[],"warnings":[]}。writerArtifactHash 必须原样回显客户端给出的值。issue 必须包含 issueId、category、subtype、severity、confidence、generatedStart、generatedEnd、generatedExcerpt、description、evidenceIds、suggestedFix。',
        '旧字段 draftQuote/draftStart/draftEnd/suggestedAction 仍会被兼容，但请优先使用 generatedExcerpt/generatedStart/generatedEnd/suggestedFix 标准字段。',
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
    subtype: check.subtype,
    severity: check.severity,
    generatedStart: check.generatedStart,
    generatedEnd: check.generatedEnd,
    generatedExcerpt: check.generatedExcerpt,
    description: check.description,
    evidenceIds: check.evidenceIds,
    suggestedFix: check.suggestedFix,
  });
}

/** Build the Repair-side explanation of Control's minimum substantial progress
 * requirement. Uses the centralized helper so the prompt and the local
 * compliance check share one definition of "progress". */
function controlProgressDirective(report: ContinuationControlReport): string {
  const forced = report.suggestions.filter(s =>
    s.suggestionId === 'ctrl_local_expand' ||
    s.suggestionId === 'ctrl_local_compress',
  );
  if (report.action === 'keep' && forced.length === 0) {
    return '【Control 最低实质进度】Control action=keep，无强制扩写或收束要求；终稿仍须落实 Checker 强制任务并真正改变原稿。';
  }
  const requiredDeltaHan =
    report.action === 'expand'
      ? Math.max(0, report.allowedMinHan - report.currentHan)
      : report.action === 'compress'
        ? Math.max(0, report.currentHan - report.allowedMaxHan)
        : 0;
  const requiredProgress = requiredControlProgressHan(requiredDeltaHan);
  const direction =
    report.action === 'expand' ? '扩写' : report.action === 'compress' ? '收束' : '保持';
  return [
    '【Control 最低实质进度】',
    `Control action=${report.action}。终稿必须朝${direction}方向产生实质性变化：只改标点、空白或少量字符、只回填 ID 不算完成。`,
    `当前汉字 ${report.currentHan}，合法区间 ${report.allowedMinHan}–${report.allowedMaxHan}。`,
    report.action === 'expand'
      ? `若终稿未达到 ${report.allowedMinHan}，则至少需要净增加 ${requiredProgress} 个汉字（最低实质进度），否则会被拒绝。`
      : report.action === 'compress'
        ? `若终稿未低于 ${report.allowedMaxHan}，则至少需要净减少 ${requiredProgress} 个汉字（最低实质进度），否则会被拒绝。`
        : '终稿仍须落实 Checker 强制任务并真正改变原稿。',
    '最终篇幅未完全进入合法区间时，本地 Final Gate 只记录 warning，不直接拒绝；但没有达到最低实质进度一定会被拒绝。',
  ].join('\n');
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
  const forcedCheckerCount = checks.filter(
    issue => issue.severity === 'error' || issue.severity === 'blocking',
  ).length;
  const forcedControlCount = input.controlReport.suggestions.length;
  return [
    {
      role: 'system',
      content: [
        '你是原著续写 V4 Repair。输出完整终稿 envelope，不输出局部修订、不输出偏移、不输出补丁、不输出摘要、解释、Markdown 或思考过程。',
        '这是严格结构协议，不是建议：schemaVersion、content、appliedCheckerIssueIds、appliedControlSuggestionIds、unappliedItems 五个顶层字段一个都不能省略；三个数组即使为空也必须保留。',
        '唯一合格的顶层结构是 {"schemaVersion":1,"content":"完整终稿","appliedCheckerIssueIds":[],"appliedControlSuggestionIds":[],"unappliedItems":[]}。只允许使用 content 保存正文；finalText、final_content、text、draft、result 等别名均不合格。',
        'content 的值必须是完整、连续、可直接作为章节正文的纯文本，覆盖完整原稿的有效事件链、人物互动、情绪转折和自然章末；content 不能是 JSON、Markdown、说明文字或只包含新增段落。不得输出 patches、offset、replacement 等局部修改字段。',
        `完整终稿汉字数必须在 ${contract.minHanCharacters}–${contract.maxHanCharacters} 范围内；本地 Final Gate 会重新计数。`,
        '修订优先级：用户锁定规则 / Canon hard facts / 已确认状态 > Checker 有证据的 error > Control 硬长度区间 > 章节目标与 Writer plan > 原著风格 > 外部补充。',
        '【本次必须完成的审计任务】',
        `- 必须落实所有 severity=error/blocking 的 Checker / 本地安全 issue，并回填其 issueId（共 ${forcedCheckerCount} 项强制任务）。`,
        `- 必须落实所有 Control suggestion，并回填其 suggestionId（共 ${forcedControlCount} 项强制建议）。`,
        '- Control 要求 expand/compress 时，不能只做标点、措辞或少量字符变化；终稿必须达到客户端给出的最低实质进度。',
        '- 最终篇幅未完全进入合法区间时仍可能作为 warning 保留，但没有达到最低实质进度会被直接拒绝。',
        '对每个 Checker severity=error 或 blocking 的 issue，必须把报告中原样给出的 issueId 填入 appliedCheckerIssueIds；对 Control 报告中的每条 suggestion，必须把原样 suggestionId 填入 appliedControlSuggestionIds；合格终稿的 unappliedItems 必须为空。只填写 id 不代表完成修订，客户端还会检查终稿是否真正改变、问题原句是否仍完整保留、Control 方向和最低实质进度是否满足。',
        lockedBlock(view.lockedRules),
        canonGuardBlock(view),
        stateBlock(view),
        `【Primary Anchor 防重复摘要】\n${view.primaryAnchorSummary}`,
        `【Recent Bridge 防重复摘要】\n${view.recentBridgeSummary || '（无）'}`,
        styleBlock(view),
        supplementBlock(view),
        `【Checker / 本地安全审查报告】\n${checks.map(renderCheck).join('\n') || '（无可操作语义问题）'}`,
        `【Control 报告】\n${json(input.controlReport)}`,
        repairLengthDirective(input.controlReport),
        controlProgressDirective(input.controlReport),
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
        '现在只输出完整终稿 JSON envelope。输出前逐项检查五个顶层字段均存在，数组字段即使为空也存在；逐项落实 Checker/Control 要求，将 unappliedItems 保持为空，并将占位内容替换为完整终稿正文：',
        '{"schemaVersion":1,"content":"在此放完整终稿纯文本","appliedCheckerIssueIds":[],"appliedControlSuggestionIds":[],"unappliedItems":[]}',
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

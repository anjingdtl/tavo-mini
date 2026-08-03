import type { ChatMessage } from '../../llm/types';
import { estimateTokens } from '../../../utils/tokenEstimator';
import { resolveContinuationLengthContract } from './continuationLengthContract';
import { requiredControlProgressHan } from './continuationControl';
import { isRepairableCheckerIssue } from './continuationChecker';
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
      '【Repair 本地扩写建议】',
      `Control 已由客户端本地计数：当前 ${report.currentHan} 个汉字，目标 ${report.targetHan} 个，最低合格线 ${report.allowedMinHan} 个；至少还缺 ${deficit} 个汉字。`,
      '优先围绕当前事件链、人物互动和章末钩子自然扩写完整终稿，不能原样返回、只润色几句、只追加摘要或把缺口交给用户。目标区间是软门槛；若正文仍超过 1000 个汉字，长度不足只记录 warning，不单独拒绝。',
    ].join('\n');
  }
  if (report.currentHan > report.allowedMaxHan) {
    return [
      '【Repair 本地收束建议】',
      `Control 已由客户端本地计数：当前 ${report.currentHan} 个汉字，合法上限 ${report.allowedMaxHan} 个。`,
      '优先在保留完整事件链和章末钩子的前提下收束完整终稿，不能仅返回裁剪说明或局部修改；长度超出只记录 warning，不单独拒绝。',
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
        'issues 不是问题清单而是 Repair 修订单：每条 issue 必须能直接驱动一次具体改写。必须给出正文中的精确 generatedExcerpt（或准确 UTF-16 generatedStart/generatedEnd）、明确问题、以动作开头的 suggestedFix 和可核验 evidenceIds；不能只写“加强一致性”“注意铺垫”这类抽象建议。无法精确定位或没有具体改法的观察只能放入 warnings，不能伪装成可执行 issue。',
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
        '只负责篇幅与结构编辑建议，不负责 Canon 事实、人物关系或知识边界判断。所有汉字数、合法区间、段落位置和重复指标以客户端本地指标为真值。',
        '顶层必须为 {"schemaVersion":1,"action":"keep|expand|compress","currentHan":0,"targetHan":0,"allowedMinHan":0,"allowedMaxHan":0,"suggestions":[],"findings":[],"preserve":[]}。',
        'suggestions 是可直接执行的增删动作；findings 是需要 Repair 处理并回填 findingId 的结构诊断。只输出 info 或 warning，不输出新的 error/blocking 门槛。重点检查重复退化、段落长度失衡、Beat 覆盖缺口、对话/叙述比例与场景节奏漂移、结尾推进或章末钩子突兀等结构问题；不要把这些问题包装成 Canon 事实。每条 finding 必须包含 findingId、subtype、severity、location、generatedStart、generatedEnd、description、suggestedFix。',
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
      content: `请根据本地指标给出最小可执行的增删建议和结构 findings。当前正文：\n${input.artifactText}`,
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
    repairReady: isRepairableCheckerIssue(check),
    repairTask: isRepairableCheckerIssue(check)
      ? `改写上述 generatedExcerpt；${check.suggestedFix ?? ''}`
      : '仅作审计记录，不作为可执行 Repair 任务',
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
    return '【Control 修订方向】Control action=keep，无扩写或收束方向要求；终稿仍须落实 Checker 强制任务并真正改变原稿。';
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
    '【Control 修订方向】',
    `Control action=${report.action}。终稿必须朝${direction}方向产生实质性变化：只改标点、空白或少量字符、只回填 ID 不算完成。`,
    `当前汉字 ${report.currentHan}，合法区间 ${report.allowedMinHan}–${report.allowedMaxHan}。`,
    report.action === 'expand'
      ? `建议至少净增加 ${requiredProgress} 个汉字并朝 ${report.allowedMinHan} 靠近；未完全达到该进度只记录 warning，不单独拒绝。`
      : report.action === 'compress'
        ? `建议至少净减少 ${requiredProgress} 个汉字并朝 ${report.allowedMaxHan} 靠近；未完全达到该进度只记录 warning，不单独拒绝。`
        : '终稿仍须落实 Checker 强制任务并真正改变原稿。',
    '最终篇幅未完全进入合法区间或未达到建议进度时，本地 Final Gate 只记录 warning，不直接拒绝；只有正文坍缩到 1000 个汉字以内才硬拦截。',
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
  const repairableCheckerIssues = checks.filter(isRepairableCheckerIssue);
  const forcedControlCount = input.controlReport.suggestions.length;
  const controlFindings = input.controlReport.findings ?? [];
  return [
    {
      role: 'system',
      content: [
        '你是原著续写 V4 Repair。只根据 Writer 完整原文、Checker 报告和 Control 报告做一次专注的定向编辑；输出完整终稿 envelope，不输出局部修订、不输出偏移、不输出补丁、不输出摘要、解释、Markdown 或思考过程。',
        '这是严格结构协议，不是建议：schemaVersion、content、appliedCheckerIssueIds、appliedControlSuggestionIds、appliedControlFindingIds、unappliedItems 六个顶层字段一个都不能省略；四个数组即使为空也必须保留。',
        '唯一合格的顶层结构是 {"schemaVersion":1,"content":"完整终稿","appliedCheckerIssueIds":[],"appliedControlSuggestionIds":[],"appliedControlFindingIds":[],"unappliedItems":[]}。只允许使用 content 保存正文；finalText、final_content、text、draft、result 等别名均不合格。',
        'content 的值必须是完整、连续、可直接作为章节正文的纯文本，覆盖完整原稿的有效事件链、人物互动、情绪转折和自然章末；content 不能是 JSON、Markdown、说明文字或只包含新增段落。不得输出 patches、offset、replacement 等局部修改字段。',
        `本地客户端会重新计数：${contract.minHanCharacters}–${contract.maxHanCharacters} 是软性目标区间；正文超过 1000 个汉字时，长度不足或超出只记录 warning。正文坍缩到 1000 个汉字以内才属于硬安全拦截。`,
        '修订只依据 Writer 原文与下方 Checker / Control 报告，不要自行引入新的 Canon、状态、风格或外部资料事实；优先保留原文完整事件链，再直接落实报告中的可执行修订。',
        '【本次必须完成的审计任务】',
        `- 必须落实所有 severity=error/blocking 的 Checker / 本地安全 issue，并回填其 issueId（共 ${forcedCheckerCount} 项强制任务）。`,
        `- Checker 中另有 ${repairableCheckerIssues.length} 项 repairReady=true 的可执行修订单；无论其严重度是 warning 还是 error，都必须对对应原文产生真实改写，不能只回填 issueId。`,
        `- 必须落实所有 Control suggestion，并回填其 suggestionId（共 ${forcedControlCount} 项强制建议）。`,
        `- 必须处理 Control findings，并回填其 findingId（共 ${controlFindings.length} 项结构诊断；findings 未完全处理只记录 warning，不单独拒绝）。`,
        '- Control 要求 expand/compress 时，应直接按照报告修订原文并尽量朝目标方向优化；未完全达到长度或建议进度时只保留 warning，不单独拒绝。',
        '- 正文不得坍缩成 1000 个汉字以内；必须保留完整事件链、人物互动和章末推进。',
        '对每个 repairReady=true 的 Checker issue，必须把报告中原样的 issueId 填入 appliedCheckerIssueIds，并改写其 generatedExcerpt；repairReady=false 的 warning 仅作审计记录，不要声称已完成。对 Control 报告中的每条 suggestion，必须把原样 suggestionId 填入 appliedControlSuggestionIds；对每条 Control finding，若已处理则把原样 findingId 填入 appliedControlFindingIds；合格终稿的 unappliedItems 必须为空。只填写 id 不代表完成修订，客户端还会检查终稿是否真正改变、问题原句是否仍完整保留以及 Control 修订方向是否满足。',
        `【Checker 可执行修订单】\n${repairableCheckerIssues.map(renderCheck).join('\n') || '（无可定位的 Checker 修订单）'}`,
        `【Checker / 本地安全审查报告】\n${checks.map(renderCheck).join('\n') || '（无可操作语义问题）'}`,
        `【Control 报告】\n${json(input.controlReport)}`,
        repairLengthDirective(input.controlReport),
        controlProgressDirective(input.controlReport),
        outputBudgetBlock(view),
      ].join('\n\n'),
    },
    {
      role: 'user',
      content: [
        '【完整 Writer 初稿开始】',
        input.artifactText,
        '【完整 Writer 初稿结束】',
        `【Checker 可执行修订单】\n${repairableCheckerIssues.map(renderCheck).join('\n') || '（无可定位的 Checker 修订单）'}`,
        '现在只输出完整终稿 JSON envelope。只在 Writer 原文上落实 Checker/Control 报告的修订要求；输出前逐项检查六个顶层字段均存在，数组字段即使为空也存在，将 unappliedItems 保持为空，并将占位内容替换为完整终稿正文：',
        '{"schemaVersion":1,"content":"在此放完整终稿纯文本","appliedCheckerIssueIds":[],"appliedControlSuggestionIds":[],"appliedControlFindingIds":[],"unappliedItems":[]}',
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
      findings: [],
      preserve: [],
    },
    repair: {
      schemaVersion: 1,
      content: '',
      appliedCheckerIssueIds: [],
      appliedControlSuggestionIds: [],
      appliedControlFindingIds: [],
      unappliedItems: [],
    },
  } as const;
  return estimateTokens(JSON.stringify(skeletons[stage]));
}

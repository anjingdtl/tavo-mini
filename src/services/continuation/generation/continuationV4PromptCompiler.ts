import type { ChatMessage } from '../../llm/types';
import { estimateTokens } from '../../../utils/tokenEstimator';
import {
  countHanCharacters,
  isLengthExpansionIssue,
  resolveContinuationLengthContract,
} from './continuationLengthContract';
import {
  isStyleIssueRepairReady,
  STYLE_REPAIR_CONFIDENCE_MIN,
} from './continuationControl';
import { isRepairableCheckerIssue } from './continuationChecker';
import type {
  ContinuationCheckResult,
  ContinuationControlFinding,
  ContinuationControlReport,
  ContinuationPlan,
  ContinuationStyleIssue,
  ContinuationV4Metrics,
  FrozenContinuationCheckerContextView,
  FrozenContinuationControlContextView,
  FrozenContinuationRepairContextView,
  FrozenContinuationWriterContextView,
} from './types';

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Inline Repair anchors: visible span markers stripped client-side after parse. */
export const REPAIR_ISSUE_ANCHOR_START = (n: number) => `⟦ISSUE_${n}_START⟧`;
export const REPAIR_ISSUE_ANCHOR_END = (n: number) => `⟦ISSUE_${n}_END⟧`;
export const REPAIR_ANCHOR_MARKER_PATTERN = /⟦ISSUE_\d+_(?:START|END)⟧/g;

export interface RepairUnifiedTask {
  /** 1-based index used in anchor tags and the numbered task list. */
  issueIndex: number;
  kind: 'checker' | 'control' | 'length_expansion';
  id: string;
  description: string;
  suggestedFix: string;
  generatedStart: number | null;
  generatedEnd: number | null;
  generatedExcerpt: string;
  rewriteGoal?: string;
  preserveMeaning?: string[];
  mustPreserve?: string[];
}

/**
 * Soft length goal: ±30% band + beat budget + deepen-first guidance.
 * Not a hard "must reach min before ending" quota (creative loosening retained).
 */
function writerLengthSoftHint(view: { targetChapterChars: number }): string {
  const contract = resolveContinuationLengthContract(view.targetChapterChars);
  return [
    `【本章目标体量】约 ${contract.targetHanCharacters} 个汉字，正常落区间 ${contract.minHanCharacters}–${contract.maxHanCharacters}（±30%）。`,
    '低于下限通常意味着场景展开不足，而非情节已经讲完。',
    '规划时为每个 beat 在 summary 中标注预期篇幅量（合计约等于目标汉字数），写作时按预算展开每个节拍再推进到下一个。',
    '若正文明显低于下限，优先深化已有场景：动作的过程与后果、对话的回合与潜台词、人物的即时反应、关键情绪的铺陈、冲突的升级阶梯——而不是提前收束、新增支线或复述设定。',
    '不得为了接近参考字数：填充重复心理；堆叠环境描写；重复人物反应；扩展无新信息的对白；添加总结性解释。',
  ].join('\n');
}

function writerLengthTailReminder(view: {
  targetChapterChars: number;
}): string {
  const contract = resolveContinuationLengthContract(view.targetChapterChars);
  return [
    '【Writer 输出前最后检查】',
    `输出前自查：正文是否落在 ${contract.minHanCharacters}–${contract.maxHanCharacters} 区间；若低于 ${contract.minHanCharacters}，是哪个节拍被压缩了？回到该节拍深化，而不是加结尾感言。`,
    '确认顶层 schemaVersion 是数字 1；content 必须是从章节开头到自然结尾的完整章节正文，不是摘要、提纲、片段或短结尾。',
    '只输出一个顶层 JSON object；不要在正文之外输出解释。',
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
        writerLengthSoftHint(view),
        '顶层必须严格为 {"schemaVersion":1,"plan":{"chapterGoal":"","centralConflict":"","beats":[{"id":"","summary":""}]},"content":""}。content 必须是从章节开头到自然结尾的完整初稿正文。',
        '自然延续原著的叙述气质、人物语言和情绪表达倾向。风格画像用于帮助理解整体画风，不要求逐项机械复现。不要为了表现“像原著”而堆叠固定句式、意象或修辞。',
        '不要机械覆盖全部 Beat、不要强制对话比例或段落分布、不要输出前做八股结构检查表。情节完整、人物准确、原著风格优先。',
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
        '你是原著续写 V4 Checker，专门审查原著五维资料一致性。只输出 JSON，不要 Markdown、解释、思考过程或复述正文。',
        '审查范围仅限：1) 人物 2) 世界规则 3) 人物关系 4) 剧情线 5) 人物经历；以及用户锁定规则、续写边界、明确的时间/状态冲突与 future leakage。',
        '不负责：字数、文风、段落长短、对话比例、Beat 覆盖、章末钩子、“灵性”或整体节奏评价。',
        '顶层必须为 {"schemaVersion":2,"writerArtifactHash":"","issues":[],"warnings":[]}。writerArtifactHash 必须原样回显客户端给出的值。',
        'issue 必须包含 issueId、category（character|world|relationship|plot|experience|boundary|locked_rule 或既有 category）、severity、confidence、generatedStart、generatedEnd、generatedExcerpt、description、evidenceIds、suggestedFix。',
        '只有同时满足以下条件才可放入 issues 且 severity 为 error/blocking：与当前 Writer artifact hash 绑定；合法 UTF-16 范围或唯一可定位 excerpt；有 evidenceIds；明确问题描述；直接 suggestedFix。普通观察放入 warnings。',
        '不要报告 chapter_length、文风、段落/对话比例或本地重复问题。没有证据只能是 warning。',
        lockedBlock(view.lockedRules),
        canonGuardBlock(view),
        stateBlock(view),
        `【接缝审查摘要】\n${view.seam.summary}\n${view.seam.excerpt}`,
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
  writerArtifactHash?: string;
}): ChatMessage[] {
  const { view, metrics } = input;
  return [
    {
      role: 'system',
      content: [
        '你是原著续写 V4 Control，负责原著文风一致性审查。只输出 JSON，不写小说正文，不输出思考过程。',
        '不负责 expand/compress、字数差额、最低净增/净减、Beat 覆盖、段落比例或剧情事实判断。字数指标仅用于识别“凑字数痕迹”，不是修订目标。',
        '重点维度：narrative_voice、pov、sentence_rhythm、dialogue_voice、emotional_expression、description_density、subtext、scene_transition、ai_template、padding。',
        `顶层必须为 {"schemaVersion":2,"writerArtifactHash":"","styleProfileRevision":null,"issues":[],"warnings":[],"summary":{"reviewedDimensions":[],"actionableIssueCount":0,"auditWarningCount":0}}。writerArtifactHash 原样回显 ${input.writerArtifactHash ?? ''}。`,
        'issues 仅放可定位、有 styleEvidenceIds、有 rewriteGoal、有 preserveMeaning、confidence 足够高的局部文风偏离；severity=error 才可能进入 Repair。',
        `repairReady 由客户端判定（confidence≥${STYLE_REPAIR_CONFIDENCE_MIN}、可定位、有证据、rewriteGoal 明确、preserveMeaning 非空、不要求新增事实或重构整章）。`,
        '无法定位的“整体不像原著”“节奏平淡”等只能放入 warnings，不得伪装成可执行 issue。',
        '风格画像和代表片段用于判断整体倾向，不是逐项打勾的写作规范。不要因为正文没有同时体现所有风格特征就判错。不要要求补 Beat、增加冲突或改变剧情。不要根据参考字数要求扩写或压缩。',
        `【本地篇幅诊断（仅提示）】currentHan=${metrics.actualHanCharacters}；referenceTarget=${metrics.targetHanCharacters}；referenceRange=${metrics.minHanCharacters}–${metrics.maxHanCharacters}`,
        styleBlock(view),
        `【量化原著风格】\n${json(view.style.quantitative)}`,
        `【用户本章目标】\n${view.userInstruction}`,
        lockedBlock(view.lockedRuleSummary),
        refsBlock(view),
        outputBudgetBlock(view),
      ].filter(Boolean).join('\n\n'),
    },
    {
      role: 'user',
      content: `请审查正文相对原著文风的局部可修订偏离。当前正文：\n${input.artifactText}`,
    },
  ];
}

/** Prefer finding excerpt; else slice Writer by UTF-16 offsets. */
export function resolveStyleFindingExcerpt(
  finding: Pick<
    ContinuationControlFinding,
    'generatedStart' | 'generatedEnd' | 'generatedExcerpt'
  >,
  artifactText?: string,
): string {
  const own = (finding.generatedExcerpt ?? '').trim();
  if (own.length > 0) return own;
  if (
    artifactText &&
    finding.generatedStart != null &&
    finding.generatedEnd != null &&
    finding.generatedStart >= 0 &&
    finding.generatedEnd > finding.generatedStart &&
    finding.generatedEnd <= artifactText.length
  ) {
    return artifactText.slice(finding.generatedStart, finding.generatedEnd);
  }
  return '';
}

function renderCheck(check: ContinuationCheckResult): string {
  const repairReady = isRepairableCheckerIssue(check);
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
    repairReady,
    repairTask: repairReady
      ? `改写上述 generatedExcerpt；${check.suggestedFix ?? ''}`
      : '仅作审计记录，不作为可执行 Repair 任务',
  });
}

export function renderStyleFinding(
  finding: ContinuationControlFinding,
  artifactText?: string,
): string {
  const generatedExcerpt = resolveStyleFindingExcerpt(finding, artifactText);
  // No placeholder evidence — missing styleEvidenceIds means not repairReady.
  const styleEvidenceIds = finding.styleEvidenceIds ?? [];
  const rewriteGoal = finding.rewriteGoal ?? finding.suggestedFix ?? '';
  const preserveMeaning =
    finding.preserveMeaning && finding.preserveMeaning.length > 0
      ? finding.preserveMeaning
      : [];
  const repairReady = isStyleIssueRepairReady({
    severity: finding.severity === 'error' ? 'error' : 'warning',
    confidence: 1,
    generatedStart: finding.generatedStart,
    generatedEnd: finding.generatedEnd,
    generatedExcerpt,
    styleEvidenceIds,
    rewriteGoal,
    preserveMeaning:
      preserveMeaning.length > 0 ? preserveMeaning : ['保留原意'],
    description: finding.description,
  });
  // If the finding was already marked repairReady upstream with real evidence,
  // keep it when location + evidence still hold; never invent evidence.
  const effectiveReady =
    (finding.repairReady === true &&
      styleEvidenceIds.length > 0 &&
      ((generatedExcerpt.trim().length >= 4) ||
        (finding.generatedStart != null &&
          finding.generatedEnd != null &&
          finding.generatedEnd > finding.generatedStart))) ||
    repairReady;

  return JSON.stringify({
    findingId: finding.findingId,
    styleDimension: finding.styleDimension ?? finding.subtype,
    severity: finding.severity,
    generatedStart: finding.generatedStart,
    generatedEnd: finding.generatedEnd,
    generatedExcerpt: generatedExcerpt || undefined,
    description: finding.description,
    styleEvidenceIds,
    rewriteGoal: rewriteGoal || undefined,
    preserveMeaning,
    repairReady: effectiveReady,
  });
}

function styleIssuesFromReport(
  report: ContinuationControlReport,
): ContinuationStyleIssue[] {
  if (report.styleIssues?.length) return report.styleIssues;
  return (report.findings ?? [])
    .filter(f => f.repairReady)
    .map(f => ({
      findingId: f.findingId,
      styleDimension: (f.styleDimension ??
        f.subtype) as ContinuationStyleIssue['styleDimension'],
      severity: f.severity === 'error' ? 'error' : 'warning',
      confidence: 1,
      generatedStart: f.generatedStart,
      generatedEnd: f.generatedEnd,
      generatedExcerpt: f.generatedExcerpt ?? '',
      description: f.description,
      styleEvidenceIds: f.styleEvidenceIds ?? [],
      rewriteGoal: f.rewriteGoal ?? f.suggestedFix,
      preserveMeaning: f.preserveMeaning ?? [],
      repairReady: true,
    }));
}

/**
 * Build a single numbered Repair task list (Checker + Control + length expansion).
 * One physical Repair request handles all tasks — no split, no retry.
 */
export function buildRepairUnifiedTasks(input: {
  artifactText: string;
  checkerReport?: { issues: ContinuationCheckResult[] } | null;
  controlReport: ContinuationControlReport;
}): RepairUnifiedTask[] {
  const tasks: RepairUnifiedTask[] = [];
  let issueIndex = 1;
  const checks = input.checkerReport?.issues ?? [];

  for (const check of checks.filter(isRepairableCheckerIssue)) {
    tasks.push({
      issueIndex: issueIndex++,
      kind: 'checker',
      id: String(check.id),
      description: check.description,
      suggestedFix: check.suggestedFix ?? '',
      generatedStart: check.generatedStart,
      generatedEnd: check.generatedEnd,
      generatedExcerpt: (check.generatedExcerpt ?? '').trim(),
      mustPreserve: [],
    });
  }

  const styleIssues = styleIssuesFromReport(input.controlReport);
  const repairReadyStyle = styleIssues.filter(i => i.repairReady);
  const styleFindings = (input.controlReport.findings ?? []).filter(
    f => f.repairReady,
  );
  const controlItems: Array<ContinuationControlFinding | ContinuationStyleIssue> =
    styleFindings.length
      ? styleFindings
      : (repairReadyStyle as ContinuationStyleIssue[]);

  for (const item of controlItems) {
    const finding = item as ContinuationControlFinding & ContinuationStyleIssue;
    const excerpt = resolveStyleFindingExcerpt(
      {
        generatedStart: finding.generatedStart,
        generatedEnd: finding.generatedEnd,
        generatedExcerpt: finding.generatedExcerpt,
      },
      input.artifactText,
    );
    const evidence = finding.styleEvidenceIds ?? [];
    if (!evidence.length && !(finding as ContinuationControlFinding).repairReady) {
      continue;
    }
    tasks.push({
      issueIndex: issueIndex++,
      kind: 'control',
      id: finding.findingId,
      description: finding.description,
      suggestedFix:
        finding.rewriteGoal ?? finding.suggestedFix ?? finding.description,
      generatedStart: finding.generatedStart,
      generatedEnd: finding.generatedEnd,
      generatedExcerpt: excerpt,
      rewriteGoal: finding.rewriteGoal ?? finding.suggestedFix,
      preserveMeaning: finding.preserveMeaning ?? [],
      mustPreserve: finding.preserveMeaning ?? [],
    });
  }

  for (const check of checks.filter(isLengthExpansionIssue)) {
    tasks.push({
      issueIndex: issueIndex++,
      kind: 'length_expansion',
      id: String(check.id),
      description: check.description,
      suggestedFix: check.suggestedFix ?? '',
      generatedStart: null,
      generatedEnd: null,
      generatedExcerpt: '',
      mustPreserve: [],
    });
  }

  return tasks;
}

/**
 * Inject ⟦ISSUE_n_START⟧…⟦ISSUE_n_END⟧ around target spans (descending offsets).
 * Overlapping ranges: later (lower-index) tasks skip if they would nest wrongly.
 */
export function injectRepairAnchors(
  artifactText: string,
  tasks: RepairUnifiedTask[],
): string {
  const withRange = tasks
    .filter(
      t =>
        t.generatedStart != null &&
        t.generatedEnd != null &&
        t.generatedEnd > t.generatedStart &&
        t.generatedStart >= 0 &&
        t.generatedEnd <= artifactText.length,
    )
    .slice()
    .sort((a, b) => {
      const startDiff = (b.generatedStart as number) - (a.generatedStart as number);
      if (startDiff !== 0) return startDiff;
      return (b.generatedEnd as number) - (a.generatedEnd as number);
    });

  let result = artifactText;
  // Track intervals already marked in original coordinates (descending inject).
  const occupied: Array<{ start: number; end: number }> = [];
  for (const t of withRange) {
    const start = t.generatedStart as number;
    const end = t.generatedEnd as number;
    if (occupied.some(o => start < o.end && end > o.start)) continue;
    occupied.push({ start, end });
    // Because we inject from high to low start, earlier (higher) offsets are
    // already expanded; lower starts still match original coordinates.
    result =
      result.slice(0, start) +
      REPAIR_ISSUE_ANCHOR_START(t.issueIndex) +
      result.slice(start, end) +
      REPAIR_ISSUE_ANCHOR_END(t.issueIndex) +
      result.slice(end);
  }
  return result;
}

/** Strip client-injected Repair anchors; report whether any markers were present. */
export function stripRepairAnchors(text: string): {
  text: string;
  hadAnchors: boolean;
} {
  const hadAnchors = REPAIR_ANCHOR_MARKER_PATTERN.test(text);
  // Reset sticky global regex state for subsequent callers.
  REPAIR_ANCHOR_MARKER_PATTERN.lastIndex = 0;
  const cleaned = text.replace(REPAIR_ANCHOR_MARKER_PATTERN, '');
  REPAIR_ANCHOR_MARKER_PATTERN.lastIndex = 0;
  return { text: cleaned, hadAnchors };
}

function formatUnifiedTaskLine(task: RepairUnifiedTask): string {
  const parts = [
    `${task.issueIndex}. [${task.kind}] id=${task.id}`,
    `锚点=⟦ISSUE_${task.issueIndex}_START⟧…⟦ISSUE_${task.issueIndex}_END⟧`,
    `问题：${task.description}`,
    `建议修法：${task.suggestedFix || task.rewriteGoal || '（见描述）'}`,
  ];
  if (task.generatedExcerpt) {
    parts.push(`命中原文：「${task.generatedExcerpt.slice(0, 120)}」`);
  }
  if (task.mustPreserve?.length || task.preserveMeaning?.length) {
    parts.push(
      `必须保留：${(task.mustPreserve ?? task.preserveMeaning ?? []).join('；')}`,
    );
  }
  if (task.generatedStart != null && task.generatedEnd != null) {
    parts.push(`utf16=${task.generatedStart}-${task.generatedEnd}`);
  }
  return parts.join(' | ');
}

function lengthExpansionInstruction(input: {
  artifactText: string;
  targetChapterChars: number;
  plan: ContinuationPlan;
  tasks: RepairUnifiedTask[];
}): string | null {
  if (!input.tasks.some(t => t.kind === 'length_expansion')) return null;
  const contract = resolveContinuationLengthContract(input.targetChapterChars);
  const currentHan = countHanCharacters(input.artifactText);
  const gap = Math.max(0, contract.minHanCharacters - currentHan);
  const beatBudget = input.plan.beats
    .map(
      (beat, index) =>
        `- beat_${beat.order || index + 1}: ${beat.summary}`,
    )
    .join('\n');
  return [
    '【定向深化扩写任务】',
    `当前汉字数=${currentHan}；目标约 ${contract.targetHanCharacters}；合格区间 ${contract.minHanCharacters}–${contract.maxHanCharacters}（±30%）；缺口约 ${gap} 个汉字。`,
    '只在既有场景与既有节拍内深化：动作过程、对话回合、人物反应、感官细节、冲突升级阶梯。',
    '禁止新增人物/设定/情节线；禁止摘要式扩写、禁止复述前文、禁止为每个段落平均加水。',
    '扩写后仍须通过文风质量闸（padding / ai_template / description_density）；注水会被拒绝。',
    `【Writer beats（按节拍深化）】\n${beatBudget || '（无）'}`,
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
  const repairableCheckerIssues = checks.filter(isRepairableCheckerIssue);
  const lengthExpansionIssues = checks.filter(isLengthExpansionIssue);
  const styleIssues = styleIssuesFromReport(input.controlReport);
  const repairReadyStyle = styleIssues.filter(i => i.repairReady);
  const styleFindings = (input.controlReport.findings ?? []).filter(
    f => f.repairReady,
  );
  const unifiedTasks = buildRepairUnifiedTasks({
    artifactText: input.artifactText,
    checkerReport: input.checkerReport,
    controlReport: input.controlReport,
  });
  const anchoredText = injectRepairAnchors(input.artifactText, unifiedTasks);
  const expansionBlock = lengthExpansionInstruction({
    artifactText: input.artifactText,
    targetChapterChars: view.targetChapterChars,
    plan: input.plan,
    tasks: unifiedTasks,
  });
  const lengthPolicy = expansionBlock
    ? expansionBlock
    : [
        `用户配置的目标体量约 ${contract.targetHanCharacters} 个汉字（区间 ${contract.minHanCharacters}–${contract.maxHanCharacters}）。`,
        '本次无篇幅扩写任务：不得为了接近参考字数增加或删除内容。',
        '不得为了接近参考字数：新增解释性心理；重复人物反应；堆叠环境描写；扩展无新信息对白；添加总结性句子；机械重复风格画像特征。',
      ].join('\n');

  return [
    {
      role: 'system',
      content: [
        '你是原著续写 V4 Repair：最小干预修订者，不是重新创作者。',
        '只根据 Writer 完整原文与下方「统一可执行任务清单」做一次定向修订；输出完整终稿 envelope。',
        '你的修改范围可以很小，但输出范围必须覆盖整篇章节。即使只修改一句话，也必须返回从章节开头到自然结尾的完整终稿。未修改部分必须与修改部分一起输出。',
        '禁止只输出：修改片段、新增段落、Patch、offset、replacement、修改说明、摘要、大纲、“其余内容保持不变”、“以下为修改部分”。',
        '严格结构协议：唯一合格顶层为 {"schemaVersion":1,"content":"完整章节终稿","appliedCheckerIssueIds":[],"appliedControlSuggestionIds":[],"appliedControlFindingIds":[],"unappliedItems":[]}。六个顶层字段一个都不能省略；数组即使为空也必须保留。',
        'content 只能是完整、连续、可直接作为章节正文的纯文本；不能是 JSON、Markdown、说明文字或局部补丁。',
        '【执行顺序】1) 先处理带锚点的 Checker 五维问题；2) 再处理带锚点的 Control 文风问题；3) 若有篇幅扩写任务则定向深化；4) 不处理 audit-only warning；5) 不统一润色全文；6) 不改写未标记段落（扩写任务除外）；7) 不新增 Canon、人物经历或剧情事实。',
        '【锚点协议】user 正文中的 ⟦ISSUE_n_START⟧…⟦ISSUE_n_END⟧ 仅用于定位，终稿 content 中禁止保留任何锚点标记。',
        lengthPolicy,
        '【本次统一可执行任务清单（一次请求内全部完成，禁止拆分）】',
        unifiedTasks.length
          ? unifiedTasks.map(formatUnifiedTaskLine).join('\n')
          : '（无）',
        `- Checker repairReady 五维/边界问题共 ${repairableCheckerIssues.length} 项：必须改写对应 generatedExcerpt/锚点并回填 issueId。`,
        `- Control repairReady 文风问题共 ${repairReadyStyle.length || styleFindings.length} 项：必须改写目标范围、落实 rewriteGoal、遵守 preserveMeaning，并回填 findingId 到 appliedControlFindingIds。`,
        `- 篇幅定向扩写任务共 ${lengthExpansionIssues.length} 项：必须使汉字数进入目标区间下限以上，且候选汉字数 > 初稿。`,
        '- appliedControlSuggestionIds 保持空数组即可（已不再使用篇幅 expand/compress 建议）。',
        '- unappliedItems 必须为空。只填写 id 不代表完成；客户端会检查问题原句是否仍完整保留、锚点是否残留，以及终稿是否为完整章节。',
        `【Checker：五维资料一致性修订（明细）】\n${repairableCheckerIssues.map(renderCheck).join('\n') || '（无）'}`,
        `【Control：原著文风修订（明细）】\n${(
          styleFindings.length
            ? styleFindings
            : (repairReadyStyle as any)
        )
          .map((f: any) =>
            f.findingId
              ? renderStyleFinding(
                  f as ContinuationControlFinding,
                  input.artifactText,
                )
              : JSON.stringify(f),
          )
          .join('\n') || '（无）'}`,
        `【Control 报告摘要】\n${json({
          schemaVersion: input.controlReport.schemaVersion,
          action: input.controlReport.action,
          currentHan: input.controlReport.currentHan,
          targetHan: input.controlReport.targetHan,
          styleIssueCount: repairReadyStyle.length,
          styleWarningCount: (input.controlReport.styleWarnings ?? []).length,
          findings: styleFindings,
        })}`,
        planBlock(input.plan),
        outputBudgetBlock(view),
      ].join('\n\n'),
    },
    {
      role: 'user',
      content: [
        '【完整 Writer 初稿开始（含任务锚点）】',
        anchoredText,
        '【完整 Writer 初稿结束】',
        '现在只输出完整终稿 JSON envelope。只在标出的锚点范围内做最小干预修订（篇幅扩写任务除外）；未标记段落尽量保持原文；输出必须是完整章节，且 content 中不得保留任何 ⟦ISSUE_*⟧ 锚点：',
        '{"schemaVersion":1,"content":"在此放完整终稿纯文本","appliedCheckerIssueIds":[],"appliedControlSuggestionIds":[],"appliedControlFindingIds":[],"unappliedItems":[]}',
      ].join('\n\n'),
    },
  ];
}

export function continuationV4ProtocolSkeletonTokens(
  stage: 'writer' | 'checker' | 'control' | 'repair',
): number {
  const skeletons = {
    writer: {
      schemaVersion: 1,
      plan: { chapterGoal: '', centralConflict: '', beats: [] },
      content: '',
    },
    checker: {
      schemaVersion: 2,
      writerArtifactHash: '',
      issues: [],
      warnings: [],
    },
    control: {
      schemaVersion: 2,
      writerArtifactHash: '',
      styleProfileRevision: null,
      issues: [],
      warnings: [],
      summary: {
        reviewedDimensions: [],
        actionableIssueCount: 0,
        auditWarningCount: 0,
      },
    },
    repair: {
      schemaVersion: 1,
      content: '',
      appliedCheckerIssueIds: [],
      appliedControlSuggestionIds: [],
      appliedControlFindingIds: [],
      unappliedItems: [],
    },
  };
  return estimateTokens(JSON.stringify(skeletons[stage]));
}

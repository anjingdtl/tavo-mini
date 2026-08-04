import type { ChatMessage } from '../../llm/types';
import { estimateTokens } from '../../../utils/tokenEstimator';
import {
  resolveContinuationV4ReferenceLengthBand,
} from './continuationLengthContract';
import {
  getRepairReadyStyleFindings,
  STYLE_REPAIR_CONFIDENCE_MIN,
} from './continuationControl';
import { isRepairableCheckerIssue } from './continuationChecker';
import type {
  ContinuationCheckResult,
  ContinuationControlFinding,
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

/** Inline Repair anchors: visible span markers stripped client-side after parse. */
export const REPAIR_ISSUE_ANCHOR_START = (n: number) => `⟦ISSUE_${n}_START⟧`;
export const REPAIR_ISSUE_ANCHOR_END = (n: number) => `⟦ISSUE_${n}_END⟧`;
export const REPAIR_ANCHOR_MARKER_PATTERN = /⟦ISSUE_\d+_(?:START|END)⟧/g;

export const REPAIR_TASK_CONTEXT_CHARS = 96;
export const MAX_REPAIR_STYLE_TASKS = 8;

export interface RepairUnifiedTask {
  /** New canonical task-card fields. */
  taskIndex: number;
  taskId: string;
  subtype: string;
  source: 'local_safety' | 'checker' | 'style_control';
  priority: number;
  contextBefore: string;
  contextAfter: string;
  description: string;
  suggestedFix: string;
  generatedStart: number | null;
  generatedEnd: number | null;
  generatedExcerpt: string;
  evidenceIds: Array<number | string>;
  confidence: number | null;
  rewriteGoal?: string;
  preserveMeaning?: string[];
  forbiddenChanges: string[];
  anchorInjected: boolean;
  /** Compatibility aliases for older prompt/test consumers. */
  issueIndex: number;
  kind: 'checker' | 'control';
  id: string;
  mustPreserve?: string[];
}

export interface RepairAnchorInjectionResult {
  text: string;
  injectedTaskIndexes: number[];
  skipped: Array<{
    taskIndex: number;
    reason: 'no_range' | 'invalid_range' | 'overlap' | 'out_of_bounds';
  }>;
  overlapGroups: Array<{ taskIndexes: number[]; start: number; end: number }>;
}

export interface ContinuationRepairPromptOptions {
  taskContextChars?: number;
  includeWriterPlan?: boolean;
}

/**
 * Soft length goal only. It must not allocate a numeric quota to individual
 * beats or create an automatic Repair task.
 */
function writerLengthSoftHint(view: { targetChapterChars: number }): string {
  const contract = resolveContinuationV4ReferenceLengthBand(
    view.targetChapterChars,
  );
  return [
    `【本章目标体量】约 ${contract.targetHanCharacters} 个汉字，正常落区间 ${contract.minHanCharacters}–${contract.maxHanCharacters}（±${Math.round(contract.toleranceRatio * 100)}%）。`,
    '尽量使章节体量接近用户参考目标。若主要场景过早收束，优先深化已有场景中的动作、对话、反应、潜台词和因果过程；没有自然内容可展开时，不得为了达到数字填充。',
    '不得为了接近参考字数：填充重复心理；堆叠环境描写；重复人物反应；扩展无新信息的对白；添加总结性解释。',
  ].join('\n');
}

function writerLengthTailReminder(view: {
  targetChapterChars: number;
}): string {
  const contract = resolveContinuationV4ReferenceLengthBand(
    view.targetChapterChars,
  );
  return [
    '【Writer 输出前最后检查】',
    `输出前自查：正文体量是否大致接近 ${contract.targetHanCharacters} 个汉字参考目标；若主要场景过早收束，可自然深化既有动作、对话、反应、潜台词和因果过程；没有自然内容可展开时不要填充。`,
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
        `顶层必须为 {"schemaVersion":2,"writerArtifactHash":"","styleProfileHash":"","styleRendererVersion":"","issues":[],"warnings":[],"summary":{"reviewedDimensions":[],"actionableIssueCount":0,"auditWarningCount":0}}。writerArtifactHash 原样回显 ${input.writerArtifactHash ?? ''}；styleProfileHash 原样回显 ${view.style.profileHash ?? view.snapshotRefs.styleProfileHash ?? ''}；styleRendererVersion 原样回显 ${view.style.rendererVersion ?? ''}。`,
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

export function renderStyleFinding(
  finding: ContinuationControlFinding,
  artifactText?: string,
): string {
  const generatedExcerpt = resolveStyleFindingExcerpt(finding, artifactText);
  const styleEvidenceIds = finding.styleEvidenceIds ?? [];
  const rewriteGoal = finding.rewriteGoal ?? finding.suggestedFix ?? '';
  const preserveMeaning = finding.preserveMeaning ?? [];

  return JSON.stringify({
    findingId: finding.findingId,
    styleDimension: finding.styleDimension ?? finding.subtype,
    severity: finding.severity,
    generatedStart: finding.generatedStart,
    generatedEnd: finding.generatedEnd,
    generatedExcerpt: generatedExcerpt || undefined,
    confidence:
      typeof finding.confidence === 'number' && Number.isFinite(finding.confidence)
        ? finding.confidence
        : undefined,
    description: finding.description,
    styleEvidenceIds,
    rewriteGoal: rewriteGoal || undefined,
    preserveMeaning,
    repairReady: finding.repairReady === true,
    bindingStatus: finding.bindingStatus,
  });
}

function taskContext(
  artifactText: string,
  start: number | null,
  end: number | null,
  excerpt: string,
  contextChars: number,
): { before: string; after: string } {
  let resolvedStart = start;
  let resolvedEnd = end;
  if (
    (resolvedStart == null || resolvedEnd == null) &&
    excerpt.length >= 4
  ) {
    const located = artifactText.indexOf(excerpt);
    if (located >= 0 && artifactText.indexOf(excerpt, located + excerpt.length) < 0) {
      resolvedStart = located;
      resolvedEnd = located + excerpt.length;
    }
  }
  if (
    resolvedStart == null ||
    resolvedEnd == null ||
    resolvedStart < 0 ||
    resolvedEnd <= resolvedStart
  ) {
    return { before: '', after: '' };
  }
  return {
    before: artifactText.slice(Math.max(0, resolvedStart - contextChars), resolvedStart),
    after: artifactText.slice(resolvedEnd, resolvedEnd + contextChars),
  };
}

function makeRepairTask(input: {
  taskIndex: number;
  source: RepairUnifiedTask['source'];
  priority: number;
  taskId: string;
  subtype: string;
  description: string;
  suggestedFix: string;
  generatedStart: number | null;
  generatedEnd: number | null;
  generatedExcerpt: string;
  evidenceIds?: Array<number | string>;
  confidence?: number | null;
  rewriteGoal?: string;
  preserveMeaning?: string[];
  artifactText: string;
  contextChars: number;
}): RepairUnifiedTask {
  const context = taskContext(
    input.artifactText,
    input.generatedStart,
    input.generatedEnd,
    input.generatedExcerpt,
    input.contextChars,
  );
  return {
    taskIndex: input.taskIndex,
    taskId: input.taskId,
    subtype: input.subtype,
    source: input.source,
    priority: input.priority,
    contextBefore: context.before,
    contextAfter: context.after,
    description: input.description,
    suggestedFix: input.suggestedFix,
    generatedStart: input.generatedStart,
    generatedEnd: input.generatedEnd,
    generatedExcerpt: input.generatedExcerpt,
    evidenceIds: input.evidenceIds ?? [],
    confidence: input.confidence ?? null,
    rewriteGoal: input.rewriteGoal,
    preserveMeaning: input.preserveMeaning ?? [],
    forbiddenChanges: ['新增 Canon 事实', '改变未标记事件链', '输出摘要或局部片段'],
    anchorInjected: false,
    issueIndex: input.taskIndex,
    kind: input.source === 'style_control' ? 'control' : 'checker',
    id: input.taskId,
    mustPreserve: input.preserveMeaning ?? [],
  };
}

/**
 * Build one authoritative task card list. Length warnings and audit-only
 * findings deliberately never become cards.
 */
export function buildRepairUnifiedTasks(input: {
  artifactText: string;
  checkerReport?: { issues: ContinuationCheckResult[] } | null;
  controlReport: ContinuationControlReport;
  contextChars?: number;
  maxStyleTasks?: number;
}): RepairUnifiedTask[] {
  const contextChars = input.contextChars ?? REPAIR_TASK_CONTEXT_CHARS;
  const tasks: RepairUnifiedTask[] = [];
  let taskIndex = 1;
  const checks = input.checkerReport?.issues ?? [];
  const checkerIssues = checks
    .filter(isRepairableCheckerIssue)
    .sort((a, b) => {
      const aLocal =
        a.subtype === 'source_overlap' ||
        a.subtype === 'continuation_anchor_overlap' ||
        a.subtype === 'future_leakage' ||
        a.subtype === 'self_duplicate';
      const bLocal =
        b.subtype === 'source_overlap' ||
        b.subtype === 'continuation_anchor_overlap' ||
        b.subtype === 'future_leakage' ||
        b.subtype === 'self_duplicate';
      return Number(bLocal) - Number(aLocal);
    });
  for (const check of checkerIssues) {
    const excerpt = (check.generatedExcerpt ?? '').trim();
    const start = check.generatedStart;
    const end = check.generatedEnd;
    tasks.push(
      makeRepairTask({
        taskIndex: taskIndex++,
        source:
          check.subtype === 'source_overlap' ||
          check.subtype === 'continuation_anchor_overlap' ||
          check.subtype === 'future_leakage' ||
          check.subtype === 'self_duplicate'
            ? 'local_safety'
            : 'checker',
        priority:
          check.subtype === 'source_overlap' ||
          check.subtype === 'continuation_anchor_overlap' ||
          check.subtype === 'future_leakage' ||
          check.subtype === 'self_duplicate'
            ? 10
            : 20,
        taskId: String(check.id),
        subtype: check.subtype,
        description: check.description,
        suggestedFix: check.suggestedFix ?? '',
        generatedStart: start,
        generatedEnd: end,
        generatedExcerpt:
          excerpt ||
          (start != null && end != null && end > start
            ? input.artifactText.slice(start, end)
            : ''),
        evidenceIds: check.evidenceIds ?? [],
        confidence: Number.isFinite(check.confidence) ? check.confidence : null,
        artifactText: input.artifactText,
        contextChars,
      }),
    );
  }

  const readyFindings = getRepairReadyStyleFindings(input.controlReport);
  const styleLimit = input.maxStyleTasks ?? MAX_REPAIR_STYLE_TASKS;
  const styleItems = readyFindings.slice(0, styleLimit);
  for (const item of styleItems) {
    const finding = item as ContinuationControlFinding;
    const excerpt = resolveStyleFindingExcerpt(
      {
        generatedStart: finding.generatedStart,
        generatedEnd: finding.generatedEnd,
        generatedExcerpt: finding.generatedExcerpt,
      },
      input.artifactText,
    );
    tasks.push(
      makeRepairTask({
        taskIndex: taskIndex++,
        source: 'style_control',
        priority: 30,
        taskId: finding.findingId,
        subtype: finding.subtype,
        description: finding.description,
        suggestedFix: finding.rewriteGoal ?? finding.suggestedFix ?? finding.description,
        generatedStart: finding.generatedStart,
        generatedEnd: finding.generatedEnd,
        generatedExcerpt: excerpt,
        evidenceIds: finding.styleEvidenceIds ?? [],
        confidence:
          typeof finding.confidence === 'number' && Number.isFinite(finding.confidence)
            ? finding.confidence
            : null,
        rewriteGoal: finding.rewriteGoal ?? finding.suggestedFix,
        preserveMeaning: finding.preserveMeaning ?? [],
        artifactText: input.artifactText,
        contextChars,
      }),
    );
  }
  return tasks;
}

/**
 * Inject anchors using original UTF-16 coordinates. Overlapping ranges are
 * merged into one shared marker group, so no actionable task disappears.
 */
export function injectRepairAnchors(
  artifactText: string,
  tasks: RepairUnifiedTask[],
): RepairAnchorInjectionResult {
  const skipped: RepairAnchorInjectionResult['skipped'] = [];
  const valid = tasks
    .map(task => {
      const hasStart = task.generatedStart != null;
      const hasEnd = task.generatedEnd != null;
      if (!hasStart && !hasEnd) {
        skipped.push({ taskIndex: task.taskIndex, reason: 'no_range' });
        return null;
      }
      if (typeof task.generatedStart !== 'number' || typeof task.generatedEnd !== 'number' || task.generatedEnd <= task.generatedStart) {
        skipped.push({ taskIndex: task.taskIndex, reason: 'invalid_range' });
        return null;
      }
      if (task.generatedStart < 0 || task.generatedEnd > artifactText.length) {
        skipped.push({ taskIndex: task.taskIndex, reason: 'out_of_bounds' });
        return null;
      }
      return {
        taskIndex: task.taskIndex,
        start: task.generatedStart,
        end: task.generatedEnd,
      };
    })
    .filter((value): value is { taskIndex: number; start: number; end: number } => value !== null)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const groups: Array<{ taskIndexes: number[]; start: number; end: number }> = [];
  for (const item of valid) {
    const current = groups[groups.length - 1];
    if (!current || item.start >= current.end) {
      groups.push({
        taskIndexes: [item.taskIndex],
        start: item.start,
        end: item.end,
      });
      continue;
    }
    current.taskIndexes.push(item.taskIndex);
    current.start = Math.min(current.start, item.start);
    current.end = Math.max(current.end, item.end);
  }
  const overlapGroups = groups.filter(group => group.taskIndexes.length > 1);
  const injectedTaskIndexes = groups.flatMap(group => group.taskIndexes);
  let text = artifactText;
  for (const group of [...groups].sort((a, b) => b.start - a.start)) {
    const starts = group.taskIndexes
      .map(taskIndex => REPAIR_ISSUE_ANCHOR_START(taskIndex))
      .join('');
    const ends = [...group.taskIndexes]
      .reverse()
      .map(taskIndex => REPAIR_ISSUE_ANCHOR_END(taskIndex))
      .join('');
    text = text.slice(0, group.start) + starts + text.slice(group.start, group.end) + ends + text.slice(group.end);
  }
  return { text, injectedTaskIndexes, skipped, overlapGroups };
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
    `${task.taskIndex}. [${task.source}] subtype=${task.subtype} taskId=${task.taskId} priority=${task.priority}`,
    task.anchorInjected
      ? `定位：锚点 ⟦ISSUE_${task.taskIndex}_START⟧…⟦ISSUE_${task.taskIndex}_END⟧`
      : `定位：utf16 ${task.generatedStart ?? '—'}–${task.generatedEnd ?? '—'}；命中原文：「${task.generatedExcerpt.slice(0, 120)}」`,
    `问题：${task.description}`,
    `修订目标：${task.rewriteGoal || task.suggestedFix || '（见描述）'}`,
  ];
  if (task.generatedExcerpt) {
    parts.push(`命中原文：「${task.generatedExcerpt.slice(0, 120)}」`);
  }
  parts.push(`前文上下文：「${task.contextBefore}」`);
  parts.push(`后文上下文：「${task.contextAfter}」`);
  parts.push(`证据=${task.evidenceIds.join(',') || 'none'}；confidence=${task.confidence ?? 'unknown'}`);
  parts.push(`必须保留：${(task.preserveMeaning ?? []).join('；') || '（未提供，不能擅自改变语义）'}`);
  parts.push(`禁止改变：${task.forbiddenChanges.join('；')}`);
  return parts.join(' | ');
}

export function compileContinuationV4RepairMessages(input: {
  view: FrozenContinuationRepairContextView;
  artifactText: string;
  plan: ContinuationPlan;
  checkerReport?: { issues: ContinuationCheckResult[] } | null;
  controlReport: ContinuationControlReport;
  options?: ContinuationRepairPromptOptions;
}): ChatMessage[] {
  const { view } = input;
  const contract = resolveContinuationV4ReferenceLengthBand(view.targetChapterChars);
  const checks = input.checkerReport?.issues ?? [];
  const repairableCheckerIssues = checks.filter(isRepairableCheckerIssue);
  const unifiedTasksBeforeAnchors = buildRepairUnifiedTasks({
    artifactText: input.artifactText,
    checkerReport: input.checkerReport,
    controlReport: input.controlReport,
    contextChars: input.options?.taskContextChars ?? REPAIR_TASK_CONTEXT_CHARS,
  });
  const anchorResult = injectRepairAnchors(
    input.artifactText,
    unifiedTasksBeforeAnchors,
  );
  const unifiedTasks = unifiedTasksBeforeAnchors.map(task => ({
    ...task,
    anchorInjected: anchorResult.injectedTaskIndexes.includes(task.taskIndex),
  }));
  const lengthPolicy = [
    `用户配置的目标体量约 ${contract.targetHanCharacters} 个汉字（参考区间 ${contract.minHanCharacters}–${contract.maxHanCharacters}，偏差仅供参考）。`,
    '尽量使章节体量接近用户参考目标。若主要场景过早收束，优先深化已有场景中的动作、对话、反应、潜台词和因果过程；没有自然内容可展开时，不得为了接近参考字数填充。',
    '篇幅偏差仅供参考，未因此触发自动 Repair；Repair 只处理统一任务卡中的 Checker、local safety 和 Control style error。',
  ].join('\n');
  const repairReadyStyleCount = unifiedTasks.filter(
    task => task.source === 'style_control',
  ).length;

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
        '【执行顺序】1) local_safety blocking；2) Checker blocking/error；3) Control style error；4) 不处理 audit-only warning；5) 不统一润色全文；6) 不改写未标记段落；7) 不新增 Canon、人物经历或剧情事实。',
        '【锚点协议】user 正文中的 ⟦ISSUE_n_START⟧…⟦ISSUE_n_END⟧ 仅用于定位，终稿 content 中禁止保留任何锚点标记。',
        lengthPolicy,
        '【本次统一可执行任务清单（一次请求内全部完成，禁止拆分）】',
        unifiedTasks.length
          ? unifiedTasks.map(formatUnifiedTaskLine).join('\n')
          : '（无）',
        `【紧凑统计】Checker/local safety 可执行 ${repairableCheckerIssues.length} 项；Control style error ${repairReadyStyleCount} 项；audit-only 不进入任务卡；锚点注入 ${anchorResult.injectedTaskIndexes.length} 项；无锚点任务 ${anchorResult.skipped.length} 项；重叠组 ${anchorResult.overlapGroups.length} 组。`,
        '- appliedControlSuggestionIds 保持空数组；字数不生成任务，也不需要回填长度进度。',
        '- unappliedItems 必须为空。只填写 id 不代表完成；客户端会检查问题原句是否仍完整保留、锚点是否残留，以及终稿是否为完整章节。',
        input.options?.includeWriterPlan === false ? '' : planBlock(input.plan),
        'Repair 后只执行本地完整性、协议、重复和确定性安全检查；不会进行第二次 LLM 文风复核。',
        outputBudgetBlock(view),
      ].filter(Boolean).join('\n\n'),
    },
    {
      role: 'user',
      content: [
        '【完整 Writer 初稿开始（含任务锚点）】',
        anchorResult.text,
        '【完整 Writer 初稿结束】',
        '现在只输出完整终稿 JSON envelope。只在任务卡指出的范围内做最小干预修订；无锚点任务使用其 utf16 范围、原文摘录和前后上下文定位；未标记段落尽量保持原文；输出必须是完整章节，且 content 中不得保留任何 ⟦ISSUE_*⟧ 锚点：',
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
      styleProfileHash: '',
      styleRendererVersion: '',
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

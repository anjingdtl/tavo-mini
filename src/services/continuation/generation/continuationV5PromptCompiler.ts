/**
 * Continuation V5 prompt compilers for the five physical nodes.
 */
import type { ChatMessage } from '../../llm/types';
import { estimateMessagesTokens } from '../../../utils/tokenEstimator';
import type {
  ContinuationV5ArchitectureEnvelope,
  ContinuationV5AuditEnvelope,
  ContinuationV5RevisionAnchor,
  ContinuationV5StageViews,
  ContinuationV5StyleDimension,
} from './types';

/**
 * Build the C2 selector list from V2 itself. The model sees the text only
 * once, tagged with stable ids, and later stages receive the selected text
 * from this client-owned source rather than from a model quotation.
 *
 * The input is normalized to LF (`\n`) first so that recorded UTF-16 offsets
 * stay consistent with the persisted V2 artifact body (always LF after JSON
 * parse). This is a defensive guard: the V5 runner already passes the same LF
 * string to both the anchor builder and the DB insert, so under normal
 * operation no `\r\n` ever reaches here. The normalization only matters if a
 * future caller accidentally feeds CRLF text — without it every preceding
 * `\r\n` would silently inflate every later anchor offset by one per line.
 */
export function buildContinuationV5RevisionAnchors(
  revisionContent: string,
): ContinuationV5RevisionAnchor[] {
  const content =
    revisionContent.indexOf('\r') >= 0
      ? revisionContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      : revisionContent;
  const anchors: ContinuationV5RevisionAnchor[] = [];
  const separator = /\r?\n\s*\r?\n/g;
  let blockStart = 0;
  const append = (raw: string, absoluteStart: number) => {
    const text = raw.trim();
    if (!text) return;
    const localStart = raw.indexOf(text);
    const start = absoluteStart + Math.max(0, localStart);
    anchors.push({
      anchorId: `v2-p-${String(anchors.length + 1).padStart(3, '0')}`,
      start,
      end: start + text.length,
      text,
    });
  };
  for (const match of content.matchAll(separator)) {
    append(content.slice(blockStart, match.index), blockStart);
    blockStart = (match.index ?? 0) + match[0].length;
  }
  append(content.slice(blockStart), blockStart);
  if (anchors.length === 0 && content.trim()) {
    const text = content.trim();
    const start = content.indexOf(text);
    anchors.push({
      anchorId: 'v2-p-001',
      start,
      end: start + text.length,
      text,
    });
  }
  return anchors;
}

function revisionAnchorBlock(anchors: ContinuationV5RevisionAnchor[]): string {
  return anchors
    .map(
      anchor =>
        `[${anchor.anchorId} @${anchor.start}-${anchor.end}]\n${anchor.text}`,
    )
    .join('\n\n');
}

// ── V3 edit work packet ────────────────────────────────────────────────
//
// The packet is a prompt-only derivation from the already-parsed
// ContinuationV5AuditEnvelope. C2 only selects real V2 anchor ids; the
// client backfills the exact excerpt, range and offsets. We surface each
// anchored style task as an explicit, ordered "edit work item" so V3's
// attention lands on per-segment rewrites before the full V2 baseline.

/**
 * A single client-derived edit task for V3. `sourceText` is always the
 * resolved V2 excerpt from the audit contract, never a model quotation.
 */
export interface ContinuationV5EditWorkItem {
  requirementId: string;
  anchorId: string;
  /** Resolved V2 excerpt (parsed contract's generatedExcerpt). */
  sourceText: string;
  /** UTF-16 offsets of sourceText inside V2; -1 when unknown. */
  sourceStart: number;
  sourceEnd: number;
  dimension: ContinuationV5StyleDimension;
  description: string;
  rewriteGoal: string;
  preserveMeaning: string[];
  /** Related finalObligation ids (matched by description overlap), else []. */
  obligationIds: string[];
}

/**
 * Build the V3 edit work packet from a parsed audit envelope.
 *
 * Rules (per `continuation-v5-v3-edit-work-packet-redesign.md`):
 * - Only style corrections whose `anchorId` is non-null AND whose resolved
 *   `generatedExcerpt` is non-empty enter the packet. Legacy anchorId=null
 *   contracts remain parseable; such tasks are simply skipped here and still
 *   flow through the existing JSON task block for resumed runs.
 * - C2's original order is preserved; the packet is capped at 6 items.
 * - No similarity, replacement or any post-hoc V3 judgement is performed.
 */
export function buildContinuationV5EditWorkPacket(
  audit: ContinuationV5AuditEnvelope,
): ContinuationV5EditWorkItem[] {
  const obligations = audit.finalObligations;
  const items = audit.styleAudit.requiredCorrections
    .filter(
      correction =>
        typeof correction.anchorId === 'string' &&
        correction.anchorId.length > 0 &&
        typeof correction.generatedExcerpt === 'string' &&
        correction.generatedExcerpt.length > 0,
    )
    .map(correction => ({
      requirementId: correction.requirementId,
      anchorId: correction.anchorId as string,
      sourceText: correction.generatedExcerpt,
      sourceStart:
        typeof correction.generatedStart === 'number'
          ? correction.generatedStart
          : -1,
      sourceEnd:
        typeof correction.generatedEnd === 'number'
          ? correction.generatedEnd
          : -1,
      dimension: correction.dimension,
      description: correction.description,
      rewriteGoal: correction.rewriteGoal,
      preserveMeaning: correction.preserveMeaning,
      obligationIds: matchObligationIds(obligations, correction),
    }));
  return items.slice(0, 6);
}

function matchObligationIds(
  obligations: ContinuationV5AuditEnvelope['finalObligations'],
  correction: {
    requirementId: string;
    description: string;
    rewriteGoal: string;
  },
): string[] {
  const hay = `${correction.description}\n${correction.rewriteGoal}`;
  return obligations
    .filter(obligation => {
      const keywords = splitKeywords(obligation.description);
      return keywords.some(keyword => keyword.length >= 3 && hay.includes(keyword));
    })
    .map(obligation => obligation.obligationId);
}

function splitKeywords(text: string): string[] {
  return text
    .split(/[\s,，。；;:：、（）()【】"'“”‘’！？!?\.]+/)
    .map(token => token.trim())
    .filter(Boolean);
}

/** Render the edit work packet as the V3-facing instructional block. */
export function formatContinuationV5EditWorkPacket(
  packet: ContinuationV5EditWorkItem[],
): string {
  if (packet.length === 0) {
    return '【V3 必须先完成的定点编辑工作包】\n（本合同无可定位的真实 V2 锚点任务；请按 C2 的 finalObligations 与 canon 纠正项正常润色。）';
  }
  const blocks = packet.map((item, index) => {
    const preserve = item.preserveMeaning.length
      ? item.preserveMeaning.map(entry => `  - ${entry}`).join('\n')
      : '  - （本段无额外硬保留约束，但仍不得改变已成立的事件、人物选择、因果与情绪落点）';
    const range =
      item.sourceStart >= 0 && item.sourceEnd >= 0
        ? `（V2 偏移 ${item.sourceStart}–${item.sourceEnd}）`
        : '';
    const obligations =
      item.obligationIds.length > 0
        ? `\n关联义务：${item.obligationIds.join(', ')}`
        : '';
    return [
      `任务 ${index + 1} / ${item.requirementId} / ${item.anchorId}（${item.dimension}）${range}`,
      `【真实 V2 原段】\n${item.sourceText}`,
      `【诊断】\n${item.description}`,
      `【本段改写目标】\n${item.rewriteGoal || '（未给出具体改写目标，请按维度整体提升表达）'}`,
      `【必须保留】\n${preserve}`,
      `【执行动作】将整段重新组织为新的叙述表达：用新的句式、节奏、对白或留白实现上述改写目标；必须保留事件、人物选择、因果与情绪落点；禁止以删词、改标点或只替换一两个近义词的方式完成本任务。${obligations}`,
    ].join('\n');
  });
  return [
    '【V3 必须先完成的定点编辑工作包】',
    '下方每一项的“真实 V2 原段”均由客户端按 anchorId 从 V2 回填，是本次必须整体重写的源段。',
    '请先按编号依次完成全部工作包，再把这些改写无缝合成为完整 V3；不得先全文复述、最后只在少数地方微调。',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

export function continuationV5ProtocolSkeletonTokens(
  stage: keyof ContinuationV5StageViews,
): number {
  switch (stage) {
    case 'draft_writer':
      return 280;
    case 'narrative_architect':
      return 360;
    case 'revision_writer':
      return 320;
    case 'adversarial_auditor':
      return 480;
    case 'final_reviser':
      return 400;
    default:
      return 300;
  }
}

function hardFactsBlock(
  view: ContinuationV5StageViews['draft_writer'],
): string {
  const hard = view.canon.hardFacts.slice(0, 24).map(fact => `- ${fact.text}`);
  const locked = view.lockedRules.slice(0, 12).map(rule => `- ${rule}`);
  return [
    '【用户锁定规则】',
    locked.length ? locked.join('\n') : '- （无）',
    '【硬 Canon】',
    hard.length ? hard.join('\n') : '- （无）',
  ].join('\n');
}

function styleBlock(text: string): string {
  return text ? `【原著风格】\n${text}` : '【原著风格】\n（无注入画像文本）';
}

/**
 * Previous-chapter seam block. Carries the real tail of the immediately
 * preceding chapter (or original-source seam for the first continuation
 * chapter) so the model can connect chapter N+1 to chapter N. Empty anchor
 * text is a degenerate case; we still emit the header so the model knows the
 * channel exists but is intentionally empty.
 */
function primaryAnchorSeamBlock(seamText: string): string {
  return seamText
    ? `【上一章正文接缝（务必自然衔接，不得复述）】\n${seamText}`
    : '【上一章正文接缝】\n（无可用上一章接缝；若为开篇则正常起笔）';
}

/**
 * Recent continuation bridge: the chronological excerpts of chapters before
 * the primary anchor (excludes the immediately-previous chapter, which is
 * already covered by the primary anchor seam). Capped to keep the prompt
 * bounded even when many prior chapters exist.
 */
function recentBridgeBlock(bridgeSummary: string): string {
  if (!bridgeSummary) return '';
  return `【更早正文桥（背景，勿复述）】\n${bridgeSummary.slice(0, 1800)}`;
}

function stateBlock(view: ContinuationV5StageViews['draft_writer']): string {
  const chars = view.effectiveState.characterStates
    .slice(0, 12)
    .map(item => `- ${item.summary}`)
    .join('\n');
  const rels = view.effectiveState.relationships
    .slice(0, 8)
    .map(item => `- ${item.summary}`)
    .join('\n');
  const plots = view.effectiveState.plotThreads
    .slice(0, 8)
    .map(item => `- ${item.title}: ${item.summary}`)
    .join('\n');
  return [
    '【当前人物状态】',
    chars || '- （无）',
    '【当前关系】',
    rels || '- （无）',
    '【当前剧情线】',
    plots || '- （无）',
  ].join('\n');
}

export function compileContinuationV5DraftWriterMessages(input: {
  view: ContinuationV5StageViews['draft_writer'];
}): { messages: ChatMessage[]; promptTokens: number } {
  const { view } = input;
  const system = [
    '你是 Continuation V5 Draft Writer。',
    '请生成从章节开头到自然结尾的完整初稿 V1。',
    `用户希望本章约为 ${view.targetChapterChars} 个汉字，首选自然体量约为 ${view.preferredMinHan}–${view.preferredMaxHan} 个汉字。`,
    '这不是要求写完后补字，而是要求你在动笔前准备足以支撑该体量的有效叙事内容。',
    '主要行动不能只被一句话概述。中心冲突不能刚刚启动就结束。',
    '重要人物的行动、阻力、选择、反应和后果需要真正发生在正文中。',
    '不要为每个 Beat 分配固定字数。',
    '不要为了接近目标而重复心理、环境、反应、对白或总结解释。',
    '如果没有足够内容自然展开，请先调整 plan，增加符合 Canon、人物状态和用户要求的有效推进，而不是提前结束正文。',
    '只输出 JSON object，schemaVersion=1，字段 plan 与 content。content 必须是完整章节正文，禁止 Patch/摘要/提纲。',
  ].join('\n');
  const user = [
    `【本章要求】\n${view.userInstruction || '（无额外要求）'}`,
    hardFactsBlock(view),
    stateBlock(view),
    styleBlock(view.style.text),
    primaryAnchorSeamBlock(view.primaryAnchorSeamText),
    recentBridgeBlock(view.recentBridgeSummary),
    '【输出契约】\n{"schemaVersion":1,"plan":{"chapterGoal":"...","centralConflict":"...","beats":[{"id":"beat_1","summary":"...","stateChange":"..."}]},"content":"完整章节正文"}',
  ]
    .filter(Boolean)
    .join('\n\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  return { messages, promptTokens: estimateMessagesTokens(messages) };
}

export function compileContinuationV5ArchitectMessages(input: {
  view: ContinuationV5StageViews['narrative_architect'];
}): { messages: ChatMessage[]; promptTokens: number } {
  const { view } = input;
  const system = [
    '你是 Continuation V5 Narrative Architect。',
    '你与 Draft Writer 并行工作，不读取 V1，也不写小说正文。',
    '你只准备足以支撑目标体量的有效叙事材料：场景单元、行动、阻力、选择/转折与后果。',
    '禁止为场景分配字数预算。禁止输出章节正文。',
    '每个 scene unit 必须形成：行动 → 阻力/异常 → 选择/转折 → 局面变化 → 后果。',
    '只输出 JSON object，schemaVersion=1。',
  ].join('\n');
  const user = [
    `【本章要求】\n${view.userInstruction || '（无）'}`,
    `【目标体量参考】约 ${view.targetChapterChars} 汉字（${view.preferredMinHan}–${view.preferredMaxHan}）`,
    hardFactsBlock(view as any),
    stateBlock(view as any),
    '【输出契约】\n{"schemaVersion":1,"chapterGoal":"...","centralConflict":"...","sceneUnits":[{"sceneId":"s1","entryState":"...","characterAction":"...","resistance":"...","turningPoint":"...","consequence":"...","relationshipChange":null,"informationChange":null,"riskChange":null,"canonEvidenceIds":[],"requiredContinuity":[],"forbiddenInventions":[]}],"endingState":"...","forbiddenPaddingPatterns":[]}',
  ].join('\n\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  return { messages, promptTokens: estimateMessagesTokens(messages) };
}

export function compileContinuationV5RevisionWriterMessages(input: {
  view: ContinuationV5StageViews['revision_writer'];
  draftContent: string;
  draftHan: number;
  draftArtifactHash: string;
  architecture: ContinuationV5ArchitectureEnvelope;
  architectureHash: string;
}): { messages: ChatMessage[]; promptTokens: number } {
  const { view } = input;
  const system = [
    '你是 Continuation V5 Revision Writer。',
    '你要生成完整的第一次修订稿 V2。',
    '【分工】V2 是本流水线的主扩写稿：目标字数必须在此阶段基本达成。后续 V3 只做润色与合同履约，默认不再大幅加长。',
    'V1 是文学表达基线。A1 是叙事材料，不是必须机械执行的清单。',
    '保留 V1 中自然、有原著气息的人物对白、叙述、动作和留白；',
    '同时从 A1 中选择符合 Canon、人物状态和用户要求的有效内容，修复 V1 中过早收束、只作概述或事件链不足的部分。',
    '通过真实行动、阻力、选择、转折和后果扩充章节。',
    '不得重复心理、堆叠环境、重复反应、扩展无信息对白或添加总结解释。',
    '不得凭空创造重大人物、能力、组织、规则或后续事实。',
    `【篇幅硬目标】本章目标 ${view.targetChapterChars} 个汉字；V2 正文汉字数必须落在 ${view.preferredMinHan}–${view.preferredMaxHan} 之间。`,
    `V1 当前为 ${input.draftHan} 个汉字。若 V1 偏短，你必须用有效情节（行动、阻力、人物选择、信息/关系变化、后果）把 V2 扩到至少 ${view.preferredMinHan} 个汉字。`,
    `未达到 ${view.preferredMinHan} 个汉字视为 V2 未完成，不得提前收束。`,
    '禁止用重复句、空转对白、堆叠环境或总结解释凑字；必须靠尚未充分展开的核心场景推进叙事。',
    '【绑定协议】draftArtifactHash 与 architectureHash 是客户端提供的权威值，必须从用户消息中逐字符原样复制；禁止重新计算、缩写、改写、填占位符或使用旧值。',
    '只输出完整章节 JSON envelope，禁止 Patch。',
  ].join('\n');
  const user = [
    `【本章要求】\n${view.userInstruction || '（无）'}`,
    hardFactsBlock(view as any),
    styleBlock(view.style.text),
    primaryAnchorSeamBlock(view.primaryAnchorSeamText),
    `【V1 contentHash】${input.draftArtifactHash}`,
    `【A1 architectureHash】${input.architectureHash}`,
    `【完整 V1】\n${input.draftContent}`,
    `【A1 叙事架构】\n${JSON.stringify(input.architecture)}`,
    `【篇幅自检】输出前确认 content 汉字数 ≥ ${view.preferredMinHan} 且 ≤ ${view.preferredMaxHan}。目标 ${view.targetChapterChars}。`,
    `【绑定字段最终自检】输出 JSON 中 draftArtifactHash 必须严格等于 ${input.draftArtifactHash}；architectureHash 必须严格等于 ${input.architectureHash}。这两个值不是示例、不是“...”占位符，也不得重新计算。`,
    `【输出契约（两个 hash 必须原样复制上方完整值）】\n{"schemaVersion":1,"draftArtifactHash":"${input.draftArtifactHash}","architectureHash":"${input.architectureHash}","content":"完整V2正文","usedArchitectSceneIds":[],"omittedArchitectSceneIds":[],"declaredNewCoreFacts":[]}`,
  ].join('\n\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  return { messages, promptTokens: estimateMessagesTokens(messages) };
}

export function compileContinuationV5AuditorMessages(input: {
  view: ContinuationV5StageViews['adversarial_auditor'];
  draftContent: string;
  draftArtifactHash: string;
  revisionContent: string;
  revisionArtifactHash: string;
  revisionAnchors: ContinuationV5RevisionAnchor[];
  architecture: ContinuationV5ArchitectureEnvelope;
  architectureHash: string;
}): { messages: ChatMessage[]; promptTokens: number } {
  const { view } = input;
  const revisionAnchors =
    input.revisionAnchors.length > 0
      ? input.revisionAnchors
      : buildContinuationV5RevisionAnchors(input.revisionContent);
  const system = [
    '你是 Continuation V5 Adversarial Auditor。',
    '你在 V2 完成后工作，直接审查真实 V2，输出驱动 V3 的最终修订合同 C2。',
    'C2 不是质量评分，也不是“没有问题”的空报告；它是一份给 Final Reviser 的定点润色任务单。',
    '必须严格分区：canonAudit / styleAudit / architectureAudit / finalObligations。',
    '不得把事实和文风混成一个总分。',
    '不得伪造 confidence、evidence、styleEvidenceIds 或 preserveMeaning。',
    '缺少证据的项不得升级为 blocking。',
    '即使 V2 没有 Canon 错误，也必须从 V2 中给出 3–6 条可执行的 styleAudit 润色项，覆盖句式节奏、叙述语气、人物对白、情绪留白、段落衔接、模板化表达或重复中的适用项。',
    '每条 styleAudit 必须从下方的真实 V2 片段列表选择一个不同的 anchorId，并写清 rewriteGoal 和 preserveMeaning；不得自行摘抄、拼接、改写或杜撰 generatedExcerpt。',
    '每条 styleAudit 的 rewriteGoal 必须要求将选中片段整体改写为更好的表达，而不是只删词、改标点或替换一两个近义词。',
    '如发现 Canon/边界问题，同样必须定位 V2 原句并说明在不改变何种既有含义下修正。',
    '【衔接检查】若 V2 开头与“上一章正文接缝”在场景、人物位置、情绪或时间上没有自然衔接（例如突兀跳场、重复已发生事件、无视接缝末尾的状态），必须生成一条 finalObligation，要求 V3 在开头补足自然衔接，并指明必须承接的接缝要素。',
    'finalObligations 要把所有需要在 V3 实际执行的修订任务按优先级重述，不要留空。',
    '只输出 JSON object。',
  ].join('\n');
  const user = [
    `【绑定字段】`,
    `draftArtifactHash=${input.draftArtifactHash}`,
    `revisionArtifactHash=${input.revisionArtifactHash}`,
    `architectureHash=${input.architectureHash}`,
    `canonSnapshotId=${view.snapshotRefs.canonSnapshotId}`,
    `canonRevision=${view.snapshotRefs.canonRevision}`,
    `inputRevisionHash=${view.snapshotRefs.inputRevisionHash}`,
    `styleProfileHash=${view.snapshotRefs.styleProfileHash ?? 'null'}`,
    `styleRendererVersion=${view.snapshotRefs.styleRendererVersion ?? 'null'}`,
    `【本章要求】\n${view.userInstruction || '（无）'}`,
    hardFactsBlock(view as any),
    styleBlock(view.style.text),
    primaryAnchorSeamBlock(view.primaryAnchorSeamText),
    `【V1 保留表达参考】\n${input.draftContent}`,
    `【A1】\n${JSON.stringify(input.architecture)}`,
    `【完整 V2（C2 的唯一润色对象；仅可用下列真实片段 id 定位）】\n${revisionAnchorBlock(
      revisionAnchors,
    )}`,
    '【C2 输出契约】\n{"schemaVersion":1,"draftArtifactHash":"...","revisionArtifactHash":"...","architectureHash":"...","canonSnapshotId":"...","canonRevision":1,"inputRevisionHash":"...","styleProfileHash":"...","styleRendererVersion":"...","canonAudit":{"requiredCorrections":[{"requirementId":"canon_1","generatedExcerpt":"V2原句","description":"...","requiredOutcome":"...","forbiddenChanges":[]}],"protectedFacts":[],"forbiddenFacts":[]},"styleAudit":{"requiredCorrections":[{"requirementId":"style_1","anchorId":"v2-p-001","dimension":"sentence_rhythm","severity":"warning","description":"具体问题","rewriteGoal":"对该完整片段的具体改写方向","preserveMeaning":["必须保留的事件/情绪"]}],"protectedPassages":[],"forbiddenExpansionPatterns":[]},"architectureAudit":{"safeSceneIds":[],"rejectedScenes":[]},"finalObligations":[{"obligationId":"obl_1","source":"style","priority":1,"description":"...","requiredOutcome":"...","forbiddenChanges":[]}]}.',
    'styleAudit.requiredCorrections 至少 3 条、至多 6 条，且每条使用不同的 anchorId。客户端会回填真实原文，忽略你自行生成的引文。',
  ].join('\n\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  return { messages, promptTokens: estimateMessagesTokens(messages) };
}

export type FinalReviserCompressionLevel = 0 | 1 | 2 | 3 | 4;

export function compileContinuationV5FinalReviserMessages(input: {
  view: ContinuationV5StageViews['final_reviser'];
  revisionContent: string;
  revisionHan: number;
  revisionArtifactHash: string;
  architecture: ContinuationV5ArchitectureEnvelope;
  architectureHash: string;
  audit: ContinuationV5AuditEnvelope;
  auditContractHash: string;
  compressionLevel?: FinalReviserCompressionLevel;
}): {
  messages: ChatMessage[];
  promptTokens: number;
  compressionLevel: FinalReviserCompressionLevel;
} {
  const level = input.compressionLevel ?? 0;
  const { view } = input;
  // All final obligations are material for Final Reviser.
  const blockingObligations = input.audit.finalObligations;
  let canonCorrections = input.audit.canonAudit.requiredCorrections;
  let styleCorrections = input.audit.styleAudit.requiredCorrections;
  if (level >= 1) {
    canonCorrections = canonCorrections.filter(
      item => item.severity !== 'warning',
    );
    styleCorrections = styleCorrections.filter(
      item => item.severity !== 'warning',
    );
  }
  const rejected = new Set(
    input.audit.architectureAudit.rejectedScenes.map(item => item.sceneId),
  );
  let scenes = input.architecture.sceneUnits.filter(
    scene => !rejected.has(scene.sceneId),
  );
  if (input.audit.architectureAudit.safeSceneIds.length > 0) {
    const safe = new Set(input.audit.architectureAudit.safeSceneIds);
    const preferred = scenes.filter(scene => safe.has(scene.sceneId));
    if (preferred.length > 0) scenes = preferred;
  }
  if (level >= 2) {
    scenes = scenes.slice(0, Math.max(2, Math.ceil(scenes.length * 0.6)));
  }
  let protectedPassages = input.audit.styleAudit.protectedPassages;
  if (level >= 3) {
    protectedPassages = protectedPassages.map(item => ({
      ...item,
      generatedExcerpt: item.generatedExcerpt.slice(0, 160),
    }));
  }
  const softCanon =
    level >= 4
      ? view.canon.softFacts.slice(0, 4).map(item => item.text)
      : view.canon.softFacts.slice(0, 16).map(item => item.text);

  const v2InBand =
    input.revisionHan >= view.preferredMinHan &&
    input.revisionHan <= view.preferredMaxHan;
  const editWorkPacket = buildContinuationV5EditWorkPacket(input.audit);
  const editWorkPacketBlock = formatContinuationV5EditWorkPacket(editWorkPacket);
  const finalObligationIds = blockingObligations.map(item => item.obligationId);
  const canonRequirementIds = canonCorrections.map(item => item.requirementId);
  const styleRequirementIds = styleCorrections.map(item => item.requirementId);
  const system = [
    '你是 Continuation V5 Final Reviser。',
    '你要生成本次唯一的完整最终稿 V3。',
    '【分工】V2 已是主扩写稿；V3 默认做润色与 C2 合同履约，不要把 V3 当成主要加长环节。',
    'V2 是当前正文基线，但不是不可修改的模板。C2 是最终修订合同。',
    '你先执行下方按编号给出的真实 V2 编辑工作包，再合成完整 V3。',
    '每个工作包的“真实 V2 原段”均由客户端按 anchorId 从 V2 回填，是本次必须整体重写的源段；绝不是模型转述。',
    '对每一项，必须保留其 preserveMeaning 列出的事件、人物选择、因果和情绪落点，但必须以新的句式、节奏、叙述组织或对白/留白实现 rewriteGoal。',
    '完成所有工作包后，再通读全文，只对未被选中的片段做必要的衔接调整，统一语气、节奏与章末收束。',
    '不得把工作包当作可选参考；不得先全文复述、最后只在少数地方微调。',
    '禁止以删词、改标点或只替换一两个近义词来完成某项工作包。',
    '必须完成 C2 中全部 blocking/error 义务。',
    '不得使用 C2 明确拒绝的 Architect scene。',
    '不得自行创造新的核心人物、能力、组织、关系状态、世界规则或后续剧情事实。',
    '保留 V2 中已经成立的行动、转折、人物选择和后果。',
    '如果 V2 磨掉了 C2 标记的 V1 优质对白、动作或留白，可以恢复或重构。',
    '【义务结算协议】必须逐条处理 C2 finalObligations。正文真实执行的义务写入 appliedObligationIds；没有执行或无法执行的义务写入 unappliedItems。只要存在义务，appliedObligationIds 与 unappliedItems 不得同时为空，禁止用空数组伪装完成。',
    '【声明协议】appliedObligationIds、appliedCanonRequirementIds、appliedStyleRequirementIds 只能填写正文确实执行的精确 ID；不得为了通过校验虚报。若声明已执行但正文没有对应语义变化，本地 Final Validate 会阻断。',
    `V2 当前为 ${input.revisionHan} 个汉字；本章目标 ${view.targetChapterChars}（首选 ${view.preferredMinHan}–${view.preferredMaxHan}）。`,
    v2InBand
      ? `V2 已在目标区间内：V3 保持同量级篇幅（相对 V2 约 ±10%），以润色、履约、去泄漏为主，禁止为凑字注水。`
      : `V2 仍低于首选下限 ${view.preferredMinHan}：你可兜底补写尚未充分展开的核心场景（行动、阻力、人物选择、信息/关系变化、后果），尽量将 V3 提升到 ${view.preferredMinHan} 以上；仍禁止重复心理/环境/空转对白。`,
    '不得追加无关描写，不得重复心理、反应、对白或解释。',
    '每个已回填的 style requirement 都必须在 V3 正文中落实其 rewriteGoal，同时保留该项的 preserveMeaning。',
    'V3 开头必须与“上一章正文接缝”自然衔接；除非 C2 的 finalObligations 显式要求重写开头，否则不要重置已成立的场景承接，也不要复述接缝中已发生的事件。',
    '只输出从章节开头到自然结尾的完整最终章节 JSON。',
  ].join('\n');

  const user = [
    `【绑定】revisionArtifactHash=${input.revisionArtifactHash}`,
    `architectureHash=${input.architectureHash}`,
    `auditContractHash=${input.auditContractHash}`,
    `【本章要求】\n${view.userInstruction || '（无）'}`,
    '【用户锁定规则与硬 Canon】',
    view.lockedRules.map(rule => `- ${rule}`).join('\n') || '- （无）',
    view.canon.hardFacts
      .slice(0, 20)
      .map(fact => `- ${fact.text}`)
      .join('\n') || '- （无）',
    level < 4 ? `【软 Canon 摘要】\n${softCanon.join('\n') || '（无）'}` : '',
    styleBlock(view.style.text),
    primaryAnchorSeamBlock(view.primaryAnchorSeamText),
    // V3 must first act on the per-segment edit work packet; it precedes the
    // full V2 baseline so attention lands on real rewrites, not global echo.
    editWorkPacketBlock,
    `【完整 V2（合成 V3 的章节连续性基线；未被工作包选中的片段保持稳定，仅做必要衔接）】\n${input.revisionContent}`,
    `【C2 finalObligations】\n${JSON.stringify(blockingObligations)}`,
    `【C2 canon requiredCorrections】\n${JSON.stringify(canonCorrections)}`,
    `【C2 真实片段改写清单（原始合同 JSON，与上方工作包一一对应）】\n${JSON.stringify(styleCorrections)}`,
    `【允许使用的 A1 scenes】\n${JSON.stringify(scenes)}`,
    `【V1 protected passages】\n${JSON.stringify(protectedPassages)}`,
    `【C2 rejected scenes】\n${JSON.stringify(
      input.audit.architectureAudit.rejectedScenes,
    )}`,
    `【义务 ID 清单】finalObligations=${finalObligationIds.join(', ') || '（无）'}；canon requiredCorrections=${canonRequirementIds.join(', ') || '（无）'}；style requiredCorrections=${styleRequirementIds.join(', ') || '（无）'}。请在完成正文后逐项结算，不能遗漏。`,
    `【绑定字段最终自检】revisionArtifactHash 必须严格等于 ${input.revisionArtifactHash}；architectureHash 必须严格等于 ${input.architectureHash}；auditContractHash 必须严格等于 ${input.auditContractHash}。三个值必须逐字符复制，不得使用“...”占位符或旧值。`,
    `【输出契约（hash 原样复制；数组只能填写实际执行结果）】\n{"schemaVersion":1,"revisionArtifactHash":"${input.revisionArtifactHash}","architectureHash":"${input.architectureHash}","auditContractHash":"${input.auditContractHash}","content":"完整V3","appliedObligationIds":[],"appliedCanonRequirementIds":[],"appliedStyleRequirementIds":[],"usedArchitectSceneIds":[],"restoredProtectedPassageIds":[],"declaredNewCoreFacts":[],"unappliedItems":[],"validNoOpRequirementIds":[],"validNoOpReasons":{}}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  return {
    messages,
    promptTokens: estimateMessagesTokens(messages),
    compressionLevel: level,
  };
}

/** Compress Final Reviser prompt until it fits, without truncating V2 body. */
export function compileContinuationV5FinalReviserWithinBudget(input: {
  view: ContinuationV5StageViews['final_reviser'];
  revisionContent: string;
  revisionHan: number;
  revisionArtifactHash: string;
  architecture: ContinuationV5ArchitectureEnvelope;
  architectureHash: string;
  audit: ContinuationV5AuditEnvelope;
  auditContractHash: string;
  contextWindow: number;
  maximumOutputTokens: number;
}): {
  ok: boolean;
  messages: ChatMessage[];
  promptTokens: number;
  compressionLevel: FinalReviserCompressionLevel;
  reason: string | null;
} {
  let last = compileContinuationV5FinalReviserMessages({
    ...input,
    compressionLevel: 0,
  });
  for (const level of [0, 1, 2, 3, 4] as FinalReviserCompressionLevel[]) {
    last = compileContinuationV5FinalReviserMessages({
      ...input,
      compressionLevel: level,
    });
    if (last.promptTokens + input.maximumOutputTokens <= input.contextWindow) {
      return {
        ok: true,
        messages: last.messages,
        promptTokens: last.promptTokens,
        compressionLevel: level,
        reason: null,
      };
    }
  }
  return {
    ok: false,
    messages: last.messages,
    promptTokens: last.promptTokens,
    compressionLevel: last.compressionLevel,
    reason: 'final_reviser_prompt_budget_exceeded',
  };
}

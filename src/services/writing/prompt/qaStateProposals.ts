/**
 * B5 — QA/State Shadow（§8：QA + State Proposal 合并，Shadow Mode）。
 *
 * 1. QA 输出契约增加可选 stateProposals（proposalType / subjectRefType /
 *    subjectRefId / payload / evidenceQuote / risk）；模型只输出
 *    evidenceQuote，禁止手算 UTF-16 offset。
 * 2. evidenceQuote 本地解析（§8.4）：exact match → UTF-16 半开区间；
 *    0 命中 reject / 1 命中 accept / 多命中 ambiguous。
 * 3. Shadow Mode（§8.6）：QA 提案与 legacy State Extraction 提案的
 *    影子对比统计（不写第二套长期记忆，只做对比与观测）。
 */
import type { SharedWritingStageName } from '../contracts/writingPolicy';

export const QA_STATE_SHADOW_VERSION = 1 as const;

export const QA_STATE_PROPOSAL_TYPES = [
  'character_state',
  'relationship_change',
  'plot_advance',
  'character_experience',
  'knowledge_change',
  'new_world_fact',
  'new_character',
  'new_location',
  'new_organization',
  'foreshadowing',
  'other',
] as const;

export type QaStateProposalType = (typeof QA_STATE_PROPOSAL_TYPES)[number];

export interface QaStateProposal {
  proposalType: QaStateProposalType;
  subjectRefType?: string;
  subjectRefId?: string;
  payload: Record<string, unknown>;
  /** 模型只给正文引文；offset 由客户端解析（§8.4）。 */
  evidenceQuote: string;
  risk: 'normal' | 'major';
}

export interface ResolvedEvidenceQuote {
  status: 'rejected' | 'accepted' | 'ambiguous';
  /** UTF-16 code-unit inclusive，仅 accepted 时有值。 */
  start?: number;
  /** UTF-16 code-unit exclusive，仅 accepted 时有值。 */
  end?: number;
}

export interface QaStateProposalShadowStats {
  version: typeof QA_STATE_SHADOW_VERSION;
  qaProposalCount: number;
  extractProposalCount: number;
  /** 两侧 evidenceQuote 文本完全一致的条目数（§8.6 对比口径）。 */
  overlapCount: number;
  qaOnlyCount: number;
  extractOnlyCount: number;
  /** 提取侧 contentHash 与最终正文指纹不一致（§8.5 body fingerprint）。 */
  blockedFingerprintMismatch: boolean;
}

/**
 * §8.4 evidenceQuote 本地解析：正文中 exact match → UTF-16 offset。
 * JS string 即 UTF-16 code unit 序列（indexOf/index 天然 utf-16）。
 */
export function resolveEvidenceQuoteLocations(
  body: string,
  quote: string,
): ResolvedEvidenceQuote {
  const cleanedQuote = typeof quote === 'string' ? quote.trim() : '';
  if (!body || !cleanedQuote) {
    return { status: 'rejected' };
  }
  const first = body.indexOf(cleanedQuote);
  if (first < 0) {
    return { status: 'rejected' };
  }
  const second = body.indexOf(cleanedQuote, first + cleanedQuote.length);
  if (second >= 0) {
    return { status: 'ambiguous' };
  }
  return {
    status: 'accepted',
    start: first,
    end: first + cleanedQuote.length,
  };
}

/** §8.3 从 QA structured 提取合法 stateProposals（坏条目过滤）。 */
export function extractQaStateProposals(qaStructured: unknown): QaStateProposal[] {
  if (!qaStructured || typeof qaStructured !== 'object') return [];
  const raw = (qaStructured as Record<string, unknown>).stateProposals;
  if (!Array.isArray(raw)) return [];
  const output: QaStateProposal[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const proposalType = row.proposalType;
    if (
      typeof proposalType !== 'string' ||
      !(QA_STATE_PROPOSAL_TYPES as readonly string[]).includes(proposalType)
    ) {
      continue;
    }
    const evidenceQuote =
      typeof row.evidenceQuote === 'string' ? row.evidenceQuote.trim() : '';
    if (!evidenceQuote) continue;
    const risk = row.risk;
    if (risk !== 'normal' && risk !== 'major') continue;
    const payload =
      row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {};
    output.push({
      proposalType: proposalType as QaStateProposalType,
      ...(typeof row.subjectRefType === 'string' && row.subjectRefType
        ? { subjectRefType: row.subjectRefType }
        : {}),
      ...(typeof row.subjectRefId === 'string' && row.subjectRefId
        ? { subjectRefId: row.subjectRefId }
        : {}),
      payload,
      evidenceQuote,
      risk,
    });
  }
  return output;
}

export interface ShadowExtractProposal {
  proposalType?: string;
  evidenceQuote?: string;
  evidenceStart?: number;
  evidenceEnd?: number;
}

/** §8.6 Shadow Mode：QA 提案 vs legacy 提取提案 的影子统计。 */
export function buildQaStateProposalShadow(input: {
  qaProposals: QaStateProposal[];
  extractProposals: ShadowExtractProposal[];
  extractionContentHash?: string;
  finalBodyFingerprint?: string;
}): QaStateProposalShadowStats {
  const qaQuotes = new Set(input.qaProposals.map(p => p.evidenceQuote));
  let overlapCount = 0;
  for (const extract of input.extractProposals) {
    const quote = typeof extract.evidenceQuote === 'string' ? extract.evidenceQuote : '';
    if (quote && qaQuotes.has(quote)) overlapCount += 1;
  }
  const extractQuotes = new Set(
    input.extractProposals
      .map(p => (typeof p.evidenceQuote === 'string' ? p.evidenceQuote : ''))
      .filter(Boolean),
  );
  const anyShared = overlapCount > 0;
  // 侧内去重后统计：两侧合计 = qa + extract - overlap。
  const extractMatchedCount = input.extractProposals.filter(
    p => typeof p.evidenceQuote === 'string' && qaQuotes.has(p.evidenceQuote),
  ).length;
  const qaMatchedCount = input.qaProposals.filter(p =>
    extractQuotes.has(p.evidenceQuote),
  ).length;
  overlapCount = Math.min(qaMatchedCount, extractMatchedCount);
  void anyShared;
  const fingerprintMismatch =
    Boolean(input.extractionContentHash) &&
    Boolean(input.finalBodyFingerprint) &&
    input.extractionContentHash !== input.finalBodyFingerprint;
  return {
    version: QA_STATE_SHADOW_VERSION,
    qaProposalCount: input.qaProposals.length,
    extractProposalCount: input.extractProposals.length,
    overlapCount,
    qaOnlyCount: input.qaProposals.length - qaMatchedCount,
    extractOnlyCount: input.extractProposals.length - extractMatchedCount,
    blockedFingerprintMismatch: fingerprintMismatch,
  };
}

export interface ResolvedQaProposalRow {
  proposalType: QaStateProposalType;
  payload: Record<string, unknown>;
  risk: 'normal' | 'major';
  evidenceQuote: string;
  /** UTF-16 code-unit inclusive。 */
  evidenceStart: number;
  /** UTF-16 code-unit exclusive。 */
  evidenceEnd: number;
}

/**
 * B6 §8.4/§8.5：QA proposals 的 evidenceQuote 在最终正文上本地解析为
 * UTF-16 offsets；0 命中（rejected）与多命中（ambiguous）的条目不入库。
 */
export function resolveQaProposalsToOffsets(input: {
  proposals: QaStateProposal[];
  finalBody: string;
}): { rows: ResolvedQaProposalRow[]; rejectedCount: number } {
  const rows: ResolvedQaProposalRow[] = [];
  let rejectedCount = 0;
  for (const proposal of input.proposals) {
    const resolved = resolveEvidenceQuoteLocations(input.finalBody, proposal.evidenceQuote);
    if (resolved.status !== 'accepted' || resolved.start === undefined || resolved.end === undefined) {
      rejectedCount += 1;
      continue;
    }
    rows.push({
      proposalType: proposal.proposalType,
      payload: proposal.payload,
      risk: proposal.risk,
      evidenceQuote: proposal.evidenceQuote,
      evidenceStart: resolved.start,
      evidenceEnd: resolved.end,
    });
  }
  return { rows, rejectedCount };
}

export interface QaProposalInsertRow {
  projectId: number;
  chapterId: number;
  sourceRunId: string | null;
  extractionContentHash: string;
  chapterRevisionHash: string;
  proposalType: QaStateProposalType;
  subjectRefType?: string | null;
  subjectRefId?: string | null;
  payloadJson: string;
  evidenceStart: number;
  evidenceEnd: number;
}

/**
 * B6：QA proposals → continuation_state_proposals 同表录入行（pending，
 * 复用 legacy 提案管道；INSERT OR IGNORE 幂等）。contentHash 绑定最终
 * 正文指纹（§8.5：Final != Draft 时 QA 提案失效，不得用它跨正文提交）。
 */
export function buildQaProposalInsertRows(input: {
  proposals: QaStateProposal[];
  finalBody: string;
  finalBodyFingerprint: string;
  projectId: number;
  chapterId: number;
  sourceRunId: string | null;
}): QaProposalInsertRow[] {
  const { rows } = resolveQaProposalsToOffsets({
    proposals: input.proposals,
    finalBody: input.finalBody,
  });
  return rows.map(row => ({
    projectId: input.projectId,
    chapterId: input.chapterId,
    sourceRunId: input.sourceRunId,
    extractionContentHash: input.finalBodyFingerprint,
    chapterRevisionHash: input.finalBodyFingerprint,
    proposalType: row.proposalType,
    payloadJson: JSON.stringify(row.payload),
    evidenceStart: row.evidenceStart,
    evidenceEnd: row.evidenceEnd,
  }));
}

/** §8.3 QA 契约追加段（shall 提示，不强制）。 */
export const QA_STATE_PROPOSAL_CONTRACT = [
  '【状态提案（可选）】',
  '如果当前正文让章节相关的人物状态 / 关系 / 情节进展 / 知识 / 世界事实发生了',
  '    可被下章引用的变化，可输出 stateProposals 数组（没有可省略或输出 []）。',
  '每条只包含：proposalType、subjectRefType、subjectRefId、payload、evidenceQuote、risk(normal|major)。',
  'proposalType 只能是 character_state / relationship_change / plot_advance /',
  '    character_experience / knowledge_change / new_world_fact / new_character /',
  '    new_location / new_organization / foreshadowing / other。',
  'evidenceQuote 必须是当前正文中逐字存在的短引文（4~80 字符）。',
  '【禁止】手算或输出任何 UTF-16 offset / start / end；offset 由客户端解析。',
].join('\n');
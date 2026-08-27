/**
 * B4 — Evidence QA Projection.
 *
 * 将 ONE QA 的宽 union projection（12-kind allowlist）收缩为：
 *   Exact Draft（编译器原有 previousArtifactBlock 提供）
 *   + Chapter Truth Projection（【章节真相】：mandatory truths 永不删除）
 *   + Requirement Checklist（【要求检查清单】：QA 适用的强制要求逐条列出）
 *   + Relevant Evidence（【相关证据】：仅保留正文/接缝命中的相关条目）
 *
 * Fail-safe：高置信（至少一个相关证据命中）→ Evidence Projection；
 * 零命中 / 场景无相关条目 / 输入异常 → enabled=false，调用方回退
 * 现有 union projection。禁止为省 token 硬裁 Canon / Memory / Seam。
 */
import { estimateTokens } from '../../../utils/tokenEstimator';
import type { FrozenWritingContext } from '../contracts/frozenWritingContext';
import type { WritingRequirements } from '../contracts/writingRequirement';
import type { WritingStageArtifacts } from '../contracts/writingStage';
import type { WritingSource, WritingSourceKind } from '../contracts/writingSource';

export const QA_EVIDENCE_PROJECTION_VERSION = 1 as const;

export interface QaEvidenceProjectionResult {
  version: typeof QA_EVIDENCE_PROJECTION_VERSION;
  enabled: boolean;
  /** enabled=false 时的回退原因（fail-safe 审计）。 */
  fallbackReason: 'no-entity-hit' | 'low-confidence' | null;
  /** 【章节真相】+【要求检查清单】+【相关证据】渲染文本。 */
  text: string;
  includedCandidateIds: string[];
  includedKinds: WritingSourceKind[];
  projectedTokens: number;
}

/** §7.2 Mandatory Truth：永不因相关度过滤而删除。 */
const MANDATORY_TRUTH_KINDS: WritingSourceKind[] = [
  'outline',
  'canon',
  'source_boundary',
  'seam',
  'primary_anchor',
  'writer_style',
  'story_memory',
  'structured_continuity_state',
  'preset',
  'instruction',
];

/** §7.3 Relevant Evidence：只选本章真正相关的条目。 */
const RELEVANT_EVIDENCE_KINDS: WritingSourceKind[] = [
  'character',
  'worldbook',
  'note',
  'episodic_memory',
];

/** QA 适用的 requirement kinds（与 requirementProjection 保持同一语义）。 */
const QA_REQUIREMENT_KINDS = new Set<string>([
  'outline',
  'plot',
  'style',
  'user-instruction',
  'obligation',
  'canon',
  'boundary',
  'fact',
  'continuity',
  'character',
  'world-rule',
  // B4 §7.2：上一章 Seam / Boundary 同类 Mandatory Truth 显式进入检查清单
  // （现有【写作要求】投影仍不含 seam/anchor，清单是 QA 专属新增）。
  'seam',
  'anchor',
]);

const CHECKLIST_ITEM_MAX_CHARS = 600;

/**
 * 相关证据的高置信命中判定：条目「实体名」（首段分隔符前的名称或前 8
 * 字符）出现在 初稿正文 + 本章指令/接缝 的归一化文本中。
 */
export function resolveQaEvidenceProjection(input: {
  stage: 'qa';
  frozenContext: FrozenWritingContext;
  artifacts: WritingStageArtifacts;
  requirements: WritingRequirements;
}): QaEvidenceProjectionResult {
  const empty = (reason: 'no-entity-hit' | 'low-confidence'): QaEvidenceProjectionResult => ({
    version: QA_EVIDENCE_PROJECTION_VERSION,
    enabled: false,
    fallbackReason: reason,
    text: '',
    includedCandidateIds: [],
    includedKinds: [],
    projectedTokens: 0,
  });

  const renderedText = input.frozenContext.rendered?.text || '';
  const materials = input.frozenContext.materials ?? [];
  const renderedItems = input.frozenContext.rendered?.items ?? [];
  if (!renderedText || materials.length === 0 || renderedItems.length === 0) {
    return empty('low-confidence');
  }
  const draftBody = readArtifactBody(input.artifacts.draft);
  if (!draftBody.trim()) {
    return empty('low-confidence');
  }

  // --- 相关证据：实体命中过滤 ----------------------------------------
  const kindById = new Map(
    materials.map(item => [item.source.candidateId, item.source.kind]),
  );
  const sourceById = new Map(
    materials.map(item => [item.source.candidateId, item.source]),
  );
  const relevantIds = renderedItems
    .filter(item => item.included)
    .map(item => item.candidateId)
    .filter(id => {
      const kind = kindById.get(id);
      return kind !== undefined && RELEVANT_EVIDENCE_KINDS.includes(kind);
    });
  // Keep the id attached while filtering absent/truncated rendered blocks.
  // Filtering the blocks alone would shift the array index and could make a
  // valid hit inherit the metadata of an earlier candidate whose block was
  // not rendered.
  const relevantBlocks = relevantIds
    .map(id => ({
      id,
      block: extractRenderedBlock(renderedText, kindById.get(id)!, id),
    }))
    .filter(item => Boolean(item.block));

  if (relevantBlocks.length === 0) {
    // 场景没有可过滤的相关条目（例如纯 outline 场景）→ 回退 union。
    return empty('no-entity-hit');
  }

  const instruction = input.frozenContext.instruction;
  const haystack = cleanForMatch(
    [
      draftBody,
      instruction.title || '',
      instruction.synopsis || '',
      instruction.userInstruction || '',
      instruction.currentContent || '',
    ].join('\n'),
  );
  const hitBlocks: string[] = [];
  const hitIds: string[] = [];
  const hitKinds: WritingSourceKind[] = [];
  relevantBlocks.forEach(({ id, block }) => {
    const source = sourceById.get(id);
    const name = entityName(block, source);
    if (!name || name.length < 2 || !haystack.includes(name)) return;
    // A resource card can contain several entities or unrelated facts. Keep
    // the matched entity's compact first fact in the QA projection instead of
    // replaying the whole card; this preserves the hit evidence without
    // smuggling unrelated names into a supposedly narrow input.
    hitBlocks.push(compactEvidenceBlock(block, name, source));
    hitIds.push(id);
    const kind = kindById.get(id)!;
    if (!hitKinds.includes(kind)) hitKinds.push(kind);
  });
  if (hitBlocks.length === 0) {
    // 相关条目存在但正文/接缝零命中 → 低置信，回退 union。
    return empty('no-entity-hit');
  }

  // --- Mandatory Truth：永不删除 --------------------------------------
  const truthBlocks: string[] = [];
  const truthIds: string[] = [];
  const truthKinds: WritingSourceKind[] = [];
  for (const item of renderedItems) {
    if (!item.included) continue;
    const kind = kindById.get(item.candidateId);
    if (!kind || !MANDATORY_TRUTH_KINDS.includes(kind)) continue;
    const block = extractRenderedBlock(renderedText, kind, item.candidateId);
    if (!block) continue;
    truthBlocks.push(block);
    truthIds.push(item.candidateId);
    if (!truthKinds.includes(kind)) truthKinds.push(kind);
  }

  // --- Requirement Checklist ------------------------------------------
  const checklist = input.requirements.items
    .filter(
      item =>
        QA_REQUIREMENT_KINDS.has(item.kind) &&
        (item.severity === 'mandatory' || item.severity === 'blocking'),
    )
    .map(item => `- [ ] (${item.severity === 'blocking' ? '必须' : '必须'}) ${item.text.trim().slice(0, CHECKLIST_ITEM_MAX_CHARS)}`)
    .filter(line => line.length > 5);
  const checklistBlock = checklist.length
    ? ['【要求检查清单】', ...checklist].join('\n')
    : '【要求检查清单】\n（本阶段无强制检查项）';

  const sections: string[] = [
    ['【章节真相】', ...truthBlocks].join('\n'),
    checklistBlock,
    ['【相关证据】', ...hitBlocks.map(block => `${block}（本章相关）`)].join('\n'),
  ];
  const text = sections.filter(Boolean).join('\n\n');

  return {
    version: QA_EVIDENCE_PROJECTION_VERSION,
    enabled: true,
    fallbackReason: null,
    text,
    includedCandidateIds: [...truthIds, ...hitIds],
    includedKinds: [...truthKinds, ...hitKinds],
    projectedTokens: estimateTokens(text),
  };
}

function entityName(block: string, source?: WritingSource): string {
  const sourceText = String(source?.content || '').trim();
  const labeledCharacter = sourceText.match(/角色\s*[「『"]([^」』"]+)[」』"]/);
  if (labeledCharacter?.[1]) return cleanForMatch(labeledCharacter[1]);
  const sourceBody = sourceText.replace(/^【[^\n]*】\s*/u, '').trim();
  const sourceHead = sourceBody.slice(0, 64);
  const sourceSep = sourceHead.search(/[:：,，。;；\s]/);
  if (sourceSep > 0) return cleanForMatch(sourceHead.slice(0, sourceSep));

  // 块形如 【kind:candidateId】\n<正文>；实体名取自正文首段。
  const body = block.split('\n').slice(1).join('\n').trim();
  if (!body) return '';
  const head = body.slice(0, 32);
  const sep = head.search(/[:：,，。;；\s]/);
  const raw = sep > 0 ? head.slice(0, sep) : head.slice(0, 10);
  return cleanForMatch(raw);
}

function compactEvidenceBlock(
  block: string,
  name: string,
  source?: WritingSource,
): string {
  const header = block.split('\n')[0] || '';
  const sourceText = String(source?.content || '').trim();
  const sourceNameIndex = sourceText.indexOf(name);
  const blockBody = block.split('\n').slice(1).join('\n').trim();
  const body = sourceNameIndex >= 0 ? sourceText.slice(sourceNameIndex) : blockBody;
  const normalizedBody = body.replace(/^[」』”"']/, '');
  const boundary = normalizedBody.search(/[，,。；;!?！？\n]/);
  const snippet = (boundary > 0
    ? normalizedBody.slice(0, boundary)
    : normalizedBody.slice(0, Math.max(name.length, 80)))
    .trim();
  return `${header}\n${snippet || name}`.trim();
}

/** 归一化：只保留中文、字母、数字（去掉标点与空白后做包含匹配）。 */
function cleanForMatch(text: string): string {
  return text.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '');
}

function readArtifactBody(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object' && value) {
    const row = value as Record<string, unknown>;
    if (typeof row.body === 'string' && row.body.trim()) return row.body.trim();
    if (typeof row.content === 'string' && row.content.trim()) return row.content.trim();
  }
  return '';
}

function extractRenderedBlock(
  renderedText: string,
  kind: WritingSourceKind,
  candidateId: string,
): string {
  const header = `【${kind}:${candidateId}】`;
  const start = renderedText.indexOf(header);
  if (start < 0) return '';
  const next = renderedText.indexOf('\n\n【', start + header.length);
  return next < 0
    ? renderedText.slice(start).trim()
    : renderedText.slice(start, next).trim();
}

export { MANDATORY_TRUTH_KINDS, RELEVANT_EVIDENCE_KINDS };

/**
 * Outline pipeline V5-Lite — Revision Contract Compiler.
 *
 * Pure function: 0 LLM, 0 database, no time randomness (§10.1). Consumes the
 * canonical draft, stable anchors, and successful V2 audits (Review and/or
 * FactCheck) and produces a deterministic, executable revision contract.
 *
 * Guarantees (§10.4–10.6):
 *   - deterministic priority ordering (fact hard constraint > outline/boundary
 *     > character knowledge/continuity > literary > style warning);
 *   - same-priority keeps original report order; review/factCheck merge order
 *     is fixed (factCheck first);
 *   - no semantic guessing: only structure validation, anchor backfill,
 *     deterministic sorting, exact-duplicate dedup, protection aggregation,
 *     explicit conflict marking;
 *   - fail-closed: invalid required/hard locators drop that whole audit side;
 *     warnings-only invalid locators are dropped and reported.
 */
import type {
  PipelineAuditCorrectionV2,
  PipelineFactCheckReportV2,
  PipelineRevisionAnchor,
  PipelineRevisionContract,
  PipelineRevisionWorkItem,
  PipelineReviewReportV2,
} from '../../types/pipelineRevision';
import { findAnchorById } from './revisionAnchors';
import { sha256Hex } from '../continuation/hashUtils';

export const REVISION_CONTRACT_SCHEMA_VERSION = 1 as const;
export const REVISION_CONTRACT_COMPILER_VERSION = 1 as const;

/**
 * Deterministic severity priority (highest wins).
 * fact hard constraint > outline/boundary > character knowledge/continuity
 * > literary correction > style warning.
 */
const SEVERITY_RANK: Record<PipelineAuditCorrectionV2['severity'], number> = {
  hard: 5,
  required: 4,
  warning: 1,
};

const DIMENSION_HARD_FACT = 'hard_constraint';
const DIMENSION_OUTLINE = 'outline';
const DIMENSION_BOUNDARY = 'boundary';
const DIMENSION_CHARACTER = 'character_knowledge';
const DIMENSION_CONTINUITY = 'continuity';
const DIMENSION_LITERARY = 'literary';
const DIMENSION_STYLE = 'style';

/**
 * Classify a correction's dimension family for deterministic ordering.
 * Unknown dimensions keep the report's original relative order (stable sort).
 */
function dimensionFamily(c: PipelineAuditCorrectionV2): string {
  const d = String(c.dimension || '').toLowerCase();
  if (d.includes('硬约束') || d.includes('事实') || d.includes('hard') || d.includes('constraint')) {
    return DIMENSION_HARD_FACT;
  }
  if (d.includes('大纲') || d.includes('节点') || d.includes('beat') || d.includes('主线')) {
    return DIMENSION_OUTLINE;
  }
  if (d.includes('边界') || d.includes('开头') || d.includes('结尾') || d.includes('boundary')) {
    return DIMENSION_BOUNDARY;
  }
  if (d.includes('人物') || d.includes('角色') || d.includes('知识') || d.includes('信息') || d.includes('character')) {
    return DIMENSION_CHARACTER;
  }
  if (d.includes('连续') || d.includes('状态') || d.includes('continuity')) {
    return DIMENSION_CONTINUITY;
  }
  if (d.includes('文风') || d.includes('风格') || d.includes('style') || d.includes('冗余') || d.includes('节奏') || d.includes('literary') || d.includes('节奏')) {
    return DIMENSION_LITERARY;
  }
  return DIMENSION_LITERARY;
}

const FAMILY_RANK: Record<string, number> = {
  [DIMENSION_HARD_FACT]: 6,
  [DIMENSION_OUTLINE]: 5,
  [DIMENSION_BOUNDARY]: 5,
  [DIMENSION_CHARACTER]: 4,
  [DIMENSION_CONTINUITY]: 4,
  [DIMENSION_LITERARY]: 3,
  [DIMENSION_STYLE]: 1,
};

/** Scope → locator validity check against the anchor list (fail-closed). */
function scopeLocatorsValid(
  c: PipelineAuditCorrectionV2,
  anchors: PipelineRevisionAnchor[],
): boolean {
  switch (c.scope) {
    case 'anchor':
      return !!findAnchorById(anchors, c.anchorId);
    case 'range':
      return (
        Array.isArray(c.anchorIds) &&
        c.anchorIds.length >= 2 &&
        c.anchorIds.every(id => !!findAnchorById(anchors, id))
      );
    case 'insertion':
      return (
        !!findAnchorById(anchors, c.insertionBeforeAnchorId) ||
        !!findAnchorById(anchors, c.insertionAfterAnchorId)
      );
    case 'boundary':
      return true; // boundary may live without a neighboring anchor
    case 'chapter':
      return true;
    default:
      return false;
  }
}

/** Backfill real anchor text/offset for a work item (client-side only). */
function backfillAnchors(
  c: PipelineAuditCorrectionV2,
  anchors: PipelineRevisionAnchor[],
): Array<{ id: string; start: number; end: number; text: string }> {
  const out: Array<{ id: string; start: number; end: number; text: string }> = [];
  const push = (id: string | undefined | null) => {
    const a = findAnchorById(anchors, id);
    if (a) out.push({ id: a.id, start: a.start, end: a.end, text: a.text });
  };
  switch (c.scope) {
    case 'anchor':
      push(c.anchorId);
      break;
    case 'range':
      for (const id of c.anchorIds || []) push(id);
      break;
    case 'insertion':
      push(c.insertionBeforeAnchorId);
      push(c.insertionAfterAnchorId);
      break;
    case 'boundary':
      push(c.anchorId);
      break;
    default:
      break;
  }
  return out;
}

function toWorkItem(c: PipelineAuditCorrectionV2, anchors: PipelineRevisionAnchor[]): PipelineRevisionWorkItem {
  const item: PipelineRevisionWorkItem = {
    id: c.id,
    scope: c.scope,
    dimension: c.dimension,
    severity: c.severity,
    diagnosis: c.diagnosis,
    rewriteGoal: c.rewriteGoal,
    preserveMeaning: c.preserveMeaning || [],
  };
  const backfilled = backfillAnchors(c, anchors);
  if (backfilled.length > 0) item.anchors = backfilled;
  if (c.insertionBeforeAnchorId) item.insertionBeforeAnchorId = c.insertionBeforeAnchorId;
  if (c.insertionAfterAnchorId) item.insertionAfterAnchorId = c.insertionAfterAnchorId;
  if (c.boundary) item.boundary = c.boundary;
  return item;
}

/** Exact structural dedup: identical scope+locator+diagnosis+rewriteGoal. */
function dedupKey(c: PipelineAuditCorrectionV2): string {
  return JSON.stringify({
    scope: c.scope,
    anchorId: c.anchorId ?? null,
    anchorIds: c.anchorIds ?? null,
    insertionBeforeAnchorId: c.insertionBeforeAnchorId ?? null,
    insertionAfterAnchorId: c.insertionAfterAnchorId ?? null,
    boundary: c.boundary ?? null,
    dimension: c.dimension,
    severity: c.severity,
    diagnosis: c.diagnosis,
    rewriteGoal: c.rewriteGoal,
  });
}

export interface CompileRevisionContractInput {
  canonicalDraft: string;
  anchors: PipelineRevisionAnchor[];
  /** Successful Review V2 (optional; twoStage/conditional/partial full). */
  review?: PipelineReviewReportV2 | null;
  /** Successful FactCheck V2 (optional). */
  factCheck?: PipelineFactCheckReportV2 | null;
}

export type CompileRevisionContractResult =
  | {
      ok: true;
      contract: PipelineRevisionContract;
      /** Invalid required/hard locators dropped whole audit sides. */
      warnings: string[];
    }
  | {
      ok: false;
      /** Both audit sides invalid → no contract (draft fallback, no proof). */
      reason: 'no_valid_audit';
      warnings: string[];
    };

/**
 * Compile the revision contract from successful V2 audits.
 * Fail-closed semantics (§10.6):
 *   - required/hard correction with invalid locator → whole side invalid;
 *   - warning with invalid locator → dropped, recorded;
 *   - full mode with one invalid side → compile from the other;
 *   - both invalid → no contract (proof never fires).
 */
export function compileRevisionContract(
  input: CompileRevisionContractInput,
): CompileRevisionContractResult {
  const warnings: string[] = [];
  const draftHash = sha256Hex(String(input.canonicalDraft ?? ''));

  // Validate each audit side; drop entire side when a required/hard locator
  // is invalid (fail-closed), keep only valid warnings.
  function normalizeSide<T extends { requiredCorrections: PipelineAuditCorrectionV2[] }>(
    report: T | null | undefined,
    kind: 'review' | 'factCheck',
  ): { corrections: PipelineAuditCorrectionV2[]; ok: boolean } | null {
    if (!report) return null;
    if (!Array.isArray(report.requiredCorrections)) {
      warnings.push(`${kind} 缺少 requiredCorrections`);
      return { corrections: [], ok: false };
    }
    const kept: PipelineAuditCorrectionV2[] = [];
    for (const c of report.requiredCorrections) {
      if (scopeLocatorsValid(c, input.anchors)) {
        kept.push(c);
        continue;
      }
      if (c.severity === 'warning') {
        warnings.push(`丢弃非法定位的 warning (${kind}: ${c.id})`);
      } else {
        warnings.push(`required/hard 定位非法，整侧失效 (${kind}: ${c.id})`);
        return { corrections: [], ok: false };
      }
    }
    return { corrections: kept, ok: true };
  }

  const reviewSide = normalizeSide(input.review, 'review');
  const factSide = normalizeSide(input.factCheck, 'factCheck');

  // Full mode: one side may be invalid → use the other. If BOTH sides are
  // explicitly provided and BOTH invalid → no contract (draft fallback).
  const reviewCorrections = reviewSide?.ok ? reviewSide.corrections : [];
  const factCorrections = factSide?.ok ? factSide.corrections : [];
  if (input.review && input.factCheck && !reviewSide?.ok && !factSide?.ok) {
    return { ok: false, reason: 'no_valid_audit', warnings };
  }
  if (reviewSide && !reviewSide.ok && !factSide) {
    return { ok: false, reason: 'no_valid_audit', warnings };
  }
  if (factSide && !factSide.ok && !reviewSide) {
    return { ok: false, reason: 'no_valid_audit', warnings };
  }

  // Merge with fixed order: factCheck corrections first, then review.
  // Note: severity ordering happens later; this list preserves the stable
  // report order for equal priorities.
  const merged = [...factCorrections, ...reviewCorrections];

  // Exact-structural dedup (keep first occurrence).
  const seen = new Set<string>();
  const deduped: PipelineAuditCorrectionV2[] = [];
  for (const c of merged) {
    const key = dedupKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }

  // Deterministic priority sort (stable: equal ranks keep report order).
  const sorted = deduped
    .map((c, index) => ({ c, index }))
    .sort((a, b) => {
      const aRank =
        FAMILY_RANK[dimensionFamily(a.c)] ?? 0;
      const bRank =
        FAMILY_RANK[dimensionFamily(b.c)] ?? 0;
      if (aRank !== bRank) return bRank - aRank;
      const aSev = SEVERITY_RANK[a.c.severity] ?? 0;
      const bSev = SEVERITY_RANK[b.c.severity] ?? 0;
      if (aSev !== bSev) return bSev - aSev;
      // Preserve fixed review/factCheck merge order: factCheck (lower index
      // because it was merged first) before review on exact tie.
      return a.index - b.index;
    })
    .map(entry => entry.c);

  const workItems: PipelineRevisionWorkItem[] = sorted.map(c =>
    toWorkItem(c, input.anchors),
  );

  const protectedAnchorIds: string[] = [];
  const seenAnchor = new Set<string>();
  const pushAnchor = (id: string | undefined | null) => {
    if (id && !seenAnchor.has(id)) {
      seenAnchor.add(id);
      protectedAnchorIds.push(id);
    }
  };
  // Protection comes ONLY from the review report's explicit declaration
  // (§6.2). WorkItem locators (anchor/range/insertion/boundary) are revision
  // targets — adding them to the protection set would make the same passage
  // both "must modify" and "must preserve".
  if (input.review) {
    for (const id of input.review.protectedAnchorIds || []) pushAnchor(id);
  }
  // Cross-report conflict (§6.2): when an effective FactCheck required/hard
  // correction targets a review-protected anchor, fact correctness wins —
  // drop it from the protection set and record a deterministic warning.
  const factHardTargets = new Set<string>();
  for (const c of factCorrections) {
    if (c.severity === 'warning') continue;
    if (c.scope === 'anchor' && c.anchorId) factHardTargets.add(c.anchorId);
    if (c.scope === 'range' && Array.isArray(c.anchorIds)) {
      for (const id of c.anchorIds) if (id) factHardTargets.add(id);
    }
  }
  if (factHardTargets.size > 0) {
    for (let i = protectedAnchorIds.length - 1; i >= 0; i -= 1) {
      const id = protectedAnchorIds[i];
      if (factHardTargets.has(id)) {
        protectedAnchorIds.splice(i, 1);
        warnings.push(
          `事实修订优先：保护锚点 ${id} 与 FactCheck required/hard 修订定位冲突，已移出保护集合`,
        );
      }
    }
  }

  const protectedFacts: string[] = [];
  if (input.factCheck) {
    for (const f of input.factCheck.protectedFacts || []) {
      if (!protectedFacts.includes(f)) protectedFacts.push(f);
    }
  }
  const hardConstraints: string[] = [];
  if (input.factCheck) {
    for (const h of input.factCheck.hardConstraints || []) {
      if (!hardConstraints.includes(h)) hardConstraints.push(h);
    }
  }

  const outlineObligations = input.review
    ? {
        fulfilledBeats: [...(input.review.outlineExecution?.fulfilledBeats || [])],
        missingBeats: [...(input.review.outlineExecution?.missingBeats || [])],
        mustPreserve: [...(input.review.outlineExecution?.mustPreserve || [])],
        endingGoal: input.review.outlineExecution?.endingGoal,
        mustNotAdvance: [...(input.review.outlineExecution?.mustNotAdvance || [])],
      }
    : {
        fulfilledBeats: [],
        missingBeats: [],
        mustPreserve: [],
        mustNotAdvance: [],
      };

  const contract: PipelineRevisionContract = {
    schemaVersion: REVISION_CONTRACT_SCHEMA_VERSION,
    compilerVersion: REVISION_CONTRACT_COMPILER_VERSION,
    draftHash,
    ...(input.review ? { reviewHash: hashReport(input.review) } : {}),
    ...(input.factCheck ? { factCheckHash: hashReport(input.factCheck) } : {}),
    workItems,
    protectedAnchorIds,
    protectedFacts,
    hardConstraints,
    outlineObligations,
  };
  return { ok: true, contract, warnings };
}

/** Stable hash of a normalized V2 report (resume fingerprint). */
function hashReport(report: PipelineReviewReportV2 | PipelineFactCheckReportV2): string {
  return sha256Hex(JSON.stringify(report)).slice(0, 32);
}

/**
 * B7 — Anchored Segment Repair inside the existing Revision stage.
 *
 * Anchors, finding-to-anchor binding and patch application are deterministic
 * local work. The model may propose replacement text, but it never supplies
 * offsets and it never gets a second repair request: an invalid segment plan
 * uses the same response's full `content` fallback, otherwise the stage fails
 * closed.
 */
import { sha256Hex } from '../../continuation/hashUtils';
import {
  buildRevisionAnchors,
} from '../../pipeline/revisionAnchors';
import type { PipelineRevisionAnchor } from '../../../types/pipelineRevision';
import type { AggregatedFinding } from '../context/findingsAggregator';

const MIN_LOCAL_NEEDLE_LENGTH = 2;

export interface AnchoredSegmentRepairFinding {
  findingId: string;
  severity: 'blocking' | 'warning';
  issue: string;
  instruction: string;
  target: string;
  evidence: string;
  anchorId: string;
  paragraphHash: string;
  start: number;
  end: number;
  anchorText: string;
}

export interface AnchoredSegmentRepairPlan {
  eligible: boolean;
  reason: string;
  draftHash: string;
  anchors: PipelineRevisionAnchor[];
  findings: AnchoredSegmentRepairFinding[];
}

export type AnchoredSegmentRepairResolution =
  | {
      status: 'not_applicable';
      plan: AnchoredSegmentRepairPlan;
      body: null;
      diagnostics: string[];
    }
  | {
      status: 'segment_repair' | 'full_revision_fallback';
      plan: AnchoredSegmentRepairPlan;
      body: string;
      diagnostics: string[];
      metadata: {
        attempted: true;
        applied: boolean;
        patchCount: number;
        coveredFindingIds: string[];
        coverage: number;
        fallback: 'full_revision' | null;
      };
    }
  | {
      status: 'invalid';
      plan: AnchoredSegmentRepairPlan;
      body: null;
      diagnostics: string[];
      reason: string;
    };

function isLocalFinding(
  finding: AggregatedFinding,
): finding is AggregatedFinding & {
  severity: 'blocking' | 'warning';
} {
  return finding.severity === 'blocking' || finding.severity === 'warning';
}

function findAnchorForFinding(
  finding: AggregatedFinding,
  anchors: PipelineRevisionAnchor[],
): PipelineRevisionAnchor | null {
  const target = finding.target.trim();
  const evidence = finding.evidence.trim();
  const needles = [target, evidence].filter(
    value => value.length >= MIN_LOCAL_NEEDLE_LENGTH,
  );
  for (const needle of needles) {
    if (/^draft-p-\d{3}(?:-s-\d{3})?$/.test(needle)) {
      const byId = anchors.filter(anchor => anchor.id === needle);
      if (byId.length === 1) return byId[0];
      continue;
    }
    const matches = anchors.filter(anchor => anchor.text.includes(needle));
    if (matches.length === 1) return matches[0];
  }
  return null;
}

/**
 * Build the local repair plan. A finding is executable locally only when a
 * concrete target/evidence string maps to exactly one stable anchor. Missing,
 * cross-anchor or chapter-wide findings deliberately select full Revision.
 */
export function buildAnchoredSegmentRepairPlan(input: {
  draftBody: string;
  findings: AggregatedFinding[];
}): AnchoredSegmentRepairPlan {
  const draftBody = String(input.draftBody ?? '');
  const anchors = buildRevisionAnchors(draftBody);
  const executable = input.findings.filter(isLocalFinding);
  if (executable.length === 0) {
    return {
      eligible: false,
      reason: 'no_local_revision_findings',
      draftHash: sha256Hex(draftBody),
      anchors,
      findings: [],
    };
  }

  const mapped: AnchoredSegmentRepairFinding[] = [];
  for (const finding of executable) {
    const anchor = findAnchorForFinding(finding, anchors);
    if (!anchor) {
      return {
        eligible: false,
        reason: `finding_not_bound_to_one_anchor:${finding.findingId}`,
        draftHash: sha256Hex(draftBody),
        anchors,
        findings: [],
      };
    }
    mapped.push({
      findingId: finding.findingId,
      severity: finding.severity,
      issue: finding.issue,
      instruction: finding.instruction,
      target: finding.target,
      evidence: finding.evidence,
      anchorId: anchor.id,
      paragraphHash: sha256Hex(anchor.text),
      start: anchor.start,
      end: anchor.end,
      anchorText: anchor.text,
    });
  }

  return {
    eligible: true,
    reason: 'local_findings_anchored',
    draftHash: sha256Hex(draftBody),
    anchors,
    findings: mapped,
  };
}

/** Prompt block for the existing Revision request; not a new stage. */
export function formatAnchoredSegmentRepairPlan(
  plan: AnchoredSegmentRepairPlan,
): string {
  if (!plan.eligible) return '';
  const lines = [
    '【B7 局部段级修复优先】',
    '当前 Revision 已将每个可执行 finding 绑定到唯一 Draft anchor。',
    `draftHash=${plan.draftHash}`,
    '请优先返回 strategy=segment_repair 与 segmentRepairs 数组；每项只输出 anchorId、paragraphHash、replacementText、findingIds、reason。',
    '不得输出数字 offset；不得改写未列出的 anchor。若无法安全覆盖全部 findings，请在同一个 JSON 中返回 strategy=full_revision、content（完整终稿），作为本次请求的回退，不要要求第二次请求。',
  ];
  for (const finding of plan.findings) {
    lines.push(
      `finding=${finding.findingId} severity=${finding.severity} anchorId=${finding.anchorId} paragraphHash=${finding.paragraphHash} range=[${finding.start},${finding.end})`,
    );
    lines.push(`原文：${finding.anchorText}`);
    lines.push(`问题：${finding.issue}`);
    if (finding.instruction) lines.push(`修复：${finding.instruction}`);
  }
  return lines.join('\n');
}

function hasSegmentRepairShape(structured: Record<string, unknown>): boolean {
  return (
    structured.strategy === 'segment_repair' ||
    Array.isArray(structured.segmentRepairs) ||
    Array.isArray(structured.patches)
  );
}

function hasProtocolLeak(value: string): boolean {
  return (
    value.includes('```') ||
    /(?:evidenceStart|evidenceEnd|segmentRepairs|proposalSourceBodyFingerprint)\s*[:=]/i.test(
      value,
    ) ||
    /<\/?(?:json|previous_output|system|assistant)>/i.test(value)
  );
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .filter(item => typeof item === 'string')
    .map(item => String(item).trim())
    .filter(Boolean);
  return items.length > 0 ? items : [];
}

/**
 * Validate and deterministically apply the model's segment response. A bad
 * plan may fall back to the same response's complete `content`, never to an
 * extra LLM request.
 */
export function resolveAnchoredRevisionOutput(input: {
  draftBody: string;
  findings: AggregatedFinding[];
  structured: Record<string, unknown>;
}): AnchoredSegmentRepairResolution {
  const plan = buildAnchoredSegmentRepairPlan({
    draftBody: input.draftBody,
    findings: input.findings,
  });
  const structured = input.structured;
  if (!hasSegmentRepairShape(structured)) {
    return {
      status: 'not_applicable',
      plan,
      body: null,
      diagnostics: [],
    };
  }

  const fullContent = nonEmptyString(structured.content);
  if (!plan.eligible) {
    if (fullContent) {
      return {
        status: 'full_revision_fallback',
        plan,
        body: fullContent,
        diagnostics: [`segment_repair_not_eligible:${plan.reason}`],
        metadata: {
          attempted: true,
          applied: false,
          patchCount: 0,
          coveredFindingIds: [],
          coverage: 0,
          fallback: 'full_revision',
        },
      };
    }
    return {
      status: 'invalid',
      plan,
      body: null,
      diagnostics: [`segment_repair_not_eligible:${plan.reason}`],
      reason: 'segment_repair_requires_full_revision_content',
    };
  }

  const rawPatches = Array.isArray(structured.segmentRepairs)
    ? structured.segmentRepairs
    : structured.patches;
  const patches = Array.isArray(rawPatches) ? rawPatches : [];
  const byAnchor = new Map(plan.anchors.map(anchor => [anchor.id, anchor]));
  const planFindingIds = new Set(plan.findings.map(item => item.findingId));
  const covered = new Set<string>();
  const normalized: Array<{
    anchor: PipelineRevisionAnchor;
    replacementText: string;
    findingIds: string[];
  }> = [];
  let invalidReason: string | null = null;

  for (const item of patches) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      invalidReason = 'patch_not_object';
      break;
    }
    const row = item as Record<string, unknown>;
    const anchorId = nonEmptyString(row.anchorId);
    const paragraphHash = nonEmptyString(row.paragraphHash);
    const replacementText = nonEmptyString(
      row.replacementText ?? row.replacement,
    );
    const findingIds = stringArray(row.findingIds);
    const anchor = anchorId ? byAnchor.get(anchorId) : undefined;
    if (!anchor || !paragraphHash || paragraphHash !== sha256Hex(anchor.text)) {
      invalidReason = 'anchor_missing_or_hash_mismatch';
      break;
    }
    if (!replacementText || hasProtocolLeak(replacementText)) {
      invalidReason = 'replacement_empty_or_protocol_leak';
      break;
    }
    if (!findingIds || findingIds.length === 0) {
      invalidReason = 'patch_missing_finding_ids';
      break;
    }
    if (normalized.some(previous => previous.anchor.id === anchor.id)) {
      invalidReason = 'duplicate_anchor_patch';
      break;
    }
    for (const findingId of findingIds) {
      if (!planFindingIds.has(findingId) || covered.has(findingId)) {
        invalidReason = 'finding_coverage_invalid';
        break;
      }
      covered.add(findingId);
    }
    if (invalidReason) break;
    if (input.draftBody.slice(anchor.start, anchor.end) !== anchor.text) {
      invalidReason = 'draft_anchor_drift';
      break;
    }
    normalized.push({ anchor, replacementText, findingIds });
  }

  if (!invalidReason) {
    for (const finding of plan.findings) {
      if (!covered.has(finding.findingId)) {
        invalidReason = 'finding_not_covered';
        break;
      }
    }
  }

  if (!invalidReason && normalized.length > 0) {
    const body = [...normalized]
      .sort((left, right) => right.anchor.start - left.anchor.start)
      .reduce(
        (current, patch) =>
          current.slice(0, patch.anchor.start) +
          patch.replacementText +
          current.slice(patch.anchor.end),
        input.draftBody,
      );
    if (!body.trim()) invalidReason = 'assembled_body_empty';
    if (!invalidReason) {
      return {
        status: 'segment_repair',
        plan,
        body,
        diagnostics: ['segment_repair_applied'],
        metadata: {
          attempted: true,
          applied: true,
          patchCount: normalized.length,
          coveredFindingIds: [...covered],
          coverage: covered.size / plan.findings.length,
          fallback: null,
        },
      };
    }
  }

  if (fullContent) {
    return {
      status: 'full_revision_fallback',
      plan,
      body: fullContent,
      diagnostics: [`segment_repair_fallback_full_revision:${invalidReason || 'empty_plan'}`],
      metadata: {
        attempted: true,
        applied: false,
        patchCount: normalized.length,
        coveredFindingIds: [...covered],
        coverage: plan.findings.length > 0 ? covered.size / plan.findings.length : 0,
        fallback: 'full_revision',
      },
    };
  }
  return {
    status: 'invalid',
    plan,
    body: null,
    diagnostics: [`segment_repair_invalid:${invalidReason || 'empty_plan'}`],
    reason: invalidReason || 'empty_segment_repair_plan',
  };
}

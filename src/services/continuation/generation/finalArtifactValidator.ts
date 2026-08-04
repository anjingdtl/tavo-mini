/**
 * Continuation V5 Final Artifact Validator.
 *
 * Zero-request technical delivery check only. No Writer-relative retention,
 * no minimal-intervention gate, no length-based rejection.
 */
import { runDeterministicChecks } from './continuationChecker';
import { countHanCharacters } from './continuationLengthContract';
import {
  CONTINUATION_V5_LENGTH_POLICY,
  diagnoseLengthTelemetry,
  resolveV5LengthTargets,
} from './continuationV5Contracts';
import type {
  ContinuationContextSnapshotV5,
  ContinuationV5ArchitectureEnvelope,
  ContinuationV5AuditEnvelope,
  ContinuationV5FinalEnvelope,
} from './types';

export type FinalArtifactValidationCode =
  | 'final_output_truncated'
  | 'final_invalid_json'
  | 'final_invalid_envelope'
  | 'final_empty_content'
  | 'final_partial_output'
  | 'final_summary_output'
  | 'final_patch_output'
  | 'final_protocol_leakage'
  | 'final_prompt_leakage'
  | 'final_anchor_leakage'
  | 'final_self_duplicate'
  | 'final_source_overlap'
  | 'final_continuation_anchor_overlap'
  | 'final_hash_binding_failed'
  | 'final_required_obligation_unapplied'
  | 'final_rejected_architect_scene_used'
  | 'final_declared_new_core_fact'
  | 'final_unapplied_items'
  | 'final_severe_under_target';

export interface FinalArtifactValidationResult {
  passed: boolean;
  codes: FinalArtifactValidationCode[];
  warnings: FinalArtifactValidationCode[];
  blockingCodes: FinalArtifactValidationCode[];
  actualHan: number;
  targetHan: number;
  targetAttainmentRatio: number;
  details: string[];
}

const SUMMARY_PHRASES = [
  '本章主要讲述',
  '随后众人',
  '经过一番',
  '最终他们',
  '以上为修订',
  '其余内容不变',
  '以下为修改部分',
  '其余内容保持不变',
  '以下是修改',
  '修改说明',
  '此处省略',
  '内容略',
  '（略）',
  '(略)',
  '……（后文不变）',
  '后文不变',
  '全文从略',
];

const PROMPT_LEAK_PATTERNS = [
  /你是 Continuation V5/i,
  /【输出契约】/,
  /schemaVersion\s*[:=]\s*1/,
  /finalObligations/,
  /appliedObligationIds/,
  /system prompt/i,
  /<\/?think>/i,
];

function looksLikeSummary(content: string): boolean {
  const han = countHanCharacters(content);
  if (han < 80) return true;
  const hits = SUMMARY_PHRASES.filter(phrase => content.includes(phrase)).length;
  if (hits >= 2 && han < 400) return true;
  if (/^(摘要|提纲|大纲|修改说明)[:：]/.test(content.trim())) return true;
  return false;
}

function hasProtocolLeakage(content: string): boolean {
  if (/```/.test(content)) return true;
  if (/^\s*\{[\s\S]*"schemaVersion"[\s\S]*\}\s*$/.test(content.trim())) {
    return true;
  }
  if (/<\/?think>/i.test(content)) return true;
  return false;
}

function hasPromptLeakage(content: string): boolean {
  return PROMPT_LEAK_PATTERNS.some(pattern => pattern.test(content));
}

function hasWholeParagraphSelfDuplicate(content: string): boolean {
  const paragraphs = content
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(part => countHanCharacters(part) >= 40);
  const seen = new Set<string>();
  for (const paragraph of paragraphs) {
    const key = paragraph.replace(/\s+/g, '');
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function hasObviousBrokenTail(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  if (/[，、：:；;（(【[]$/.test(trimmed)) return true;
  if (trimmed.length < 20) return true;
  return false;
}

export function validateFinalArtifact(input: {
  envelope: ContinuationV5FinalEnvelope | null;
  finishReason?: string | null;
  snapshot: ContinuationContextSnapshotV5;
  architecture: ContinuationV5ArchitectureEnvelope;
  architectureHash: string;
  audit: ContinuationV5AuditEnvelope;
  auditContractHash: string;
  revisionArtifactHash: string;
  parseErrorCode?: FinalArtifactValidationCode | null;
}): FinalArtifactValidationResult {
  const codes: FinalArtifactValidationCode[] = [];
  const warnings: FinalArtifactValidationCode[] = [];
  const details: string[] = [];
  const targetHan =
    input.snapshot.settingsSnapshot.values.targetChapterChars || 0;
  const targets = resolveV5LengthTargets(
    targetHan,
    input.snapshot.lengthPolicy ?? CONTINUATION_V5_LENGTH_POLICY,
  );

  if (input.finishReason === 'length') {
    codes.push('final_output_truncated');
    details.push('finishReason=length');
  }
  if (input.parseErrorCode) {
    codes.push(input.parseErrorCode);
  }
  if (!input.envelope) {
    if (!codes.includes('final_invalid_envelope') && !input.parseErrorCode) {
      codes.push('final_invalid_envelope');
    }
    return {
      passed: false,
      codes: Array.from(new Set(codes)),
      warnings,
      blockingCodes: Array.from(new Set(codes)),
      actualHan: 0,
      targetHan: targets.targetHan,
      targetAttainmentRatio: 0,
      details,
    };
  }

  const envelope = input.envelope;
  const content = envelope.content ?? '';
  const actualHan = countHanCharacters(content);

  if (!content.trim()) {
    codes.push('final_empty_content');
  }
  if (
    envelope.revisionArtifactHash !== input.revisionArtifactHash ||
    envelope.architectureHash !== input.architectureHash ||
    envelope.auditContractHash !== input.auditContractHash
  ) {
    codes.push('final_hash_binding_failed');
    details.push('envelope hash binding mismatch');
  }

  if (looksLikeSummary(content)) {
    codes.push('final_summary_output');
  }
  if (/其余不变|仅修改以下|patch|diff/i.test(content)) {
    codes.push('final_patch_output');
  }
  if (hasProtocolLeakage(content)) {
    codes.push('final_protocol_leakage');
  }
  if (hasPromptLeakage(content)) {
    codes.push('final_prompt_leakage');
  }
  if (/⟦|⟧|<<REPAIR_|ANCHOR_/.test(content)) {
    codes.push('final_anchor_leakage');
  }
  if (hasWholeParagraphSelfDuplicate(content)) {
    codes.push('final_self_duplicate');
  }
  if (hasObviousBrokenTail(content)) {
    codes.push('final_partial_output');
  }

  // Deterministic seam/overlap checks reused from Checker helpers.
  try {
    const deterministic = runDeterministicChecks(content, input.snapshot as any);
    for (const issue of deterministic) {
      if (issue.subtype === 'source_overlap') {
        codes.push('final_source_overlap');
      }
      if (issue.subtype === 'continuation_anchor_overlap') {
        codes.push('final_continuation_anchor_overlap');
      }
      if (issue.subtype === 'self_duplicate') {
        codes.push('final_self_duplicate');
      }
    }
  } catch {
    // Validator must not throw on optional deterministic helpers.
  }

  const requiredObligationIds = input.audit.finalObligations.map(
    item => item.obligationId,
  );
  const appliedObl = new Set(envelope.appliedObligationIds);
  const missingObl = requiredObligationIds.filter(id => !appliedObl.has(id));
  // Only enforce when the model declared obligations exist; empty fallback
  // still requires unappliedItems=[] and no new core facts.
  if (requiredObligationIds.length > 0 && missingObl.length > 0) {
    // Softened: if model left unappliedItems empty but missed some ids in the
    // applied list, still fail required obligation backfill.
    codes.push('final_required_obligation_unapplied');
    details.push(`missing obligations: ${missingObl.slice(0, 8).join(',')}`);
  }

  if (envelope.unappliedItems.length > 0) {
    codes.push('final_unapplied_items');
  }
  if (envelope.declaredNewCoreFacts.length > 0) {
    codes.push('final_declared_new_core_fact');
  }

  const rejected = new Set(
    input.audit.architectureAudit.rejectedScenes.map(item => item.sceneId),
  );
  const usedRejected = envelope.usedArchitectSceneIds.filter(id =>
    rejected.has(id),
  );
  if (usedRejected.length > 0) {
    codes.push('final_rejected_architect_scene_used');
  }

  const knownSceneIds = new Set(
    input.architecture.sceneUnits.map(scene => scene.sceneId),
  );
  const unknownScenes = envelope.usedArchitectSceneIds.filter(
    id => !knownSceneIds.has(id),
  );
  if (unknownScenes.length > 0) {
    codes.push('final_invalid_envelope');
    details.push(`unknown scenes: ${unknownScenes.slice(0, 6).join(',')}`);
  }

  const lengthTelemetry = diagnoseLengthTelemetry({
    content,
    targetHan: targets.targetHan,
  });
  if (lengthTelemetry.severeUnderTarget) {
    warnings.push('final_severe_under_target');
    details.push(
      `severe under target: ${lengthTelemetry.actualHan}/${targets.targetHan}`,
    );
  }

  // Length never blocks eligibility.
  const uniqueCodes = Array.from(new Set(codes));
  const blockingCodes = uniqueCodes.filter(
    code => code !== 'final_severe_under_target',
  );

  return {
    passed: blockingCodes.length === 0,
    codes: [...uniqueCodes, ...warnings.filter(code => !uniqueCodes.includes(code))],
    warnings,
    blockingCodes,
    actualHan,
    targetHan: targets.targetHan,
    targetAttainmentRatio: lengthTelemetry.targetAttainmentRatio,
    details,
  };
}

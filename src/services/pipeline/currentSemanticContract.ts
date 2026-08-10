import { extractAuditJsonPayload } from '../pipelineAuditValidator';
import { sha256Hex } from '../continuation/hashUtils';
import {
  FACTCHECK_V32_DIMENSIONS,
  REVIEW_V32_COVERAGE,
  type FactCheckV32Category,
  type ReviewV32Category,
} from './auditSemanticEnvelope';
import type {
  NormalizedFactCheckV3,
  NormalizedReviewV3,
} from './briefCompilerTypes';
import type { PipelineRevisionAnchor } from '../../types/pipelineRevision';

/** Current LLM semantic contract. Machine-owned envelopes stay local. */
export const CURRENT_AUDIT_CONTRACT_VERSION = 33 as const;

export interface AuditImmutableEnvelopeV33 {
  schemaVersion: 5;
  auditContractVersion: 33;
  draftHash: string;
  protectedFacts: string[];
  hardConstraints: string[];
  mustNotAdvance: string[];
  mustPreserve: string[];
  endingBoundary: string;
  inputFactRefs: string[];
}

export interface NormalizedReviewV33
  extends Omit<NormalizedReviewV3, 'schemaVersion'> {
  schemaVersion: 5;
  auditContractVersion: 33;
  coverage: { checkedDimensions: ReviewV32Category[] };
  immutableEnvelope: AuditImmutableEnvelopeV33;
}

export interface NormalizedFactCheckV33
  extends Omit<NormalizedFactCheckV3, 'schemaVersion'> {
  schemaVersion: 5;
  auditContractVersion: 33;
  verdict: 'pass' | 'needs_revision' | 'not_applicable';
  confirmedFactRefs: string[];
  coverage: {
    checkedDimensions: FactCheckV32Category[];
    checkedFactRefs: string[];
  };
  immutableEnvelope: AuditImmutableEnvelopeV33;
}

export interface CurrentAuditValidationResult<T> {
  valid: boolean;
  report?: T;
  normalizedText?: string;
  warnings: string[];
  reason?: string;
  details?: {
    missingPaths: string[];
    invalidPaths: string[];
    findingCount: number;
    requiredFindingCount: number;
    coverage: string[];
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max = 1600): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function strings(value: unknown, max = 1600): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => text(item, max))
    .filter(Boolean);
}

function unique(items: string[]): string[] {
  return [...new Set(items.map(item => item.trim()).filter(Boolean))];
}

function arrayOrSingle(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function unwrap(value: unknown, key: 'review' | 'factCheck'): Record<string, unknown> {
  if (!object(value)) return {};
  return object(value[key]) ? (value[key] as Record<string, unknown>) : value;
}

function parsePayload(raw: unknown): Record<string, unknown> | null {
  if (object(raw)) return raw;
  const extracted = extractAuditJsonPayload(String(raw ?? '').trim());
  if (!extracted.jsonText) return null;
  try {
    const parsed = JSON.parse(extracted.jsonText);
    return object(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeLevel(value: unknown): 'hard' | 'required' | 'advisory' | null {
  const key = text(value, 40).toLocaleLowerCase().replace(/[ -]+/g, '_');
  if (key === 'hard' || key === 'blocking' || key === 'critical') return 'hard';
  if (key === 'required' || key === 'must' || key === 'error') return 'required';
  if (key === 'advisory' || key === 'warning' || key === 'suggestion') {
    return 'advisory';
  }
  return null;
}

function normalizeCategory(value: unknown, allowed: readonly string[]): string | null {
  const key = text(value, 80).toLocaleLowerCase().replace(/[ -]+/g, '_');
  if (allowed.includes(key)) return key;
  return null;
}

function normalizeAnchor(
  value: unknown,
  anchors: readonly PipelineRevisionAnchor[],
): string | null {
  const source = object(value) ? value : { value };
  const raw = text(
    source.target ?? source.anchor ?? source.location ?? source.anchorId ?? source.value,
    120,
  ).replace(/^\[|\]$/g, '');
  if (!raw) return null;
  const exact = anchors.find(anchor => anchor.id === raw);
  return exact?.id || null;
}

function stableSourceId(stage: 'review' | 'factCheck', index: number, issue: string, instruction: string): string {
  return `${stage}.${index + 1}.${sha256Hex(JSON.stringify({ stage, issue, instruction })).slice(0, 12)}`;
}

function envelopeBase(params: {
  draftHash: string;
  protectedFacts?: string[];
  hardConstraints?: string[];
  mustNotAdvance?: string[];
  mustPreserve?: string[];
  endingBoundary?: string;
  inputFactRefs?: string[];
}): AuditImmutableEnvelopeV33 {
  return {
    schemaVersion: 5,
    auditContractVersion: 33,
    draftHash: text(params.draftHash, 128),
    protectedFacts: unique(params.protectedFacts || []),
    hardConstraints: unique(params.hardConstraints || []),
    mustNotAdvance: unique(params.mustNotAdvance || []),
    mustPreserve: unique(params.mustPreserve || []),
    endingBoundary: text(params.endingBoundary, 1600),
    inputFactRefs: unique(params.inputFactRefs || []),
  };
}

export function buildReviewImmutableEnvelopeV33(params: {
  draftHash: string;
  protectedFacts?: string[];
  mustNotAdvance?: string[];
  mustPreserve?: string[];
  endingBoundary?: string;
}): AuditImmutableEnvelopeV33 {
  return envelopeBase(params);
}

export function buildFactCheckImmutableEnvelopeV33(params: {
  draftHash: string;
  protectedFacts?: string[];
  hardConstraints?: string[];
  mustNotAdvance?: string[];
  inputFactRefs?: string[];
}): AuditImmutableEnvelopeV33 {
  return envelopeBase(params);
}

function normalizeReviewChecked(value: unknown): ReviewV32Category[] {
  const aliases: Record<string, ReviewV32Category> = {
    opening: 'opening_continuity',
    continuity: 'opening_continuity',
    outline: 'outline_execution',
    character_state: 'character',
    style: 'prose',
    ending: 'ending_boundary',
  };
  return unique(strings(value, 80))
    .map(item => item.toLocaleLowerCase().replace(/[ -]+/g, '_'))
    .map(item => aliases[item] || item)
    .filter((item): item is ReviewV32Category =>
      (REVIEW_V32_COVERAGE as readonly string[]).includes(item),
    );
}

function normalizeFactChecked(value: unknown): string[] {
  return unique(strings(value, 160));
}

function failure<T>(
  reason: string,
  warnings: string[],
  missingPaths: string[],
  invalidPaths: string[],
  findingCount: number,
  requiredFindingCount: number,
  coverage: string[],
): CurrentAuditValidationResult<T> {
  return {
    valid: false,
    reason,
    warnings,
    details: {
      missingPaths,
      invalidPaths,
      findingCount,
      requiredFindingCount,
      coverage,
    },
  };
}

function safeSemanticText(value: unknown): string {
  const serialized = JSON.stringify(value);
  return /<think|protectedanchorids|revision\s*contract|prompt\s*注入/i.test(serialized)
    ? ''
    : serialized;
}

export function validateReviewSemanticPayloadV33(params: {
  raw: unknown;
  envelope: AuditImmutableEnvelopeV33;
  anchors: readonly PipelineRevisionAnchor[];
}): CurrentAuditValidationResult<NormalizedReviewV33> {
  const parsed = parsePayload(params.raw);
  const value = unwrap(parsed, 'review');
  const warnings: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  if (!parsed || !safeSemanticText(value)) {
    return failure('REVIEW_SEMANTIC_INVALID', warnings, ['json'], [], 0, 0, []);
  }
  const verdict =
    value.verdict === 'pass' || value.verdict === 'needs_revision'
      ? value.verdict
      : null;
  if (!verdict) invalid.push('verdict');
  const checked = normalizeReviewChecked(value.checked);
  if (!Array.isArray(value.checked)) missing.push('checked');
  for (const required of REVIEW_V32_COVERAGE) {
    if (!checked.includes(required)) invalid.push(`checked.${required}`);
  }
  const findings = arrayOrSingle(value.findings);
  if (value.findings == null) missing.push('findings');
  const normalized: NormalizedReviewV33['executableCorrections'] = [];
  const advisory: string[] = [];
  let requiredCount = 0;
  for (let index = 0; index < findings.length; index += 1) {
    const row = findings[index];
    if (!object(row)) {
      invalid.push(`findings[${index}]`);
      continue;
    }
    const level = normalizeLevel(row.level ?? row.severity);
    const target = normalizeAnchor(row.target ?? row.anchor, params.anchors);
    const issue = text(row.issue ?? row.finding ?? row.diagnosis);
    const instruction = text(row.instruction ?? row.action ?? row.rewriteGoal);
    if (!level || !target || !issue || !instruction) {
      invalid.push(`findings[${index}]`);
      continue;
    }
    const item = {
      sourceId: stableSourceId('review', index, issue, instruction),
      severity: level === 'advisory' ? ('warning' as const) : level,
      dimension:
        normalizeCategory(row.category ?? row.dimension, [
          'opening_continuity',
          'outline_execution',
          'character',
          'prose',
          'spatial_logic',
          'causality',
          'ending_boundary',
        ]) || 'review',
      diagnosis: issue,
      rewriteGoal: instruction,
      preserveMeaning: strings(row.preserve, 800),
      locationHint: target,
      source: 'review' as const,
    };
    normalized.push(item);
    if (level === 'advisory') advisory.push(issue);
    else requiredCount += 1;
  }
  if (verdict === 'needs_revision' && requiredCount === 0) {
    invalid.push('findings.required_or_hard');
  }
  if (missing.length || invalid.length || !verdict) {
    return failure(
      'REVIEW_SEMANTIC_INVALID',
      warnings,
      missing,
      invalid,
      normalized.length,
      requiredCount,
      checked,
    );
  }
  const preserve = strings(value.preserve, 1200);
  const ending = text(value.ending, 1600);
  const report: NormalizedReviewV33 = {
    schemaVersion: 5,
    auditContractVersion: 33,
    draftHash: params.envelope.draftHash,
    executableCorrections: normalized.filter(item => item.severity !== 'warning'),
    unlocatedRequired: [],
    advisoryNotes: advisory,
    outlineExecution: {
      fulfilledBeats: [],
      missingBeats: [],
      deviations: [],
      prematureBeats: [],
      mustPreserve: unique([...params.envelope.mustPreserve, ...preserve]),
      endingGoal: params.envelope.endingBoundary || ending,
      mustNotAdvance: params.envelope.mustNotAdvance,
    },
    protectedFacts: params.envelope.protectedFacts,
    warnings,
    coverage: { checkedDimensions: checked },
    immutableEnvelope: params.envelope,
  };
  return {
    valid: true,
    report,
    normalizedText: JSON.stringify(report),
    warnings,
    details: {
      missingPaths: [],
      invalidPaths: [],
      findingCount: normalized.length,
      requiredFindingCount: requiredCount,
      coverage: checked,
    },
  };
}

export function validateFactCheckSemanticPayloadV33(params: {
  raw: unknown;
  envelope: AuditImmutableEnvelopeV33;
  inputDimensions?: readonly string[];
  anchors: readonly PipelineRevisionAnchor[];
}): CurrentAuditValidationResult<NormalizedFactCheckV33> {
  const parsed = parsePayload(params.raw);
  const value = unwrap(parsed, 'factCheck');
  const warnings: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  if (!parsed || !safeSemanticText(value)) {
    return failure('FACTCHECK_SEMANTIC_INVALID', warnings, ['json'], [], 0, 0, []);
  }
  const expectedDimensions = unique(
    (params.inputDimensions || []).map(item => String(item).trim()).filter(Boolean),
  );
  const expectedRefs = params.envelope.inputFactRefs;
  const expectedReceipt = unique([...expectedDimensions, ...expectedRefs]);
  const checked = normalizeFactChecked(value.checked);
  if (!Array.isArray(value.checked)) missing.push('checked');
  for (const receipt of expectedReceipt) {
    if (!checked.includes(receipt)) invalid.push(`checked.${receipt}`);
  }
  const verdict =
    value.verdict === 'pass' ||
    value.verdict === 'needs_revision' ||
    value.verdict === 'not_applicable'
      ? value.verdict
      : null;
  if (!verdict) invalid.push('verdict');
  if (expectedReceipt.length && verdict === 'not_applicable') {
    invalid.push('verdict.not_applicable_with_input');
  }
  const findings = arrayOrSingle(value.findings);
  if (value.findings == null) missing.push('findings');
  const normalized: NormalizedFactCheckV33['corrections'] = [];
  let requiredCount = 0;
  for (let index = 0; index < findings.length; index += 1) {
    const row = findings[index];
    if (!object(row)) {
      invalid.push(`findings[${index}]`);
      continue;
    }
    const level = normalizeLevel(row.level ?? row.severity);
    const target = normalizeAnchor(row.target ?? row.anchor, params.anchors);
    const issue = text(row.issue ?? row.finding ?? row.diagnosis);
    const instruction = text(row.instruction ?? row.action ?? row.rewriteGoal);
    if (!level || !target || !issue || !instruction) {
      invalid.push(`findings[${index}]`);
      continue;
    }
    normalized.push({
      sourceId: stableSourceId('factCheck', index, issue, instruction),
      severity: level === 'advisory' ? ('warning' as const) : level,
      dimension:
        normalizeCategory(row.category ?? row.dimension, FACTCHECK_V32_DIMENSIONS) ||
        'fact',
      diagnosis: issue,
      rewriteGoal: instruction,
      preserveMeaning: strings(row.preserve, 800),
      locationHint: target,
      source: 'factCheck' as const,
    });
    if (level !== 'advisory') requiredCount += 1;
  }
  if (verdict === 'needs_revision' && requiredCount === 0) {
    invalid.push('findings.required_or_hard');
  }
  if (missing.length || invalid.length || !verdict) {
    return failure(
      'FACTCHECK_SEMANTIC_INVALID',
      warnings,
      missing,
      invalid,
      normalized.length,
      requiredCount,
      checked,
    );
  }
  const checkedDimensions = checked.filter((item): item is FactCheckV32Category =>
    (FACTCHECK_V32_DIMENSIONS as readonly string[]).includes(item),
  );
  const checkedFactRefs = checked.filter(item => expectedRefs.includes(item));
  const report: NormalizedFactCheckV33 = {
    schemaVersion: 5,
    auditContractVersion: 33,
    draftHash: params.envelope.draftHash,
    verdict,
    corrections: normalized,
    protectedFacts: params.envelope.protectedFacts,
    hardConstraints: params.envelope.hardConstraints,
    warnings,
    confirmedFactRefs: checkedFactRefs,
    coverage: { checkedDimensions, checkedFactRefs },
    immutableEnvelope: params.envelope,
  };
  return {
    valid: true,
    report,
    normalizedText: JSON.stringify(report),
    warnings,
    details: {
      missingPaths: [],
      invalidPaths: [],
      findingCount: normalized.length,
      requiredFindingCount: requiredCount,
      coverage: checked,
    },
  };
}

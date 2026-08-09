import { sha256Hex } from '../continuation/hashUtils';
import type {
  NormalizedCorrectionV3,
  NormalizedFactCheckV3,
  NormalizedReviewV3,
} from './briefCompilerTypes';

export const REVIEW_V32_COVERAGE = [
  'opening_continuity',
  'outline_execution',
  'character',
  'prose',
  'ending_boundary',
] as const;

export const REVIEW_V32_DIMENSIONS = [
  ...REVIEW_V32_COVERAGE,
  'spatial_logic',
  'causality',
] as const;

export const FACTCHECK_V32_DIMENSIONS = [
  'timeline',
  'character_state',
  'object_state',
  'world_rule',
  'spatial_logic',
  'knowledge_boundary',
  'outline_boundary',
] as const;

export type ReviewV32Category = (typeof REVIEW_V32_DIMENSIONS)[number];
export type FactCheckV32Category = (typeof FACTCHECK_V32_DIMENSIONS)[number];
export type AuditV32Severity = 'hard' | 'required' | 'advisory';
export type AuditV32TargetKind =
  | 'opening'
  | 'scene'
  | 'middle'
  | 'ending'
  | 'global';

export interface AuditV32Target {
  kind: AuditV32TargetKind;
  sceneHint?: string;
  evidenceQuote?: string;
}

export interface ReviewSemanticPayloadV32 {
  verdict: 'pass' | 'needs_revision';
  findings: Array<{
    severity: AuditV32Severity;
    category: ReviewV32Category;
    target: AuditV32Target;
    finding: string;
    instruction: string;
    preserve: string[];
  }>;
  outlineAssessment: {
    fulfilled: string[];
    missing: string[];
    deviations: string[];
    premature: string[];
    endingAssessment: string;
  };
  coverage: { checkedDimensions: ReviewV32Category[] };
}

export interface FactCheckSemanticPayloadV32 {
  verdict: 'pass' | 'needs_revision' | 'not_applicable';
  findings: Array<{
    severity: AuditV32Severity;
    category: FactCheckV32Category;
    target: AuditV32Target;
    factRef?: string;
    finding: string;
    instruction: string;
  }>;
  confirmedFactRefs: string[];
  coverage: {
    checkedDimensions: FactCheckV32Category[];
    checkedFactRefs: string[];
  };
}

export interface AuditImmutableEnvelopeV32 {
  schemaVersion: 4;
  auditContractVersion: 32;
  draftHash: string;
  protectedFacts: string[];
  hardConstraints: string[];
  mustNotAdvance: string[];
  mustPreserve: string[];
  endingBoundary: string;
  inputFactRefs: string[];
}

export interface NormalizedReviewV32
  extends Omit<NormalizedReviewV3, 'schemaVersion'> {
  schemaVersion: 4;
  auditContractVersion: 32;
  verdict: ReviewSemanticPayloadV32['verdict'];
  coverage: { checkedDimensions: ReviewV32Category[] };
  immutableEnvelope: AuditImmutableEnvelopeV32;
}

export interface NormalizedFactCheckV32
  extends Omit<NormalizedFactCheckV3, 'schemaVersion'> {
  schemaVersion: 4;
  auditContractVersion: 32;
  verdict: FactCheckSemanticPayloadV32['verdict'];
  confirmedFactRefs: string[];
  coverage: FactCheckSemanticPayloadV32['coverage'];
  immutableEnvelope: AuditImmutableEnvelopeV32;
}

export interface AuditSemanticValidationResult<T> {
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
    coverageDimensions: string[];
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max = 1200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function strings(value: unknown, max = 1200): string[] {
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

function alias(value: unknown): string {
  return text(value)
    .toLocaleLowerCase()
    .replace(/[ -]+/g, '_');
}

function normalizeSeverity(value: unknown): AuditV32Severity | null {
  const key = alias(value);
  if (key === 'hard' || key === 'blocking' || key === 'critical') return 'hard';
  if (key === 'required' || key === 'must' || key === 'error') return 'required';
  if (key === 'advisory' || key === 'warning' || key === 'suggestion') {
    return 'advisory';
  }
  return null;
}

function normalizeTarget(value: unknown): AuditV32Target | null {
  const source = isObject(value) ? value : { kind: value };
  const rawKind = alias(source.kind ?? source.location ?? source.target);
  const kind =
    rawKind === 'opening' || rawKind === 'beginning'
      ? 'opening'
      : rawKind === 'scene' || rawKind === 'current_scene'
      ? 'scene'
      : rawKind === 'middle' || rawKind === 'body'
      ? 'middle'
      : rawKind === 'ending' || rawKind === 'end'
      ? 'ending'
      : rawKind === 'global' || rawKind === 'chapter'
      ? 'global'
      : null;
  if (!kind) return null;
  const target: AuditV32Target = { kind };
  const sceneHint = text(source.sceneHint ?? source.hint ?? source.locationHint);
  const evidenceQuote = text(
    source.evidenceQuote ?? source.evidence ?? source.draftQuote,
    800,
  );
  if (sceneHint) target.sceneHint = sceneHint;
  if (evidenceQuote) target.evidenceQuote = evidenceQuote;
  return target;
}

function normalizeReviewCategory(value: unknown): ReviewV32Category | null {
  const key = alias(value);
  const mapped: Record<string, ReviewV32Category> = {
    opening_continuity: 'opening_continuity',
    opening: 'opening_continuity',
    continuity: 'opening_continuity',
    outline_execution: 'outline_execution',
    outline: 'outline_execution',
    character: 'character',
    character_state: 'character',
    prose: 'prose',
    style: 'prose',
    spatial_logic: 'spatial_logic',
    spatial: 'spatial_logic',
    causality: 'causality',
    cause_effect: 'causality',
    ending_boundary: 'ending_boundary',
    ending: 'ending_boundary',
  };
  return mapped[key] || null;
}

function normalizeFactCategory(value: unknown): FactCheckV32Category | null {
  const key = alias(value);
  const mapped: Record<string, FactCheckV32Category> = {
    timeline: 'timeline',
    time: 'timeline',
    character_state: 'character_state',
    character: 'character_state',
    object_state: 'object_state',
    object: 'object_state',
    world_rule: 'world_rule',
    world: 'world_rule',
    spatial_logic: 'spatial_logic',
    spatial: 'spatial_logic',
    knowledge_boundary: 'knowledge_boundary',
    knowledge: 'knowledge_boundary',
    outline_boundary: 'outline_boundary',
    outline: 'outline_boundary',
  };
  return mapped[key] || null;
}

function stableSourceId(
  stage: 'review' | 'factCheck',
  index: number,
  category: string,
  finding: string,
  instruction: string,
): string {
  const digest = sha256Hex(
    JSON.stringify({ stage, category, finding, instruction }),
  ).slice(0, 12);
  return stage + '.' + String(index + 1) + '.' + category + '.' + digest;
}

function localEnvelope(params: {
  draftHash: string;
  protectedFacts?: string[];
  hardConstraints?: string[];
  mustNotAdvance?: string[];
  mustPreserve?: string[];
  endingBoundary?: string;
  inputFactRefs?: string[];
}): AuditImmutableEnvelopeV32 {
  return {
    schemaVersion: 4,
    auditContractVersion: 32,
    draftHash: text(params.draftHash, 128),
    protectedFacts: unique(params.protectedFacts || []),
    hardConstraints: unique(params.hardConstraints || []),
    mustNotAdvance: unique(params.mustNotAdvance || []),
    mustPreserve: unique(params.mustPreserve || []),
    endingBoundary: text(params.endingBoundary, 1200),
    inputFactRefs: unique(params.inputFactRefs || []),
  };
}

function resultFailure<T>(
  reason: string,
  warnings: string[],
  details: AuditSemanticValidationResult<T>['details'],
): AuditSemanticValidationResult<T> {
  return { valid: false, reason, warnings, details };
}

function unwrap(raw: unknown, key: 'review' | 'factCheck'): Record<string, unknown> {
  if (!isObject(raw)) return {};
  const nested = raw[key];
  return isObject(nested) ? nested : raw;
}

function modelEnvelopeWarnings(
  raw: Record<string, unknown>,
  envelope: AuditImmutableEnvelopeV32,
): string[] {
  const warnings: string[] = [];
  if (raw.schemaVersion !== undefined && Number(raw.schemaVersion) !== 4) {
    warnings.push('schemaVersion 已由本地 V3.2 信封覆盖');
  }
  if (
    raw.auditContractVersion !== undefined &&
    Number(raw.auditContractVersion) !== 32
  ) {
    warnings.push('auditContractVersion 已由本地 V3.2 信封覆盖');
  }
  if (
    raw.draftHash !== undefined &&
    text(raw.draftHash, 128) !== envelope.draftHash
  ) {
    warnings.push('draftHash 已由本地 V3.2 信封覆盖');
  }
  return warnings;
}

export function buildReviewImmutableEnvelopeV32(params: {
  draftHash: string;
  protectedFacts?: string[];
  mustNotAdvance?: string[];
  mustPreserve?: string[];
  endingBoundary?: string;
}): AuditImmutableEnvelopeV32 {
  return localEnvelope(params);
}

export function buildFactCheckImmutableEnvelopeV32(params: {
  draftHash: string;
  protectedFacts?: string[];
  hardConstraints?: string[];
  mustNotAdvance?: string[];
  inputFactRefs?: string[];
}): AuditImmutableEnvelopeV32 {
  return localEnvelope(params);
}

/**
 * Stable, body-free IDs for the frozen fact inputs a FactCheck actually saw.
 * The model may return these IDs as coverage receipts, while the source text
 * and the authoritative envelope remain local-only.
 */
export function buildFactCheckInputRefsV32(
  inputs: ReadonlyArray<{ key: string; text?: string | null }>,
): string[] {
  return unique(
    inputs
      .map(input => {
        const body = text(input.text, 20000);
        const key = alias(input.key).replace(/[^a-z0-9_]+/g, '_');
        return body && key
          ? `fact.${key}.${sha256Hex(body).slice(0, 12)}`
          : '';
      })
      .filter(Boolean),
  );
}

export function validateReviewSemanticPayloadV32(params: {
  raw: unknown;
  envelope: AuditImmutableEnvelopeV32;
  legalSourceIds?: readonly string[];
}): AuditSemanticValidationResult<NormalizedReviewV32> {
  const value = unwrap(params.raw, 'review');
  const warnings = modelEnvelopeWarnings(value, params.envelope);
  const missingPaths: string[] = [];
  const invalidPaths: string[] = [];
  const verdict =
    value.verdict === 'pass' || value.verdict === 'needs_revision'
      ? value.verdict
      : null;
  if (!verdict) invalidPaths.push('verdict');
  const rawCoverage = isObject(value.coverage) ? value.coverage : {};
  const checkedDimensions = unique(
    strings(rawCoverage.checkedDimensions),
  ).filter((item): item is ReviewV32Category =>
    (REVIEW_V32_DIMENSIONS as readonly string[]).includes(item),
  );
  if (!isObject(value.coverage)) missingPaths.push('coverage');
  if (!checkedDimensions.length) missingPaths.push('coverage.checkedDimensions');
  if (value.findings == null) missingPaths.push('findings');
  for (const required of REVIEW_V32_COVERAGE) {
    if (!checkedDimensions.includes(required)) {
      invalidPaths.push('coverage.checkedDimensions.' + required);
    }
  }
  const assessmentValue = isObject(value.outlineAssessment)
    ? value.outlineAssessment
    : null;
  if (!assessmentValue) missingPaths.push('outlineAssessment');
  const outline = {
    fulfilled: strings(assessmentValue?.fulfilled ?? assessmentValue?.fulfilledBeats),
    missing: strings(assessmentValue?.missing ?? assessmentValue?.missingBeats),
    deviations: strings(assessmentValue?.deviations),
    premature: strings(assessmentValue?.premature ?? assessmentValue?.prematureBeats),
    endingAssessment: text(
      assessmentValue?.endingAssessment ?? assessmentValue?.endingGoal,
    ),
  };
  const findings: NormalizedCorrectionV3[] = [];
  let requiredFindingCount = 0;
  const usedSourceIds = new Set<string>();
  for (let index = 0; index < arrayOrSingle(value.findings).length; index += 1) {
    const rawFinding = arrayOrSingle(value.findings)[index];
    if (!isObject(rawFinding)) {
      invalidPaths.push('findings[' + String(index) + ']');
      continue;
    }
    const severity = normalizeSeverity(rawFinding.severity);
    const category = normalizeReviewCategory(
      rawFinding.category ?? rawFinding.dimension,
    );
    const target = normalizeTarget(
      rawFinding.target ?? rawFinding.location ?? rawFinding.sceneHint,
    );
    const finding = text(
      rawFinding.finding ??
        rawFinding.diagnosis ??
        rawFinding.description ??
        rawFinding.issue,
    );
    const instruction = text(
      rawFinding.instruction ??
        rawFinding.suggestedAction ??
        rawFinding.rewriteGoal ??
        rawFinding.action,
    );
    const modelSourceId = text(rawFinding.sourceId ?? rawFinding.id, 160);
    if (!severity || !category || !target || !finding || !instruction) {
      invalidPaths.push('findings[' + String(index) + ']');
      continue;
    }
    const sourceId =
      params.legalSourceIds !== undefined
        ? params.legalSourceIds.includes(modelSourceId)
          ? modelSourceId
          : ''
        : stableSourceId('review', index, category, finding, instruction);
    if (!sourceId || usedSourceIds.has(sourceId)) {
      invalidPaths.push('findings[' + String(index) + '].sourceId');
      continue;
    }
    usedSourceIds.add(sourceId);
    if (severity === 'hard' || severity === 'required') {
      requiredFindingCount += 1;
      if (!target.kind || !finding || !instruction) {
        invalidPaths.push('findings[' + String(index) + '].required_fields');
      }
    }
    findings.push({
      sourceId,
      severity: severity === 'advisory' ? 'warning' : severity,
      dimension: category,
      diagnosis: finding,
      rewriteGoal: instruction,
      preserveMeaning: strings(rawFinding.preserve ?? rawFinding.preserveMeaning, 400),
      locationHint: target.kind,
      evidenceQuote: target.evidenceQuote,
      source: 'review',
      sceneHint: target.sceneHint,
    });
  }
  if (verdict === 'needs_revision' && requiredFindingCount === 0) {
    invalidPaths.push('findings.required_or_hard');
  }
  if (verdict === 'pass' && findings.some(item => item.severity !== 'warning')) {
    warnings.push('Review verdict=pass 但包含必改 finding，保留 finding 并按 fail-closed 语义处理');
  }
  if (params.envelope.mustNotAdvance.length) {
    for (const item of outline.premature) {
      if (!params.envelope.mustNotAdvance.includes(item)) {
        warnings.push('premature outline 由本地 ending boundary 约束覆盖：' + item.slice(0, 120));
      }
    }
  }
  if (missingPaths.length || invalidPaths.length || !verdict) {
    return resultFailure(
      'REVIEW_SEMANTIC_INVALID',
      warnings,
      {
        missingPaths,
        invalidPaths,
        findingCount: findings.length,
        requiredFindingCount,
        coverageDimensions: checkedDimensions,
      },
    );
  }
  const report: NormalizedReviewV32 = {
    schemaVersion: 4,
    auditContractVersion: 32,
    draftHash: params.envelope.draftHash,
    verdict,
    executableCorrections: findings.filter(item => item.severity !== 'warning'),
    unlocatedRequired: [],
    advisoryNotes: findings
      .filter(item => item.severity === 'warning')
      .map(item => item.diagnosis),
    outlineExecution: {
      fulfilledBeats: outline.fulfilled,
      missingBeats: outline.missing,
      deviations: outline.deviations,
      prematureBeats: outline.premature,
      mustPreserve: params.envelope.mustPreserve,
      endingGoal: params.envelope.endingBoundary || outline.endingAssessment,
      mustNotAdvance: params.envelope.mustNotAdvance,
    },
    protectedFacts: params.envelope.protectedFacts,
    warnings,
    coverage: { checkedDimensions },
    immutableEnvelope: params.envelope,
  };
  return {
    valid: true,
    report,
    normalizedText: JSON.stringify(report),
    warnings,
    details: {
      missingPaths,
      invalidPaths,
      findingCount: findings.length,
      requiredFindingCount,
      coverageDimensions: checkedDimensions,
    },
  };
}

export function validateFactCheckSemanticPayloadV32(params: {
  raw: unknown;
  envelope: AuditImmutableEnvelopeV32;
  inputDimensions?: FactCheckV32Category[];
  legalSourceIds?: readonly string[];
}): AuditSemanticValidationResult<NormalizedFactCheckV32> {
  const value = unwrap(params.raw, 'factCheck');
  const warnings = modelEnvelopeWarnings(value, params.envelope);
  const missingPaths: string[] = [];
  const invalidPaths: string[] = [];
  const verdict =
    value.verdict === 'pass' ||
    value.verdict === 'needs_revision' ||
    value.verdict === 'not_applicable'
      ? value.verdict
      : null;
  if (!verdict) invalidPaths.push('verdict');
  const coverageValue = isObject(value.coverage) ? value.coverage : {};
  const checkedDimensions = unique(strings(coverageValue.checkedDimensions)).filter(
    (item): item is FactCheckV32Category =>
      (FACTCHECK_V32_DIMENSIONS as readonly string[]).includes(item),
  );
  const checkedFactRefs = unique(strings(coverageValue.checkedFactRefs, 160));
  const confirmedFactRefs = unique(strings(value.confirmedFactRefs, 160));
  if (!isObject(value.coverage)) missingPaths.push('coverage');
  if (value.findings == null) missingPaths.push('findings');
  const findings: NormalizedCorrectionV3[] = [];
  let requiredFindingCount = 0;
  const usedSourceIds = new Set<string>();
  for (let index = 0; index < arrayOrSingle(value.findings).length; index += 1) {
    const rawFinding = arrayOrSingle(value.findings)[index];
    if (!isObject(rawFinding)) {
      invalidPaths.push('findings[' + String(index) + ']');
      continue;
    }
    const severity = normalizeSeverity(rawFinding.severity);
    const category = normalizeFactCategory(
      rawFinding.category ?? rawFinding.dimension,
    );
    const target = normalizeTarget(
      rawFinding.target ?? rawFinding.location ?? rawFinding.sceneHint,
    );
    const finding = text(
      rawFinding.finding ??
        rawFinding.diagnosis ??
        rawFinding.description ??
        rawFinding.issue,
    );
    const instruction = text(
      rawFinding.instruction ??
        rawFinding.suggestedAction ??
        rawFinding.rewriteGoal ??
        rawFinding.action,
    );
    const modelSourceId = text(rawFinding.sourceId ?? rawFinding.id, 160);
    if (!severity || !category || !target || !finding || !instruction) {
      invalidPaths.push('findings[' + String(index) + ']');
      continue;
    }
    const sourceId =
      params.legalSourceIds !== undefined
        ? params.legalSourceIds.includes(modelSourceId)
          ? modelSourceId
          : ''
        : stableSourceId(
            'factCheck',
            index,
            category,
            finding,
            instruction,
          );
    if (!sourceId || usedSourceIds.has(sourceId)) {
      invalidPaths.push('findings[' + String(index) + '].sourceId');
      continue;
    }
    usedSourceIds.add(sourceId);
    if (severity === 'hard' || severity === 'required') requiredFindingCount += 1;
    findings.push({
      sourceId,
      severity: severity === 'advisory' ? 'warning' : severity,
      dimension: category,
      diagnosis: finding,
      rewriteGoal: instruction,
      preserveMeaning: [],
      locationHint: target.kind,
      evidenceQuote: target.evidenceQuote,
      source: 'factCheck',
      sourceRefs: rawFinding.factRef ? [text(rawFinding.factRef, 160)] : undefined,
    });
  }
  const inputDimensions = params.inputDimensions || [];
  if (verdict === 'pass') {
    if (!checkedDimensions.length) invalidPaths.push('coverage.checkedDimensions');
    for (const dimension of inputDimensions) {
      if (!checkedDimensions.includes(dimension)) {
        invalidPaths.push('coverage.checkedDimensions.' + dimension);
      }
    }
    if (
      params.envelope.inputFactRefs.length &&
      !checkedFactRefs.some(id => params.envelope.inputFactRefs.includes(id)) &&
      !confirmedFactRefs.some(id => params.envelope.inputFactRefs.includes(id))
    ) {
      invalidPaths.push('coverage.checkedFactRefs');
    }
  }
  if (verdict === 'needs_revision' && requiredFindingCount === 0) {
    invalidPaths.push('findings.required_or_hard');
  }
  if (verdict === 'not_applicable') {
    warnings.push('FACT_CONTEXT_EMPTY');
    if (inputDimensions.length) {
      invalidPaths.push('verdict.not_applicable_with_input_dimensions');
    }
  }
  if (missingPaths.length || invalidPaths.length || !verdict) {
    return resultFailure(
      'FACTCHECK_SEMANTIC_INVALID',
      warnings,
      {
        missingPaths,
        invalidPaths,
        findingCount: findings.length,
        requiredFindingCount,
        coverageDimensions: checkedDimensions,
      },
    );
  }
  const report: NormalizedFactCheckV32 = {
    schemaVersion: 4,
    auditContractVersion: 32,
    draftHash: params.envelope.draftHash,
    verdict,
    corrections: findings,
    protectedFacts: params.envelope.protectedFacts,
    hardConstraints: params.envelope.hardConstraints,
    confirmedFactRefs,
    coverage: { checkedDimensions, checkedFactRefs },
    warnings,
    immutableEnvelope: params.envelope,
  };
  return {
    valid: true,
    report,
    normalizedText: JSON.stringify(report),
    warnings,
    details: {
      missingPaths,
      invalidPaths,
      findingCount: findings.length,
      requiredFindingCount,
      coverageDimensions: checkedDimensions,
    },
  };
}

/**
 * Build the local source manifest used by the one-shot Formatter.  The
 * manifest is derived from the primary candidate, never from model-provided
 * IDs, so a Formatter cannot invent new authoritative findings.
 */
export function buildAuditSourceManifest(
  stage: 'review' | 'factCheck',
  raw: unknown,
): string[] {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const value = unwrap(parsed, stage);
  const findings = arrayOrSingle(value.findings);
  const ids: string[] = [];
  for (let index = 0; index < findings.length; index += 1) {
    const item = findings[index];
    if (!isObject(item)) continue;
    const category =
      stage === 'review'
        ? normalizeReviewCategory(item.category ?? item.dimension)
        : normalizeFactCategory(item.category ?? item.dimension);
    const finding = text(
      item.finding ?? item.diagnosis ?? item.description ?? item.issue,
    );
    const instruction = text(
      item.instruction ??
        item.suggestedAction ??
        item.rewriteGoal ??
        item.action,
    );
    if (!category || !finding || !instruction) continue;
    ids.push(stableSourceId(stage, index, category, finding, instruction));
  }
  return unique(ids);
}

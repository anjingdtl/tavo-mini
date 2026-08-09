import type { PipelineStageName } from '../../types/pipeline';
import type { LLMResult } from '../llm/types';
import { extractAuditJsonPayload } from '../pipelineAuditValidator';

type V31AuditStage = Extract<PipelineStageName, 'review' | 'factCheck'>;

export type V31AuditAdaptation =
  | 'none'
  | 'local_fields_completed'
  | 'legacy_review_shape'
  | 'legacy_fact_check_shape'
  | 'v2_review_shape'
  | 'v2_fact_check_shape';

export interface V31AuditCompatibilityResult {
  result: LLMResult;
  adaptation: V31AuditAdaptation;
}

const V31_CATEGORIES = new Set([
  'opening_continuity',
  'outline_execution',
  'character',
  'character_state',
  'world_rule',
  'object_state',
  'knowledge_boundary',
  'outline_boundary',
  'timeline',
  'space',
  'spatial_logic',
  'causality',
  'style',
  'prose',
  'ending_boundary',
]);

const V31_TARGETS = new Set(['opening', 'scene', 'middle', 'ending', 'global']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max = 800): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function strings(value: unknown, max = 60): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => typeof item === 'string' && item.trim())
    .slice(0, max)
    .map(item => text(item, 320));
}

function firstText(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const candidate = text(value[key]);
    if (candidate) return candidate;
  }
  return '';
}

function itemText(value: unknown): string {
  if (typeof value === 'string') return text(value);
  if (!isRecord(value)) return '';
  return firstText(value, [
    'finding',
    'diagnosis',
    'description',
    'problem',
    'issue',
    'text',
  ]);
}

function normalizeTarget(value: unknown): { kind: string } {
  const rawKind =
    typeof value === 'string'
      ? text(value, 40)
      : isRecord(value)
      ? text(value.kind, 40)
      : '';
  return { kind: V31_TARGETS.has(rawKind) ? rawKind : 'middle' };
}

function normalizeCategory(value: unknown, fallback: string): string {
  const candidate = text(value, 120);
  return V31_CATEGORIES.has(candidate) ? candidate : fallback;
}

function normalizeSeverity(
  value: unknown,
  fallback: 'required' | 'advisory',
): 'required' | 'hard' | 'advisory' {
  if (value === 'required' || value === 'hard' || value === 'advisory') {
    return value;
  }
  if (value === 'warning') return 'advisory';
  return fallback;
}

function correctionFromLegacy(
  value: unknown,
  index: number,
  source: V31AuditStage,
  defaultSeverity: 'required' | 'advisory',
  fallbackInstruction: string,
  suggestion?: unknown,
): Record<string, unknown> | null {
  const row = isRecord(value) ? value : {};
  const finding = itemText(value);
  if (!finding) return null;
  const instruction =
    firstText(row, [
      'instruction',
      'rewriteGoal',
      'suggestedAction',
      'suggestion',
      'action',
      'fix',
    ]) ||
    text(suggestion) ||
    fallbackInstruction;
  const category = normalizeCategory(
    row.category ?? row.dimension,
    source === 'factCheck' ? 'world_rule' : 'style',
  );
  const target = normalizeTarget(
    row.target ?? row.location ?? row.locationHint,
  );
  const preserve = strings(row.preserve ?? row.preserveMeaning, 20);
  const sourceRefs = strings(row.sourceRefs, 8);
  return {
    id: text(row.id, 120) || `legacy-${source}-${index + 1}`,
    severity: normalizeSeverity(row.severity, defaultSeverity),
    category,
    target,
    finding,
    instruction,
    ...(preserve.length > 0 ? { preserve } : {}),
    ...(text(row.evidenceQuote ?? row.quote, 80)
      ? { evidenceQuote: text(row.evidenceQuote ?? row.quote, 80) }
      : {}),
    ...(sourceRefs.length > 0 ? { sourceRefs } : {}),
  };
}

function outlineExecutionFromLegacy(value: unknown): Record<string, unknown> {
  const outline = isRecord(value) ? value : {};
  return {
    fulfilledBeats: strings(outline.fulfilledBeats),
    missingBeats: strings(outline.missingBeats),
    deviations: strings(outline.deviations),
    prematureBeats: strings(outline.prematureBeats),
    mustPreserve: strings(outline.mustPreserve),
    endingGoal: text(outline.endingGoal),
    mustNotAdvance: strings(outline.mustNotAdvance ?? outline.prematureBeats),
  };
}

function parseObject(result: LLMResult): Record<string, unknown> | null {
  const raw = typeof result.text === 'string' ? result.text.trim() : '';
  if (!raw) return null;
  const extracted = extractAuditJsonPayload(raw);
  if (!extracted.jsonText) return null;
  try {
    const parsed: unknown = JSON.parse(extracted.jsonText);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function withPayload(
  result: LLMResult,
  payload: Record<string, unknown>,
  adaptation: Exclude<V31AuditAdaptation, 'none'>,
): V31AuditCompatibilityResult {
  return {
    result: { ...result, text: JSON.stringify(payload) },
    adaptation,
  };
}

function adaptLegacyReview(
  result: LLMResult,
  raw: Record<string, unknown>,
  draftHash: string,
): V31AuditCompatibilityResult {
  const issues = Array.isArray(raw.issues) ? raw.issues : [];
  const suggestions = Array.isArray(raw.suggestions) ? raw.suggestions : [];
  const corrections = issues
    .map((issue, index) =>
      correctionFromLegacy(
        issue,
        index,
        'review',
        'advisory',
        '将该审阅意见作为终稿的文学修订提示。',
        suggestions[index],
      ),
    )
    .filter((item): item is Record<string, unknown> => item != null);
  if (corrections.length === 0 && suggestions.length > 0) {
    suggestions.forEach((suggestion, index) => {
      const item = correctionFromLegacy(
        suggestion,
        index,
        'review',
        'advisory',
        '将该审阅意见作为终稿的文学修订提示。',
      );
      if (item) corrections.push(item);
    });
  }
  const outline =
    raw.outlineExecution ?? raw.outlineAssessment ?? raw.outline ?? {};
  return withPayload(
    result,
    {
      schemaVersion: 3,
      draftHash,
      corrections,
      protectedFacts: strings(raw.protectedFacts),
      outlineExecution: outlineExecutionFromLegacy(outline),
    },
    'legacy_review_shape',
  );
}

function adaptLegacyFactCheck(
  result: LLMResult,
  raw: Record<string, unknown>,
  draftHash: string,
): V31AuditCompatibilityResult {
  const errors = Array.isArray(raw.errors) ? raw.errors : [];
  const warnings = Array.isArray(raw.warnings) ? raw.warnings : [];
  const corrections = [
    ...errors
      .map((item, index) =>
        correctionFromLegacy(
          item,
          index,
          'factCheck',
          'required',
          '核对该事实并修正与证据不一致的表述。',
        ),
      )
      .filter((item): item is Record<string, unknown> => item != null),
    ...warnings
      .map((item, index) =>
        correctionFromLegacy(
          item,
          errors.length + index,
          'factCheck',
          'advisory',
          '将该事实风险作为终稿核对提示。',
        ),
      )
      .filter((item): item is Record<string, unknown> => item != null),
  ];
  const confirmed = Array.isArray(raw.confirmed)
    ? raw.confirmed.map(item => itemText(item)).filter(Boolean)
    : [];
  return withPayload(
    result,
    {
      schemaVersion: 3,
      draftHash,
      corrections,
      protectedFacts: confirmed.slice(0, 200),
      hardConstraints: strings(raw.hardConstraints),
    },
    'legacy_fact_check_shape',
  );
}

function adaptV2Shape(
  result: LLMResult,
  raw: Record<string, unknown>,
  stage: V31AuditStage,
  draftHash: string,
): V31AuditCompatibilityResult {
  const rows = Array.isArray(raw.requiredCorrections)
    ? raw.requiredCorrections
    : [];
  const corrections = rows
    .map((item, index) =>
      correctionFromLegacy(
        item,
        index,
        stage,
        'required',
        stage === 'review'
          ? '将该修正要求纳入终稿。'
          : '核对该事实并修正与证据不一致的表述。',
      ),
    )
    .filter((item): item is Record<string, unknown> => item != null);
  if (stage === 'review') {
    return withPayload(
      result,
      {
        schemaVersion: 3,
        draftHash,
        corrections,
        protectedFacts: strings(raw.protectedFacts),
        outlineExecution: outlineExecutionFromLegacy(raw.outlineExecution),
      },
      'v2_review_shape',
    );
  }
  return withPayload(
    result,
    {
      schemaVersion: 3,
      draftHash,
      corrections,
      protectedFacts: strings(raw.protectedFacts),
      hardConstraints: strings(raw.hardConstraints),
    },
    'v2_fact_check_shape',
  );
}

/**
 * Adapt only recognized historical JSON dialects into the V3.1 envelope.
 *
 * This is intentionally not a generic "fill missing fields" fallback: unknown
 * objects remain invalid and are handled by the fail-closed response gate.
 */
export function adaptV31AuditResult(
  result: LLMResult,
  stage: V31AuditStage,
  draftHash: string,
): V31AuditCompatibilityResult {
  const raw = parseObject(result);
  if (!raw) return { result, adaptation: 'none' };

  const isNativeV31 =
    Number(raw.schemaVersion) === 3 &&
    (Array.isArray(raw.corrections) || Array.isArray(raw.requiredCorrections));
  if (isNativeV31) {
    // schemaVersion and draftHash are transport/envelope facts.  A legacy
    // formatter is allowed to omit the locally known hash, but an explicit
    // conflicting hash must remain visible to the strict validator.
    if (typeof raw.draftHash !== 'string' || !raw.draftHash.trim()) {
      return withPayload(
        result,
        { ...raw, schemaVersion: 3, draftHash },
        'local_fields_completed',
      );
    }
    return { result, adaptation: 'none' };
  }

  if (
    Number(raw.schemaVersion) === 2 &&
    Array.isArray(raw.requiredCorrections)
  ) {
    return adaptV2Shape(result, raw, stage, draftHash);
  }

  if (
    stage === 'review' &&
    (Array.isArray(raw.issues) ||
      Array.isArray(raw.suggestions) ||
      Array.isArray(raw.strengths) ||
      isRecord(raw.outlineAssessment))
  ) {
    return adaptLegacyReview(result, raw, draftHash);
  }

  if (
    stage === 'factCheck' &&
    (Array.isArray(raw.errors) ||
      Array.isArray(raw.warnings) ||
      Array.isArray(raw.confirmed))
  ) {
    return adaptLegacyFactCheck(result, raw, draftHash);
  }

  return { result, adaptation: 'none' };
}

/**
 * Semantic Apply gate shared by the unified writing kernel and continuation
 * final validation. Zero-width-only storage changes are deliberately ignored:
 * a distinct database hash is not evidence that a requirement changed prose.
 */

export type SemanticApplyFailureCode =
  | 'SEMANTIC_APPLY_FAILED'
  | 'VALID_NO_OP';

export interface SemanticApplyCheckInput {
  beforeRevisionBody: string;
  finalBody: string;
  appliedRequirementIds: readonly string[];
  validNoOpRequirementIds?: readonly string[];
  validNoOpReasons?: Readonly<Record<string, string>>;
}

export interface SemanticApplyCheckResult {
  ok: boolean;
  code: SemanticApplyFailureCode | null;
  semanticallyChanged: boolean;
  appliedRequirementIds: string[];
  invalidAppliedRequirementIds: string[];
  validNoOpRequirementIds: string[];
  details: string[];
}

/** Normalize only representation noise, preserving punctuation and wording. */
export function normalizeWritingBodyForSemanticComparison(value: string): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s\u200B-\u200D\uFEFF\u2060]+/g, '')
    .trim();
}

export function checkSemanticRequirementApplication(
  input: SemanticApplyCheckInput,
): SemanticApplyCheckResult {
  const applied = Array.from(
    new Set(
      input.appliedRequirementIds
        .map(item => String(item).trim())
        .filter(Boolean),
    ),
  );
  const noOpIds = new Set(
    (input.validNoOpRequirementIds || [])
      .map(item => String(item).trim())
      .filter(Boolean),
  );
  const reasons = input.validNoOpReasons || {};
  const before = normalizeWritingBodyForSemanticComparison(
    input.beforeRevisionBody,
  );
  const after = normalizeWritingBodyForSemanticComparison(input.finalBody);
  const semanticallyChanged = before !== after;
  const invalidAppliedRequirementIds = applied.filter(
    requirementId =>
      !noOpIds.has(requirementId) ||
      !String(reasons[requirementId] || '').trim(),
  );
  const validNoOpRequirementIds = applied.filter(
    requirementId =>
      noOpIds.has(requirementId) &&
      Boolean(String(reasons[requirementId] || '').trim()),
  );

  if (applied.length === 0) {
    return {
      ok: true,
      code: null,
      semanticallyChanged,
      appliedRequirementIds: applied,
      invalidAppliedRequirementIds: [],
      validNoOpRequirementIds,
      details: [],
    };
  }

  if (semanticallyChanged) {
    return {
      ok: true,
      code: null,
      semanticallyChanged: true,
      appliedRequirementIds: applied,
      invalidAppliedRequirementIds: [],
      validNoOpRequirementIds,
      details: [`semantic body changed; applied=${applied.length}`],
    };
  }

  if (invalidAppliedRequirementIds.length === 0) {
    return {
      ok: true,
      code: 'VALID_NO_OP',
      semanticallyChanged: false,
      appliedRequirementIds: applied,
      invalidAppliedRequirementIds: [],
      validNoOpRequirementIds,
      details: [`VALID_NO_OP: ${validNoOpRequirementIds.join(',')}`],
    };
  }

  return {
    ok: false,
    code: 'SEMANTIC_APPLY_FAILED',
    semanticallyChanged: false,
    appliedRequirementIds: applied,
    invalidAppliedRequirementIds,
    validNoOpRequirementIds,
    details: [
      `semantic body unchanged; invalid applied requirements=${invalidAppliedRequirementIds.join(',')}`,
    ],
  };
}

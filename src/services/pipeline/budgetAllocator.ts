/**
 * Conservation-based stage context budget allocator.
 *
 * Order (must not oversubscribe):
 * 1. safety margin
 * 2. reserved output
 * 3. fixed messages (true token cost)
 * 4. full outline (never silently truncated)
 * 5. mandatory body for this stage
 * 6. remaining → optional sections by weight (sum ≤ 100%)
 */

export interface BudgetSection {
  id: string;
  tokens: number;
  /** Relative weight among optional sections only; ignored for mandatory. */
  weight?: number;
  mandatory?: boolean;
}

export interface AllocateStageContextBudgetInput {
  contextWindow: number;
  reservedOutputTokens: number;
  safetyMargin?: number;
  /** Fixed system/user scaffold already in messages (prompt templates etc.). */
  fixedMessagesTokens: number;
  fullOutlineTokens: number;
  mandatoryBodyTokens: number;
  optionalSections: Array<{ id: string; tokens: number; weight: number }>;
}

export interface AllocateStageContextBudgetResult {
  contextWindow: number;
  safetyMargin: number;
  reservedOutputTokens: number;
  fixedMessagesTokens: number;
  fullOutlineTokens: number;
  mandatoryBodyTokens: number;
  remainingForOptional: number;
  optionalAllocations: Array<{
    id: string;
    requested: number;
    allocated: number;
    truncated: boolean;
  }>;
  fitsMandatory: boolean;
  fits: boolean;
  blockingReason: 'outline_or_body' | 'fixed_overflow' | null;
  totalInputBudget: number;
}

export function deriveDefaultSafetyMargin(contextWindow: number): number {
  if (!(contextWindow > 0)) return 512;
  return Math.min(1024, Math.max(256, Math.floor(contextWindow * 0.02)));
}

export function allocateStageContextBudget(
  input: AllocateStageContextBudgetInput,
): AllocateStageContextBudgetResult {
  const contextWindow = Math.max(0, Number(input.contextWindow) || 0);
  const reservedOutputTokens = Math.max(
    0,
    Number(input.reservedOutputTokens) || 0,
  );
  const safetyMargin =
    input.safetyMargin != null
      ? Math.max(0, Number(input.safetyMargin) || 0)
      : deriveDefaultSafetyMargin(contextWindow);
  const fixedMessagesTokens = Math.max(
    0,
    Number(input.fixedMessagesTokens) || 0,
  );
  const fullOutlineTokens = Math.max(0, Number(input.fullOutlineTokens) || 0);
  const mandatoryBodyTokens = Math.max(
    0,
    Number(input.mandatoryBodyTokens) || 0,
  );

  const totalInputBudget = Math.max(
    0,
    contextWindow - reservedOutputTokens - safetyMargin,
  );

  let remaining = totalInputBudget - fixedMessagesTokens;
  if (remaining < 0) {
    return {
      contextWindow,
      safetyMargin,
      reservedOutputTokens,
      fixedMessagesTokens,
      fullOutlineTokens,
      mandatoryBodyTokens,
      remainingForOptional: 0,
      optionalAllocations: input.optionalSections.map(s => ({
        id: s.id,
        requested: s.tokens,
        allocated: 0,
        truncated: s.tokens > 0,
      })),
      fitsMandatory: false,
      fits: false,
      blockingReason: 'fixed_overflow',
      totalInputBudget,
    };
  }

  remaining -= fullOutlineTokens;
  remaining -= mandatoryBodyTokens;
  const fitsMandatory = remaining >= 0;
  if (!fitsMandatory) {
    return {
      contextWindow,
      safetyMargin,
      reservedOutputTokens,
      fixedMessagesTokens,
      fullOutlineTokens,
      mandatoryBodyTokens,
      remainingForOptional: 0,
      optionalAllocations: input.optionalSections.map(s => ({
        id: s.id,
        requested: s.tokens,
        allocated: 0,
        truncated: s.tokens > 0,
      })),
      fitsMandatory: false,
      fits: false,
      blockingReason: 'outline_or_body',
      totalInputBudget,
    };
  }

  // Normalize optional weights to sum ≤ 100 (treat as percentages).
  const opts = input.optionalSections || [];
  const weightSum = opts.reduce((s, o) => s + Math.max(0, o.weight || 0), 0);
  const scale = weightSum > 100 ? 100 / weightSum : 1;
  const remainingForOptional = remaining;

  const optionalAllocations = opts.map(o => {
    const w = Math.max(0, o.weight || 0) * scale;
    const cap = Math.floor((remainingForOptional * w) / 100);
    const allocated = Math.min(Math.max(0, o.tokens), Math.max(0, cap));
    return {
      id: o.id,
      requested: o.tokens,
      allocated,
      truncated: allocated < o.tokens,
    };
  });

  return {
    contextWindow,
    safetyMargin,
    reservedOutputTokens,
    fixedMessagesTokens,
    fullOutlineTokens,
    mandatoryBodyTokens,
    remainingForOptional,
    optionalAllocations,
    fitsMandatory: true,
    fits: true,
    blockingReason: null,
    totalInputBudget,
  };
}

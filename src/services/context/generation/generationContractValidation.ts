import { sha256Hex } from '../../continuation/hashUtils';
import type { ChatMessage } from '../../llm';
import type { GenerationDiagnostic } from '../../../types/generationTrace';
import type {
  FrozenGenerationContextContractV2,
  GenerationActivation,
  GenerationBudgetItem,
  GenerationCandidateSourceType,
  GenerationRequirement,
  GenerationRenderedContextItem,
} from './generationContracts';

const SOURCE_TYPES: GenerationCandidateSourceType[] = [
  'chapter',
  'outline',
  'character',
  'worldbook',
  'note',
  'story_memory',
  'episodic_memory',
  'writer_style',
  'canon',
  'preset',
  'other',
];
const ACTIVATIONS: GenerationActivation[] = [
  'explicit',
  'automatic',
  'mandatory',
  'system',
];
const REQUIREMENTS: GenerationRequirement[] = [
  'mandatory',
  'preferred',
  'optional',
];
const WATER_LEVELS: GenerationBudgetItem['waterLevel'][] = [
  'mandatory',
  'soft',
  'burst',
  'hard',
  'none',
];

type RecordLike = Record<string, unknown>;

function record(value: unknown, path: string): RecordLike {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`GENERATION_CONTRACT_INVALID:${path}`);
  }
  return value as RecordLike;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`GENERATION_CONTRACT_INVALID:${path}`);
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value !== null && typeof value !== 'string') {
    throw new Error(`GENERATION_CONTRACT_INVALID:${path}`);
  }
  return value;
}

function finiteNumber(value: unknown, path: string, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`GENERATION_CONTRACT_INVALID:${path}`);
  }
  return parsed;
}

function nullableFiniteNumber(
  value: unknown,
  path: string,
  minimum = 0,
  maximum?: number,
): number | null {
  if (value === null) return null;
  const parsed = finiteNumber(value, path, minimum);
  if (maximum != null && parsed > maximum) {
    throw new Error(`GENERATION_CONTRACT_INVALID:${path}`);
  }
  return parsed;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`GENERATION_CONTRACT_INVALID:${path}`);
  }
  return value as T;
}

function sourceId(value: unknown, path: string): string | number | null {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error(`GENERATION_CONTRACT_INVALID:${path}`);
}

function hashValue(value: unknown, path: string): string {
  const hash = stringValue(value, path);
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    throw new Error(`GENERATION_CONTRACT_INVALID:${path}`);
  }
  return hash;
}

function parseCandidate(raw: unknown, index: number) {
  const value = record(raw, `candidates[${index}]`);
  const candidateId = stringValue(
    value.candidateId,
    `candidates[${index}].candidateId`,
  );
  if (!candidateId) {
    throw new Error(`GENERATION_CONTRACT_INVALID:candidates[${index}].candidateId`);
  }
  return {
    candidateId,
    sourceType: enumValue(
      value.sourceType,
      SOURCE_TYPES,
      `candidates[${index}].sourceType`,
    ),
    sourceId: sourceId(value.sourceId, `candidates[${index}].sourceId`),
    sourceRevision: nullableString(
      value.sourceRevision,
      `candidates[${index}].sourceRevision`,
    ),
    contentHash: hashValue(
      value.contentHash,
      `candidates[${index}].contentHash`,
    ),
    activation: enumValue(
      value.activation,
      ACTIVATIONS,
      `candidates[${index}].activation`,
    ),
    selected: typeof value.selected === 'boolean'
      ? value.selected
      : (() => {
          throw new Error(
            `GENERATION_CONTRACT_INVALID:candidates[${index}].selected`,
          );
        })(),
    selectedReason: nullableString(
      value.selectedReason,
      `candidates[${index}].selectedReason`,
    ),
    rejectedReason: nullableString(
      value.rejectedReason,
      `candidates[${index}].rejectedReason`,
    ),
    requirement: enumValue(
      value.requirement,
      REQUIREMENTS,
      `candidates[${index}].requirement`,
    ),
    relevance: nullableFiniteNumber(
      value.relevance,
      `candidates[${index}].relevance`,
      0,
      1,
    ),
    priority: nullableFiniteNumber(
      value.priority,
      `candidates[${index}].priority`,
    ),
    selectionBoost: nullableFiniteNumber(
      value.selectionBoost,
      `candidates[${index}].selectionBoost`,
    ),
    demandTokens: finiteNumber(
      value.demandTokens,
      `candidates[${index}].demandTokens`,
    ),
  };
}

function parseBudgetItem(raw: unknown, index: number): GenerationBudgetItem {
  const value = record(raw, `budget[${index}]`);
  const candidateId = stringValue(
    value.candidateId,
    `budget[${index}].candidateId`,
  );
  const legacyClipped = value.clippedByBudget;
  const canonicalClipped = value.budgetClipped;
  if (
    typeof canonicalClipped !== 'boolean' &&
    typeof legacyClipped !== 'boolean'
  ) {
    throw new Error(`GENERATION_CONTRACT_INVALID:budget[${index}].budgetClipped`);
  }
  if (
    typeof canonicalClipped === 'boolean' &&
    typeof legacyClipped === 'boolean' &&
    canonicalClipped !== legacyClipped
  ) {
    throw new Error(`GENERATION_CONTRACT_INVALID:budget[${index}].budgetClipped`);
  }
  const budgetClipped =
    typeof canonicalClipped === 'boolean'
      ? canonicalClipped
      : (legacyClipped as boolean);
  return {
    candidateId,
    demandTokens: finiteNumber(value.demandTokens, `budget[${index}].demandTokens`),
    requestedTokens: finiteNumber(
      value.requestedTokens ?? value.demandTokens,
      `budget[${index}].requestedTokens`,
    ),
    minTokens: finiteNumber(value.minTokens, `budget[${index}].minTokens`),
    targetTokens: finiteNumber(value.targetTokens, `budget[${index}].targetTokens`),
    maxTokens: finiteNumber(value.maxTokens, `budget[${index}].maxTokens`),
    allocatedTokens: finiteNumber(
      value.allocatedTokens,
      `budget[${index}].allocatedTokens`,
    ),
    allocationReason: stringValue(
      value.allocationReason,
      `budget[${index}].allocationReason`,
    ),
    waterLevel: enumValue(
      value.waterLevel,
      WATER_LEVELS,
      `budget[${index}].waterLevel`,
    ),
    budgetClipped,
    clippedByBudget: budgetClipped,
  };
}

function parseRenderedItem(
  raw: unknown,
  index: number,
): GenerationRenderedContextItem {
  const value = record(raw, `rendered[${index}]`);
  const included = value.included;
  const clipped = value.clipped;
  if (typeof included !== 'boolean' || typeof clipped !== 'boolean') {
    throw new Error(`GENERATION_CONTRACT_INVALID:rendered[${index}].flags`);
  }
  return {
    candidateId: stringValue(
      value.candidateId,
      `rendered[${index}].candidateId`,
    ),
    allocatedTokens: finiteNumber(
      value.allocatedTokens,
      `rendered[${index}].allocatedTokens`,
    ),
    actualTokens: finiteNumber(value.actualTokens, `rendered[${index}].actualTokens`),
    included,
    clipped,
    clippingReason: nullableString(
      value.clippingReason,
      `rendered[${index}].clippingReason`,
    ),
    renderedHash: hashValue(
      value.renderedHash,
      `rendered[${index}].renderedHash`,
    ),
  };
}

function parseMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) {
    throw new Error('GENERATION_CONTRACT_INVALID:messages');
  }
  return raw.map((item, index) => {
    const value = record(item, `messages[${index}]`);
    const role = enumValue(
      value.role,
      ['system', 'user', 'assistant'] as const,
      `messages[${index}].role`,
    );
    return {
      role,
      content: stringValue(value.content, `messages[${index}].content`),
    };
  });
}

function parseDiagnostics(raw: unknown): GenerationDiagnostic[] {
  if (!Array.isArray(raw)) {
    throw new Error('GENERATION_CONTRACT_INVALID:diagnostics');
  }
  return raw.map((item, index) => {
    const value = record(item, `diagnostics[${index}]`);
    const severity = enumValue(
      value.severity,
      ['info', 'warning', 'error', 'blocking'] as const,
      `diagnostics[${index}].severity`,
    );
    const result: GenerationDiagnostic = {
      code: stringValue(value.code, `diagnostics[${index}].code`),
      severity,
      message: stringValue(value.message, `diagnostics[${index}].message`),
    };
    if (value.stage !== undefined) {
      result.stage = stringValue(value.stage, `diagnostics[${index}].stage`);
    }
    if (value.source !== undefined) {
      result.source = stringValue(value.source, `diagnostics[${index}].source`);
    }
    if (value.detail !== undefined) {
      result.detail = record(value.detail, `diagnostics[${index}].detail`);
    }
    return result;
  });
}

/** Remove the self-digest before hashing a frozen contract payload. */
export function generationContractPayload(
  contract: FrozenGenerationContextContractV2,
): Record<string, unknown> {
  return {
    version: 2,
    projectId: contract.projectId,
    chapterId: contract.chapterId,
    currentPosition: contract.currentPosition,
    candidates: contract.candidates.map(candidate => ({
      candidateId: candidate.candidateId,
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId,
      sourceRevision: candidate.sourceRevision,
      contentHash: candidate.contentHash,
      activation: candidate.activation,
      selected: candidate.selected,
      selectedReason: candidate.selectedReason,
      rejectedReason: candidate.rejectedReason,
      requirement: candidate.requirement,
      relevance: candidate.relevance,
      priority: candidate.priority,
      selectionBoost: candidate.selectionBoost,
      demandTokens: candidate.demandTokens,
    })),
    budget: contract.budget.map(item => ({
      candidateId: item.candidateId,
      demandTokens: item.demandTokens,
      minTokens: item.minTokens,
      targetTokens: item.targetTokens,
      maxTokens: item.maxTokens,
      allocatedTokens: item.allocatedTokens,
      allocationReason: item.allocationReason,
      waterLevel: item.waterLevel,
      budgetClipped:
        typeof item.budgetClipped === 'boolean'
          ? item.budgetClipped
          : Boolean(item.clippedByBudget),
    })),
    rendered: contract.rendered.map(item => ({
      candidateId: item.candidateId,
      allocatedTokens: item.allocatedTokens,
      actualTokens: item.actualTokens,
      included: item.included,
      clipped: item.clipped,
      clippingReason: item.clippingReason,
      renderedHash: item.renderedHash,
    })),
    messages: contract.messages.map(message => ({
      role: message.role,
      content: message.content,
    })),
    diagnostics: contract.diagnostics,
  };
}

export function computeGenerationContractFingerprint(
  contract: FrozenGenerationContextContractV2,
): string {
  return sha256Hex(JSON.stringify(generationContractPayload(contract)));
}

/**
 * Strictly parse a persisted Candidate/Budget/Render contract. Historical
 * Phase-1 contracts that only carried `clippedByBudget` remain readable; all
 * newly emitted contracts carry the canonical `budgetClipped` field.
 */
export function parseFrozenGenerationContextContract(
  raw: unknown,
): FrozenGenerationContextContractV2 {
  const value = record(raw, 'generationContract');
  if (Number(value.version) !== 2) {
    throw new Error('GENERATION_CONTRACT_INVALID:version');
  }
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.map(parseCandidate)
    : (() => {
        throw new Error('GENERATION_CONTRACT_INVALID:candidates');
      })();
  const candidateIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.candidateId)) {
      throw new Error(
        `GENERATION_CONTRACT_INVALID:candidates.${candidate.candidateId}`,
      );
    }
    candidateIds.add(candidate.candidateId);
  }
  const budget = Array.isArray(value.budget)
    ? value.budget.map(parseBudgetItem)
    : (() => {
        throw new Error('GENERATION_CONTRACT_INVALID:budget');
      })();
  const rendered = Array.isArray(value.rendered)
    ? value.rendered.map(parseRenderedItem)
    : (() => {
        throw new Error('GENERATION_CONTRACT_INVALID:rendered');
      })();
  for (const item of [...budget, ...rendered]) {
    if (!candidateIds.has(item.candidateId)) {
      throw new Error(
        `GENERATION_CONTRACT_INVALID:unknown_candidate.${item.candidateId}`,
      );
    }
  }
  const contract: FrozenGenerationContextContractV2 = {
    version: 2,
    projectId: finiteNumber(value.projectId, 'projectId'),
    chapterId:
      value.chapterId === null
        ? null
        : finiteNumber(value.chapterId, 'chapterId'),
    currentPosition: finiteNumber(value.currentPosition, 'currentPosition'),
    candidates,
    budget,
    rendered,
    messages: parseMessages(value.messages),
    diagnostics: parseDiagnostics(value.diagnostics),
    fingerprint: stringValue(value.fingerprint, 'fingerprint'),
  };
  if (!/^[0-9a-f]{64}$/i.test(contract.fingerprint)) {
    throw new Error('GENERATION_CONTRACT_INVALID:fingerprint');
  }

  // Verify the original JSON shape first so old contracts with the legacy
  // budget key retain their own digest semantics. New contracts are emitted
  // and verified with the canonical budgetClipped field.
  const rawPayload = { ...value };
  delete rawPayload.fingerprint;
  const rawFingerprint = sha256Hex(JSON.stringify(rawPayload));
  const canonicalFingerprint = computeGenerationContractFingerprint(contract);
  if (
    rawFingerprint !== contract.fingerprint &&
    canonicalFingerprint !== contract.fingerprint
  ) {
    throw new Error('GENERATION_CONTRACT_FINGERPRINT_MISMATCH');
  }
  return contract;
}

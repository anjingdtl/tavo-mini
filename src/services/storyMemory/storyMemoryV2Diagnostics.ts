import type { Chapter } from '../../types/novel';
import type { StoryMemoryObservationWarning } from './storyMemoryObservationTypes';
import type { StoryMemoryObservationMaterials } from './storyMemoryObservationMaterials';
import type {
  FrozenStoryMemoryLLMConfig,
  StoryMemoryObservationRequestPlan,
} from './storyMemoryRequestBudget';
import type { StoryMemoryEntityHandleEnvelope } from './storyMemoryEntityHandles';
import type { StoryMemoryEvidenceEnvelope } from './storyMemoryEvidenceAnchors';
import type { StoryMemoryBatchPatchDraft } from './storyMemoryTypes';

export const STORY_MEMORY_V2_PROTOCOL_VERSION = 2 as const;

export type StoryMemoryV2DropReason =
  | 'invalid_anchor'
  | 'invalid_ref'
  | 'future_ref'
  | 'invalid_kind'
  | 'invalid_op'
  | 'invalid_field'
  | 'invalid_endpoint'
  | 'duplicate'
  | 'invalid_observation';

export interface StoryMemoryV2Diagnostics {
  protocolVersion: typeof STORY_MEMORY_V2_PROTOCOL_VERSION;
  range: {
    fromPosition: number;
    throughPosition: number;
  };
  model: string;
  contextWindow: number;
  modelMaxOutput: number;
  outputReservation: number;
  fullInputTokens: number;
  finalInputTokens: number;
  softLimit: number;
  burstLimit: number;
  hardLimit: number;
  materialCounts: StoryMemoryObservationMaterials['materialCounts'];
  includedEntityCounts: {
    relevantCharacters: number;
    characters: number;
    relationships: number;
    conflicts: number;
    threads: number;
    foreshadowing: number;
  };
  droppedMaterialCounts: StoryMemoryObservationMaterials['materialCounts'];
  anchorCount: number;
  handleCounts: {
    chapters: number;
    characters: number;
    relationships: number;
    conflicts: number;
    threads: number;
    foreshadowing: number;
    arcs: number;
  };
  responseCandidateChars: number;
  normalizerWarnings: number;
  observationsReceived: number;
  observationsAccepted: number;
  observationsDropped: number;
  dropReasons: Record<StoryMemoryV2DropReason, number>;
  physicalAttemptCount: number;
  formatterUsed: boolean;
  freshRetryUsed: boolean;
  splitUsed: boolean;
  applied: boolean;
}

export interface StoryMemoryV2DiagnosticsRef {
  current?: StoryMemoryV2Diagnostics;
}

export const STORY_MEMORY_KNOWN_CHANGE_MIN_ACCEPTED_OBSERVATIONS = 3;

export type StoryMemoryKnownChangeSemanticCategory =
  | 'character'
  | 'relationship'
  | 'conflict'
  | 'thread'
  | 'foreshadowing'
  | 'objective'
  | 'arc'
  | 'timeline';

export interface StoryMemoryKnownChangeSemanticGateResult {
  pass: boolean;
  reason: string;
  categories: StoryMemoryKnownChangeSemanticCategory[];
  observationsReceived: number;
  observationsAccepted: number;
}

function nonNegativeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Semantic QA gate for a known-change Story Memory request.
 *
 * HTTP success and a parseable JSON body are not sufficient: the request must
 * yield accepted observations and at least one concrete state-patch category.
 * This remains a diagnostics/test seam only; production generation does not
 * turn a zero-observation response into a physical retry or a hard failure.
 */
export function evaluateStoryMemoryKnownChangeSemanticGate(input: {
  observationsReceived: number;
  observationsAccepted: number;
  patch: StoryMemoryBatchPatchDraft;
}): StoryMemoryKnownChangeSemanticGateResult {
  const observationsReceived = nonNegativeCount(input.observationsReceived);
  const observationsAccepted = nonNegativeCount(input.observationsAccepted);
  const patch = input.patch;
  const categories: StoryMemoryKnownChangeSemanticCategory[] = [];

  if (
    (patch.newCharacters?.length ?? 0) > 0 ||
    (patch.characterUpdates?.length ?? 0) > 0
  ) {
    categories.push('character');
  }
  if (
    (patch.newRelationships?.length ?? 0) > 0 ||
    (patch.relationshipUpdates?.length ?? 0) > 0
  ) {
    categories.push('relationship');
  }
  if (
    (patch.mainlinePatch.conflictUpserts?.length ?? 0) > 0 ||
    (patch.mainlinePatch.conflictResolutions?.length ?? 0) > 0
  ) {
    categories.push('conflict');
  }
  if (
    (patch.mainlinePatch.threadOpens?.length ?? 0) > 0 ||
    (patch.mainlinePatch.threadUpdates?.length ?? 0) > 0 ||
    (patch.mainlinePatch.threadResolutions?.length ?? 0) > 0
  ) {
    categories.push('thread');
  }
  if ((patch.mainlinePatch.foreshadowingUpserts?.length ?? 0) > 0) {
    categories.push('foreshadowing');
  }
  if (patch.mainlinePatch.currentObjective) {
    categories.push('objective');
  }
  if (
    patch.mainlinePatch.currentArcUpdate?.action !== undefined &&
    patch.mainlinePatch.currentArcUpdate.action !== 'none'
  ) {
    categories.push('arc');
  }
  if (
    (patch.mainlinePatch.timelineAnchors?.length ?? 0) > 0 ||
    (patch.mainlinePatch.completedBeats?.length ?? 0) > 0
  ) {
    categories.push('timeline');
  }

  const prefix =
    `observationsReceived=${observationsReceived}; ` +
    `observationsAccepted=${observationsAccepted}; ` +
    `categories=${categories.join(',') || 'none'}`;
  if (observationsReceived <= 0) {
    return {
      pass: false,
      reason: `${prefix}; observationsReceived must be greater than zero`,
      categories,
      observationsReceived,
      observationsAccepted,
    };
  }
  if (observationsAccepted <= 0) {
    return {
      pass: false,
      reason: `${prefix}; observationsAccepted must be greater than zero`,
      categories,
      observationsReceived,
      observationsAccepted,
    };
  }
  if (
    observationsAccepted < STORY_MEMORY_KNOWN_CHANGE_MIN_ACCEPTED_OBSERVATIONS
  ) {
    return {
      pass: false,
      reason:
        `${prefix}; observationsAccepted must be at least ` +
        `${STORY_MEMORY_KNOWN_CHANGE_MIN_ACCEPTED_OBSERVATIONS}`,
      categories,
      observationsReceived,
      observationsAccepted,
    };
  }
  if (categories.length === 0) {
    return {
      pass: false,
      reason: `${prefix}; no concrete state patch category was produced`,
      categories,
      observationsReceived,
      observationsAccepted,
    };
  }
  return {
    pass: true,
    reason: `${prefix}; semantic state change is present`,
    categories,
    observationsReceived,
    observationsAccepted,
  };
}

const recentDiagnostics: StoryMemoryV2Diagnostics[] = [];

function cloneDiagnostics(
  diagnostics: StoryMemoryV2Diagnostics,
): StoryMemoryV2Diagnostics {
  return {
    ...diagnostics,
    range: { ...diagnostics.range },
    materialCounts: { ...diagnostics.materialCounts },
    includedEntityCounts: { ...diagnostics.includedEntityCounts },
    droppedMaterialCounts: { ...diagnostics.droppedMaterialCounts },
    handleCounts: { ...diagnostics.handleCounts },
    dropReasons: { ...diagnostics.dropReasons },
  };
}

/**
 * Keep a bounded, process-local redacted trace for QA/support inspection.
 * It deliberately stores counters and model capability metadata only; never
 * the chapter body, prompt, API key, reasoning, or model response.
 */
export function recordRecentStoryMemoryV2Diagnostics(
  diagnostics: StoryMemoryV2Diagnostics,
): void {
  recentDiagnostics.push(cloneDiagnostics(diagnostics));
  if (recentDiagnostics.length > 20) recentDiagnostics.shift();
}

export function getRecentStoryMemoryV2Diagnostics(): StoryMemoryV2Diagnostics[] {
  return recentDiagnostics.map(cloneDiagnostics);
}

function emptyCounts(): StoryMemoryObservationMaterials['materialCounts'] {
  return {
    mandatory: 0,
    preferredHigh: 0,
    preferredLow: 0,
    optional: 0,
  };
}

function emptyDropReasons(): Record<StoryMemoryV2DropReason, number> {
  // Keep explicit keys so JSON/diagnostics consumers always see future_ref.
  return {
    invalid_anchor: 0,
    invalid_ref: 0,
    future_ref: 0,
    invalid_kind: 0,
    invalid_op: 0,
    invalid_field: 0,
    invalid_endpoint: 0,
    duplicate: 0,
    invalid_observation: 0,
  };
}

function moduleTier(
  materials: StoryMemoryObservationMaterials,
  moduleId: string,
): keyof StoryMemoryObservationMaterials['materialCounts'] | null {
  const module = materials.modules.find(item => item.id === moduleId);
  if (!module) return null;
  switch (module.tier) {
    case 'mandatory':
      return 'mandatory';
    case 'preferred_high':
      return 'preferredHigh';
    case 'preferred_low':
      return 'preferredLow';
    case 'optional':
      return 'optional';
  }
}

export function createStoryMemoryV2Diagnostics(input: {
  chapters: Chapter[];
  config: FrozenStoryMemoryLLMConfig;
  materials: StoryMemoryObservationMaterials;
  handles: StoryMemoryEntityHandleEnvelope;
  evidence: StoryMemoryEvidenceEnvelope;
  fullInputTokens: number;
  splitUsed?: boolean;
}): StoryMemoryV2Diagnostics {
  const ordered = [...input.chapters].sort(
    (left, right) => left.position - right.position,
  );
  const fromPosition = ordered[0]?.position ?? -1;
  const throughPosition = ordered.at(-1)?.position ?? fromPosition;
  return {
    protocolVersion: STORY_MEMORY_V2_PROTOCOL_VERSION,
    range: { fromPosition, throughPosition },
    model: input.config.modelName,
    contextWindow: input.config.contextWindow,
    modelMaxOutput: input.config.maxOutputTokens,
    outputReservation: 0,
    fullInputTokens: Math.max(0, Math.floor(input.fullInputTokens)),
    finalInputTokens: 0,
    softLimit: 0,
    burstLimit: 0,
    hardLimit: 0,
    materialCounts: { ...input.materials.materialCounts },
    includedEntityCounts: {
      relevantCharacters: input.materials.relevantCharacterIds.size,
      characters: input.handles.characterByHandle.size,
      relationships: input.handles.relationshipByHandle.size,
      conflicts: input.handles.conflictByHandle.size,
      threads: input.handles.threadByHandle.size,
      foreshadowing: input.handles.foreshadowingByHandle.size,
    },
    droppedMaterialCounts: emptyCounts(),
    anchorCount: input.evidence.anchors.length,
    handleCounts: {
      chapters: input.handles.chapters.length,
      characters: input.handles.characterByHandle.size,
      relationships: input.handles.relationshipByHandle.size,
      conflicts: input.handles.conflictByHandle.size,
      threads: input.handles.threadByHandle.size,
      foreshadowing: input.handles.foreshadowingByHandle.size,
      arcs: input.handles.arcHandle ? 1 : 0,
    },
    responseCandidateChars: 0,
    normalizerWarnings: 0,
    observationsReceived: 0,
    observationsAccepted: 0,
    observationsDropped: 0,
    dropReasons: emptyDropReasons(),
    physicalAttemptCount: 0,
    formatterUsed: false,
    freshRetryUsed: false,
    splitUsed: Boolean(input.splitUsed),
    applied: false,
  };
}

export function recordStoryMemoryV2Plan(
  diagnostics: StoryMemoryV2Diagnostics,
  plan: StoryMemoryObservationRequestPlan,
  materials: StoryMemoryObservationMaterials,
): void {
  diagnostics.outputReservation = plan.maxTokens;
  diagnostics.finalInputTokens = Math.max(
    0,
    Math.floor(plan.estimatedInputTokens),
  );
  diagnostics.softLimit = plan.softInputLimit;
  diagnostics.burstLimit = plan.burstInputLimit;
  diagnostics.hardLimit = plan.hardInputLimit;
  diagnostics.droppedMaterialCounts = emptyCounts();
  plan.droppedModuleIds.forEach(moduleId => {
    const tier = moduleTier(materials, moduleId);
    if (tier) diagnostics.droppedMaterialCounts[tier] += 1;
  });
}

function dropReasonForWarning(
  code: StoryMemoryObservationWarning['code'],
): StoryMemoryV2DropReason {
  switch (code) {
    case 'OBS_INVALID_EVIDENCE':
      return 'invalid_anchor';
    case 'OBS_INVALID_REF':
      return 'invalid_ref';
    case 'OBS_FUTURE_REF':
      return 'future_ref';
    case 'OBS_INVALID_KIND':
      return 'invalid_kind';
    case 'OBS_INVALID_OP':
      return 'invalid_op';
    case 'OBS_INVALID_FIELD':
      return 'invalid_field';
    case 'OBS_INVALID_ENDPOINT':
      return 'invalid_endpoint';
    case 'OBS_DUPLICATE':
      return 'duplicate';
    default:
      return 'invalid_observation';
  }
}

export function recordStoryMemoryV2Warnings(
  diagnostics: StoryMemoryV2Diagnostics,
  warnings: StoryMemoryObservationWarning[],
): void {
  diagnostics.normalizerWarnings += warnings.length;
  warnings.forEach(item => {
    const reason = dropReasonForWarning(item.code);
    diagnostics.dropReasons[reason] += 1;
  });
}

export function recordStoryMemoryV2ObservationStats(
  diagnostics: StoryMemoryV2Diagnostics,
  input: {
    responseCandidateChars: number;
    observationsReceived: number;
    observationsAccepted: number;
  },
): void {
  diagnostics.responseCandidateChars = Math.max(
    diagnostics.responseCandidateChars,
    Math.max(0, Math.floor(input.responseCandidateChars)),
  );
  diagnostics.observationsReceived += Math.max(
    0,
    Math.floor(input.observationsReceived),
  );
  diagnostics.observationsAccepted += Math.max(
    0,
    Math.floor(input.observationsAccepted),
  );
  diagnostics.observationsDropped = Math.max(
    0,
    diagnostics.observationsReceived - diagnostics.observationsAccepted,
  );
}

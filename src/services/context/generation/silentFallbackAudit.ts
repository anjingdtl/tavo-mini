/**
 * Stability Phase II / Phase 6 — Generation Semantic Path fallback register.
 *
 * This is a small, machine-checkable inventory rather than a project-wide
 * warning list.  Entries are limited to the context collection, candidate,
 * frozen-resource, allocation, and render path used by Generation.  A
 * fallback may be safe or historical, but it must still have an explicit
 * disposition before the Phase 6 gate can pass.
 */

export type SilentFallbackClassification =
  | 'SAFE_NON_SEMANTIC'
  | 'DIAGNOSTIC_REQUIRED'
  | 'BLOCKING_REQUIRED'
  | 'LEGACY_ONLY';

export interface SilentFallbackAuditEntry {
  id: string;
  path: string;
  fallback: string;
  semantic: boolean;
  classification: SilentFallbackClassification | null;
  observability: string;
}

export const SECOND_PHASE_SILENT_FALLBACK_AUDIT: readonly SilentFallbackAuditEntry[] = [
  {
    id: 'SFA-01',
    path: 'collectGenerationMaterials.resourceSources',
    fallback: 'Promise.allSettled rejection becomes an empty source collection',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'GenerationDiagnostic RESOURCE_RETRIEVAL_FAILED / NOTE_RETRIEVAL_FAILED',
  },
  {
    id: 'SFA-02',
    path: 'collectGenerationMaterials.resourceSources.shape',
    fallback: 'fulfilled non-array source result becomes []',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'GenerationDiagnostic with expected_array detail',
  },
  {
    id: 'SFA-03',
    path: 'collectGenerationMaterials.resourceSources.noteContents',
    fallback: 'note body read failure becomes {}',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'GenerationDiagnostic NOTE_RETRIEVAL_FAILED',
  },
  {
    id: 'SFA-04',
    path: 'collectGenerationMaterials.resourceSources.noteStyleProfiles',
    fallback: 'failed or empty style profiles are omitted',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'GenerationDiagnostic NOTE_STYLE_ANALYSIS_FAILED per note',
  },
  {
    id: 'SFA-05',
    path: 'collectGenerationMaterials.resourceSources.noteRetrieval',
    fallback: 'note retrieval failure becomes an empty fragment list',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'GenerationDiagnostic NOTE_RETRIEVAL_FAILED',
  },
  {
    id: 'SFA-06',
    path: 'collectGenerationMaterials.collectOutline.activeModel',
    fallback: 'model capacity read failure yields zero outline capacity',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'GenerationDiagnostic BUDGET_INVALID_CAPACITY',
  },
  {
    id: 'SFA-07',
    path: 'collectGenerationMaterials.storyMemory',
    fallback: 'Story Memory render failure becomes empty story memory text',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'GenerationDiagnostic STORY_MEMORY_RENDER_FAILED',
  },
  {
    id: 'SFA-08',
    path: 'collectGenerationMaterials.resourcePreparation',
    fallback: 'V6 candidate collector failure becomes an empty resource pool',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'GenerationDiagnostic RESOURCE_RETRIEVAL_FAILED aggregate',
  },
  {
    id: 'SFA-09',
    path: 'collectGenerationMaterials.episodicProbe',
    fallback: 'missing probe callback uses zero demand and empty text',
    semantic: true,
    classification: 'LEGACY_ONLY',
    observability: 'Production buildContext always supplies the probe callback',
  },
  {
    id: 'SFA-10',
    path: 'contextBuilder.idfCache',
    fallback: 'IDF cache/build failure uses the original O(N²) retrieval path',
    semantic: false,
    classification: 'SAFE_NON_SEMANTIC',
    observability: 'Correctness-preserving performance fallback',
  },
  {
    id: 'SFA-11',
    path: 'contextBuilder.buildResourceContext',
    fallback: 'section render rejection is omitted by Promise.allSettled',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'GenerationDiagnostic RESOURCE_RENDER_FAILED per section',
  },
  {
    id: 'SFA-12',
    path: 'contextBuilder.buildStyleContext',
    fallback: 'style build failure falls back to original note injection',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'GenerationDiagnostic NOTE_STYLE_ANALYSIS_FAILED',
  },
  {
    id: 'SFA-13',
    path: 'contextBuilder.buildRetrievedNoteContext',
    fallback: 'retrieval failure returns empty note text',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'GenerationDiagnostic NOTE_RETRIEVAL_FAILED',
  },
  {
    id: 'SFA-14',
    path: 'contextBuilder.buildNoteContextOriginal',
    fallback: 'historical direct bulk-note path keeps an empty content map',
    semantic: true,
    classification: 'LEGACY_ONLY',
    observability: 'Main Generation path receives captured noteContents before render',
  },
  {
    id: 'SFA-15',
    path: 'contextBuilder.resolveStoryStateForRetrieval',
    fallback: 'missing/dirty/future checkpoint contributes no entity boost',
    semantic: false,
    classification: 'SAFE_NON_SEMANTIC',
    observability: 'Checkpoint eligibility and Story Memory trace carry the state',
  },
  {
    id: 'SFA-16',
    path: 'resourceContextCandidates.noteConfig',
    fallback: 'note config failure becomes mode none',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'GenerationDiagnostic NOTE_RETRIEVAL_FAILED',
  },
  {
    id: 'SFA-17',
    path: 'resourceContextCandidates.characterPayload',
    fallback: 'invalid character JSON becomes a name-only candidate',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'GenerationDiagnostic RESOURCE_RENDER_FAILED',
  },
  {
    id: 'SFA-18',
    path: 'resourceContextCandidates.noteStyleProfiles',
    fallback: 'style profile failure/empty profile is omitted',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'GenerationDiagnostic NOTE_STYLE_ANALYSIS_FAILED per note',
  },
  {
    id: 'SFA-19',
    path: 'resourceContextCandidates.noteStyleCollection',
    fallback: 'style collector failure falls back to original notes',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'GenerationDiagnostic NOTE_STYLE_ANALYSIS_FAILED',
  },
  {
    id: 'SFA-20',
    path: 'resourceContextCandidates.noteRetrieval',
    fallback: 'retrieval failure returns zero note candidates',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'GenerationDiagnostic NOTE_RETRIEVAL_FAILED',
  },
  {
    id: 'SFA-21',
    path: 'resourceContextCandidates.noteContents',
    fallback: 'bulk note body failure uses empty bodies',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'GenerationDiagnostic NOTE_RETRIEVAL_FAILED',
  },
  {
    id: 'SFA-22',
    path: 'resources.hydrateFrozenStyleProfiles.cache',
    fallback: 'style cache read failure is treated as a cache miss',
    semantic: false,
    classification: 'SAFE_NON_SEMANTIC',
    observability: 'Analyzer is attempted against the already-frozen note body',
  },
  {
    id: 'SFA-23',
    path: 'resources.hydrateFrozenStyleProfiles.analyzer',
    fallback: 'unavailable style analyzer leaves the frozen note without a profile',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'Resource warning NOTE_STYLE_ANALYSIS_FAILED and GenerationDiagnostic',
  },
  {
    id: 'SFA-24',
    path: 'resources.hydrateFrozenRetrieval',
    fallback: 'invalid/failed retrieval uses frozen candidate fragments',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'Resource warning NOTE_RETRIEVAL_FAILED and GenerationDiagnostic',
  },
  {
    id: 'SFA-25',
    path: 'resources.parseFrozenNoteBody',
    fallback: 'malformed or unavailable frozen note body is skipped',
    semantic: true,
    classification: 'DIAGNOSTIC_REQUIRED',
    observability: 'NOTE_DETAIL_COMPILE_FAILED warning at pure note compiler',
  },
  {
    id: 'SFA-26',
    path: 'resources.parseFrozenSourcePayload',
    fallback: 'historical non-JSON payload is wrapped as raw source content',
    semantic: true,
    classification: 'LEGACY_ONLY',
    observability: 'Preserves source identity for historical snapshots; current freeze writes JSON',
  },
  {
    id: 'SFA-27',
    path: 'resources.resourceContextV2.worldbookZeroHit',
    fallback: 'no keyword hit activates a bounded project fallback',
    semantic: false,
    classification: 'SAFE_NON_SEMANTIC',
    observability: 'Candidate activationReason project_fallback is frozen in trace',
  },
  {
    id: 'SFA-28',
    path: 'resources.characterAwarenessCompiler.legacy',
    fallback: 'non-novel character data uses protected legacy skeleton',
    semantic: true,
    classification: 'LEGACY_ONLY',
    observability: 'fallbackMode full_source_protected and legacyCharacterFallback are frozen',
  },
  {
    id: 'SFA-29',
    path: 'resources.readSourcePayloads.characters/worldbook',
    fallback: 'enabled awareness source read failure aborts V7 compilation',
    semantic: true,
    classification: 'BLOCKING_REQUIRED',
    observability: 'ResourceContextError RESOURCE_AWARENESS_READ_FAILED',
  },
  {
    id: 'SFA-30',
    path: 'generation.renderGenerationContext.missingCandidate',
    fallback: 'allocation item without a plan candidate is rejected',
    semantic: true,
    classification: 'BLOCKING_REQUIRED',
    observability: 'GENERATION_CONTRACT_INVALID render error; no silent skip',
  },
  {
    id: 'SFA-31',
    path: 'generation.buildGenerationContextPlan.legacySources',
    fallback: 'missing historical resource source bundle yields no legacy candidates',
    semantic: true,
    classification: 'LEGACY_ONLY',
    observability: 'Current Collect stage always supplies a source bundle',
  },
  {
    id: 'SFA-32',
    path: 'generation.renderCandidateToText.zeroGrant',
    fallback: 'zero allocator grant renders an empty candidate body',
    semantic: false,
    classification: 'SAFE_NON_SEMANTIC',
    observability: 'Budget item and render trace record budget_zero/clipped state',
  },
  {
    id: 'SFA-33',
    path: 'resources.capture.includeResources',
    fallback: 'explicit resource opt-out produces empty resource boards',
    semantic: false,
    classification: 'SAFE_NON_SEMANTIC',
    observability: 'resourcesDisabledWarning and disabled trace item',
  },
] as const;

export function getUnclassifiedSemanticFallbacks(): SilentFallbackAuditEntry[] {
  return SECOND_PHASE_SILENT_FALLBACK_AUDIT.filter(
    entry => entry.semantic && !entry.classification,
  );
}

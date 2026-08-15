/**
 * Generation Replay Harness (Stability Plan §7 / Phase 6).
 *
 * Given a persisted pipeline task context (the frozen envelope), the harness
 * replays every DETERMINISTIC derivation and proves stability:
 *
 *   - envelope parse (byte hash + semantic fingerprint verification)
 *   - FrozenGenerationContext derivation (identity / digests / settings)
 *   - generationFingerprint recomputation — must equal the stored value
 *   - frozenDraftRequest fingerprint recomputation from messages — must
 *     equal the value frozen at task start
 *
 * The LLM is never required: replay works purely from persisted state, so a
 * production trace exported from a device reproduces deterministically in
 * CI. Phase 6 gate: the same fixture replayed 10 times yields identical
 * fingerprints every time.
 */
import {
  parsePersistedPipelineTaskContext,
  computeFrozenDraftRequestFingerprint,
} from '../pipelineTaskContext';
import {
  deriveFrozenGenerationContext,
  computeGenerationFingerprint,
  buildGenerationFingerprintInput,
} from './frozenGenerationContext';
import type { GenerationDiagnostic } from '../../types/generationTrace';
import type { Chapter, ContextConfig, Preset } from '../../types/novel';
import { normalizeGenerationMaterials } from '../context/generation/normalizeGenerationMaterials';
import { buildGenerationContextPlan } from '../context/generation/buildGenerationContextPlan';
import { allocateGenerationContextBudget } from '../context/generation/allocateGenerationContextBudget';
import { renderGenerationContext } from '../context/generation/renderGenerationContext';
import { freezeGenerationContext } from '../context/generation/freezeGenerationContext';
import type {
  FrozenGenerationContextContractV2,
  GenerationMaterialCandidate,
} from '../context/generation/generationContracts';
import type { CollectedGenerationMaterials } from '../context/generation/generationContracts';

export interface GenerationReplayFixtureResourceSet {
  characters?: unknown[];
  notes?: unknown[];
  noteConfig?: unknown;
  noteContents?: Record<number, string>;
  worldbookEntries?: unknown[];
  candidates?: Array<Partial<GenerationMaterialCandidate> & { candidateId: string }>;
}

export interface GenerationReplayFixtureV2 {
  fixtureId: string;
  project: { id: number; mode?: string };
  chapter: Chapter;
  chapters?: Chapter[];
  previousChapters?: Chapter[];
  episodicCandidates?: Chapter[];
  outline?: {
    text: string;
    estimatedTokens: number;
    fingerprint: string;
    outlineIds: number[];
    complete: boolean;
    blockingReason?: string;
  };
  resources?: GenerationReplayFixtureResourceSet;
  storyMemory?: {
    text?: string;
    prepared?: unknown;
    coverage?: unknown;
    coverageCandidates?: unknown;
    rawChapterIds?: number[];
  };
  contextConfig: ContextConfig;
  preset?: Preset | string;
  writerStyle?: {
    text: string;
    sourceId?: string | number | null;
  };
  modelConfig: {
    contextWindow: number;
    reservedOutputTokens: number;
    safetyMargin?: number;
  };
  policy?: {
    allocationMode?: 'legacy' | 'elastic' | 'hierarchical';
    contextBudgetVersion?: number;
    retrievalUserPrompt?: string;
  };
  expected?: FrozenGenerationContextContractV2 | null;
}

export type ReplayDiffKind =
  | 'candidate_mismatch'
  | 'selection_mismatch'
  | 'allocation_mismatch'
  | 'render_mismatch'
  | 'fingerprint_mismatch'
  | 'diagnostics_mismatch';

export interface ReplayDiff {
  kind: ReplayDiffKind;
  path: string;
  expected: unknown;
  actual: unknown;
}

export interface ReplayGenerationFixtureV2Result {
  ok: boolean;
  fixtureId: string;
  stageOrder: string[];
  actual: FrozenGenerationContextContractV2 | null;
  expected: FrozenGenerationContextContractV2 | null;
  diffs: ReplayDiff[];
  error?: string;
}

export interface ReplayDeterminismV2Result {
  iterations: number;
  allIdentical: boolean;
  candidateSignatures: string[];
  selectedSignatures: string[];
  allocationSignatures: string[];
  renderSignatures: string[];
  fingerprints: string[];
}

export interface ReplayHarnessInput {
  pipelineContextJson: string;
  pipelineContextVersion?: number | null;
  pipelineContextHash?: string | null;
  /** Ownership pins (project/chapter) for strict parse, when known. */
  expectedProjectId?: number;
  expectedChapterId?: number;
}

export interface ReplayCheckResult {
  name: string;
  passed: boolean;
  expected?: string;
  actual?: string;
}

export interface ReplayResult {
  ok: boolean;
  /** Parse succeeded and all checks below ran. */
  parsed: boolean;
  checks: ReplayCheckResult[];
  generationTraceId: string | null;
  generationFingerprint: string | null;
  diagnostics: GenerationDiagnostic[];
  poolCaptureWarnings: string[];
}

/**
 * Replay a frozen generation envelope once, verifying every deterministic
 * invariant. Throws nothing — failures come back as failed checks so callers
 * (tests, debug tooling) can report precisely what drifted.
 */
export function replayFrozenGeneration(
  input: ReplayHarnessInput,
): ReplayResult {
  const checks: ReplayCheckResult[] = [];
  let generationTraceId: string | null = null;
  let generationFingerprint: string | null = null;
  let diagnostics: GenerationDiagnostic[] = [];
  let poolCaptureWarnings: string[] = [];

  let parsed;
  try {
    parsed = parsePersistedPipelineTaskContext(
      {
        pipelineContextJson: input.pipelineContextJson,
        pipelineContextVersion: input.pipelineContextVersion,
        pipelineContextHash: input.pipelineContextHash,
      },
      {
        expectedProjectId: input.expectedProjectId,
        expectedChapterId: input.expectedChapterId,
      },
    );
  } catch (error) {
    const err = error as Error & { code?: string };
    // The semantic fingerprint check itself runs inside parse (fail-closed);
    // classify it so replay reports drift with its real name.
    const isFingerprintMismatch = err.code === 'SNAPSHOT_FINGERPRINT_MISMATCH';
    return {
      ok: false,
      parsed: false,
      checks: [
        {
          name: isFingerprintMismatch
            ? 'generation_fingerprint_matches_stored'
            : 'envelope_parse',
          passed: false,
          actual: err.message,
        },
      ],
      generationTraceId: null,
      generationFingerprint: null,
      diagnostics: [],
      poolCaptureWarnings: [],
    };
  }

  checks.push({ name: 'envelope_parse', passed: true });
  generationTraceId = parsed.trace?.generationTraceId ?? null;
  diagnostics = parsed.draftContext.stabilityDiagnostics ?? [];
  poolCaptureWarnings = parsed.frozenAuditCandidates?.captureWarnings ?? [];

  const view = deriveFrozenGenerationContext({
    pipelineTaskId: 'replay',
    parsed,
  });

  if (view) {
    generationFingerprint = view.computedGenerationFingerprint;
    checks.push({
      name: 'generation_fingerprint_matches_stored',
      passed:
        view.storedGenerationFingerprint == null ||
        view.storedGenerationFingerprint === view.computedGenerationFingerprint,
      expected: view.storedGenerationFingerprint ?? undefined,
      actual: view.computedGenerationFingerprint,
    });
  }

  if (parsed.frozenDraftRequest) {
    const recomputed = computeFrozenDraftRequestFingerprint(
      parsed.frozenDraftRequest.messages,
      {
        estimatedInputTokens: parsed.frozenDraftRequest.estimatedInputTokens,
        reservedOutputTokens: parsed.frozenDraftRequest.reservedOutputTokens,
        safetyMargin: parsed.frozenDraftRequest.safetyMargin,
        contextWindow: parsed.frozenDraftRequest.contextWindow,
      },
    );
    checks.push({
      name: 'frozen_draft_request_fingerprint_replay',
      passed: recomputed === parsed.frozenDraftRequest.requestFingerprint,
      expected: parsed.frozenDraftRequest.requestFingerprint,
      actual: recomputed,
    });
  }

  return {
    ok: checks.every(check => check.passed),
    parsed: true,
    checks,
    generationTraceId,
    generationFingerprint,
    diagnostics,
    poolCaptureWarnings,
  };
}

export interface ReplayDeterminismResult {
  iterations: number;
  allIdentical: boolean;
  fingerprints: string[];
}

/**
 * Phase 6 gate: replay the same fixture N times — every iteration must
 * produce the identical semantic fingerprint (same input → same output).
 */
export function replayDeterminism(
  input: ReplayHarnessInput,
  iterations = 10,
): ReplayDeterminismResult {
  const fingerprints: string[] = [];
  for (let i = 0; i < iterations; i++) {
    const parsed = parsePersistedPipelineTaskContext(input);
    const view = deriveFrozenGenerationContext({
      pipelineTaskId: 'replay',
      parsed,
    });
    if (!view) {
      return { iterations: i + 1, allIdentical: false, fingerprints };
    }
    fingerprints.push(view.computedGenerationFingerprint);
  }
  const allIdentical = fingerprints.every(fp => fp === fingerprints[0]);
  return { iterations, allIdentical, fingerprints };
}

/**
 * Cross-derivation consistency used by golden journeys: rebuilding the
 * fingerprint input from the PARSED envelope must reproduce the exact
 * fingerprint the serializer embedded at freeze time.
 */
export function replayFingerprintFromParsed(parsedInput: {
  draftContext: Parameters<typeof buildGenerationFingerprintInput>[0];
  execution: Parameters<typeof buildGenerationFingerprintInput>[1];
  frozenDraftRequest: Parameters<typeof buildGenerationFingerprintInput>[2];
  expectedFingerprint: string;
}): boolean {
  return (
    computeGenerationFingerprint(
      buildGenerationFingerprintInput(
        parsedInput.draftContext,
        parsedInput.execution,
        parsedInput.frozenDraftRequest,
      ),
    ) === parsedInput.expectedFingerprint
  );
}

function collectReplayFixture(
  fixture: GenerationReplayFixtureV2,
): CollectedGenerationMaterials {
  const resources = fixture.resources || {};
  const storyMemory = fixture.storyMemory || {};
  const previousChapters = [
    ...(fixture.previousChapters || []),
  ];
  const chapterList = fixture.chapters || [
    ...previousChapters,
    fixture.chapter,
  ];
  const replayCandidates = [
    ...(resources.candidates || []),
    ...(fixture.writerStyle
      ? [
          {
            candidateId: `writer_style:${fixture.writerStyle.sourceId ?? 'fixture'}`,
            sourceType: 'writer_style' as const,
            sourceId: fixture.writerStyle.sourceId ?? null,
            sourceRevision: null,
            content: fixture.writerStyle.text,
            selected: true,
            selectedReason: 'frozen_writer_style',
            requirement: 'preferred' as const,
            activation: 'explicit' as const,
          },
        ]
      : []),
  ];
  const resourceCandidates: GenerationMaterialCandidate[] = replayCandidates.map(
    (candidate, index) => ({
      candidateId: candidate.candidateId,
      sourceType: candidate.sourceType || 'other',
      sourceId: candidate.sourceId ?? null,
      sourceRevision: candidate.sourceRevision ?? null,
      contentHash: candidate.contentHash || '',
      activation: candidate.activation || 'automatic',
      selected: candidate.selected ?? Boolean(candidate.content),
      selectedReason: candidate.selectedReason ?? null,
      rejectedReason: candidate.rejectedReason ?? null,
      requirement: candidate.requirement || 'optional',
      relevance: candidate.relevance ?? null,
      priority: candidate.priority ?? null,
      selectionBoost: candidate.selectionBoost ?? null,
      demandTokens: candidate.demandTokens ?? 0,
      content: String(candidate.content ?? ''),
      sourceOrder: candidate.sourceOrder ?? index,
    }),
  );
  const outlineText = String(fixture.outline?.text || '');
  return {
    projectId: fixture.project.id,
    currentChapter: fixture.chapter,
    config: fixture.contextConfig,
    preset: fixture.preset,
    options: {
      contextBudgetVersion: fixture.policy?.contextBudgetVersion ?? 5,
      contextWindow: fixture.modelConfig.contextWindow,
      reservedOutputTokens: fixture.modelConfig.reservedOutputTokens,
      retrievalUserPrompt: fixture.policy?.retrievalUserPrompt,
    },
    chapters: chapterList,
    previousChapters,
    episodicCandidates: fixture.episodicCandidates || [],
    rawChapterIds: storyMemory.rawChapterIds || [],
    prepared: storyMemory.prepared || {},
    coverage: storyMemory.coverage || null,
    coverageCandidates: storyMemory.coverageCandidates || null,
    preOutlineContext: {
      text: outlineText,
      estimatedTokens: Number(fixture.outline?.estimatedTokens) || 0,
      fingerprint: fixture.outline?.fingerprint || '',
      outlineIds: fixture.outline?.outlineIds || [],
      complete: fixture.outline?.complete ?? true,
      ...(fixture.outline?.blockingReason
        ? { blockingReason: fixture.outline.blockingReason }
        : {}),
    },
    worldbookScanContent: previousChapters
      .map(chapter => chapter.content || '')
      .filter(Boolean)
      .join('\n\n'),
    episodicQuery: [fixture.chapter.title, fixture.chapter.synopsis]
      .filter(Boolean)
      .join('\n'),
    retrievalOptions: {
      queryText: [fixture.chapter.title, fixture.chapter.synopsis]
        .filter(Boolean)
        .join('\n'),
    },
    resourceCandidates,
    resourceSources: {
      characters: resources.characters || [],
      notes: resources.notes || [],
      noteConfig: resources.noteConfig ?? null,
      noteContents: resources.noteContents || {},
      worldbookEntries: resources.worldbookEntries || [],
      noteStyleProfiles: [],
      noteRetrievalFragments: [],
    },
    storyMemoryText: storyMemory.text || '',
  };
}

function systemTextFromPreset(preset: Preset | string | undefined): string {
  if (typeof preset === 'string') return preset;
  if (!preset) return 'Replay fixture system prompt';
  return [
    preset.system_prompt,
    preset.writing_style && `写作风格：${preset.writing_style}`,
    (preset as any).extra_instructions && `附加要求：${(preset as any).extra_instructions}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function stableRows<T extends Record<string, unknown>>(
  rows: T[],
  key: string,
): T[] {
  return [...rows].sort((left, right) =>
    String(left[key] ?? '').localeCompare(String(right[key] ?? '')),
  );
}

function compareRows(
  diffs: ReplayDiff[],
  kind: ReplayDiffKind,
  path: string,
  expectedRows: Array<Record<string, unknown>>,
  actualRows: Array<Record<string, unknown>>,
  fields: string[],
): void {
  const expectedById = new Map(
    expectedRows.map(row => [String(row.candidateId), row]),
  );
  const actualById = new Map(
    actualRows.map(row => [String(row.candidateId), row]),
  );
  const ids = new Set([...expectedById.keys(), ...actualById.keys()]);
  for (const candidateId of ids) {
    const expected = expectedById.get(candidateId);
    const actual = actualById.get(candidateId);
    if (!expected || !actual) {
      diffs.push({
        kind,
        path: `${path}.${candidateId}`,
        expected: expected ?? null,
        actual: actual ?? null,
      });
      continue;
    }
    for (const field of fields) {
      if (JSON.stringify(expected[field]) === JSON.stringify(actual[field])) continue;
      diffs.push({
        kind,
        path: `${path}.${candidateId}.${field}`,
        expected: expected[field],
        actual: actual[field],
      });
    }
  }
}

function compareReplayContracts(
  expected: FrozenGenerationContextContractV2,
  actual: FrozenGenerationContextContractV2,
): ReplayDiff[] {
  const diffs: ReplayDiff[] = [];
  const expectedCandidates = stableRows(
    expected.candidates as unknown as Array<Record<string, unknown>>,
    'candidateId',
  );
  const actualCandidates = stableRows(
    actual.candidates as unknown as Array<Record<string, unknown>>,
    'candidateId',
  );
  compareRows(
    diffs,
    'candidate_mismatch',
    'candidates',
    expectedCandidates,
    actualCandidates,
    [
      'sourceType',
      'sourceId',
      'sourceRevision',
      'contentHash',
      'activation',
      'requirement',
      'relevance',
      'priority',
      'selectionBoost',
      'demandTokens',
    ],
  );
  compareRows(
    diffs,
    'selection_mismatch',
    'selection',
    expectedCandidates,
    actualCandidates,
    ['selected', 'selectedReason', 'rejectedReason'],
  );
  compareRows(
    diffs,
    'allocation_mismatch',
    'budget',
    stableRows(
      expected.budget as unknown as Array<Record<string, unknown>>,
      'candidateId',
    ),
    stableRows(
      actual.budget as unknown as Array<Record<string, unknown>>,
      'candidateId',
    ),
    [
      'demandTokens',
      'requestedTokens',
      'minTokens',
      'targetTokens',
      'maxTokens',
      'allocatedTokens',
      'allocationReason',
      'waterLevel',
      'budgetClipped',
      'clippedByBudget',
    ],
  );
  compareRows(
    diffs,
    'render_mismatch',
    'rendered',
    stableRows(
      expected.rendered as unknown as Array<Record<string, unknown>>,
      'candidateId',
    ),
    stableRows(
      actual.rendered as unknown as Array<Record<string, unknown>>,
      'candidateId',
    ),
    [
      'allocatedTokens',
      'actualTokens',
      'included',
      'clipped',
      'clippingReason',
      'renderedHash',
    ],
  );
  if (expected.fingerprint !== actual.fingerprint) {
    diffs.push({
      kind: 'fingerprint_mismatch',
      path: 'fingerprint',
      expected: expected.fingerprint,
      actual: actual.fingerprint,
    });
  }
  if (JSON.stringify(expected.diagnostics) !== JSON.stringify(actual.diagnostics)) {
    diffs.push({
      kind: 'diagnostics_mismatch',
      path: 'diagnostics',
      expected: expected.diagnostics,
      actual: actual.diagnostics,
    });
  }
  return diffs;
}

/**
 * Phase 4 Decision Replay: execute the same six-stage pipeline against a
 * captured fixture, then compare decision-level evidence rather than only a
 * final hash. Fixture collection is an explicit replay adapter; production
 * repository IO is never reopened during Normalize/Plan/Allocate/Render.
 */
export function replayGenerationFixtureV2(
  fixture: GenerationReplayFixtureV2,
): ReplayGenerationFixtureV2Result {
  const stageOrder: string[] = [];
  try {
    stageOrder.push('collect');
    const collected = collectReplayFixture(fixture);
    stageOrder.push('normalize');
    const normalized = normalizeGenerationMaterials(collected);
    stageOrder.push('plan');
    const plan = buildGenerationContextPlan({ normalized });
    stageOrder.push('allocate');
    const allocation = allocateGenerationContextBudget({
      plan,
      contextWindow: fixture.modelConfig.contextWindow,
      reservedOutputTokens: fixture.modelConfig.reservedOutputTokens,
      safetyMargin: fixture.modelConfig.safetyMargin,
      mode: fixture.policy?.allocationMode || 'legacy',
    });
    stageOrder.push('render');
    const sourceTextByCandidateId = Object.fromEntries(
      plan.candidates.map(candidate => [candidate.candidateId, candidate.content]),
    );
    const rendered = renderGenerationContext({
      normalized,
      plan,
      allocation,
      blocks: {
        systemText: systemTextFromPreset(fixture.preset),
        instructionText: '',
        sourceTextByCandidateId,
      },
    });
    stageOrder.push('freeze');
    const actual = freezeGenerationContext({
      normalized,
      plan,
      allocation,
      rendered,
      diagnostics: [],
    });
    stageOrder.push('compare');
    const expected = fixture.expected || null;
    const diffs = expected ? compareReplayContracts(expected, actual) : [];
    return {
      ok: diffs.length === 0,
      fixtureId: fixture.fixtureId,
      stageOrder,
      actual,
      expected,
      diffs,
    };
  } catch (error) {
    return {
      ok: false,
      fixtureId: fixture.fixtureId,
      stageOrder,
      actual: null,
      expected: fixture.expected || null,
      diffs: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function signature(value: unknown): string {
  return JSON.stringify(value);
}

function decisionSignatures(contract: FrozenGenerationContextContractV2) {
  const candidates = stableRows(
    contract.candidates as unknown as Array<Record<string, unknown>>,
    'candidateId',
  );
  const budget = stableRows(
    contract.budget as unknown as Array<Record<string, unknown>>,
    'candidateId',
  );
  const rendered = stableRows(
    contract.rendered as unknown as Array<Record<string, unknown>>,
    'candidateId',
  );
  return {
    candidate: signature(candidates),
    selected: signature(
      candidates.map(candidate => ({
        candidateId: candidate.candidateId,
        selected: candidate.selected,
        selectedReason: candidate.selectedReason,
        rejectedReason: candidate.rejectedReason,
      })),
    ),
    allocation: signature(budget),
    render: signature(rendered),
    fingerprint: contract.fingerprint,
  };
}

/** Repeat the complete V2 replay and compare every decision layer. */
export function replayDeterminismV2(
  fixture: GenerationReplayFixtureV2,
  iterations = 10,
): ReplayDeterminismV2Result {
  const candidateSignatures: string[] = [];
  const selectedSignatures: string[] = [];
  const allocationSignatures: string[] = [];
  const renderSignatures: string[] = [];
  const fingerprints: string[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const result = replayGenerationFixtureV2(fixture);
    if (!result.actual) {
      return {
        iterations: index + 1,
        allIdentical: false,
        candidateSignatures,
        selectedSignatures,
        allocationSignatures,
        renderSignatures,
        fingerprints,
      };
    }
    const current = decisionSignatures(result.actual);
    candidateSignatures.push(current.candidate);
    selectedSignatures.push(current.selected);
    allocationSignatures.push(current.allocation);
    renderSignatures.push(current.render);
    fingerprints.push(current.fingerprint);
  }
  const allSame = (values: string[]) => values.every(value => value === values[0]);
  return {
    iterations,
    allIdentical:
      allSame(candidateSignatures) &&
      allSame(selectedSignatures) &&
      allSame(allocationSignatures) &&
      allSame(renderSignatures) &&
      allSame(fingerprints),
    candidateSignatures,
    selectedSignatures,
    allocationSignatures,
    renderSignatures,
    fingerprints,
  };
}

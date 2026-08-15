import * as db from './database';
import { processMacros } from './macroReplace';
import { clipTextToTokenBudget, estimateTokens } from '../utils/tokenEstimator';
import {
  type HierarchicalBudgetInput,
  type HierarchicalBudgetResult,
} from './context/hierarchicalContextAllocator';
import {
  renderCandidateToText,
  type ResourceContextCandidate,
} from './context/resourceContextCandidates';
import {
  allocateAndFreezeDetails,
  buildFrozenPresetContext,
  buildFrozenPresetContextFromSource,
  buildPhase2ContextTrace,
  buildResourceSelectionTrace,
  freezeAwarenessItems,
  intensityToDetailSoftRatio,
  projectCharacterText,
  projectNoteText,
  projectWorldbookText,
  ResourceContextError,
  RESOURCE_AWARENESS_OVER_BUDGET_MESSAGE,
  type FrozenPresetContext,
  type FrozenResourceDetailItem,
  type GlobalAwarenessCandidate,
  type Phase2BudgetResources,
} from './context/resources';
import {
  DEFAULT_CONTEXT_AUTOMATION_POLICY_V3,
  hashContextAutomationPolicyV3,
  type ContextBudgetBoardKey,
  type ContextAutomationPolicyV3,
} from './contextAutomationPolicy';
import type { Chapter, ContextConfig, Preset } from '../types/novel';
import type { ChatMessage } from './llm';
import {
  GenerationStageStopwatch,
} from './context/generationStageContracts';
import {
  createGenerationDiagnosticCollector,
  type DiagnosticSink,
} from './context/generationDiagnostics';
import type { GenerationDiagnostic } from '../types/generationTrace';
import type { ContextTraceItem } from '../types/contextTrace';
import type { PipelineContextSnapshot } from '../types/pipelineContext';
import {
  deriveContextSafetyMargin,
  OutlineContextError,
} from './outlineContextBuilder';
import {
  getOrAnalyzeNoteStyle,
  mergeStyleProfiles,
  DEFAULT_STYLE_WEIGHTS,
  type StyleWeights,
} from './styleAnalyzer';
import { retrieveNoteFragments, type RetrievalQuery } from './noteRetriever';
import {
  buildPendingBridgeText,
  estimateStoryCoverageCandidateDemand,
  excludeRawFromEpisodicCandidates,
  resolveStoryMemoryCoverage,
  STORY_MEMORY_MAX_RAW_CHAPTERS,
} from './storyMemory/storyMemoryCoverage';
import { renderStoryMemoryForContext } from './storyMemory/storyMemoryRenderer';
import { prepareStoryMemoryForGeneration } from './storyMemory/storyMemoryPrepare';
import type { StoryMemoryPrepareWarning } from './storyMemory/storyMemoryPrepare';
import {
  resolveUsableCheckpointForTarget,
  type CheckpointEligibilityResult,
} from './storyMemory/storyMemoryCheckpointEligibility';
import type { StoryMemoryCoveragePlan } from './storyMemory/storyMemoryTypes';
import * as episodicMemoryRetriever from './episodicMemoryRetriever';
import {
  collectStoryRetrievalTerms,
  findActiveStoryTerms,
  formatMemoryCandidateLine,
  orderCandidatesForDisplay,
  resolveEpisodicRetrievalMode,
  scoreMemoryCandidates,
  selectCandidatesWithinTokenBudget,
  selectMemoryCandidates,
  tokenizeForMemoryRetrieval,
  type MemoryRetrievalOptions,
} from './episodicMemoryRetriever';
import * as idfCache from '../utils/idfCache';
import {
  buildGenerationContextPlan,
} from './context/generation/buildGenerationContextPlan';
import {
  collectGenerationMaterials,
  deriveGenerationOutlineBudgetTokens,
} from './context/generation/collectGenerationMaterials';
import { normalizeGenerationMaterials } from './context/generation/normalizeGenerationMaterials';
import { allocateGenerationContextBudget } from './context/generation/allocateGenerationContextBudget';
import type {
  GenerationBudgetDemand,
  GenerationBudgetAllocation,
  GenerationResourceSources,
} from './context/generation/generationContracts';
import {
  renderGenerationContext,
  type LegacyRenderBlocks,
} from './context/generation/renderGenerationContext';
import { freezeGenerationContext } from './context/generation/freezeGenerationContext';
import {
  selectPreviousChapters as selectPreviousChaptersPure,
  type PreviousChapterSelectionConfig,
} from './context/generation/selectPreviousChapters';

export { deriveGenerationOutlineBudgetTokens };

const DEFAULT_SYSTEM_PROMPT =
  '你是一位经验丰富的中文小说作者。请根据既有设定、人物状态、章节概要和前文内容，继续创作自然、连贯、有画面感的中文小说。';

type PartialContextConfig = Partial<ContextConfig> &
  Partial<PreviousChapterSelectionConfig>;

export interface BuildContextResult {
  messages: ChatMessage[];
  chapters: Chapter[];
  trace: ContextTraceItem[];
  estimatedInputTokens: number;
  /**
   * Shared snapshot of the context actually injected into the draft messages.
   * Downstream pipeline stages (review / factCheck / proof) MUST consume this
   * instead of re-reading the DB or re-parsing `messages`. See SPEC §7.
   */
  pipelineContext: PipelineContextSnapshot;
  /** Local readiness warnings; safe coverage never blocks the request. */
  storyMemoryWarnings: StoryMemoryPrepareWarning[];
  /** Phase 2+ elastic budget trace when options.elasticBudget is enabled. */
  elasticBudgetTrace?: import('./pipeline/elasticBudgetAllocator').ElasticBudgetTrace;
  /**
   * Context Budget V3 hierarchical allocator trace when
   * options.contextBudgetVersion >= 6. Carries per-board demand/soft/borrow/
   * allocated plus per-item traces for resources; the Preview screen renders
   * these so the user can see WHY each section got the budget it did.
   */
  hierarchicalBudgetTrace?: HierarchicalBudgetResult;
  /**
   * Stability Phase 4 (layer 1) — per-stage wall-clock telemetry for the
   * collect/allocate/render/freeze spans (plan §21). Observation only.
   */
  stageTimings?: import('./context/generationStageContracts').GenerationStageTimings;
  /** Stability Phase 4 — observational collect-stage summary (plan §4.1). */
  collectedMaterials?: import('./context/generationStageContracts').CollectedGenerationMaterialsSummary;
  /** Stability Phase 5 — semantic degradations from this build (plan §9). */
  stabilityDiagnostics?: GenerationDiagnostic[];
}

export interface BuildContextOptions {
  retrievalUserPrompt?: string;
  storyMemoryMode?: 'generation' | 'preview';
  /**
   * When set, soft materials (notes / worldbook / episodic / story memory)
   * shrink to leave room for the full outline + reserved output + safety margin.
   * Outline is never clipped.
   */
  reservedOutputTokens?: number;
  /** Override active-model window (use frozen request config when available). */
  contextWindow?: number;
  /**
   * Phase 2+: replace the fixed-ratio soft budget caps with the elastic
   * 80%/95% allocator. Flag OFF keeps the legacy fixed-ratio behavior.
   */
  elasticBudget?: boolean;
  /**
   * Context Budget protocol version driving this build (Plan §12). Drives the
   * allocator branch:
   *   - missing / <= 5: V1/V2 path (legacy elastic or fixed ratio)
   *   - >= 6: V3 hierarchical board/item elastic (candidate-first resources,
   *     cross-board borrow, model-relative soft targets)
   * V3 is independent of `elasticBudget` — when both are set with version >= 6,
   * V3 takes precedence.
   */
  contextBudgetVersion?: number;
  /** Explicit pipeline preset id. Null means no explicit selection (V7). */
  requestedPresetId?: number | null;
  /** V5-only frozen Writer Style demand; must be budgeted as mandatory. */
  protectedWriterStyleTokens?: number;
  /**
   * Optional V3 policy override. When omitted the default balanced preset is
   * used; auto-config persists the chosen policy under `context_auto_policy_v3`
   * so resumed tasks see the same board ratios.
   */
  contextAutomationPolicyV3?: typeof DEFAULT_CONTEXT_AUTOMATION_POLICY_V3;
}

const V3_DEMAND_PROBE_BUDGET = 1_000_000;

/**
 * Measure episodic demand from the already-collected in-memory candidates.
 * This helper deliberately has no database or network boundary: callers may
 * use it once for Phase A and once for the post-coverage reconciliation pass.
 */
async function measureV3EpisodicDemand(input: {
  projectId: number;
  candidates: Chapter[];
  currentChapter: Chapter;
  retrievalOptions: MemoryRetrievalOptions;
  onDiagnostic?: DiagnosticSink;
}): Promise<{ demandTokens: number; text: string }> {
  if (input.candidates.length === 0) {
    return { demandTokens: 0, text: '' };
  }
  try {
    const signature = idfCache.computeMemorySummarySignature(input.candidates);
    let idf = idfCache.getCachedIdf(input.projectId, signature);
    if (!idf) {
      idf = buildIdf(
        input.candidates
          .map(c => String((c as any).memory_summary || ''))
          .filter(Boolean),
      );
      idfCache.setCachedIdf(input.projectId, signature, idf);
    }
    const text = buildMemoryContextWithIdf(
      input.candidates,
      input.currentChapter,
      idf,
      Math.max(input.candidates.length, 1),
      V3_DEMAND_PROBE_BUDGET,
      input.retrievalOptions,
    );
    return { demandTokens: estimateTokens(text), text };
  } catch (error) {
    input.onDiagnostic?.({
      code: 'EPISODIC_MEMORY_RETRIEVAL_FAILED',
      severity: 'warning',
      message: '情节记忆需求探测失败，按 0 需求参与预算竞争',
      stage: 'collect',
      source: 'contextBuilder.measureV3EpisodicDemand',
      detail: { reason: String((error as Error)?.message || error) },
    });
    return { demandTokens: 0, text: '' };
  }
}

/**
 * Human-readable diagnostic for an eligibility decision. Used by both the
 * Renderer trace path and the coverage trace path so the reason surfaced to
 * the user stays consistent with the snapshot actually consumed.
 *
 * Position values are 0-indexed internally; user-facing copy uses +1.
 */
export function describeCheckpointEligibility(
  eligibility: import('./storyMemory/storyMemoryCheckpointEligibility').CheckpointEligibilityResult,
): string {
  switch (eligibility.reason) {
    case 'usable':
      return `检查点截至第 ${eligibility.originalThroughPosition + 1} 章`;
    case 'missing':
      return '当前项目尚无可用故事记忆检查点';
    case 'future_or_same_position': {
      const through = eligibility.originalThroughPosition;
      const target = Number.isFinite(eligibility.targetChapterPosition)
        ? eligibility.targetChapterPosition
        : Number.NaN;
      if (through >= 0 && Number.isFinite(target)) {
        return `检测到检查点截至第 ${through + 1} 章，当前目标为第 ${target + 1} 章；为防止未来剧情污染，本次未注入该检查点`;
      }
      return '检测到未来或同位置检查点；为防止未来剧情污染，本次未注入该检查点';
    }
    case 'invalid_position':
      // V2.5.16: distinguish illegal target chapter position from illegal
      // checkpoint through position — they must not share the same copy.
      if (eligibility.invalidPositionSource === 'target') {
        return '目标章节位置无效，无法安全构建故事上下文';
      }
      return '故事记忆检查点位置无效，本次未注入长期故事状态';
    case 'empty_state':
      return eligibility.originalStatus
        ? `当前故事记忆检查点状态不可用（${eligibility.originalStatus}），本次未注入长期故事状态`
        : '当前故事记忆检查点状态不可用，本次未注入长期故事状态';
    case 'not_clean':
      return eligibility.originalStatus
        ? `当前故事记忆检查点状态不可用（${eligibility.originalStatus}），本次未注入长期故事状态`
        : '当前故事记忆检查点状态不可用，本次未注入长期故事状态';
    default:
      return '当前故事记忆检查点状态不可用，本次未注入长期故事状态';
  }
}

/**
 * V2.5.15 — single source of truth for the final story_memory trace item.
 *
 * `buildContext()` runs two independent passes that both know about the
 * checkpoint:
 *   1. `renderPreparedStoryMemoryContext()` re-validates the prepared snapshot
 *      and produces the usable tokens / clipped flag / rendered preview.
 *   2. The coverage/eligibility pass knows WHY the checkpoint was (or was not)
 *      used.
 *
 * To avoid two conflicting story_memory trace entries, `buildContext()` emits
 * EXACTLY ONE trace item, and this helper merges both passes into it:
 *   - For an UNUSABLE checkpoint (future / dirty / empty / invalid / missing),
 *     `prepared.checkpoint` is null, so the Renderer sees "missing" and
 *     contributes empty text / no tokens. The reason comes from the prepared
 *     `checkpointEligibility` (the real cause), never from a second DB read.
 *   - For a USABLE checkpoint, the reason is the checkpoint position, and the
 *     tokens / clipped / preview come from the Renderer result.
 *
 * Pure function — never reads the DB — so it is unit-testable in isolation.
 */
export interface StoryMemoryTraceInput {
  eligibility: CheckpointEligibilityResult | undefined;
  rendererResult: { text: string; traceItems: ContextTraceItem[] };
  coverage: StoryMemoryCoveragePlan | undefined;
  rawChapterIds: number[];
  projectId: number;
}

export function buildStoryMemoryTraceItem(
  input: StoryMemoryTraceInput,
): ContextTraceItem {
  const { eligibility, rendererResult, coverage, rawChapterIds, projectId } =
    input;
  const checkpointPos = coverage?.checkpointThroughPosition ?? -1;
  const checkpointReason =
    eligibility && !eligibility.usable
      ? describeCheckpointEligibility(eligibility)
      : checkpointPos >= 0
        ? `检查点截至第 ${checkpointPos + 1} 章`
        : '尚无检查点';
  const statusDiagnostic =
    eligibility && !eligibility.usable && eligibility.originalStatus
      ? `检查点状态：${eligibility.originalStatus}`
      : '';
  return {
    kind: 'story_memory',
    sourceId: projectId,
    title: '长期故事检查点',
    reason: [
      checkpointReason,
      statusDiagnostic,
      coverage?.hardDue ? 'hardDue' : 'coverage完整',
      coverage && coverage.uncoveredChapterIds.length
        ? `未覆盖:${coverage.uncoveredChapterIds.join(',')}`
        : '无空洞',
      rawChapterIds.length
        ? `Episodic排除raw:${rawChapterIds.join(',')}`
        : '',
    ]
      .filter(Boolean)
      .join('；'),
    estimatedTokens: rendererResult.traceItems[0]?.estimatedTokens || 0,
    included: Boolean(rendererResult.text),
    clipped: rendererResult.traceItems[0]?.clipped || false,
    preview: rendererResult.text.slice(0, 500),
  };
}

/**
 * Pure renderer for a prepared Story Memory snapshot.
 *
 * V2.5.13+ — main `buildContext()` MUST use this with `prepared.checkpoint`
 * so coverage, entity boosts, Renderer and trace all see the SAME checkpoint
 * snapshot. This function never touches the database; it only re-validates
 * eligibility on the caller-supplied snapshot.
 *
 * V2.5.14+ — the trace `reason` now derives from the same eligibility decision
 * so a future / dirty / empty / invalid checkpoint surfaces its real cause
 * instead of a generic "尚无检查点".
 */
export function renderPreparedStoryMemoryContext(
  projectId: number,
  currentChapter: Chapter,
  checkpoint: import('../data/repositories/storyMemoryRepository').ProjectStoryMemoryRecord | null,
  budgetTokens: number,
  options?: { retrievalUserPrompt?: string },
): { text: string; traceItems: ContextTraceItem[] } {
  // Defensive re-check on the supplied snapshot only — never re-read DB.
  const eligibility = resolveUsableCheckpointForTarget(
    checkpoint,
    currentChapter.position,
  );
  if (!eligibility.usable || !eligibility.checkpoint?.state) {
    const reason = describeCheckpointEligibility(eligibility);
    // When the checkpoint exists but is unusable, surface its original status
    // as extra diagnostic copy (e.g. "检查点状态：dirty"). Missing checkpoint
    // produces no trace item, matching the legacy contract.
    return {
      text: '',
      traceItems: checkpoint
        ? [{
            kind: 'story_memory',
            sourceId: projectId,
            title: '全局故事状态',
            reason,
            estimatedTokens: 0,
            included: false,
            clipped: false,
            preview: eligibility.originalStatus
              ? `检查点状态：${eligibility.originalStatus}`
              : checkpoint.lastError || '',
          }]
        : [],
    };
  }
  const rendered = renderStoryMemoryForContext(eligibility.checkpoint.state, {
    currentChapter,
    budgetTokens,
    retrievalUserPrompt: options?.retrievalUserPrompt,
  });
  return {
    text: rendered.text,
    traceItems: [{
      kind: 'story_memory',
      sourceId: projectId,
      title: '长期故事检查点',
      reason: describeCheckpointEligibility(eligibility),
      estimatedTokens: rendered.estimatedTokens,
      included: true,
      clipped: rendered.clipped,
      preview: rendered.text.slice(0, 500),
    }],
  };
}

/**
 * Legacy wrapper: DB read + eligibility + renderPreparedStoryMemoryContext.
 * External callers that have NOT already run `prepareStoryMemoryForGeneration`
 * may still use this. The main `buildContext()` MUST NOT — it must reuse the
 * prepared snapshot via `renderPreparedStoryMemoryContext` instead.
 */
export async function buildStoryMemoryContext(
  projectId: number,
  currentChapter: Chapter,
  budgetTokens: number,
  options?: { retrievalUserPrompt?: string },
): Promise<{ text: string; traceItems: ContextTraceItem[] }> {
  if (typeof (db as any).getProjectStoryMemory !== 'function') {
    return { text: '', traceItems: [] };
  }
  const record = await (db as any).getProjectStoryMemory(projectId);
  return renderPreparedStoryMemoryContext(
    projectId,
    currentChapter,
    record,
    budgetTokens,
    options,
  );
}

export async function buildContext(
  currentChapter: Chapter,
  config: ContextConfig,
  projectId: number,
  preset?: Preset | string,
  options: BuildContextOptions = {},
): Promise<BuildContextResult> {
  // Stability Phase 4 (layer 1): named stage spans + freeze-time guards.
  // Observation only — no budget/render logic moves in this layer.
  const stageWatch = new GenerationStageStopwatch();
  stageWatch.mark('collect');
  // Stability Phase 5: semantic degradations stay non-blocking but every one
  // leaves a structured diagnostic frozen into the snapshot (plan §9).
  const diagnostics = createGenerationDiagnosticCollector();
  const pushDiagnostic: DiagnosticSink = (diagnostic: GenerationDiagnostic) =>
    diagnostics.push(diagnostic);
  const trace: ContextTraceItem[] = [];
  const budgetVersion = Number(options.contextBudgetVersion) || 0;
  const useV7 = budgetVersion >= 7;
  const useV3Hierarchical = budgetVersion === 6;
  const useHierarchicalBoards = budgetVersion >= 6;

  // Phase 2 Layer 2: source IO / checkpoint preparation / outline capture /
  // episodic query capture now live behind the real Collect stage.
  const collected = await collectGenerationMaterials({
    currentChapter,
    config,
    projectId,
    preset,
    options: options as unknown as Record<string, unknown>,
    measureEpisodicDemand: measureV3EpisodicDemand,
    onDiagnostic: pushDiagnostic,
  });
  stageWatch.close('collect', 'collect');
  stageWatch.mark('normalize');
  const normalized = normalizeGenerationMaterials(collected);
  stageWatch.close('normalize', 'normalize');
  stageWatch.mark('plan');
  const generationPlan = buildGenerationContextPlan({ normalized });
  stageWatch.close('plan', 'plan');

  // Checkpoint / pending bridge / seam preparation. This is local-only:
  // generation mode may signal background maintenance, but never waits for
  // Story Memory LLM work.
  // V2.5.14: removed the `|| true` dead-code guard — the call is unconditional
  // (prepare() itself falls back to ensureProjectStoryMemoryRow when
  // getProjectStoryMemory is absent), so the gate was misleading. Coverage,
  // entity weighting, Renderer and trace all reuse this single snapshot.
  let chapters = normalized.chapters;
  const prepared = normalized.prepared as Awaited<
    ReturnType<typeof prepareStoryMemoryForGeneration>
  >;
  let coverage = prepared?.coverage;
  const coverageCandidates = prepared?.coverageCandidates;
  let rawChapterIds = coverage?.rawChapterIds || normalized.rawChapterIds;
  const previousChapters = normalized.previousChapters;
  let episodicCandidates = normalized.episodicCandidates;

  // Resolve outline first so soft budgets can yield to the full outline plan.
  // Generation packing uses the real remaining input budget (not the 30%
  // management suggestion), so a 40% outline is allowed when the total request fits.
  const preOutlineContext = normalized.preOutlineContext;
  // Worldbook keyword scan haystack. Computed once, before the budget block,
  // so the V3 candidate collector can run upstream of the hierarchical
  // allocator. memoryText is appended later for the final scanText used by the
  // legacy V2 builders; the provisional scanText here omits it because episodic
  // memory building depends on effective budgets (circular dependency).
  const worldbookScanContent = normalized.worldbookScanContent;
  // Episodic query is computed ONCE here (before the budget block) so the V3
  // branch can measure REAL episodic demand and build a worldbook scan haystack
  // that includes episodic keywords — without re-deriving it downstream.
  // Entity boosts only from prepare()-usable checkpoints.
  const storyStateForRetrieval = resolveStoryStateForRetrieval(prepared);
  const retrievalOptions: MemoryRetrievalOptions = {
    ...(normalized.retrievalOptions as unknown as MemoryRetrievalOptions),
    storyState: storyStateForRetrieval,
  };
  // Preset + outline are the only mandatory sections; the allocator result
  // above is attached for diagnostics / freezing.
  let elasticBudgetTrace:
    | import('./pipeline/elasticBudgetAllocator').ElasticBudgetTrace
    | undefined;
  let hierarchicalBudgetTrace: HierarchicalBudgetResult | undefined;
  // V3 candidate state — populated only when the V3 branch runs. The resources
  // rendering block downstream consumes these instead of buildResourceContext.
  let v3ResourceCandidates: ResourceContextCandidate[] =
    normalized.resourcePreparation?.v3ResourceCandidates || [];
  let v3ResourceItemAllocations: ReadonlyMap<string, number> | undefined;
  let v3ResourceItemTraces: HierarchicalBudgetResult['resourceItemTraces'];
  let v3HierarchicalInput: HierarchicalBudgetInput | undefined;
  let v7Resources: Phase2BudgetResources | undefined =
    normalized.resourcePreparation?.v7Resources;
  let v7FrozenPreset: FrozenPresetContext | undefined;
  let v7FrozenDetails: FrozenResourceDetailItem[] = [];
  let v7Awareness: GlobalAwarenessCandidate[] = [];
  let generationAllocation: GenerationBudgetAllocation | undefined;
  if (normalized.resourcePreparation?.resourceCollectionError) {
    pushDiagnostic({
      code: 'RESOURCE_RETRIEVAL_FAILED',
      severity: 'warning',
      message: '资料候选收集失败，角色/世界书/笔记按空参与本次生成',
      stage: 'collect',
      source: 'collectGenerationMaterials.resourcePreparation',
      detail: {
        reason: normalized.resourcePreparation.resourceCollectionError,
      },
    });
  }
  const applyV3Allocation = (result: HierarchicalBudgetResult) => {
    hierarchicalBudgetTrace = result;
    v3ResourceItemAllocations = result.resourceItemAllocations;
    v3ResourceItemTraces = result.resourceItemTraces;
    effectiveStoryStateBudget =
      result.boardAllocations.storyState.allocatedTokens;
    effectiveResourceBudget = result.boardAllocations.resources.allocatedTokens;
    effectiveSlidingWindow =
      result.boardAllocations.slidingWindow.allocatedTokens;
    effectiveEpisodicBudget =
      result.boardAllocations.episodic.allocatedTokens;
  };
  let effectiveResourceBudget = useHierarchicalBoards
    ? V3_DEMAND_PROBE_BUDGET
    : config.resourceBudget;
  let effectiveStoryStateBudget = useHierarchicalBoards
    ? V3_DEMAND_PROBE_BUDGET
    : config.storyStateBudgetTokens ?? 8000;
  let effectiveSlidingWindow = useHierarchicalBoards
    ? V3_DEMAND_PROBE_BUDGET
    : config.slidingWindowSize;
  let effectiveMemoryTopK = useHierarchicalBoards
    ? Math.max(episodicCandidates.length, 1)
    : config.memoryTopK ?? 10;
  let effectiveEpisodicBudget = useHierarchicalBoards
    ? V3_DEMAND_PROBE_BUDGET
    : config.episodicMemoryBudgetTokens ?? config.summaryBudgetTokens ?? 20000;
  const resolvedContextWindow =
    options.contextWindow != null && options.contextWindow > 0
      ? Number(options.contextWindow)
      : 0;
  const reservedOut =
    options.reservedOutputTokens != null && options.reservedOutputTokens > 0
      ? Number(options.reservedOutputTokens)
      : 0;
  stageWatch.mark('allocate');
  if (resolvedContextWindow > 0 && reservedOut > 0) {
    const safety = deriveContextSafetyMargin(resolvedContextWindow);
    const fixedProtocol = 256;
    const outlineTokens = preOutlineContext.estimatedTokens || 0;
    const availableInput = Math.max(
      0,
      resolvedContextWindow - safety - reservedOut - fixedProtocol,
    );
    const remainingAfterOutline = Math.max(0, availableInput - outlineTokens);
    if (useHierarchicalBoards) {
      // ----- Hierarchical boards (V6 resource-candidate / V7 awareness+detail)
      const presetTextForEstimate =
        typeof preset === 'string' ? preset : buildPresetPrompt(preset);
      if (useV7) {
        v7FrozenPreset =
          typeof preset === 'string'
            ? {
                ...buildFrozenPresetContext({ requestedPresetId: null }),
                combinedText: preset,
                systemText: preset,
              }
            : buildFrozenPresetContext({
                requestedPresetId: options.requestedPresetId,
                preset: preset || null,
              });
      }
      let mandatoryTokens =
        Math.max(
          estimateTokens(
          useV7
            ? v7FrozenPreset?.combinedText || DEFAULT_SYSTEM_PROMPT
            : presetTextForEstimate || DEFAULT_SYSTEM_PROMPT,
          ),
          Number(options.protectedWriterStyleTokens) || 0,
        ) +
        outlineTokens +
        fixedProtocol;

      // --- Story State demand (real) -----------------------------------------
      // Render the prepared checkpoint with a huge budget so the result is the
      // NATURAL story-memory size (no destructive clip). Missing / dirty /
      // empty / future / invalid checkpoints yield usable=false → demand 0.
      let storyStateDemand = 0;
      const storyStateEligibility = prepared?.checkpointEligibility;
      if (prepared?.checkpoint && storyStateEligibility?.usable) {
        try {
          const probe = renderPreparedStoryMemoryContext(
            projectId,
            currentChapter,
            prepared.checkpoint,
            V3_DEMAND_PROBE_BUDGET,
            { retrievalUserPrompt: options.retrievalUserPrompt },
          );
          storyStateDemand =
            probe.traceItems[0]?.estimatedTokens || estimateTokens(probe.text);
        } catch (error) {
          // Semantic degradation: real story-state demand is UNKNOWN here,
          // not zero. Keep the degraded behavior but make it observable.
          pushDiagnostic({
            code: 'STORY_MEMORY_RENDER_FAILED',
            severity: 'warning',
            message: '故事状态需求探测失败，按 0 需求参与预算竞争',
            stage: 'collect',
            source: 'contextBuilder.storyStateDemand',
            detail: { reason: String((error as Error)?.message || error) },
          });
          storyStateDemand = 0;
        }
      }

      // Episodic demand and resource candidates are captured by Collect. The
      // allocator only consumes those immutable facts; it never opens a
      // repository or invokes a source selector.
      const resourcePreparation = normalized.resourcePreparation;
      const episodicDemand =
        resourcePreparation?.episodicProbeDemandTokens || 0;

      // --- Resources demand --------------------------------------------------
      let resourcesActualDemand = 0;
      if (useV7 && v7Resources) {
        if (v7Resources.source.preset) {
          const capturedPreset = buildFrozenPresetContextFromSource(
            v7Resources.source.preset,
            { requestedPresetId: options.requestedPresetId },
          );
          if (
            v7FrozenPreset &&
            capturedPreset.sourceFingerprint !== v7FrozenPreset.sourceFingerprint
          ) {
            throw new ResourceContextError(
              'RESOURCE_SOURCE_CHANGED_DURING_BUILD',
              '构建上下文时作家风格发生变化，已阻止把两个版本拼进同一次冻结。请稍后重试。',
              'restart_task',
              {
                before: v7FrozenPreset.sourceFingerprint,
                after: capturedPreset.sourceFingerprint,
              },
            );
          }
          v7FrozenPreset = capturedPreset;
        }
        v7Awareness = v7Resources.awareness;
        mandatoryTokens += v7Resources.awarenessTokens;
        const hardInputLimit = Math.max(
          0,
          resolvedContextWindow - safety - reservedOut,
        );
        if (mandatoryTokens > hardInputLimit) {
          throw new ResourceContextError(
            'RESOURCE_AWARENESS_OVER_BUDGET',
            RESOURCE_AWARENESS_OVER_BUDGET_MESSAGE,
            'open_llm_settings',
            {
              mandatoryTokens,
              hardInputLimit,
              awarenessTokens: v7Resources.awarenessTokens,
              overBudgetSources: v7Awareness
                .filter(item => item.fallbackMode === 'full_source_protected')
                .map(item => `${item.sourceKind}:${item.title}`),
            },
          );
        }
        const intensity = intensityToDetailSoftRatio(
          config.resourceDetailIntensity,
        );
        resourcesActualDemand = Math.ceil(
          // The intensity is a soft demand signal for the final hierarchical
          // allocator. Keep rich > balanced > save visible in competition;
          // the allocator still enforces the hard context envelope.
          v7Resources.detailDemandTokens * intensity,
        );
      } else if (useV3Hierarchical || config.includeResources) {
        resourcesActualDemand = v3ResourceCandidates.reduce(
          (sum, candidate) => sum + candidate.actualTokens,
          0,
        );
      }

      // --- Sliding demand (real raw-bridge size, ≤ 10 chapters) --------------
      // coverage.estimatedRawTokens already includes a seam reserve. With no
      // coverage (story memory off) fall back to the real sliding haystack size
      // — never the config slidingWindowSize as a hard demand cap.
      const slidingDemand =
        coverageCandidates && coverageCandidates.pendingChapters.length > 0
          ? estimateStoryCoverageCandidateDemand(coverageCandidates)
          : coverage && coverage.estimatedRawTokens > 0
            ? coverage.estimatedRawTokens
            : estimateTokens(worldbookScanContent);

      // --- Allocate ----------------------------------------------------------
      v3HierarchicalInput = {
        contextWindow: resolvedContextWindow,
        reservedOutputTokens: reservedOut,
        mandatoryTokens,
        safetyMargin: safety,
        resourceDetailIntensity: useV7
          ? config.resourceDetailIntensity
          : undefined,
        policy: options.contextAutomationPolicyV3 ?? DEFAULT_CONTEXT_AUTOMATION_POLICY_V3,
        boards: {
          storyState: { actualDemandTokens: storyStateDemand },
          resources: { actualDemandTokens: resourcesActualDemand },
          slidingWindow: { actualDemandTokens: slidingDemand },
          episodic: { actualDemandTokens: episodicDemand },
        },
        resourceItems: useV7
          ? (v7Resources?.details || []).map(item => ({
              id: item.id,
              sourceKind: item.sourceKind,
              actualTokens: item.actualTokens,
              explicitSelected: item.explicitSelected,
              activated: true,
              activationReason: item.activationReason as any,
              sourceOrder: item.sourceOrder,
              relevance: item.relevance,
            }))
          : v3ResourceCandidates.map(c => ({
              id: c.id,
              sourceKind: c.sourceKind,
              actualTokens: c.actualTokens,
              explicitSelected: c.explicitSelected,
              activated: c.activated,
              activationReason: c.activationReason,
              sourceOrder: c.sourceOrder,
            })),
      };
      const v3Allocation = allocateGenerationContextBudget({
        plan: generationPlan,
        contextWindow: v3HierarchicalInput.contextWindow,
        reservedOutputTokens: v3HierarchicalInput.reservedOutputTokens,
        safetyMargin: v3HierarchicalInput.safetyMargin,
        mode: 'hierarchical',
        hierarchicalInput: v3HierarchicalInput,
      });
      generationAllocation = v3Allocation;
      const v3Result = v3Allocation.trace as HierarchicalBudgetResult;
      applyV3Allocation(v3Result);
      if (useV7 && v7Resources) {
        v7FrozenDetails = allocateAndFreezeDetails(
          v7Resources.details,
          v3Result.resourceItemAllocations || new Map(),
        );
      }
      // Wire board grants into the effective budgets consumed by the shared
      // downstream rendering path. The allocator grant (not the config ceiling)
      // is the final clip authority.
      if (remainingAfterOutline < 1500) {
        effectiveMemoryTopK = Math.min(effectiveMemoryTopK, 2);
      } else if (remainingAfterOutline < 4000) {
        effectiveMemoryTopK = Math.min(effectiveMemoryTopK, 3);
      }
    } else if (options.elasticBudget) {
      // Elastic budget pool (Phase 2): protocol + full outline are mandatory;
      // story state / resources / sliding window / episodic compete in the
      // 80% soft pool and may borrow the 95% burst band by priority×relevance.
      // Blocked (mandatory > hard limit) zeroes soft budgets; the final fits
      // check in the draft compiler then blocks the LLM call (call count 0).
      const storyStateAvailable = config.storyStateBudgetTokens ?? 8000;
      const episodicAvailable =
        config.episodicMemoryBudgetTokens ?? config.summaryBudgetTokens ?? 20000;
      const elasticDemands: GenerationBudgetDemand[] = [
          {
            candidateId: 'protocol',
            demandTokens: fixedProtocol,
            minTokens: fixedProtocol,
            targetTokens: fixedProtocol,
            maxTokens: fixedProtocol,
            priority: 10,
            relevance: 1,
            requirement: 'mandatory',
            selectionBoost: 1,
          },
          {
            candidateId: 'outline',
            demandTokens: outlineTokens,
            minTokens: outlineTokens,
            targetTokens: outlineTokens,
            maxTokens: outlineTokens,
            priority: 10,
            relevance: 1,
            requirement: 'mandatory',
            selectionBoost: 1,
          },
          ...(Number(options.protectedWriterStyleTokens) > 0
            ? [{
                candidateId: 'writerStyle',
                demandTokens: Math.floor(
                  Number(options.protectedWriterStyleTokens),
                ),
                minTokens: Math.floor(
                  Number(options.protectedWriterStyleTokens),
                ),
                targetTokens: Math.floor(
                  Number(options.protectedWriterStyleTokens),
                ),
                maxTokens: Math.floor(
                  Number(options.protectedWriterStyleTokens),
                ),
                priority: 10,
                relevance: 1,
                requirement: 'mandatory' as const,
                selectionBoost: 1,
              }]
            : []),
          {
            candidateId: 'storyState',
            demandTokens: storyStateAvailable,
            minTokens: Math.floor(storyStateAvailable * 0.3),
            targetTokens: storyStateAvailable,
            maxTokens: storyStateAvailable,
            priority: 5,
            relevance: 0.8,
            requirement: 'preferred',
            selectionBoost: 1,
          },
          {
            candidateId: 'resources',
            demandTokens: config.resourceBudget,
            minTokens: Math.floor(config.resourceBudget * 0.3),
            targetTokens: config.resourceBudget,
            maxTokens: config.resourceBudget,
            priority: 4,
            relevance: 0.75,
            requirement: 'preferred',
            selectionBoost: 1,
          },
          {
            candidateId: 'slidingWindow',
            demandTokens: config.slidingWindowSize,
            minTokens: Math.floor(config.slidingWindowSize * 0.2),
            targetTokens: config.slidingWindowSize,
            maxTokens: config.slidingWindowSize,
            priority: 3,
            relevance: 0.6,
            requirement: 'optional',
            selectionBoost: 1,
          },
          {
            candidateId: 'episodic',
            demandTokens: episodicAvailable,
            minTokens: Math.floor(episodicAvailable * 0.3),
            targetTokens: episodicAvailable,
            maxTokens: episodicAvailable,
            priority: 4,
            relevance: 0.7,
            requirement: 'optional',
            selectionBoost: 1,
          },
        ];
      const allocationContract = allocateGenerationContextBudget({
        plan: generationPlan,
        demands: elasticDemands,
        contextWindow: resolvedContextWindow,
        reservedOutputTokens: reservedOut,
        safetyMargin: safety,
        mode: 'elastic',
      });
      generationAllocation = allocationContract;
      elasticBudgetTrace = allocationContract.trace as import('./pipeline/elasticBudgetAllocator').ElasticBudgetTrace;
      const allocationById = new Map(
        allocationContract.items.map(item => [item.candidateId, item.allocatedTokens]),
      );
      if (allocationContract.ok) {
        effectiveStoryStateBudget = allocationById.get('storyState') || 0;
        effectiveResourceBudget = allocationById.get('resources') || 0;
        effectiveSlidingWindow = allocationById.get('slidingWindow') || 0;
        effectiveEpisodicBudget = allocationById.get('episodic') || 0;
        if (remainingAfterOutline < 1500) {
          effectiveMemoryTopK = Math.min(effectiveMemoryTopK, 2);
        } else if (remainingAfterOutline < 4000) {
          effectiveMemoryTopK = Math.min(effectiveMemoryTopK, 3);
        }
      } else {
        // Mandatory (protocol + outline) exceeds the hard limit — zero all
        // soft budgets; the draft fits check blocks the LLM call.
        effectiveStoryStateBudget = 0;
        effectiveResourceBudget = 0;
        effectiveSlidingWindow = 0;
        effectiveMemoryTopK = 0;
        effectiveEpisodicBudget = 0;
      }
    } else if (remainingAfterOutline > 0) {
      const softCap = remainingAfterOutline;
      effectiveStoryStateBudget = Math.min(
        effectiveStoryStateBudget,
        Math.floor(softCap * 0.35),
      );
      effectiveResourceBudget = Math.min(
        effectiveResourceBudget,
        Math.floor(softCap * 0.4),
      );
      effectiveSlidingWindow = Math.min(
        effectiveSlidingWindow,
        Math.floor(softCap * 0.2),
      );
      effectiveEpisodicBudget = Math.min(
        effectiveEpisodicBudget,
        Math.floor(softCap * 0.25),
      );
      if (softCap < 1500) {
        effectiveMemoryTopK = Math.min(effectiveMemoryTopK, 2);
      } else if (softCap < 4000) {
        effectiveMemoryTopK = Math.min(effectiveMemoryTopK, 3);
      }
    } else if (outlineTokens > 0) {
      effectiveStoryStateBudget = 0;
      effectiveResourceBudget = 0;
      effectiveSlidingWindow = 0;
      effectiveMemoryTopK = 0;
      effectiveEpisodicBudget = 0;
    }
  }

  // Story Coverage is candidate-first in V3: only the allocator grant is
  // allowed to decide which recent chapters stay raw and which become
  // Episodic fallbacks. Legacy ContextConfig slidingWindowSize is not used for
  // this decision.
  if (
    useHierarchicalBoards &&
    coverageCandidates &&
    coverageCandidates.pendingChapters.length > 0
  ) {
    coverage = resolveStoryMemoryCoverage({
      candidates: coverageCandidates,
      slidingBudgetTokens: effectiveSlidingWindow,
    });
    rawChapterIds = coverage.rawChapterIds;
    episodicCandidates = excludeRawFromEpisodicCandidates(
      previousChapters,
      rawChapterIds,
    );
    effectiveMemoryTopK = Math.max(episodicCandidates.length, 1);

    // Phase B: Raw chapters committed by Story Coverage no longer belong to
    // Episodic demand. Reconcile exactly once with the same hierarchical
    // allocator; no DB/LLM/retrieval round is repeated and no fixed-point loop
    // is permitted here.
    if (rawChapterIds.length > 0 && v3HierarchicalInput) {
      const postCoverageEpisodic = await measureV3EpisodicDemand({
        projectId,
        candidates: episodicCandidates,
        currentChapter,
        retrievalOptions,
        onDiagnostic: pushDiagnostic,
      });
      const preliminaryEpisodicDemand =
        v3HierarchicalInput.boards.episodic.actualDemandTokens;
      if (postCoverageEpisodic.demandTokens !== preliminaryEpisodicDemand) {
        const committedBridgeDemand = Math.max(
          0,
          Math.floor(Number(coverage.estimatedRawTokens) || 0),
        );
        const finalSlidingBoard =
          committedBridgeDemand > 0
            ? {
                ...v3HierarchicalInput.boards.slidingWindow,
                // Preserve content already committed by Coverage if the
                // reclaimed capacity changes board ordering.
                minTokens: Math.max(
                  v3HierarchicalInput.boards.slidingWindow.minTokens ?? 0,
                  committedBridgeDemand,
                ),
              }
            : v3HierarchicalInput.boards.slidingWindow;
        const finalInput: HierarchicalBudgetInput = {
          ...v3HierarchicalInput,
          boards: {
            ...v3HierarchicalInput.boards,
            slidingWindow: finalSlidingBoard,
            episodic: {
              ...v3HierarchicalInput.boards.episodic,
              actualDemandTokens: postCoverageEpisodic.demandTokens,
            },
          },
        };
        const finalAllocation = allocateGenerationContextBudget({
          plan: generationPlan,
          contextWindow: finalInput.contextWindow,
          reservedOutputTokens: finalInput.reservedOutputTokens,
          safetyMargin: finalInput.safetyMargin,
          mode: 'hierarchical',
          hierarchicalInput: finalInput,
        });
        generationAllocation = finalAllocation;
        applyV3Allocation(finalAllocation.trace as HierarchicalBudgetResult);
      }
    }
  }

  // Episodic query / retrieval options were computed above (before the budget
  // block) so the V3 branch could measure real demand + enrich the worldbook
  // scan haystack. Reused unchanged here for the final memoryText render.
  if (!generationAllocation) {
    const legacyAllocations = new Map<string, number>();
    const legacyReasons = new Map<string, string>();
    let resourceRemaining = Math.max(0, Math.floor(effectiveResourceBudget));
    let episodicRemaining = Math.max(0, Math.floor(effectiveEpisodicBudget));
    for (const candidate of generationPlan.candidates) {
      const demand = Math.max(0, Math.floor(candidate.demandTokens));
      let allocated = 0;
      let reason = 'not_activated';
      if (candidate.sourceType === 'preset' || candidate.sourceType === 'outline') {
        allocated = demand;
        reason = 'mandatory';
      } else if (candidate.sourceType === 'story_memory') {
        allocated = Math.min(
          demand,
          Math.max(0, Math.floor(effectiveStoryStateBudget)),
        );
        reason = allocated > 0 ? 'legacy_story_state' : 'budget_zero';
      } else if (candidate.sourceType === 'episodic_memory') {
        allocated = Math.min(demand, episodicRemaining);
        episodicRemaining = Math.max(0, episodicRemaining - allocated);
        reason = allocated > 0 ? 'legacy_episodic' : 'budget_zero';
      } else if (
        candidate.sourceType === 'character' ||
        candidate.sourceType === 'note' ||
        candidate.sourceType === 'worldbook'
      ) {
        allocated = Math.min(demand, resourceRemaining);
        resourceRemaining = Math.max(0, resourceRemaining - allocated);
        reason = allocated > 0 ? 'legacy_resource_pool' : 'budget_zero';
      } else if (candidate.candidateId.startsWith('chapter:current:')) {
        allocated = demand;
        reason = 'mandatory';
      }
      legacyAllocations.set(candidate.candidateId, allocated);
      legacyReasons.set(candidate.candidateId, reason);
    }
    generationAllocation = allocateGenerationContextBudget({
      plan: generationPlan,
      contextWindow: resolvedContextWindow,
      reservedOutputTokens: reservedOut,
      safetyMargin:
        resolvedContextWindow > 0
          ? deriveContextSafetyMargin(resolvedContextWindow)
          : 0,
      mode: 'legacy',
      legacyAllocations,
      legacyReasons,
    });
  }
  stageWatch.close('allocate', 'allocate');
  stageWatch.mark('render');

  // V2.2.0：IDF 缓存——同项目 memory_summary 不变时复用，避免每次 tokenize+buildIdf
  let memoryText: string;
  try {
    const signature = idfCache.computeMemorySummarySignature(episodicCandidates);
    let idf = idfCache.getCachedIdf(projectId, signature);
    if (!idf) {
      idf = buildIdf(
        episodicCandidates
          .map(c => String((c as any).memory_summary || ''))
          .filter(Boolean),
      );
      idfCache.setCachedIdf(projectId, signature, idf);
    }
    memoryText = buildMemoryContextWithIdf(
      episodicCandidates,
      currentChapter,
      idf,
      effectiveMemoryTopK,
      effectiveEpisodicBudget,
      retrievalOptions,
    );
  } catch {
    // idfCache 不可用或失败时回退原始 buildMemoryContext（O(N²) 但保证正确性）
    memoryText = buildMemoryContext(
      episodicCandidates,
      currentChapter,
      effectiveMemoryTopK,
      effectiveEpisodicBudget,
      retrievalOptions,
    );
  }
  // retrievalUserPrompt 必须参与世界书扫描：空章开写时标题/概要往往不含触发词，
  // 但生成指令（含章节概要复述、用户本轮要求）里经常出现设定关键词。
  // `worldbookScanContent` was computed before the budget block so the V3
  // candidate collector can run upstream; reused here unchanged.
  const scanText = [
    currentChapter.title,
    currentChapter.synopsis,
    currentChapter.content,
    options.retrievalUserPrompt || '',
    worldbookScanContent,
    memoryText,
  ]
    .filter(Boolean)
    .join('\n\n');

  const systemPrompt = useV7
    ? v7FrozenPreset?.combinedText || DEFAULT_SYSTEM_PROMPT
    : typeof preset === 'string'
      ? preset
      : buildPresetPrompt(preset);
  const rawSystemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
  // 宏替换覆盖系统提示词修复：preset.system_prompt / writing_style / extra_instructions
  // 里的 {{char}}/{{user}}/{{chapter}}/{{synopsis}} 也需要替换，否则以字面量进入 LLM
  const resolvedSystemPrompt = await processMacros(rawSystemPrompt, {
    projectId,
    chapterTitle: currentChapter.title,
    chapterSynopsis: currentChapter.synopsis,
  });

  // Outline already resolved above (preOutlineContext) so soft budgets yielded
  // to the full outline before episodic / resource assembly.
  const outlineContext = preOutlineContext;

  const renderStageBlocks: LegacyRenderBlocks = {
    preset: {
      traceItem: {
        kind: 'preset',
        sourceId:
          typeof preset !== 'string' && preset ? (preset as any).id ?? null : null,
        title:
          typeof preset !== 'string' && preset
            ? preset.name || '作家风格'
            : '系统提示词',
        reason: '系统提示词和作家风格配置',
        estimatedTokens: estimateTokens(resolvedSystemPrompt),
        included: true,
        clipped: false,
        preview: resolvedSystemPrompt.slice(0, 500),
      },
    },
  };

  // Outline injection: the highest creative constraint. Compiled into the
  // primary system message (together with the preset) so providers that
  // de-prioritize or drop consecutive system messages still see the plan.
  // Strict no-truncation: a blocked outline throws before any model call.
  if (outlineContext.text) {
    if (!outlineContext.complete) {
      throw new OutlineContextError(
        'OUTLINE_OVER_BUDGET',
        outlineContext.blockingReason || '大纲无法完整注入，已阻止生成。',
        'open_outlines',
      );
    }
    // Keep presetText in the snapshot as the raw preset; outline is separate.
    renderStageBlocks.outline = {
      text: outlineContext.text,
      traceItem: {
        kind: 'outline',
        sourceId: null,
        title: '★ 项目大纲',
        reason: outlineContext.enabledCount
          ? `最高创作约束｜${outlineContext.enabledCount} 份｜完整注入`
          : '最高创作约束',
        estimatedTokens: outlineContext.estimatedTokens,
        included: true,
        clipped: false,
        preview: outlineContext.text.slice(0, 500),
      },
    };
  } else if (!outlineContext.complete) {
    // No text but blocked (e.g. all outlines disabled yet budget check failed
    // defensively). Surface the block reason so the user can act.
    throw new OutlineContextError(
      'OUTLINE_OVER_BUDGET',
      outlineContext.blockingReason || '大纲无法完整注入，已阻止生成。',
      'open_outlines',
    );
  }

  // Story Memory Checkpoint — reuse the SAME prepared snapshot so coverage,
  // entity boosts, Renderer and trace all see a consistent view. Never re-read
  // the DB after prepare() inside this buildContext() call.
  const storyMemory = renderPreparedStoryMemoryContext(
    projectId,
    currentChapter,
    prepared?.checkpoint ?? null,
    effectiveStoryStateBudget,
    { retrievalUserPrompt: options.retrievalUserPrompt },
  );
  if (coverage) {
    // V2.5.15: a single consolidated story_memory trace item. For an unusable
    // checkpoint `prepared.checkpoint` is null, so the Renderer above only saw
    // "missing" (empty text / no tokens); the reason here comes from the
    // prepared eligibility (the real cause: future / dirty / empty / invalid),
    // never from a second DB read. For a usable checkpoint the reason is the
    // checkpoint position and tokens/clipped/preview come from the Renderer.
    renderStageBlocks.storyMemory = {
      text: storyMemory.text,
      traceItem: buildStoryMemoryTraceItem({
        eligibility: prepared?.checkpointEligibility,
        rendererResult: storyMemory,
        coverage,
        rawChapterIds,
        projectId,
      }),
    };
  } else {
    renderStageBlocks.storyMemory = {
      text: storyMemory.text,
      traceItems: storyMemory.traceItems,
    };
  }

  // Snapshot partition capture (SPEC §7). Capture each section's text as it is
  // assembled so downstream stages reuse the SAME view, never a re-read.
  let snapshotCharacterText = '';
  let snapshotNoteText = '';
  let snapshotWorldbookText = '';

  if (useV7 && v7Resources) {
    const v7ResourceMessages: string[] = [];
    const v7ResourceTraceItems: ContextTraceItem[] = [];
    const awarenessText = v7Resources.globalResourceAwarenessText;
    if (awarenessText) {
      v7ResourceMessages.push(awarenessText);
    }
    const detailBodies: string[] = [];
    for (const item of v7FrozenDetails) {
      if (item.content) {
        detailBodies.push(item.content);
      }
    }
    if (detailBodies.length > 0) {
      v7ResourceMessages.push(
        `以下是本次写作可展开的资料详情（全局骨架已单独注入）：\n\n${detailBodies.join('\n\n')}`,
      );
    }
    snapshotCharacterText = projectCharacterText('', v7FrozenDetails);
    snapshotWorldbookText = projectWorldbookText('', v7FrozenDetails);
    snapshotNoteText = projectNoteText(v7FrozenDetails);
    if (!v7Resources.includeResources) {
      v7ResourceTraceItems.push({
        kind: 'character',
        sourceId: null,
        title: '资料上下文已关闭',
        reason: '用户关闭了角色 / 世界书 / 笔记；全局感知未生成。作家风格仍生效。',
        estimatedTokens: 0,
        included: false,
        clipped: false,
        preview: '',
        empty: true,
        resourcePreviewStatus: 'DISABLED',
      });
    } else {
      const selection = buildResourceSelectionTrace({
        awareness: v7Awareness,
        details: v7Resources.details,
        frozenDetails: v7FrozenDetails,
        includeResources: true,
        warnings: v7Resources.warnings,
      });
      if (v7FrozenPreset) {
        v7ResourceTraceItems.push(
          ...buildPhase2ContextTrace({
            preset: v7FrozenPreset,
            awareness: v7Awareness,
            details: v7FrozenDetails,
            selection,
            includeResources: true,
            styleNotePresent: v7Resources.styleNotePresent,
          }).filter(item => item.kind !== 'preset'),
        );
      }
    }
    renderStageBlocks.resources = {
      messages: v7ResourceMessages,
      traceItems: v7ResourceTraceItems,
    };
  } else if ((useV3Hierarchical || config.includeResources) && effectiveResourceBudget > 0) {
    if (useV3Hierarchical && v3ResourceCandidates.length > 0) {
      // ----- V3 candidate-first resource rendering (Plan §6 / §15) ----------
      // Each candidate is clipped to its item-allocator grant; no fixed
      // 35/20/45 split, no `remaining` order bias. Trace items carry demand /
      // soft target / allocated / borrowed / reason so Preview explains why.
      const renderedByKind: Record<
        'character' | 'note' | 'worldbook',
        string[]
      > = { character: [], note: [], worldbook: [] };
      const sectionLabels: Record<'character' | 'note' | 'worldbook', string> = {
        character: '人物设定',
        note: '项目笔记',
        worldbook: '世界书',
      };
      const resourceTraceItems: ContextTraceItem[] = [];
      const itemTracesById = new Map(
        (v3ResourceItemTraces ?? []).map(t => [t.id, t]),
      );
      for (const candidate of v3ResourceCandidates) {
        const grant = v3ResourceItemAllocations?.get(candidate.id) ?? 0;
        const { text, clipped } = renderCandidateToText(candidate, grant);
        const itemTrace = itemTracesById.get(candidate.id);
        const included = text.length > 0;
        if (included) {
          renderedByKind[candidate.sourceKind].push(text);
        }
        resourceTraceItems.push({
          kind:
            candidate.sourceKind === 'character'
              ? 'character'
              : candidate.sourceKind === 'note'
                ? 'note'
                : 'worldbook',
          sourceId: candidate.sourceId,
          title: candidate.title,
          reason: describeV3ItemReason(candidate, itemTrace?.reason),
          estimatedTokens: included ? estimateTokens(text) : candidate.actualTokens,
          included,
          clipped: clipped || (!included && candidate.actualTokens > 0),
          preview: candidate.content.slice(0, 500),
          demandTokens: candidate.actualTokens,
          allocatedTokens: grant,
          allocationReason: mapV3ItemReason(itemTrace?.reason),
        });
      }
      const parts: string[] = [];
      (['character', 'note', 'worldbook'] as const).forEach(kind => {
        const bodies = renderedByKind[kind];
        if (bodies.length > 0) {
          parts.push(`${sectionLabels[kind]}：\n${bodies.join('\n\n')}`);
        }
      });
      const resourceText = parts.join('\n\n');
      // Per-kind snapshot text: full unclipped bodies so downstream stages
      // (review / factCheck / proof) can re-clip per their own budgets.
      snapshotCharacterText = renderedByKind.character.join('\n\n');
      snapshotNoteText = renderedByKind.note.join('\n\n');
      snapshotWorldbookText = renderedByKind.worldbook.join('\n\n');
      if (resourceText) {
        const resourceMessage = `以下是本次写作必须参考的设定资料：\n\n${resourceText}`;
        renderStageBlocks.resources = {
          text: resourceMessage,
          traceItems: resourceTraceItems,
        };
      } else {
        renderStageBlocks.resources = { traceItems: resourceTraceItems };
      }
    } else {
      const resourceResult = await buildResourceContext(
        projectId,
        effectiveResourceBudget,
        scanText,
        config.worldbookRecursive !== false,
        currentChapter,
        options.retrievalUserPrompt || '',
        normalized.resourceSources,
        pushDiagnostic,
      );
      snapshotCharacterText = resourceResult.characterText;
      snapshotNoteText = resourceResult.noteText;
      snapshotWorldbookText = resourceResult.worldbookText;
      if (resourceResult.text) {
        const resourceMessage = `以下是本次写作必须参考的设定资料：\n\n${resourceResult.text}`;
        renderStageBlocks.resources = {
          text: resourceMessage,
          traceItems: resourceResult.traceItems,
        };
      } else {
        renderStageBlocks.resources = {
          traceItems: resourceResult.traceItems,
        };
      }
    }
  }

  if (memoryText) {
    const memoryMessage = `以下是相关历史章节事件：\n\n${memoryText}`;
    renderStageBlocks.memory = {
      text: memoryMessage,
      traceItem: {
        kind: 'memory',
        sourceId: null,
        title: '相关历史章节事件',
        reason: '章节事件记忆 TF-IDF 检索（已排除 raw bridge 章节）',
        estimatedTokens: estimateTokens(memoryMessage),
        included: true,
        clipped: false,
        preview: memoryMessage.slice(0, 500),
      },
    };
  }

  // Pending bridge + seam: prefer coverage plan; fall back to sliding window.
  let previousContent = '';
  if (coverage && coverage.pendingChapters.length > 0) {
    const byId = new Map(chapters.map(chapter => [chapter.id, chapter]));
    previousContent = buildPendingBridgeText(coverage, byId);
    if (
      coverage.seamChapter &&
      !coverage.rawChapterIds.includes(coverage.seamChapter.id)
    ) {
      const seam = coverage.seamChapter;
      const seamBlock = `【衔接章｜第 ${seam.position + 1} 章｜${
        seam.title || ''
      }】\n${seam.content}`;
      previousContent = previousContent
        ? `${previousContent}\n\n${seamBlock}`
        : seamBlock;
    }
  } else {
    if (useHierarchicalBoards) {
      // V6 has no manual strategy/full/custom path. When there is no pending
      // checkpoint bridge, render the bounded recent candidate set and let the
      // allocator grant below clip the rendered bytes.
      const recent = selectPreviousChapters(
        currentChapter,
        {
          strategy: 'sliding',
          recentChapterCount: STORY_MEMORY_MAX_RAW_CHAPTERS,
        },
        chapters,
      );
      const recentText = recent
        .map(
          chapter =>
            `第 ${chapter.position + 1} 章「${chapter.title || '未命名'}」\n${
              chapter.content
            }`,
        )
        .join('\n\n');
      previousContent = clipTextTailToTokenBudget(
        recentText,
        effectiveSlidingWindow,
      );
    } else {
      previousContent = buildPreviousContentText(
        currentChapter,
        { ...config, slidingWindowSize: effectiveSlidingWindow },
        chapters,
      );
    }
  }

  // Pending bridge / seam text for the snapshot. Captured in macro-processed
  // form because that is exactly what the draft saw — downstream stages must
  // see the same view, not the raw pre-macro text.
  let snapshotRecentBridgeText = '';
  if (previousContent) {
    const processedBeforeBudget = await processMacros(previousContent, {
      projectId,
      chapterTitle: currentChapter.title,
      chapterSynopsis: currentChapter.synopsis,
    });
    const processed = useHierarchicalBoards
      ? clipTextTailToTokenBudget(
          processedBeforeBudget,
          effectiveSlidingWindow,
        )
      : processedBeforeBudget;
    snapshotRecentBridgeText = processed;
    const prevMessage = `以下是检查点之后的近期正文/桥接内容，请重点承接最后发生的事件；若与长期状态冲突，以位置更晚的近期正文为准：\n\n${processed}`;
    renderStageBlocks.previousBridge = {
      messageText: prevMessage,
      traceItem: {
        kind: coverage?.pendingChapters.length
          ? 'story_memory_bridge'
          : 'chapter',
        sourceId: currentChapter.id ?? null,
        title: coverage?.pendingChapters.length
          ? 'Pending Bridge / Seam'
          : '前文滑动窗口',
        reason: coverage?.pendingChapters.length
          ? `raw:${coverage.rawChapterIds.join(',') || '无'}; episodicFallback:${
              coverage.episodicFallbackChapterIds.join(',') || '无'
            }; tokens≈${coverage.estimatedRawTokens}`
          : '前文滑动窗口',
        estimatedTokens: estimateTokens(prevMessage),
        included: true,
        clipped: false,
        preview: prevMessage.slice(0, 500),
      },
    };
  }

  const instructionContent = [
    `当前章节：「${
      currentChapter.title || `第 ${currentChapter.position + 1} 章`
    }」`,
    `章节概要：${
      currentChapter.synopsis || '无明确概要，请自然承接前文推进剧情。'
    }`,
  ].join('\n');
  renderStageBlocks.instruction = {
    messageText: instructionContent,
    traceItem: {
      kind: 'instruction',
      sourceId: currentChapter.id ?? null,
      title: currentChapter.title || `第 ${currentChapter.position + 1} 章`,
      reason: '当前章节指令',
      estimatedTokens: estimateTokens(instructionContent),
      included: true,
      clipped: false,
      preview: instructionContent.slice(0, 500),
    },
  };

  const finalGenerationAllocation = generationAllocation;
  if (!finalGenerationAllocation) {
    throw new Error('GENERATION_BUDGET_ALLOCATION_MISSING');
  }

  const renderedContext = renderGenerationContext({
    normalized,
    plan: generationPlan,
    allocation: finalGenerationAllocation,
    blocks: {
      systemText: resolvedSystemPrompt,
      instructionText: '',
      sourceTextByCandidateId: {},
      legacy: renderStageBlocks,
    },
  });
  const messages = renderedContext.messages;
  trace.push(...renderedContext.trace);
  const estimatedInputTokens = renderedContext.estimatedInputTokens;

  // Keep the immediately preceding chapter separate from the sliding bridge.
  // The bridge may be clipped or assembled from several chapters, while Final
  // V3 must always be able to recover the exact last-chapter seam.
  stageWatch.close('render', 'render');
  stageWatch.mark('freeze');
  const frozenGenerationContract = freezeGenerationContext({
    normalized,
    plan: generationPlan,
    allocation: finalGenerationAllocation,
    rendered: renderedContext,
    diagnostics: diagnostics.list(),
  });
  stageWatch.close('freeze', 'freeze');
  const immediatePreviousChapter = chapters
    .filter(chapter => chapter.position < currentChapter.position && chapter.content)
    .sort((a, b) => b.position - a.position)[0];
  const immediatePreviousChapterText = useHierarchicalBoards
    ? ''
    : immediatePreviousChapter?.content || '';
  const immediatePreviousChapterEnding =
    immediatePreviousChapter?.content?.slice(-1200) || '';

  const pipelineContext: PipelineContextSnapshot = {
    presetText: resolvedSystemPrompt,
    storyMemoryText: storyMemory.text,
    characterText: snapshotCharacterText,
    noteText: snapshotNoteText,
    worldbookText: snapshotWorldbookText,
    episodicMemoryText: memoryText,
    recentBridgeText: snapshotRecentBridgeText,
    immediatePreviousChapterText,
    immediatePreviousChapterEnding,
    immediatePreviousChapterId: immediatePreviousChapter?.id,
    immediatePreviousChapterPosition: immediatePreviousChapter?.position,
    currentInstructionText: instructionContent,
    retrievalUserPrompt: options.retrievalUserPrompt || '',
    // Frozen outline snapshot: every stage of this task reads these fields
    // instead of re-querying the DB, so a mid-task outline edit cannot change
    // the plan the draft was generated against.
    outlineText: outlineContext.text,
    outlineFingerprint: outlineContext.fingerprint,
    outlineIds: outlineContext.outlineIds,
    outlineComplete: outlineContext.complete,
    outlineBlockingReason: outlineContext.blockingReason,
    outlineEstimatedTokens: outlineContext.estimatedTokens,
    sourceFingerprint: `proj=${projectId}|chapter=${currentChapter.id ?? currentChapter.position}`,
    generationContract: frozenGenerationContract,
    // Stability Phase 5 — semantic degradations frozen with the snapshot.
    stabilityDiagnostics:
      diagnostics.list().length > 0 ? diagnostics.list() : undefined,
    stageTimings: stageWatch.result(),
    contextBudgetV3Summary:
      hierarchicalBudgetTrace && useV3Hierarchical
        ? buildV3Summary(hierarchicalBudgetTrace, options.contextAutomationPolicyV3)
        : undefined,
    ...(useV7
      ? {
          resourceContextVersion: 2 as const,
          characterAwarenessText: v7Resources?.characterAwarenessText || '',
          worldbookAwarenessText: v7Resources?.worldbookAwarenessText || '',
          globalResourceAwarenessText:
            v7Resources?.globalResourceAwarenessText || '',
          resourceAwarenessItems: freezeAwarenessItems(v7Awareness),
          resourceDetailItems: v7FrozenDetails,
          resourceSelectionTrace: v7Resources
            ? buildResourceSelectionTrace({
                awareness: v7Awareness,
                details: v7Resources.details,
                frozenDetails: v7FrozenDetails,
                includeResources: v7Resources.includeResources,
                warnings: v7Resources.warnings,
              })
            : [],
          presetSystemText: v7FrozenPreset?.systemText,
          presetWritingStyleText: v7FrozenPreset?.writingStyleText,
          presetExtraInstructionsText: v7FrozenPreset?.extraInstructionsText,
          presetSourceFingerprint: v7FrozenPreset?.sourceFingerprint,
          presetSource: v7FrozenPreset?.presetSource,
          includeResources: config.includeResources !== false,
          resourcesDisabledWarning:
            config.includeResources === false
              ? '资料上下文已关闭：角色 / 世界书 / 笔记不会进入本次任务。作家风格仍生效。'
              : undefined,
          contextBudgetV7Summary: hierarchicalBudgetTrace
            ? buildV7Summary(
                hierarchicalBudgetTrace,
                options.contextAutomationPolicyV3,
                v7Resources?.awarenessTokens || 0,
                v7Resources?.detailDemandTokens || 0,
                v7FrozenDetails.reduce(
                  (sum, item) => sum + (item.allocatedTokens || 0),
                  0,
                ),
              )
            : undefined,
        }
      : {}),
  };

  return {
    messages,
    chapters,
    trace,
    estimatedInputTokens,
    pipelineContext,
    storyMemoryWarnings: prepared?.warnings || [],
    elasticBudgetTrace,
    hierarchicalBudgetTrace,
    stageTimings: stageWatch.result(),
    stabilityDiagnostics: diagnostics.list(),
    collectedMaterials: {
      chapterCount: chapters.length,
      previousChapterCount: previousChapters.length,
      episodicCandidateCount: episodicCandidates.length,
      storyMemoryCheckpointUsable:
        prepared?.checkpointEligibility?.usable ?? null,
      outlineEstimatedTokens: preOutlineContext.estimatedTokens ?? null,
      contextBudgetVersion: budgetVersion,
    },
  };
}

/**
 * Build the V3 summary embedded in PipelineContextSnapshot (Plan §13).
 * Downstream stages (review / factCheck / proof) read this to render the same
 * allocation view the draft saw, without re-running the allocator. Pure /
 * deterministic — never touches the DB.
 */
function buildV7Summary(
  trace: HierarchicalBudgetResult,
  policy: ContextAutomationPolicyV3 | undefined,
  protectedAwarenessTokens: number,
  resourceDetailDemandTokens: number,
  resourceDetailAllocatedTokens: number,
): import('../types/pipelineContext').ContextBudgetV7Summary {
  const base = buildV3Summary(trace, policy);
  return {
    ...base,
    contextBudgetVersion: 7,
    resourceContextVersion: 2,
    protectedAwarenessTokens,
    resourceDetailDemandTokens,
    resourceDetailAllocatedTokens,
  };
}

function buildV3Summary(
  trace: HierarchicalBudgetResult,
  policy: ContextAutomationPolicyV3 | undefined,
): import('../types/pipelineContext').ContextBudgetV3Summary {
  const usedPolicy = policy ?? DEFAULT_CONTEXT_AUTOMATION_POLICY_V3;
  const policyHash = hashContextAutomationPolicyV3(usedPolicy);
  return {
    contextBudgetVersion: 6,
    contextAutomationPolicyVersion: 'context-automation-v3',
    policyHash,
    contextAutomationPolicyHash: policyHash,
    contextAutomationPolicySnapshot: JSON.parse(JSON.stringify(usedPolicy)),
    envelope: { ...trace.envelope },
    boards: (
      Object.values(trace.boardAllocations) as Array<
        (typeof trace.boardAllocations)[ContextBudgetBoardKey]
      >
    ).map(b => ({
      key: b.key,
      actualDemandTokens: b.actualDemandTokens,
      softTargetTokens: b.softTargetTokens,
      elasticMaxTokens: b.elasticMaxTokens,
      allocatedTokens: b.allocatedTokens,
      reclaimedTokens: b.reclaimedTokens,
      borrowedTokens: b.borrowedTokens,
      reason: b.reason,
    })),
  };
}

/**
 * Map a V3 item allocator reason code to the public ContextAllocationReason
 * vocabulary (Plan §15). Allocator reasons not in the public set fall back to
 * 'item_competition' so the Preview always has something to show.
 */
function mapV3ItemReason(
  reason: string | undefined,
): import('../types/contextTrace').ContextAllocationReason | undefined {
  if (!reason) return undefined;
  switch (reason) {
    case 'mandatory':
    case 'min':
    case 'small_full_fit':
    case 'redistributed':
      return 'full_fit';
    case 'burst':
      return 'global_borrow';
    case 'reclaimed':
      return 'item_competition';
    case 'not_activated':
      return 'not_activated';
    default:
      return 'item_competition';
  }
}

/**
 * Build a human-readable reason string for a V3 resource item trace. Combines
 * the candidate's activation source with the allocator's decision so the
 * Preview shows both WHY the candidate was activated and HOW it was funded.
 */
function describeV3ItemReason(
  candidate: ResourceContextCandidate,
  allocatorReason: string | undefined,
): string {
  const activationLabel: Record<string, string> = {
    primary_secondary_hit: '主+次关键词命中',
    constant: '常驻',
    primary_hit: '主关键词命中',
    recursive_hit: '递归命中',
    project_fallback: '项目启用兜底',
    explicit: '用户显式选择',
  };
  const source =
    activationLabel[candidate.activationReason ?? 'explicit'] ?? '显式选择';
  const funded = allocatorReason ? `｜分配:${allocatorReason}` : '';
  return `${source}${funded}`;
}

function buildPresetPrompt(preset?: Preset): string {
  if (!preset) return DEFAULT_SYSTEM_PROMPT;
  const parts = [preset.system_prompt || DEFAULT_SYSTEM_PROMPT];
  if (preset.writing_style) parts.push(`写作风格：${preset.writing_style}`);
  if (preset.extra_instructions)
    parts.push(`附加要求：${preset.extra_instructions}`);
  return parts.join('\n\n');
}

/**
 * Resolve the project mode + active model context window, then build the
 * outline context with its own budget.
 *
 * Fail-closed:
 *  - non-outline modes → empty (legal)
 *  - no enabled outlines → empty (legal)
 *  - repository / project read failures → rethrow OutlineContextError
 *  - OutlineContextError from buildOutlineContext → rethrow
 *
 * Missing LLM config yields budget 0 so outlines still inject; the pipeline
 * final window check separately blocks real generation when the model window
 * is unknown.
 */
/**
 * Generation packing budget for outlines.
 *
 * Management UI still shows OUTLINE_BUDGET_RATIO (30%) as a soft suggestion.
 * Actual generation only blocks when full outline + fixed prompt + mandatory
 * body + output reserve + safety margin exceed the model window.
 */
/**
 * Resource context result with per-section text (SPEC §7.4). `text` keeps the
 * legacy combined string the draft consumes; `characterText` / `noteText` /
 * `worldbookText` preserve the activated bodies so downstream stages (review /
 * factCheck / proof) can re-clip per their own budgets without re-reading the
 * database or re-parsing the draft messages.
 */
interface ResourceContextResult {
  text: string;
  characterText: string;
  noteText: string;
  worldbookText: string;
  traceItems: ContextTraceItem[];
}

async function buildResourceContext(
  projectId: number,
  budget: number,
  scanText: string,
  recursiveWorldbook: boolean,
  currentChapter?: Chapter,
  retrievalUserPrompt = '',
  resourceSources?: GenerationResourceSources,
  onDiagnostic?: DiagnosticSink,
): Promise<ResourceContextResult> {
  if (!resourceSources) {
    throw new Error('GENERATION_RESOURCE_SOURCES_NOT_CAPTURED');
  }
  const capturedSources = resourceSources;
  const parts: string[] = [];
  const allTraceItems: ContextTraceItem[] = [];
  const characterBudget = Math.floor(budget * 0.35);
  const noteBudget = Math.floor(budget * 0.2);
  const worldbookBudget = Math.max(0, budget - characterBudget - noteBudget);
  const addPart = (title: string, text: string, sectionBudget: number) => {
    if (!text || sectionBudget <= 0) return;
    const clipped = clipTextToTokenBudget(text, sectionBudget);
    if (!clipped) return;
    parts.push(`${title}：\n${clipped}`);
  };

  const [charSettled, noteSettled, wbSettled] = await Promise.allSettled([
    buildCharacterContext(
      projectId,
      characterBudget,
      capturedSources.characters,
      onDiagnostic,
    ),
    buildNoteContext(
      projectId,
      noteBudget,
      scanText,
      currentChapter?.title || '',
      currentChapter?.synopsis || '',
      retrievalUserPrompt,
      onDiagnostic,
      capturedSources,
    ),
    buildWorldbookContext(
      projectId,
      worldbookBudget,
      scanText,
      recursiveWorldbook,
      capturedSources.worldbookEntries,
    ),
  ]);

  // Capture the per-section text BEFORE addPart clips it, so the snapshot
  // preserves the full activated body (downstream stages re-clip per budget).
  const characterText =
    charSettled.status === 'fulfilled' ? charSettled.value.text : '';
  const noteText =
    noteSettled.status === 'fulfilled' ? noteSettled.value.text : '';
  const worldbookText =
    wbSettled.status === 'fulfilled' ? wbSettled.value.text : '';

  const reportFailure = (
    result: PromiseSettledResult<unknown>,
    source: string,
    message: string,
  ) => {
    if (result.status !== 'rejected') return;
    onDiagnostic?.({
      code: 'RESOURCE_RENDER_FAILED',
      severity: 'warning',
      message,
      stage: 'render',
      source,
      detail: {
        reason: String((result.reason as Error)?.message || result.reason),
      },
    });
  };
  reportFailure(
    charSettled,
    'contextBuilder.buildResourceContext.characters',
    '角色资料渲染失败，角色资料未进入本次生成',
  );
  reportFailure(
    noteSettled,
    'contextBuilder.buildResourceContext.notes',
    '笔记资料渲染失败，笔记资料未进入本次生成',
  );
  reportFailure(
    wbSettled,
    'contextBuilder.buildResourceContext.worldbook',
    '世界书渲染失败，世界书资料未进入本次生成',
  );

  if (charSettled.status === 'fulfilled') {
    addPart('人物设定', charSettled.value.text, characterBudget);
    allTraceItems.push(...charSettled.value.items);
  }
  if (noteSettled.status === 'fulfilled') {
    addPart('项目笔记', noteSettled.value.text, noteBudget);
    allTraceItems.push(...noteSettled.value.items);
  }
  if (wbSettled.status === 'fulfilled') {
    addPart('世界书', wbSettled.value.text, worldbookBudget);
    allTraceItems.push(...wbSettled.value.items);
  }

  return {
    text: parts.join('\n\n'),
    characterText,
    noteText,
    worldbookText,
    traceItems: allTraceItems,
  };
}

export async function buildCharacterContext(
  projectId: number,
  budget: number,
  capturedCharacters?: unknown[],
  onDiagnostic?: DiagnosticSink,
): Promise<{ text: string; items: ContextTraceItem[] }> {
  const characters =
    capturedCharacters ?? (await db.getCharactersByProject(projectId));
  const parts: string[] = [];
  const items: ContextTraceItem[] = [];
  let remaining = budget;

  for (const character of characters as any[]) {
    const data = safeJson(character.data_json, onDiagnostic);
    const card = data.data || data;
    const charName = character.name || card.name || '未命名角色';
    const text = [
      `角色「${charName}」`,
      card.system_prompt && `角色系统提示：${card.system_prompt}`,
      card.description && `描述：${card.description}`,
      card.personality && `性格：${card.personality}`,
      card.scenario && `场景：${card.scenario}`,
      card.first_mes && `开场消息：${card.first_mes}`,
      card.mes_example && `对话示例：${card.mes_example}`,
      card.post_history_instructions &&
        `后置指令：${card.post_history_instructions}`,
    ]
      .filter(Boolean)
      .join('\n');
    const charBudget = Math.min(
      remaining,
      Number(character.max_tokens ?? 50000),
    );
    const clipped = clipTextToTokenBudget(text, charBudget);
    const wasClipped = clipped !== text && clipped.length < text.length;
    const included = clipped.length > 0;

    if (included) {
      parts.push(clipped);
      remaining -= estimateTokens(clipped);
    }

    items.push({
      kind: 'character',
      sourceId: Number(character.id) || null,
      title: charName,
      reason: `角色设定：${charName}`,
      estimatedTokens: included
        ? estimateTokens(clipped)
        : estimateTokens(text),
      included,
      clipped: wasClipped,
      preview: text.slice(0, 500),
    });

    if (remaining <= 0) break;
  }

  // Mark characters that weren't processed due to budget as clipped
  for (let i = 0; i < (characters as any[]).length; i++) {
    const character = (characters as any[])[i];
    const existingItem = items.find(it => it.sourceId === Number(character.id));
    if (!existingItem) {
      const data = safeJson(character.data_json, onDiagnostic);
      const card = data.data || data;
      const charName = character.name || card.name || '未命名角色';
      const text = [
        `角色「${charName}」`,
        card.system_prompt && `角色系统提示：${card.system_prompt}`,
        card.description && `描述：${card.description}`,
        card.personality && `性格：${card.personality}`,
        card.scenario && `场景：${card.scenario}`,
        card.first_mes && `开场消息：${card.first_mes}`,
        card.mes_example && `对话示例：${card.mes_example}`,
        card.post_history_instructions &&
          `后置指令：${card.post_history_instructions}`,
      ]
        .filter(Boolean)
        .join('\n');
      items.push({
        kind: 'character',
        sourceId: Number(character.id) || null,
        title: charName,
        reason: `角色设定：${charName}`,
        estimatedTokens: estimateTokens(text),
        included: false,
        clipped: true,
        preview: text.slice(0, 500),
      });
    }
  }

  return { text: parts.join('\n\n'), items };
}

async function buildNoteContext(
  projectId: number,
  budget: number,
  scanText: string,
  chapterTitle = '',
  chapterSynopsis = '',
  userPrompt = '',
  onDiagnostic?: DiagnosticSink,
  resourceSources?: GenerationResourceSources,
): Promise<{ text: string; items: ContextTraceItem[] }> {
  let config: any = resourceSources?.noteConfig;
  if (!resourceSources) {
    try {
      config = await db.getProjectNoteConfig(projectId);
    } catch (error) {
      onDiagnostic?.({
        code: 'NOTE_RETRIEVAL_FAILED',
        severity: 'warning',
        message: '笔记模式配置读取失败，按默认模式处理',
        stage: 'collect',
        source: 'contextBuilder.buildNoteContext',
        detail: { reason: String((error as Error)?.message || error) },
      });
      config = null;
    }
  }
  const mode = config?.mode;

  if (mode === 'none') {
    return { text: '', items: [] };
  }
  if (mode === 'style') {
    return buildStyleContext(
      projectId,
      budget,
      config,
      onDiagnostic,
      resourceSources,
    );
  }
  if (mode === 'retrieval') {
    return buildRetrievedNoteContext(
      projectId,
      budget,
      scanText,
      config,
      chapterTitle,
      chapterSynopsis,
      userPrompt,
      onDiagnostic,
      resourceSources,
    );
  }
  return buildNoteContextOriginal(projectId, budget, resourceSources);
}

// 仿写模式：注入缓存的风格画像 + 项目级要素权重
async function buildStyleContext(
  projectId: number,
  budget: number,
  config: any,
  onDiagnostic?: DiagnosticSink,
  resourceSources?: GenerationResourceSources,
): Promise<{ text: string; items: ContextTraceItem[] }> {
  try {
    // project_note_config 中可能残留已被当前项目关闭的笔记 ID。
    // 无论是否配置了显式名单，都必须以当前项目实际启用的笔记为边界，
    // 避免“当前项目使用”已关闭的笔记继续参与画像，甚至跨项目串用。
    const projectNotes =
      (resourceSources?.notes as any[] | undefined) ??
      (await db.getNotesByProject(projectId));
    const eligibleIds = projectNotes.map((note: any) => Number(note.id));
    const eligibleSet = new Set(eligibleIds);
    const configuredIds: number[] = Array.isArray(config?.enabledNoteIds)
      ? config.enabledNoteIds.map(Number)
      : [];
    const noteIds =
      configuredIds.length > 0
        ? configuredIds.filter(id => eligibleSet.has(id))
        : eligibleIds;
    if (noteIds.length === 0) {
      // 没有任何候选笔记 → 不回退到原始注入（用户选的是仿写），但要明确告知
      return {
        text: '',
        items: [
          {
            kind: 'note',
            sourceId: null,
            title: '风格画像（仿写）',
            reason:
              '仿写模式已启用，但当前项目暂无可用笔记，无法生成风格画像。',
            estimatedTokens: 0,
            included: false,
            clipped: false,
            preview: '',
          },
        ],
      };
    }

    // 用 allSettled：单条笔记风格分析失败（空内容 / LLM 报错）不影响整体注入，
    // 避免整个仿写被一条坏数据拉回到原始笔记注入
    const settled = resourceSources?.noteStyleProfiles
      ? resourceSources.noteStyleProfiles.map(value => ({
          status: 'fulfilled' as const,
          value,
        }))
      : await Promise.allSettled(
          noteIds.map((id: number) => getOrAnalyzeNoteStyle(id)),
        );
    const profiles = settled
      .filter(
        (
          r,
        ): r is { status: 'fulfilled'; value: Awaited<ReturnType<typeof getOrAnalyzeNoteStyle>> } =>
          r.status === 'fulfilled',
      )
      .map(r => r.value as Awaited<ReturnType<typeof getOrAnalyzeNoteStyle>>)
      .filter(p => p && p.profileJson && Object.keys(p.profileJson).length > 0);

    const weights: StyleWeights = {
      ...DEFAULT_STYLE_WEIGHTS,
      ...(config?.styleWeights || {}),
    };
    const mergedText = mergeStyleProfiles(profiles, weights);
    if (!mergedText) {
      // 有候选笔记但都没拿到可用画像（可能都为空、LLM 失败、权重全 0）
      const reasonText =
        profiles.length === 0
          ? `仿写模式：${noteIds.length} 篇候选笔记均未生成可用画像，请检查笔记内容或点击"重新分析风格"。`
          : `仿写模式：所有画像维度权重均为 0，未生成风格指令。`;
      return {
        text: '',
        items: [
          {
            kind: 'note',
            sourceId: null,
            title: '风格画像（仿写）',
            reason: reasonText,
            estimatedTokens: 0,
            included: false,
            clipped: false,
            preview: '',
          },
        ],
      };
    }

    const fullText = `以下是本次写作必须遵循的风格画像，请严格按照对应权重的维度进行仿写：\n${mergedText}`;
    const clipped = clipTextToTokenBudget(fullText, budget);
    const failedCount = noteIds.length - profiles.length;
    const reason =
      failedCount > 0
        ? `仿写模式：${profiles.length}/${noteIds.length} 篇笔记联合风格（${failedCount} 篇未生成画像）`
        : `仿写模式：${noteIds.length} 篇笔记联合风格`;
    return {
      text: clipped,
      items: [
        {
          kind: 'note',
          sourceId: null,
          title: '风格画像（仿写）',
          reason,
          estimatedTokens: estimateTokens(clipped),
          included: clipped.length > 0,
          clipped: clipped.length < fullText.length,
          preview: mergedText.slice(0, 500),
        },
      ],
    };
  } catch (error) {
    // 风格分析失败，回退到原始全量注入（语义降级必须可观测）
    onDiagnostic?.({
      code: 'NOTE_STYLE_ANALYSIS_FAILED',
      severity: 'warning',
      message: '风格画像构建失败，回退为笔记全量注入',
      stage: 'render',
      source: 'contextBuilder.buildStyleContext',
      detail: { reason: String((error as Error)?.message || error) },
    });
    return buildNoteContextOriginal(projectId, budget, resourceSources);
  }
}

// 资料库模式：LLM 检索 → 注入命中片段
async function buildRetrievedNoteContext(
  projectId: number,
  budget: number,
  scanText: string,
  config: any,
  chapterTitle = '',
  chapterSynopsis = '',
  userPrompt = '',
  onDiagnostic?: DiagnosticSink,
  resourceSources?: GenerationResourceSources,
): Promise<{ text: string; items: ContextTraceItem[] }> {
  try {
    const topK = config?.retrievalTopK ?? 5;
    const query: RetrievalQuery = {
      chapterTitle,
      chapterSynopsis,
      previousEnding: scanText.slice(-500),
      userPrompt,
    };
    const fragments = resourceSources?.noteRetrievalFragments
      ? (resourceSources.noteRetrievalFragments as Awaited<
          ReturnType<typeof retrieveNoteFragments>
        >)
      : await retrieveNoteFragments(projectId, query, topK);
    if (fragments.length === 0) {
      return {
        text: '',
        items: [
          {
            kind: 'note',
            sourceId: null,
            title: '资料库检索',
            reason:
              '未在已选笔记中找到与本章标题、概要、前文结尾或写作指令相关的内容。',
            estimatedTokens: 0,
            included: false,
            clipped: false,
            preview: '',
          },
        ],
      };
    }

    const parts = fragments.map(f => `[笔记「${f.noteTitle}」] ${f.fragment}`);
    const fullText = `以下是本次写作可参考的资料片段，请结合上下文合理引用：\n${parts.join(
      '\n',
    )}`;
    const clipped = clipTextToTokenBudget(fullText, budget);
    return {
      text: clipped,
      items: fragments.map(f => ({
        kind: 'note' as const,
        sourceId: f.noteId,
        title: f.noteTitle,
        reason: `资料库检索：${f.relevance}`,
        estimatedTokens: estimateTokens(f.fragment),
        included: true,
        clipped: false,
        preview: f.fragment.slice(0, 500),
      })),
    };
  } catch (error) {
    onDiagnostic?.({
      code: 'NOTE_RETRIEVAL_FAILED',
      severity: 'warning',
      message: '资料库笔记检索失败，笔记内容未进入本次生成',
      stage: 'render',
      source: 'contextBuilder.buildRetrievedNoteContext',
      detail: { reason: String((error as Error)?.message || error) },
    });
    return { text: '', items: [] };
  }
}

async function buildNoteContextOriginal(
  projectId: number,
  budget: number,
  resourceSources?: GenerationResourceSources,
): Promise<{ text: string; items: ContextTraceItem[] }> {
  const notes =
    (resourceSources?.notes as any[] | undefined) ??
    (await db.getNotesByProject(projectId));
  const parts: string[] = [];
  const items: ContextTraceItem[] = [];
  let remaining = budget;

  // V2.2.0：bulk fetch 一次拿回所有笔记内容，避免对每条 getNoteContentById 的 N 次 round-trip。
  // 单条实现里每条笔记还会按 120k chunk 分块拉多次，所以 60 条笔记 = 上百次往返；
  // 现在统一 1 次往返 + 仅对超大笔记追加 chunk。
  let contents: Record<number, string> = resourceSources?.noteContents || {};
  if (notes.length > 0) {
    if (!resourceSources) {
      try {
        contents = await db.getNotesContentByIds(notes.map(n => Number(n.id)));
      } catch {
        // bulk 失败时回退单条，最坏情况是性能回退到老路径
        contents = {};
      }
    }
  }

  for (const note of notes) {
    const content = contents[Number(note.id)] ?? '';
    const noteTitle = note.title || '无标题';
    const text = `笔记「${noteTitle}」：${content}`;
    const noteBudget = Math.min(remaining, note.max_tokens ?? 30000);
    const clipped = clipTextToTokenBudget(text, noteBudget);
    const wasClipped = clipped !== text && clipped.length < text.length;
    const included = clipped.length > 0;

    if (included) {
      parts.push(clipped);
      remaining -= estimateTokens(clipped);
    }

    items.push({
      kind: 'note',
      sourceId: Number(note.id) || null,
      title: noteTitle,
      reason: `项目笔记：${noteTitle}`,
      estimatedTokens: included
        ? estimateTokens(clipped)
        : estimateTokens(text),
      included,
      clipped: wasClipped,
      preview: text.slice(0, 500),
    });

    if (remaining <= 0) break;
  }

  // Mark notes that weren't processed due to budget as clipped
  const processedIds = new Set(items.map(it => it.sourceId));
  for (const note of notes) {
    if (processedIds.has(Number(note.id))) continue;
    const content = contents[Number(note.id)] ?? '';
    const noteTitle = note.title || '无标题';
    const text = `笔记「${noteTitle}」：${content}`;
    items.push({
      kind: 'note',
      sourceId: Number(note.id) || null,
      title: noteTitle,
      reason: `项目笔记：${noteTitle}`,
      estimatedTokens: estimateTokens(text),
      included: false,
      clipped: true,
      preview: text.slice(0, 500),
    });
  }

  return { text: parts.join('\n\n'), items };
}

export async function buildWorldbookContext(
  projectId: number,
  budget: number,
  scanText: string,
  recursive = true,
  capturedEntries?: unknown[],
): Promise<{ text: string; items: ContextTraceItem[] }> {
  if (budget <= 0) return { text: '', items: [] };
  const entries = ((capturedEntries ?? (await db.getWorldbookEntriesByProject(projectId))) as any[]).sort(
      (a, b) =>
        Number(a.position || 0) - Number(b.position || 0) ||
        Number(a.id || 0) - Number(b.id || 0),
    );

  const activated = new Map<number | null, any>();
  const activationReason = new Map<number | null, string>();

  const determineReason = (entry: any, haystack: string): string => {
    if (entry.constant === 1 || entry.constant === true) return '常驻';
    const primaryKeys = normalizeKeys(
      entry.keyword_primary ?? entry.key ?? entry.keys ?? entry.keyword,
    );
    if (primaryKeys.length === 0) return '常驻';
    const primaryHit = primaryKeys.some(key => includesKey(haystack, key));
    if (!primaryHit) return '';
    const secondaryKeys = normalizeKeys(
      entry.keyword_secondary ?? entry.keysecondary ?? entry.secondary_keys,
    );
    if (secondaryKeys.length === 0) return '主关键词命中';
    const secondaryHit = secondaryKeys.some(key => includesKey(haystack, key));
    return secondaryHit ? '主+次关键词命中' : '主关键词命中';
  };

  const activatePass = (haystack: string, isRecursive = false) => {
    for (const entry of entries) {
      // entry.id=0 回退 indexOf 修复：id=0 时 indexOf 当 id，可能与其他条目 id 撞号。
      // 直接取 Number(entry.id)，0 当作无效统一回退 null（activated Map 用 null key 不会撞）
      const id = Number(entry.id) || null;
      if (activated.has(id)) continue;
      const reason = determineReason(entry, haystack);
      if (reason) {
        activated.set(id, entry);
        activationReason.set(id, isRecursive ? '递归命中' : reason);
      }
    }
  };

  activatePass(scanText);
  if (recursive && activated.size > 0) {
    activatePass(
      `${scanText}\n\n${Array.from(activated.values())
        .map(entry => entry.content || '')
        .join('\n')}`,
      true,
    );
  }

  // 小说写作场景兜底：当前章节标题/概要/正文/指令均未命中任何关键词，且也没有常驻条目时，
  // 若用户已在项目中启用世界书，仍应注入设定（否则「资料库已开、写作却像空白世界」）。
  // 有关键词命中时保持 ST 风格选择性注入，不把未命中条目强行塞进上下文。
  if (activated.size === 0 && entries.length > 0) {
    for (const entry of entries) {
      const id = Number(entry.id) || null;
      if (activated.has(id)) continue;
      activated.set(id, entry);
      activationReason.set(id, '项目启用兜底');
    }
  }

  const collectionUsage = new Map<number, number>();
  const lines: string[] = [];
  const items: ContextTraceItem[] = [];
  let remaining = budget;
  for (const entry of activated.values()) {
    const id = Number(entry.id);
    const entryContent = String(entry.content || '');
    const label = normalizeKeys(
      entry.keyword_primary ?? entry.key ?? entry.keys ?? entry.keyword,
    )[0];
    const reason = activationReason.get(id) || '主关键词命中';
    const entryBudget = Math.min(remaining, Number(entry.max_tokens ?? 2000));

    const collectionId = Number(entry.collection_id || 0);
    const collectionBudget = Number(entry.collection_max_tokens ?? 50000);
    const used = collectionUsage.get(collectionId) || 0;
    const remainingForCollection = Math.max(0, collectionBudget - used);

    if (remainingForCollection <= 0 || entryBudget <= 0) {
      items.push({
        kind: 'worldbook',
        sourceId: id || null,
        title: label || `条目#${id}`,
        reason,
        estimatedTokens: estimateTokens(entryContent),
        included: false,
        clipped: true,
        preview: entryContent.slice(0, 500),
      });
      continue;
    }

    const effectiveBudget = Math.min(entryBudget, remainingForCollection);
    const body = clipTextToTokenBudget(entryContent, effectiveBudget);
    const wasClipped =
      body !== entryContent && body.length < entryContent.length;
    const included = body.length > 0;

    if (included) {
      const line = label ? `关键词「${label}」：${body}` : body;
      lines.push(line);
      const tokenCost = estimateTokens(body);
      collectionUsage.set(collectionId, used + tokenCost);
      remaining -= tokenCost;
    }

    items.push({
      kind: 'worldbook',
      sourceId: id || null,
      title: label || `条目#${id}`,
      reason,
      estimatedTokens: included
        ? estimateTokens(body)
        : estimateTokens(entryContent),
      included,
      clipped: wasClipped || !included,
      preview: entryContent.slice(0, 500),
    });

    if (remaining <= 0) break;
  }

  // Mark entries that were activated but not processed due to budget
  for (const [id, entry] of activated) {
    const existingItem = items.find(it => it.sourceId === id);
    if (!existingItem) {
      const entryContent = String(entry.content || '');
      const label = normalizeKeys(
        entry.keyword_primary ?? entry.key ?? entry.keys ?? entry.keyword,
      )[0];
      const reason = activationReason.get(id) || '主关键词命中';
      items.push({
        kind: 'worldbook',
        sourceId: id || null,
        title: label || `条目#${id}`,
        reason,
        estimatedTokens: estimateTokens(entryContent),
        included: false,
        clipped: true,
        preview: entryContent.slice(0, 500),
      });
    }
  }

  return { text: lines.join('\n'), items };
}

function includesKey(text: string, key: string): boolean {
  return text.toLocaleLowerCase().includes(key.toLocaleLowerCase());
}

function normalizeKeys(raw: any): string[] {
  if (Array.isArray(raw))
    return raw
      .map(String)
      .map(item => item.trim())
      .filter(Boolean);
  if (typeof raw === 'string')
    return raw
      .split(/[,，\n]/)
      .map(item => item.trim())
      .filter(Boolean);
  return [];
}

export function selectPreviousChapters(
  currentChapter: Chapter,
  config: PartialContextConfig,
  chapters: Chapter[],
): Chapter[] {
  return selectPreviousChaptersPure(currentChapter, config, chapters);
}

export function buildPreviousContentText(
  currentChapter: Chapter,
  config: PartialContextConfig,
  chapters: Chapter[],
): string {
  const selected = selectPreviousChapters(currentChapter, config, chapters);
  const text = selected
    .map(
      chapter =>
        `第 ${chapter.position + 1} 章「${chapter.title || '未命名'}」\n${
          chapter.content
        }`,
    )
    .join('\n\n');
  return clipTextTailToTokenBudget(
    text,
    Number(config.slidingWindowSize || 50000),
  );
}

function clipTextTailToTokenBudget(text: string, budget: number): string {
  if (budget <= 0 || !text) return '';
  // O(n²) 拼接修复：先反向遍历累计 token 找到起始下标，最后 slice，整体 O(n)
  let used = 0;
  let startIdx = text.length;
  for (let index = text.length - 1; index >= 0; index--) {
    const char = text[index];
    const nextCost = estimateTokens(char);
    if (used + nextCost > budget) break;
    used += nextCost;
    startIdx = index;
  }
  return text.slice(startIdx).trimStart();
}

export function buildMemoryContext(
  previousChapters: Chapter[],
  currentChapter: Chapter,
  topK: number,
  budgetTokens: number,
  options?: MemoryRetrievalOptions,
): string {
  const docs = previousChapters
    .map(chapter => ({
      chapter,
      text: String((chapter as any).memory_summary || ''),
    }))
    .filter(item => item.text.trim());

  if (docs.length === 0 || topK <= 0 || budgetTokens <= 0) return '';

  const idf = buildIdf(docs.map(doc => doc.text));
  return assembleMemoryContextFromIdf(
    docs,
    currentChapter,
    idf,
    topK,
    budgetTokens,
    options,
  );
}

/**
 * V2.2.0：用预先计算/缓存好的 IDF 直接召回，避免 O(N) tokenize+buildIdf。
 * When IDF is empty (punctuation-only / stop-word-only summaries), fall back to
 * recent valid summaries with the same token-safe budget path — never block generation.
 */
export function buildMemoryContextWithIdf(
  previousChapters: Chapter[],
  currentChapter: Chapter,
  idf: Map<string, number>,
  topK: number,
  budgetTokens: number,
  options?: MemoryRetrievalOptions,
): string {
  const docs = previousChapters
    .map(chapter => ({
      chapter,
      text: String((chapter as any).memory_summary || ''),
    }))
    .filter(item => item.text.trim());

  if (docs.length === 0 || topK <= 0 || budgetTokens <= 0) return '';

  if (!idf || idf.size === 0) {
    return assembleRecentSummariesWithinBudget(
      docs,
      topK,
      budgetTokens,
      options?.getDisplayNumber,
    );
  }

  return assembleMemoryContextFromIdf(
    docs,
    currentChapter,
    idf,
    topK,
    budgetTokens,
    options,
  );
}

/**
 * Recent-valid-summary fallback (empty IDF / zero-signal): priority by recency,
 * budget via selectCandidatesWithinTokenBudget, display chronological.
 */
function assembleRecentSummariesWithinBudget(
  docs: Array<{ chapter: Chapter; text: string }>,
  topK: number,
  budgetTokens: number,
  getDisplayNumber: (position: number) => number = position => position + 1,
): string {
  const recentPriority = [...docs]
    .sort((a, b) => {
      if (b.chapter.position !== a.chapter.position) {
        return b.chapter.position - a.chapter.position;
      }
      return a.chapter.id - b.chapter.id;
    })
    .slice(0, topK)
    .map(item => ({
      chapter: item.chapter,
      text: item.text,
      cosineScore: 0,
      entityBoost: 0,
      pairBoost: 0,
      finalScore: 0,
      matchedCharacterIds: [] as string[],
      matchedCharacters: [] as string[],
      matchedObjects: [] as string[],
      matchedThreads: [] as string[],
    }));
  const budgeted = selectCandidatesWithinTokenBudget(
    recentPriority,
    budgetTokens,
    getDisplayNumber,
  );
  return orderCandidatesForDisplay(budgeted)
    .map(item => formatMemoryCandidateLine(item, getDisplayNumber))
    .join('\n');
}

/**
 * Only use Story Memory state that prepareStoryMemoryForGeneration marked usable.
 * Dirty / empty / failed / rebuilding / missing / unreadable → null (TF-IDF only).
 */
/**
 * Entity-boost state only from prepare()'s usable checkpoint.
 * prepare() already filters via resolveUsableCheckpointForTarget, so a non-null
 * checkpoint is clean and through < target. Still refuse non-clean statuses.
 */
export function resolveStoryStateForRetrieval(
  prepared: {
    checkpoint: import('../data/repositories/storyMemoryRepository').ProjectStoryMemoryRecord | null;
  } | null,
): MemoryRetrievalOptions['storyState'] {
  try {
    const record = prepared?.checkpoint;
    if (!record?.state) return null;
    if (record.status !== 'clean') return null;
    return record.state;
  } catch {
    return null;
  }
}

function assembleMemoryContextFromIdf(
  docs: Array<{ chapter: Chapter; text: string }>,
  currentChapter: Chapter,
  idf: Map<string, number>,
  topK: number,
  budgetTokens: number,
  options?: MemoryRetrievalOptions,
): string {
  const legacyQuery = `${currentChapter.title}\n${currentChapter.synopsis}\n${
    currentChapter.content?.slice(0, 500) || ''
  }`;
  // Prefer explicit queryText when provided (even empty string = true empty query).
  const hasExplicitQuery = options != null && 'queryText' in options;
  const query = hasExplicitQuery
    ? String(options?.queryText || '').trim()
    : legacyQuery.trim() ||
      `${currentChapter.title || ''}\n${currentChapter.synopsis || ''}`.trim();

  // All paths produce ScoredMemoryCandidate[] in budget-priority order, then
  // share selectCandidatesWithinTokenBudget + chronological display.
  let priorityCandidates: ReturnType<typeof scoreMemoryCandidates>;

  const mode = resolveEpisodicRetrievalMode({
    v2Enabled: episodicMemoryRetriever.EPISODIC_RETRIEVAL_V2_ENABLED,
    queryText: query,
    idfSize: idf?.size ?? 0,
  });
  // Bind mode so tests can observe the taken branch without production logs.
  (assembleMemoryContextFromIdf as { lastMode?: string }).lastMode = mode;

  if (mode === 'legacy') {
    const queryVector = vectorize(query || legacyQuery, idf);
    priorityCandidates = docs
      .map(doc => {
        const score = cosineSimilarity(queryVector, vectorize(doc.text, idf));
        return {
          chapter: doc.chapter,
          text: doc.text,
          cosineScore: score,
          entityBoost: 0,
          pairBoost: 0,
          finalScore: score,
          matchedCharacterIds: [] as string[],
          matchedCharacters: [] as string[],
          matchedObjects: [] as string[],
          matchedThreads: [] as string[],
        };
      })
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, topK);
  } else if (mode === 'empty_query_recent' || mode === 'empty_idf_recent') {
    // Empty query / empty IDF: recency priority, no Story Memory entity matching.
    priorityCandidates = [...docs]
      .sort((a, b) => {
        if (b.chapter.position !== a.chapter.position) {
          return b.chapter.position - a.chapter.position;
        }
        return a.chapter.id - b.chapter.id;
      })
      .slice(0, topK)
      .map(item => ({
        chapter: item.chapter,
        text: item.text,
        cosineScore: 0,
        entityBoost: 0,
        pairBoost: 0,
        finalScore: 0,
        matchedCharacterIds: [] as string[],
        matchedCharacters: [] as string[],
        matchedObjects: [] as string[],
        matchedThreads: [] as string[],
      }));
  } else {
    // Collect Story Memory terms once per retrieval; pass into scorer (no recompute).
    const storyTerms = collectStoryRetrievalTerms(options?.storyState ?? null);
    const active = findActiveStoryTerms(query, storyTerms);
    const scored = scoreMemoryCandidates(
      docs,
      query,
      idf,
      options?.storyState ?? null,
      cosineSimilarity,
      vectorize,
      { storyTerms, activeTerms: active },
    );
    priorityCandidates = selectMemoryCandidates(scored, active, topK);
  }

  const getDisplayNumber =
    options?.getDisplayNumber ?? ((position: number) => position + 1);
  const budgeted = selectCandidatesWithinTokenBudget(
    priorityCandidates,
    budgetTokens,
    getDisplayNumber,
  );
  return orderCandidatesForDisplay(budgeted)
    .map(item => formatMemoryCandidateLine(item, getDisplayNumber))
    .join('\n');
}

/** Test-only: last retrieval mode taken by assembleMemoryContextFromIdf. */
export function getLastEpisodicRetrievalMode(): string | undefined {
  return (assembleMemoryContextFromIdf as { lastMode?: string }).lastMode;
}

function tokenize(text: string): string[] {
  return tokenizeForMemoryRetrieval(text);
}

function buildIdf(docs: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(tokenize(doc))) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log((docs.length + 1) / (count + 1)) + 1);
  }
  return idf;
}

function vectorize(
  text: string,
  idf: Map<string, number>,
): Map<string, number> {
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
  const maxTf = Math.max(1, ...tf.values());
  const vector = new Map<string, number>();
  for (const [term, count] of tf) {
    vector.set(term, (count / maxTf) * (idf.get(term) || 1));
  }
  return vector;
}

function cosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [key, value] of a) {
    normA += value * value;
    dot += value * (b.get(key) || 0);
  }
  for (const value of b.values()) normB += value * value;
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function safeJson(text: string, onDiagnostic?: DiagnosticSink): any {
  try {
    return JSON.parse(text || '{}');
  } catch (error) {
    onDiagnostic?.({
      code: 'RESOURCE_RENDER_FAILED',
      severity: 'warning',
      message: '角色资料 JSON 解析失败，角色仅保留可识别名称',
      stage: 'render',
      source: 'contextBuilder.buildCharacterContext.characterPayload',
      detail: { reason: String((error as Error)?.message || error) },
    });
    return {};
  }
}

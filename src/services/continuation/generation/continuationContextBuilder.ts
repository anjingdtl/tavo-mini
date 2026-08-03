/**
 * Continuation Context Builder (Spec §8 / §9).
 * Does NOT call generation-mode buildContext() or Story Memory LLM.
 * Does NOT trigger Style Analysis LLM — only reads cached injectable profiles.
 * Freezes a snapshot shared by Planner/Writer/Checker/Repair.
 */
import type { ContinuationChapterPosition } from '../../../types/novel';
import {
  clipTextToTokenBudget,
  clipTextTailToTokenBudget,
  estimateTokens,
  estimateMessagesTokens,
} from '../../../utils/tokenEstimator';
import type { Chapter } from '../../../types/novel';
import * as database from '../../database';
import { buildMemoryContext } from '../../contextBuilder';
import { renderStoryMemoryForContext } from '../../storyMemory/storyMemoryRenderer';
import { resolveUsableCheckpointForTarget } from '../../storyMemory/storyMemoryCheckpointEligibility';
import { continuationSourceReader } from '../continuationSourceReader';
import { CanonQueryService } from '../canon/canonQueryService';
import { listHistoricalDigestReferences } from '../canon/historicalDigestService';
import {
  getInjectableStyleProfile,
  type StyleProfileFingerprint,
  type ContinuationStyleProfileRow,
} from '../styleProfile/styleProfileRepository';
import {
  STYLE_RENDERER_VERSION,
  renderStyleProfile,
  selectStyleRenderLevel,
  type StyleRenderLevel,
} from '../styleProfile/styleProfileRenderer';
import { computeStyleProfileHash } from '../styleProfile/styleProfileHash';
import { STYLE_ANALYZER_VERSION } from '../styleProfile/styleAnalysisPrompt';
import type { StyleMetrics } from '../styleProfile/styleStatistics';
import { CONTINUATION_BUDGET_POLICY } from './continuationContextBudget';
import {
  hashContextAutomationPolicy,
  type ContextAutomationPolicyV2,
} from '../../contextAutomationPolicy';
import { getEffectiveContinuationState } from './continuationStateService';
import { buildContinuationSupplementContext } from './continuationSupplementContextBuilder';
import {
  contentRevisionHash,
  ensureGenerationSettings,
} from './generationRepository';
import type {
  ContinuationContextSnapshot,
  ContinuationContextTrace,
  ContinuationFrozenStyle,
  ContinuationContextSnapshotV3,
  ContinuationGenerationSettings,
  ContinuationGenerationSettingsSnapshot,
  ContinuationPlan,
  ContinuationStyleProfile,
  FrozenContinuationModelConfig,
  ContinuationV4ContextStage,
  StrictnessProfile,
} from './types';
import { ContinuationCapabilityBlockedError } from './types';
import {
  planContinuationContextBudget,
  planStageCapacity,
  type ContinuationStageBudgets,
  type ResolvedStageCapacity,
} from './continuationContextBudget';
import {
  selectContinuationAnchor,
  type ContinuationAnchorChapter,
} from './continuationAnchor';
import {
  planContinuationV4ContextBudget,
  resolveContinuationV4BudgetPreview,
} from './continuationV4Budget';
import {
  buildContinuationV4StageViews,
  hashContinuationV4StageView,
} from './continuationV4ContextViews';
import {
  compileContinuationV4CheckerMessages,
  compileContinuationV4ControlMessages,
  compileContinuationV4RepairMessages,
  compileContinuationV4WriterMessages,
  continuationV4ProtocolSkeletonTokens,
} from './continuationV4PromptCompiler';
import {
  buildContinuationControlFallback,
  buildContinuationControlMetrics,
} from './continuationControl';

export interface BuildContinuationContextInput {
  projectId: number;
  targetChapterId: number;
  targetPosition: ContinuationChapterPosition;
  currentChapterContent: string;
  userInstruction: string;
  /**
   * Layout window for the frozen snapshot (typically Writer's context_window).
   * Prefer passing stageBudgets when available; this remains the fallback for
   * callers that only know a single limit (e.g. context preview).
   */
  modelContextLimit: number;
  maxOutputTokens: number;
  /** First Writer request when the layout reserves a larger retry ceiling. */
  initialWriterOutputTokens?: number;
  /** Resolved active LLM config id used when stage ids are null. */
  activeLlmConfigId: number;
  settingsOverride?: Partial<ContinuationGenerationSettings>;
  /**
   * Optional per-stage capacity already resolved by the runner. When provided,
   * frozen onto the snapshot and used as the Writer layout budget when present.
   */
  stageBudgets?: ContinuationStageBudgets;
  /** V4 context layout source; absent means historical V2 budget policy. */
  contextAutomationPolicy?: ContextAutomationPolicyV2;
  writerStageModel?: {
    configId: number;
    contextWindow: number;
    maxOutputTokens: number;
  };
  /** Non-secret routing fields frozen from each selected stage config. */
  frozenModelConfigs?: {
    planner: FrozenContinuationModelConfig | null;
    writer: FrozenContinuationModelConfig | null;
    checker: FrozenContinuationModelConfig | null;
    repair: FrozenContinuationModelConfig | null;
    stateExtraction: FrozenContinuationModelConfig | null;
    control?: FrozenContinuationModelConfig | null;
  };
}

function reviewPolicyFor(
  profile: StrictnessProfile,
): 'strict' | 'balanced' | 'loose' {
  if (profile === 'strict') return 'strict';
  if (profile === 'loose') return 'loose';
  return 'balanced';
}

function requiredCapabilities(
  profile: StrictnessProfile,
): Array<keyof import('../canon/types').CanonCapabilities> {
  if (profile === 'loose') {
    return ['worldRules', 'characterProfiles', 'plotThreads'];
  }
  return [
    'worldRules',
    'characterProfiles',
    'characterStates',
    'relationships',
    'plotThreads',
    'experiences',
    'knowledgeBoundaries',
  ];
}

function capabilityGaps(
  caps: import('../canon/types').CanonCapabilities,
  profile: StrictnessProfile,
): string[] {
  return requiredCapabilities(profile).filter(k => !caps[k]);
}

function fingerprintFromSource(
  source: import('../types').ContinuationSourceSnapshot,
): StyleProfileFingerprint {
  return {
    sourceId: source.sourceId,
    sourceVersion: source.sourceVersion,
    sourceSha256: source.normalizedSha256,
    parserVersion: source.parserVersion,
    normalizationVersion: source.normalizationVersion,
    boundaryChapterId: source.boundary.chapterId,
    boundaryPosition: Number(source.boundary.chapterPosition),
    boundaryCharOffsetExclusive: Number(source.boundary.charOffsetExclusive),
  };
}

function sourceFingerprintKey(fp: StyleProfileFingerprint): string {
  return [
    fp.sourceId,
    fp.sourceVersion,
    fp.sourceSha256,
    fp.parserVersion,
    fp.normalizationVersion,
    fp.boundaryChapterId,
    fp.boundaryPosition,
    fp.boundaryCharOffsetExclusive,
  ].join('|');
}

/** Recompute the persisted payload hash before any style content is injected. */
function isProfileHashAcceptable(row: ContinuationStyleProfileRow): boolean {
  const hash = String(row.profileHash || '').trim();
  if (!/^[a-f0-9]{16,}$/i.test(hash)) return false;
  const profile = row.profileJson;
  if (!profile || typeof profile !== 'object') return false;
  if (Object.keys(profile).length === 0) return false;
  return (
    hash.toLowerCase() ===
    computeStyleProfileHash({
      profile,
      metrics: row.metricsJson,
      sampleRefs: row.sampleRefsJson,
      profileSchemaVersion: row.profileSchemaVersion,
      analyzerVersion: row.analyzerVersion,
      userOverrides: row.userOverridesJson,
    })
  );
}

function legacyStyleFromRow(
  row: ContinuationStyleProfileRow,
): ContinuationStyleProfile {
  const metrics = row.metricsJson as Partial<StyleMetrics> | undefined;
  const profile = row.profileJson as Record<string, unknown>;
  const narrative =
    profile &&
    typeof profile.global === 'object' &&
    profile.global &&
    typeof (profile.global as any).narrative === 'object'
      ? ((profile.global as any).narrative as Record<string, unknown>)
      : null;
  const personSignals = metrics?.person;
  let narrativePerson = String(narrative?.person ?? '');
  if (!narrativePerson && personSignals) {
    narrativePerson =
      (personSignals.firstPersonRatio ?? 0) > 0.55 ? '第一人称' : '第三人称';
  }
  const tense = String(narrative?.tenseAndTimeHandling ?? '');
  return {
    projectId: row.projectId,
    sourceId: row.sourceId,
    canonSnapshotId: row.canonSnapshotId,
    canonRevision: 0,
    narrativePerson: narrativePerson || '第三人称',
    tense: tense || '过去/叙述',
    averageSentenceLength: Number(metrics?.sentenceLength?.mean ?? 0),
    averageParagraphLength: Number(metrics?.paragraphLength?.mean ?? 0),
    dialogueRatio: Number(metrics?.dialogue?.ratio ?? 0),
    descriptionRatio: Number(metrics?.functionalRatios?.environment ?? 0),
    pacingNotes: String(
      (profile as any)?.global?.rhythm?.scenePacing ??
        (profile as any)?.boundaryLocalDelta?.pacing ??
        '',
    ),
    lexicalNotes: String((profile as any)?.global?.diction?.register ?? ''),
    sampleEvidenceIds: [],
    reviewStatus: row.reviewStatus,
  };
}

export async function buildContinuationContext(
  input: BuildContinuationContextInput,
): Promise<{
  snapshot: ContinuationContextSnapshot;
  trace: ContinuationContextTrace;
}> {
  const settings = {
    ...(await ensureGenerationSettings(input.projectId)),
    ...input.settingsOverride,
  };
  const profile = settings.strictnessProfile;

  // Active source snapshot via bounded reader only.
  const source = await continuationSourceReader.getSnapshot(input.projectId);
  const snap = await CanonQueryService.getActiveSnapshot(input.projectId);
  const gaps = capabilityGaps(snap.capabilities, profile);
  if (profile === 'strict' && gaps.length > 0) {
    throw new ContinuationCapabilityBlockedError(
      `strict 模式缺少 Canon 能力：${gaps.join(', ')}。请完成原著分析。`,
    );
  }

  const effectiveState = await getEffectiveContinuationState({
    projectId: input.projectId,
    canonSnapshotId: snap.id,
    canonRevision: snap.revision,
    targetPosition: input.targetPosition,
  });

  if (
    profile === 'strict' &&
    (effectiveState.freshness.pendingStateExtractionCount > 0 ||
      effectiveState.freshness.pendingMajorProposalCount > 0)
  ) {
    throw new ContinuationCapabilityBlockedError(
      'strict 模式：存在未完成的状态提取或待确认重大 proposal，请先处理。',
    );
  }

  if (
    profile === 'strict' &&
    (effectiveState.freshness.storyMemoryStatus === 'dirty' ||
      effectiveState.freshness.storyMemoryStatus === 'failed')
  ) {
    throw new ContinuationCapabilityBlockedError(
      'strict 模式：故事记忆需先更新（hard due / dirty），请先运行独立记忆任务。',
    );
  }

  // Prefer Writer stage capacity for layout when frozen stage budgets exist.
  const writerCapacity: ResolvedStageCapacity | null =
    input.stageBudgets?.writer ?? null;
  const layoutLimit =
    input.writerStageModel?.contextWindow ??
    writerCapacity?.contextWindow ??
    input.modelContextLimit;
  const layoutMaxOut =
    input.writerStageModel?.maxOutputTokens ??
    writerCapacity?.maxOutputTokens ??
    input.maxOutputTokens;
  const planLayout = (hardContextTokens = 0, hasPrimaryAnchor = false) =>
    input.contextAutomationPolicy && input.writerStageModel
      ? planContinuationV4ContextBudget({
          frozenPolicy: input.contextAutomationPolicy,
          frozenModelConfig: input.writerStageModel,
          targetChapterChars: settings.targetChapterChars,
          hardContextTokens,
          hasPrimaryAnchor,
        })
      : planContinuationContextBudget({
          modelContextLimit: layoutLimit,
          writerMaxOutputTokens: layoutMaxOut,
          targetChapterChars: settings.targetChapterChars,
          hardContextTokens,
          hasPrimaryAnchor,
        });

  let contextBudget = planLayout();
  let lockedRules: string[] = [];
  try {
    lockedRules = JSON.parse(settings.customRulesJson || '[]');
    if (!Array.isArray(lockedRules)) lockedRules = [];
  } catch {
    lockedRules = [];
  }

  const lockedRuleTokens = estimateTokens(lockedRules.join('\n'));

  const reviewPolicy = reviewPolicyFor(profile);

  // Read prior continuation chapters before touching bounded source正文. The
  // selected primary anchor is the only正文 seam for this frozen run.
  // H1-Generation 修复：原 getChaptersByProject 全表 SELECT * 拉 100+ 章正文
  // 再 filter，大项目 OOM。selectContinuationAnchor 只取最近 1 章，recent
  // bridge 受 recentBridgeTokens 限制也只取最近几章，所以只需查最近 20 章。
  const recentProjectChapters = await database.getRecentChaptersBeforePosition(
    input.projectId,
    input.targetPosition,
    20,
  );
  const priorChapters = recentProjectChapters
    .filter(chapter => Boolean(chapter.content?.trim()))
    .sort((a, b) => b.position - a.position || b.id - a.id);

  let chapters: Awaited<
    ReturnType<typeof continuationSourceReader.listBoundedSourceChapters>
  > = [];
  let seamSummary = '';
  let seamExcerpt = '';
  if (priorChapters.length === 0) {
    // The Writer only needs the source seam when no continuation正文 exists
    // yet. Calling listBoundedSourceChapters here would read every source
    // chapter body before selecting the last one; a 2M novel may contain
    // 10,000+ chapters and turn a tiny Writer context build into minutes of
    // SQLite reads. Use the range reader to fetch only the boundary chapter.
    const boundaryPosition = Number(source.boundary.chapterPosition);
    const rangeReader =
      continuationSourceReader.listBoundedSourceChaptersForRange;
    if (typeof rangeReader === 'function' && Number.isFinite(boundaryPosition)) {
      chapters = await rangeReader(
        source,
        source.boundary.chapterPosition,
        (boundaryPosition + 1) as any,
      );
    } else {
      // Compatibility fallback for older injected readers used by migrations
      // and tests that do not expose the range method yet.
      chapters = await continuationSourceReader.listBoundedSourceChapters(
        source,
      );
    }
    if (chapters.length > 0) {
      const last = chapters[chapters.length - 1];
      seamSummary = `原著末章「${last.title}」(position=${last.position})`;
      // The source boundary is the continuation seam. Keep its tail, not the
      // chapter opening, so the next paragraph inherits the last real event.
      seamExcerpt = clipTextTailToTokenBudget(
        last.content || last.title,
        contextBudget.sourceSeamTokens,
      );
    }
  }

  const primaryAnchor = selectContinuationAnchor({
    targetPosition: input.targetPosition,
    priorChapters: priorChapters.map(
      chapter =>
        ({
          id: chapter.id,
          position: chapter.position as ContinuationChapterPosition,
          content: chapter.content,
          title: chapter.title,
        } satisfies ContinuationAnchorChapter),
    ),
    sourceSeam: { summary: seamSummary, excerpt: seamExcerpt },
  });
  // The selected primary anchor is rendered in every Writer prompt, so its
  // final clipped form must be the same text counted by the context budget.
  // This is especially important after the first continuation chapter: the
  // anchor then comes from the previous continuation正文 rather than source.
  let primaryAnchorExcerpt = clipTextTailToTokenBudget(
    primaryAnchor.excerpt,
    contextBudget.sourceSeamTokens,
  );

  // Canon retrieval is relevance-driven: instruction + current seam + the
  // target chapter synopsis are the query. The Writer plan is deliberately
  // not available yet and can never become a hidden pre-call.
  const canonQuery = [
    `用户要求：${input.userInstruction}`,
    `当前正文接缝：${primaryAnchorExcerpt}`,
    `当前章 synopsis：${input.userInstruction}`,
  ].join('\n');
  let canonBundle = await CanonQueryService.getContextBundle({
    projectId: input.projectId,
    snapshotId: snap.id,
    snapshotRevision: snap.revision,
    atSourcePosition: snap.boundaryPosition,
    queryText: canonQuery,
    characterIds: [],
    tokenBudget: contextBudget.canonTokens,
    hardTokenBudget: Math.max(
      0,
      contextBudget.inputBudget - lockedRuleTokens,
    ),
    reviewPolicy,
  });

  const hardCanonText = canonBundle.worldRules
    .filter(rule => rule.constraintLevel === 'hard')
    .map(rule => `${rule.title}: ${rule.description}`)
    .join('\n');
  const hardContextTokens =
    lockedRuleTokens + estimateTokens(hardCanonText);
  if (hardContextTokens > contextBudget.inputBudget) {
    throw new ContinuationCapabilityBlockedError(
      `上下文预算不足：用户锁定规则与 hard Canon 约 ${hardContextTokens} token，可用 ${contextBudget.inputBudget}。请换更大上下文模型或降低目标章节长度。`,
    );
  }
  contextBudget = planLayout(hardContextTokens, Boolean(primaryAnchorExcerpt));
  primaryAnchorExcerpt = clipTextTailToTokenBudget(
    primaryAnchor.excerpt,
    contextBudget.sourceSeamTokens,
  );
  canonBundle = await CanonQueryService.getContextBundle({
    projectId: input.projectId,
    snapshotId: snap.id,
    snapshotRevision: snap.revision,
    atSourcePosition: snap.boundaryPosition,
    queryText: canonQuery,
    characterIds: [],
    tokenBudget: contextBudget.canonTokens,
    hardTokenBudget: contextBudget.residualContextBudget,
    reviewPolicy,
  });
  if (canonBundle.omittedReasonCounts.hard_world_rules_over_budget) {
    throw new ContinuationCapabilityBlockedError(
      `上下文预算不足：hard Canon 无法完整装入有效窗口 ${contextBudget.residualContextBudget} token。请换更大上下文模型或降低目标章节长度。`,
    );
  }

  const supplements = await buildContinuationSupplementContext({
    projectId: input.projectId,
    tokenBudget: contextBudget.supplementTokens,
  });
  const partiallyCovered =
    snap.coverage.analyzedChapterCount < snap.coverage.sourceChapterCount;
  const historicalDigests = partiallyCovered
    ? await listHistoricalDigestReferences({
        projectId: input.projectId,
        queryText: canonQuery,
        limit: 3,
      })
        .then(items => {
          const perCard = Math.floor(
            contextBudget.episodicTokens / Math.max(1, items.length),
          );
          return items.map(item => ({
            ...item,
            summary: clipTextToTokenBudget(item.summary, perCard),
          }));
        })
        .catch(() => [])
    : [];

  // Recent continuation chapters are a distinct short-term bridge. Allocate
  // from newest to oldest: the immediately previous chapter is retained whole
  // when possible, older chapters progressively contribute their tails.
  const recentChapters: ContinuationContextSnapshot['bundles']['recentChapters'] =
    [];
  let recentRemaining = contextBudget.recentBridgeTokens;
  for (const chapter of priorChapters) {
    // The primary anchor is rendered once in its dedicated block. Do not
    // spend bridge budget repeating the same正文 in recentChapters.
    if (chapter.id === primaryAnchor.chapterId) continue;
    if (recentRemaining <= 0) break;
    const content = String(chapter.content ?? '');
    const excerpt = clipTextTailToTokenBudget(content, recentRemaining);
    const excerptTokens = estimateTokens(excerpt);
    if (!excerpt) continue;
    recentChapters.push({
      chapterId: chapter.id,
      position: chapter.position as ContinuationChapterPosition,
      revisionHash: contentRevisionHash(content),
      excerpt,
    });
    recentRemaining -= excerptTokens;
  }
  // Chronological order for prompts
  recentChapters.reverse();
  const recentCoveredByPrimaryAnchor =
    primaryAnchor.kind === 'continuation_chapter' &&
    primaryAnchor.chapterId != null
      ? 1
      : 0;
  const recentBridgeBudgetOmitted = Math.max(
    0,
    priorChapters.length - recentCoveredByPrimaryAnchor - recentChapters.length,
  );

  // Long-term Story Memory: only a clean checkpoint strictly before target may
  // be rendered. This mirrors outline mode and prevents dirty/future state from
  // silently contaminating a balanced continuation run.
  const targetChapter = {
    id: input.targetChapterId,
    project_id: input.projectId,
    position: input.targetPosition,
    title: '',
    synopsis: input.userInstruction,
    content: input.currentChapterContent,
    status: 'draft',
    summary_json: null,
    created_at: '',
    updated_at: '',
  } as Chapter;
  // Display numbers continue from the source boundary (Spec §11.3) so Story
  // Memory text, episodic prefixes, and Planner/Writer targets stay aligned.
  let getDisplayNumber: ((position: number) => number) | undefined;
  try {
    const { getContinuationChapterNumbering } = await import(
      '../chapterNumbering/continuationChapterNumbering'
    );
    const numbering = await getContinuationChapterNumbering(input.projectId);
    getDisplayNumber = position =>
      numbering.getDisplayNumber(position as ContinuationChapterPosition);
  } catch {
    // Fall back to position+1 inside formatters / renderer.
  }

  let smSummary = '';
  let smTokens = 0;
  let smFingerprint = 'none';
  let smThrough: ContinuationChapterPosition | -1 = -1;
  let smStatus = 'missing';
  let smEligibilityReason = 'missing';
  try {
    const record = await database.getProjectStoryMemory(input.projectId);
    const eligibility = resolveUsableCheckpointForTarget(
      record,
      input.targetPosition,
    );
    smEligibilityReason = eligibility.reason;
    if (record) smStatus = record.status;
    if (eligibility.usable) {
      smThrough = eligibility.checkpoint.state
        .throughChapterPosition as ContinuationChapterPosition;
      smFingerprint =
        eligibility.checkpoint.state.metadata.stateFingerprint ?? 'none';
      const rendered = renderStoryMemoryForContext(
        eligibility.checkpoint.state,
        {
          currentChapter: targetChapter,
          budgetTokens: contextBudget.storyMemoryTokens,
          retrievalUserPrompt: input.userInstruction,
          getDisplayNumber,
        },
      );
      smSummary = rendered.text;
      smTokens = rendered.estimatedTokens;
    }
  } catch {
    // Memory is optional in loose/balanced mode. The trace exposes omission.
  }

  // Episodic chapter memories complement the checkpoint with task-relevant
  // settled events. Do not repeat raw bridge chapters in both categories.
  const bridgeIds = new Set(recentChapters.map(chapter => chapter.chapterId));
  // The primary anchor is the immediate continuation正文; do not repeat its
  // event memory beside the full anchor excerpt.
  if (
    primaryAnchor.kind === 'continuation_chapter' &&
    primaryAnchor.chapterId
  ) {
    bridgeIds.add(primaryAnchor.chapterId);
  }
  const episodicText = buildMemoryContext(
    priorChapters
      .filter(chapter => !bridgeIds.has(chapter.id))
      .sort((a, b) => a.position - b.position),
    targetChapter,
    10,
    contextBudget.episodicTokens,
    { queryText: input.userInstruction, getDisplayNumber },
  );
  const episodic = episodicText
    ? [{ chapterId: -1, summary: episodicText }]
    : [];

  // ---------- Original style (cached injectable only; never analyse here) ----
  // 原著续写始终以严格文风注入运行。不能只信任持久化设置：旧快照或
  // 外部调用仍可能携带 off/balanced，必须在最终上下文边界再次收紧。
  const styleLevel = 'strict' as const;
  const fp = fingerprintFromSource(source);
  let frozenStyle: ContinuationFrozenStyle | null = null;
  let legacyStyle: ContinuationStyleProfile | null = null;
  let styleTraceCandidates = 0;
  let styleTraceSelected = 0;
  let styleTraceTokens = 0;
  let styleOmitReasons: Record<string, number> = {};
  let styleRenderLevel: StyleRenderLevel | null = null;
  let styleDegradeReason: string | null = null;

  styleTraceCandidates = 1;
  let row: ContinuationStyleProfileRow | null = null;
  try {
    row = await getInjectableStyleProfile(input.projectId, fp);
  } catch {
    row = null;
    styleOmitReasons.repository_error = 1;
  }

  if (!row) {
    styleOmitReasons.no_injectable_profile = 1;
    throw new ContinuationCapabilityBlockedError(
      '续写需要可用的原著风格画像，但当前没有可注入的画像（未分析、已忽略、过期或与当前原著指纹/边界不匹配）。请完成风格分析并启用原著资料后再续写。',
    );
  } else if (row.analyzerVersion !== STYLE_ANALYZER_VERSION) {
    styleOmitReasons.outdated_analyzer_version = 1;
    throw new ContinuationCapabilityBlockedError(
      `原著风格画像版本过期（当前 ${row.analyzerVersion}，需要 ${STYLE_ANALYZER_VERSION}）。请重新分析原著风格后再续写。`,
    );
  } else if (!isProfileHashAcceptable(row)) {
    styleOmitReasons.invalid_profile_hash = 1;
    throw new ContinuationCapabilityBlockedError(
      '原著风格画像哈希或内容无效，无法安全注入。请重新运行风格分析并启用原著资料。',
    );
  } else {
    // Prefer full voices for level selection so Writer with participants
    // cannot silently exceed the style token share (code-quality #1).
    let styleBudget = contextBudget.styleTokens;
    let selection = selectStyleRenderLevel(
      row.profileJson,
      styleBudget,
      'strict',
      { stage: 'writer', userOverrides: row.userOverridesJson },
    );

    // Spec §7.3 strict: before blocking compact, steal budget from soft
    // categories (historical digests + supplements) and retry once.
    if (selection.blocked) {
      const softPool =
        contextBudget.supplementTokens + contextBudget.episodicTokens;
      styleBudget = Math.min(contextBudget.inputBudget, styleBudget + softPool);
      selection = selectStyleRenderLevel(
        row.profileJson,
        styleBudget,
        'strict',
        { stage: 'writer', userOverrides: row.userOverridesJson },
      );
      if (selection.level) {
        styleOmitReasons.strict_soft_trim_for_style = 1;
        styleDegradeReason = 'strict_soft_trim_for_style';
      }
    }

    if (selection.blocked) {
      throw new ContinuationCapabilityBlockedError(
        `原著风格画像无法装入当前上下文预算（${
          selection.reason ?? 'insufficient_tokens'
        }）。请换更大上下文模型，或提高上下文长度后再续写。`,
      );
    }

    // Always keep legacy metrics for checker heuristics when a row is injectable.
    legacyStyle = legacyStyleFromRow(row);

    if (!selection.level) {
      styleOmitReasons[selection.reason ?? 'omitted_budget'] =
        (styleOmitReasons[selection.reason ?? 'omitted_budget'] || 0) + 1;
      styleDegradeReason = selection.reason ?? 'omitted_budget';
      // Balanced: no frozen V2 text, but metrics remain for deterministic checks.
      frozenStyle = null;
    } else {
      styleRenderLevel = selection.level;
      styleDegradeReason =
        selection.reason && selection.reason.startsWith('degraded')
          ? selection.reason
          : styleDegradeReason;
      styleTraceSelected = 1;
      // Estimate tokens at the selected level for the trace category.
      const rendered = renderStyleProfile(row.profileJson, selection.level, {
        stage: 'writer',
        userOverrides: row.userOverridesJson,
      });
      styleTraceTokens = rendered.estimatedTokens;

      frozenStyle = {
        profileId: row.id,
        profileHash: row.profileHash,
        profileSchemaVersion: row.profileSchemaVersion,
        analyzerVersion: row.analyzerVersion,
        rendererVersion: STYLE_RENDERER_VERSION,
        sourceFingerprint: sourceFingerprintKey(fp),
        boundaryCharOffsetExclusive: row.boundaryCharOffsetExclusive,
        frozenProfile: row.profileJson,
        userOverrides: row.userOverridesJson ?? {},
        renderLevel: selection.level,
        styleTokens: styleBudget,
        omitReason: styleDegradeReason,
      };
    }
  }

  // Canon facts are rendered in their own complete block. Keep this list for
  // explicit user rules only, otherwise hard world rules would be duplicated
  // in both prompt sections and inflate the context trace.

  const settingsSnapshot: ContinuationGenerationSettingsSnapshot = {
    schemaVersion: 1,
    workflowVersion: 2,
    // Persist the effective policy into the immutable run snapshot as well;
    // downstream prompt/checker stages must never see a stale off/balanced value.
    values: { ...settings, styleLevel },
    resolvedModelConfigIds: {
      planner: settings.plannerLlmConfigId ?? input.activeLlmConfigId,
      writer: settings.writerLlmConfigId ?? input.activeLlmConfigId,
      checker: settings.checkerEnabled
        ? settings.checkerLlmConfigId ?? input.activeLlmConfigId
        : null,
      repair: settings.checkerEnabled
        ? settings.repairLlmConfigId ?? input.activeLlmConfigId
        : null,
      stateExtraction:
        settings.stateExtractionLlmConfigId ?? input.activeLlmConfigId,
      control:
        settings.controlLlmConfigId ??
        settings.checkerLlmConfigId ??
        input.activeLlmConfigId,
    },
    frozenModelConfigs: input.frozenModelConfigs,
  };

  // Freeze stage budgets: prefer caller-provided; otherwise derive a writer-only
  // skeleton so resume/preview still have a capacity record.
  const stageBudgets: ContinuationStageBudgets | undefined =
    input.stageBudgets ??
    ({
      planner: planStageCapacity({
        llmConfigId: settingsSnapshot.resolvedModelConfigIds.planner,
        contextWindow: layoutLimit,
        maxOutputTokens: layoutMaxOut,
      }),
      writer: planStageCapacity({
        llmConfigId: settingsSnapshot.resolvedModelConfigIds.writer,
        contextWindow: layoutLimit,
        maxOutputTokens: layoutMaxOut,
      }),
      checker:
        settingsSnapshot.resolvedModelConfigIds.checker != null
          ? planStageCapacity({
              llmConfigId: settingsSnapshot.resolvedModelConfigIds.checker,
              contextWindow: layoutLimit,
              maxOutputTokens: layoutMaxOut,
            })
          : null,
      repair:
        settingsSnapshot.resolvedModelConfigIds.repair != null
          ? planStageCapacity({
              llmConfigId: settingsSnapshot.resolvedModelConfigIds.repair,
              contextWindow: layoutLimit,
              maxOutputTokens: layoutMaxOut,
            })
          : null,
    } satisfies ContinuationStageBudgets);

  const snapshot: ContinuationContextSnapshot = {
    schemaVersion: 2,
    workflowVersion: 2,
    projectId: input.projectId,
    targetChapterId: input.targetChapterId,
    targetPosition: input.targetPosition,
    source,
    canon: {
      snapshotId: snap.id,
      revision: snap.revision,
      boundaryGlobalCharOffset: snap.boundaryCharOffsetExclusive as number,
      capabilities: snap.capabilities,
      coverageWarning: partiallyCovered
        ? `当前 Canon 仅覆盖 ${snap.coverage.analyzedChapterCount}/${snap.coverage.sourceChapterCount} 个原著章节；早期设定可能未覆盖。`
        : undefined,
    },
    storyMemory: {
      stateFingerprint: smFingerprint,
      throughPosition: smThrough,
      status: smStatus,
    },
    inputRevisionHash: contentRevisionHash(input.currentChapterContent),
    contextBudget: {
      modelContextLimit: contextBudget.modelContextLimit,
      inputBudget: contextBudget.inputBudget,
      reservedOutputTokens: contextBudget.reservedOutputTokens,
      writerMaxOutputTokens: layoutMaxOut,
      writerInitialOutputTokens: input.initialWriterOutputTokens,
      styleTokens: contextBudget.styleTokens,
    },
    stageBudgets,
    style: frozenStyle,
    primaryAnchor: {
      ...primaryAnchor,
      excerpt: primaryAnchorExcerpt,
    },
    settingsSnapshot,
    bundles: {
      lockedRules,
      canon: canonBundle,
      historicalDigests,
      effectiveState,
      // Keep the legacy field readable for Schema 1 consumers. New runs use
      // primaryAnchor as the only injected正文 seam; continuation anchors do
      // not carry the original tail here.
      seam: {
        summary:
          primaryAnchor.kind === 'source_seam'
            ? primaryAnchor.summary
            : '（已由最近续写正文接缝替代）',
        excerpt:
          primaryAnchor.kind === 'source_seam' ? primaryAnchorExcerpt : '',
      },
      recentChapters,
      storyMemory: {
        summary: smSummary,
        estimatedTokens: smTokens,
        eligibilityReason: smEligibilityReason,
        throughPosition: smThrough,
      },
      episodic,
      style: legacyStyle,
      supplements,
      userInstruction: input.userInstruction,
    },
    createdAt: new Date().toISOString(),
  };

  const originalStyleCategory = {
    name: 'originalStyle',
    candidates: styleTraceCandidates,
    selected: styleTraceSelected,
    tokens: styleTraceTokens,
    omittedReasonCounts: {
      ...styleOmitReasons,
      ...(styleRenderLevel ? { [`level_${styleRenderLevel}`]: 1 } : {}),
      ...(styleDegradeReason ? { [styleDegradeReason]: 1 } : {}),
      ...(frozenStyle
        ? {
            [`profile_${frozenStyle.profileId.slice(0, 8)}`]: 1,
            [`hash_${frozenStyle.profileHash.slice(0, 8)}`]: 1,
          }
        : {}),
    },
  };
  const canonFactCount = [
    canonBundle.worldRules,
    canonBundle.characters,
    canonBundle.characterStates,
    canonBundle.relationships,
    canonBundle.experiences,
    canonBundle.knowledge,
    canonBundle.plotThreads,
    canonBundle.timelineEvents,
  ].reduce((total, items) => total + items.length, 0);

  const categories = [
    {
      name: 'supplements',
      candidates: supplements.selected.length + supplements.excluded.length,
      selected: supplements.selected.length,
      tokens: estimateTokens(
        [
          supplements.characterText,
          supplements.worldbookText,
          supplements.noteText,
          supplements.presetText,
        ].join('\n'),
      ),
      omittedReasonCounts: supplements.excluded.reduce((counts, item) => {
        counts[item.reason] = (counts[item.reason] || 0) + 1;
        return counts;
      }, {} as Record<string, number>),
    },
    {
      name: 'lockedRules',
      candidates: lockedRules.length,
      selected: lockedRules.length,
      tokens: estimateTokens(lockedRules.join('\n')),
      omittedReasonCounts: {},
    },
    {
      name: 'canon',
      candidates: canonFactCount,
      selected: canonFactCount,
      tokens: canonBundle.estimatedTokens,
      omittedReasonCounts: canonBundle.omittedReasonCounts,
    },
    {
      name: 'historicalDigests',
      candidates: historicalDigests.length,
      selected: historicalDigests.length,
      tokens: estimateTokens(
        historicalDigests.map(item => item.summary).join('\n'),
      ),
      omittedReasonCounts: {},
    },
    {
      name: 'effectiveState',
      candidates: effectiveState.characterStates.length,
      selected: effectiveState.characterStates.length,
      tokens: estimateTokens(JSON.stringify(effectiveState.characterStates)),
      omittedReasonCounts: {},
    },
    {
      name: 'primaryAnchor',
      candidates: primaryAnchor.excerpt ? 1 : 0,
      selected: primaryAnchorExcerpt ? 1 : 0,
      tokens: estimateTokens(primaryAnchorExcerpt),
      omittedReasonCounts: {},
    },
    {
      name: 'recentChapters',
      candidates: priorChapters.length,
      selected: recentChapters.length,
      coveredByPrimaryAnchor: recentCoveredByPrimaryAnchor,
      tokens: estimateTokens(recentChapters.map(c => c.excerpt).join('\n')),
      omittedReasonCounts: {
        ...(recentCoveredByPrimaryAnchor > 0
          ? { already_covered_by_primary_anchor: recentCoveredByPrimaryAnchor }
          : {}),
        ...(recentBridgeBudgetOmitted > 0
          ? { recent_bridge_budget_exhausted: recentBridgeBudgetOmitted }
          : {}),
      },
    },
    {
      name: 'storyMemory',
      candidates: smStatus === 'missing' ? 0 : 1,
      selected: smSummary ? 1 : 0,
      tokens: smTokens,
      omittedReasonCounts: smSummary ? {} : { [smEligibilityReason]: 1 },
    },
    {
      name: 'episodic',
      candidates: priorChapters.filter(chapter =>
        Boolean(chapter.memory_summary?.trim()),
      ).length,
      selected: episodic.length,
      tokens: estimateTokens(episodicText),
      omittedReasonCounts: episodicText ? {} : { no_match_or_summary: 1 },
    },
    originalStyleCategory,
  ];

  const totalInputTokens = categories.reduce((s, c) => s + c.tokens, 0);
  if (totalInputTokens > contextBudget.inputBudget) {
    // Explicit block rather than silent hard-rule truncation.
    // Soft trim recent + style already clipped; if still over, block.
    const hardTokens = categories
      .filter(c => c.name === 'lockedRules' || c.name === 'canon')
      .reduce((s, c) => s + c.tokens, 0);
    if (hardTokens > contextBudget.inputBudget) {
      throw new ContinuationCapabilityBlockedError(
        `上下文预算不足：硬规则约 ${hardTokens} token，可用 ${contextBudget.inputBudget}。请换更大上下文模型或降低目标章节长度。`,
      );
    }
    throw new ContinuationCapabilityBlockedError(
      `上下文预算不足：已组装约 ${totalInputTokens} token，可用 ${contextBudget.inputBudget}。请换更大上下文模型或降低目标章节长度。`,
    );
  }

  const trace: ContinuationContextTrace = {
    sourceId: source.sourceId,
    canonSnapshotId: snap.id,
    canonRevision: snap.revision,
    targetPosition: input.targetPosition,
    entityRefs: effectiveState.characterStates.map(c => c.ref),
    storyMemoryFingerprint: smFingerprint,
    freshness: {
      canonReady: true,
      storyMemoryStatus: smStatus,
      pendingStateExtractionCount:
        effectiveState.freshness.pendingStateExtractionCount,
      pendingMajorProposalCount:
        effectiveState.freshness.pendingMajorProposalCount,
    },
    categories,
    totalInputTokens,
    reservedOutputTokens: contextBudget.reservedOutputTokens,
    inputBudget: contextBudget.inputBudget,
    modelContextLimit: contextBudget.modelContextLimit,
    omittedCapabilities: gaps,
    primaryAnchorKind: primaryAnchor.kind,
    primaryAnchorChapterId: primaryAnchor.chapterId,
    primaryAnchorPosition: primaryAnchor.position,
    effectiveWindow: contextBudget.effectiveWindow,
    contextUtilizationRatio:
      CONTINUATION_BUDGET_POLICY.contextUtilizationRatio,
    maxOutputRatio: CONTINUATION_BUDGET_POLICY.maxOutputRatio,
    declaredOutput: contextBudget.declaredOutput,
    chapterDemand: contextBudget.chapterDemand,
    pressure: contextBudget.pressure,
    planShare: contextBudget.planShare,
    hardContextTokens,
    desiredOutput: contextBudget.desiredOutput,
    requestedMaxTokens: contextBudget.requestedMaxTokens,
    effectiveInputBudget: contextBudget.inputBudget,
    minimumOutput: contextBudget.minimumOutput,
    budgetRestrictedReason: null,
  };

  return { snapshot, trace };
}

export interface BuildContinuationV4ContextInput
  extends Omit<
    BuildContinuationContextInput,
    | 'modelContextLimit'
    | 'maxOutputTokens'
    | 'initialWriterOutputTokens'
    | 'stageBudgets'
  > {
  policy: ContextAutomationPolicyV2;
  stageModels: Record<
    ContinuationV4ContextStage,
    { configId: number; contextWindow: number; maxOutputTokens: number }
  >;
}

function simulatedContinuationPlan(): ContinuationPlan {
  return {
    schemaVersion: 1,
    chapterGoal: '',
    centralConflict: '',
    beats: [],
    participatingCharacterIds: [],
    characterActions: [],
    plotAdvances: [],
    foreshadowingActions: [],
    proposedStateChanges: [],
    risks: [],
  };
}

function v4PromptEstimates(input: {
  views: ReturnType<typeof buildContinuationV4StageViews>;
  artifactText: string;
  plan: ContinuationPlan;
  metrics: ReturnType<typeof buildContinuationControlMetrics>;
  controlReport: ReturnType<typeof buildContinuationControlFallback>;
}): Record<ContinuationV4ContextStage, number> {
  return {
    writer: estimateMessagesTokens(
      compileContinuationV4WriterMessages(input.views.writer),
    ),
    checker: estimateMessagesTokens(
      compileContinuationV4CheckerMessages({
        view: input.views.checker,
        artifactText: input.artifactText,
        writerArtifactHash: contentRevisionHash(input.artifactText),
        plan: input.plan,
      }),
    ),
    control: estimateMessagesTokens(
      compileContinuationV4ControlMessages({
        view: input.views.control,
        artifactText: input.artifactText,
        metrics: input.metrics,
        plan: input.plan,
      }),
    ),
    repair: estimateMessagesTokens(
      compileContinuationV4RepairMessages({
        view: input.views.repair,
        artifactText: input.artifactText,
        plan: input.plan,
        checkerReport: { issues: [] },
        controlReport: input.controlReport,
      }),
    ),
  };
}

function v4ProtocolSkeletons(): Record<ContinuationV4ContextStage, number> {
  return {
    writer: continuationV4ProtocolSkeletonTokens('writer'),
    checker: continuationV4ProtocolSkeletonTokens('checker'),
    control: continuationV4ProtocolSkeletonTokens('control'),
    repair: continuationV4ProtocolSkeletonTokens('repair'),
  };
}

/**
 * Build the V4 snapshot by reusing the one-shot frozen source/Canon/state
 * selection and then deriving stage views synchronously from that snapshot.
 * The base builder remains the historical V2 entrypoint; this wrapper is the
 * only new-run V4 entrypoint and freezes policy/model capabilities before it
 * returns.
 */
export async function buildContinuationV4Context(
  input: BuildContinuationV4ContextInput,
): Promise<{
  snapshot: ContinuationContextSnapshotV3;
  trace: ContinuationContextTrace;
}> {
  const writerModel = input.stageModels.writer;
  const base = await buildContinuationContext({
    ...input,
    modelContextLimit: writerModel.contextWindow,
    maxOutputTokens: writerModel.maxOutputTokens,
    initialWriterOutputTokens: writerModel.maxOutputTokens,
    contextAutomationPolicy: input.policy,
    writerStageModel: writerModel,
  });
  const policyHash = hashContextAutomationPolicy(input.policy);
  const frozenPolicy = {
    schemaVersion: input.policy.schemaVersion,
    allocatorVersion: input.policy.allocatorVersion,
    policyHash,
    policy: JSON.parse(JSON.stringify(input.policy)) as ContextAutomationPolicyV2,
    appliedAt: new Date().toISOString(),
  };
  const plan = simulatedContinuationPlan();
  const artifactText = '';
  const metrics = buildContinuationControlMetrics({
    text: artifactText,
    target: input.targetPosition == null
      ? input.settingsOverride?.targetChapterChars ?? 1
      : input.settingsOverride?.targetChapterChars ??
        (base.snapshot.settingsSnapshot.values.targetChapterChars ?? 1),
    plan,
  });
  const controlReport = buildContinuationControlFallback(metrics);
  const protocolSkeletonTokens = v4ProtocolSkeletons();
  const provisionalBudgets = resolveContinuationV4BudgetPreview({
    frozenPolicy: input.policy,
    stages: input.stageModels,
    targetChapterChars: base.snapshot.settingsSnapshot.values.targetChapterChars,
    writerDraftTokens: estimateTokens(artifactText),
    paragraphCount: 0,
    compiledPromptTokens: 0,
    protocolSkeletonTokens,
    hardContextTokens: 0,
  }).stages;
  const provisionalViews = buildContinuationV4StageViews({
    snapshot: base.snapshot,
    stageBudgets: provisionalBudgets,
  });
  const firstPromptTokens = v4PromptEstimates({
    views: provisionalViews,
    artifactText,
    plan,
    metrics,
    controlReport,
  });
  const resolvedBudgets = resolveContinuationV4BudgetPreview({
    frozenPolicy: input.policy,
    stages: input.stageModels,
    targetChapterChars: base.snapshot.settingsSnapshot.values.targetChapterChars,
    writerDraftTokens: estimateTokens(artifactText),
    paragraphCount: 0,
    compiledPromptTokens: firstPromptTokens,
    protocolSkeletonTokens,
    hardContextTokens: {
      writer: base.trace.hardContextTokens ?? 0,
      checker: 0,
      control: 0,
      repair: 0,
    },
  }).stages;
  const stageViews = buildContinuationV4StageViews({
    snapshot: base.snapshot,
    stageBudgets: resolvedBudgets,
  });
  const finalPromptTokens = v4PromptEstimates({
    views: stageViews,
    artifactText,
    plan,
    metrics,
    controlReport,
  });
  const frozenStageBudgets = resolveContinuationV4BudgetPreview({
    frozenPolicy: input.policy,
    stages: input.stageModels,
    targetChapterChars: base.snapshot.settingsSnapshot.values.targetChapterChars,
    writerDraftTokens: estimateTokens(artifactText),
    paragraphCount: 0,
    compiledPromptTokens: finalPromptTokens,
    protocolSkeletonTokens,
    hardContextTokens: {
      writer: base.trace.hardContextTokens ?? 0,
      checker: 0,
      control: 0,
      repair: 0,
    },
  }).stages;
  const frozenViews = buildContinuationV4StageViews({
    snapshot: base.snapshot,
    stageBudgets: frozenStageBudgets,
  });
  const settingsSnapshot: ContinuationGenerationSettingsSnapshot = {
    ...base.snapshot.settingsSnapshot,
    workflowVersion: 4,
    values: {
      ...base.snapshot.settingsSnapshot.values,
      checkerEnabled: true,
      writerLlmConfigId: input.stageModels.writer.configId,
      checkerLlmConfigId: input.stageModels.checker.configId,
      controlLlmConfigId: input.stageModels.control.configId,
      repairLlmConfigId: input.stageModels.repair.configId,
    },
    resolvedModelConfigIds: {
      ...base.snapshot.settingsSnapshot.resolvedModelConfigIds,
      writer: input.stageModels.writer.configId,
      checker: input.stageModels.checker.configId,
      control: input.stageModels.control.configId,
      repair: input.stageModels.repair.configId,
    },
    frozenModelConfigs: input.frozenModelConfigs,
  };
  const snapshot: ContinuationContextSnapshotV3 = {
    ...base.snapshot,
    schemaVersion: 3,
    workflowVersion: 4,
    budgetPolicy: frozenPolicy,
    stageBudgets: frozenStageBudgets,
    stageViews: frozenViews,
    settingsSnapshot,
  };
  const trace: ContinuationContextTrace = {
    ...base.trace,
    v4StageBudgets: frozenStageBudgets,
    v4StageViewHashes: {
      writer: hashContinuationV4StageView(frozenViews.writer),
      checker: hashContinuationV4StageView(frozenViews.checker),
      control: hashContinuationV4StageView(frozenViews.control),
      repair: hashContinuationV4StageView(frozenViews.repair),
    },
  };
  return { snapshot, trace };
}

/**
 * Continuation Context Builder (Spec §8).
 * Does NOT call generation-mode buildContext() or Story Memory LLM.
 * Freezes a snapshot shared by Planner/Writer/Checker/Repair.
 */
import type { ContinuationChapterPosition } from '../../../types/novel';
import { openDatabase } from '../../../data/connection/openDatabase';
import {
  clipTextToTokenBudget,
  clipTextTailToTokenBudget,
  estimateTokens,
} from '../../../utils/tokenEstimator';
import type { Chapter } from '../../../types/novel';
import * as database from '../../database';
import { buildMemoryContext } from '../../contextBuilder';
import { renderStoryMemoryForContext } from '../../storyMemory/storyMemoryRenderer';
import { resolveUsableCheckpointForTarget } from '../../storyMemory/storyMemoryCheckpointEligibility';
import { continuationSourceReader } from '../continuationSourceReader';
import { CanonQueryService } from '../canon/canonQueryService';
import { listHistoricalDigestReferences } from '../canon/historicalDigestService';
import { getEffectiveContinuationState } from './continuationStateService';
import { buildContinuationSupplementContext } from './continuationSupplementContextBuilder';
import {
  contentRevisionHash,
  ensureGenerationSettings,
} from './generationRepository';
import type {
  ContinuationContextSnapshot,
  ContinuationContextTrace,
  ContinuationGenerationSettings,
  ContinuationGenerationSettingsSnapshot,
  ContinuationStyleProfile,
  StrictnessProfile,
} from './types';
import { ContinuationCapabilityBlockedError } from './types';
import { planContinuationContextBudget } from './continuationContextBudget';

export interface BuildContinuationContextInput {
  projectId: number;
  targetChapterId: number;
  targetPosition: ContinuationChapterPosition;
  currentChapterContent: string;
  userInstruction: string;
  modelContextLimit: number;
  maxOutputTokens: number;
  /** Resolved active LLM config id used when stage ids are null. */
  activeLlmConfigId: number;
  settingsOverride?: Partial<ContinuationGenerationSettings>;
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

  const contextBudget = planContinuationContextBudget({
    modelContextLimit: input.modelContextLimit,
    writerMaxOutputTokens: input.maxOutputTokens,
  });
  const inputBudget = contextBudget.inputBudget;

  const reviewPolicy = reviewPolicyFor(profile);
  const supplements = await buildContinuationSupplementContext({
    projectId: input.projectId,
    tokenBudget: contextBudget.supplementTokens,
  });
  const canonBundle = await CanonQueryService.getContextBundle({
    projectId: input.projectId,
    snapshotId: snap.id,
    snapshotRevision: snap.revision,
    atSourcePosition: snap.boundaryPosition,
    queryText: input.userInstruction,
    characterIds: [],
    tokenBudget: contextBudget.canonTokens,
    reviewPolicy,
  });
  const partiallyCovered =
    snap.coverage.analyzedChapterCount < snap.coverage.sourceChapterCount;
  const historicalDigests = partiallyCovered
    ? await listHistoricalDigestReferences({
        projectId: input.projectId,
        queryText: input.userInstruction,
        limit: 3,
      })
        .then(items =>
          {
            // Historical cards are the first soft context to be dropped. They
            // share one category budget rather than each consuming 5%.
            const perCard = Math.max(
              1,
              Math.floor((inputBudget * 0.05) / Math.max(1, items.length)),
            );
            return items.map(item => ({
              ...item,
              summary: clipTextToTokenBudget(item.summary, perCard),
            }));
          },
        )
        .catch(() => [])
    : [];

  // Seam: last bounded source chapter excerpt via SourceReader only.
  const chapters =
    await continuationSourceReader.listBoundedSourceChapters(source);
  let seamSummary = '';
  let seamExcerpt = '';
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

  // Recent continuation chapters are a distinct short-term bridge. Allocate
  // from newest to oldest: the immediately previous chapter is retained whole
  // when possible, older chapters progressively contribute their tails.
  const projectChapters = await database.getChaptersByProject(input.projectId);
  const priorChapters = projectChapters
    .filter(
      chapter =>
        chapter.position < input.targetPosition && Boolean(chapter.content?.trim()),
    )
    .sort((a, b) => b.position - a.position);
  const recentChapters: ContinuationContextSnapshot['bundles']['recentChapters'] =
    [];
  let recentRemaining = contextBudget.recentBridgeTokens;
  for (const chapter of priorChapters) {
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
      smThrough = eligibility.checkpoint.state.throughChapterPosition as ContinuationChapterPosition;
      smFingerprint = eligibility.checkpoint.state.metadata.stateFingerprint ?? 'none';
      const rendered = renderStoryMemoryForContext(eligibility.checkpoint.state, {
        currentChapter: targetChapter,
        budgetTokens: contextBudget.storyMemoryTokens,
        retrievalUserPrompt: input.userInstruction,
      });
      smSummary = rendered.text;
      smTokens = rendered.estimatedTokens;
    }
  } catch {
    // Memory is optional in loose/balanced mode. The trace exposes omission.
  }

  // Episodic chapter memories complement the checkpoint with task-relevant
  // settled events. Do not repeat raw bridge chapters in both categories.
  const bridgeIds = new Set(recentChapters.map(chapter => chapter.chapterId));
  const episodicText = buildMemoryContext(
    priorChapters
      .filter(chapter => !bridgeIds.has(chapter.id))
      .sort((a, b) => a.position - b.position),
    targetChapter,
    10,
    contextBudget.episodicTokens,
    { queryText: input.userInstruction },
  );
  const episodic = episodicText
    ? [{ chapterId: -1, summary: episodicText }]
    : [];

  const db = await openDatabase();

  // Style profile (optional)
  let style: ContinuationStyleProfile | null = null;
  try {
    const [st] = await db.executeSql(
      'SELECT * FROM continuation_style_profiles WHERE project_id = ?',
      [input.projectId],
    );
    if (st.rows.length > 0) {
      const r = st.rows.item(0);
      style = {
        projectId: r.project_id,
        sourceId: r.source_id,
        canonSnapshotId: r.canon_snapshot_id,
        canonRevision: r.canon_revision,
        narrativePerson: r.narrative_person,
        tense: r.tense,
        averageSentenceLength: r.average_sentence_length,
        averageParagraphLength: r.average_paragraph_length,
        dialogueRatio: r.dialogue_ratio,
        descriptionRatio: r.description_ratio,
        pacingNotes: r.pacing_notes,
        lexicalNotes: r.lexical_notes,
        sampleEvidenceIds: JSON.parse(r.sample_evidence_ids_json || '[]'),
        reviewStatus: r.review_status,
      };
    }
  } catch {
    style = null;
  }

  let lockedRules: string[] = [];
  try {
    lockedRules = JSON.parse(settings.customRulesJson || '[]');
    if (!Array.isArray(lockedRules)) lockedRules = [];
  } catch {
    lockedRules = [];
  }
  // Hard locked world rules always first
  for (const rule of canonBundle.worldRules) {
    if (rule.constraintLevel === 'hard' || rule.reviewStatus === 'locked') {
      lockedRules.push(`[locked] ${rule.title}: ${rule.description}`);
    }
  }

  const settingsSnapshot: ContinuationGenerationSettingsSnapshot = {
    schemaVersion: 1,
    values: settings,
    resolvedModelConfigIds: {
      planner: settings.plannerLlmConfigId ?? input.activeLlmConfigId,
      writer: settings.writerLlmConfigId ?? input.activeLlmConfigId,
      checker: settings.checkerEnabled
        ? (settings.checkerLlmConfigId ?? input.activeLlmConfigId)
        : null,
      repair: settings.checkerEnabled
        ? (settings.repairLlmConfigId ?? input.activeLlmConfigId)
        : null,
      stateExtraction:
        settings.stateExtractionLlmConfigId ?? input.activeLlmConfigId,
    },
  };

  const snapshot: ContinuationContextSnapshot = {
    schemaVersion: 1,
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
      writerMaxOutputTokens: input.maxOutputTokens,
    },
    settingsSnapshot,
    bundles: {
      lockedRules,
      canon: canonBundle,
      historicalDigests,
      effectiveState,
      seam: { summary: seamSummary, excerpt: seamExcerpt },
      recentChapters,
      storyMemory: {
        summary: smSummary,
        estimatedTokens: smTokens,
        eligibilityReason: smEligibilityReason,
        throughPosition: smThrough,
      },
      episodic,
      style,
      supplements,
      userInstruction: input.userInstruction,
    },
    createdAt: new Date().toISOString(),
  };

  const categories = [
    {
      name: 'supplements',
      candidates: supplements.selected.length + supplements.excluded.length,
      selected: supplements.selected.length,
      tokens: estimateTokens([supplements.characterText, supplements.worldbookText, supplements.noteText, supplements.presetText].join('\n')),
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
      candidates: canonBundle.worldRules.length + canonBundle.characters.length,
      selected: canonBundle.worldRules.length + canonBundle.characters.length,
      tokens: canonBundle.estimatedTokens,
      omittedReasonCounts: canonBundle.omittedReasonCounts,
    },
    {
      name: 'historicalDigests',
      candidates: historicalDigests.length,
      selected: historicalDigests.length,
      tokens: estimateTokens(historicalDigests.map(item => item.summary).join('\n')),
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
      name: 'seam',
      candidates: chapters.length > 0 ? 1 : 0,
      selected: chapters.length > 0 ? 1 : 0,
      tokens: estimateTokens(seamExcerpt),
      omittedReasonCounts: {},
    },
    {
      name: 'recentChapters',
      candidates: priorChapters.length,
      selected: recentChapters.length,
      tokens: estimateTokens(recentChapters.map(c => c.excerpt).join('\n')),
      omittedReasonCounts: {},
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
      candidates: priorChapters.filter(chapter => Boolean(chapter.memory_summary?.trim())).length,
      selected: episodic.length,
      tokens: estimateTokens(episodicText),
      omittedReasonCounts: episodicText ? {} : { no_match_or_summary: 1 },
    },
  ];

  const totalInputTokens = categories.reduce((s, c) => s + c.tokens, 0);
  if (totalInputTokens > inputBudget) {
    // Explicit block rather than silent hard-rule truncation.
    // Soft trim recent + style already clipped; if still over, block.
    const hardTokens = categories
      .filter(c => c.name === 'lockedRules' || c.name === 'canon')
      .reduce((s, c) => s + c.tokens, 0);
    if (hardTokens > inputBudget) {
      throw new ContinuationCapabilityBlockedError(
        `上下文预算不足：硬规则约 ${hardTokens} token，可用 ${inputBudget}。请换更大上下文模型或降低输出预留。`,
      );
    }
    throw new ContinuationCapabilityBlockedError(
      `上下文预算不足：已组装约 ${totalInputTokens} token，可用 ${inputBudget}。请换更大上下文模型或降低输出预留。`,
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
  };

  return { snapshot, trace };
}

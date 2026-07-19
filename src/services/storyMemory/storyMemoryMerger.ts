import { estimateTokens } from '../../utils/tokenEstimator';
import {
  canonicalStringify,
  fingerprintStoryMemoryState,
  stableTextFingerprint,
} from './storyMemoryFingerprint';
import { validateEntityReferences } from './storyMemoryValidator';
import type {
  ApplyBatchPatchResult,
  ApplyPatchResult,
  BatchEvidenceQuote,
  ChapterMemoryPatchDraft,
  StoryCharacter,
  StoryMemoryBatchPatchDraft,
  StoryMemoryState,
  StoryMemoryWarning,
  StoredStoryMemoryBatch,
} from './storyMemoryTypes';
import { StoryMemoryError } from './storyMemoryTypes';

const MAX_EVIDENCE_CHAPTERS = 20;
const MAX_COMPLETED_BEATS = 20;
const MAX_RESOLVED_THREADS = 30;

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort();
}

function recentEvidence(values: number[], chapterId: number): number[] {
  return [...new Set([...values, chapterId])].slice(-MAX_EVIDENCE_CHAPTERS);
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}_${stableTextFingerprint(seed)}`;
}

function resolveAvailableId(
  baseId: string,
  collection: Record<string, unknown>,
): string {
  if (!collection[baseId]) return baseId;
  let suffix = 2;
  while (collection[`${baseId}_${suffix}`]) suffix += 1;
  return `${baseId}_${suffix}`;
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function findExistingCharacter(
  state: StoryMemoryState,
  name: string,
  aliases: string[],
): StoryCharacter | null {
  const names = new Set([name, ...aliases].map(normalizeName));
  return (
    Object.values(state.characters).find(character =>
      [character.canonicalName, ...character.aliases]
        .map(normalizeName)
        .some(candidate => names.has(candidate)),
    ) || null
  );
}

function updateSet(
  original: string[],
  additions: string[],
  removals: string[],
): string[] {
  const removed = new Set(removals.map(normalizeName));
  return unique([...original, ...additions]).filter(
    item => !removed.has(normalizeName(item)),
  );
}

function archiveOverflow(state: StoryMemoryState): void {
  const archived: string[] = [];
  if (state.mainline.recentCompletedBeats.length > MAX_COMPLETED_BEATS) {
    const overflow = state.mainline.recentCompletedBeats.splice(
      0,
      state.mainline.recentCompletedBeats.length - MAX_COMPLETED_BEATS,
    );
    archived.push(...overflow.map(item => `完成：${item.summary}`));
  }
  if (state.mainline.recentResolvedThreads.length > MAX_RESOLVED_THREADS) {
    const overflow = state.mainline.recentResolvedThreads.splice(
      0,
      state.mainline.recentResolvedThreads.length - MAX_RESOLVED_THREADS,
    );
    archived.push(
      ...overflow.map(item => `解决：${item.title}—${item.resolution}`),
    );
  }
  if (archived.length > 0) {
    state.mainline.archiveDigest = [state.mainline.archiveDigest, ...archived]
      .filter(Boolean)
      .join('\n')
      .slice(-3000);
  }
}

export function applyStoryMemoryPatch(
  previous: StoryMemoryState,
  draft: ChapterMemoryPatchDraft,
  context: {
    projectId: number;
    chapterId: number;
    chapterPosition: number;
    sourceFingerprint: string;
    baseMemoryFingerprint?: string;
    now?: string;
    /** tempRef → first evidence chapterId for deterministic stable IDs */
    characterSeedChapterIds?: Map<string, number>;
    /** optional last applied unit id override (batch_*) */
    lastAppliedUnitId?: string;
  },
): ApplyPatchResult {
  if (
    context.projectId !== previous.projectId ||
    draft.chapterRef.chapterId !== context.chapterId ||
    draft.chapterRef.chapterPosition !== context.chapterPosition
  ) {
    throw new StoryMemoryError(
      'MEMORY_PATCH_SCHEMA_INVALID',
      '补丁章节引用与应用上下文不一致。',
    );
  }
  if (context.chapterPosition < previous.throughChapterPosition) {
    throw new StoryMemoryError(
      'MEMORY_DIRTY',
      '补丁章节早于当前故事记忆进度。',
    );
  }
  const baseFingerprint = fingerprintStoryMemoryState(previous);
  if (
    context.baseMemoryFingerprint &&
    context.baseMemoryFingerprint !== baseFingerprint
  ) {
    throw new StoryMemoryError(
      'MEMORY_BASE_FINGERPRINT_MISMATCH',
      '故事记忆基础指纹不匹配，需要重建。',
    );
  }
  validateEntityReferences(draft, previous);
  const patchId =
    context.lastAppliedUnitId ||
    `patch_${context.chapterId}_${context.sourceFingerprint}_1`;
  if (previous.metadata.lastAppliedPatchId === patchId) {
    return {
      state: previous,
      resolvedPatch: {
        patchId,
        schemaVersion: 1,
        projectId: context.projectId,
        chapterId: context.chapterId,
        chapterPosition: context.chapterPosition,
        sourceFingerprint: context.sourceFingerprint,
        baseMemoryFingerprint: baseFingerprint,
        resultMemoryFingerprint: previous.metadata.stateFingerprint,
        episodicSummary: draft.episodicSummary,
        normalizedPatch: draft,
        generatedAt: context.now || new Date().toISOString(),
        appliedAt: context.now || new Date().toISOString(),
      },
      warnings: [{ code: 'PATCH_ALREADY_APPLIED', message: '补丁已应用。' }],
    };
  }

  const state: StoryMemoryState = JSON.parse(canonicalStringify(previous));
  const warnings: StoryMemoryWarning[] = [];
  const refMap = new Map<string, string>();

  for (const item of draft.newCharacters) {
    const existing = findExistingCharacter(
      state,
      item.canonicalName,
      item.aliases,
    );
    if (existing) {
      existing.aliases = unique([
        ...existing.aliases,
        ...item.aliases,
        item.canonicalName === existing.canonicalName ? '' : item.canonicalName,
      ]);
      existing.evidenceChapterIds = recentEvidence(
        existing.evidenceChapterIds,
        context.chapterId,
      );
      refMap.set(item.tempRef, existing.id);
      warnings.push({
        code: 'CHARACTER_ALIAS_MERGED',
        message: `${item.canonicalName} 已合并到现有人物。`,
      });
      continue;
    }
    const seedChapterId =
      context.characterSeedChapterIds?.get(item.tempRef) ?? context.chapterId;
    const baseId = stableId(
      `char_${context.projectId}`,
      `${normalizeName(item.canonicalName)}|${seedChapterId}`,
    );
    const id = resolveAvailableId(baseId, state.characters);
    state.characters[id] = {
      id,
      canonicalName: item.canonicalName.trim(),
      aliases: unique(item.aliases),
      role: item.role.trim(),
      immutableProfile: {
        identity: item.identity.trim(),
        stableTraits: unique(item.stableTraits),
        affiliations: [],
      },
      currentState: {
        location: item.initialState.location || '',
        physicalState: item.initialState.physicalState || '',
        emotionalState: item.initialState.emotionalState || '',
        currentGoal: item.initialState.currentGoal || '',
        knowledge: unique(item.initialState.knowledge || []),
        possessions: unique(item.initialState.possessions || []),
        secrets: unique(item.initialState.secrets || []),
      },
      status: item.status,
      firstSeenChapterId: seedChapterId,
      firstSeenPosition: context.chapterPosition,
      lastChangedChapterId: context.chapterId,
      lastChangedPosition: context.chapterPosition,
      evidenceChapterIds: [seedChapterId],
    };
    refMap.set(item.tempRef, id);
  }

  for (const update of draft.characterUpdates) {
    const character = state.characters[update.characterRef];
    character.aliases = unique([...character.aliases, ...update.addAliases]);
    if (Object.keys(update.profileCorrections || {}).length > 0) {
      character.immutableProfile = {
        ...character.immutableProfile,
        ...update.profileCorrections,
        stableTraits: update.profileCorrections.stableTraits
          ? unique(update.profileCorrections.stableTraits)
          : character.immutableProfile.stableTraits,
        affiliations: update.profileCorrections.affiliations
          ? unique(update.profileCorrections.affiliations)
          : character.immutableProfile.affiliations,
      };
    }
    for (const field of update.clearFields) {
      if (
        field in character.currentState &&
        typeof character.currentState[
          field as keyof typeof character.currentState
        ] === 'string'
      ) {
        (character.currentState as unknown as Record<string, unknown>)[field] =
          '';
      }
    }
    character.currentState = {
      ...character.currentState,
      ...update.stateChanges,
      knowledge: updateSet(
        character.currentState.knowledge,
        update.addKnowledge,
        update.removeKnowledge,
      ),
      possessions: updateSet(
        character.currentState.possessions,
        update.addPossessions,
        update.removePossessions,
      ),
      secrets: updateSet(
        character.currentState.secrets,
        update.addSecrets,
        update.removeSecrets,
      ),
    };
    if (update.status) character.status = update.status;
    character.lastChangedChapterId = context.chapterId;
    character.lastChangedPosition = context.chapterPosition;
    character.evidenceChapterIds = recentEvidence(
      character.evidenceChapterIds,
      context.chapterId,
    );
  }

  for (const item of draft.newRelationships) {
    let fromId = refMap.get(item.fromRef) || item.fromRef;
    let toId = refMap.get(item.toRef) || item.toRef;
    if (item.direction === 'bidirectional' && fromId > toId) {
      [fromId, toId] = [toId, fromId];
    }
    const relationSeed = `${fromId}|${toId}|${item.direction}|${normalizeName(
      item.relationType,
    )}|${context.chapterId}`;
    const id = resolveAvailableId(
      stableId(`rel_${context.projectId}`, relationSeed),
      state.relationships,
    );
    state.relationships[id] = {
      id,
      fromCharacterId: fromId,
      toCharacterId: toId,
      direction: item.direction,
      relationType: item.relationType,
      currentState: item.currentState,
      trustLevel: item.trustLevel,
      publicStatus: item.publicStatus,
      hiddenStatus: item.hiddenStatus,
      reason: item.reason,
      firstSeenChapterId: context.chapterId,
      lastChangedChapterId: context.chapterId,
      lastChangedPosition: context.chapterPosition,
      evidenceChapterIds: [context.chapterId],
    };
    refMap.set(item.tempRef, id);
  }

  for (const update of draft.relationshipUpdates) {
    const relationship = state.relationships[update.relationshipRef];
    Object.assign(
      relationship,
      Object.fromEntries(
        Object.entries(update).filter(
          ([key, value]) =>
            key !== 'relationshipRef' &&
            key !== 'evidenceQuote' &&
            value !== undefined,
        ),
      ),
    );
    relationship.lastChangedChapterId = context.chapterId;
    relationship.lastChangedPosition = context.chapterPosition;
    relationship.evidenceChapterIds = recentEvidence(
      relationship.evidenceChapterIds,
      context.chapterId,
    );
  }

  const mainline = state.mainline;
  const arc = draft.mainlinePatch.currentArcUpdate;
  if (arc.action === 'start') {
    mainline.currentArc = {
      id: stableId(
        `arc_${context.projectId}`,
        `${arc.name}|${context.chapterId}`,
      ),
      name: arc.name,
      summary: arc.summary,
      startedChapterId: context.chapterId,
    };
  } else if (arc.action === 'update' && mainline.currentArc) {
    mainline.currentArc.name = arc.name || mainline.currentArc.name;
    mainline.currentArc.summary = arc.summary || mainline.currentArc.summary;
  } else if (arc.action === 'complete') {
    if (mainline.currentArc) {
      mainline.recentCompletedBeats.push({
        id: mainline.currentArc.id,
        summary: arc.summary || mainline.currentArc.summary,
        chapterId: context.chapterId,
      });
    }
    mainline.currentArc = null;
  }
  if (draft.mainlinePatch.currentObjective) {
    mainline.currentObjective = draft.mainlinePatch.currentObjective.value;
  }
  for (const item of draft.mainlinePatch.conflictUpserts) {
    const id =
      item.ref && mainline.activeConflicts[item.ref]
        ? item.ref
        : stableId(
            `conflict_${context.projectId}`,
            `${item.title}|${context.chapterId}`,
          );
    mainline.activeConflicts[id] = {
      id,
      title: item.title,
      parties: unique((item.parties || []).map(ref => refMap.get(ref) || ref)),
      state: item.state || '',
      stakes: item.stakes || '',
      openedChapterId:
        mainline.activeConflicts[id]?.openedChapterId || context.chapterId,
      lastChangedChapterId: context.chapterId,
      evidenceChapterIds: recentEvidence(
        mainline.activeConflicts[id]?.evidenceChapterIds || [],
        context.chapterId,
      ),
    };
  }
  for (const item of draft.mainlinePatch.threadOpens) {
    const id = stableId(
      `thread_${context.projectId}`,
      `${item.title}|${context.chapterId}`,
    );
    mainline.openThreads[id] = {
      id,
      title: item.title,
      description: item.description || '',
      ownerCharacterIds: unique(
        (item.ownerCharacterRefs || []).map(ref => refMap.get(ref) || ref),
      ),
      priority: item.priority || 'normal',
      openedChapterId: context.chapterId,
      lastChangedChapterId: context.chapterId,
      deadlineOrTrigger: item.deadlineOrTrigger || '',
      evidenceChapterIds: [context.chapterId],
    };
    refMap.set(item.ref, id);
  }
  for (const item of draft.mainlinePatch.threadUpdates) {
    const id = refMap.get(item.ref) || item.ref;
    const thread = mainline.openThreads[id];
    if (!thread) {
      throw new StoryMemoryError(
        'MEMORY_ENTITY_REFERENCE_INVALID',
        `待更新线索不存在：${item.ref}`,
      );
    }
    thread.title = item.title || thread.title;
    thread.description = item.description || thread.description;
    thread.priority = item.priority || thread.priority;
    thread.deadlineOrTrigger =
      item.deadlineOrTrigger || thread.deadlineOrTrigger;
    thread.lastChangedChapterId = context.chapterId;
    thread.evidenceChapterIds = recentEvidence(
      thread.evidenceChapterIds,
      context.chapterId,
    );
  }
  for (const item of draft.mainlinePatch.threadResolutions) {
    const id = refMap.get(item.threadRef) || item.threadRef;
    const thread = mainline.openThreads[id];
    if (!thread) {
      throw new StoryMemoryError(
        'MEMORY_ENTITY_REFERENCE_INVALID',
        `待解决线索不存在：${item.threadRef}`,
      );
    }
    mainline.recentResolvedThreads.push({
      id,
      title: thread.title,
      resolution: item.resolution,
      openedChapterId: thread.openedChapterId,
      resolvedChapterId: context.chapterId,
    });
    delete mainline.openThreads[id];
  }
  for (const item of draft.mainlinePatch.foreshadowingUpserts) {
    const id =
      item.ref && mainline.foreshadowing[item.ref]
        ? item.ref
        : stableId(
            `foreshadow_${context.projectId}`,
            `${item.setup}|${context.chapterId}`,
          );
    mainline.foreshadowing[id] = {
      id,
      setup: item.setup || mainline.foreshadowing[id]?.setup || '',
      expectedPayoff:
        item.expectedPayoff || mainline.foreshadowing[id]?.expectedPayoff || '',
      status: item.status || mainline.foreshadowing[id]?.status || 'open',
      openedChapterId:
        mainline.foreshadowing[id]?.openedChapterId || context.chapterId,
      lastChangedChapterId: context.chapterId,
      evidenceChapterIds: recentEvidence(
        mainline.foreshadowing[id]?.evidenceChapterIds || [],
        context.chapterId,
      ),
    };
  }
  for (const item of draft.mainlinePatch.timelineAnchors) {
    const id = stableId(
      `time_${context.projectId}`,
      `${item.label}|${context.chapterId}`,
    );
    mainline.timelineAnchors[id] = {
      id,
      label: item.label,
      timeDescription: item.timeDescription,
      event: item.event,
      chapterId: context.chapterId,
      pinned: item.pinned,
    };
  }
  for (const item of draft.mainlinePatch.completedBeats) {
    const id = stableId(
      `beat_${context.projectId}`,
      `${item.summary}|${context.chapterId}`,
    );
    if (!mainline.recentCompletedBeats.some(beat => beat.id === id)) {
      mainline.recentCompletedBeats.push({
        id,
        summary: item.summary,
        chapterId: context.chapterId,
      });
    }
  }

  archiveOverflow(state);
  state.throughChapterId = context.chapterId;
  state.throughChapterPosition = context.chapterPosition;
  state.metadata.status = 'clean';
  state.metadata.dirtyFromPosition = null;
  state.metadata.lastError = '';
  state.metadata.lastAppliedPatchId = patchId;
  state.metadata.updatedAt = context.now || new Date().toISOString();
  state.metadata.stateFingerprint = fingerprintStoryMemoryState(state);
  state.metadata.estimatedTokens = estimateTokens(canonicalStringify(state));

  return {
    state,
    resolvedPatch: {
      patchId,
      schemaVersion: 1,
      projectId: context.projectId,
      chapterId: context.chapterId,
      chapterPosition: context.chapterPosition,
      sourceFingerprint: context.sourceFingerprint,
      baseMemoryFingerprint: baseFingerprint,
      resultMemoryFingerprint: state.metadata.stateFingerprint,
      episodicSummary: draft.episodicSummary,
      normalizedPatch: draft,
      generatedAt: state.metadata.updatedAt,
      appliedAt: state.metadata.updatedAt,
    },
    warnings,
  };
}

function firstQuote(evidence: BatchEvidenceQuote[] | undefined): string {
  return evidence?.[0]?.quote || '';
}

function firstEvidenceChapterId(
  evidence: BatchEvidenceQuote[] | undefined,
  fallback: number,
): number {
  return evidence?.[0]?.chapterId ?? fallback;
}

/** Convert a net-change batch patch into the chapter patch shape for reuse. */
export function batchPatchToChapterDraft(
  draft: StoryMemoryBatchPatchDraft,
  title = '',
): {
  chapterDraft: ChapterMemoryPatchDraft;
  characterSeedChapterIds: Map<string, number>;
} {
  const characterSeedChapterIds = new Map<string, number>();
  for (const item of draft.newCharacters) {
    characterSeedChapterIds.set(
      item.tempRef,
      firstEvidenceChapterId(item.evidence, draft.rangeRef.fromChapterId),
    );
  }
  const combined = draft.chapterSummaries;
  const chapterDraft: ChapterMemoryPatchDraft = {
    schemaVersion: 1,
    chapterRef: {
      chapterId: draft.rangeRef.throughChapterId,
      chapterPosition: draft.rangeRef.throughPosition,
      title,
    },
    episodicSummary: {
      brief: combined.map(item => item.brief).filter(Boolean).join('；'),
      keywords: unique(combined.flatMap(item => item.keywords)),
      events: combined.flatMap(item => item.events),
      characterChanges: combined.flatMap(item => item.characterChanges),
      relationshipChanges: combined.flatMap(item => item.relationshipChanges),
      mainlineChanges: combined.flatMap(item => item.mainlineChanges),
      newThreads: combined.flatMap(item => item.newThreads),
      resolvedThreads: combined.flatMap(item => item.resolvedThreads),
    },
    newCharacters: draft.newCharacters.map(item => ({
      tempRef: item.tempRef,
      canonicalName: item.canonicalName,
      aliases: item.aliases,
      role: item.role,
      identity: item.identity,
      stableTraits: item.stableTraits,
      initialState: item.initialState,
      status: item.status,
      evidenceQuote: firstQuote(item.evidence),
    })),
    characterUpdates: draft.characterUpdates.map(item => ({
      characterRef: item.characterRef,
      addAliases: item.addAliases,
      profileCorrections: item.profileCorrections,
      stateChanges: item.stateChanges,
      status: item.status,
      correctionReason: item.correctionReason,
      addKnowledge: item.addKnowledge,
      removeKnowledge: item.removeKnowledge,
      addPossessions: item.addPossessions,
      removePossessions: item.removePossessions,
      addSecrets: item.addSecrets,
      removeSecrets: item.removeSecrets,
      clearFields: item.clearFields,
      evidenceQuote: firstQuote(item.evidence),
    })),
    newRelationships: draft.newRelationships.map(item => ({
      tempRef: item.tempRef,
      fromRef: item.fromRef,
      toRef: item.toRef,
      direction: item.direction,
      relationType: item.relationType,
      currentState: item.currentState,
      trustLevel: item.trustLevel,
      publicStatus: item.publicStatus,
      hiddenStatus: item.hiddenStatus,
      reason: item.reason,
      evidenceQuote: firstQuote(item.evidence),
    })),
    relationshipUpdates: draft.relationshipUpdates.map(item => ({
      relationshipRef: item.relationshipRef,
      currentState: item.currentState,
      trustLevel: item.trustLevel,
      publicStatus: item.publicStatus,
      hiddenStatus: item.hiddenStatus,
      reason: item.reason,
      evidenceQuote: firstQuote(item.evidence),
    })),
    mainlinePatch: {
      currentArcUpdate: {
        action: draft.mainlinePatch.currentArcUpdate.action,
        arcRef: draft.mainlinePatch.currentArcUpdate.arcRef,
        name: draft.mainlinePatch.currentArcUpdate.name,
        summary: draft.mainlinePatch.currentArcUpdate.summary,
        evidenceQuote: firstQuote(draft.mainlinePatch.currentArcUpdate.evidence),
      },
      currentObjective: draft.mainlinePatch.currentObjective
        ? {
            value: draft.mainlinePatch.currentObjective.value,
            evidenceQuote: firstQuote(
              draft.mainlinePatch.currentObjective.evidence,
            ),
          }
        : undefined,
      conflictUpserts: draft.mainlinePatch.conflictUpserts.map(item => ({
        ...item,
        evidenceQuote: firstQuote(item.evidence),
      })),
      threadOpens: draft.mainlinePatch.threadOpens.map(item => ({
        ...item,
        evidenceQuote: firstQuote(item.evidence),
      })),
      threadUpdates: draft.mainlinePatch.threadUpdates.map(item => ({
        ...item,
        evidenceQuote: firstQuote(item.evidence),
      })),
      threadResolutions: draft.mainlinePatch.threadResolutions.map(item => ({
        threadRef: item.threadRef,
        resolution: item.resolution,
        evidenceQuote: firstQuote(item.evidence),
      })),
      foreshadowingUpserts: draft.mainlinePatch.foreshadowingUpserts.map(
        item => ({
          ...item,
          evidenceQuote: firstQuote(item.evidence),
        }),
      ),
      timelineAnchors: draft.mainlinePatch.timelineAnchors.map(item => ({
        ref: item.ref,
        label: item.label,
        timeDescription: item.timeDescription,
        event: item.event,
        pinned: item.pinned,
        evidenceQuote: firstQuote(item.evidence),
      })),
      completedBeats: draft.mainlinePatch.completedBeats.map(item => ({
        ref: item.ref,
        summary: item.summary,
        evidenceQuote: firstQuote(item.evidence),
      })),
    },
  };
  return { chapterDraft, characterSeedChapterIds };
}

export function applyStoryMemoryBatchPatch(
  previous: StoryMemoryState,
  draft: StoryMemoryBatchPatchDraft,
  context: {
    projectId: number;
    sourceFingerprint: string;
    baseMemoryFingerprint?: string;
    now?: string;
    batchId: string;
    title?: string;
  },
): ApplyBatchPatchResult {
  if (
    draft.rangeRef.throughPosition < previous.throughChapterPosition ||
    (previous.throughChapterPosition >= 0 &&
      draft.rangeRef.fromPosition > previous.throughChapterPosition + 1)
  ) {
    // Allow fromPosition == through+1; reject gaps that skip chapters only
    // when previous already advanced past empty.
  }
  if (draft.rangeRef.throughPosition < previous.throughChapterPosition) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_RANGE_MISMATCH',
      '批次终点早于当前检查点。',
    );
  }
  const { chapterDraft, characterSeedChapterIds } = batchPatchToChapterDraft(
    draft,
    context.title || '',
  );
  const applied = applyStoryMemoryPatch(previous, chapterDraft, {
    projectId: context.projectId,
    chapterId: draft.rangeRef.throughChapterId,
    chapterPosition: draft.rangeRef.throughPosition,
    sourceFingerprint: context.sourceFingerprint,
    baseMemoryFingerprint: context.baseMemoryFingerprint,
    now: context.now,
    characterSeedChapterIds,
    lastAppliedUnitId: context.batchId,
  });
  const resolvedBatch: StoredStoryMemoryBatch = {
    batchId: context.batchId,
    projectId: context.projectId,
    fromChapterId: draft.rangeRef.fromChapterId,
    fromPosition: draft.rangeRef.fromPosition,
    throughChapterId: draft.rangeRef.throughChapterId,
    throughPosition: draft.rangeRef.throughPosition,
    schemaVersion: 2,
    sourceFingerprint: context.sourceFingerprint,
    baseStateFingerprint:
      context.baseMemoryFingerprint ||
      fingerprintStoryMemoryState(previous),
    resultStateFingerprint: applied.state.metadata.stateFingerprint,
    patch: draft,
    chapterSummaries: draft.chapterSummaries,
    estimatedTokens: estimateTokens(canonicalStringify(draft)),
    status: 'applied',
    lastError: '',
    generatedAt: context.now || new Date().toISOString(),
    appliedAt: applied.state.metadata.updatedAt,
  };
  return {
    state: applied.state,
    resolvedBatch,
    warnings: applied.warnings,
  };
}

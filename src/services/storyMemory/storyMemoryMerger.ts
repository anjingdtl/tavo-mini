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
    /**
     * Optional batch temporal maps. When present, firstSeen/opened/lastChanged
     * /resolved timestamps are recovered from each item's Evidence chapters
     * instead of the batch through chapter. Single-chapter patches omit this.
     */
    temporalMaps?: StoryMemoryBatchTemporalMaps;
    /** optional last applied unit id override (batch_*) */
    lastAppliedUnitId?: string;
  },
): ApplyPatchResult {
  const temporal = context.temporalMaps;
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
    const itemTemporal = temporal?.newCharacters.get(item.tempRef);
    if (existing) {
      existing.aliases = unique([
        ...existing.aliases,
        ...item.aliases,
        item.canonicalName === existing.canonicalName ? '' : item.canonicalName,
      ]);
      const mergeChapterId =
        itemTemporal?.lastChapterId ?? context.chapterId;
      existing.lastChangedChapterId = mergeChapterId;
      existing.lastChangedPosition =
        itemTemporal?.lastPosition ?? context.chapterPosition;
      existing.evidenceChapterIds = recentEvidence(
        existing.evidenceChapterIds,
        mergeChapterId,
      );
      refMap.set(item.tempRef, existing.id);
      warnings.push({
        code: 'CHARACTER_ALIAS_MERGED',
        message: `${item.canonicalName} 已合并到现有人物。`,
      });
      continue;
    }
    const seedChapterId =
      context.characterSeedChapterIds?.get(item.tempRef) ??
      itemTemporal?.firstChapterId ??
      context.chapterId;
    const firstPosition =
      itemTemporal?.firstPosition ?? context.chapterPosition;
    const lastChapterId = itemTemporal?.lastChapterId ?? context.chapterId;
    const lastPosition = itemTemporal?.lastPosition ?? context.chapterPosition;
    const evidenceChapterIds =
      itemTemporal?.evidenceChapterIds?.length
        ? itemTemporal.evidenceChapterIds
        : [seedChapterId];
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
      firstSeenPosition: firstPosition,
      lastChangedChapterId: lastChapterId,
      lastChangedPosition: lastPosition,
      evidenceChapterIds,
    };
    refMap.set(item.tempRef, id);
  }

  for (const update of draft.characterUpdates) {
    const character =
      state.characters[update.characterRef] ||
      state.characters[refMap.get(update.characterRef) || ''];
    if (!character) {
      warnings.push({
        code: 'CHARACTER_UPDATE_SKIPPED',
        message: `待更新人物不存在，已跳过：${update.characterRef || '(空)'}`,
      });
      continue;
    }
    const itemTemporal =
      temporal?.characterUpdates.get(update.characterRef) ||
      temporal?.newCharacters.get(update.characterRef);
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
    const lastChapterId = itemTemporal?.lastChapterId ?? context.chapterId;
    const lastPosition = itemTemporal?.lastPosition ?? context.chapterPosition;
    character.lastChangedChapterId = lastChapterId;
    character.lastChangedPosition = lastPosition;
    character.evidenceChapterIds = recentEvidence(
      character.evidenceChapterIds,
      lastChapterId,
    );
  }

  for (const item of draft.newRelationships) {
    let fromId = refMap.get(item.fromRef) || item.fromRef;
    let toId = refMap.get(item.toRef) || item.toRef;
    if (item.direction === 'bidirectional' && fromId > toId) {
      [fromId, toId] = [toId, fromId];
    }
    const itemTemporal = temporal?.newRelationships.get(item.tempRef);
    const seedChapterId = itemTemporal?.firstChapterId ?? context.chapterId;
    const lastChapterId = itemTemporal?.lastChapterId ?? context.chapterId;
    const lastPosition = itemTemporal?.lastPosition ?? context.chapterPosition;
    const evidenceChapterIds =
      itemTemporal?.evidenceChapterIds?.length
        ? itemTemporal.evidenceChapterIds
        : [seedChapterId];
    const relationSeed = `${fromId}|${toId}|${item.direction}|${normalizeName(
      item.relationType,
    )}|${seedChapterId}`;
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
      firstSeenChapterId: seedChapterId,
      lastChangedChapterId: lastChapterId,
      lastChangedPosition: lastPosition,
      evidenceChapterIds,
    };
    refMap.set(item.tempRef, id);
  }

  for (const update of draft.relationshipUpdates) {
    const relationship =
      state.relationships[update.relationshipRef] ||
      state.relationships[refMap.get(update.relationshipRef) || ''];
    if (!relationship) continue;
    const itemTemporal =
      temporal?.relationshipUpdates.get(update.relationshipRef) ||
      temporal?.newRelationships.get(update.relationshipRef);
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
    const lastChapterId = itemTemporal?.lastChapterId ?? context.chapterId;
    const lastPosition = itemTemporal?.lastPosition ?? context.chapterPosition;
    relationship.lastChangedChapterId = lastChapterId;
    relationship.lastChangedPosition = lastPosition;
    relationship.evidenceChapterIds = recentEvidence(
      relationship.evidenceChapterIds,
      lastChapterId,
    );
  }

  const mainline = state.mainline;
  const arc = draft.mainlinePatch.currentArcUpdate;
  const addCompletedBeat = (
    id: string,
    summary: string,
    chapterId = context.chapterId,
  ) => {
    if (!mainline.recentCompletedBeats.some(beat => beat.id === id)) {
      mainline.recentCompletedBeats.push({
        id,
        summary,
        chapterId,
      });
    }
  };
  const arcTemporal = temporal?.currentArc;
  if (arc.action === 'start') {
    const startedChapterId = arcTemporal?.firstChapterId ?? context.chapterId;
    mainline.currentArc = {
      id: stableId(
        `arc_${context.projectId}`,
        `${arc.name}|${startedChapterId}`,
      ),
      name: arc.name,
      summary: arc.summary,
      startedChapterId,
    };
  } else if (arc.action === 'update' && mainline.currentArc) {
    mainline.currentArc.name = arc.name || mainline.currentArc.name;
    mainline.currentArc.summary = arc.summary || mainline.currentArc.summary;
  } else if (arc.action === 'complete') {
    if (mainline.currentArc) {
      addCompletedBeat(
        mainline.currentArc.id,
        arc.summary || mainline.currentArc.summary,
        arcTemporal?.lastChapterId ?? context.chapterId,
      );
    }
    mainline.currentArc = null;
  } else if (arc.action === 'replace' && mainline.currentArc) {
    addCompletedBeat(
      mainline.currentArc.id,
      mainline.currentArc.summary,
      arcTemporal?.lastChapterId ?? context.chapterId,
    );
    const startedChapterId = arcTemporal?.firstChapterId ?? context.chapterId;
    mainline.currentArc = {
      id: stableId(
        `arc_${context.projectId}`,
        `${arc.name}|${startedChapterId}`,
      ),
      name: arc.name,
      summary: arc.summary,
      startedChapterId,
    };
  }
  if (draft.mainlinePatch.currentObjective) {
    mainline.currentObjective =
      draft.mainlinePatch.currentObjective.value.trim();
  }
  for (const item of draft.mainlinePatch.conflictUpserts) {
    const itemTemporal =
      temporal?.conflictUpserts.get(item.ref) ||
      temporal?.conflictUpserts.get(item.title);
    const seedChapterId = itemTemporal?.firstChapterId ?? context.chapterId;
    const lastChapterId = itemTemporal?.lastChapterId ?? context.chapterId;
    const resolvedExistingId =
      (item.ref && mainline.activeConflicts[item.ref] && item.ref) ||
      (item.ref && refMap.get(item.ref) && mainline.activeConflicts[refMap.get(item.ref)!]
        ? refMap.get(item.ref)
        : undefined);
    const id =
      resolvedExistingId ||
      stableId(
        `conflict_${context.projectId}`,
        `${item.title}|${seedChapterId}`,
      );
    const previous = mainline.activeConflicts[id];
    mainline.activeConflicts[id] = {
      id,
      title: item.title,
      parties: unique((item.parties || []).map(ref => refMap.get(ref) || ref)),
      state: item.state || '',
      stakes: item.stakes || '',
      openedChapterId: previous?.openedChapterId || seedChapterId,
      lastChangedChapterId: lastChapterId,
      evidenceChapterIds: recentEvidence(
        previous?.evidenceChapterIds || [],
        lastChapterId,
      ),
    };
    if (item.ref) refMap.set(item.ref, id);
  }
  for (const item of draft.mainlinePatch.conflictResolutions ?? []) {
    const id = refMap.get(item.conflictRef) || item.conflictRef;
    const conflict = mainline.activeConflicts[id];
    if (!conflict) {
      warnings.push({
        code: 'CONFLICT_RESOLVE_SKIPPED',
        message: `待解决冲突不存在，已跳过：${item.conflictRef || '(空)'}`,
      });
      continue;
    }
    const itemTemporal = temporal?.conflictResolutions.get(item.conflictRef);
    const resolveChapterId =
      itemTemporal?.lastChapterId ?? context.chapterId;
    addCompletedBeat(
      stableId(
        `beat_${context.projectId}`,
        `conflict|${conflict.id}|${resolveChapterId}`,
      ),
      `冲突「${conflict.title}」解决：${item.resolution}`,
      resolveChapterId,
    );
    delete mainline.activeConflicts[id];
  }
  for (const item of draft.mainlinePatch.threadOpens) {
    const itemTemporal = temporal?.threadOpens.get(item.ref);
    const seedChapterId = itemTemporal?.firstChapterId ?? context.chapterId;
    const lastChapterId = itemTemporal?.lastChapterId ?? context.chapterId;
    const evidenceChapterIds =
      itemTemporal?.evidenceChapterIds?.length
        ? itemTemporal.evidenceChapterIds
        : [seedChapterId];
    const id = stableId(
      `thread_${context.projectId}`,
      `${item.title}|${seedChapterId}`,
    );
    mainline.openThreads[id] = {
      id,
      title: item.title,
      description: item.description || '',
      ownerCharacterIds: unique(
        (item.ownerCharacterRefs || []).map(ref => refMap.get(ref) || ref),
      ),
      priority: item.priority || 'normal',
      openedChapterId: seedChapterId,
      lastChangedChapterId: lastChapterId,
      deadlineOrTrigger: item.deadlineOrTrigger || '',
      evidenceChapterIds,
    };
    refMap.set(item.ref, id);
  }
  for (const item of draft.mainlinePatch.threadUpdates) {
    const id = refMap.get(item.ref) || item.ref;
    const thread = mainline.openThreads[id];
    if (!thread) {
      // Soft-skip: models often reference empty/unknown thread refs in batch
      // mode. Dropping one thread update must not discard the whole cast batch.
      warnings.push({
        code: 'THREAD_UPDATE_SKIPPED',
        message: `待更新线索不存在，已跳过：${item.ref || '(空)'}`,
      });
      continue;
    }
    const itemTemporal =
      temporal?.threadUpdates.get(item.ref) ||
      temporal?.threadOpens.get(item.ref);
    thread.title = item.title || thread.title;
    thread.description = item.description || thread.description;
    thread.priority = item.priority || thread.priority;
    thread.deadlineOrTrigger =
      item.deadlineOrTrigger || thread.deadlineOrTrigger;
    const lastChapterId = itemTemporal?.lastChapterId ?? context.chapterId;
    thread.lastChangedChapterId = lastChapterId;
    thread.evidenceChapterIds = recentEvidence(
      thread.evidenceChapterIds,
      lastChapterId,
    );
  }
  for (const item of draft.mainlinePatch.threadResolutions) {
    const id = refMap.get(item.threadRef) || item.threadRef;
    const thread = mainline.openThreads[id];
    if (!thread) {
      warnings.push({
        code: 'THREAD_RESOLVE_SKIPPED',
        message: `待解决线索不存在，已跳过：${item.threadRef || '(空)'}`,
      });
      continue;
    }
    const itemTemporal = temporal?.threadResolutions.get(item.threadRef);
    mainline.recentResolvedThreads.push({
      id,
      title: thread.title,
      resolution: item.resolution,
      openedChapterId: thread.openedChapterId,
      resolvedChapterId: itemTemporal?.lastChapterId ?? context.chapterId,
    });
    delete mainline.openThreads[id];
  }
  for (const item of draft.mainlinePatch.foreshadowingUpserts) {
    const itemTemporal =
      temporal?.foreshadowingUpserts.get(item.ref) ||
      temporal?.foreshadowingUpserts.get(item.setup || '');
    const seedChapterId = itemTemporal?.firstChapterId ?? context.chapterId;
    const lastChapterId = itemTemporal?.lastChapterId ?? context.chapterId;
    const id =
      item.ref && mainline.foreshadowing[item.ref]
        ? item.ref
        : item.ref && refMap.get(item.ref) && mainline.foreshadowing[refMap.get(item.ref)!]
          ? refMap.get(item.ref)!
          : stableId(
              `foreshadow_${context.projectId}`,
              `${item.setup}|${seedChapterId}`,
            );
    const existing = mainline.foreshadowing[id];
    const requestedStatus = item.status || existing?.status || 'open';
    mainline.foreshadowing[id] = {
      id,
      setup: item.setup || existing?.setup || '',
      expectedPayoff: item.expectedPayoff || existing?.expectedPayoff || '',
      status:
        existing?.status === 'paid' && requestedStatus !== 'paid'
          ? 'paid'
          : requestedStatus,
      openedChapterId: existing?.openedChapterId || seedChapterId,
      lastChangedChapterId: lastChapterId,
      evidenceChapterIds: recentEvidence(
        existing?.evidenceChapterIds || [],
        lastChapterId,
      ),
    };
    if (item.ref) refMap.set(item.ref, id);
  }
  for (const item of draft.mainlinePatch.timelineAnchors) {
    const itemTemporal =
      temporal?.timelineAnchors.get(item.ref) ||
      temporal?.timelineAnchors.get(item.label);
    const chapterId = itemTemporal?.firstChapterId ?? context.chapterId;
    const id = stableId(
      `time_${context.projectId}`,
      `${item.label}|${chapterId}`,
    );
    mainline.timelineAnchors[id] = {
      id,
      label: item.label,
      timeDescription: item.timeDescription,
      event: item.event,
      chapterId,
      pinned: item.pinned,
    };
  }
  for (const item of draft.mainlinePatch.completedBeats) {
    const itemTemporal =
      temporal?.completedBeats.get(item.ref) ||
      temporal?.completedBeats.get(item.summary);
    const chapterId = itemTemporal?.lastChapterId ?? context.chapterId;
    const id = stableId(
      `beat_${context.projectId}`,
      `${item.summary}|${chapterId}`,
    );
    if (!mainline.recentCompletedBeats.some(beat => beat.id === id)) {
      mainline.recentCompletedBeats.push({
        id,
        summary: item.summary,
        chapterId,
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

/** Local-only temporal window derived from BatchEvidenceQuote chapters. */
export interface StoryMemoryItemTemporal {
  firstChapterId: number;
  firstPosition: number;
  lastChapterId: number;
  lastPosition: number;
  evidenceChapterIds: number[];
}

/**
 * Per-item temporal maps for a single batch apply.
 * Keys are patch refs (tempRef / characterRef / conflictRef / …).
 * Mutation remains one Merger pass; only timestamps are recovered from Evidence.
 */
export interface StoryMemoryBatchTemporalMaps {
  chapterPositionById: Map<number, number>;
  newCharacters: Map<string, StoryMemoryItemTemporal>;
  characterUpdates: Map<string, StoryMemoryItemTemporal>;
  newRelationships: Map<string, StoryMemoryItemTemporal>;
  relationshipUpdates: Map<string, StoryMemoryItemTemporal>;
  conflictUpserts: Map<string, StoryMemoryItemTemporal>;
  conflictResolutions: Map<string, StoryMemoryItemTemporal>;
  threadOpens: Map<string, StoryMemoryItemTemporal>;
  threadUpdates: Map<string, StoryMemoryItemTemporal>;
  threadResolutions: Map<string, StoryMemoryItemTemporal>;
  foreshadowingUpserts: Map<string, StoryMemoryItemTemporal>;
  timelineAnchors: Map<string, StoryMemoryItemTemporal>;
  completedBeats: Map<string, StoryMemoryItemTemporal>;
  currentArc?: StoryMemoryItemTemporal;
}

function buildChapterPositionById(
  draft: StoryMemoryBatchPatchDraft,
): Map<number, number> {
  const map = new Map<number, number>();
  map.set(draft.rangeRef.fromChapterId, draft.rangeRef.fromPosition);
  map.set(draft.rangeRef.throughChapterId, draft.rangeRef.throughPosition);
  for (const summary of draft.chapterSummaries) {
    if (Number.isFinite(summary.chapterId)) {
      map.set(summary.chapterId, summary.chapterPosition);
    }
  }
  return map;
}

function evidenceTemporal(
  evidence: BatchEvidenceQuote[] | undefined,
  fallbackChapterId: number,
  fallbackPosition: number,
  positionById: Map<number, number>,
): StoryMemoryItemTemporal {
  const uniqueIds = [
    ...new Set(
      (evidence || [])
        .map(item => item.chapterId)
        .filter(id => Number.isFinite(id)),
    ),
  ];
  if (uniqueIds.length === 0) {
    return {
      firstChapterId: fallbackChapterId,
      firstPosition: fallbackPosition,
      lastChapterId: fallbackChapterId,
      lastPosition: fallbackPosition,
      evidenceChapterIds: [fallbackChapterId],
    };
  }
  const sorted = [...uniqueIds].sort((left, right) => {
    const leftPos = positionById.get(left);
    const rightPos = positionById.get(right);
    if (leftPos != null && rightPos != null && leftPos !== rightPos) {
      return leftPos - rightPos;
    }
    if (leftPos != null && rightPos == null) return -1;
    if (leftPos == null && rightPos != null) return 1;
    return left - right;
  });
  const firstChapterId = sorted[0];
  const lastChapterId = sorted[sorted.length - 1];
  return {
    firstChapterId,
    firstPosition: positionById.get(firstChapterId) ?? fallbackPosition,
    lastChapterId,
    lastPosition: positionById.get(lastChapterId) ?? fallbackPosition,
    evidenceChapterIds: sorted,
  };
}

function putTemporal(
  map: Map<string, StoryMemoryItemTemporal>,
  key: string,
  temporal: StoryMemoryItemTemporal,
  positionById: Map<number, number>,
): void {
  if (!key) return;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, temporal);
    return;
  }
  const mergedIds = [
    ...new Set([
      ...existing.evidenceChapterIds,
      ...temporal.evidenceChapterIds,
    ]),
  ];
  map.set(
    key,
    evidenceTemporal(
      mergedIds.map(chapterId => ({ chapterId, quote: '' })),
      temporal.firstChapterId,
      temporal.firstPosition,
      positionById,
    ),
  );
}

export function buildStoryMemoryBatchTemporalMaps(
  draft: StoryMemoryBatchPatchDraft,
): StoryMemoryBatchTemporalMaps {
  const chapterPositionById = buildChapterPositionById(draft);
  const fallbackChapterId = draft.rangeRef.throughChapterId;
  const fallbackPosition = draft.rangeRef.throughPosition;
  const maps: StoryMemoryBatchTemporalMaps = {
    chapterPositionById,
    newCharacters: new Map(),
    characterUpdates: new Map(),
    newRelationships: new Map(),
    relationshipUpdates: new Map(),
    conflictUpserts: new Map(),
    conflictResolutions: new Map(),
    threadOpens: new Map(),
    threadUpdates: new Map(),
    threadResolutions: new Map(),
    foreshadowingUpserts: new Map(),
    timelineAnchors: new Map(),
    completedBeats: new Map(),
  };
  const of = (evidence: BatchEvidenceQuote[] | undefined) =>
    evidenceTemporal(
      evidence,
      fallbackChapterId,
      fallbackPosition,
      chapterPositionById,
    );

  for (const item of draft.newCharacters) {
    putTemporal(maps.newCharacters, item.tempRef, of(item.evidence), chapterPositionById);
  }
  for (const item of draft.characterUpdates) {
    putTemporal(
      maps.characterUpdates,
      item.characterRef,
      of(item.evidence),
      chapterPositionById,
    );
  }
  for (const item of draft.newRelationships) {
    putTemporal(
      maps.newRelationships,
      item.tempRef,
      of(item.evidence),
      chapterPositionById,
    );
  }
  for (const item of draft.relationshipUpdates) {
    putTemporal(
      maps.relationshipUpdates,
      item.relationshipRef,
      of(item.evidence),
      chapterPositionById,
    );
  }
  for (const item of draft.mainlinePatch.conflictUpserts) {
    putTemporal(
      maps.conflictUpserts,
      item.ref || item.title,
      of(item.evidence),
      chapterPositionById,
    );
  }
  for (const item of draft.mainlinePatch.conflictResolutions || []) {
    putTemporal(
      maps.conflictResolutions,
      item.conflictRef,
      of(item.evidence),
      chapterPositionById,
    );
  }
  for (const item of draft.mainlinePatch.threadOpens) {
    putTemporal(maps.threadOpens, item.ref, of(item.evidence), chapterPositionById);
  }
  for (const item of draft.mainlinePatch.threadUpdates) {
    putTemporal(
      maps.threadUpdates,
      item.ref,
      of(item.evidence),
      chapterPositionById,
    );
  }
  for (const item of draft.mainlinePatch.threadResolutions) {
    putTemporal(
      maps.threadResolutions,
      item.threadRef,
      of(item.evidence),
      chapterPositionById,
    );
  }
  for (const item of draft.mainlinePatch.foreshadowingUpserts) {
    putTemporal(
      maps.foreshadowingUpserts,
      item.ref || item.setup || '',
      of(item.evidence),
      chapterPositionById,
    );
  }
  for (const item of draft.mainlinePatch.timelineAnchors) {
    putTemporal(
      maps.timelineAnchors,
      item.ref || item.label,
      of(item.evidence),
      chapterPositionById,
    );
  }
  for (const item of draft.mainlinePatch.completedBeats) {
    putTemporal(
      maps.completedBeats,
      item.ref || item.summary,
      of(item.evidence),
      chapterPositionById,
    );
  }
  if (draft.mainlinePatch.currentArcUpdate.action !== 'none') {
    maps.currentArc = of(draft.mainlinePatch.currentArcUpdate.evidence);
  }
  return maps;
}

/** Convert a net-change batch patch into the chapter patch shape for reuse. */
export function batchPatchToChapterDraft(
  draft: StoryMemoryBatchPatchDraft,
  title = '',
): {
  chapterDraft: ChapterMemoryPatchDraft;
  characterSeedChapterIds: Map<string, number>;
  temporalMaps: StoryMemoryBatchTemporalMaps;
} {
  const temporalMaps = buildStoryMemoryBatchTemporalMaps(draft);
  const characterSeedChapterIds = new Map<string, number>();
  for (const item of draft.newCharacters) {
    const temporal = temporalMaps.newCharacters.get(item.tempRef);
    characterSeedChapterIds.set(
      item.tempRef,
      temporal?.firstChapterId ??
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
      brief: combined
        .map(item => item.brief)
        .filter(Boolean)
        .join('；'),
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
      assessment: draft.mainlinePatch.assessment,
      currentArcUpdate: {
        action: draft.mainlinePatch.currentArcUpdate.action,
        arcRef: draft.mainlinePatch.currentArcUpdate.arcRef,
        name: draft.mainlinePatch.currentArcUpdate.name,
        summary: draft.mainlinePatch.currentArcUpdate.summary,
        evidenceQuote: firstQuote(
          draft.mainlinePatch.currentArcUpdate.evidence,
        ),
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
      conflictResolutions: (draft.mainlinePatch.conflictResolutions || []).map(
        item => ({
          conflictRef: item.conflictRef,
          resolution: item.resolution,
          evidenceQuote: firstQuote(item.evidence),
        }),
      ),
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
  return { chapterDraft, characterSeedChapterIds, temporalMaps };
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
  const { chapterDraft, characterSeedChapterIds, temporalMaps } =
    batchPatchToChapterDraft(draft, context.title || '');
  const applied = applyStoryMemoryPatch(previous, chapterDraft, {
    projectId: context.projectId,
    chapterId: draft.rangeRef.throughChapterId,
    chapterPosition: draft.rangeRef.throughPosition,
    sourceFingerprint: context.sourceFingerprint,
    baseMemoryFingerprint: context.baseMemoryFingerprint,
    now: context.now,
    characterSeedChapterIds,
    temporalMaps,
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
      context.baseMemoryFingerprint || fingerprintStoryMemoryState(previous),
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

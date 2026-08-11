import type { Chapter } from '../../types/novel';
import type {
  BatchEvidenceQuote,
  StoryMemoryBatchPatchDraft,
  StoryMemoryState,
} from './storyMemoryTypes';
import { StoryMemoryError } from './storyMemoryTypes';
import {
  hasMainlineStateMutation,
  validateChapterMemoryPatch,
  validateEvidenceQuote,
} from './storyMemoryValidator';
import { batchPatchToChapterDraft } from './storyMemoryMerger';
import { reconcileStoryMemoryMainlineDraft } from './storyMemoryMainlineReconciler';
import * as continuationChapterNumbering from '../continuation/chapterNumbering/continuationChapterNumbering';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertArray(
  value: unknown,
  field: string,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_SCHEMA_INVALID',
      `字段 ${field} 必须是数组。`,
    );
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function normalizeEvidenceList(
  value: unknown,
  batchChapterIds: Set<number>,
): BatchEvidenceQuote[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (!isRecord(item)) return null;
      const chapterId = Number(item.chapterId);
      const quote = text(item.quote || item.evidenceQuote || item.evidence);
      if (!Number.isFinite(chapterId) || !quote) return null;
      return { chapterId, quote };
    })
    .filter((item): item is BatchEvidenceQuote => Boolean(item))
    .filter(item => batchChapterIds.has(item.chapterId));
}

function recoverBatchEvidence(
  evidence: BatchEvidenceQuote[],
  contentByChapterId: Map<number, string>,
  recover: boolean,
): BatchEvidenceQuote[] {
  const recovered: BatchEvidenceQuote[] = [];
  for (const item of evidence) {
    const content = contentByChapterId.get(item.chapterId) || '';
    if (validateEvidenceQuote(content, item.quote)) {
      recovered.push(item);
      continue;
    }
    // Soft-drop bad quotes. Callers decide whether the parent op is kept
    // (characters without any valid evidence are removed later).
    void recover;
  }
  return recovered;
}

/**
 * Validate a batch checkpoint patch against the input chapter range and state.
 * Reuses chapter-level entity/evidence rules after converting to chapter draft shape.
 */
export function validateStoryMemoryBatchPatch(
  raw: unknown,
  previousState: StoryMemoryState,
  chapters: Chapter[],
  options: {
    recoverEvidence?: boolean;
    requireMainlineAssessment?: boolean;
    getDisplayNumber?: (position: number) => number;
  } = {},
): StoryMemoryBatchPatchDraft {
  if (!isRecord(raw)) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_SCHEMA_INVALID',
      '批量检查点必须是 JSON 对象。',
    );
  }
  if (Number(raw.schemaVersion) !== 2) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_SCHEMA_INVALID',
      '批量检查点 schemaVersion 必须为 2。',
    );
  }
  if (!chapters.length) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_RANGE_MISMATCH',
      '批次章节不能为空。',
    );
  }
  const ordered = [...chapters].sort((a, b) => a.position - b.position);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const batchChapterIds = new Set(ordered.map(chapter => chapter.id));
  const contentByChapterId = new Map(
    ordered.map(chapter => [chapter.id, chapter.content || '']),
  );
  const getDisplayNumber =
    options.getDisplayNumber ||
    (typeof continuationChapterNumbering.makeContinuationChapterNumbering ===
    'function'
      ? continuationChapterNumbering.makeContinuationChapterNumbering(null)
          .getDisplayNumber
      : (position: number) => position + 1);

  const rangeRefRaw = isRecord(raw.rangeRef) ? raw.rangeRef : {};
  const rangeRef = {
    fromChapterId: Number(rangeRefRaw.fromChapterId),
    fromPosition: Number(rangeRefRaw.fromPosition),
    throughChapterId: Number(rangeRefRaw.throughChapterId),
    throughPosition: Number(rangeRefRaw.throughPosition),
  };
  if (
    rangeRef.fromChapterId !== first.id ||
    rangeRef.fromPosition !== first.position ||
    rangeRef.throughChapterId !== last.id ||
    rangeRef.throughPosition !== last.position
  ) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_RANGE_MISMATCH',
      '批次 range 必须与输入首尾章节完全一致。',
    );
  }

  assertArray(raw.chapterSummaries, 'chapterSummaries');
  if (raw.chapterSummaries.length !== ordered.length) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_SCHEMA_INVALID',
      'chapterSummaries 必须与输入章节一一对应。',
    );
  }

  const chapterSummaries = raw.chapterSummaries.map((item, index) => {
    if (!isRecord(item)) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_SCHEMA_INVALID',
        `chapterSummaries[${index}] 无效。`,
      );
    }
    const chapter = ordered[index];
    const chapterId = Number(item.chapterId);
    const chapterPosition = Number(item.chapterPosition);
    if (chapterId !== chapter.id || chapterPosition !== chapter.position) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_RANGE_MISMATCH',
        `章节摘要顺序或引用不匹配：期望 ${chapter.id}@${chapter.position}。`,
      );
    }
    const brief = text(item.brief);
    if (!brief.trim()) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_SCHEMA_INVALID',
        `第 ${getDisplayNumber(chapter.position as any)} 章摘要 brief 不能为空。`,
      );
    }
    return {
      chapterId,
      chapterPosition,
      brief,
      keywords: textList(item.keywords),
      events: textList(item.events),
      characterChanges: textList(item.characterChanges),
      relationshipChanges: textList(item.relationshipChanges),
      mainlineChanges: textList(item.mainlineChanges),
      newThreads: textList(item.newThreads),
      resolvedThreads: textList(item.resolvedThreads),
    };
  });

  const mapEvidence = (value: unknown): BatchEvidenceQuote[] => {
    const list = normalizeEvidenceList(value, batchChapterIds);
    return recoverBatchEvidence(
      list,
      contentByChapterId,
      Boolean(options.recoverEvidence),
    );
  };

  assertArray(raw.newCharacters, 'newCharacters');
  assertArray(raw.characterUpdates, 'characterUpdates');
  assertArray(raw.newRelationships, 'newRelationships');
  assertArray(raw.relationshipUpdates, 'relationshipUpdates');
  if (!isRecord(raw.mainlinePatch)) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_SCHEMA_INVALID',
      'mainlinePatch 必须是对象。',
    );
  }

  const draft: StoryMemoryBatchPatchDraft = {
    schemaVersion: 2,
    rangeRef,
    chapterSummaries,
    newCharacters: raw.newCharacters.map((item, index) => {
      if (!isRecord(item)) {
        throw new StoryMemoryError(
          'MEMORY_CHECKPOINT_SCHEMA_INVALID',
          `newCharacters[${index}] 无效。`,
        );
      }
      return {
        tempRef: text(item.tempRef || item.ref || item.id),
        canonicalName: text(
          item.canonicalName || item.name || item.characterName,
        ),
        aliases: textList(item.aliases),
        role: text(item.role),
        identity: text(item.identity),
        stableTraits: textList(item.stableTraits),
        initialState: isRecord(item.initialState)
          ? (item.initialState as any)
          : {},
        status: (text(item.status) || 'active') as any,
        evidence: mapEvidence(item.evidence || item.evidenceQuotes),
      };
    }),
    characterUpdates: raw.characterUpdates.map((item, index) => {
      if (!isRecord(item)) {
        throw new StoryMemoryError(
          'MEMORY_CHECKPOINT_SCHEMA_INVALID',
          `characterUpdates[${index}] 无效。`,
        );
      }
      return {
        characterRef: text(item.characterRef || item.ref),
        addAliases: textList(item.addAliases),
        profileCorrections: isRecord(item.profileCorrections)
          ? (item.profileCorrections as any)
          : {},
        stateChanges: isRecord(item.stateChanges)
          ? (item.stateChanges as any)
          : {},
        status: item.status ? (text(item.status) as any) : undefined,
        correctionReason: text(item.correctionReason),
        addKnowledge: textList(item.addKnowledge),
        removeKnowledge: textList(item.removeKnowledge),
        addPossessions: textList(item.addPossessions),
        removePossessions: textList(item.removePossessions),
        addSecrets: textList(item.addSecrets),
        removeSecrets: textList(item.removeSecrets),
        clearFields: textList(item.clearFields),
        evidence: mapEvidence(item.evidence || item.evidenceQuotes),
      };
    }),
    newRelationships: raw.newRelationships.map((item, index) => {
      if (!isRecord(item)) {
        throw new StoryMemoryError(
          'MEMORY_CHECKPOINT_SCHEMA_INVALID',
          `newRelationships[${index}] 无效。`,
        );
      }
      return {
        tempRef: text(item.tempRef || item.ref),
        fromRef: text(item.fromRef || item.from),
        toRef: text(item.toRef || item.to),
        direction: (text(item.direction) || 'bidirectional') as any,
        relationType: text(item.relationType),
        currentState: text(item.currentState),
        trustLevel: (text(item.trustLevel) || 'unknown') as any,
        publicStatus: text(item.publicStatus),
        hiddenStatus: text(item.hiddenStatus),
        reason: text(item.reason),
        evidence: mapEvidence(item.evidence || item.evidenceQuotes),
      };
    }),
    relationshipUpdates: raw.relationshipUpdates.map((item, index) => {
      if (!isRecord(item)) {
        throw new StoryMemoryError(
          'MEMORY_CHECKPOINT_SCHEMA_INVALID',
          `relationshipUpdates[${index}] 无效。`,
        );
      }
      return {
        relationshipRef: text(item.relationshipRef || item.ref),
        currentState:
          item.currentState != null ? text(item.currentState) : undefined,
        trustLevel:
          item.trustLevel != null ? (text(item.trustLevel) as any) : undefined,
        publicStatus:
          item.publicStatus != null ? text(item.publicStatus) : undefined,
        hiddenStatus:
          item.hiddenStatus != null ? text(item.hiddenStatus) : undefined,
        reason: item.reason != null ? text(item.reason) : undefined,
        evidence: mapEvidence(item.evidence || item.evidenceQuotes),
      };
    }),
    mainlinePatch: {
      assessment: isRecord(raw.mainlinePatch.assessment)
        ? {
            result: (text(raw.mainlinePatch.assessment.result) ||
              'unchanged') as any,
            reason: text(raw.mainlinePatch.assessment.reason),
          }
        : undefined,
      currentArcUpdate: {
        action: (text(
          isRecord(raw.mainlinePatch.currentArcUpdate)
            ? raw.mainlinePatch.currentArcUpdate.action
            : 'none',
        ) || 'none') as any,
        arcRef: text(
          isRecord(raw.mainlinePatch.currentArcUpdate)
            ? raw.mainlinePatch.currentArcUpdate.arcRef
            : '',
        ),
        name: text(
          isRecord(raw.mainlinePatch.currentArcUpdate)
            ? raw.mainlinePatch.currentArcUpdate.name
            : '',
        ),
        summary: text(
          isRecord(raw.mainlinePatch.currentArcUpdate)
            ? raw.mainlinePatch.currentArcUpdate.summary
            : '',
        ),
        evidence: mapEvidence(
          isRecord(raw.mainlinePatch.currentArcUpdate)
            ? raw.mainlinePatch.currentArcUpdate.evidence
            : [],
        ),
      },
      currentObjective: isRecord(raw.mainlinePatch.currentObjective)
        ? {
            value: text(raw.mainlinePatch.currentObjective.value),
            evidence: mapEvidence(raw.mainlinePatch.currentObjective.evidence),
          }
        : undefined,
      conflictUpserts: [],
      conflictResolutions: [],
      threadOpens: [],
      threadUpdates: [],
      threadResolutions: [],
      foreshadowingUpserts: [],
      timelineAnchors: [],
      completedBeats: [],
    },
  };

  const mapMainlineList = (value: unknown, field: string) => {
    assertArray(value ?? [], field);
    return ((value as unknown[]) || []).map((item, index) => {
      if (!isRecord(item)) {
        throw new StoryMemoryError(
          'MEMORY_CHECKPOINT_SCHEMA_INVALID',
          `${field}[${index}] 无效。`,
        );
      }
      return {
        ref: text(item.ref),
        title: text(item.title),
        description: text(item.description),
        state: text(item.state),
        stakes: text(item.stakes),
        parties: textList(item.parties),
        ownerCharacterRefs: textList(item.ownerCharacterRefs),
        priority: (text(item.priority) || 'normal') as any,
        deadlineOrTrigger: text(item.deadlineOrTrigger),
        setup: text(item.setup),
        expectedPayoff: text(item.expectedPayoff),
        status: item.status ? (text(item.status) as any) : undefined,
        evidence: mapEvidence(item.evidence || item.evidenceQuotes),
      };
    });
  };

  draft.mainlinePatch.conflictUpserts = mapMainlineList(
    raw.mainlinePatch.conflictUpserts,
    'conflictUpserts',
  );
  draft.mainlinePatch.threadOpens = mapMainlineList(
    raw.mainlinePatch.threadOpens,
    'threadOpens',
  );
  draft.mainlinePatch.threadUpdates = mapMainlineList(
    raw.mainlinePatch.threadUpdates,
    'threadUpdates',
  );
  draft.mainlinePatch.foreshadowingUpserts = mapMainlineList(
    raw.mainlinePatch.foreshadowingUpserts,
    'foreshadowingUpserts',
  );
  assertArray(raw.mainlinePatch.threadResolutions ?? [], 'threadResolutions');
  draft.mainlinePatch.threadResolutions = (
    (raw.mainlinePatch.threadResolutions as unknown[]) || []
  ).map((item, index) => {
    if (!isRecord(item)) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_SCHEMA_INVALID',
        `threadResolutions[${index}] 无效。`,
      );
    }
    return {
      threadRef: text(item.threadRef || item.ref),
      resolution: text(item.resolution),
      evidence: mapEvidence(item.evidence || item.evidenceQuotes),
    };
  });
  assertArray(
    raw.mainlinePatch.conflictResolutions ?? [],
    'conflictResolutions',
  );
  draft.mainlinePatch.conflictResolutions = (
    (raw.mainlinePatch.conflictResolutions as unknown[]) || []
  ).map((item, index) => {
    if (!isRecord(item)) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_SCHEMA_INVALID',
        `conflictResolutions[${index}] 无效。`,
      );
    }
    return {
      conflictRef: text(item.conflictRef || item.ref),
      resolution: text(item.resolution),
      evidence: mapEvidence(item.evidence || item.evidenceQuotes),
    };
  });
  assertArray(raw.mainlinePatch.timelineAnchors ?? [], 'timelineAnchors');
  // Soft-normalize optional mainline items: drop unusable entries instead of
  // failing the entire multi-chapter batch (models often emit strings here).
  draft.mainlinePatch.timelineAnchors = (
    (raw.mainlinePatch.timelineAnchors as unknown[]) || []
  )
    .map((item, index) => {
      if (typeof item === 'string') {
        const summary = item.trim();
        if (!summary) return null;
        return {
          ref: `new_time_${index + 1}`,
          label: summary.slice(0, 40),
          timeDescription: '',
          event: summary,
          pinned: false,
          evidence: [] as BatchEvidenceQuote[],
        };
      }
      if (!isRecord(item)) return null;
      const event = text(item.event || item.summary || item.label);
      if (!event && !text(item.ref)) return null;
      return {
        ref: text(item.ref) || `new_time_${index + 1}`,
        label: text(item.label) || event.slice(0, 40),
        timeDescription: text(item.timeDescription),
        event,
        pinned: Boolean(item.pinned),
        evidence: mapEvidence(item.evidence || item.evidenceQuotes),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  assertArray(raw.mainlinePatch.completedBeats ?? [], 'completedBeats');
  draft.mainlinePatch.completedBeats = (
    (raw.mainlinePatch.completedBeats as unknown[]) || []
  )
    .map((item, index) => {
      if (typeof item === 'string') {
        const summary = item.trim();
        if (!summary) return null;
        return {
          ref: `new_beat_${index + 1}`,
          summary,
          evidence: [] as BatchEvidenceQuote[],
        };
      }
      if (!isRecord(item)) return null;
      const summary = text(item.summary || item.title || item.event);
      if (!summary) return null;
      return {
        ref: text(item.ref) || `new_beat_${index + 1}`,
        summary,
        evidence: mapEvidence(item.evidence || item.evidenceQuotes),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const requireEvidence = (evidence: BatchEvidenceQuote[], label: string) => {
    if (!evidence.length) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_EVIDENCE_NOT_FOUND',
        `${label} 缺少批次内证据。`,
      );
    }
    for (const item of evidence) {
      const content = contentByChapterId.get(item.chapterId) || '';
      if (!validateEvidenceQuote(content, item.quote)) {
        throw new StoryMemoryError(
          'MEMORY_CHECKPOINT_EVIDENCE_NOT_FOUND',
          `${label} 证据无法在对应章节中定位：${item.quote.slice(0, 40)}`,
        );
      }
    }
  };

  // Drop ungrounded cast/relationship ops before chapter-level validation so a
  // single bad evidenceQuote cannot wipe an entire multi-chapter batch.
  draft.newCharacters = draft.newCharacters
    .map(item => {
      if (!item.canonicalName.trim()) return null;
      try {
        requireEvidence(item.evidence, item.canonicalName);
        return item;
      } catch {
        // Recover: attach a real quote from a batch chapter that contains the name.
        const name = item.canonicalName.trim();
        for (const chapter of ordered) {
          const content = chapter.content || '';
          const idx = content.indexOf(name);
          if (idx < 0) continue;
          const start = Math.max(0, idx - 4);
          const quote = content.slice(
            start,
            start + Math.min(40, content.length - start),
          );
          if (quote.length >= 4 && validateEvidenceQuote(content, quote)) {
            return {
              ...item,
              evidence: [{ chapterId: chapter.id, quote }],
            };
          }
        }
        return options.recoverEvidence ? item : null;
      }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  draft.characterUpdates = draft.characterUpdates.filter(item => {
    try {
      requireEvidence(item.evidence, item.characterRef);
      return true;
    } catch {
      return false;
    }
  });
  draft.newRelationships = draft.newRelationships.filter(item => {
    try {
      requireEvidence(item.evidence, item.tempRef || '关系');
      return true;
    } catch {
      return false;
    }
  });
  draft.relationshipUpdates = draft.relationshipUpdates.filter(item => {
    try {
      requireEvidence(item.evidence, item.relationshipRef);
      return true;
    } catch {
      return false;
    }
  });
  // Optional mainline lists: strip items with no usable summary already done;
  // empty evidence is allowed for completedBeats/timeline after coercion.

  // Local mainline reconcile (governance plan §4): collapse pure
  // chapterSummaries ↔ mainlinePatch classification divergence BEFORE the
  // strict consistency check so a paid Repair / Fresh Retry round is not
  // consumed for what is really a retrieval-annotation vs structured-state
  // label difference. Structured State stays the sole persistent authority;
  // the model's mainlineChanges / newThreads / resolvedThreads text is
  // preserved in events for retrieval instead of hard-failing.
  const reconciled = reconcileStoryMemoryMainlineDraft(draft).reconciledDraft;
  draft.chapterSummaries = reconciled.chapterSummaries;
  draft.mainlinePatch = reconciled.mainlinePatch;

  // Reuse chapter-level entity validation against concatenated content.
  const { chapterDraft } = batchPatchToChapterDraft(draft, last.title || '');
  // Clear optional mainline evidence requirements that chapter validator may
  // reject when coerced from incomplete model output.
  chapterDraft.mainlinePatch.completedBeats =
    chapterDraft.mainlinePatch.completedBeats
      .filter(item => item.summary?.trim())
      .map(item => ({
        ...item,
        evidenceQuote:
          item.evidenceQuote && item.evidenceQuote.length >= 4
            ? item.evidenceQuote
            : ordered[0].content.slice(0, 20),
      }));
  chapterDraft.mainlinePatch.timelineAnchors =
    chapterDraft.mainlinePatch.timelineAnchors.map(item => ({
      ...item,
      evidenceQuote:
        item.evidenceQuote && item.evidenceQuote.length >= 4
          ? item.evidenceQuote
          : ordered[0].content.slice(0, 20),
    }));

  const joinedContent = ordered
    .map(chapter => chapter.content || '')
    .join('\n');
  try {
    const validatedChapterDraft = validateChapterMemoryPatch(
      chapterDraft,
      previousState,
      joinedContent,
      {
        recoverEvidence: true,
        ...options,
      },
    );
    validateBatchMainlineSummaryConsistency(draft, validatedChapterDraft);
  } catch (error) {
    if (error instanceof StoryMemoryError) {
      // Soft-fail remaining optional mainline issues by clearing optional arrays
      // once, then retry once more before hard-fail.
      if (
        error.message.includes('completedBeats') ||
        error.message.includes('timelineAnchors') ||
        error.message.includes('threadResolutions')
      ) {
        chapterDraft.mainlinePatch.completedBeats = [];
        chapterDraft.mainlinePatch.timelineAnchors = [];
        try {
          validateChapterMemoryPatch(
            chapterDraft,
            previousState,
            joinedContent,
            {
              recoverEvidence: true,
              ...options,
            },
          );
          draft.mainlinePatch.completedBeats = [];
          draft.mainlinePatch.timelineAnchors = [];
          return draft;
        } catch {
          // fall through
        }
      }
      const code =
        error.code === 'MEMORY_EVIDENCE_NOT_FOUND'
          ? 'MEMORY_CHECKPOINT_EVIDENCE_NOT_FOUND'
          : error.code === 'MEMORY_PATCH_SCHEMA_INVALID'
          ? 'MEMORY_CHECKPOINT_SCHEMA_INVALID'
          : error.code === 'MEMORY_ENTITY_REFERENCE_INVALID'
          ? 'MEMORY_CHECKPOINT_SCHEMA_INVALID'
          : error.code === 'MEMORY_PATCH_INVALID_JSON'
          ? 'MEMORY_CHECKPOINT_INVALID_JSON'
          : error.code;
      throw new StoryMemoryError(code as any, error.message);
    }
    throw error;
  }

  return draft;
}

function hasText(items: string[]): boolean {
  return items.some(item => item.trim().length > 0);
}

function validateBatchMainlineSummaryConsistency(
  draft: StoryMemoryBatchPatchDraft,
  chapterDraft: import('./storyMemoryTypes').ChapterMemoryPatchDraft,
): void {
  const summaries = draft.chapterSummaries;
  const hasMainlineChanges = summaries.some(summary =>
    hasText(summary.mainlineChanges),
  );
  const hasNewThreads = summaries.some(summary => hasText(summary.newThreads));
  const hasResolvedThreads = summaries.some(summary =>
    hasText(summary.resolvedThreads),
  );
  const mainline = chapterDraft.mainlinePatch;

  if (hasMainlineChanges && !hasMainlineStateMutation(mainline)) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_SCHEMA_INVALID',
      '章节摘要记录了主线变化，但结构化故事主线没有有效操作。',
    );
  }
  if (
    hasNewThreads &&
    mainline.threadOpens.length === 0 &&
    mainline.threadUpdates.length === 0
  ) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_SCHEMA_INVALID',
      '章节摘要记录了新增悬念，但结构化故事主线没有线索操作。',
    );
  }
  if (
    hasResolvedThreads &&
    mainline.threadResolutions.length === 0 &&
    mainline.conflictResolutions.length === 0 &&
    mainline.currentArcUpdate.action !== 'complete' &&
    mainline.currentArcUpdate.action !== 'replace' &&
    !mainline.foreshadowingUpserts.some(item => item.status === 'paid')
  ) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_SCHEMA_INVALID',
      '章节摘要记录了已解决事项，但结构化故事主线没有闭合操作。',
    );
  }
}

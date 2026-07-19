import type { Chapter } from '../../types/novel';
import type {
  BatchEvidenceQuote,
  StoryMemoryBatchPatchDraft,
  StoryMemoryState,
} from './storyMemoryTypes';
import { StoryMemoryError } from './storyMemoryTypes';
import {
  validateChapterMemoryPatch,
  validateEvidenceQuote,
} from './storyMemoryValidator';
import { batchPatchToChapterDraft } from './storyMemoryMerger';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertArray(value: unknown, field: string): asserts value is unknown[] {
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
    if (!recover) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_EVIDENCE_NOT_FOUND',
        `证据不在第 ${item.chapterId} 章正文中：${item.quote.slice(0, 40)}`,
      );
    }
    // Drop unrecoverable evidence lines; chapter-level validation may still fail.
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
  options: { recoverEvidence?: boolean } = {},
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
        `第 ${chapter.position + 1} 章摘要 brief 不能为空。`,
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
        initialState: isRecord(item.initialState) ? (item.initialState as any) : {},
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
        stateChanges: isRecord(item.stateChanges) ? (item.stateChanges as any) : {},
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
        currentState: item.currentState != null ? text(item.currentState) : undefined,
        trustLevel: item.trustLevel != null ? (text(item.trustLevel) as any) : undefined,
        publicStatus: item.publicStatus != null ? text(item.publicStatus) : undefined,
        hiddenStatus: item.hiddenStatus != null ? text(item.hiddenStatus) : undefined,
        reason: item.reason != null ? text(item.reason) : undefined,
        evidence: mapEvidence(item.evidence || item.evidenceQuotes),
      };
    }),
    mainlinePatch: {
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
  assertArray(raw.mainlinePatch.timelineAnchors ?? [], 'timelineAnchors');
  draft.mainlinePatch.timelineAnchors = (
    (raw.mainlinePatch.timelineAnchors as unknown[]) || []
  ).map((item, index) => {
    if (!isRecord(item)) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_SCHEMA_INVALID',
        `timelineAnchors[${index}] 无效。`,
      );
    }
    return {
      ref: text(item.ref),
      label: text(item.label),
      timeDescription: text(item.timeDescription),
      event: text(item.event),
      pinned: Boolean(item.pinned),
      evidence: mapEvidence(item.evidence || item.evidenceQuotes),
    };
  });
  assertArray(raw.mainlinePatch.completedBeats ?? [], 'completedBeats');
  draft.mainlinePatch.completedBeats = (
    (raw.mainlinePatch.completedBeats as unknown[]) || []
  ).map((item, index) => {
    if (!isRecord(item)) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_SCHEMA_INVALID',
        `completedBeats[${index}] 无效。`,
      );
    }
    return {
      ref: text(item.ref),
      summary: text(item.summary),
      evidence: mapEvidence(item.evidence || item.evidenceQuotes),
    };
  });

  // Reuse chapter-level entity/evidence validation against concatenated content.
  const { chapterDraft } = batchPatchToChapterDraft(draft, last.title || '');
  const joinedContent = ordered
    .map(chapter => chapter.content || '')
    .join('\n');
  try {
    validateChapterMemoryPatch(
      chapterDraft,
      previousState,
      joinedContent,
      options,
    );
  } catch (error) {
    if (error instanceof StoryMemoryError) {
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

  // Per-chapter evidence membership already filtered; also reject empty evidence
  // on state-changing ops.
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
  for (const item of draft.newCharacters) {
    if (item.canonicalName.trim()) requireEvidence(item.evidence, item.canonicalName);
  }
  for (const item of draft.characterUpdates) {
    requireEvidence(item.evidence, item.characterRef);
  }
  for (const item of draft.newRelationships) {
    requireEvidence(item.evidence, item.tempRef || '关系');
  }
  for (const item of draft.relationshipUpdates) {
    requireEvidence(item.evidence, item.relationshipRef);
  }

  return draft;
}

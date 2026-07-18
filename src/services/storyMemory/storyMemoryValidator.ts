import type {
  ChapterMemoryPatchDraft,
  StoryMemoryState,
} from './storyMemoryTypes';
import { StoryMemoryError } from './storyMemoryTypes';

function normalizeEvidence(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function validateEvidenceQuote(
  chapterContent: string,
  evidenceQuote: string,
): boolean {
  const quote = normalizeEvidence(evidenceQuote);
  if (quote.length < 4 || quote.length > 80 || !/[\p{L}\p{N}]/u.test(quote)) {
    return false;
  }
  return normalizeEvidence(chapterContent).includes(quote);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertArray(value: unknown, field: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new StoryMemoryError(
      'MEMORY_PATCH_SCHEMA_INVALID',
      `字段 ${field} 必须是数组。`,
    );
  }
}

export function validatePatchShape(
  value: unknown,
): asserts value is ChapterMemoryPatchDraft {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new StoryMemoryError(
      'MEMORY_PATCH_SCHEMA_INVALID',
      '记忆补丁 schemaVersion 无效。',
    );
  }
  if (!isRecord(value.chapterRef) || !isRecord(value.episodicSummary)) {
    throw new StoryMemoryError(
      'MEMORY_PATCH_SCHEMA_INVALID',
      '记忆补丁缺少章节引用或事件摘要。',
    );
  }
  for (const key of [
    'newCharacters',
    'characterUpdates',
    'newRelationships',
    'relationshipUpdates',
  ]) {
    assertArray(value[key], key);
  }
  if (!isRecord(value.mainlinePatch)) {
    throw new StoryMemoryError(
      'MEMORY_PATCH_SCHEMA_INVALID',
      '记忆补丁缺少主线变更。',
    );
  }
  for (const key of [
    'keywords',
    'events',
    'characterChanges',
    'relationshipChanges',
    'mainlineChanges',
    'newThreads',
    'resolvedThreads',
  ]) {
    assertArray(value.episodicSummary[key], `episodicSummary.${key}`);
  }
  for (const key of [
    'conflictUpserts',
    'threadOpens',
    'threadUpdates',
    'threadResolutions',
    'foreshadowingUpserts',
    'timelineAnchors',
    'completedBeats',
  ]) {
    assertArray(value.mainlinePatch[key], `mainlinePatch.${key}`);
  }
}

function collectEvidenceOperations(draft: ChapterMemoryPatchDraft): unknown[] {
  return [
    ...draft.newCharacters,
    ...draft.characterUpdates,
    ...draft.newRelationships,
    ...draft.relationshipUpdates,
    ...(draft.mainlinePatch.currentArcUpdate.action === 'none'
      ? []
      : [draft.mainlinePatch.currentArcUpdate]),
    ...(draft.mainlinePatch.currentObjective
      ? [draft.mainlinePatch.currentObjective]
      : []),
    ...draft.mainlinePatch.conflictUpserts,
    ...draft.mainlinePatch.threadOpens,
    ...draft.mainlinePatch.threadUpdates,
    ...draft.mainlinePatch.threadResolutions,
    ...draft.mainlinePatch.foreshadowingUpserts,
    ...draft.mainlinePatch.timelineAnchors,
    ...draft.mainlinePatch.completedBeats,
  ];
}

export function validatePatchEvidence(
  draft: ChapterMemoryPatchDraft,
  chapterContent: string,
): void {
  for (const operation of collectEvidenceOperations(draft)) {
    const quote = isRecord(operation) ? operation.evidenceQuote : null;
    if (
      typeof quote !== 'string' ||
      !validateEvidenceQuote(chapterContent, quote)
    ) {
      throw new StoryMemoryError(
        'MEMORY_EVIDENCE_NOT_FOUND',
        '记忆补丁包含无法在章节正文中定位的证据。',
      );
    }
  }
}

export function validateEntityReferences(
  draft: ChapterMemoryPatchDraft,
  state: StoryMemoryState,
): void {
  const newCharacterRefs = new Set(draft.newCharacters.map(item => item.tempRef));
  if (
    newCharacterRefs.size !== draft.newCharacters.length ||
    [...newCharacterRefs].some(ref => !/^new_char_[A-Za-z0-9_-]+$/.test(ref))
  ) {
    throw new StoryMemoryError(
      'MEMORY_ENTITY_REFERENCE_INVALID',
      '新人物临时引用无效或重复。',
    );
  }
  for (const update of draft.characterUpdates) {
    if (!state.characters[update.characterRef]) {
      throw new StoryMemoryError(
        'MEMORY_ENTITY_REFERENCE_INVALID',
        `人物引用不存在：${update.characterRef}`,
      );
    }
    if (
      Object.keys(update.profileCorrections || {}).length > 0 &&
      !update.correctionReason?.trim()
    ) {
      throw new StoryMemoryError(
        'MEMORY_PATCH_SCHEMA_INVALID',
        '修正人物固定档案必须提供 correctionReason。',
      );
    }
  }
  const characterRefs = new Set([
    ...Object.keys(state.characters),
    ...newCharacterRefs,
  ]);
  for (const relationship of draft.newRelationships) {
    if (
      !characterRefs.has(relationship.fromRef) ||
      !characterRefs.has(relationship.toRef) ||
      relationship.fromRef === relationship.toRef
    ) {
      throw new StoryMemoryError(
        'MEMORY_ENTITY_REFERENCE_INVALID',
        '关系补丁引用了无效人物或自身关系。',
      );
    }
  }
  for (const update of draft.relationshipUpdates) {
    if (!state.relationships[update.relationshipRef]) {
      throw new StoryMemoryError(
        'MEMORY_ENTITY_REFERENCE_INVALID',
        `关系引用不存在：${update.relationshipRef}`,
      );
    }
  }
  for (const resolution of draft.mainlinePatch.threadResolutions) {
    if (!state.mainline.openThreads[resolution.threadRef]) {
      throw new StoryMemoryError(
        'MEMORY_ENTITY_REFERENCE_INVALID',
        `待解决线索不存在：${resolution.threadRef}`,
      );
    }
  }
}

export function validateChapterMemoryPatch(
  value: unknown,
  state: StoryMemoryState,
  chapterContent: string,
): ChapterMemoryPatchDraft {
  validatePatchShape(value);
  validateEntityReferences(value, state);
  validatePatchEvidence(value, chapterContent);
  return value;
}

import type { Chapter } from '../../types/novel';
import { createEmptyBatchPatch } from './storyMemoryPrompts';
import {
  buildStoryMemoryEntityHandles,
  type StoryMemoryEntityHandleEnvelope,
} from './storyMemoryEntityHandles';
import {
  resolveObservationEvidence,
  type StoryMemoryEvidenceEnvelope,
} from './storyMemoryEvidenceAnchors';
import type {
  StoryMemoryCompiledObservationResult,
  StoryMemoryObservation,
  StoryMemoryObservationChapter,
  StoryMemoryObservationWarning,
} from './storyMemoryObservationTypes';
import type {
  BatchCharacterUpdatePatch,
  BatchEvidenceQuote,
  BatchMainlineEntityPatch,
  BatchNewCharacterPatch,
  BatchNewRelationshipPatch,
  BatchRelationshipUpdatePatch,
  StoryCharacter,
  StoryMemoryBatchPatchDraft,
  StoryMemoryState,
  StoryTrustLevel,
} from './storyMemoryTypes';
import { StoryMemoryError } from './storyMemoryTypes';

interface ObservationEntry {
  chapter: Chapter;
  chapterHandle: string;
  observation: StoryMemoryObservation;
  originalOrder: number;
  evidenceOffset: number;
}

interface AcceptedLocalRef {
  ref: string;
  definedChapterPosition: number;
  definedEvidenceOffset: number;
  kind: 'character' | 'relationship' | 'conflict' | 'thread' | 'foreshadowing';
}

interface RefResolution {
  ref: string | null;
  future: boolean;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

const MAX_PATCH_ITEM_EVIDENCE = 3;

function mergeEvidencePreservingTemporalBoundary(
  chapterPositionById: ReadonlyMap<number, number>,
  ...groups: BatchEvidenceQuote[][]
): BatchEvidenceQuote[] {
  const seen = new Set<string>();
  const merged: BatchEvidenceQuote[] = [];
  groups.flat().forEach(item => {
    const key = `${item.chapterId}\u0000${item.quote}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });

  const chapterGroups = new Map<
    number,
    { items: BatchEvidenceQuote[]; firstIndex: number }
  >();
  merged.forEach((item, index) => {
    const group = chapterGroups.get(item.chapterId);
    if (group) {
      group.items.push(item);
    } else {
      chapterGroups.set(item.chapterId, {
        items: [item],
        firstIndex: index,
      });
    }
  });

  const orderedGroups = [...chapterGroups.entries()].sort(
    ([leftChapterId, leftGroup], [rightChapterId, rightGroup]) => {
      const leftPosition = chapterPositionById.get(leftChapterId);
      const rightPosition = chapterPositionById.get(rightChapterId);
      if (leftPosition != null && rightPosition != null) {
        return leftPosition - rightPosition;
      }
      if (leftPosition != null) return -1;
      if (rightPosition != null) return 1;
      return leftGroup.firstIndex - rightGroup.firstIndex;
    },
  );
  const orderedEvidence = orderedGroups.flatMap(([, group]) => group.items);
  if (orderedEvidence.length <= MAX_PATCH_ITEM_EVIDENCE) {
    return orderedEvidence;
  }

  const selected = new Set<BatchEvidenceQuote>();
  const select = (item: BatchEvidenceQuote | undefined): void => {
    if (item) selected.add(item);
  };

  if (orderedGroups.length === 1) {
    return orderedEvidence.slice(0, MAX_PATCH_ITEM_EVIDENCE);
  }

  // Always reserve the temporal boundary chapters. The extra slot for a
  // two-chapter item prefers the last accepted change from the earliest
  // chapter, matching the deterministic chapter/order retention policy.
  select(orderedGroups[0][1].items[0]);
  select(orderedGroups.at(-1)![1].items.at(-1));
  if (orderedGroups.length === 2) {
    const fillCandidates = [
      ...orderedGroups[0][1].items.slice().reverse(),
      ...orderedGroups[1][1].items,
    ];
    for (const item of fillCandidates) {
      select(item);
      if (selected.size === MAX_PATCH_ITEM_EVIDENCE) break;
    }
  } else {
    const middleIndex = Math.floor((orderedGroups.length - 1) / 2);
    select(orderedGroups[middleIndex][1].items.at(-1));
  }

  return orderedEvidence.filter(item => selected.has(item));
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function safeKey(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  return normalized || fallback;
}

function localRef(prefix: string, key: string, fallback: string): string {
  return `${prefix}${safeKey(key, fallback)}`;
}

function warning(
  code: StoryMemoryObservationWarning['code'],
  message: string,
  entry: ObservationEntry,
): StoryMemoryObservationWarning {
  return {
    code,
    message,
    chapterHandle: entry.chapterHandle,
    observationIndex: entry.originalOrder,
  };
}

function findExistingCharacter(
  state: StoryMemoryState,
  name: string,
  aliases: string[],
): StoryCharacter | null {
  const names = new Set([name, ...aliases].map(normalizeName).filter(Boolean));
  return (
    Object.values(state.characters).find(character =>
      [character.canonicalName, ...character.aliases]
        .map(normalizeName)
        .some(candidate => names.has(candidate)),
    ) || null
  );
}

function trustLevel(value: string | undefined): StoryTrustLevel {
  const allowed: StoryTrustLevel[] = [
    'hostile',
    'low',
    'uncertain',
    'medium',
    'high',
    'absolute',
    'unknown',
  ];
  return allowed.includes(value as StoryTrustLevel)
    ? (value as StoryTrustLevel)
    : 'unknown';
}

function status(value: string | undefined): StoryCharacter['status'] {
  const allowed: StoryCharacter['status'][] = [
    'active',
    'inactive',
    'missing',
    'dead',
    'unknown',
  ];
  return allowed.includes(value as StoryCharacter['status'])
    ? (value as StoryCharacter['status'])
    : 'active';
}

function chapterFallbackBrief(
  chapter: Chapter,
  evidence: StoryMemoryEvidenceEnvelope,
  chapterId: number,
): string {
  const anchor = evidence.anchors.find(item => item.chapterId === chapterId);
  if (anchor) return anchor.text;
  if (chapter.synopsis.trim()) return chapter.synopsis.trim().slice(0, 240);
  return Array.from(chapter.content.trim()).slice(0, 80).join('');
}

function ensureSummary(
  summaries: Map<
    number,
    {
      brief: string;
      keywords: string[];
      events: string[];
      characterChanges: string[];
      relationshipChanges: string[];
      mainlineChanges: string[];
      newThreads: string[];
      resolvedThreads: string[];
    }
  >,
  chapter: Chapter,
  brief: string,
): {
  brief: string;
  keywords: string[];
  events: string[];
  characterChanges: string[];
  relationshipChanges: string[];
  mainlineChanges: string[];
  newThreads: string[];
  resolvedThreads: string[];
} {
  const existing = summaries.get(chapter.id);
  if (existing) {
    if (!existing.brief && brief) existing.brief = brief;
    return existing;
  }
  const created = {
    brief,
    keywords: [],
    events: [],
    characterChanges: [],
    relationshipChanges: [],
    mainlineChanges: [],
    newThreads: [],
    resolvedThreads: [],
  };
  summaries.set(chapter.id, created);
  return created;
}

function addSummaryValue(target: string[], value: string): void {
  const trimmed = value.trim();
  if (trimmed && !target.includes(trimmed)) target.push(trimmed);
}

function refLabel(
  ref: string,
  state: StoryMemoryState,
  handles: StoryMemoryEntityHandleEnvelope,
  characterKeyRefs: ReadonlyMap<string, AcceptedLocalRef>,
): string {
  const characterId =
    characterKeyRefs.get(ref)?.ref || handles.characterByHandle.get(ref) || ref;
  return state.characters[characterId]?.canonicalName || ref;
}

function evidenceFor(
  entry: ObservationEntry,
  envelope: StoryMemoryEvidenceEnvelope,
  warnings: StoryMemoryObservationWarning[],
): BatchEvidenceQuote[] | null {
  if (entry.observation.evidence.length === 0) {
    warnings.push(
      warning(
        'OBS_INVALID_EVIDENCE',
        '状态 observation 缺少 evidence anchor。',
        entry,
      ),
    );
    return null;
  }
  // Same-chapter only: any cross-CH Q invalidates the whole observation.
  const resolved = resolveObservationEvidence(
    entry.observation.evidence,
    envelope,
    entry.chapter.id,
  );
  if (resolved.length === 0) {
    warnings.push(
      warning(
        'OBS_INVALID_EVIDENCE',
        'evidence anchor 不存在或跨章节，已丢弃 observation。',
        entry,
      ),
    );
    return null;
  }
  return resolved;
}

function observationAcceptKey(entry: ObservationEntry): number {
  return entry.originalOrder + entry.chapter.position * 100000;
}

function isDefinitionObservation(observation: StoryMemoryObservation): boolean {
  return (
    observation.kind === 'character_new' ||
    (observation.kind === 'relationship' && observation.op === 'open') ||
    (observation.kind === 'conflict' && observation.op === 'open') ||
    (observation.kind === 'thread' && observation.op === 'open') ||
    (observation.kind === 'foreshadowing' && observation.op === 'open')
  );
}

function definitionSortRank(observation: StoryMemoryObservation): number {
  // Characters first so same-batch N1 can be referenced by later opens.
  if (observation.kind === 'character_new') return 0;
  if (observation.kind === 'relationship') return 1;
  if (observation.kind === 'conflict') return 2;
  if (observation.kind === 'thread') return 3;
  if (observation.kind === 'foreshadowing') return 4;
  return 9;
}

function resolveLocalRef(
  ref: string | undefined,
  handleRefs: ReadonlyMap<string, string>,
  keyRefs: ReadonlyMap<string, AcceptedLocalRef>,
  entry: ObservationEntry,
  definitionCandidates: ReadonlyMap<string, AcceptedLocalRef> = keyRefs,
): RefResolution {
  if (!ref) return { ref: null, future: false };
  const accepted = keyRefs.get(ref);
  if (accepted) {
    const future =
      accepted.definedChapterPosition > entry.chapter.position ||
      (accepted.definedChapterPosition === entry.chapter.position &&
        accepted.definedEvidenceOffset > entry.evidenceOffset);
    return { ref: future ? null : accepted.ref, future };
  }
  const candidate = definitionCandidates.get(ref);
  if (
    candidate &&
    (candidate.definedChapterPosition > entry.chapter.position ||
      (candidate.definedChapterPosition === entry.chapter.position &&
        candidate.definedEvidenceOffset > entry.evidenceOffset))
  ) {
    return { ref: null, future: true };
  }
  return { ref: handleRefs.get(ref) || null, future: false };
}

function resolveCharacterRef(
  ref: string | undefined,
  handles: StoryMemoryEntityHandleEnvelope,
  characterKeyRefs: ReadonlyMap<string, AcceptedLocalRef>,
  entry: ObservationEntry,
  definitionCandidates?: ReadonlyMap<string, AcceptedLocalRef>,
): RefResolution {
  return resolveLocalRef(
    ref,
    handles.characterByHandle,
    characterKeyRefs,
    entry,
    definitionCandidates,
  );
}

function resolveRelationshipRef(
  ref: string | undefined,
  handles: StoryMemoryEntityHandleEnvelope,
  relationshipKeyRefs: ReadonlyMap<string, AcceptedLocalRef>,
  entry: ObservationEntry,
  definitionCandidates?: ReadonlyMap<string, AcceptedLocalRef>,
): RefResolution {
  return resolveLocalRef(
    ref,
    handles.relationshipByHandle,
    relationshipKeyRefs,
    entry,
    definitionCandidates,
  );
}

function resolveConflictRef(
  ref: string | undefined,
  handles: StoryMemoryEntityHandleEnvelope,
  conflictKeyRefs: ReadonlyMap<string, AcceptedLocalRef>,
  entry: ObservationEntry,
  definitionCandidates?: ReadonlyMap<string, AcceptedLocalRef>,
): RefResolution {
  return resolveLocalRef(
    ref,
    handles.conflictByHandle,
    conflictKeyRefs,
    entry,
    definitionCandidates,
  );
}

function resolveThreadRef(
  ref: string | undefined,
  handles: StoryMemoryEntityHandleEnvelope,
  threadKeyRefs: ReadonlyMap<string, AcceptedLocalRef>,
  entry: ObservationEntry,
  definitionCandidates?: ReadonlyMap<string, AcceptedLocalRef>,
): RefResolution {
  return resolveLocalRef(
    ref,
    handles.threadByHandle,
    threadKeyRefs,
    entry,
    definitionCandidates,
  );
}

function resolveForeshadowingRef(
  ref: string | undefined,
  handles: StoryMemoryEntityHandleEnvelope,
  keyRefs: ReadonlyMap<string, AcceptedLocalRef>,
  entry: ObservationEntry,
  definitionCandidates?: ReadonlyMap<string, AcceptedLocalRef>,
): RefResolution {
  return resolveLocalRef(
    ref,
    handles.foreshadowingByHandle,
    keyRefs,
    entry,
    definitionCandidates,
  );
}

function earliestEvidenceOffset(
  observation: StoryMemoryObservation,
  evidence: StoryMemoryEvidenceEnvelope,
): number {
  const offsets = observation.evidence
    .map(id => evidence.byId.get(id)?.startOffset)
    .filter((value): value is number => value != null);
  return offsets.length ? Math.min(...offsets) : Number.MAX_SAFE_INTEGER;
}

function emptyCharacterUpdate(
  characterRef: string,
  evidence: BatchEvidenceQuote[],
): BatchCharacterUpdatePatch {
  return {
    characterRef,
    addAliases: [],
    profileCorrections: {},
    stateChanges: {},
    correctionReason: '',
    addKnowledge: [],
    removeKnowledge: [],
    addPossessions: [],
    removePossessions: [],
    addSecrets: [],
    removeSecrets: [],
    clearFields: [],
    evidence,
  };
}

function emptyMainlineEntity(
  ref: string,
  evidence: BatchEvidenceQuote[],
): BatchMainlineEntityPatch {
  return { ref, title: '', evidence };
}

function statement(
  entry: ObservationEntry,
  state: StoryMemoryState,
  handles: StoryMemoryEntityHandleEnvelope,
  characterKeyRefs: ReadonlyMap<string, AcceptedLocalRef>,
): string {
  const observation = entry.observation;
  const character = (ref?: string) =>
    refLabel(ref || '', state, handles, characterKeyRefs);
  // The intentionally compact statements are local retrieval labels, not
  // another model-authored summary contract.
  switch (observation.kind) {
    case 'character_new':
      return `${observation.name || '新人物'} 出现${
        observation.role ? `，身份为${observation.role}` : ''
      }`;
    case 'character_state':
      return `${character(observation.ref)} 的${observation.field || '状态'}${
        observation.op === 'clear' ? '被清除' : `变为${observation.value || ''}`
      }`;
    case 'character_set':
      return `${character(observation.ref)} ${
        observation.op === 'remove' ? '失去' : '获得'
      }${observation.value || ''}`;
    case 'relationship':
      return observation.op === 'open'
        ? `${character(observation.from)} 与${character(observation.to)}建立${
            observation.type || '关系'
          }`
        : `${character(observation.ref)} 的关系状态更新`;
    case 'arc':
      return `剧情弧${
        observation.op === 'complete'
          ? '完成'
          : observation.op === 'start'
          ? '开始'
          : '更新'
      }${observation.name ? `：${observation.name}` : ''}`;
    case 'objective':
      return `当前目标${
        observation.op === 'clear' ? '清除' : `变为${observation.value || ''}`
      }`;
    case 'conflict':
      return `${
        observation.op === 'resolve'
          ? '冲突解决'
          : observation.op === 'open'
          ? '冲突开启'
          : '冲突更新'
      }${observation.title ? `：${observation.title}` : ''}`;
    case 'thread':
      return `${
        observation.op === 'resolve'
          ? '线索解决'
          : observation.op === 'open'
          ? '线索开启'
          : '线索更新'
      }${observation.title ? `：${observation.title}` : ''}`;
    case 'foreshadowing':
      return `伏笔${
        observation.op === 'resolve'
          ? '回收'
          : observation.op === 'partial'
          ? '部分回收'
          : observation.op === 'open'
          ? '建立'
          : '更新'
      }`;
    case 'timeline':
      return `时间线新增：${observation.label || observation.event || ''}`;
  }
}

function mapPartyRefs(
  refs: string[],
  handles: StoryMemoryEntityHandleEnvelope,
  characterKeyRefs: ReadonlyMap<string, AcceptedLocalRef>,
  entry: ObservationEntry,
  definitionCandidates?: ReadonlyMap<string, AcceptedLocalRef>,
): { refs: string[] | null; future: boolean } {
  const resolutions = refs.map(ref =>
    resolveCharacterRef(
      ref,
      handles,
      characterKeyRefs,
      entry,
      definitionCandidates,
    ),
  );
  if (resolutions.some(item => !item.ref)) {
    return {
      refs: null,
      future: resolutions.some(item => item.future),
    };
  }
  return {
    refs: resolutions.map(item => item.ref) as string[],
    future: false,
  };
}

function mergeStringSet(
  current: string[] | undefined,
  additions: string[],
  removals: string[],
): string[] {
  const removed = new Set(removals.map(normalizeName));
  return unique([...(current || []), ...additions]).filter(
    value => !removed.has(normalizeName(value)),
  );
}

function mergeCharacterUpdateIntoNewPatch(
  chapterPositionById: ReadonlyMap<number, number>,
  character: BatchNewCharacterPatch,
  update: BatchCharacterUpdatePatch,
): void {
  character.aliases = unique([...character.aliases, ...update.addAliases]);
  character.stableTraits = unique([
    ...character.stableTraits,
    ...(update.profileCorrections.stableTraits || []),
  ]);
  character.initialState = {
    ...character.initialState,
    ...update.stateChanges,
  };
  for (const field of update.clearFields) {
    if (field in character.initialState) {
      (character.initialState as Record<string, unknown>)[field] = '';
    }
  }
  character.initialState.knowledge = mergeStringSet(
    character.initialState.knowledge,
    update.addKnowledge,
    update.removeKnowledge,
  );
  character.initialState.possessions = mergeStringSet(
    character.initialState.possessions,
    update.addPossessions,
    update.removePossessions,
  );
  character.initialState.secrets = mergeStringSet(
    character.initialState.secrets,
    update.addSecrets,
    update.removeSecrets,
  );
  if (update.status) character.status = update.status;
  character.evidence = mergeEvidencePreservingTemporalBoundary(
    chapterPositionById,
    character.evidence,
    update.evidence,
  );
}

function registerLocalRef(
  refs: Map<string, AcceptedLocalRef>,
  key: string,
  ref: string,
  entry: ObservationEntry,
  kind: AcceptedLocalRef['kind'],
): void {
  refs.set(key, {
    ref,
    definedChapterPosition: entry.chapter.position,
    definedEvidenceOffset: entry.evidenceOffset,
    kind,
  });
}

function buildEntries(
  normalizedChapters: StoryMemoryObservationChapter[],
  chapters: Chapter[],
  handles: StoryMemoryEntityHandleEnvelope,
  evidence: StoryMemoryEvidenceEnvelope,
): ObservationEntry[] {
  const chaptersByHandle = new Map(
    handles.chapters.map(chapter => [chapter.handle, chapter]),
  );
  const chaptersById = new Map(chapters.map(chapter => [chapter.id, chapter]));
  const entries: ObservationEntry[] = [];
  normalizedChapters.forEach(normalizedChapter => {
    const handle = chaptersByHandle.get(normalizedChapter.chapter);
    const chapter = handle ? chaptersById.get(handle.chapterId) : undefined;
    if (!chapter) return;
    normalizedChapter.observations.forEach((observation, originalOrder) => {
      entries.push({
        chapter,
        chapterHandle: normalizedChapter.chapter,
        observation,
        originalOrder,
        evidenceOffset: earliestEvidenceOffset(observation, evidence),
      });
    });
  });
  return entries;
}

interface AcceptedKeyRefs {
  characterKeyRefs: Map<string, AcceptedLocalRef>;
  relationshipKeyRefs: Map<string, AcceptedLocalRef>;
  conflictKeyRefs: Map<string, AcceptedLocalRef>;
  threadKeyRefs: Map<string, AcceptedLocalRef>;
  foreshadowingKeyRefs: Map<string, AcceptedLocalRef>;
}

function createEmptyKeyRefs(): AcceptedKeyRefs {
  return {
    characterKeyRefs: new Map(),
    relationshipKeyRefs: new Map(),
    conflictKeyRefs: new Map(),
    threadKeyRefs: new Map(),
    foreshadowingKeyRefs: new Map(),
  };
}

export function validateCompiledStoryMemoryBatchPatch(
  patch: StoryMemoryBatchPatchDraft,
  previousState: StoryMemoryState,
  chapters: Chapter[],
  evidence: StoryMemoryEvidenceEnvelope,
): void {
  const ordered = [...chapters].sort(
    (left, right) => left.position - right.position,
  );
  if (
    patch.schemaVersion !== 2 ||
    patch.rangeRef.fromChapterId !== ordered[0]?.id ||
    patch.rangeRef.fromPosition !== ordered[0]?.position ||
    patch.rangeRef.throughChapterId !== ordered.at(-1)?.id ||
    patch.rangeRef.throughPosition !== ordered.at(-1)?.position
  ) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_SCHEMA_INVALID',
      '本地 Observation Compiler 生成了错误的章节范围。',
    );
  }
  if (patch.chapterSummaries.length !== ordered.length) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_SCHEMA_INVALID',
      '本地 Observation Compiler 未覆盖全部章节。',
    );
  }
  const validQuotes = new Set(
    evidence.anchors.map(anchor => `${anchor.chapterId}\u0000${anchor.text}`),
  );
  const checkEvidence = (
    items: Array<{ chapterId: number; quote: string }>,
  ) => {
    if (items.length === 0)
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_SCHEMA_INVALID',
        '本地 Compiler 生成的状态变更缺少 evidence。',
      );
    if (
      items.some(
        item => !validQuotes.has(`${item.chapterId}\u0000${item.quote}`),
      )
    ) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_SCHEMA_INVALID',
        '本地 Compiler 生成了未由 Anchor 解析的 evidence。',
      );
    }
  };
  const charRefs = new Set([
    ...Object.keys(previousState.characters),
    ...patch.newCharacters.map(item => item.tempRef),
  ]);
  if (
    new Set(patch.newCharacters.map(item => item.tempRef)).size !==
    patch.newCharacters.length
  ) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_SCHEMA_INVALID',
      '本地 Compiler 生成了重复人物 tempRef。',
    );
  }
  patch.newCharacters.forEach(item => {
    if (
      !/^new_char_[\p{L}\p{N}_-]+$/u.test(item.tempRef) ||
      !item.canonicalName.trim()
    ) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_SCHEMA_INVALID',
        '本地 Compiler 生成了无效人物引用。',
      );
    }
    checkEvidence(item.evidence);
  });
  patch.characterUpdates.forEach(item => {
    if (!charRefs.has(item.characterRef))
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_SCHEMA_INVALID',
        '本地 Compiler 生成了无效人物更新引用。',
      );
    checkEvidence(item.evidence);
  });
  patch.newRelationships.forEach(item => {
    if (
      !charRefs.has(item.fromRef) ||
      !charRefs.has(item.toRef) ||
      item.fromRef === item.toRef
    ) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_SCHEMA_INVALID',
        '本地 Compiler 生成了无效关系端点。',
      );
    }
    checkEvidence(item.evidence);
  });
  patch.relationshipUpdates.forEach(item => {
    if (!previousState.relationships[item.relationshipRef])
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_SCHEMA_INVALID',
        '本地 Compiler 生成了无效关系更新引用。',
      );
    checkEvidence(item.evidence);
  });
  const conflictRefs = new Set([
    ...Object.keys(previousState.mainline.activeConflicts),
    ...patch.mainlinePatch.conflictUpserts
      .map(item => item.ref)
      .filter(Boolean),
  ]);
  patch.mainlinePatch.conflictResolutions.forEach(item => {
    if (!conflictRefs.has(item.conflictRef)) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_SCHEMA_INVALID',
        '本地 Compiler 生成了无效冲突解决引用。',
      );
    }
  });
  const threadRefs = new Set([
    ...Object.keys(previousState.mainline.openThreads),
    ...patch.mainlinePatch.threadOpens.map(item => item.ref).filter(Boolean),
  ]);
  patch.mainlinePatch.threadUpdates.forEach(item => {
    if (!threadRefs.has(item.ref)) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_SCHEMA_INVALID',
        '本地 Compiler 生成了无效线索更新引用。',
      );
    }
  });
  patch.mainlinePatch.threadResolutions.forEach(item => {
    if (!threadRefs.has(item.threadRef)) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_SCHEMA_INVALID',
        '本地 Compiler 生成了无效线索解决引用。',
      );
    }
  });
  const checkMainlineEvidence = (
    items: Array<{ evidence: BatchEvidenceQuote[] }>,
  ) => items.forEach(item => checkEvidence(item.evidence));
  checkMainlineEvidence([
    ...(patch.mainlinePatch.currentArcUpdate.action === 'none'
      ? []
      : [patch.mainlinePatch.currentArcUpdate]),
    ...(patch.mainlinePatch.currentObjective
      ? [patch.mainlinePatch.currentObjective]
      : []),
    ...patch.mainlinePatch.conflictUpserts,
    ...patch.mainlinePatch.conflictResolutions,
    ...patch.mainlinePatch.threadOpens,
    ...patch.mainlinePatch.threadUpdates,
    ...patch.mainlinePatch.threadResolutions,
    ...patch.mainlinePatch.foreshadowingUpserts,
    ...patch.mainlinePatch.timelineAnchors,
  ]);
  patch.chapterSummaries.forEach((summary, index) => {
    if (
      summary.chapterId !== ordered[index].id ||
      summary.chapterPosition !== ordered[index].position ||
      !summary.brief.trim()
    ) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_SCHEMA_INVALID',
        '本地 Compiler 生成了缺章或空 brief。',
      );
    }
  });
}

export function compileStoryMemoryObservations(input: {
  chapters: Chapter[];
  previousState: StoryMemoryState;
  normalized: StoryMemoryObservationChapter[];
  handles?: StoryMemoryEntityHandleEnvelope;
  evidence: StoryMemoryEvidenceEnvelope;
}): StoryMemoryCompiledObservationResult {
  const ordered = [...input.chapters].sort(
    (left, right) => left.position - right.position,
  );
  const chapterPositionById = new Map(
    ordered.map(chapter => [chapter.id, chapter.position]),
  );
  const handles =
    input.handles ||
    buildStoryMemoryEntityHandles(input.previousState, ordered);
  const entries = buildEntries(
    input.normalized,
    ordered,
    handles,
    input.evidence,
  ).sort((left, right) => {
    const position = left.chapter.position - right.chapter.position;
    if (position !== 0) return position;
    return (
      left.evidenceOffset - right.evidenceOffset ||
      definitionSortRank(left.observation) -
        definitionSortRank(right.observation) ||
      left.originalOrder - right.originalOrder
    );
  });
  const definitionCandidates = createEmptyKeyRefs();
  for (const entry of entries) {
    if (!isDefinitionObservation(entry.observation) || !entry.observation.key) {
      continue;
    }
    if (
      resolveObservationEvidence(
        entry.observation.evidence,
        input.evidence,
        entry.chapter.id,
      ).length === 0
    ) {
      // An ungrounded definition is not a future entity; its dependants should
      // retain the ordinary invalid-evidence/endpoint diagnostics.
      continue;
    }
    const key = entry.observation.key;
    const candidate = {
      ref: '',
      definedChapterPosition: entry.chapter.position,
      definedEvidenceOffset: entry.evidenceOffset,
      kind:
        entry.observation.kind === 'character_new'
          ? 'character'
          : entry.observation.kind,
    } as AcceptedLocalRef;
    const target =
      entry.observation.kind === 'character_new'
        ? definitionCandidates.characterKeyRefs
        : entry.observation.kind === 'relationship'
        ? definitionCandidates.relationshipKeyRefs
        : entry.observation.kind === 'conflict'
        ? definitionCandidates.conflictKeyRefs
        : entry.observation.kind === 'thread'
        ? definitionCandidates.threadKeyRefs
        : definitionCandidates.foreshadowingKeyRefs;
    if (!target.has(key)) target.set(key, candidate);
  }
  const warnings: StoryMemoryObservationWarning[] = [];
  const refs = createEmptyKeyRefs();
  const patch = createEmptyBatchPatch(ordered);
  const summaries = new Map<number, ReturnType<typeof ensureSummary>>();
  for (const chapter of ordered) {
    const source = input.normalized.find(
      item => item.chapter === handles.chapterHandleById.get(chapter.id),
    );
    const brief =
      source?.brief.trim() ||
      chapterFallbackBrief(chapter, input.evidence, chapter.id);
    const summary = ensureSummary(summaries, chapter, brief);
    if (source) {
      // Model brief/events/keywords are retrieval annotations, not state.
      source.events.forEach(event => addSummaryValue(summary.events, event));
      source.keywords.forEach(keyword =>
        addSummaryValue(summary.keywords, keyword),
      );
    }
  }

  const accepted = new Set<number>();
  const evidenceByObservation = new Map<number, BatchEvidenceQuote[]>();
  const newCharactersByRef = new Map<string, BatchNewCharacterPatch>();
  const newRelationshipsByRef = new Map<string, BatchNewRelationshipPatch>();
  const conflictByRef = new Map<string, BatchMainlineEntityPatch>();
  const threadByRef = new Map<string, BatchMainlineEntityPatch>();
  const foreshadowingByRef = new Map<string, BatchMainlineEntityPatch>();
  const newCharacterNames = new Map<string, string>();
  let characterSerial = 0;
  let relationshipSerial = 0;
  let conflictSerial = 0;
  let threadSerial = 0;
  let foreshadowingSerial = 0;

  const acceptObservation = (
    entry: ObservationEntry,
    evidence: BatchEvidenceQuote[],
    semanticBucket:
      | 'events'
      | 'characterChanges'
      | 'relationshipChanges'
      | 'mainlineChanges'
      | 'newThreads'
      | 'resolvedThreads'
      | Array<
          | 'events'
          | 'characterChanges'
          | 'relationshipChanges'
          | 'mainlineChanges'
          | 'newThreads'
          | 'resolvedThreads'
        >,
  ): void => {
    const summary = summaries.get(entry.chapter.id)!;
    const label = statement(
      entry,
      input.previousState,
      handles,
      refs.characterKeyRefs,
    );
    addSummaryValue(summary.events, label);
    const buckets = Array.isArray(semanticBucket)
      ? semanticBucket
      : [semanticBucket];
    for (const bucket of buckets) {
      if (bucket === 'events') continue;
      addSummaryValue(summary[bucket], label);
    }
    const key = observationAcceptKey(entry);
    evidenceByObservation.set(accepted.size, evidence);
    accepted.add(key);
  };

  /**
   * Compile one observation only after Evidence / Ref / Endpoint / Dependency
   * all pass. Summary and accepted stats are written only on success so a
   * rejected observation never pollutes episodic memory.
   */
  const compileOne = (entry: ObservationEntry): boolean => {
    const observation = entry.observation;
    const evidence = evidenceFor(entry, input.evidence, warnings);
    if (!evidence) return false;

    if (observation.kind === 'character_new') {
      const key = observation.key || '';
      if (!key) {
        warnings.push(
          warning(
            'OBS_MISSING_REQUIRED_FIELD',
            'character_new 缺少 key。',
            entry,
          ),
        );
        return false;
      }
      if (!observation.name?.trim()) {
        warnings.push(
          warning(
            'OBS_MISSING_REQUIRED_FIELD',
            'character_new 缺少 name。',
            entry,
          ),
        );
        return false;
      }
      if (refs.characterKeyRefs.has(key)) {
        warnings.push(
          warning('OBS_DUPLICATE', `重复新人物 key：${key}。`, entry),
        );
        return false;
      }
      const existing = findExistingCharacter(
        input.previousState,
        observation.name || '',
        observation.aliases,
      );
      let characterRef: string;
      if (existing) {
        characterRef = existing.id;
        registerLocalRef(
          refs.characterKeyRefs,
          key,
          characterRef,
          entry,
          'character',
        );
        const aliases = unique([
          ...observation.aliases,
          observation.name &&
          normalizeName(observation.name) !==
            normalizeName(existing.canonicalName)
            ? observation.name
            : '',
        ]);
        if (aliases.length) {
          const update = emptyCharacterUpdate(characterRef, evidence);
          update.addAliases = aliases;
          patch.characterUpdates.push(update);
        }
      } else {
        const nameKey = normalizeName(observation.name || '');
        const sameNameRef = newCharacterNames.get(nameKey);
        if (sameNameRef) {
          characterRef = sameNameRef;
          registerLocalRef(
            refs.characterKeyRefs,
            key,
            characterRef,
            entry,
            'character',
          );
          warnings.push(
            warning(
              'OBS_DUPLICATE',
              `同批同名人物已合并：${observation.name || ''}。`,
              entry,
            ),
          );
          const existingPatch = newCharactersByRef.get(characterRef);
          if (existingPatch) {
            existingPatch.aliases = unique([
              ...existingPatch.aliases,
              ...observation.aliases,
            ]);
            existingPatch.evidence = mergeEvidencePreservingTemporalBoundary(
              chapterPositionById,
              existingPatch.evidence,
              evidence,
            );
          }
        } else {
          characterRef = localRef(
            'new_char_obs_',
            key,
            `n${++characterSerial}`,
          );
          newCharacterNames.set(nameKey, characterRef);
          const item: BatchNewCharacterPatch = {
            tempRef: characterRef,
            canonicalName: observation.name || '',
            aliases: unique(observation.aliases),
            role: observation.role || '',
            identity: observation.identity || '',
            stableTraits: unique(observation.stableTraits),
            initialState: observation.initialState,
            status: status(observation.status),
            evidence,
          };
          registerLocalRef(
            refs.characterKeyRefs,
            key,
            characterRef,
            entry,
            'character',
          );
          newCharactersByRef.set(characterRef, item);
          patch.newCharacters.push(item);
        }
      }
      acceptObservation(entry, evidence, 'characterChanges');
      return true;
    }

    if (observation.kind === 'character_state') {
      const resolution = resolveCharacterRef(
        observation.ref,
        handles,
        refs.characterKeyRefs,
        entry,
        definitionCandidates.characterKeyRefs,
      );
      const characterRef = resolution.ref;
      if (!characterRef) {
        warnings.push(
          warning(
            resolution.future ? 'OBS_FUTURE_REF' : 'OBS_INVALID_REF',
            resolution.future
              ? `人物引用早于定义：${observation.ref || '(空)'}`
              : `人物 handle 不存在：${observation.ref || '(空)'}`,
            entry,
          ),
        );
        return false;
      }
      const update = emptyCharacterUpdate(characterRef, evidence);
      if (observation.field === 'status') {
        update.status = status(
          observation.op === 'clear' ? 'unknown' : observation.value,
        );
      } else if (observation.field) {
        if (observation.op === 'clear')
          update.clearFields = [observation.field];
        else {
          update.stateChanges = {
            [observation.field]: observation.value || '',
          } as BatchCharacterUpdatePatch['stateChanges'];
        }
      }
      const newCharacter = newCharactersByRef.get(characterRef);
      if (newCharacter)
        mergeCharacterUpdateIntoNewPatch(
          chapterPositionById,
          newCharacter,
          update,
        );
      else patch.characterUpdates.push(update);
      acceptObservation(entry, evidence, 'characterChanges');
      return true;
    }

    if (observation.kind === 'character_set') {
      const resolution = resolveCharacterRef(
        observation.ref,
        handles,
        refs.characterKeyRefs,
        entry,
        definitionCandidates.characterKeyRefs,
      );
      const characterRef = resolution.ref;
      if (!characterRef) {
        warnings.push(
          warning(
            resolution.future ? 'OBS_FUTURE_REF' : 'OBS_INVALID_REF',
            resolution.future
              ? `人物引用早于定义：${observation.ref || '(空)'}`
              : `人物 handle 不存在：${observation.ref || '(空)'}`,
            entry,
          ),
        );
        return false;
      }
      const update = emptyCharacterUpdate(characterRef, evidence);
      const value = observation.value || '';
      if (observation.field === 'alias') {
        if (observation.op === 'remove') {
          warnings.push(
            warning(
              'OBS_INVALID_FIELD',
              '现有 Batch Patch 没有安全的 remove alias 操作，已局部丢弃。',
              entry,
            ),
          );
          return false;
        }
        update.addAliases = [value];
      } else if (observation.field === 'knowledge') {
        (observation.op === 'remove'
          ? update.removeKnowledge
          : update.addKnowledge
        ).push(value);
      } else if (observation.field === 'possession') {
        (observation.op === 'remove'
          ? update.removePossessions
          : update.addPossessions
        ).push(value);
      } else if (observation.field === 'secret') {
        (observation.op === 'remove'
          ? update.removeSecrets
          : update.addSecrets
        ).push(value);
      }
      const newCharacter = newCharactersByRef.get(characterRef);
      if (newCharacter)
        mergeCharacterUpdateIntoNewPatch(
          chapterPositionById,
          newCharacter,
          update,
        );
      else patch.characterUpdates.push(update);
      acceptObservation(entry, evidence, 'characterChanges');
      return true;
    }

    if (observation.kind === 'relationship') {
      if (observation.op === 'open') {
        const key = observation.key || '';
        if (!key) {
          warnings.push(
            warning(
              'OBS_MISSING_REQUIRED_FIELD',
              'relationship open 缺少 key。',
              entry,
            ),
          );
          return false;
        }
        if (refs.relationshipKeyRefs.has(key)) {
          warnings.push(
            warning('OBS_DUPLICATE', `重复新关系 key：${key}。`, entry),
          );
          return false;
        }
        const fromResolution = resolveCharacterRef(
          observation.from,
          handles,
          refs.characterKeyRefs,
          entry,
          definitionCandidates.characterKeyRefs,
        );
        const toResolution = resolveCharacterRef(
          observation.to,
          handles,
          refs.characterKeyRefs,
          entry,
          definitionCandidates.characterKeyRefs,
        );
        const fromRef = fromResolution.ref;
        const toRef = toResolution.ref;
        if (!fromRef || !toRef || fromRef === toRef) {
          warnings.push(
            warning(
              fromResolution.future || toResolution.future
                ? 'OBS_FUTURE_REF'
                : 'OBS_INVALID_ENDPOINT',
              fromResolution.future || toResolution.future
                ? '关系 endpoint 引用了尚未定义的实体，已局部丢弃。'
                : '关系 endpoint 无法解析，已局部丢弃。',
              entry,
            ),
          );
          return false;
        }
        const tempRef = localRef(
          'new_rel_obs_',
          key,
          `n${++relationshipSerial}`,
        );
        const item: BatchNewRelationshipPatch = {
          tempRef,
          fromRef,
          toRef,
          direction: observation.direction || 'bidirectional',
          relationType: observation.type || '',
          currentState: observation.state || '',
          trustLevel: trustLevel(observation.trustLevel || observation.trust),
          publicStatus: observation.publicStatus || '',
          hiddenStatus: observation.hiddenStatus || '',
          reason: observation.reason || '',
          evidence,
        };
        registerLocalRef(
          refs.relationshipKeyRefs,
          key,
          tempRef,
          entry,
          'relationship',
        );
        newRelationshipsByRef.set(tempRef, item);
        patch.newRelationships.push(item);
        acceptObservation(entry, evidence, 'relationshipChanges');
        return true;
      }
      const resolution = resolveRelationshipRef(
        observation.ref,
        handles,
        refs.relationshipKeyRefs,
        entry,
        definitionCandidates.relationshipKeyRefs,
      );
      const relationshipRef = resolution.ref;
      if (!relationshipRef) {
        warnings.push(
          warning(
            resolution.future ? 'OBS_FUTURE_REF' : 'OBS_INVALID_REF',
            resolution.future
              ? `关系引用早于定义：${observation.ref || '(空)'}`
              : `关系 handle 不存在：${observation.ref || '(空)'}`,
            entry,
          ),
        );
        return false;
      }
      const update: BatchRelationshipUpdatePatch = {
        relationshipRef,
        currentState: observation.state,
        trustLevel:
          observation.trust || observation.trustLevel
            ? trustLevel(observation.trust || observation.trustLevel)
            : undefined,
        publicStatus: observation.publicStatus,
        hiddenStatus: observation.hiddenStatus,
        reason: observation.reason,
        evidence,
      };
      const newRelationship = newRelationshipsByRef.get(relationshipRef);
      if (newRelationship) {
        if (update.currentState !== undefined) {
          newRelationship.currentState = update.currentState;
        }
        if (update.trustLevel !== undefined) {
          newRelationship.trustLevel = update.trustLevel;
        }
        if (update.publicStatus !== undefined) {
          newRelationship.publicStatus = update.publicStatus;
        }
        if (update.hiddenStatus !== undefined) {
          newRelationship.hiddenStatus = update.hiddenStatus;
        }
        if (update.reason !== undefined) newRelationship.reason = update.reason;
        newRelationship.evidence = mergeEvidencePreservingTemporalBoundary(
          chapterPositionById,
          newRelationship.evidence,
          update.evidence,
        );
      } else {
        patch.relationshipUpdates.push(update);
      }
      acceptObservation(entry, evidence, 'relationshipChanges');
      return true;
    }

    if (observation.kind === 'arc') {
      const action = observation.op as
        | 'start'
        | 'update'
        | 'complete'
        | 'replace';
      const currentArc = input.previousState.mainline.currentArc;
      if (
        (action === 'update' ||
          action === 'complete' ||
          action === 'replace') &&
        !currentArc
      ) {
        warnings.push(
          warning(
            'OBS_INVALID_REF',
            '没有当前剧情弧可更新，已局部丢弃。',
            entry,
          ),
        );
        return false;
      }
      if (action === 'start' && currentArc) {
        warnings.push(
          warning(
            'OBS_INVALID_REF',
            '已有当前剧情弧，start 不得覆盖，已局部丢弃。',
            entry,
          ),
        );
        return false;
      }
      patch.mainlinePatch.currentArcUpdate = {
        action,
        arcRef: currentArc ? currentArc.id : '',
        name: observation.name || '',
        summary: observation.summary || '',
        evidence,
      };
      acceptObservation(entry, evidence, 'mainlineChanges');
      return true;
    }

    if (observation.kind === 'objective') {
      patch.mainlinePatch.currentObjective = {
        value: observation.op === 'clear' ? '' : observation.value || '',
        evidence,
      };
      acceptObservation(entry, evidence, 'mainlineChanges');
      return true;
    }

    if (observation.kind === 'conflict') {
      if (observation.op === 'open') {
        const key = observation.key || '';
        if (!key) {
          warnings.push(
            warning(
              'OBS_MISSING_REQUIRED_FIELD',
              'conflict open 缺少 key。',
              entry,
            ),
          );
          return false;
        }
        if (refs.conflictKeyRefs.has(key)) {
          warnings.push(
            warning('OBS_DUPLICATE', `重复新冲突 key：${key}。`, entry),
          );
          return false;
        }
        const partiesResolution = mapPartyRefs(
          observation.parties,
          handles,
          refs.characterKeyRefs,
          entry,
          definitionCandidates.characterKeyRefs,
        );
        const parties = partiesResolution.refs;
        if (parties === null) {
          warnings.push(
            warning(
              partiesResolution.future
                ? 'OBS_FUTURE_REF'
                : 'OBS_INVALID_ENDPOINT',
              partiesResolution.future
                ? '冲突参与者引用了尚未定义的实体，已局部丢弃。'
                : '冲突参与者 handle 不存在，已局部丢弃。',
              entry,
            ),
          );
          return false;
        }
        const ref = localRef('new_conflict_obs_', key, `n${++conflictSerial}`);
        const item = emptyMainlineEntity(ref, evidence);
        item.title = observation.title || '';
        item.state = observation.state || '';
        item.stakes = observation.stakes || '';
        if (parties.length) item.parties = parties;
        registerLocalRef(refs.conflictKeyRefs, key, ref, entry, 'conflict');
        conflictByRef.set(ref, item);
        patch.mainlinePatch.conflictUpserts.push(item);
        acceptObservation(entry, evidence, 'mainlineChanges');
        return true;
      }
      if (observation.op === 'update') {
        const resolution = resolveConflictRef(
          observation.ref,
          handles,
          refs.conflictKeyRefs,
          entry,
          definitionCandidates.conflictKeyRefs,
        );
        const ref = resolution.ref;
        if (!ref) {
          warnings.push(
            warning(
              resolution.future ? 'OBS_FUTURE_REF' : 'OBS_INVALID_REF',
              resolution.future
                ? '冲突引用早于定义，已局部丢弃。'
                : '冲突 handle 不存在，已局部丢弃。',
              entry,
            ),
          );
          return false;
        }
        const partiesResolution = mapPartyRefs(
          observation.parties,
          handles,
          refs.characterKeyRefs,
          entry,
          definitionCandidates.characterKeyRefs,
        );
        const parties = partiesResolution.refs;
        if (parties === null) {
          warnings.push(
            warning(
              partiesResolution.future
                ? 'OBS_FUTURE_REF'
                : 'OBS_INVALID_ENDPOINT',
              partiesResolution.future
                ? '冲突参与者引用了尚未定义的实体，已局部丢弃。'
                : '冲突参与者 handle 不存在，已局部丢弃。',
              entry,
            ),
          );
          return false;
        }
        const item =
          conflictByRef.get(ref) || emptyMainlineEntity(ref, evidence);
        item.title = observation.title || item.title || '';
        item.state = observation.state || item.state || '';
        item.stakes = observation.stakes || item.stakes || '';
        if (parties.length) item.parties = parties;
        item.evidence = mergeEvidencePreservingTemporalBoundary(
          chapterPositionById,
          item.evidence,
          evidence,
        );
        if (!conflictByRef.has(ref)) {
          conflictByRef.set(ref, item);
          patch.mainlinePatch.conflictUpserts.push(item);
        }
        acceptObservation(entry, evidence, 'mainlineChanges');
        return true;
      }
      const resolution = resolveConflictRef(
        observation.ref,
        handles,
        refs.conflictKeyRefs,
        entry,
        definitionCandidates.conflictKeyRefs,
      );
      const ref = resolution.ref;
      if (
        !ref ||
        (!input.previousState.mainline.activeConflicts[ref] &&
          !conflictByRef.has(ref))
      ) {
        warnings.push(
          warning(
            resolution.future ? 'OBS_FUTURE_REF' : 'OBS_INVALID_REF',
            resolution.future
              ? '冲突引用早于定义，已局部丢弃。'
              : '待解决冲突不存在，已局部丢弃。',
            entry,
          ),
        );
        return false;
      }
      patch.mainlinePatch.conflictResolutions.push({
        conflictRef: ref,
        resolution: observation.payoff || observation.state || '',
        evidence,
      });
      acceptObservation(entry, evidence, [
        'mainlineChanges',
        'resolvedThreads',
      ]);
      return true;
    }

    if (observation.kind === 'thread') {
      if (observation.op === 'open') {
        const key = observation.key || '';
        if (!key) {
          warnings.push(
            warning(
              'OBS_MISSING_REQUIRED_FIELD',
              'thread open 缺少 key。',
              entry,
            ),
          );
          return false;
        }
        if (refs.threadKeyRefs.has(key)) {
          warnings.push(
            warning('OBS_DUPLICATE', `重复新线索 key：${key}。`, entry),
          );
          return false;
        }
        const ownersResolution = mapPartyRefs(
          observation.owners,
          handles,
          refs.characterKeyRefs,
          entry,
          definitionCandidates.characterKeyRefs,
        );
        const owners = ownersResolution.refs;
        if (owners === null) {
          warnings.push(
            warning(
              ownersResolution.future
                ? 'OBS_FUTURE_REF'
                : 'OBS_INVALID_ENDPOINT',
              ownersResolution.future
                ? '线索 owner 引用了尚未定义的实体，已局部丢弃。'
                : '线索 owner handle 不存在，已局部丢弃。',
              entry,
            ),
          );
          return false;
        }
        const ref = localRef('new_thread_obs_', key, `n${++threadSerial}`);
        const item = emptyMainlineEntity(ref, evidence);
        item.title = observation.title || '';
        item.description = observation.description || '';
        item.priority = observation.priority || 'normal';
        item.deadlineOrTrigger = observation.deadlineOrTrigger || '';
        if (owners.length) item.ownerCharacterRefs = owners;
        registerLocalRef(refs.threadKeyRefs, key, ref, entry, 'thread');
        threadByRef.set(ref, item);
        patch.mainlinePatch.threadOpens.push(item);
        acceptObservation(entry, evidence, ['mainlineChanges', 'newThreads']);
        return true;
      }
      if (observation.op === 'update') {
        const resolution = resolveThreadRef(
          observation.ref,
          handles,
          refs.threadKeyRefs,
          entry,
          definitionCandidates.threadKeyRefs,
        );
        const ref = resolution.ref;
        if (!ref) {
          warnings.push(
            warning(
              resolution.future ? 'OBS_FUTURE_REF' : 'OBS_INVALID_REF',
              resolution.future
                ? '线索引用早于定义，已局部丢弃。'
                : '线索 handle 不存在，已局部丢弃。',
              entry,
            ),
          );
          return false;
        }
        const ownersResolution = mapPartyRefs(
          observation.owners,
          handles,
          refs.characterKeyRefs,
          entry,
          definitionCandidates.characterKeyRefs,
        );
        const owners = ownersResolution.refs;
        if (owners === null) {
          warnings.push(
            warning(
              ownersResolution.future
                ? 'OBS_FUTURE_REF'
                : 'OBS_INVALID_ENDPOINT',
              ownersResolution.future
                ? '线索 owner 引用了尚未定义的实体，已局部丢弃。'
                : '线索 owner handle 不存在，已局部丢弃。',
              entry,
            ),
          );
          return false;
        }
        const item = threadByRef.get(ref) || emptyMainlineEntity(ref, evidence);
        item.title = observation.title || item.title || '';
        item.description = observation.description || item.description || '';
        item.priority = observation.priority || item.priority || 'normal';
        item.deadlineOrTrigger =
          observation.deadlineOrTrigger || item.deadlineOrTrigger || '';
        if (owners.length) item.ownerCharacterRefs = owners;
        item.evidence = mergeEvidencePreservingTemporalBoundary(
          chapterPositionById,
          item.evidence,
          evidence,
        );
        if (threadByRef.has(ref)) {
          // Same-batch update folds into the open item.
        } else {
          patch.mainlinePatch.threadUpdates.push(item);
        }
        acceptObservation(entry, evidence, 'mainlineChanges');
        return true;
      }
      const resolution = resolveThreadRef(
        observation.ref,
        handles,
        refs.threadKeyRefs,
        entry,
        definitionCandidates.threadKeyRefs,
      );
      const ref = resolution.ref;
      const existing =
        ref &&
        (input.previousState.mainline.openThreads[ref] || threadByRef.has(ref));
      if (!ref || !existing) {
        warnings.push(
          warning(
            resolution.future ? 'OBS_FUTURE_REF' : 'OBS_INVALID_REF',
            resolution.future
              ? '线索引用早于定义，已局部丢弃。'
              : '待解决线索不存在，已局部丢弃。',
            entry,
          ),
        );
        return false;
      }
      patch.mainlinePatch.threadResolutions.push({
        threadRef: ref,
        resolution: observation.payoff || observation.description || '',
        evidence,
      });
      acceptObservation(entry, evidence, [
        'mainlineChanges',
        'resolvedThreads',
      ]);
      return true;
    }

    if (observation.kind === 'foreshadowing') {
      if (observation.op === 'open') {
        const key = observation.key || '';
        if (!key) {
          warnings.push(
            warning(
              'OBS_MISSING_REQUIRED_FIELD',
              'foreshadowing open 缺少 key。',
              entry,
            ),
          );
          return false;
        }
        if (refs.foreshadowingKeyRefs.has(key)) {
          warnings.push(
            warning('OBS_DUPLICATE', `重复新伏笔 key：${key}。`, entry),
          );
          return false;
        }
        const ref = localRef(
          'new_foreshadow_obs_',
          key,
          `n${++foreshadowingSerial}`,
        );
        const item = emptyMainlineEntity(ref, evidence);
        item.setup = observation.setup || '';
        item.expectedPayoff = observation.expectedPayoff || '';
        item.status = 'open';
        registerLocalRef(
          refs.foreshadowingKeyRefs,
          key,
          ref,
          entry,
          'foreshadowing',
        );
        foreshadowingByRef.set(ref, item);
        patch.mainlinePatch.foreshadowingUpserts.push(item);
        acceptObservation(entry, evidence, 'mainlineChanges');
        return true;
      }
      const resolution = resolveForeshadowingRef(
        observation.ref,
        handles,
        refs.foreshadowingKeyRefs,
        entry,
        definitionCandidates.foreshadowingKeyRefs,
      );
      const ref = resolution.ref;
      if (!ref) {
        warnings.push(
          warning(
            resolution.future ? 'OBS_FUTURE_REF' : 'OBS_INVALID_REF',
            resolution.future
              ? '伏笔引用早于定义，已局部丢弃。'
              : '伏笔 handle 不存在，已局部丢弃。',
            entry,
          ),
        );
        return false;
      }
      const existing = foreshadowingByRef.get(ref);
      const item = existing || emptyMainlineEntity(ref, evidence);
      item.setup = observation.setup || item.setup || '';
      item.expectedPayoff =
        observation.expectedPayoff || item.expectedPayoff || '';
      item.status =
        observation.op === 'partial'
          ? 'partially_paid'
          : observation.op === 'resolve'
          ? 'paid'
          : item.status || 'open';
      item.evidence = mergeEvidencePreservingTemporalBoundary(
        chapterPositionById,
        item.evidence,
        evidence,
      );
      if (!existing) {
        foreshadowingByRef.set(ref, item);
        patch.mainlinePatch.foreshadowingUpserts.push(item);
      }
      acceptObservation(entry, evidence, 'mainlineChanges');
      return true;
    }

    if (observation.kind === 'timeline') {
      patch.mainlinePatch.timelineAnchors.push({
        ref: localRef(
          'new_time_obs_',
          `${entry.chapter.position}_${entry.originalOrder}`,
          'time',
        ),
        label: observation.label || observation.event || '',
        timeDescription: observation.time || '',
        event: observation.event || observation.label || '',
        pinned: Boolean(observation.pinned),
        evidence,
      });
      acceptObservation(entry, evidence, 'mainlineChanges');
      return true;
    }

    return false;
  };

  // Register definitions only at their real chapter/evidence position. A
  // global definition pass would make CH01 see an N-key defined in CH02, and
  // would also let an earlier same-chapter reference see a later definition.
  // Equal-offset definitions sort before references so one evidence sentence
  // can introduce an entity and describe its first relationship/state.
  for (const entry of entries) {
    compileOne(entry);
  }

  patch.chapterSummaries = ordered.map(chapter => {
    const summary = summaries.get(chapter.id)!;
    return {
      chapterId: chapter.id,
      chapterPosition: chapter.position,
      brief:
        summary.brief ||
        chapterFallbackBrief(chapter, input.evidence, chapter.id) ||
        '本章正文已处理。',
      keywords: unique(summary.keywords),
      events: unique(summary.events),
      characterChanges: unique(summary.characterChanges),
      relationshipChanges: unique(summary.relationshipChanges),
      mainlineChanges: unique(summary.mainlineChanges),
      newThreads: unique(summary.newThreads),
      resolvedThreads: unique(summary.resolvedThreads),
    };
  });
  const hasMainlineMutation = Boolean(
    patch.mainlinePatch.currentArcUpdate.action !== 'none' ||
      patch.mainlinePatch.currentObjective ||
      patch.mainlinePatch.conflictUpserts.length ||
      patch.mainlinePatch.conflictResolutions.length ||
      patch.mainlinePatch.threadOpens.length ||
      patch.mainlinePatch.threadUpdates.length ||
      patch.mainlinePatch.threadResolutions.length ||
      patch.mainlinePatch.foreshadowingUpserts.length ||
      patch.mainlinePatch.timelineAnchors.length ||
      patch.mainlinePatch.completedBeats.length,
  );
  patch.mainlinePatch.assessment = {
    result: hasMainlineMutation ? 'changed' : 'unchanged',
    reason: hasMainlineMutation
      ? '检测到结构化主线变化。'
      : '本批未形成持续主线状态变化。',
  };
  validateCompiledStoryMemoryBatchPatch(
    patch,
    input.previousState,
    ordered,
    input.evidence,
  );
  const observationsNormalized = entries.length;
  return {
    patch,
    warnings,
    acceptedObservations: accepted.size,
    // Dropped = normalized - accepted (not warning count; one obs may warn twice).
    droppedObservations: Math.max(0, observationsNormalized - accepted.size),
    evidenceByObservation,
  };
}

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
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function mergeEvidence(
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
  return merged.slice(0, 3);
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
  summaries: Map<number, {
    brief: string;
    keywords: string[];
    events: string[];
    characterChanges: string[];
    relationshipChanges: string[];
    mainlineChanges: string[];
    newThreads: string[];
    resolvedThreads: string[];
  }>,
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
  characterKeyRefs: ReadonlyMap<string, string>,
): string {
  const characterId =
    characterKeyRefs.get(ref) || handles.characterByHandle.get(ref) || ref;
  return state.characters[characterId]?.canonicalName || ref;
}

function evidenceFor(
  entry: ObservationEntry,
  envelope: StoryMemoryEvidenceEnvelope,
  warnings: StoryMemoryObservationWarning[],
): BatchEvidenceQuote[] | null {
  if (entry.observation.evidence.length === 0) {
    warnings.push(warning('OBS_INVALID_EVIDENCE', '状态 observation 缺少 evidence anchor。', entry));
    return null;
  }
  const resolved = resolveObservationEvidence(entry.observation.evidence, envelope);
  if (resolved.length === 0) {
    warnings.push(warning('OBS_INVALID_EVIDENCE', 'evidence anchor 不存在，已丢弃 observation。', entry));
    return null;
  }
  return resolved;
}

function resolveCharacterRef(
  ref: string | undefined,
  handles: StoryMemoryEntityHandleEnvelope,
  characterKeyRefs: ReadonlyMap<string, string>,
): string | null {
  if (!ref) return null;
  return characterKeyRefs.get(ref) || handles.characterByHandle.get(ref) || null;
}

function resolveRelationshipRef(
  ref: string | undefined,
  handles: StoryMemoryEntityHandleEnvelope,
): string | null {
  return ref ? handles.relationshipByHandle.get(ref) || null : null;
}

function resolveConflictRef(
  ref: string | undefined,
  handles: StoryMemoryEntityHandleEnvelope,
  conflictKeyRefs: ReadonlyMap<string, string>,
): string | null {
  if (!ref) return null;
  return conflictKeyRefs.get(ref) || handles.conflictByHandle.get(ref) || null;
}

function resolveThreadRef(
  ref: string | undefined,
  handles: StoryMemoryEntityHandleEnvelope,
  threadKeyRefs: ReadonlyMap<string, string>,
): string | null {
  if (!ref) return null;
  return threadKeyRefs.get(ref) || handles.threadByHandle.get(ref) || null;
}

function resolveForeshadowingRef(
  ref: string | undefined,
  handles: StoryMemoryEntityHandleEnvelope,
  keyRefs: ReadonlyMap<string, string>,
): string | null {
  if (!ref) return null;
  return keyRefs.get(ref) || handles.foreshadowingByHandle.get(ref) || null;
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

function emptyCharacterUpdate(characterRef: string, evidence: BatchEvidenceQuote[]): BatchCharacterUpdatePatch {
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

function emptyMainlineEntity(ref: string, evidence: BatchEvidenceQuote[]): BatchMainlineEntityPatch {
  return { ref, title: '', evidence };
}

function statement(
  entry: ObservationEntry,
  state: StoryMemoryState,
  handles: StoryMemoryEntityHandleEnvelope,
  characterKeyRefs: ReadonlyMap<string, string>,
): string {
  const observation = entry.observation;
  const character = (ref?: string) =>
    refLabel(ref || '', state, handles, characterKeyRefs);
  // The intentionally compact statements are local retrieval labels, not
  // another model-authored summary contract.
  switch (observation.kind) {
    case 'character_new':
      return `${observation.name || '新人物'} 出现${observation.role ? `，身份为${observation.role}` : ''}`;
    case 'character_state':
      return `${character(observation.ref)} 的${observation.field || '状态'}${observation.op === 'clear' ? '被清除' : `变为${observation.value || ''}`}`;
    case 'character_set':
      return `${character(observation.ref)} ${observation.op === 'remove' ? '失去' : '获得'}${observation.value || ''}`;
    case 'relationship':
      return observation.op === 'open'
        ? `${character(observation.from)} 与${character(observation.to)}建立${observation.type || '关系'}`
        : `${character(observation.ref)} 的关系状态更新`;
    case 'arc':
      return `剧情弧${observation.op === 'complete' ? '完成' : observation.op === 'start' ? '开始' : '更新'}${observation.name ? `：${observation.name}` : ''}`;
    case 'objective':
      return `当前目标${observation.op === 'clear' ? '清除' : `变为${observation.value || ''}`}`;
    case 'conflict':
      return `${observation.op === 'resolve' ? '冲突解决' : observation.op === 'open' ? '冲突开启' : '冲突更新'}${observation.title ? `：${observation.title}` : ''}`;
    case 'thread':
      return `${observation.op === 'resolve' ? '线索解决' : observation.op === 'open' ? '线索开启' : '线索更新'}${observation.title ? `：${observation.title}` : ''}`;
    case 'foreshadowing':
      return `伏笔${observation.op === 'resolve' ? '回收' : observation.op === 'partial' ? '部分回收' : observation.op === 'open' ? '建立' : '更新'}`;
    case 'timeline':
      return `时间线新增：${observation.label || observation.event || ''}`;
  }
}

function mapPartyRefs(
  refs: string[],
  handles: StoryMemoryEntityHandleEnvelope,
  characterKeyRefs: ReadonlyMap<string, string>,
): string[] | null {
  const mapped = refs.map(ref => resolveCharacterRef(ref, handles, characterKeyRefs));
  if (mapped.some(ref => !ref)) return null;
  return mapped as string[];
}

function buildEntries(
  normalizedChapters: StoryMemoryObservationChapter[],
  chapters: Chapter[],
  handles: StoryMemoryEntityHandleEnvelope,
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
      entries.push({ chapter, chapterHandle: normalizedChapter.chapter, observation, originalOrder });
    });
  });
  return entries;
}

function prepareKeyRefs(
  entries: ObservationEntry[],
  state: StoryMemoryState,
  handles: StoryMemoryEntityHandleEnvelope,
  warnings: StoryMemoryObservationWarning[],
): {
  characterKeyRefs: Map<string, string>;
  relationshipKeyRefs: Map<string, string>;
  conflictKeyRefs: Map<string, string>;
  threadKeyRefs: Map<string, string>;
  foreshadowingKeyRefs: Map<string, string>;
} {
  const characterKeyRefs = new Map<string, string>();
  const relationshipKeyRefs = new Map<string, string>();
  const conflictKeyRefs = new Map<string, string>();
  const threadKeyRefs = new Map<string, string>();
  const foreshadowingKeyRefs = new Map<string, string>();
  const newNames = new Map<string, string>();
  let characterSerial = 0;
  let relationshipSerial = 0;
  let conflictSerial = 0;
  let threadSerial = 0;
  let foreshadowingSerial = 0;

  for (const entry of entries) {
    const observation = entry.observation;
    if (observation.kind === 'character_new' && observation.key) {
      if (characterKeyRefs.has(observation.key)) {
        warnings.push(warning('OBS_DUPLICATE', `重复新人物 key：${observation.key}。`, entry));
        continue;
      }
      const existing = findExistingCharacter(state, observation.name || '', observation.aliases);
      if (existing) {
        characterKeyRefs.set(observation.key, existing.id);
        continue;
      }
      const nameKey = normalizeName(observation.name || '');
      const sameNameRef = newNames.get(nameKey);
      if (sameNameRef) {
        characterKeyRefs.set(observation.key, sameNameRef);
        warnings.push(warning('OBS_DUPLICATE', `同批同名人物已合并：${observation.name || ''}。`, entry));
        continue;
      }
      const ref = localRef('new_char_obs_', observation.key, `n${++characterSerial}`);
      newNames.set(nameKey, ref);
      characterKeyRefs.set(observation.key, ref);
      continue;
    }
    if (observation.kind === 'relationship' && observation.op === 'open' && observation.key) {
      relationshipKeyRefs.set(
        observation.key,
        localRef('new_rel_obs_', observation.key, `n${++relationshipSerial}`),
      );
    }
    if (observation.kind === 'conflict' && observation.op === 'open' && observation.key) {
      conflictKeyRefs.set(
        observation.key,
        localRef('new_conflict_obs_', observation.key, `n${++conflictSerial}`),
      );
    }
    if (observation.kind === 'thread' && observation.op === 'open' && observation.key) {
      threadKeyRefs.set(
        observation.key,
        localRef('new_thread_obs_', observation.key, `n${++threadSerial}`),
      );
    }
    if (observation.kind === 'foreshadowing' && observation.op === 'open' && observation.key) {
      foreshadowingKeyRefs.set(
        observation.key,
        localRef('new_foreshadow_obs_', observation.key, `n${++foreshadowingSerial}`),
      );
    }
  }
  return {
    characterKeyRefs,
    relationshipKeyRefs,
    conflictKeyRefs,
    threadKeyRefs,
    foreshadowingKeyRefs,
  };
}

export function validateCompiledStoryMemoryBatchPatch(
  patch: StoryMemoryBatchPatchDraft,
  previousState: StoryMemoryState,
  chapters: Chapter[],
  evidence: StoryMemoryEvidenceEnvelope,
): void {
  const ordered = [...chapters].sort((left, right) => left.position - right.position);
  if (
    patch.schemaVersion !== 2 ||
    patch.rangeRef.fromChapterId !== ordered[0]?.id ||
    patch.rangeRef.fromPosition !== ordered[0]?.position ||
    patch.rangeRef.throughChapterId !== ordered.at(-1)?.id ||
    patch.rangeRef.throughPosition !== ordered.at(-1)?.position
  ) {
    throw new StoryMemoryError('MEMORY_CHECKPOINT_SCHEMA_INVALID', '本地 Observation Compiler 生成了错误的章节范围。');
  }
  if (patch.chapterSummaries.length !== ordered.length) {
    throw new StoryMemoryError('MEMORY_CHECKPOINT_SCHEMA_INVALID', '本地 Observation Compiler 未覆盖全部章节。');
  }
  const validQuotes = new Set(evidence.anchors.map(anchor => `${anchor.chapterId}\u0000${anchor.text}`));
  const checkEvidence = (items: Array<{ chapterId: number; quote: string }>) => {
    if (items.length === 0) throw new StoryMemoryError('MEMORY_CHECKPOINT_SCHEMA_INVALID', '本地 Compiler 生成的状态变更缺少 evidence。');
    if (items.some(item => !validQuotes.has(`${item.chapterId}\u0000${item.quote}`))) {
      throw new StoryMemoryError('MEMORY_CHECKPOINT_SCHEMA_INVALID', '本地 Compiler 生成了未由 Anchor 解析的 evidence。');
    }
  };
  const charRefs = new Set([...Object.keys(previousState.characters), ...patch.newCharacters.map(item => item.tempRef)]);
  if (new Set(patch.newCharacters.map(item => item.tempRef)).size !== patch.newCharacters.length) {
    throw new StoryMemoryError('MEMORY_CHECKPOINT_SCHEMA_INVALID', '本地 Compiler 生成了重复人物 tempRef。');
  }
  patch.newCharacters.forEach(item => {
    if (!/^new_char_[\p{L}\p{N}_-]+$/u.test(item.tempRef) || !item.canonicalName.trim()) {
      throw new StoryMemoryError('MEMORY_CHECKPOINT_SCHEMA_INVALID', '本地 Compiler 生成了无效人物引用。');
    }
    checkEvidence(item.evidence);
  });
  patch.characterUpdates.forEach(item => {
    if (!charRefs.has(item.characterRef)) throw new StoryMemoryError('MEMORY_CHECKPOINT_SCHEMA_INVALID', '本地 Compiler 生成了无效人物更新引用。');
    checkEvidence(item.evidence);
  });
  patch.newRelationships.forEach(item => {
    if (!charRefs.has(item.fromRef) || !charRefs.has(item.toRef) || item.fromRef === item.toRef) {
      throw new StoryMemoryError('MEMORY_CHECKPOINT_SCHEMA_INVALID', '本地 Compiler 生成了无效关系端点。');
    }
    checkEvidence(item.evidence);
  });
  patch.relationshipUpdates.forEach(item => {
    if (!previousState.relationships[item.relationshipRef]) throw new StoryMemoryError('MEMORY_CHECKPOINT_SCHEMA_INVALID', '本地 Compiler 生成了无效关系更新引用。');
    checkEvidence(item.evidence);
  });
  const checkMainlineEvidence = (items: Array<{ evidence: BatchEvidenceQuote[] }>) => items.forEach(item => checkEvidence(item.evidence));
  checkMainlineEvidence([
    ...(patch.mainlinePatch.currentArcUpdate.action === 'none'
      ? []
      : [patch.mainlinePatch.currentArcUpdate]),
    ...(patch.mainlinePatch.currentObjective ? [patch.mainlinePatch.currentObjective] : []),
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
      throw new StoryMemoryError('MEMORY_CHECKPOINT_SCHEMA_INVALID', '本地 Compiler 生成了缺章或空 brief。');
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
  const ordered = [...input.chapters].sort((left, right) => left.position - right.position);
  const handles = input.handles || buildStoryMemoryEntityHandles(input.previousState, ordered);
  const entries = buildEntries(input.normalized, ordered, handles).sort((left, right) => {
    const position = left.chapter.position - right.chapter.position;
    if (position !== 0) return position;
    const leftOffset = earliestEvidenceOffset(left.observation, input.evidence);
    const rightOffset = earliestEvidenceOffset(right.observation, input.evidence);
    return leftOffset - rightOffset || left.originalOrder - right.originalOrder;
  });
  const warnings: StoryMemoryObservationWarning[] = [];
  const refs = prepareKeyRefs(entries, input.previousState, handles, warnings);
  const patch = createEmptyBatchPatch(ordered);
  const summaries = new Map<number, ReturnType<typeof ensureSummary>>();
  for (const chapter of ordered) {
    const source = input.normalized.find(item => item.chapter === handles.chapterHandleById.get(chapter.id));
    const brief = source?.brief.trim() || chapterFallbackBrief(chapter, input.evidence, chapter.id);
    const summary = ensureSummary(summaries, chapter, brief);
    if (source) {
      source.events.forEach(event => addSummaryValue(summary.events, event));
      source.keywords.forEach(keyword => addSummaryValue(summary.keywords, keyword));
    }
  }

  const accepted = new Set<number>();
  const evidenceByObservation = new Map<number, BatchEvidenceQuote[]>();
  const newCharactersByRef = new Map<string, BatchNewCharacterPatch>();
  const newRelationshipsByRef = new Map<string, BatchNewRelationshipPatch>();
  const conflictByRef = new Map<string, BatchMainlineEntityPatch>();
  const threadByRef = new Map<string, BatchMainlineEntityPatch>();
  const foreshadowingByRef = new Map<string, BatchMainlineEntityPatch>();

  for (const entry of entries) {
    const observation = entry.observation;
    const evidence = evidenceFor(entry, input.evidence, warnings);
    if (!evidence) continue;
    const summary = summaries.get(entry.chapter.id)!;
    const label = statement(entry, input.previousState, handles, refs.characterKeyRefs);
    addSummaryValue(summary.events, label);
    const ordinal = [...accepted].length;
    evidenceByObservation.set(ordinal, evidence);
    accepted.add(entry.originalOrder + entry.chapter.position * 100000);

    if (observation.kind === 'character_new') {
      const characterRef = refs.characterKeyRefs.get(observation.key || '');
      if (!characterRef) continue;
      const existing = input.previousState.characters[characterRef];
      if (existing) {
        const aliases = unique([
          ...observation.aliases,
          observation.name && normalizeName(observation.name) !== normalizeName(existing.canonicalName)
            ? observation.name
            : '',
        ]);
        if (aliases.length) {
          const update = emptyCharacterUpdate(characterRef, evidence);
          update.addAliases = aliases;
          patch.characterUpdates.push(update);
        }
      } else {
        const existingPatch = newCharactersByRef.get(characterRef);
        if (existingPatch) {
          existingPatch.aliases = unique([...existingPatch.aliases, ...observation.aliases]);
          existingPatch.evidence = mergeEvidence(existingPatch.evidence, evidence);
        } else {
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
          newCharactersByRef.set(characterRef, item);
          patch.newCharacters.push(item);
        }
      }
      addSummaryValue(summary.characterChanges, label);
      continue;
    }

    if (observation.kind === 'character_state') {
      const characterRef = resolveCharacterRef(observation.ref, handles, refs.characterKeyRefs);
      if (!characterRef) {
        warnings.push(warning('OBS_INVALID_REF', `人物 handle 不存在：${observation.ref || '(空)'}`, entry));
        continue;
      }
      const update = emptyCharacterUpdate(characterRef, evidence);
      if (observation.field === 'status') {
        update.status = status(observation.op === 'clear' ? 'unknown' : observation.value);
      } else if (observation.field) {
        if (observation.op === 'clear') update.clearFields = [observation.field];
        else update.stateChanges = { [observation.field]: observation.value || '' } as BatchCharacterUpdatePatch['stateChanges'];
      }
      patch.characterUpdates.push(update);
      addSummaryValue(summary.characterChanges, label);
      continue;
    }

    if (observation.kind === 'character_set') {
      const characterRef = resolveCharacterRef(observation.ref, handles, refs.characterKeyRefs);
      if (!characterRef) {
        warnings.push(warning('OBS_INVALID_REF', `人物 handle 不存在：${observation.ref || '(空)'}`, entry));
        continue;
      }
      const update = emptyCharacterUpdate(characterRef, evidence);
      const value = observation.value || '';
      if (observation.field === 'alias') {
        if (observation.op === 'remove') {
          warnings.push(warning('OBS_INVALID_FIELD', '现有 Batch Patch 没有安全的 remove alias 操作，已局部丢弃。', entry));
          continue;
        }
        update.addAliases = [value];
      } else if (observation.field === 'knowledge') {
        (observation.op === 'remove' ? update.removeKnowledge : update.addKnowledge).push(value);
      } else if (observation.field === 'possession') {
        (observation.op === 'remove' ? update.removePossessions : update.addPossessions).push(value);
      } else if (observation.field === 'secret') {
        (observation.op === 'remove' ? update.removeSecrets : update.addSecrets).push(value);
      }
      patch.characterUpdates.push(update);
      addSummaryValue(summary.characterChanges, label);
      continue;
    }

    if (observation.kind === 'relationship') {
      if (observation.op === 'open') {
        const fromRef = resolveCharacterRef(observation.from, handles, refs.characterKeyRefs);
        const toRef = resolveCharacterRef(observation.to, handles, refs.characterKeyRefs);
        if (!fromRef || !toRef || fromRef === toRef) {
          warnings.push(warning('OBS_INVALID_ENDPOINT', '关系 endpoint 无法解析，已局部丢弃。', entry));
          continue;
        }
        const tempRef = refs.relationshipKeyRefs.get(observation.key || '');
        if (!tempRef) continue;
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
        const previous = newRelationshipsByRef.get(tempRef);
        if (previous) {
          previous.currentState = item.currentState || previous.currentState;
          previous.evidence = mergeEvidence(previous.evidence, evidence);
        } else {
          newRelationshipsByRef.set(tempRef, item);
          patch.newRelationships.push(item);
        }
      } else {
        const relationshipRef = resolveRelationshipRef(observation.ref, handles);
        if (!relationshipRef) {
          warnings.push(warning('OBS_INVALID_REF', `关系 handle 不存在：${observation.ref || '(空)'}`, entry));
          continue;
        }
        const update: BatchRelationshipUpdatePatch = {
          relationshipRef,
          currentState: observation.state,
          trustLevel: observation.trust || observation.trustLevel ? trustLevel(observation.trust || observation.trustLevel) : undefined,
          publicStatus: observation.publicStatus,
          hiddenStatus: observation.hiddenStatus,
          reason: observation.reason,
          evidence,
        };
        patch.relationshipUpdates.push(update);
      }
      addSummaryValue(summary.relationshipChanges, label);
      continue;
    }

    if (observation.kind === 'arc') {
      const action = observation.op as 'start' | 'update' | 'complete' | 'replace';
      const currentArc = input.previousState.mainline.currentArc;
      if ((action === 'update' || action === 'complete' || action === 'replace') && !currentArc) {
        warnings.push(warning('OBS_INVALID_REF', '没有当前剧情弧可更新，已局部丢弃。', entry));
        continue;
      }
      if (action === 'start' && currentArc) {
        warnings.push(warning('OBS_INVALID_REF', '已有当前剧情弧，start 不得覆盖，已局部丢弃。', entry));
        continue;
      }
      patch.mainlinePatch.currentArcUpdate = {
        action,
        arcRef: currentArc ? currentArc.id : '',
        name: observation.name || '',
        summary: observation.summary || '',
        evidence,
      };
      addSummaryValue(summary.mainlineChanges, label);
      continue;
    }

    if (observation.kind === 'objective') {
      patch.mainlinePatch.currentObjective = {
        value: observation.op === 'clear' ? '' : observation.value || '',
        evidence,
      };
      addSummaryValue(summary.mainlineChanges, label);
      continue;
    }

    if (observation.kind === 'conflict') {
      if (observation.op === 'open' || observation.op === 'update') {
        const ref = observation.op === 'open'
          ? refs.conflictKeyRefs.get(observation.key || '')
          : resolveConflictRef(observation.ref, handles, refs.conflictKeyRefs);
        if (!ref) {
          warnings.push(warning('OBS_INVALID_REF', '冲突 handle 不存在，已局部丢弃。', entry));
          continue;
        }
        const parties = mapPartyRefs(observation.parties, handles, refs.characterKeyRefs);
        if (parties === null) {
          warnings.push(warning('OBS_INVALID_ENDPOINT', '冲突参与者 handle 不存在，已局部丢弃。', entry));
          continue;
        }
        const item = conflictByRef.get(ref) || emptyMainlineEntity(ref, evidence);
        item.title = observation.title || item.title || '';
        item.state = observation.state || item.state || '';
        item.stakes = observation.stakes || item.stakes || '';
        if (parties.length) item.parties = parties;
        item.evidence = mergeEvidence(item.evidence, evidence);
        if (!conflictByRef.has(ref)) {
          conflictByRef.set(ref, item);
          patch.mainlinePatch.conflictUpserts.push(item);
        }
      } else {
        const ref = resolveConflictRef(observation.ref, handles, refs.conflictKeyRefs);
        if (!ref || !input.previousState.mainline.activeConflicts[ref]) {
          warnings.push(warning('OBS_INVALID_REF', '待解决冲突不存在，已局部丢弃。', entry));
          continue;
        }
        patch.mainlinePatch.conflictResolutions.push({ conflictRef: ref, resolution: observation.payoff || observation.state || '', evidence });
        addSummaryValue(summary.resolvedThreads, label);
      }
      addSummaryValue(summary.mainlineChanges, label);
      continue;
    }

    if (observation.kind === 'thread') {
      if (observation.op === 'open' || observation.op === 'update') {
        const ref = observation.op === 'open'
          ? refs.threadKeyRefs.get(observation.key || '')
          : resolveThreadRef(observation.ref, handles, refs.threadKeyRefs);
        if (!ref) {
          warnings.push(warning('OBS_INVALID_REF', '线索 handle 不存在，已局部丢弃。', entry));
          continue;
        }
        const owners = mapPartyRefs(observation.owners, handles, refs.characterKeyRefs);
        if (owners === null) {
          warnings.push(warning('OBS_INVALID_ENDPOINT', '线索 owner handle 不存在，已局部丢弃。', entry));
          continue;
        }
        const item = threadByRef.get(ref) || emptyMainlineEntity(ref, evidence);
        item.title = observation.title || item.title || '';
        item.description = observation.description || item.description || '';
        item.priority = observation.priority || item.priority || 'normal';
        item.deadlineOrTrigger = observation.deadlineOrTrigger || item.deadlineOrTrigger || '';
        if (owners.length) item.ownerCharacterRefs = owners;
        item.evidence = mergeEvidence(item.evidence, evidence);
        if (observation.op === 'open') {
          if (!threadByRef.has(ref)) {
            threadByRef.set(ref, item);
            patch.mainlinePatch.threadOpens.push(item);
          }
          addSummaryValue(summary.newThreads, label);
        } else if (threadByRef.has(ref)) {
          // A same-batch update is folded into its open item so the existing
          // merger can resolve the local temp ref in one deterministic pass.
        } else {
          patch.mainlinePatch.threadUpdates.push(item);
        }
      } else {
        const ref = resolveThreadRef(observation.ref, handles, refs.threadKeyRefs);
        const existing = ref && (input.previousState.mainline.openThreads[ref] || threadByRef.has(ref));
        if (!ref || !existing) {
          warnings.push(warning('OBS_INVALID_REF', '待解决线索不存在，已局部丢弃。', entry));
          continue;
        }
        patch.mainlinePatch.threadResolutions.push({ threadRef: ref, resolution: observation.payoff || observation.description || '', evidence });
        addSummaryValue(summary.resolvedThreads, label);
      }
      addSummaryValue(summary.mainlineChanges, label);
      continue;
    }

    if (observation.kind === 'foreshadowing') {
      const ref = observation.op === 'open'
        ? refs.foreshadowingKeyRefs.get(observation.key || '')
        : resolveForeshadowingRef(observation.ref, handles, refs.foreshadowingKeyRefs);
      if (!ref) {
        warnings.push(warning('OBS_INVALID_REF', '伏笔 handle 不存在，已局部丢弃。', entry));
        continue;
      }
      const existing = foreshadowingByRef.get(ref);
      const item = existing || emptyMainlineEntity(ref, evidence);
      item.setup = observation.setup || item.setup || '';
      item.expectedPayoff = observation.expectedPayoff || item.expectedPayoff || '';
      item.status = observation.op === 'partial' ? 'partially_paid' : observation.op === 'resolve' ? 'paid' : observation.op === 'open' ? 'open' : item.status || 'open';
      item.evidence = mergeEvidence(item.evidence, evidence);
      if (!existing) {
        foreshadowingByRef.set(ref, item);
        patch.mainlinePatch.foreshadowingUpserts.push(item);
      }
      addSummaryValue(summary.mainlineChanges, label);
      continue;
    }

    if (observation.kind === 'timeline') {
      patch.mainlinePatch.timelineAnchors.push({
        ref: localRef('new_time_obs_', `${entry.chapter.position}_${entry.originalOrder}`, 'time'),
        label: observation.label || observation.event || '',
        timeDescription: observation.time || '',
        event: observation.event || observation.label || '',
        pinned: Boolean(observation.pinned),
        evidence,
      });
      addSummaryValue(summary.mainlineChanges, label);
    }
  }

  patch.chapterSummaries = ordered.map(chapter => {
    const summary = summaries.get(chapter.id)!;
    return {
      chapterId: chapter.id,
      chapterPosition: chapter.position,
      brief: summary.brief || chapterFallbackBrief(chapter, input.evidence, chapter.id) || '本章正文已处理。',
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
    reason: hasMainlineMutation ? '检测到结构化主线变化。' : '本批未形成持续主线状态变化。',
  };
  validateCompiledStoryMemoryBatchPatch(patch, input.previousState, ordered, input.evidence);
  return {
    patch,
    warnings,
    acceptedObservations: accepted.size,
    droppedObservations: warnings.filter(item => item.observationIndex != null).length,
    evidenceByObservation,
  };
}

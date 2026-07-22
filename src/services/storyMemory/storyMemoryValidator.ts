import type {
  ChapterMemoryPatchDraft,
  MainlinePatch,
  StoryMemoryState,
} from './storyMemoryTypes';
import { StoryMemoryError } from './storyMemoryTypes';

function normalizeEvidence(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeEvidenceForMatch(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]+/gu, '');
}

function hasCloseEvidenceSubstring(content: string, quote: string): boolean {
  const pattern = Array.from(quote);
  const source = Array.from(content);
  if (pattern.length < 6 || source.length < pattern.length - 2) return false;

  // Semi-global edit distance: the content prefix is free, so the final row
  // measures the quote against every possible substring ending in the chapter.
  // This tolerates provider-only wording slips such as “与”/“和”, while still
  // requiring at least 75% of the returned quote to be copied from one locus.
  let previous = pattern.map((_, index) => index + 1);
  previous.unshift(0);
  let best = pattern.length;
  for (const sourceCharacter of source) {
    const current = new Array<number>(pattern.length + 1);
    current[0] = 0;
    for (let index = 1; index <= pattern.length; index += 1) {
      const substitutionCost = pattern[index - 1] === sourceCharacter ? 0 : 1;
      current[index] = Math.min(
        previous[index] + 1,
        current[index - 1] + 1,
        previous[index - 1] + substitutionCost,
      );
    }
    best = Math.min(best, current[pattern.length]);
    previous = current;
  }
  return best <= Math.min(6, Math.floor(pattern.length / 4));
}

export function validateEvidenceQuote(
  chapterContent: string,
  evidenceQuote: string,
): boolean {
  const quote = normalizeEvidence(evidenceQuote);
  if (quote.length < 4 || quote.length > 80 || !/[\p{L}\p{N}]/u.test(quote)) {
    return false;
  }
  const content = normalizeEvidence(chapterContent);
  const compactContent = normalizeEvidenceForMatch(content);
  const compactQuote = normalizeEvidenceForMatch(quote);
  return (
    content.includes(quote) ||
    compactContent.includes(compactQuote) ||
    hasCloseEvidenceSubstring(compactContent, compactQuote)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertArray(
  value: unknown,
  field: string,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new StoryMemoryError(
      'MEMORY_PATCH_SCHEMA_INVALID',
      `字段 ${field} 必须是数组。`,
    );
  }
}

function normalizeOptionalPatchFields(draft: ChapterMemoryPatchDraft): void {
  const text = (value: unknown): string =>
    typeof value === 'string' ? value : '';
  const textList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  draft.episodicSummary.brief =
    typeof draft.episodicSummary.brief === 'string'
      ? draft.episodicSummary.brief
      : '';
  for (const key of [
    'keywords',
    'events',
    'characterChanges',
    'relationshipChanges',
    'mainlineChanges',
    'newThreads',
    'resolvedThreads',
  ] as const) {
    draft.episodicSummary[key] = draft.episodicSummary[key].filter(
      (item): item is string => typeof item === 'string',
    );
  }
  draft.newCharacters = draft.newCharacters.filter(item => {
    const raw = item as unknown as Record<string, unknown>;
    return Object.values(raw).some(value =>
      Array.isArray(value) ? value.length > 0 : Boolean(value),
    );
  });
  for (const item of draft.newCharacters) {
    const raw = item as unknown as Record<string, unknown>;
    item.tempRef = text(item.tempRef || raw.ref || raw.id);
    item.aliases = textList(item.aliases);
    item.evidenceQuote = text(item.evidenceQuote || raw.quote || raw.evidence);
    const tempRef = item.tempRef;
    item.canonicalName = text(
      item.canonicalName ||
        raw.name ||
        raw.characterName ||
        raw.displayName ||
        item.aliases[0],
    );
    if (typeof item.canonicalName !== 'string' || !item.canonicalName.trim()) {
      const refSuffix = tempRef.replace(/^new_char_/, '');
      if (/\p{L}/u.test(refSuffix)) item.canonicalName = refSuffix;
    }
    if (typeof item.canonicalName !== 'string' || !item.canonicalName.trim()) {
      throw new StoryMemoryError(
        'MEMORY_PATCH_SCHEMA_INVALID',
        `新人物 ${tempRef || '未知引用'} 缺少 canonicalName。`,
      );
    }
    item.role = typeof item.role === 'string' ? item.role : '';
    item.identity = typeof item.identity === 'string' ? item.identity : '';
    item.stableTraits = Array.isArray(item.stableTraits)
      ? item.stableTraits.filter(
          (trait): trait is string => typeof trait === 'string',
        )
      : [];
    item.initialState ??= {};
    for (const key of [
      'location',
      'physicalState',
      'emotionalState',
      'currentGoal',
    ] as const) {
      item.initialState[key] = text(item.initialState[key]);
    }
    for (const key of ['knowledge', 'possessions', 'secrets'] as const) {
      item.initialState[key] = textList(item.initialState[key]);
    }
    item.status ??= 'active';
  }
  for (const update of draft.characterUpdates) {
    update.addAliases ??= [];
    update.profileCorrections ??= {};
    update.stateChanges ??= {};
    update.correctionReason ??= '';
    update.addKnowledge ??= [];
    update.removeKnowledge ??= [];
    update.addPossessions ??= [];
    update.removePossessions ??= [];
    update.addSecrets ??= [];
    update.removeSecrets ??= [];
    update.clearFields ??= [];
    update.evidenceQuote = text(update.evidenceQuote);
  }
  for (const item of draft.newRelationships) {
    item.tempRef = text(item.tempRef);
    item.fromRef = text(item.fromRef);
    item.toRef = text(item.toRef);
    item.direction =
      item.direction === 'directed' ? 'directed' : 'bidirectional';
    item.relationType = text(item.relationType);
    item.currentState = text(item.currentState);
    item.trustLevel = item.trustLevel || 'unknown';
    item.publicStatus = text(item.publicStatus);
    item.hiddenStatus = text(item.hiddenStatus);
    item.reason = text(item.reason);
    item.evidenceQuote = text(item.evidenceQuote);
  }
  for (const item of draft.relationshipUpdates) {
    item.relationshipRef = text(item.relationshipRef);
    item.currentState =
      item.currentState === undefined ? undefined : text(item.currentState);
    item.publicStatus =
      item.publicStatus === undefined ? undefined : text(item.publicStatus);
    item.hiddenStatus =
      item.hiddenStatus === undefined ? undefined : text(item.hiddenStatus);
    item.reason = item.reason === undefined ? undefined : text(item.reason);
    item.evidenceQuote = text(item.evidenceQuote);
  }

  const arc = draft.mainlinePatch.currentArcUpdate;
  arc.action = ['none', 'start', 'update', 'complete', 'replace'].includes(
    arc.action,
  )
    ? arc.action
    : 'none';
  arc.arcRef = text(arc.arcRef);
  arc.name = text(arc.name);
  arc.summary = text(arc.summary);
  arc.evidenceQuote = text(arc.evidenceQuote);
  const assessment = draft.mainlinePatch.assessment as unknown;
  if (isRecord(assessment)) {
    const result = text(assessment.result);
    draft.mainlinePatch.assessment = {
      result: result === 'changed' ? 'changed' : 'unchanged',
      reason: text(assessment.reason),
    };
  } else {
    delete draft.mainlinePatch.assessment;
  }
  if (draft.mainlinePatch.currentObjective) {
    draft.mainlinePatch.currentObjective.value = text(
      draft.mainlinePatch.currentObjective.value,
    );
    draft.mainlinePatch.currentObjective.evidenceQuote = text(
      draft.mainlinePatch.currentObjective.evidenceQuote,
    );
  }
  for (const list of [
    draft.mainlinePatch.conflictUpserts,
    draft.mainlinePatch.threadOpens,
    draft.mainlinePatch.threadUpdates,
    draft.mainlinePatch.foreshadowingUpserts,
  ]) {
    for (const item of list) {
      item.ref = text(item.ref);
      item.title = text(item.title);
      item.description = text(item.description);
      item.state = text(item.state);
      item.stakes = text(item.stakes);
      item.parties = textList(item.parties);
      item.ownerCharacterRefs = textList(item.ownerCharacterRefs);
      item.deadlineOrTrigger = text(item.deadlineOrTrigger);
      item.setup = text(item.setup);
      item.expectedPayoff = text(item.expectedPayoff);
      item.evidenceQuote = text(item.evidenceQuote);
    }
  }
  for (const item of draft.mainlinePatch.threadResolutions) {
    item.threadRef = text(item.threadRef);
    item.resolution = text(item.resolution);
    item.evidenceQuote = text(item.evidenceQuote);
  }
  draft.mainlinePatch.conflictResolutions ??= [];
  for (const item of draft.mainlinePatch.conflictResolutions) {
    item.conflictRef = text(item.conflictRef);
    item.resolution = text(item.resolution);
    item.evidenceQuote = text(item.evidenceQuote);
  }
  for (const item of draft.mainlinePatch.timelineAnchors) {
    item.ref = text(item.ref);
    item.label = text(item.label);
    item.timeDescription = text(item.timeDescription);
    item.event = text(item.event);
    item.pinned = Boolean(item.pinned);
    item.evidenceQuote = text(item.evidenceQuote);
  }
  for (const item of draft.mainlinePatch.completedBeats) {
    item.ref = text(item.ref);
    item.summary = text(item.summary);
    item.evidenceQuote = text(item.evidenceQuote);
  }
}

interface CharacterRefCandidate {
  name: string;
  ref: string;
}

function buildUniqueCharacterRef(
  canonicalName: string,
  fallbackIndex: number,
  usedRefs: Set<string>,
): string {
  const suffix = canonicalName
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  const base = `new_char_${suffix || fallbackIndex + 1}`;
  let candidate = base;
  let serial = 2;
  while (usedRefs.has(candidate)) {
    candidate = `${base}_${serial}`;
    serial += 1;
  }
  usedRefs.add(candidate);
  return candidate;
}

function matchingCandidates(
  candidates: CharacterRefCandidate[],
  contextText: string,
): CharacterRefCandidate[] {
  return candidates.filter(candidate => contextText.includes(candidate.name));
}

function matchingCandidatesInTextOrder(
  candidates: CharacterRefCandidate[],
  contextText: string,
): CharacterRefCandidate[] {
  return matchingCandidates(candidates, contextText).sort((left, right) => {
    const leftIndex = contextText.indexOf(left.name);
    const rightIndex = contextText.indexOf(right.name);
    return leftIndex - rightIndex;
  });
}

function normalizeDuplicateCharacterRefs(draft: ChapterMemoryPatchDraft): void {
  const groups = new Map<string, typeof draft.newCharacters>();
  for (const character of draft.newCharacters) {
    const group = groups.get(character.tempRef) || [];
    group.push(character);
    groups.set(character.tempRef, group);
  }
  const duplicatedGroups = [...groups.entries()].filter(
    ([, characters]) => characters.length > 1,
  );
  if (!duplicatedGroups.length) return;

  const usedRefs = new Set(
    [...groups.entries()]
      .filter(([, characters]) => characters.length === 1)
      .map(([ref]) => ref),
  );
  const replacements = new Map<string, CharacterRefCandidate[]>();
  const removed = new Set<(typeof draft.newCharacters)[number]>();

  for (const [duplicateRef, characters] of duplicatedGroups) {
    const byName = new Map<string, (typeof draft.newCharacters)[number]>();
    for (const character of characters) {
      const nameKey = character.canonicalName.trim().toLocaleLowerCase();
      const existing = byName.get(nameKey);
      if (!existing) {
        byName.set(nameKey, character);
        continue;
      }
      existing.aliases = [
        ...new Set([...existing.aliases, ...character.aliases]),
      ];
      existing.stableTraits = [
        ...new Set([...existing.stableTraits, ...character.stableTraits]),
      ];
      existing.role ||= character.role;
      existing.identity ||= character.identity;
      existing.initialState = {
        ...character.initialState,
        ...existing.initialState,
      };
      removed.add(character);
    }
    const candidates = [...byName.values()].map((character, index) => {
      const ref = buildUniqueCharacterRef(
        character.canonicalName,
        index,
        usedRefs,
      );
      character.tempRef = ref;
      return { name: character.canonicalName, ref };
    });
    replacements.set(duplicateRef, candidates);
  }
  draft.newCharacters = draft.newCharacters.filter(
    character => !removed.has(character),
  );

  const resolveOne = (ref: string, contextText: string): string => {
    const candidates = replacements.get(ref);
    if (!candidates) return ref;
    if (candidates.length === 1) return candidates[0].ref;
    const matched = matchingCandidates(candidates, contextText);
    if (matched.length === 1) return matched[0].ref;
    throw new StoryMemoryError(
      'MEMORY_ENTITY_REFERENCE_INVALID',
      `重复人物引用 ${ref} 无法根据关系证据消歧，请为每个人物使用唯一 tempRef。`,
    );
  };
  const resolveMany = (refs: string[] | undefined, contextText: string) =>
    (refs || []).flatMap(ref => {
      const candidates = replacements.get(ref);
      if (!candidates) return [ref];
      const matched = matchingCandidates(candidates, contextText);
      return (matched.length ? matched : candidates).map(
        candidate => candidate.ref,
      );
    });

  for (const relationship of draft.newRelationships) {
    const contextText = [
      relationship.evidenceQuote,
      relationship.reason,
      relationship.currentState,
      relationship.publicStatus,
      relationship.hiddenStatus,
    ].join('\n');
    const sharedCandidates =
      relationship.fromRef === relationship.toRef
        ? replacements.get(relationship.fromRef)
        : undefined;
    const mentionedCandidates = sharedCandidates
      ? matchingCandidatesInTextOrder(sharedCandidates, contextText)
      : [];
    const endpoints =
      mentionedCandidates.length === 2
        ? mentionedCandidates
        : sharedCandidates?.length === 2
        ? sharedCandidates
        : undefined;
    if (endpoints) {
      [relationship.fromRef, relationship.toRef] = endpoints.map(
        candidate => candidate.ref,
      );
    } else {
      relationship.fromRef = resolveOne(relationship.fromRef, contextText);
      relationship.toRef = resolveOne(relationship.toRef, contextText);
    }
  }
  for (const conflict of draft.mainlinePatch.conflictUpserts) {
    conflict.parties = resolveMany(
      conflict.parties,
      [
        conflict.title,
        conflict.description,
        conflict.state,
        conflict.evidenceQuote,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  for (const thread of draft.mainlinePatch.threadOpens) {
    thread.ownerCharacterRefs = resolveMany(
      thread.ownerCharacterRefs,
      [thread.title, thread.description, thread.evidenceQuote]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

function normalizeRelationshipCharacterRefs(
  draft: ChapterMemoryPatchDraft,
  state: StoryMemoryState,
): void {
  const candidates = [
    ...draft.newCharacters.map(character => ({
      ref: character.tempRef,
      names: [character.canonicalName, ...character.aliases].filter(Boolean),
    })),
    ...Object.values(state.characters).map(character => ({
      ref: character.id,
      names: [character.canonicalName, ...character.aliases].filter(Boolean),
    })),
  ];
  const validRefs = new Set(candidates.map(candidate => candidate.ref));
  const mentionedInOrder = (contextText: string) =>
    candidates
      .map(candidate => ({
        candidate,
        index: Math.min(
          ...candidate.names
            .map(name => contextText.indexOf(name))
            .filter(index => index >= 0),
        ),
      }))
      .filter(item => Number.isFinite(item.index))
      .sort((left, right) => left.index - right.index)
      .map(item => item.candidate);
  const resolveNamedRef = (ref: string) => {
    const normalizedRef = ref.replace(/^new_char_/, '');
    const matches = candidates.filter(candidate =>
      candidate.names.some(
        name => name === ref || name === normalizedRef || ref.includes(name),
      ),
    );
    return matches.length === 1 ? matches[0].ref : undefined;
  };

  for (const relationship of draft.newRelationships) {
    const contextText = [
      relationship.evidenceQuote,
      relationship.reason,
      relationship.currentState,
      relationship.publicStatus,
      relationship.hiddenStatus,
    ].join('\n');
    let fromRef = validRefs.has(relationship.fromRef)
      ? relationship.fromRef
      : resolveNamedRef(relationship.fromRef);
    let toRef = validRefs.has(relationship.toRef)
      ? relationship.toRef
      : resolveNamedRef(relationship.toRef);
    const mentioned = mentionedInOrder(contextText);
    if (!fromRef && mentioned.length === 1) fromRef = mentioned[0].ref;
    if (!toRef && mentioned.length === 1) toRef = mentioned[0].ref;
    if (!fromRef && mentioned.length >= 2) fromRef = mentioned[0].ref;
    if (!toRef && mentioned.length >= 2) {
      toRef = mentioned.find(candidate => candidate.ref !== fromRef)?.ref;
    }
    if (fromRef === toRef && mentioned.length >= 2) {
      const endpoints = mentioned.filter(
        (candidate, index, all) =>
          all.findIndex(item => item.ref === candidate.ref) === index,
      );
      if (endpoints.length >= 2) {
        [fromRef, toRef] = [endpoints[0].ref, endpoints[1].ref];
      }
    }
    relationship.fromRef = fromRef || relationship.fromRef;
    relationship.toRef = toRef || relationship.toRef;
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
  if (!isRecord(value.mainlinePatch.currentArcUpdate)) {
    throw new StoryMemoryError(
      'MEMORY_PATCH_SCHEMA_INVALID',
      '记忆补丁缺少剧情弧变更。',
    );
  }
  value.mainlinePatch.conflictResolutions ??= [];
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
    'conflictResolutions',
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
    ...draft.mainlinePatch.conflictResolutions,
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
        `证据“${
          typeof quote === 'string' && quote.trim()
            ? quote.trim().slice(0, 80)
            : '（空）'
        }”无法在章节正文中定位。evidenceQuote 必须使用与正文相同语言，直接逐字复制一段 4–80 字符的连续原文，不得翻译、改写或概括。`,
      );
    }
  }
}

function longestCommonSubstringLength(left: string, right: string): number {
  if (!left || !right) return 0;
  let previous = new Array<number>(right.length + 1).fill(0);
  let best = 0;
  for (const leftCharacter of left) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let index = 1; index <= right.length; index += 1) {
      if (leftCharacter === right[index - 1]) {
        current[index] = previous[index - 1] + 1;
        best = Math.max(best, current[index]);
      }
    }
    previous = current;
  }
  return best;
}

function collectEvidenceContext(value: unknown, key = ''): string[] {
  if (key === 'evidenceQuote' || /Ref$/u.test(key)) return [];
  if (typeof value === 'string') {
    const text = normalizeEvidence(value);
    return text.length >= 2 ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => collectEvidenceContext(item, key));
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([entryKey, entryValue]) =>
      collectEvidenceContext(entryValue, entryKey),
    );
  }
  return [];
}

function chapterEvidenceSegments(chapterContent: string): string[] {
  const normalized = normalizeEvidence(chapterContent);
  const units = normalized
    .split(/(?<=[。！？；])/u)
    .map(segment => segment.trim())
    .filter(Boolean);
  const segments: string[] = [];
  for (const unit of units.length ? units : normalized ? [normalized] : []) {
    if (unit.length <= 80) {
      segments.push(unit);
      continue;
    }
    for (let offset = 0; offset < unit.length; offset += 60) {
      segments.push(unit.slice(offset, offset + 80));
    }
  }
  return segments;
}

function findRecoverableEvidenceQuote(
  operation: Record<string, unknown>,
  chapterContent: string,
): string | null {
  const originalQuote =
    typeof operation.evidenceQuote === 'string'
      ? normalizeEvidence(operation.evidenceQuote)
      : '';
  const compactQuote = normalizeEvidenceForMatch(originalQuote);
  if (!compactQuote) return null;
  const context = collectEvidenceContext(operation).filter(
    candidate => candidate !== originalQuote,
  );
  const segments = chapterEvidenceSegments(chapterContent);
  let best:
    | { segment: string; quoteMatch: number; contextMatch: number }
    | undefined;
  for (const segment of segments) {
    const compactSegment = normalizeEvidenceForMatch(segment);
    if (!compactSegment) continue;
    const quoteMatch = longestCommonSubstringLength(
      compactQuote,
      compactSegment,
    );
    const contextMatch = context.reduce(
      (maximum, candidate) =>
        Math.max(
          maximum,
          longestCommonSubstringLength(
            normalizeEvidenceForMatch(candidate),
            compactSegment,
          ),
        ),
      0,
    );
    if (
      !best ||
      quoteMatch * 4 + contextMatch > best.quoteMatch * 4 + best.contextMatch
    ) {
      best = { segment, quoteMatch, contextMatch };
    }
  }
  if (!best) return null;

  const quoteRequired =
    compactQuote.length >= 16
      ? Math.ceil(compactQuote.length * 0.4)
      : Math.max(4, Math.ceil(compactQuote.length * 0.55));
  const contextRequired = Math.max(6, Math.ceil(compactQuote.length * 0.3));
  if (
    best.quoteMatch < quoteRequired &&
    (best.contextMatch < contextRequired || best.contextMatch < 6)
  ) {
    return null;
  }
  return best.segment.slice(0, 80);
}

/**
 * Last-resort grounding for provider paraphrases. It only runs after the
 * normal model repair attempts have failed. A recovered quote is always an
 * actual excerpt from the chapter; an operation with no defensible excerpt is
 * removed instead of allowing an ungrounded fact into story memory.
 */
export function recoverPatchEvidence(
  draft: ChapterMemoryPatchDraft,
  chapterContent: string,
): { recovered: number; dropped: number } {
  let recovered = 0;
  let dropped = 0;
  const recoverList = <T extends { evidenceQuote: string }>(items: T[]): T[] =>
    items.filter(item => {
      if (
        typeof item.evidenceQuote === 'string' &&
        validateEvidenceQuote(chapterContent, item.evidenceQuote)
      ) {
        return true;
      }
      const quote = findRecoverableEvidenceQuote(item, chapterContent);
      if (quote) {
        item.evidenceQuote = quote;
        recovered += 1;
        return true;
      }
      dropped += 1;
      return false;
    });

  draft.newCharacters = recoverList(draft.newCharacters);
  draft.characterUpdates = recoverList(draft.characterUpdates);
  draft.newRelationships = recoverList(draft.newRelationships);
  draft.relationshipUpdates = recoverList(draft.relationshipUpdates);
  draft.mainlinePatch.conflictUpserts = recoverList(
    draft.mainlinePatch.conflictUpserts,
  );
  draft.mainlinePatch.conflictResolutions = recoverList(
    draft.mainlinePatch.conflictResolutions ?? [],
  );
  draft.mainlinePatch.threadOpens = recoverList(
    draft.mainlinePatch.threadOpens,
  );
  draft.mainlinePatch.threadUpdates = recoverList(
    draft.mainlinePatch.threadUpdates,
  );
  draft.mainlinePatch.threadResolutions = recoverList(
    draft.mainlinePatch.threadResolutions,
  );
  draft.mainlinePatch.foreshadowingUpserts = recoverList(
    draft.mainlinePatch.foreshadowingUpserts,
  );
  draft.mainlinePatch.timelineAnchors = recoverList(
    draft.mainlinePatch.timelineAnchors,
  );
  draft.mainlinePatch.completedBeats = recoverList(
    draft.mainlinePatch.completedBeats,
  );

  const arc = draft.mainlinePatch.currentArcUpdate;
  if (
    arc.action !== 'none' &&
    !validateEvidenceQuote(chapterContent, arc.evidenceQuote)
  ) {
    const quote = findRecoverableEvidenceQuote(arc, chapterContent);
    if (quote) {
      arc.evidenceQuote = quote;
      recovered += 1;
    } else {
      arc.action = 'none';
      arc.arcRef = '';
      arc.name = '';
      arc.summary = '';
      arc.evidenceQuote = '';
      dropped += 1;
    }
  }
  const objective = draft.mainlinePatch.currentObjective;
  if (
    objective &&
    !validateEvidenceQuote(chapterContent, objective.evidenceQuote)
  ) {
    const quote = findRecoverableEvidenceQuote(objective, chapterContent);
    if (quote) {
      objective.evidenceQuote = quote;
      recovered += 1;
    } else {
      delete draft.mainlinePatch.currentObjective;
      dropped += 1;
    }
  }
  return { recovered, dropped };
}

export function validateEntityReferences(
  draft: ChapterMemoryPatchDraft,
  state: StoryMemoryState,
): void {
  const newCharacterRefs = new Set(
    draft.newCharacters.map(item => item.tempRef),
  );
  if (newCharacterRefs.size !== draft.newCharacters.length) {
    throw new StoryMemoryError(
      'MEMORY_ENTITY_REFERENCE_INVALID',
      '新人物临时引用重复；每个新人物必须使用唯一的 tempRef。',
    );
  }
  const invalidCharacterRef = [...newCharacterRefs].find(
    ref => !/^new_char_[\p{L}\p{N}_-]+$/u.test(ref),
  );
  if (invalidCharacterRef) {
    throw new StoryMemoryError(
      'MEMORY_ENTITY_REFERENCE_INVALID',
      `新人物临时引用格式无效：${invalidCharacterRef}。tempRef 必须以 new_char_ 开头，后缀只能包含中英文字母、数字、下划线或连字符。`,
    );
  }
  // Soft-drop invalid update refs so one bad model reference cannot discard
  // an otherwise valid multi-character batch.
  draft.characterUpdates = draft.characterUpdates.filter(update => {
    if (
      !Object.prototype.hasOwnProperty.call(
        state.characters,
        update.characterRef,
      )
    ) {
      return false;
    }
    if (
      Object.keys(update.profileCorrections || {}).length > 0 &&
      !update.correctionReason?.trim()
    ) {
      return false;
    }
    return true;
  });
  const characterRefs = new Set([
    ...Object.keys(state.characters),
    ...newCharacterRefs,
  ]);
  draft.newRelationships = draft.newRelationships.filter(
    relationship =>
      characterRefs.has(relationship.fromRef) &&
      characterRefs.has(relationship.toRef) &&
      relationship.fromRef !== relationship.toRef,
  );
  draft.relationshipUpdates = draft.relationshipUpdates.filter(update =>
    Boolean(state.relationships[update.relationshipRef]),
  );
  const threadRefs = new Set([
    ...Object.keys(state.mainline.openThreads),
    ...draft.mainlinePatch.threadOpens.map(item => item.ref).filter(Boolean),
  ]);
  draft.mainlinePatch.threadUpdates = draft.mainlinePatch.threadUpdates.filter(
    item => Boolean(item.ref) && threadRefs.has(item.ref),
  );
  draft.mainlinePatch.threadResolutions =
    draft.mainlinePatch.threadResolutions.filter(
      resolution =>
        Boolean(resolution.threadRef) &&
        (Boolean(state.mainline.openThreads[resolution.threadRef]) ||
          threadRefs.has(resolution.threadRef)),
    );
  draft.mainlinePatch.conflictResolutions = (
    draft.mainlinePatch.conflictResolutions ?? []
  ).filter(
    resolution =>
      Boolean(resolution.conflictRef) &&
      Boolean(state.mainline.activeConflicts[resolution.conflictRef]),
  );

  const arc = draft.mainlinePatch.currentArcUpdate;
  if (
    ['update', 'complete', 'replace'].includes(arc.action) &&
    (!state.mainline.currentArc || arc.arcRef !== state.mainline.currentArc.id)
  ) {
    throw new StoryMemoryError(
      'MEMORY_ENTITY_REFERENCE_INVALID',
      '剧情弧更新、完成或替换必须引用当前剧情弧的精确 ID。',
    );
  }
  if (arc.action === 'start' && state.mainline.currentArc) {
    throw new StoryMemoryError(
      'MEMORY_ENTITY_REFERENCE_INVALID',
      '已有当前剧情弧时必须使用 update、complete 或 replace，不能直接 start 覆盖。',
    );
  }
}

/** Whether the patch changes one of the five user-visible mainline fields. */
export function hasMainlineStateMutation(patch: MainlinePatch): boolean {
  return Boolean(
    patch.currentArcUpdate.action !== 'none' ||
      patch.currentObjective ||
      patch.conflictUpserts.length ||
      patch.conflictResolutions?.length ||
      0 ||
      patch.threadOpens.length ||
      patch.threadUpdates.length ||
      patch.threadResolutions.length ||
      patch.foreshadowingUpserts.length,
  );
}

export function validateMainlineAssessment(
  patch: MainlinePatch,
  requireAssessment = false,
): void {
  if (!requireAssessment) return;
  const assessment = patch.assessment;
  if (!assessment) {
    if (!requireAssessment) return; // legacy persisted patches remain replayable.
    throw new StoryMemoryError(
      'MEMORY_PATCH_SCHEMA_INVALID',
      '故事主线 assessment 缺失，无法判断本章是否存在持续性变化。',
    );
  }
  if (!assessment.reason.trim()) {
    if (!requireAssessment) return;
    throw new StoryMemoryError(
      'MEMORY_PATCH_SCHEMA_INVALID',
      '故事主线 assessment 必须说明本章是否存在持续性变化。',
    );
  }
  const changed = hasMainlineStateMutation(patch);
  if (
    (assessment.result === 'changed' && !changed) ||
    (assessment.result === 'unchanged' && changed)
  ) {
    throw new StoryMemoryError(
      'MEMORY_PATCH_SCHEMA_INVALID',
      '故事主线 assessment 与实际主线操作不一致。',
    );
  }
}

export function validateChapterMemoryPatch(
  value: unknown,
  state: StoryMemoryState,
  chapterContent: string,
  options: {
    recoverEvidence?: boolean;
    requireMainlineAssessment?: boolean;
  } = {},
): ChapterMemoryPatchDraft {
  validatePatchShape(value);
  normalizeOptionalPatchFields(value);
  normalizeDuplicateCharacterRefs(value);
  normalizeRelationshipCharacterRefs(value, state);
  validateEntityReferences(value, state);
  if (options.recoverEvidence) recoverPatchEvidence(value, chapterContent);
  validatePatchEvidence(value, chapterContent);
  validateMainlineAssessment(
    value.mainlinePatch,
    options.requireMainlineAssessment,
  );
  return value;
}

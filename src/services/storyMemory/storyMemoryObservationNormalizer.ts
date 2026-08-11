import type {
  StoryMemoryNormalizedObservationPayload,
  StoryMemoryObservation,
  StoryMemoryObservationChapter,
  StoryMemoryObservationKind,
  StoryMemoryObservationWarning,
} from './storyMemoryObservationTypes';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function textList(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(Boolean))];
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function observationKey(observation: StoryMemoryObservation): string {
  return JSON.stringify([
    observation.kind,
    observation.op,
    observation.key,
    observation.ref,
    observation.field,
    observation.value,
    observation.name,
    observation.from,
    observation.to,
    observation.evidence,
  ]);
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return allowed.includes(value as T);
}

const KINDS: readonly StoryMemoryObservationKind[] = [
  'character_new',
  'character_state',
  'character_set',
  'relationship',
  'arc',
  'objective',
  'conflict',
  'thread',
  'foreshadowing',
  'timeline',
];

const KIND_ALIASES: Record<string, StoryMemoryObservationKind> = {
  characterNew: 'character_new',
  characterState: 'character_state',
  characterSet: 'character_set',
  relation: 'relationship',
  mainlineArc: 'arc',
  mainlineObjective: 'objective',
  foreshadow: 'foreshadowing',
};

const OPS: Record<StoryMemoryObservationKind, readonly string[]> = {
  character_new: ['new', 'open'],
  character_state: ['set', 'clear'],
  character_set: ['add', 'remove'],
  relationship: ['open', 'update'],
  arc: ['start', 'update', 'complete', 'replace'],
  objective: ['set', 'clear'],
  conflict: ['open', 'update', 'resolve'],
  thread: ['open', 'update', 'resolve'],
  foreshadowing: ['open', 'update', 'partial', 'resolve'],
  timeline: ['add'],
};

const DEFAULT_OP: Record<StoryMemoryObservationKind, string> = {
  character_new: 'new',
  character_state: 'set',
  character_set: 'add',
  relationship: 'open',
  arc: 'update',
  objective: 'set',
  conflict: 'open',
  thread: 'open',
  foreshadowing: 'open',
  timeline: 'add',
};

const CHARACTER_STATE_FIELDS = [
  'location',
  'physicalState',
  'emotionalState',
  'currentGoal',
  'status',
] as const;
const CHARACTER_SET_FIELDS = ['alias', 'knowledge', 'possession', 'secret'] as const;

function warning(
  code: StoryMemoryObservationWarning['code'],
  message: string,
  chapterHandle: string,
  observationIndex: number,
): StoryMemoryObservationWarning {
  return { code, message, chapterHandle, observationIndex };
}

function normalizeKind(value: unknown): StoryMemoryObservationKind | null {
  const raw = text(value);
  const canonical = KIND_ALIASES[raw] || raw;
  return oneOf(canonical, KINDS) ? canonical : null;
}

function normalizeObservation(
  raw: unknown,
  chapterHandle: string,
  observationIndex: number,
  warnings: StoryMemoryObservationWarning[],
): StoryMemoryObservation | null {
  if (!isRecord(raw)) {
    warnings.push(
      warning(
        'OBS_INVALID_KIND',
        'Observation 必须是对象。',
        chapterHandle,
        observationIndex,
      ),
    );
    return null;
  }
  const kind = normalizeKind(raw.kind);
  if (!kind) {
    warnings.push(
      warning(
        'OBS_INVALID_KIND',
        `未知 observation kind：${text(raw.kind) || '(空)'}`,
        chapterHandle,
        observationIndex,
      ),
    );
    return null;
  }
  const op = text(raw.op) || DEFAULT_OP[kind];
  if (!OPS[kind].includes(op)) {
    warnings.push(
      warning(
        'OBS_INVALID_OP',
        `${kind} 不支持 op=${op}。`,
        chapterHandle,
        observationIndex,
      ),
    );
    return null;
  }
  const field = text(raw.field);
  if (
    (kind === 'character_state' && !CHARACTER_STATE_FIELDS.includes(field as never)) ||
    (kind === 'character_set' && !CHARACTER_SET_FIELDS.includes(field as never))
  ) {
    warnings.push(
      warning(
        'OBS_INVALID_FIELD',
        `${kind} 的 field 无效：${field || '(空)'}`,
        chapterHandle,
        observationIndex,
      ),
    );
    return null;
  }

  const normalized: StoryMemoryObservation = {
    kind,
    op,
    key: text(raw.key) || undefined,
    ref: text(raw.ref) || undefined,
    field: field || undefined,
    value: text(raw.value) || undefined,
    name: text(raw.name) || undefined,
    aliases: textList(raw.aliases),
    role: text(raw.role) || undefined,
    identity: text(raw.identity) || undefined,
    stableTraits: textList(raw.stableTraits),
    initialState: (() => {
      const state = record(raw.initialState);
      return {
        location: text(state.location) || undefined,
        physicalState: text(state.physicalState) || undefined,
        emotionalState: text(state.emotionalState) || undefined,
        currentGoal: text(state.currentGoal) || undefined,
        knowledge: textList(state.knowledge),
        possessions: textList(state.possessions),
        secrets: textList(state.secrets),
      };
    })(),
    status: oneOf(text(raw.status), ['active', 'inactive', 'missing', 'dead', 'unknown'])
      ? (text(raw.status) as StoryMemoryObservation['status'])
      : 'active',
    direction:
      text(raw.direction) === 'directed' ? 'directed' : 'bidirectional',
    from: text(raw.from) || undefined,
    to: text(raw.to) || undefined,
    type: text(raw.type || raw.relationType) || undefined,
    state: text(raw.state || raw.currentState) || undefined,
    trust: text(raw.trust || raw.trustLevel) || undefined,
    trustLevel: text(raw.trustLevel || raw.trust) || undefined,
    reason: text(raw.reason) || undefined,
    publicStatus: text(raw.publicStatus) || undefined,
    hiddenStatus: text(raw.hiddenStatus) || undefined,
    title: text(raw.title) || undefined,
    description: text(raw.description) || undefined,
    stakes: text(raw.stakes) || undefined,
    parties: textList(raw.parties),
    owners: textList(raw.owners || raw.ownerCharacterRefs),
    priority: oneOf(text(raw.priority), ['critical', 'high', 'normal', 'low'])
      ? (text(raw.priority) as StoryMemoryObservation['priority'])
      : 'normal',
    deadlineOrTrigger: text(raw.deadlineOrTrigger) || undefined,
    setup: text(raw.setup) || undefined,
    payoff: text(raw.payoff || raw.resolution) || undefined,
    expectedPayoff: text(raw.expectedPayoff || raw.payoff) || undefined,
    summary: text(raw.summary) || undefined,
    label: text(raw.label) || undefined,
    time: text(raw.time || raw.timeDescription) || undefined,
    event: text(raw.event) || undefined,
    pinned: Boolean(raw.pinned),
    evidence: textList(raw.evidence || raw.evidenceIds),
  };

  const required: Array<[boolean, string]> = [];
  if (kind === 'character_new') {
    required.push([Boolean(normalized.key), 'character_new.key']);
    required.push([Boolean(normalized.name), 'character_new.name']);
  } else if (kind === 'character_state' || kind === 'character_set') {
    required.push([Boolean(normalized.ref), `${kind}.ref`]);
    required.push([Boolean(normalized.field), `${kind}.field`]);
    if (op === 'set' || op === 'add') required.push([Boolean(normalized.value), `${kind}.value`]);
  } else if (kind === 'relationship') {
    if (op === 'open') {
      required.push([Boolean(normalized.key), 'relationship.key']);
      required.push([Boolean(normalized.from), 'relationship.from']);
      required.push([Boolean(normalized.to), 'relationship.to']);
    } else {
      required.push([Boolean(normalized.ref), 'relationship.ref']);
    }
  } else if (kind === 'conflict' || kind === 'thread') {
    if (op === 'open') required.push([Boolean(normalized.key), `${kind}.key`]);
    else required.push([Boolean(normalized.ref), `${kind}.ref`]);
    if (op === 'open') required.push([Boolean(normalized.title), `${kind}.title`]);
  } else if (kind === 'foreshadowing') {
    if (op === 'open') required.push([Boolean(normalized.key), 'foreshadowing.key']);
    else required.push([Boolean(normalized.ref), 'foreshadowing.ref']);
    if (op === 'open') required.push([Boolean(normalized.setup), 'foreshadowing.setup']);
  } else if (kind === 'timeline') {
    required.push([Boolean(normalized.label), 'timeline.label']);
    required.push([Boolean(normalized.event), 'timeline.event']);
  }
  const missing = required.find(([present]) => !present);
  if (missing) {
    warnings.push(
      warning(
        'OBS_MISSING_REQUIRED_FIELD',
        `缺少 ${missing[1]}。`,
        chapterHandle,
        observationIndex,
      ),
    );
    return null;
  }
  return normalized;
}

function unwrapChapters(raw: unknown): unknown[] | null {
  if (!isRecord(raw)) return null;
  if (Array.isArray(raw.chapters)) return raw.chapters;
  const keys = Object.keys(raw);
  if (keys.length === 1) {
    const child = raw[keys[0]];
    if (isRecord(child) && Array.isArray(child.chapters)) return child.chapters;
  }
  return null;
}

export function isObservationPayload(raw: unknown): raw is { chapters: unknown[] } {
  return unwrapChapters(raw) !== null;
}

export function normalizeStoryMemoryObservationPayload(
  raw: unknown,
  expectedChapterHandles: readonly string[],
  options: { fallbackBriefByChapter?: ReadonlyMap<string, string> } = {},
): StoryMemoryNormalizedObservationPayload {
  const warnings: StoryMemoryObservationWarning[] = [];
  const rawChapters = unwrapChapters(raw);
  const expected = new Set(expectedChapterHandles);
  const byHandle = new Map<string, StoryMemoryObservationChapter>();
  if (!rawChapters) {
    return {
      chapters: [],
      warnings,
      missingChapterHandles: [...expected],
    };
  }

  rawChapters.forEach((rawChapter, chapterIndex) => {
    if (!isRecord(rawChapter)) {
      warnings.push({
        code: 'OBS_UNKNOWN_CHAPTER',
        message: `chapters[${chapterIndex}] 不是对象。`,
      });
      return;
    }
    const handle = text(rawChapter.chapter || rawChapter.chapterHandle || rawChapter.handle);
    if (!expected.has(handle)) {
      warnings.push({ code: 'OBS_UNKNOWN_CHAPTER', message: `未知章节 handle：${handle || '(空)'}` });
      return;
    }
    const chapterWarnings: StoryMemoryObservationWarning[] = [];
    const observations = Array.isArray(rawChapter.observations)
      ? rawChapter.observations
          .map((item, index) => normalizeObservation(item, handle, index, chapterWarnings))
          .filter((item): item is StoryMemoryObservation => Boolean(item))
      : [];
    const seen = new Set<string>();
    const deduped = observations.filter((observation, index) => {
      const key = observationKey(observation);
      if (seen.has(key)) {
        chapterWarnings.push({
          code: 'OBS_DUPLICATE',
          message: '重复 observation 已丢弃。',
          chapterHandle: handle,
          observationIndex: index,
        });
        return false;
      }
      seen.add(key);
      return true;
    });
    let brief = text(rawChapter.brief);
    const events = textList(rawChapter.events);
    if (!brief && events.length > 0) {
      brief = events[0];
      chapterWarnings.push({ code: 'OBS_BRIEF_FALLBACK', message: 'brief 为空，已使用首个 event。', chapterHandle: handle });
    }
    if (!brief) {
      const fallback = text(options.fallbackBriefByChapter?.get(handle));
      if (fallback) {
        brief = fallback;
        chapterWarnings.push({ code: 'OBS_BRIEF_FALLBACK', message: 'brief/events 均为空，已使用本地 Anchor fallback。', chapterHandle: handle });
      }
    }
    const chapter: StoryMemoryObservationChapter = {
      chapter: handle,
      brief,
      events,
      keywords: textList(rawChapter.keywords),
      observations: deduped,
    };
    warnings.push(...chapterWarnings);
    const previous = byHandle.get(handle);
    if (!previous) {
      byHandle.set(handle, chapter);
      return;
    }
    warnings.push({ code: 'OBS_CHAPTER_DUPLICATE', message: `章节 ${handle} 重复，已合并更完整记录。`, chapterHandle: handle });
    const mergeObservations = (
      left: StoryMemoryObservation[],
      right: StoryMemoryObservation[],
    ): StoryMemoryObservation[] => {
      const merged: StoryMemoryObservation[] = [];
      const mergeSeen = new Set<string>();
      [...left, ...right].forEach(observation => {
        const key = observationKey(observation);
        if (mergeSeen.has(key)) {
          warnings.push({
            code: 'OBS_DUPLICATE',
            message: '重复 observation 已在章节合并时丢弃。',
            chapterHandle: handle,
          });
          return;
        }
        mergeSeen.add(key);
        merged.push(observation);
      });
      return merged;
    };
    const score = (value: StoryMemoryObservationChapter) =>
      value.observations.length * 10 + value.events.length + value.brief.length;
    if (score(chapter) > score(previous)) {
      byHandle.set(handle, {
        chapter: handle,
        brief: chapter.brief || previous.brief,
        events: [...new Set([...previous.events, ...chapter.events])],
        keywords: [...new Set([...previous.keywords, ...chapter.keywords])],
        observations: mergeObservations(previous.observations, chapter.observations),
      });
    } else {
      previous.events = [...new Set([...previous.events, ...chapter.events])];
      previous.keywords = [...new Set([...previous.keywords, ...chapter.keywords])];
      previous.observations = mergeObservations(previous.observations, chapter.observations);
    }
  });

  const chapters = expectedChapterHandles
    .map(handle => byHandle.get(handle))
    .filter((chapter): chapter is StoryMemoryObservationChapter => Boolean(chapter));
  return {
    chapters,
    warnings,
    missingChapterHandles: expectedChapterHandles.filter(handle => !byHandle.has(handle)),
  };
}

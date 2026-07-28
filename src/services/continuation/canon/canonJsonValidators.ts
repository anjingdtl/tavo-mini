/**
 * Versioned JSON validators for Canon extraction output (Spec §8.2, §6.16).
 * Never write unparseable model text into JSON columns.
 */

export const EXTRACTION_RESULT_SCHEMA_VERSION = 1 as const;

export interface ExtractionEvidenceCandidate {
  chapterId: number;
  chapterPosition: number;
  charStart: number;
  charEnd: number;
  quotePreview: string;
}

export interface ExtractionWorldRule {
  category: string;
  title: string;
  description: string;
  constraintLevel: 'hard' | 'strong' | 'reference';
  confidence: number;
  evidence: ExtractionEvidenceCandidate[];
}

export interface ExtractionCharacter {
  canonicalName: string;
  aliases: string[];
  description: string;
  importance: 'primary' | 'major' | 'supporting' | 'minor';
  confidence: number;
  evidence: ExtractionEvidenceCandidate[];
}

export interface ExtractionRelationship {
  sourceName: string;
  targetName: string;
  relationType: string;
  attitude: string;
  publicStatus: 'public' | 'secret' | 'misunderstood' | 'one_sided';
  description: string;
  confidence: number;
  evidence: ExtractionEvidenceCandidate[];
}

export interface ExtractionPlotThread {
  title: string;
  description: string;
  /** 原著明确交代时保留；未交代可为空，不能靠模型猜测。 */
  timeDescription: string;
  /** 原著明确交代时保留；未交代可为空，不能靠模型猜测。 */
  location: string;
  level: 'main' | 'volume' | 'arc' | 'subplot' | 'foreshadowing';
  status: 'active' | 'paused' | 'resolved' | 'abandoned' | 'unknown';
  characterNames: string[];
  confidence: number;
  evidence: ExtractionEvidenceCandidate[];
}

export interface ExtractionExperience {
  characterName: string;
  eventType: string;
  title: string;
  description: string;
  importance: number;
  confidence: number;
  evidence: ExtractionEvidenceCandidate[];
}

export interface ExtractionKnowledge {
  characterName: string;
  factKey: string;
  factSummary: string;
  knowledgeState: 'unknown' | 'suspected' | 'known' | 'misunderstood';
  confidence: number;
  evidence: ExtractionEvidenceCandidate[];
}

export interface ExtractionState {
  characterName: string;
  location: string | null;
  physicalState: string | null;
  emotionalState: string | null;
  aliveState: 'alive' | 'dead' | 'unknown';
  summary: string;
  confidence: number;
  evidence: ExtractionEvidenceCandidate[];
}

export interface ExtractionTimelineEvent {
  eventKey: string;
  title: string;
  summary: string;
  eventType: string;
  timeDescription: string;
  location: string;
  characterNames: string[];
  importance: number;
  confidence: number;
  evidence: ExtractionEvidenceCandidate[];
}

export interface ChapterExtractionResult {
  schemaVersion: typeof EXTRACTION_RESULT_SCHEMA_VERSION;
  worldRules: ExtractionWorldRule[];
  characters: ExtractionCharacter[];
  relationships: ExtractionRelationship[];
  plotThreads: ExtractionPlotThread[];
  experiences: ExtractionExperience[];
  knowledge: ExtractionKnowledge[];
  states: ExtractionState[];
  timelineEvents: ExtractionTimelineEvent[];
}

const CONSTRAINT = new Set(['hard', 'strong', 'reference']);
const IMPORTANCE = new Set(['primary', 'major', 'supporting', 'minor']);
const PUBLIC = new Set(['public', 'secret', 'misunderstood', 'one_sided']);
const PLOT_LEVEL = new Set([
  'main',
  'volume',
  'arc',
  'subplot',
  'foreshadowing',
]);
const PLOT_STATUS = new Set([
  'active',
  'paused',
  'resolved',
  'abandoned',
  'unknown',
]);
const KNOW = new Set(['unknown', 'suspected', 'known', 'misunderstood']);
const ALIVE = new Set(['alive', 'dead', 'unknown']);

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * 小说模型经常把枚举写成自然语言（例如“贯穿全书的叙事线”）。这类
 * 值不应让名称、关系对象和证据都完整的事实被整条丢弃；归入保守的
 * 规范默认值，保留其余可审核内容。
 */
function enumOrFallback(
  value: string,
  allowed: Set<string>,
  fallback: string,
): string {
  return allowed.has(value) ? value : fallback;
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function parseEvidence(raw: unknown): ExtractionEvidenceCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractionEvidenceCandidate[] = [];
  for (const item of raw) {
    if (!isObj(item)) continue;
    const charStart = num(item.charStart, -1);
    const charEnd = num(item.charEnd, -1);
    if (charStart < 0 || charEnd <= charStart) continue;
    out.push({
      chapterId: Math.floor(num(item.chapterId)),
      chapterPosition: Math.floor(num(item.chapterPosition)),
      charStart: Math.floor(charStart),
      charEnd: Math.floor(charEnd),
      quotePreview: str(item.quotePreview).slice(0, 160),
    });
  }
  return out;
}

/**
 * Extract balanced JSON values while respecting quoted strings and escapes.
 * Some OpenAI-compatible providers prepend a sentence or append usage text;
 * using `lastIndexOf` in that situation used to accidentally join two JSON
 * objects into one invalid payload.
 */
function findBalancedJsonValues(text: string): string[] {
  const values: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    const open = text[start];
    if (open !== '{' && open !== '[') continue;

    const stack: string[] = [open === '{' ? '}' : ']'];
    let quoted = false;
    let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (char === '{') stack.push('}');
      else if (char === '[') stack.push(']');
      else if (char === '}' || char === ']') {
        if (stack[stack.length - 1] !== char) break;
        stack.pop();
        if (stack.length === 0) {
          values.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return values;
}

function modelJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const fenced = fence?.[1]?.trim();
  const sources = fenced && fenced !== trimmed ? [fenced, trimmed] : [trimmed];
  const candidates: string[] = [];
  for (const source of sources) {
    if (source) candidates.push(source);
    candidates.push(...findBalancedJsonValues(source));
  }
  return [...new Set(candidates)];
}

/** Strip surrounding prose/code fences and return the first balanced JSON value. */
export function stripModelJson(text: string): string {
  return (
    modelJsonCandidates(text).find(candidate => {
      try {
        JSON.parse(candidate);
        return true;
      } catch {
        return false;
      }
    }) ?? text.trim()
  );
}

export function parseExtractionResultJson(
  raw: string,
): ChapterExtractionResult {
  let validationError: Error | null = null;
  for (const candidate of modelJsonCandidates(raw)) {
    try {
      // A few OpenAI-compatible gateways serialise `content` once more, so
      // the model result arrives as a JSON string containing the JSON object.
      // Accept that transport wrapper, but cap unwrapping to avoid treating
      // arbitrary nested strings as an extraction result.
      let parsed: unknown = JSON.parse(candidate);
      for (let depth = 0; typeof parsed === 'string' && depth < 2; depth += 1) {
        parsed = JSON.parse(parsed.trim());
      }
      return validateExtractionResult(parsed);
    } catch (error) {
      // A valid but unrelated JSON object may be present before the actual
      // result. Keep scanning candidates, but retain schema errors when it is
      // the only JSON the model returned.
      if (
        validationError === null &&
        !(error instanceof SyntaxError) &&
        error instanceof Error
      ) {
        validationError = error;
      }
    }
  }
  if (validationError) throw validationError;
  throw new Error('提取结果不是合法 JSON 或不符合 Canon schema');
}

/**
 * Field-name alias table used to relax the validator (Spec §3, change 2).
 *
 * Models routinely guess field names (`name`/`source`/`target`/`character`
 * /`fact`/`key`/`event`). Before validating we map every alias onto the
 * canonical column name, but **only when the canonical field is absent** —
 * this keeps the change strictly a relaxation: an explicit canonical value is
 * never overwritten by an alias.
 */
const EXTRACTION_FIELD_ALIASES: Record<string, Array<[string, string]>> = {
  characters: [['name', 'canonicalName']],
  relationships: [
    ['source', 'sourceName'],
    ['from', 'sourceName'],
    ['target', 'targetName'],
    ['to', 'targetName'],
  ],
  experiences: [['character', 'characterName']],
  knowledge: [
    ['character', 'characterName'],
    ['fact', 'factKey'],
  ],
  states: [['character', 'characterName']],
  timelineEvents: [
    ['key', 'eventKey'],
    ['event', 'eventKey'],
    ['time', 'timeDescription'],
    ['timeText', 'timeDescription'],
    ['when', 'timeDescription'],
    ['place', 'location'],
    ['where', 'location'],
  ],
  worldRules: [['name', 'title']],
  plotThreads: [
    ['name', 'title'],
    ['time', 'timeDescription'],
    ['timeText', 'timeDescription'],
    ['when', 'timeDescription'],
    ['place', 'location'],
    ['where', 'location'],
  ],
};

/**
 * Provider-observed enum variants. These are intentionally narrow: every
 * entry below was captured by the redacted on-device extraction diagnostic.
 * They are promoted to the existing canonical enum before validation, so this
 * only relaxes input spelling and never broadens the persisted domain.
 */
const EXTRACTION_VALUE_ALIASES: Record<
  string,
  Record<string, Record<string, string>>
> = {
  worldRules: {
    constraintLevel: {
      未明: 'reference',
      未明确: 'reference',
    },
  },
  plotThreads: {
    level: {
      primary: 'main',
      major: 'main',
      主要: 'main',
    },
  },
  characters: {
    importance: { 高: 'major' },
  },
  relationships: {
    publicStatus: { 隐秘: 'secret' },
  },
  knowledge: {
    knowledgeState: { 确知: 'known' },
  },
  states: {
    aliveState: { 活着: 'alive' },
  },
};

function normalizeObservedEnumValue(
  category: string,
  field: string,
  value: string,
): string {
  const exact = EXTRACTION_VALUE_ALIASES[category]?.[field]?.[value];
  if (exact) return exact;
  // The provider emitted publicStatus as a canonical Chinese label followed by
  // a parenthetical explanation. The label itself is unambiguous, while the
  // explanation is free-form prose and must not become part of the enum.
  if (category === 'relationships' && field === 'publicStatus' && value.startsWith('公开')) {
    return 'public';
  }
  return value;
}

/**
 * Normalize a single raw extraction item by promoting aliases to their
 * canonical field names. Mutates a shallow copy and returns it; the input
 * object is never modified. Non-objects are returned unchanged.
 */
export function normalizeExtractionItem(
  category: keyof typeof EXTRACTION_FIELD_ALIASES,
  raw: unknown,
): Record<string, unknown> {
  if (!isObj(raw)) return raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  for (const [alias, canonical] of EXTRACTION_FIELD_ALIASES[category] ?? []) {
    if (out[canonical] == null || out[canonical] === '') {
      const value = out[alias];
      if (value != null && value !== '') {
        out[canonical] = value;
      }
    }
  }
  for (const field of Object.keys(EXTRACTION_VALUE_ALIASES[category] ?? {})) {
    const value = out[field];
    if (typeof value === 'string') {
      out[field] = normalizeObservedEnumValue(category, field, value);
    }
  }
  return out;
}

export interface ExtractionCategoryStats {
  received: number;
  accepted: number;
  dropped: number;
  firstDropReason?: string;
}

export type ExtractionStats = Record<
  | 'worldRules'
  | 'characters'
  | 'relationships'
  | 'plotThreads'
  | 'experiences'
  | 'knowledge'
  | 'states'
  | 'timelineEvents',
  ExtractionCategoryStats
>;

export function validateExtractionResult(
  raw: unknown,
): ChapterExtractionResult {
  return validateExtractionResultWithStats(raw).result;
}

export function validateExtractionResultWithStats(raw: unknown): {
  result: ChapterExtractionResult;
  stats: ExtractionStats;
} {
  if (!isObj(raw)) throw new Error('提取结果必须是对象');
  const schemaVersion = num(raw.schemaVersion, 0);
  if (schemaVersion !== EXTRACTION_RESULT_SCHEMA_VERSION) {
    throw new Error(`不支持的提取 schema 版本：${schemaVersion}`);
  }

  const stats: ExtractionStats = {
    worldRules: { received: 0, accepted: 0, dropped: 0 },
    characters: { received: 0, accepted: 0, dropped: 0 },
    relationships: { received: 0, accepted: 0, dropped: 0 },
    plotThreads: { received: 0, accepted: 0, dropped: 0 },
    experiences: { received: 0, accepted: 0, dropped: 0 },
    knowledge: { received: 0, accepted: 0, dropped: 0 },
    states: { received: 0, accepted: 0, dropped: 0 },
    timelineEvents: { received: 0, accepted: 0, dropped: 0 },
  };

  const worldRules: ExtractionWorldRule[] = [];
  for (const item of Array.isArray(raw.worldRules) ? raw.worldRules : []) {
    stats.worldRules.received += 1;
    if (!isObj(item)) {
      recordDrop(stats.worldRules, 'worldRules: 非对象');
      continue;
    }
    const normed = normalizeExtractionItem('worldRules', item);
    const level = enumOrFallback(
      str(normed.constraintLevel, 'reference'),
      CONSTRAINT,
      'reference',
    );
    const title = str(normed.title).trim();
    if (!title) {
      recordDrop(stats.worldRules, 'worldRules: title 为空');
      continue;
    }
    worldRules.push({
      category: str(normed.category, 'other') || 'other',
      title,
      description: str(normed.description),
      constraintLevel: level as ExtractionWorldRule['constraintLevel'],
      confidence: clamp01(num(normed.confidence, 0.5)),
      evidence: parseEvidence(normed.evidence),
    });
    stats.worldRules.accepted += 1;
  }

  const characters: ExtractionCharacter[] = [];
  for (const item of Array.isArray(raw.characters) ? raw.characters : []) {
    stats.characters.received += 1;
    if (!isObj(item)) {
      recordDrop(stats.characters, 'characters: 非对象');
      continue;
    }
    const normed = normalizeExtractionItem('characters', item);
    const name = str(normed.canonicalName).trim();
    if (!name) {
      recordDrop(stats.characters, 'characters: canonicalName 为空');
      continue;
    }
    const imp = enumOrFallback(
      str(normed.importance, 'supporting'),
      IMPORTANCE,
      'supporting',
    );
    characters.push({
      canonicalName: name,
      aliases: Array.isArray(normed.aliases)
        ? normed.aliases.filter(
            (a): a is string => typeof a === 'string' && a.trim().length > 0,
          )
        : [],
      description: str(normed.description),
      importance: imp as ExtractionCharacter['importance'],
      confidence: clamp01(num(normed.confidence, 0.5)),
      evidence: parseEvidence(normed.evidence),
    });
    stats.characters.accepted += 1;
  }

  const relationships: ExtractionRelationship[] = [];
  for (const item of Array.isArray(raw.relationships)
    ? raw.relationships
    : []) {
    stats.relationships.received += 1;
    if (!isObj(item)) {
      recordDrop(stats.relationships, 'relationships: 非对象');
      continue;
    }
    const normed = normalizeExtractionItem('relationships', item);
    const sourceName = str(normed.sourceName).trim();
    const targetName = str(normed.targetName).trim();
    if (!sourceName) {
      recordDrop(stats.relationships, 'relationships: sourceName 为空');
      continue;
    }
    if (!targetName) {
      recordDrop(stats.relationships, 'relationships: targetName 为空');
      continue;
    }
    if (sourceName === targetName) {
      recordDrop(stats.relationships, 'relationships: source=target');
      continue;
    }
    const pub = enumOrFallback(
      str(normed.publicStatus, 'public'),
      PUBLIC,
      'public',
    );
    relationships.push({
      sourceName,
      targetName,
      relationType: str(normed.relationType, 'related') || 'related',
      attitude: str(normed.attitude),
      publicStatus: pub as ExtractionRelationship['publicStatus'],
      description: str(normed.description),
      confidence: clamp01(num(normed.confidence, 0.5)),
      evidence: parseEvidence(normed.evidence),
    });
    stats.relationships.accepted += 1;
  }

  const plotThreads: ExtractionPlotThread[] = [];
  for (const item of Array.isArray(raw.plotThreads) ? raw.plotThreads : []) {
    stats.plotThreads.received += 1;
    if (!isObj(item)) {
      recordDrop(stats.plotThreads, 'plotThreads: 非对象');
      continue;
    }
    const normed = normalizeExtractionItem('plotThreads', item);
    const title = str(normed.title).trim();
    if (!title) {
      recordDrop(stats.plotThreads, 'plotThreads: title 为空');
      continue;
    }
    const level = enumOrFallback(
      str(normed.level, 'subplot'),
      PLOT_LEVEL,
      'subplot',
    );
    const status = enumOrFallback(
      str(normed.status, 'active'),
      PLOT_STATUS,
      'active',
    );
    plotThreads.push({
      title,
      description: str(normed.description),
      timeDescription: str(normed.timeDescription),
      location: str(normed.location),
      level: level as ExtractionPlotThread['level'],
      status: status as ExtractionPlotThread['status'],
      characterNames: Array.isArray(normed.characterNames)
        ? normed.characterNames.filter(
            (a): a is string => typeof a === 'string',
          )
        : [],
      confidence: clamp01(num(normed.confidence, 0.5)),
      evidence: parseEvidence(normed.evidence),
    });
    stats.plotThreads.accepted += 1;
  }

  const experiences: ExtractionExperience[] = [];
  for (const item of Array.isArray(raw.experiences) ? raw.experiences : []) {
    stats.experiences.received += 1;
    if (!isObj(item)) {
      recordDrop(stats.experiences, 'experiences: 非对象');
      continue;
    }
    const normed = normalizeExtractionItem('experiences', item);
    const characterName = str(normed.characterName).trim();
    if (!characterName) {
      recordDrop(stats.experiences, 'experiences: characterName 为空');
      continue;
    }
    const title = str(normed.title).trim();
    if (!title) {
      recordDrop(stats.experiences, 'experiences: title 为空');
      continue;
    }
    experiences.push({
      characterName,
      eventType: str(normed.eventType, 'other') || 'other',
      title,
      description: str(normed.description),
      importance: Math.floor(num(normed.importance, 0)),
      confidence: clamp01(num(normed.confidence, 0.5)),
      evidence: parseEvidence(normed.evidence),
    });
    stats.experiences.accepted += 1;
  }

  const knowledge: ExtractionKnowledge[] = [];
  for (const item of Array.isArray(raw.knowledge) ? raw.knowledge : []) {
    stats.knowledge.received += 1;
    if (!isObj(item)) {
      recordDrop(stats.knowledge, 'knowledge: 非对象');
      continue;
    }
    const normed = normalizeExtractionItem('knowledge', item);
    const characterName = str(normed.characterName).trim();
    if (!characterName) {
      recordDrop(stats.knowledge, 'knowledge: characterName 为空');
      continue;
    }
    const factKey = str(normed.factKey).trim();
    if (!factKey) {
      recordDrop(stats.knowledge, 'knowledge: factKey 为空');
      continue;
    }
    const ks = enumOrFallback(
      str(normed.knowledgeState, 'known'),
      KNOW,
      'unknown',
    );
    knowledge.push({
      characterName,
      factKey,
      factSummary: str(normed.factSummary) || factKey,
      knowledgeState: ks as ExtractionKnowledge['knowledgeState'],
      confidence: clamp01(num(normed.confidence, 0.5)),
      evidence: parseEvidence(normed.evidence),
    });
    stats.knowledge.accepted += 1;
  }

  const states: ExtractionState[] = [];
  for (const item of Array.isArray(raw.states) ? raw.states : []) {
    stats.states.received += 1;
    if (!isObj(item)) {
      recordDrop(stats.states, 'states: 非对象');
      continue;
    }
    const normed = normalizeExtractionItem('states', item);
    const characterName = str(normed.characterName).trim();
    if (!characterName) {
      recordDrop(stats.states, 'states: characterName 为空');
      continue;
    }
    const alive = enumOrFallback(
      str(normed.aliveState, 'unknown'),
      ALIVE,
      'unknown',
    );
    states.push({
      characterName,
      location: normed.location == null ? null : str(normed.location),
      physicalState:
        normed.physicalState == null ? null : str(normed.physicalState),
      emotionalState:
        normed.emotionalState == null ? null : str(normed.emotionalState),
      aliveState: alive as ExtractionState['aliveState'],
      summary: str(normed.summary),
      confidence: clamp01(num(normed.confidence, 0.5)),
      evidence: parseEvidence(normed.evidence),
    });
    stats.states.accepted += 1;
  }

  const timelineEvents: ExtractionTimelineEvent[] = [];
  for (const item of Array.isArray(raw.timelineEvents)
    ? raw.timelineEvents
    : []) {
    stats.timelineEvents.received += 1;
    if (!isObj(item)) {
      recordDrop(stats.timelineEvents, 'timelineEvents: 非对象');
      continue;
    }
    const normed = normalizeExtractionItem('timelineEvents', item);
    const eventKey = str(normed.eventKey).trim();
    if (!eventKey) {
      recordDrop(stats.timelineEvents, 'timelineEvents: eventKey 为空');
      continue;
    }
    const title = str(normed.title).trim();
    if (!title) {
      recordDrop(stats.timelineEvents, 'timelineEvents: title 为空');
      continue;
    }
    timelineEvents.push({
      eventKey,
      title,
      summary: str(normed.summary),
      eventType: str(normed.eventType, 'event') || 'event',
      timeDescription: str(normed.timeDescription),
      location: str(normed.location),
      characterNames: Array.isArray(normed.characterNames)
        ? normed.characterNames.filter(
            (a): a is string => typeof a === 'string',
          )
        : [],
      importance: Math.floor(num(normed.importance, 0)),
      confidence: clamp01(num(normed.confidence, 0.5)),
      evidence: parseEvidence(normed.evidence),
    });
    stats.timelineEvents.accepted += 1;
  }

  return {
    result: {
      schemaVersion: EXTRACTION_RESULT_SCHEMA_VERSION,
      worldRules,
      characters,
      relationships,
      plotThreads,
      experiences,
      knowledge,
      states,
      timelineEvents,
    },
    stats,
  };
}

function recordDrop(
  bucket: ExtractionCategoryStats,
  reason: string,
): void {
  bucket.dropped += 1;
  if (!bucket.firstDropReason) bucket.firstDropReason = reason;
}

/** Validate free-form JSON columns before write (Spec §6.16). */
export function assertJsonColumn(
  value: string,
  kind: 'object' | 'array' = 'object',
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('JSON 列无法解析');
  }
  if (kind === 'object' && !isObj(parsed)) throw new Error('JSON 列必须是对象');
  if (kind === 'array' && !Array.isArray(parsed))
    throw new Error('JSON 列必须是数组');
  return value;
}

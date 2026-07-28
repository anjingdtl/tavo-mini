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

export function validateExtractionResult(
  raw: unknown,
): ChapterExtractionResult {
  if (!isObj(raw)) throw new Error('提取结果必须是对象');
  const schemaVersion = num(raw.schemaVersion, 0);
  if (schemaVersion !== EXTRACTION_RESULT_SCHEMA_VERSION) {
    throw new Error(`不支持的提取 schema 版本：${schemaVersion}`);
  }

  const worldRules: ExtractionWorldRule[] = [];
  for (const item of Array.isArray(raw.worldRules) ? raw.worldRules : []) {
    if (!isObj(item)) continue;
    const level = str(item.constraintLevel, 'reference');
    if (!CONSTRAINT.has(level)) continue;
    const title = str(item.title).trim();
    if (!title) continue;
    worldRules.push({
      category: str(item.category, 'other') || 'other',
      title,
      description: str(item.description),
      constraintLevel: level as ExtractionWorldRule['constraintLevel'],
      confidence: clamp01(num(item.confidence, 0.5)),
      evidence: parseEvidence(item.evidence),
    });
  }

  const characters: ExtractionCharacter[] = [];
  for (const item of Array.isArray(raw.characters) ? raw.characters : []) {
    if (!isObj(item)) continue;
    const name = str(item.canonicalName).trim();
    if (!name) continue;
    const imp = str(item.importance, 'supporting');
    if (!IMPORTANCE.has(imp)) continue;
    characters.push({
      canonicalName: name,
      aliases: Array.isArray(item.aliases)
        ? item.aliases.filter(
            (a): a is string => typeof a === 'string' && a.trim().length > 0,
          )
        : [],
      description: str(item.description),
      importance: imp as ExtractionCharacter['importance'],
      confidence: clamp01(num(item.confidence, 0.5)),
      evidence: parseEvidence(item.evidence),
    });
  }

  const relationships: ExtractionRelationship[] = [];
  for (const item of Array.isArray(raw.relationships)
    ? raw.relationships
    : []) {
    if (!isObj(item)) continue;
    const sourceName = str(item.sourceName).trim();
    const targetName = str(item.targetName).trim();
    if (!sourceName || !targetName || sourceName === targetName) continue;
    const pub = str(item.publicStatus, 'public');
    if (!PUBLIC.has(pub)) continue;
    relationships.push({
      sourceName,
      targetName,
      relationType: str(item.relationType, 'related') || 'related',
      attitude: str(item.attitude),
      publicStatus: pub as ExtractionRelationship['publicStatus'],
      description: str(item.description),
      confidence: clamp01(num(item.confidence, 0.5)),
      evidence: parseEvidence(item.evidence),
    });
  }

  const plotThreads: ExtractionPlotThread[] = [];
  for (const item of Array.isArray(raw.plotThreads) ? raw.plotThreads : []) {
    if (!isObj(item)) continue;
    const title = str(item.title).trim();
    if (!title) continue;
    const level = str(item.level, 'subplot');
    const status = str(item.status, 'active');
    if (!PLOT_LEVEL.has(level) || !PLOT_STATUS.has(status)) continue;
    plotThreads.push({
      title,
      description: str(item.description),
      level: level as ExtractionPlotThread['level'],
      status: status as ExtractionPlotThread['status'],
      characterNames: Array.isArray(item.characterNames)
        ? item.characterNames.filter((a): a is string => typeof a === 'string')
        : [],
      confidence: clamp01(num(item.confidence, 0.5)),
      evidence: parseEvidence(item.evidence),
    });
  }

  const experiences: ExtractionExperience[] = [];
  for (const item of Array.isArray(raw.experiences) ? raw.experiences : []) {
    if (!isObj(item)) continue;
    const characterName = str(item.characterName).trim();
    const title = str(item.title).trim();
    if (!characterName || !title) continue;
    experiences.push({
      characterName,
      eventType: str(item.eventType, 'other') || 'other',
      title,
      description: str(item.description),
      importance: Math.floor(num(item.importance, 0)),
      confidence: clamp01(num(item.confidence, 0.5)),
      evidence: parseEvidence(item.evidence),
    });
  }

  const knowledge: ExtractionKnowledge[] = [];
  for (const item of Array.isArray(raw.knowledge) ? raw.knowledge : []) {
    if (!isObj(item)) continue;
    const characterName = str(item.characterName).trim();
    const factKey = str(item.factKey).trim();
    if (!characterName || !factKey) continue;
    const ks = str(item.knowledgeState, 'known');
    if (!KNOW.has(ks)) continue;
    knowledge.push({
      characterName,
      factKey,
      factSummary: str(item.factSummary) || factKey,
      knowledgeState: ks as ExtractionKnowledge['knowledgeState'],
      confidence: clamp01(num(item.confidence, 0.5)),
      evidence: parseEvidence(item.evidence),
    });
  }

  const states: ExtractionState[] = [];
  for (const item of Array.isArray(raw.states) ? raw.states : []) {
    if (!isObj(item)) continue;
    const characterName = str(item.characterName).trim();
    if (!characterName) continue;
    const alive = str(item.aliveState, 'unknown');
    if (!ALIVE.has(alive)) continue;
    states.push({
      characterName,
      location: item.location == null ? null : str(item.location),
      physicalState:
        item.physicalState == null ? null : str(item.physicalState),
      emotionalState:
        item.emotionalState == null ? null : str(item.emotionalState),
      aliveState: alive as ExtractionState['aliveState'],
      summary: str(item.summary),
      confidence: clamp01(num(item.confidence, 0.5)),
      evidence: parseEvidence(item.evidence),
    });
  }

  const timelineEvents: ExtractionTimelineEvent[] = [];
  for (const item of Array.isArray(raw.timelineEvents)
    ? raw.timelineEvents
    : []) {
    if (!isObj(item)) continue;
    const eventKey = str(item.eventKey).trim();
    const title = str(item.title).trim();
    if (!eventKey || !title) continue;
    timelineEvents.push({
      eventKey,
      title,
      summary: str(item.summary),
      eventType: str(item.eventType, 'event') || 'event',
      characterNames: Array.isArray(item.characterNames)
        ? item.characterNames.filter((a): a is string => typeof a === 'string')
        : [],
      importance: Math.floor(num(item.importance, 0)),
      confidence: clamp01(num(item.confidence, 0.5)),
      evidence: parseEvidence(item.evidence),
    });
  }

  return {
    schemaVersion: EXTRACTION_RESULT_SCHEMA_VERSION,
    worldRules,
    characters,
    relationships,
    plotThreads,
    experiences,
    knowledge,
    states,
    timelineEvents,
  };
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

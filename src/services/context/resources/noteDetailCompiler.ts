import { estimateTokens } from '../../../utils/tokenEstimator';
import type {
  FrozenNoteConfig,
  FrozenSourceRecord,
  ResourceContextWarning,
  ResourceDetailCandidate,
} from './resourceAwarenessTypes';

export interface NoteDetailCompileHaystack {
  title: string;
  synopsis: string;
  currentBody: string;
  userPrompt: string;
  previousChapters: string;
  storyMemory: string;
  outline: string;
  episodic: string;
}

export interface NoteDetailCompileInput {
  /** Frozen records only. This compiler has no project/database boundary. */
  notes: FrozenSourceRecord[];
  haystack: NoteDetailCompileHaystack;
  noteConfig?: FrozenNoteConfig;
}

export interface NoteDetailCompileResult {
  candidates: ResourceDetailCandidate[];
  totalActualTokens: number;
  styleNotePresent: boolean;
  warnings: ResourceContextWarning[];
}

interface ParsedFrozenNote {
  id: number | null;
  title: string;
  body: string;
  contentAvailable: boolean;
  record: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function warning(
  code: ResourceContextWarning['code'],
  message: string,
  note?: { id: number | null; title: string },
): ResourceContextWarning {
  return {
    code,
    sourceKind: 'note',
    sourceId: note?.id,
    title: note?.title,
    message,
    action: code === 'NOTE_DETAIL_COMPILE_FAILED' ? 'retry' : 'open_resources',
  };
}

function parseFrozenNote(record: FrozenSourceRecord): ParsedFrozenNote {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.payload);
  } catch {
    throw new Error('冻结笔记 payload 不是有效 JSON。');
  }
  const raw = asRecord(parsed);
  if (Object.keys(raw).length === 0) {
    throw new Error('冻结笔记 payload 为空。');
  }
  const idValue = Number(raw.id ?? record.id);
  const id = Number.isSafeInteger(idValue) && idValue > 0 ? idValue : record.id;
  const title = String(raw.title || record.title || '笔记');
  const contentAvailable = raw.__contentAvailable !== false;
  if (!contentAvailable) {
    return { id, title, body: '', contentAvailable: false, record: raw };
  }
  if (typeof raw.content !== 'string') {
    throw new Error('冻结笔记 payload 缺少正文。');
  }
  return {
    id,
    title,
    body: raw.content,
    contentAvailable: true,
    record: raw,
  };
}

function isStyleNote(title: string, raw: Record<string, unknown>, mode: string): boolean {
  return /风格画像|仿写/.test(title) || raw.mode === 'style' || mode === 'style';
}

function normalizeTerms(text: string): string[] {
  const words = text
    .replace(/[\s，。、！？；：""''（）【】《》\-—…,.!?;:"'()]/g, ' ')
    .split(/\s+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2);
  const chineseTerms: string[] = [];
  for (const word of words) {
    if (!/^[\u4e00-\u9fff]+$/.test(word)) continue;
    for (let length = 2; length <= Math.min(6, word.length); length += 1) {
      for (let start = 0; start <= word.length - length; start += 1) {
        chineseTerms.push(word.slice(start, start + length));
      }
    }
  }
  return Array.from(new Set([...words, ...chineseTerms]));
}

function countOccurrences(text: string, term: string): number {
  const source = text.toLocaleLowerCase();
  const needle = term.toLocaleLowerCase();
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= source.length) {
    const index = source.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + Math.max(1, needle.length);
  }
  return count;
}

function extractFragment(body: string, term: string, limit: number): string {
  const safeLimit = Math.max(200, Math.min(4000, Math.floor(limit || 1000)));
  const lowerBody = body.toLocaleLowerCase();
  const index = lowerBody.indexOf(term.toLocaleLowerCase());
  if (index < 0) return body.slice(0, safeLimit);
  const radius = Math.max(0, Math.floor((safeLimit - term.length) / 2));
  const start = Math.max(0, index - radius);
  const end = Math.min(body.length, index + term.length + radius);
  return body.slice(start, end);
}

function selectedNoteIds(config?: FrozenNoteConfig): Set<number> | null {
  const ids = config?.enabledNoteIds || [];
  return ids.length > 0 ? new Set(ids) : null;
}

function makeCandidate(
  note: ParsedFrozenNote,
  record: FrozenSourceRecord,
  sourceOrder: number,
  content: string,
  options: {
    activationReason: ResourceDetailCandidate['activationReason'];
    relevance: number;
    explicitSelected: boolean;
    retrievalScore?: number;
  },
): ResourceDetailCandidate {
  return {
    id: `note-detail:${record.id ?? sourceOrder}`,
    sourceKind: 'note',
    sourceId: note.id,
    title: note.title,
    content,
    actualTokens: estimateTokens(content),
    activationReason: options.activationReason,
    relevance: options.relevance,
    explicitSelected: options.explicitSelected,
    sourceOrder: 2000 + sourceOrder,
    sourceFingerprint: record.fingerprint,
    ...(options.retrievalScore != null
      ? { retrievalScore: options.retrievalScore }
      : {}),
  };
}

function compileOriginalNotes(
  notes: ParsedFrozenNote[],
  records: FrozenSourceRecord[],
  mode: string,
  selectedIds: Set<number> | null,
): { candidates: ResourceDetailCandidate[]; styleNotePresent: boolean } {
  const candidates: ResourceDetailCandidate[] = [];
  let styleNotePresent = false;
  notes.forEach((note, index) => {
    if (!note.contentAvailable || !note.body.trim()) return;
    if (selectedIds && note.id != null && !selectedIds.has(note.id)) return;
    const style = isStyleNote(note.title, note.record, mode);
    if (style) styleNotePresent = true;
    const content = style
      ? `【风格画像笔记｜补充参考，不得覆盖已选写作预设】\n${note.body}`
      : `笔记「${note.title}」：${note.body}`;
    candidates.push(
      makeCandidate(note, records[index], index, content, {
        activationReason: style ? 'style_note' : 'explicit',
        relevance: style ? 0.42 : 0.5,
        explicitSelected: !style,
      }),
    );
  });
  return { candidates, styleNotePresent };
}

function compileStyleNotes(
  notes: ParsedFrozenNote[],
  records: FrozenSourceRecord[],
  selectedIds: Set<number> | null,
): { candidates: ResourceDetailCandidate[]; styleNotePresent: boolean } {
  const eligible: Array<{ note: ParsedFrozenNote; record: FrozenSourceRecord; index: number }> = [];
  notes.forEach((note, index) => {
    if (
      note.contentAvailable &&
      note.body.trim() &&
      (!selectedIds || (note.id != null && selectedIds.has(note.id)))
    ) {
      eligible.push({ note, record: records[index], index });
    }
  });
  if (eligible.length === 0) {
    return { candidates: [], styleNotePresent: true };
  }
  const content = [
    '以下是本次写作的风格画像参考，请严格遵循其可用维度，但不得覆盖已选写作预设：',
    ...eligible.map(item => `【${item.note.title}】\n${item.note.body}`),
  ].join('\n');
  const first = eligible[0];
  const candidate = makeCandidate(first.note, {
    ...first.record,
    id: null,
    fingerprint: eligible.map(item => item.record.fingerprint).join('|'),
  }, 0, content, {
    activationReason: 'style_note',
    relevance: 0.42,
    explicitSelected: false,
  });
  candidate.id = 'note-detail:style-profile';
  candidate.sourceId = null;
  candidate.title = '风格画像（仿写）';
  return { candidates: [candidate], styleNotePresent: true };
}

function compileRetrievedNotes(
  notes: ParsedFrozenNote[],
  records: FrozenSourceRecord[],
  haystack: NoteDetailCompileHaystack,
  config: FrozenNoteConfig | undefined,
  selectedIds: Set<number> | null,
): { candidates: ResourceDetailCandidate[]; styleNotePresent: boolean } {
  const topK = Math.max(0, Math.floor(Number(config?.retrievalTopK ?? 5)));
  if (topK <= 0) return { candidates: [], styleNotePresent: false };
  const fragmentChars = Math.max(
    200,
    Math.min(4000, Math.floor(Number(config?.retrievalFragmentChars ?? 1000))),
  );
  const terms = normalizeTerms(
    [
      haystack.title,
      haystack.synopsis,
      haystack.currentBody,
      haystack.userPrompt,
      haystack.previousChapters,
      haystack.storyMemory,
      haystack.outline,
      haystack.episodic,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  const ranked = notes
    .map((note, index) => {
      if (
        !note.contentAvailable ||
        !note.body.trim() ||
        (selectedIds && note.id != null && !selectedIds.has(note.id))
      ) {
        return null;
      }
      const matched = terms.filter(term =>
        countOccurrences(`${note.title}\n${note.body}`, term) > 0,
      );
      const hits = matched.reduce(
        (sum, term) => sum + countOccurrences(note.body, term),
        0,
      );
      if (hits <= 0) return null;
      const score = Math.min(1, hits / Math.max(1, terms.length));
      return { note, index, matched, hits, score };
    })
    .filter(
      (item): item is { note: ParsedFrozenNote; index: number; matched: string[]; hits: number; score: number } =>
        item != null,
    )
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, topK);

  const candidates = ranked.map(item => {
    const term = item.matched[0] || '';
    const fragment = extractFragment(item.note.body, term, fragmentChars);
    const content = `【笔记「${item.note.title}」】 ${fragment}`;
    return makeCandidate(item.note, records[item.index], item.index, content, {
      activationReason: 'primary_hit',
      relevance: Math.max(0.2, item.score),
      explicitSelected: false,
      retrievalScore: item.score,
    });
  });
  return {
    candidates,
    styleNotePresent: candidates.some(item => /风格画像|仿写/.test(item.title)),
  };
}

/**
 * Compile Note Detail exclusively from the frozen source view. In particular,
 * this function must remain free of projectId/database/repository inputs.
 */
export function compileNoteDetailCandidatesFromSnapshot(
  input: NoteDetailCompileInput,
): NoteDetailCompileResult {
  const warnings: ResourceContextWarning[] = [];
  const parsedNotes: ParsedFrozenNote[] = [];
  const records: FrozenSourceRecord[] = [];

  input.notes.forEach(record => {
    try {
      const parsed = parseFrozenNote(record);
      parsedNotes.push(parsed);
      records.push(record);
    } catch {
      warnings.push(
        warning(
          'NOTE_DETAIL_COMPILE_FAILED',
          `笔记「${record.title || '未命名'}」本轮无法编译，已跳过，不影响角色/世界书全局设定。`,
          { id: record.id, title: record.title || '笔记' },
        ),
      );
    }
  });

  const config = input.noteConfig;
  const mode = config?.mode || 'none';
  const selectedIds = selectedNoteIds(config);
  let compiled: { candidates: ResourceDetailCandidate[]; styleNotePresent: boolean };
  if (mode === 'style') {
    compiled = compileStyleNotes(parsedNotes, records, selectedIds);
  } else if (mode === 'retrieval') {
    compiled = compileRetrievedNotes(
      parsedNotes,
      records,
      input.haystack,
      config,
      selectedIds,
    );
  } else {
    compiled = compileOriginalNotes(parsedNotes, records, mode, null);
  }

  return {
    candidates: compiled.candidates,
    totalActualTokens: compiled.candidates.reduce(
      (sum, candidate) => sum + candidate.actualTokens,
      0,
    ),
    styleNotePresent: compiled.styleNotePresent,
    warnings,
  };
}

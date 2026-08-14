import { estimateTokens } from '../../../utils/tokenEstimator';
import {
  mergeStyleProfiles,
  parseStyleProfileJson,
  resolveStyleWeights,
  type StyleProfile,
} from '../../noteSemantics';
import type {
  FrozenNoteConfig,
  FrozenNoteRetrieval,
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
  /** LLM-selected fragments captured while the source snapshot was built. */
  noteRetrieval?: FrozenNoteRetrieval;
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
  source: FrozenSourceRecord;
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

function parseFrozenNote(source: FrozenSourceRecord): ParsedFrozenNote {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.payload);
  } catch {
    throw new Error('冻结笔记 payload 不是有效 JSON。');
  }
  const raw = asRecord(parsed);
  if (Object.keys(raw).length === 0) {
    throw new Error('冻结笔记 payload 为空。');
  }
  const idValue = Number(raw.id ?? source.id);
  const id = Number.isSafeInteger(idValue) && idValue > 0 ? idValue : source.id;
  const title = String(raw.title || source.title || '笔记');
  const contentAvailable = raw.__contentAvailable !== false;
  if (!contentAvailable) {
    return {
      id,
      title,
      body: '',
      contentAvailable: false,
      record: raw,
      source,
    };
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
    source,
  };
}

function isStyleNote(
  title: string,
  raw: Record<string, unknown>,
  mode: string,
): boolean {
  return /风格画像|仿写/.test(title) || raw.mode === 'style' || mode === 'style';
}

function selectedNoteIds(config?: FrozenNoteConfig): Set<number> | null {
  const ids = config?.enabledNoteIds || [];
  return ids.length > 0 ? new Set(ids) : null;
}

function makeCandidate(
  note: ParsedFrozenNote,
  sourceOrder: number,
  content: string,
  options: {
    activationReason: ResourceDetailCandidate['activationReason'];
    relevance: number;
    explicitSelected: boolean;
    retrievalScore?: number;
    id?: string;
    sourceId?: number | null;
    title?: string;
    fingerprint?: string;
  },
): ResourceDetailCandidate {
  return {
    id: options.id || `note-detail:${note.source.id ?? sourceOrder}`,
    sourceKind: 'note',
    sourceId: options.sourceId === undefined ? note.id : options.sourceId,
    title: options.title || note.title,
    content,
    actualTokens: estimateTokens(content),
    activationReason: options.activationReason,
    relevance: options.relevance,
    explicitSelected: options.explicitSelected,
    sourceOrder: 2000 + sourceOrder,
    sourceFingerprint: options.fingerprint || note.source.fingerprint,
    ...(options.retrievalScore != null
      ? { retrievalScore: options.retrievalScore }
      : {}),
  };
}

function compileOriginalNotes(
  notes: ParsedFrozenNote[],
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
      ? `【风格画像笔记｜补充参考，不得覆盖已选作家风格】\n${note.body}`
      : `笔记「${note.title}」：${note.body}`;
    candidates.push(
      makeCandidate(note, index, content, {
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
  selectedIds: Set<number> | null,
  config?: FrozenNoteConfig,
): { candidates: ResourceDetailCandidate[]; styleNotePresent: boolean } {
  const eligible = notes.filter(
    note =>
      note.contentAvailable &&
      note.body.trim() &&
      (!selectedIds || (note.id != null && selectedIds.has(note.id))),
  );
  if (eligible.length === 0) {
    return { candidates: [], styleNotePresent: true };
  }

  // V6 reads/caches note_style_profiles, then merges profile JSON.  Snapshot
  // capture freezes those exact profile values on each FrozenSourceRecord;
  // V7 only parses and merges them here, never the live Note or DB cache.
  const profiles: StyleProfile[] = eligible
    .map(note => {
      const frozen = note.source.styleProfile;
      if (!frozen) return null;
      return {
        profileText: frozen.profileText,
        profileJson: parseStyleProfileJson(frozen.profileJson),
        sourceHash: frozen.sourceHash,
      };
    })
    .filter((profile): profile is StyleProfile => profile != null);
  const mergedText = mergeStyleProfiles(
    profiles,
    resolveStyleWeights(config?.styleWeights),
  );
  if (!mergedText) {
    return { candidates: [], styleNotePresent: true };
  }

  const content = [
    '以下是本次写作必须遵循的风格画像，请严格按照对应权重的维度进行仿写：',
    mergedText,
  ].join('\n');
  const first = eligible[0];
  const candidate = makeCandidate(first, 0, content, {
    id: 'note-detail:style-profile',
    sourceId: null,
    title: '风格画像（仿写）',
    activationReason: 'style_note',
    relevance: 0.42,
    explicitSelected: false,
    fingerprint: eligible.map(note => note.source.fingerprint).join('|'),
  });
  return { candidates: [candidate], styleNotePresent: true };
}

function compileRetrievedNotes(
  notes: ParsedFrozenNote[],
  retrieval: FrozenNoteRetrieval | undefined,
  config: FrozenNoteConfig | undefined,
  selectedIds: Set<number> | null,
): { candidates: ResourceDetailCandidate[]; styleNotePresent: boolean } {
  if (!retrieval) {
    // A production V7 snapshot always captures retrieval before this pure
    // compiler runs.  Missing it is an empty retrieval, never a new silent
    // string-matching implementation.
    return { candidates: [], styleNotePresent: false };
  }
  const topK = Math.max(0, Math.floor(Number(config?.retrievalTopK ?? 5)));
  if (topK <= 0) return { candidates: [], styleNotePresent: false };
  const notesById = new Map(
    notes
      .filter(
        note =>
          note.contentAvailable &&
          note.body.trim() &&
          (!selectedIds || (note.id != null && selectedIds.has(note.id))),
      )
      .map(note => [note.id, note]),
  );
  const candidates = retrieval.fragments.slice(0, topK).flatMap((fragment, index) => {
    const note = notesById.get(fragment.noteId);
    if (!note || !fragment.fragment) return [];
    const score = Number(fragment.retrievalScore);
    const relevance = Number.isFinite(score)
      ? Math.max(0.2, Math.min(1, score))
      : 0.5;
    return [
      makeCandidate(note, index, `【笔记「${note.title}」】 ${fragment.fragment}`, {
        activationReason: 'primary_hit',
        relevance,
        explicitSelected: false,
        retrievalScore: Number.isFinite(score) ? score : undefined,
      }),
    ];
  });
  return { candidates, styleNotePresent: false };
}

/**
 * Compile Note Detail exclusively from the frozen source view.  The legacy
 * profile merge and retrieval selection algorithms are consumed as pure
 * functions; no projectId/database/repository input is accepted.
 */
export function compileNoteDetailCandidatesFromSnapshot(
  input: NoteDetailCompileInput,
): NoteDetailCompileResult {
  const warnings: ResourceContextWarning[] = [];
  const parsedNotes: ParsedFrozenNote[] = [];
  input.notes.forEach(source => {
    try {
      parsedNotes.push(parseFrozenNote(source));
    } catch {
      warnings.push(
        warning(
          'NOTE_DETAIL_COMPILE_FAILED',
          `笔记「${source.title || '未命名'}」本轮无法编译，已跳过，不影响角色/世界书全局设定。`,
          { id: source.id, title: source.title || '笔记' },
        ),
      );
    }
  });

  const mode = input.noteConfig?.mode || 'none';
  const selectedIds = selectedNoteIds(input.noteConfig);
  const compiled =
    mode === 'style'
      ? compileStyleNotes(parsedNotes, selectedIds, input.noteConfig)
      : mode === 'retrieval'
        ? compileRetrievedNotes(
            parsedNotes,
            input.noteRetrieval,
            input.noteConfig,
            selectedIds,
          )
        : compileOriginalNotes(parsedNotes, mode, null);

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

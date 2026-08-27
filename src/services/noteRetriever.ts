import * as db from './database';
import { callLLMResult } from './llm';
import { extractJSON } from '../utils/jsonExtractor';
import {
  buildNoteRetrievalMessages,
  fallbackToFrozenNoteCandidates,
  filterFrozenNoteCorpus,
  normalizeRetrievalFragmentChars,
  prefilterFrozenNoteFragments,
  type FrozenNoteCorpusEntry,
  type NoteRetrievalQuery,
  type RetrievedNoteFragment,
  validateFrozenNoteFragments,
} from './noteSemantics';

export type { NoteRetrievalQuery, RetrievedNoteFragment } from './noteSemantics';
export type { NoteRetrievalQuery as RetrievalQuery } from './noteSemantics';

const MAX_CACHE_SIZE = 32;
const cache = new Map<string, RetrievedNoteFragment[]>();

function toLegacyFragment(
  fragment: RetrievedNoteFragment,
): RetrievedNoteFragment {
  const legacy = { ...fragment };
  delete legacy.retrievalScore;
  return legacy;
}

function buildCacheKey(
  projectId: number,
  query: NoteRetrievalQuery,
  fragmentChars: number,
  noteIdentity: string,
): string {
  return `${projectId}|${fragmentChars}|${noteIdentity}|${query.chapterTitle}|${query.chapterSynopsis}|${query.previousEnding}|${query.userPrompt}`;
}

export function clearRetrievalCache(projectId?: number): void {
  if (projectId === undefined) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${projectId}|`)) cache.delete(key);
  }
}

export async function retrieveNoteFragments(
  projectId: number,
  query: NoteRetrievalQuery,
  topK: number,
): Promise<RetrievedNoteFragment[]> {
  const config = await db.getProjectNoteConfig(projectId);
  const fragmentChars = normalizeRetrievalFragmentChars(
    config?.retrievalFragmentChars,
  );
  const projectNotes = await db.getNotesByProject(projectId);
  const eligibleIds = projectNotes.map((note: any) => Number(note.id));
  const eligibleSet = new Set(eligibleIds);
  const configuredIds = Array.isArray(config?.enabledNoteIds)
    ? config.enabledNoteIds.map(Number)
    : [];
  const noteIds =
    configuredIds.length > 0
      ? configuredIds.filter((id: number) => eligibleSet.has(id))
      : eligibleIds;
  if (noteIds.length === 0) return [];

  const noteIdentity = noteIds
    .map(id => {
      const note = projectNotes.find((candidate: any) => Number(candidate.id) === id);
      return `${id}@${String(note?.updated_at ?? '')}`;
    })
    .join(',');
  const cacheKey = buildCacheKey(projectId, query, fragmentChars, noteIdentity);
  const cached = cache.get(cacheKey);
  if (cached) return cached.slice(0, topK).map(toLegacyFragment);

  const notesById = new Map(
    (await db.getAllNotes()).map((note: any) => [Number(note.id), note]),
  );

  const corpus: FrozenNoteCorpusEntry[] = [];
  for (const noteId of noteIds) {
    const note = notesById.get(noteId);
    if (!note) continue;
    corpus.push({
      noteId,
      noteTitle: note.title || '无标题',
      content: await db.getNoteContentById(noteId),
    });
  }
  const candidates = prefilterFrozenNoteFragments(
    filterFrozenNoteCorpus(corpus),
    query,
    fragmentChars,
  );
  if (candidates.length === 0) return [];

  let fragments: RetrievedNoteFragment[];
  try {
    const result = await callLLMResult(
      buildNoteRetrievalMessages(query, candidates),
      undefined,
      { scenario: 'note_retrieve', temperature: 0.3, projectId },
    );
    const jsonStr = extractJSON(result.text || '') || '{"selected":[]}';
    const parsed = JSON.parse(jsonStr);
    const selected = Array.isArray(parsed?.selected) ? parsed.selected : [];
    fragments = validateFrozenNoteFragments(selected, candidates, fragmentChars);
    if (selected.length > 0 && fragments.length === 0) {
      fragments = fallbackToFrozenNoteCandidates(candidates, topK);
    }
  } catch {
    // 与 V6 原逻辑一致：网络/调用失败才回退到关键词预筛片段。
    fragments = fallbackToFrozenNoteCandidates(candidates, topK);
  }

  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(cacheKey, fragments);
  return fragments.slice(0, topK).map(toLegacyFragment);
}

/* eslint-env jest */

jest.mock('../src/services/database', () => ({
  getProjectNoteConfig: jest.fn(async () => ({
    mode: 'retrieval',
    styleWeights: {},
    retrievalTopK: 5,
    retrievalFragmentChars: 200,
    enabledNoteIds: [],
  })),
  getCharactersByProject: jest.fn(async () => []),
  getWorldbookEntriesByProject: jest.fn(async () => []),
  getNotesByProject: jest.fn(async () => []),
  getNotesContentByIds: jest.fn(async () => ({})),
  getAllNotes: jest.fn(async () => []),
  getNoteContentById: jest.fn(async () => ''),
  getNoteStyleProfile: jest.fn(async () => null),
  setNoteStyleProfile: jest.fn(async () => undefined),
  computeNoteSourceHash: jest.fn(async (content: string) => `hash:${content}`),
}));

jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(async () => ({
    text: JSON.stringify({ selected: [] }),
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
  })),
}));

import * as db from '../src/services/database';
import { callLLMResult } from '../src/services/llm';
import {
  captureResourceSourceSnapshot,
} from '../src/services/context/resources/resourceSourceSnapshot';
import { buildResourceContextV2 } from '../src/services/context/resources/resourceContextV2';
import { compileNoteDetailCandidatesFromSnapshot } from '../src/services/context/resources/noteDetailCompiler';
import { clearRetrievalCache, retrieveNoteFragments } from '../src/services/noteRetriever';
import { computeNoteSourceHash } from '../src/services/noteSemantics';

function noteRecord(
  id: number,
  title: string,
  content: string,
  styleProfile?: { profileText: string; profileJson: string; sourceHash: string },
) {
  return {
    kind: 'note' as const,
    id,
    title,
    payload: JSON.stringify({ id, title, content, __contentAvailable: true }),
    fingerprint: `fp-${id}-${content}`,
    ...(styleProfile ? { styleProfile } : {}),
  };
}

const haystack = {
  title: '钟楼',
  synopsis: '主角进入钟楼',
  currentBody: '',
  userPrompt: '描写钟楼内部',
  previousChapter: '前文抵达钟楼',
  previousChapters: '前文抵达钟楼',
  storyMemory: '',
  outline: '',
  episodic: '',
  activatedDetailText: '',
};

beforeEach(() => {
  jest.clearAllMocks();
  clearRetrievalCache();
  (db.getProjectNoteConfig as jest.Mock).mockResolvedValue({
    mode: 'retrieval',
    styleWeights: {},
    retrievalTopK: 5,
    retrievalFragmentChars: 200,
    enabledNoteIds: [],
  });
  (db.getCharactersByProject as jest.Mock).mockResolvedValue([]);
  (db.getWorldbookEntriesByProject as jest.Mock).mockResolvedValue([]);
  (db.getNotesByProject as jest.Mock).mockResolvedValue([]);
  (db.getNotesContentByIds as jest.Mock).mockResolvedValue({});
  (db.getAllNotes as jest.Mock).mockResolvedValue([]);
  (db.getNoteStyleProfile as jest.Mock).mockResolvedValue(null);
});

test('V7 style uses frozen Style Profiles and styleWeights, matching V6 merge semantics', () => {
  const result = compileNoteDetailCandidatesFromSnapshot({
    notes: [
      noteRecord(1, '风格样本', '原文一', {
        profileText: '缓存画像一',
        profileJson: JSON.stringify({
          sentence_structure: '短句',
          tone_emotion: '冷峻',
          vocabulary: '书面',
          character_voice: '第三人称',
          narrative_rhythm: '紧凑',
        }),
        sourceHash: 'hash-1',
      }),
      noteRecord(2, '风格样本二', '原文二', {
        profileText: '缓存画像二',
        profileJson: JSON.stringify({
          sentence_structure: '长句',
          tone_emotion: '克制',
          vocabulary: '口语',
          character_voice: '第一人称',
          narrative_rhythm: '舒缓',
        }),
        sourceHash: 'hash-2',
      }),
    ],
    noteConfig: {
      mode: 'style',
      enabledNoteIds: [1, 2],
      styleWeights: {
        sentence_structure: 0,
        tone_emotion: 3,
        vocabulary: 0,
        character_voice: 1,
        narrative_rhythm: 0,
      },
    },
    haystack: haystack,
  });

  expect(result.candidates).toHaveLength(1);
  const text = result.candidates[0].content;
  expect(text).toContain('语气与情感');
  expect(text).toContain('严格遵循');
  expect(text).toContain('冷峻 / 克制');
  expect(text).toContain('角色设定');
  expect(text).toContain('适当参考');
  expect(text).not.toContain('句式结构');
  expect(text).not.toContain('常用词汇与搭配');
  expect(text).not.toContain('叙事节奏');
  expect(result.styleNotePresent).toBe(true);
});

test('V7 style snapshot freezes profile values and performs no Note DB reads during compile', async () => {
  const body = '风格样本正文';
  const row = { id: 31, title: '风格笔记', updated_at: 'v1' };
  (db.getProjectNoteConfig as jest.Mock).mockResolvedValue({
    mode: 'style',
    styleWeights: {
      sentence_structure: 2,
      tone_emotion: 0,
      vocabulary: 1,
      character_voice: 2,
      narrative_rhythm: 2,
    },
    retrievalTopK: 5,
    retrievalFragmentChars: 200,
    enabledNoteIds: [31],
  });
  (db.getNotesByProject as jest.Mock).mockResolvedValue([row]);
  (db.getNotesContentByIds as jest.Mock).mockResolvedValue({ 31: body });
  (db.getNoteStyleProfile as jest.Mock).mockResolvedValue({
    noteId: 31,
    profileText: '缓存画像',
    profileJson: JSON.stringify({
      sentence_structure: '短句',
      tone_emotion: '冷峻',
      vocabulary: '书面',
      character_voice: '第三人称',
      narrative_rhythm: '紧凑',
    }),
    sourceHash: computeNoteSourceHash(body),
  });

  const snapshot = await captureResourceSourceSnapshot(7, {
    includeResources: true,
    noteQuery: {
      chapterTitle: '',
      chapterSynopsis: '',
      previousEnding: '',
      userPrompt: '',
    },
  });
  expect(snapshot.notes[0].styleProfile?.profileText).toBe('缓存画像');
  const readCounts = {
    notes: (db.getNotesByProject as jest.Mock).mock.calls.length,
    contents: (db.getNotesContentByIds as jest.Mock).mock.calls.length,
    profiles: (db.getNoteStyleProfile as jest.Mock).mock.calls.length,
  };
  (db.getNotesByProject as jest.Mock).mockImplementation(() => {
    throw new Error('post-snapshot read');
  });
  (db.getNotesContentByIds as jest.Mock).mockImplementation(() => {
    throw new Error('post-snapshot read');
  });
  (db.getNoteStyleProfile as jest.Mock).mockImplementation(() => {
    throw new Error('post-snapshot read');
  });

  const built = buildResourceContextV2({
    source: snapshot,
    haystack,
  });
  expect(built.details[0].content).toContain('短句');
  expect(built.details[0].content).not.toContain('冷峻');
  expect(db.getNotesByProject).toHaveBeenCalledTimes(readCounts.notes);
  expect(db.getNotesContentByIds).toHaveBeenCalledTimes(readCounts.contents);
  expect(db.getNoteStyleProfile).toHaveBeenCalledTimes(readCounts.profiles);
});

test('V6 live retrieval and V7 frozen retrieval return the same selected fragment semantics', async () => {
  const rows = [
    { id: 1, title: '笔记A', updated_at: 'a' },
    { id: 2, title: '笔记B', updated_at: 'b' },
  ];
  const bodies: Record<number, string> = {
    1: '雨夜的钟楼外有风。',
    2: '钟楼内部悬着一面旧钟，暗门藏在墙后。',
  };
  (db.getProjectNoteConfig as jest.Mock).mockResolvedValue({
    mode: 'retrieval',
    styleWeights: {},
    retrievalTopK: 5,
    retrievalFragmentChars: 200,
    enabledNoteIds: [1, 2],
  });
  (db.getNotesByProject as jest.Mock).mockResolvedValue(rows);
  (db.getAllNotes as jest.Mock).mockResolvedValue(rows);
  (db.getNoteContentById as jest.Mock).mockImplementation(
    async (id: number) => bodies[id],
  );
  const query = {
    chapterTitle: '钟楼',
    chapterSynopsis: '主角进入钟楼',
    previousEnding: '前文抵达钟楼',
    userPrompt: '描写钟楼内部',
  };
  const selected = {
    selected: [
      {
        noteId: 2,
        noteTitle: '伪标题',
        fragment: bodies[2],
        relevance: '内部设定命中',
      },
    ],
  };
  (callLLMResult as jest.Mock).mockResolvedValue({
    text: JSON.stringify(selected),
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
  });

  const legacy = await retrieveNoteFragments(7, query, 5);
  clearRetrievalCache(7);
  (db.getNotesContentByIds as jest.Mock).mockResolvedValue(bodies);
  const frozen = await captureResourceSourceSnapshot(7, {
    includeResources: true,
    noteQuery: query,
  });

  expect(frozen.noteRetrieval?.fragments).toEqual(
    legacy.map(fragment => ({
      noteId: fragment.noteId,
      noteTitle: fragment.noteTitle,
      fragment: fragment.fragment,
      relevance: fragment.relevance,
      retrievalScore: expect.any(Number),
    })),
  );
  expect(frozen.noteRetrieval?.fragments[0].noteTitle).toBe('笔记B');
  expect(frozen.noteRetrieval?.fragments[0].fragment).toBe(bodies[2]);

  const readsAtSnapshot = {
    characters: (db.getCharactersByProject as jest.Mock).mock.calls.length,
    worldbook: (db.getWorldbookEntriesByProject as jest.Mock).mock.calls.length,
    notes: (db.getNotesByProject as jest.Mock).mock.calls.length,
    noteContents: (db.getNotesContentByIds as jest.Mock).mock.calls.length,
  };
  (db.getCharactersByProject as jest.Mock).mockImplementation(() => {
    throw new Error('post-snapshot resource read');
  });
  (db.getWorldbookEntriesByProject as jest.Mock).mockImplementation(() => {
    throw new Error('post-snapshot resource read');
  });
  (db.getNotesByProject as jest.Mock).mockImplementation(() => {
    throw new Error('post-snapshot resource read');
  });
  (db.getNotesContentByIds as jest.Mock).mockImplementation(() => {
    throw new Error('post-snapshot resource read');
  });

  const built = buildResourceContextV2({
    source: frozen,
    haystack,
  });
  expect(built.details[0].content).toContain(bodies[2]);
  expect(db.getCharactersByProject).toHaveBeenCalledTimes(readsAtSnapshot.characters);
  expect(db.getWorldbookEntriesByProject).toHaveBeenCalledTimes(readsAtSnapshot.worldbook);
  expect(db.getNotesByProject).toHaveBeenCalledTimes(readsAtSnapshot.notes);
  expect(db.getNotesContentByIds).toHaveBeenCalledTimes(readsAtSnapshot.noteContents);
});

test('V7 original Note mode remains literal frozen-body injection', () => {
  const result = compileNoteDetailCandidatesFromSnapshot({
    notes: [noteRecord(10, '普通笔记', '原始资料正文')],
    noteConfig: { mode: 'none', enabledNoteIds: [] },
    haystack,
  });
  expect(result.warnings).toHaveLength(0);
  expect(result.candidates[0].content).toBe('笔记「普通笔记」：原始资料正文');
});

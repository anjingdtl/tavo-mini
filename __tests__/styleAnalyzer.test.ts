/* eslint-env jest */

jest.mock('../src/services/database', () => ({
  getNoteContentById: jest.fn(async () => '测试文本内容'),
  computeNoteSourceHash: jest.fn(async (c: string) => 'hash_' + c.length),
  getNoteStyleProfile: jest.fn(async () => null),
  setNoteStyleProfile: jest.fn(async () => undefined),
}));
jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(async () => ({
    text: '{"sentence_structure":"短句为主","tone_emotion":"冷峻","vocabulary":"书面语","character_voice":"第三人称","narrative_rhythm":"紧凑"}',
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
  })),
}));

import { analyzeNoteStyle, getOrAnalyzeNoteStyle, mergeStyleProfiles, DEFAULT_STYLE_WEIGHTS } from '../src/services/styleAnalyzer';
import * as db from '../src/services/database';
import { callLLMResult } from '../src/services/llm';

beforeEach(() => jest.clearAllMocks());

test('analyzeNoteStyle calls LLM and caches profile', async () => {
  const profile = await analyzeNoteStyle(1);
  expect(profile.profileJson.sentence_structure).toBe('短句为主');
  expect(profile.profileText).toContain('句式结构');
  expect(db.setNoteStyleProfile).toHaveBeenCalledWith(1, expect.any(String), expect.any(String), expect.any(String));
});

test('getOrAnalyzeNoteStyle returns cache when hash matches', async () => {
  (db.getNoteStyleProfile as jest.Mock).mockResolvedValueOnce({
    noteId: 1,
    profileText: '缓存画像',
    profileJson: '{"sentence_structure":"cached"}',
    analyzedAt: new Date().toISOString(),
    sourceHash: 'hash_6',
  });
  (db.computeNoteSourceHash as jest.Mock).mockResolvedValueOnce('hash_6');
  (db.getNoteContentById as jest.Mock).mockResolvedValueOnce('测试文本内容');

  const profile = await getOrAnalyzeNoteStyle(1);
  expect(profile.profileText).toBe('缓存画像');
  expect(callLLMResult).not.toHaveBeenCalled();
});

test('getOrAnalyzeNoteStyle re-analyzes when hash mismatch', async () => {
  (db.getNoteStyleProfile as jest.Mock).mockResolvedValueOnce({
    noteId: 2,
    profileText: '旧画像',
    profileJson: '{}',
    analyzedAt: new Date().toISOString(),
    sourceHash: 'old_hash',
  });
  // getOrAnalyzeNoteStyle 和 analyzeNoteStyle 都会调用，统一返回 new_hash
  (db.computeNoteSourceHash as jest.Mock).mockResolvedValue('new_hash');

  const profile = await getOrAnalyzeNoteStyle(2);
  expect(callLLMResult).toHaveBeenCalled();
  expect(profile.sourceHash).toBe('new_hash');
});

test('mergeStyleProfiles respects weight 0 (skip) and weight 3 (strict)', () => {
  const profiles = [
    {
      profileText: '',
      profileJson: {
        sentence_structure: '短句',
        tone_emotion: '冷峻',
        vocabulary: '书面',
        character_voice: '第三人称',
        narrative_rhythm: '快',
      },
      sourceHash: '',
    },
  ];
  const weights = { ...DEFAULT_STYLE_WEIGHTS, vocabulary: 0, character_voice: 3 };
  const merged = mergeStyleProfiles(profiles, weights as any);
  expect(merged).not.toContain('常用词汇与搭配');
  expect(merged).toContain('严格遵循');
  expect(merged).toContain('句式结构');
});

test('mergeStyleProfiles merges multiple profiles', () => {
  const profiles = [
    {
      profileText: '',
      profileJson: { sentence_structure: '短句', tone_emotion: '', vocabulary: '', character_voice: '', narrative_rhythm: '' },
      sourceHash: '',
    },
    {
      profileText: '',
      profileJson: { sentence_structure: '长句', tone_emotion: '', vocabulary: '', character_voice: '', narrative_rhythm: '' },
      sourceHash: '',
    },
  ];
  const merged = mergeStyleProfiles(profiles, { ...DEFAULT_STYLE_WEIGHTS, tone_emotion: 0, vocabulary: 0, character_voice: 0, narrative_rhythm: 0 } as any);
  expect(merged).toContain('短句');
  expect(merged).toContain('长句');
});

test('analyzeNoteStyle handles invalid LLM response gracefully', async () => {
  (callLLMResult as jest.Mock).mockResolvedValueOnce({ text: 'not json at all', inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  const profile = await analyzeNoteStyle(3);
  expect(profile.profileText).toBe('');
  expect(profile.profileJson.sentence_structure).toBe('');
});

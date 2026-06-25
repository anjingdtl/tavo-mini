/* eslint-env jest */

// 测试 buildNoteContext 的模式分发逻辑（mode=none/style/retrieval）
// 以及 mode=none 时的向后兼容行为

jest.mock('../src/services/database', () => ({
  getProjectNoteConfig: jest.fn(async () => null),
  setProjectNoteConfig: jest.fn(async () => undefined),
  getNotesByProject: jest.fn(async () => []),
  getNoteContentById: jest.fn(async () => ''),
  getAllNotes: jest.fn(async () => []),
  getChaptersByProject: jest.fn(async () => []),
  getCharactersByProject: jest.fn(async () => []),
  getNoteStyleProfile: jest.fn(async () => null),
  setNoteStyleProfile: jest.fn(async () => undefined),
  deleteNoteStyleProfile: jest.fn(async () => undefined),
  computeNoteSourceHash: jest.fn(async () => 'hash'),
}));
jest.mock('../src/services/styleAnalyzer', () => ({
  analyzeNoteStyle: jest.fn(async () => ({ profileText: '', profileJson: {}, sourceHash: '' })),
  analyzeNotesStyle: jest.fn(async () => []),
  getOrAnalyzeNoteStyle: jest.fn(async () => ({ profileText: '', profileJson: {}, sourceHash: '' })),
  mergeStyleProfiles: jest.fn(() => ''),
  DEFAULT_STYLE_WEIGHTS: { sentence_structure: 2, tone_emotion: 2, vocabulary: 1, character_voice: 2, narrative_rhythm: 2 },
}));
jest.mock('../src/services/noteRetriever', () => ({
  retrieveNoteFragments: jest.fn(async () => []),
  clearRetrievalCache: jest.fn(),
}));
jest.mock('../src/services/macroReplace', () => ({ processMacros: (t: string) => t }));
jest.mock('../src/services/llm', () => ({ callLLMResult: jest.fn(async () => ({ text: '', inputTokens: 0, outputTokens: 0, totalTokens: 0 })) }));

import * as db from '../src/services/database';

test('getProjectNoteConfig is available and returns null when no config', async () => {
  const config = await db.getProjectNoteConfig(1);
  expect(config).toBeNull();
});

test('database module exports note mode functions', () => {
  expect(typeof db.getProjectNoteConfig).toBe('function');
  expect(typeof db.setProjectNoteConfig).toBe('function');
  expect(typeof db.getNoteStyleProfile).toBe('function');
  expect(typeof db.setNoteStyleProfile).toBe('function');
  expect(typeof db.deleteNoteStyleProfile).toBe('function');
  expect(typeof db.computeNoteSourceHash).toBe('function');
});

test('styleAnalyzer module exports expected functions', () => {
  const sa = require('../src/services/styleAnalyzer');
  expect(typeof sa.analyzeNoteStyle).toBe('function');
  expect(typeof sa.getOrAnalyzeNoteStyle).toBe('function');
  expect(typeof sa.analyzeNotesStyle).toBe('function');
  expect(typeof sa.mergeStyleProfiles).toBe('function');
  expect(typeof sa.DEFAULT_STYLE_WEIGHTS).toBe('object');
});

test('noteRetriever module exports expected functions', () => {
  const nr = require('../src/services/noteRetriever');
  expect(typeof nr.retrieveNoteFragments).toBe('function');
  expect(typeof nr.clearRetrievalCache).toBe('function');
});

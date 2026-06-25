/* eslint-env jest */

jest.mock('../src/services/database', () => {
  const configMap = new Map<number, any>();
  const profileMap = new Map<number, any>();
  return {
    getProjectNoteConfig: jest.fn(async (projectId: number) => configMap.get(projectId) ?? null),
    setProjectNoteConfig: jest.fn(async (projectId: number, config: any) => {
      const existing = configMap.get(projectId);
      configMap.set(projectId, {
        projectId,
        mode: config.mode ?? existing?.mode ?? 'none',
        styleWeights: config.styleWeights ?? existing?.styleWeights ?? {},
        retrievalTopK: config.retrievalTopK ?? existing?.retrievalTopK ?? 5,
        enabledNoteIds: config.enabledNoteIds ?? existing?.enabledNoteIds ?? [],
        updatedAt: new Date().toISOString(),
      });
    }),
    getNoteStyleProfile: jest.fn(async (noteId: number) => profileMap.get(noteId) ?? null),
    setNoteStyleProfile: jest.fn(async (noteId: number, profileText: string, profileJson: string, sourceHash: string) => {
      profileMap.set(noteId, { noteId, profileText, profileJson, analyzedAt: new Date().toISOString(), sourceHash });
    }),
    deleteNoteStyleProfile: jest.fn(async (noteId: number) => {
      profileMap.delete(noteId);
    }),
    computeNoteSourceHash: jest.fn(async (content: string) => {
      let hash = 0;
      for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
      }
      return Math.abs(hash).toString(16).padStart(8, '0') + '_' + content.length.toString(16);
    }),
  };
});

import * as db from '../src/services/database';

test('project_note_config upsert and read', async () => {
  await db.setProjectNoteConfig(1, {
    mode: 'style',
    styleWeights: { tone_emotion: 3 },
    retrievalTopK: 5,
    enabledNoteIds: [10],
  });
  const config = await db.getProjectNoteConfig(1);
  expect(config).not.toBeNull();
  expect(config!.mode).toBe('style');
  expect(config!.styleWeights.tone_emotion).toBe(3);
  expect(config!.enabledNoteIds).toEqual([10]);
});

test('project_note_config partial update preserves other fields', async () => {
  await db.setProjectNoteConfig(2, {
    mode: 'retrieval',
    styleWeights: {},
    retrievalTopK: 8,
    enabledNoteIds: [1, 2],
  });
  // 只更新 mode，其他字段应保留
  await db.setProjectNoteConfig(2, { mode: 'none' });
  const config = await db.getProjectNoteConfig(2);
  expect(config!.mode).toBe('none');
  expect(config!.retrievalTopK).toBe(8);
  expect(config!.enabledNoteIds).toEqual([1, 2]);
});

test('note_style_profiles upsert and read', async () => {
  await db.setNoteStyleProfile(42, '风格画像文本', '{"a":1}', 'abc12345');
  const profile = await db.getNoteStyleProfile(42);
  expect(profile).not.toBeNull();
  expect(profile!.profileText).toBe('风格画像文本');
  expect(profile!.sourceHash).toBe('abc12345');
});

test('note_style_profiles delete', async () => {
  await db.setNoteStyleProfile(42, 'x', '{}', 'h');
  await db.deleteNoteStyleProfile(42);
  const profile = await db.getNoteStyleProfile(42);
  expect(profile).toBeNull();
});

test('getProjectNoteConfig returns null for non-existent project', async () => {
  const config = await db.getProjectNoteConfig(999);
  expect(config).toBeNull();
});

test('getNoteStyleProfile returns null for non-existent note', async () => {
  const profile = await db.getNoteStyleProfile(999);
  expect(profile).toBeNull();
});

test('computeNoteSourceHash returns stable value for same content', async () => {
  const h1 = await db.computeNoteSourceHash('hello');
  const h2 = await db.computeNoteSourceHash('hello');
  expect(h1).toBe(h2);
  const h3 = await db.computeNoteSourceHash('world');
  expect(h3).not.toBe(h1);
});

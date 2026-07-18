import {
  createEmptyChapterMemoryPatch,
  createEmptyStoryMemory,
} from '../src/services/storyMemory/storyMemoryDefaults';
import { canonicalStringify } from '../src/services/storyMemory/storyMemoryFingerprint';
import { applyStoryMemoryPatch } from '../src/services/storyMemory/storyMemoryMerger';
import type { ChapterMemoryPatchDraft } from '../src/services/storyMemory/storyMemoryTypes';
import { validateChapterMemoryPatch } from '../src/services/storyMemory/storyMemoryValidator';

function firstPatch(): ChapterMemoryPatchDraft {
  const patch = createEmptyChapterMemoryPatch({
    chapterId: 1,
    chapterPosition: 0,
    title: '第一章',
  });
  patch.episodicSummary.brief = '林岚发现暗门。';
  patch.newCharacters.push({
    tempRef: 'new_char_1',
    canonicalName: '林岚',
    aliases: ['小岚', '小岚'],
    role: '守夜人',
    identity: '调查员',
    stableTraits: ['冷静'],
    initialState: { location: '钟楼', knowledge: ['暗门存在'] },
    status: 'active',
    evidenceQuote: '林岚发现暗门',
  });
  patch.newCharacters.push({
    tempRef: 'new_char_2',
    canonicalName: '周恪',
    aliases: [],
    role: '记者',
    identity: '旧报记者',
    stableTraits: ['敏锐'],
    initialState: { location: '钟楼' },
    status: 'active',
    evidenceQuote: '周恪赶到钟楼',
  });
  patch.newRelationships.push({
    tempRef: 'new_rel_1',
    fromRef: 'new_char_2',
    toRef: 'new_char_1',
    direction: 'bidirectional',
    relationType: '盟友',
    currentState: '共同调查',
    trustLevel: 'medium',
    publicStatus: '同事',
    hiddenStatus: '',
    reason: '共同发现暗门',
    evidenceQuote: '两人决定共同调查',
  });
  patch.mainlinePatch.threadOpens.push({
    ref: 'new_thread_1',
    title: '暗门通向何处',
    description: '调查暗门',
    priority: 'critical',
    evidenceQuote: '暗门深处传来钟声',
  });
  return patch;
}

const context = {
  projectId: 7,
  chapterId: 1,
  chapterPosition: 0,
  sourceFingerprint: 'source-one',
  now: '2026-07-18T00:00:00.000Z',
};

describe('deterministic story memory merger', () => {
  it('creates stable characters, normalizes aliases and relationship direction', () => {
    const result = applyStoryMemoryPatch(
      createEmptyStoryMemory(7),
      firstPatch(),
      context,
    );
    const characters = Object.values(result.state.characters);
    const relationship = Object.values(result.state.relationships)[0];
    expect(characters).toHaveLength(2);
    expect(
      characters.find(item => item.canonicalName === '林岚')?.aliases,
    ).toEqual(['小岚']);
    expect(relationship.fromCharacterId < relationship.toCharacterId).toBe(
      true,
    );
    expect(Object.values(result.state.mainline.openThreads)[0].priority).toBe(
      'critical',
    );
  });

  it('updates character sets and resolves an open thread', () => {
    const first = applyStoryMemoryPatch(
      createEmptyStoryMemory(7),
      firstPatch(),
      context,
    );
    const characterId = Object.values(first.state.characters).find(
      item => item.canonicalName === '林岚',
    )!.id;
    const threadId = Object.keys(first.state.mainline.openThreads)[0];
    const patch = createEmptyChapterMemoryPatch({
      chapterId: 2,
      chapterPosition: 1,
      title: '第二章',
    });
    patch.characterUpdates.push({
      characterRef: characterId,
      addAliases: ['林调查员'],
      profileCorrections: {},
      stateChanges: { location: '地下档案室' },
      correctionReason: '',
      addKnowledge: ['暗门通往档案室'],
      removeKnowledge: ['暗门存在'],
      addPossessions: ['银钥匙'],
      removePossessions: [],
      addSecrets: [],
      removeSecrets: [],
      clearFields: [],
      evidenceQuote: '林岚进入地下档案室',
    });
    patch.mainlinePatch.threadResolutions.push({
      threadRef: threadId,
      resolution: '暗门通往地下档案室',
      evidenceQuote: '暗门通往地下档案室',
    });
    const result = applyStoryMemoryPatch(first.state, patch, {
      ...context,
      chapterId: 2,
      chapterPosition: 1,
      sourceFingerprint: 'source-two',
    });
    expect(result.state.characters[characterId].currentState).toEqual(
      expect.objectContaining({
        location: '地下档案室',
        knowledge: ['暗门通往档案室'],
        possessions: ['银钥匙'],
      }),
    );
    expect(result.state.mainline.openThreads[threadId]).toBeUndefined();
    expect(result.state.mainline.recentResolvedThreads[0].id).toBe(threadId);
  });

  it('merges provider output that omits empty character-update fields', () => {
    const first = applyStoryMemoryPatch(
      createEmptyStoryMemory(7),
      firstPatch(),
      context,
    );
    const characterId = Object.values(first.state.characters)[0].id;
    const patch = createEmptyChapterMemoryPatch({
      chapterId: 2,
      chapterPosition: 1,
      title: '第二章',
    });
    patch.characterUpdates.push({
      characterRef: characterId,
      addAliases: undefined as unknown as string[],
      profileCorrections: undefined as unknown as {},
      stateChanges: { location: '地下档案室' },
      correctionReason: undefined as unknown as string,
      addKnowledge: undefined as unknown as string[],
      removeKnowledge: undefined as unknown as string[],
      addPossessions: undefined as unknown as string[],
      removePossessions: undefined as unknown as string[],
      addSecrets: undefined as unknown as string[],
      removeSecrets: undefined as unknown as string[],
      clearFields: undefined as unknown as string[],
      evidenceQuote: '林岚进入地下档案室',
    });
    const validated = validateChapterMemoryPatch(
      patch,
      first.state,
      '林岚进入地下档案室。',
    );

    expect(() =>
      applyStoryMemoryPatch(first.state, validated, {
        ...context,
        chapterId: 2,
        chapterPosition: 1,
        sourceFingerprint: 'source-provider-omissions',
      }),
    ).not.toThrow();
  });

  it('is idempotent and deterministic across replay', () => {
    const initial = createEmptyStoryMemory(7);
    const first = applyStoryMemoryPatch(initial, firstPatch(), context);
    const repeated = applyStoryMemoryPatch(first.state, firstPatch(), context);
    const replay = applyStoryMemoryPatch(
      createEmptyStoryMemory(7),
      firstPatch(),
      context,
    );
    expect(repeated.state).toBe(first.state);
    expect(canonicalStringify(replay.state)).toBe(
      canonicalStringify(first.state),
    );
  });

  it('rejects a stale base fingerprint and earlier chapter position', () => {
    expect(() =>
      applyStoryMemoryPatch(createEmptyStoryMemory(7), firstPatch(), {
        ...context,
        baseMemoryFingerprint: 'stale',
      }),
    ).toThrow('基础指纹不匹配');
    const first = applyStoryMemoryPatch(
      createEmptyStoryMemory(7),
      firstPatch(),
      context,
    );
    const earlierPatch = firstPatch();
    earlierPatch.chapterRef.chapterPosition = -1;
    expect(() =>
      applyStoryMemoryPatch(first.state, earlierPatch, {
        ...context,
        chapterPosition: -1,
      }),
    ).toThrow('早于当前故事记忆进度');
  });
});

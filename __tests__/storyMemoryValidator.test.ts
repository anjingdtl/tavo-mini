import {
  createEmptyChapterMemoryPatch,
  createEmptyStoryMemory,
} from '../src/services/storyMemory/storyMemoryDefaults';
import {
  validateChapterMemoryPatch,
  validateEvidenceQuote,
  validateEntityReferences,
} from '../src/services/storyMemory/storyMemoryValidator';

describe('story memory patch validation', () => {
  it('normalizes whitespace but rejects missing, punctuation, and oversized evidence', () => {
    expect(validateEvidenceQuote('林岚  推开暗门。', '林岚 推开暗门')).toBe(true);
    expect(validateEvidenceQuote('林岚推开暗门。', '暗门不存在')).toBe(false);
    expect(validateEvidenceQuote('……', '……')).toBe(false);
    expect(validateEvidenceQuote('甲'.repeat(100), '甲'.repeat(81))).toBe(false);
  });

  it('rejects unknown references and immutable profile changes without a reason', () => {
    const state = createEmptyStoryMemory(7);
    const patch = createEmptyChapterMemoryPatch({
      chapterId: 1,
      chapterPosition: 0,
      title: '第一章',
    });
    patch.characterUpdates.push({
      characterRef: 'missing',
      addAliases: [],
      profileCorrections: { identity: '新身份' },
      stateChanges: {},
      correctionReason: '',
      addKnowledge: [],
      removeKnowledge: [],
      addPossessions: [],
      removePossessions: [],
      addSecrets: [],
      removeSecrets: [],
      clearFields: [],
      evidenceQuote: '林岚公开了新身份',
    });
    expect(() => validateEntityReferences(patch, state)).toThrow('人物引用不存在');
  });

  it('accepts a fully shaped patch with grounded evidence', () => {
    const state = createEmptyStoryMemory(7);
    const patch = createEmptyChapterMemoryPatch({
      chapterId: 1,
      chapterPosition: 0,
      title: '第一章',
    });
    patch.newCharacters.push({
      tempRef: 'new_char_1',
      canonicalName: '林岚',
      aliases: [],
      role: '守夜人',
      identity: '调查员',
      stableTraits: ['冷静'],
      initialState: { location: '钟楼' },
      status: 'active',
      evidenceQuote: '林岚推开钟楼暗门',
    });
    expect(
      validateChapterMemoryPatch(patch, state, '雨夜里，林岚推开钟楼暗门。'),
    ).toBe(patch);
  });
});

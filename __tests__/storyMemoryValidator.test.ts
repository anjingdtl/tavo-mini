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
    expect(validateEvidenceQuote('林岚  推开暗门。', '林岚 推开暗门')).toBe(
      true,
    );
    expect(validateEvidenceQuote('林岚推开暗门。', '暗门不存在')).toBe(false);
    expect(
      validateEvidenceQuote(
        '石璐和世恒是同事，也是长期搭档。',
        '石璐与世恒是同事，也是长期搭档',
      ),
    ).toBe(true);
    expect(
      validateEvidenceQuote(
        '石璐和世恒是同事，也是长期搭档。',
        '石璐辞职后独自离开了这座城市',
      ),
    ).toBe(false);
    expect(
      validateEvidenceQuote(
        '石璐在雨夜推开钟楼暗门，发现一封信。',
        '“石璐在雨夜推开钟楼暗门。”',
      ),
    ).toBe(true);
    expect(validateEvidenceQuote('……', '……')).toBe(false);
    expect(validateEvidenceQuote('甲'.repeat(100), '甲'.repeat(81))).toBe(
      false,
    );
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
    expect(() => validateEntityReferences(patch, state)).toThrow(
      '人物引用不存在',
    );
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

  it('accepts unique Unicode character refs but rejects unsafe refs', () => {
    const state = createEmptyStoryMemory(7);
    const patch = createEmptyChapterMemoryPatch({
      chapterId: 1,
      chapterPosition: 0,
      title: '第一章',
    });
    const newCharacter = {
      tempRef: 'new_char_石璐',
      canonicalName: '石璐',
      aliases: [],
      role: '调查员',
      identity: '',
      stableTraits: [],
      initialState: {},
      status: 'active' as const,
      evidenceQuote: '石璐推开钟楼暗门',
    };
    patch.newCharacters.push(newCharacter);

    expect(() => validateEntityReferences(patch, state)).not.toThrow();

    patch.newCharacters[0] = { ...newCharacter, tempRef: 'new_char_石璐!' };
    expect(() => validateEntityReferences(patch, state)).toThrow(
      '后缀只能包含中英文字母、数字、下划线或连字符',
    );
  });

  it('deterministically disambiguates duplicate refs and rewrites relationships', () => {
    const state = createEmptyStoryMemory(7);
    const patch = createEmptyChapterMemoryPatch({
      chapterId: 1,
      chapterPosition: 0,
      title: '第一章',
    });
    const character = (canonicalName: string, evidenceQuote: string) => ({
      tempRef: 'new_char_人物',
      canonicalName,
      aliases: [],
      role: '同事',
      identity: '',
      stableTraits: [],
      initialState: {},
      status: 'active' as const,
      evidenceQuote,
    });
    patch.newCharacters.push(
      character('石璐', '石璐推了推金丝眼镜'),
      character('世恒', '世恒从电脑屏幕上抬起头'),
    );
    patch.newRelationships.push({
      tempRef: 'new_rel_同事',
      fromRef: 'new_char_人物',
      toRef: 'new_char_人物',
      direction: 'bidirectional',
      relationType: '同事',
      currentState: '共同加班',
      trustLevel: 'medium',
      publicStatus: '同事',
      hiddenStatus: '',
      reason: '两人在办公室共同加班',
      evidenceQuote: '石璐和世恒是同事',
    });

    const validated = validateChapterMemoryPatch(
      patch,
      state,
      '石璐和世恒是同事。石璐推了推金丝眼镜，世恒从电脑屏幕上抬起头。',
    );
    expect(validated.newCharacters.map(item => item.tempRef)).toEqual([
      'new_char_石璐',
      'new_char_世恒',
    ]);
    expect(validated.newRelationships[0]).toEqual(
      expect.objectContaining({
        fromRef: 'new_char_石璐',
        toRef: 'new_char_世恒',
      }),
    );
  });

  it('grounds provider relationship aliases onto real character nodes', () => {
    const state = createEmptyStoryMemory(7);
    const patch = createEmptyChapterMemoryPatch({
      chapterId: 1,
      chapterPosition: 0,
      title: '第一章',
    });
    for (const name of ['石璐', '世恒']) {
      patch.newCharacters.push({
        tempRef: `new_char_${name}`,
        canonicalName: name,
        aliases: [],
        role: '同事',
        identity: '',
        stableTraits: [],
        initialState: {},
        status: 'active',
        evidenceQuote: `${name}留在办公室加班`,
      });
    }
    patch.newRelationships.push({
      tempRef: 'new_rel_同事',
      fromRef: '石璐',
      toRef: 'new_char_人物2',
      direction: 'bidirectional',
      relationType: '同事',
      currentState: '共同加班',
      trustLevel: 'medium',
      publicStatus: '同事',
      hiddenStatus: '',
      reason: '石璐和世恒共同加班',
      evidenceQuote: '石璐和世恒共同加班',
    });

    const validated = validateChapterMemoryPatch(
      patch,
      state,
      '石璐留在办公室加班，世恒留在办公室加班。石璐和世恒共同加班。',
    );
    expect(validated.newRelationships[0]).toEqual(
      expect.objectContaining({
        fromRef: 'new_char_石璐',
        toRef: 'new_char_世恒',
      }),
    );
  });

  it('merges duplicate extraction of the same named character', () => {
    const state = createEmptyStoryMemory(7);
    const patch = createEmptyChapterMemoryPatch({
      chapterId: 1,
      chapterPosition: 0,
      title: '第一章',
    });
    const base = {
      tempRef: 'new_char_重复',
      canonicalName: '石璐',
      aliases: ['小石'],
      role: '',
      identity: '',
      stableTraits: ['冷静'],
      initialState: {},
      status: 'active' as const,
      evidenceQuote: '石璐推开办公室的门',
    };
    patch.newCharacters.push(base, {
      ...base,
      aliases: ['石编辑'],
      role: '编辑',
      stableTraits: ['敏锐'],
    });

    const validated = validateChapterMemoryPatch(
      patch,
      state,
      '深夜里，石璐推开办公室的门。',
    );
    expect(validated.newCharacters).toHaveLength(1);
    expect(validated.newCharacters[0]).toEqual(
      expect.objectContaining({
        tempRef: 'new_char_石璐',
        aliases: ['小石', '石编辑'],
        role: '编辑',
        stableTraits: ['冷静', '敏锐'],
      }),
    );
  });

  it('supports a multi-character relationship graph and branched story threads', () => {
    const state = createEmptyStoryMemory(7);
    const patch = createEmptyChapterMemoryPatch({
      chapterId: 1,
      chapterPosition: 0,
      title: '第一章',
    });
    for (const name of ['石璐', '世恒', '林岚', '周遥']) {
      patch.newCharacters.push({
        tempRef: 'new_char_人物',
        canonicalName: name,
        aliases: [],
        role: '调查组成员',
        identity: '',
        stableTraits: [],
        initialState: {},
        status: 'active',
        evidenceQuote: `${name}加入调查组`,
      });
    }
    const relationship = (from: string, to: string, type: string) => ({
      tempRef: `new_rel_${from}_${to}`,
      fromRef: 'new_char_人物',
      toRef: 'new_char_人物',
      direction: 'bidirectional' as const,
      relationType: type,
      currentState: type,
      trustLevel: 'medium' as const,
      publicStatus: type,
      hiddenStatus: '',
      reason: `${from}和${to}${type}`,
      evidenceQuote: `${from}和${to}${type}`,
    });
    patch.newRelationships.push(
      relationship('石璐', '世恒', '是搭档'),
      relationship('世恒', '林岚', '共同追查线索'),
      relationship('林岚', '周遥', '彼此怀疑'),
    );
    patch.mainlinePatch.threadOpens.push(
      {
        ref: 'new_thread_档案',
        title: '失踪档案线',
        description: '石璐和世恒追查失踪档案',
        ownerCharacterRefs: ['new_char_人物'],
        priority: 'high',
        evidenceQuote: '石璐和世恒追查失踪档案',
      },
      {
        ref: 'new_thread_内鬼',
        title: '内鬼疑云线',
        description: '林岚和周遥调查内鬼',
        ownerCharacterRefs: ['new_char_人物'],
        priority: 'normal',
        evidenceQuote: '林岚和周遥调查内鬼',
      },
    );

    const content =
      '石璐加入调查组，世恒加入调查组，林岚加入调查组，周遥加入调查组。' +
      '石璐和世恒是搭档，世恒和林岚共同追查线索，林岚和周遥彼此怀疑。' +
      '石璐和世恒追查失踪档案；林岚和周遥调查内鬼。';
    const validated = validateChapterMemoryPatch(patch, state, content);

    expect(validated.newCharacters.map(item => item.tempRef)).toEqual([
      'new_char_石璐',
      'new_char_世恒',
      'new_char_林岚',
      'new_char_周遥',
    ]);
    expect(
      validated.newRelationships.map(item => [item.fromRef, item.toRef]),
    ).toEqual([
      ['new_char_石璐', 'new_char_世恒'],
      ['new_char_世恒', 'new_char_林岚'],
      ['new_char_林岚', 'new_char_周遥'],
    ]);
    expect(validated.mainlinePatch.threadOpens[0].ownerCharacterRefs).toEqual([
      'new_char_石璐',
      'new_char_世恒',
    ]);
    expect(validated.mainlinePatch.threadOpens[1].ownerCharacterRefs).toEqual([
      'new_char_林岚',
      'new_char_周遥',
    ]);
  });

  it('normalizes omitted semantically-empty fields from compatible providers', () => {
    const state = createEmptyStoryMemory(7);
    const patch = createEmptyChapterMemoryPatch({
      chapterId: 1,
      chapterPosition: 0,
      title: '第一章',
    });
    patch.newCharacters.push({
      tempRef: 'new_char_石璐',
      canonicalName: undefined as unknown as string,
      aliases: undefined as unknown as string[],
      role: undefined as unknown as string,
      identity: undefined as unknown as string,
      stableTraits: undefined as unknown as string[],
      initialState: undefined as unknown as {},
      status: undefined as unknown as 'active',
      evidenceQuote: '石璐推开钟楼暗门',
    });
    patch.newRelationships.push({
      tempRef: 'new_rel_同事',
      fromRef: 'new_char_石璐',
      toRef: 'new_char_世恒',
      direction: undefined as unknown as 'bidirectional',
      relationType: undefined as unknown as string,
      currentState: undefined as unknown as string,
      trustLevel: undefined as unknown as 'unknown',
      publicStatus: undefined as unknown as string,
      hiddenStatus: undefined as unknown as string,
      reason: undefined as unknown as string,
      evidenceQuote: '石璐和世恒是同事',
    });
    patch.newCharacters.push({
      tempRef: 'new_char_世恒',
      canonicalName: '世恒',
      aliases: [],
      role: '',
      identity: '',
      stableTraits: [],
      initialState: {},
      status: 'active',
      evidenceQuote: '石璐和世恒是同事',
    });

    const validated = validateChapterMemoryPatch(
      patch,
      state,
      '雨夜里，石璐推开钟楼暗门。石璐和世恒是同事。',
    );
    expect(validated.newCharacters[0]).toEqual(
      expect.objectContaining({
        aliases: [],
        canonicalName: '石璐',
        role: '',
        identity: '',
        stableTraits: [],
        initialState: expect.objectContaining({
          location: '',
          knowledge: [],
        }),
        status: 'active',
      }),
    );
    expect(validated.newRelationships[0]).toEqual(
      expect.objectContaining({
        direction: 'bidirectional',
        relationType: '',
        currentState: '',
        trustLevel: 'unknown',
        publicStatus: '',
        hiddenStatus: '',
        reason: '',
      }),
    );
  });

  it('accepts common provider aliases and removes fully empty placeholders', () => {
    const state = createEmptyStoryMemory(7);
    const patch = createEmptyChapterMemoryPatch({
      chapterId: 1,
      chapterPosition: 0,
      title: '第一章',
    });
    patch.newCharacters.push(
      {} as never,
      {
        ref: 'new_char_石璐',
        name: '石璐',
        aliases: [],
        role: '',
        identity: '',
        stableTraits: [],
        initialState: {},
        status: 'active',
        evidence: '石璐留在办公室加班',
      } as never,
    );

    const validated = validateChapterMemoryPatch(
      patch,
      state,
      '石璐留在办公室加班。',
    );
    expect(validated.newCharacters).toHaveLength(1);
    expect(validated.newCharacters[0]).toEqual(
      expect.objectContaining({
        tempRef: 'new_char_石璐',
        canonicalName: '石璐',
        evidenceQuote: '石璐留在办公室加班',
      }),
    );
  });
});

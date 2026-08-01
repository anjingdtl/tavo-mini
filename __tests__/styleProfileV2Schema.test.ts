import {
  validateStyleProfileV2,
  type OriginalStyleProfileV2,
} from '../src/services/continuation/styleProfile/styleProfileV2Schema';

/** Build a fully valid V2 profile. Tests mutate copies to break specific fields. */
function validProfile(): OriginalStyleProfileV2 {
  return {
    schemaVersion: 2,
    summary: '冷峻克制的第三人称限制视角，短句为主，少用形容词。',
    global: {
      narrative: {
        person: '第三人称',
        focalization: '限制视角，跟随主角',
        narrativeDistance: '贴近主角内心',
        tenseAndTimeHandling: '过去时，顺叙为主',
        perspectiveSwitchRules: ['仅在分节时切换视角'],
      },
      syntax: {
        sentenceLengthPattern: '短句为主，平均 12-18 字',
        sentenceStructures: ['主谓宾', '少用从句'],
        punctuationHabits: ['逗号断句', '少用感叹号'],
        paragraphPattern: '单句成段较多',
      },
      diction: {
        register: '书面口语混合',
        concreteness: '具体名词为主',
        lexicalPreferences: ['动词驱动', '少用成语'],
        expressionsToAvoid: ['套话'],
      },
      tone: {
        baseline: '克制冷静',
        emotionalAmplitude: '低振幅',
        humorAndRestraint: '几乎不幽默',
      },
      rhythm: {
        scenePacing: '中速',
        expositionDensity: '低',
        transitionMethods: ['时间跳跃'],
        chapterEndingPatterns: ['悬念收束'],
      },
      description: {
        sensoryPriorities: ['视觉', '听觉'],
        environmentUsage: '点到为止',
        actionVsInteriorBalance: '动作多于心理',
        imageryHabits: ['白描'],
      },
      dialogue: {
        dialogueDensity: '中',
        turnLength: '短',
        attributionStyle: '只用说/道',
        subtextStyle: '潜台词明显',
        expositionAvoidance: ['不在对话中直接解释设定'],
      },
      informationReveal: {
        setupMethod: '前置细节',
        foreshadowingMethod: '环境暗示',
        suspenseMethod: '信息差',
      },
    },
    boundaryLocalDelta: {
      tone: '更紧张',
      pacing: '加快',
      sentenceAndParagraphShift: '句长略增',
      activeNarrativePatterns: ['追击', '对峙'],
    },
    sceneVariants: [
      {
        sceneType: 'action',
        instructions: ['短促动词链'],
        avoid: ['长描写'],
        confidence: 0.8,
      },
    ],
    characterVoices: [
      {
        canonCharacterId: 5,
        sourceName: '林凡',
        speechRegister: '冷淡简短',
        sentenceHabits: ['常用反问'],
        interactionHabits: ['不主动开口'],
        avoid: ['感叹号'],
        confidence: 0.7,
      },
    ],
    globalAvoid: ['大段抒情', 'AI 腔总结'],
    confidence: 0.82,
    coverage: {
      sourceChapterCount: 20,
      sampledChapterCount: 8,
      sampledKinds: ['opening', 'middle', 'boundary'],
    },
  };
}

describe('validateStyleProfileV2', () => {
  it('accepts a fully valid profile', () => {
    const result = validateStyleProfileV2(validProfile());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.profile?.global.narrative.person).toBe('第三人称');
  });

  it('coerces imageryHabits string to string array (LLM variance)', () => {
    const p = validProfile() as any;
    p.global.description.imageryHabits = '白描与留白';
    const result = validateStyleProfileV2(p);
    expect(result.ok).toBe(true);
    expect(result.profile?.global.description.imageryHabits).toEqual([
      '白描与留白',
    ]);
  });

  it('rejects a non-object top level', () => {
    const result = validateStyleProfileV2('not an object');
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('顶层必须是一个对象');
  });

  it('rejects wrong schemaVersion', () => {
    const p = validProfile();
    (p as unknown as { schemaVersion: number }).schemaVersion = 1;
    const result = validateStyleProfileV2(p);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('schemaVersion'))).toBe(true);
  });

  it('rejects empty summary (vague conclusions are not allowed)', () => {
    const p = validProfile();
    p.summary = '   ';
    const result = validateStyleProfileV2(p);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('summary'))).toBe(true);
  });

  it('rejects missing global.narrative sub-object', () => {
    const p = validProfile();
    (p.global.narrative as unknown as { person: unknown }).person = '';
    const result = validateStyleProfileV2(p);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('global.narrative.person'))).toBe(
      true,
    );
  });

  it('rejects an unknown sceneType', () => {
    const p = validProfile();
    p.sceneVariants[0].sceneType = 'explosion' as never;
    const result = validateStyleProfileV2(p);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(e => e.includes('sceneType')),
    ).toBe(true);
  });

  it('rejects sceneVariant confidence out of range', () => {
    const p = validProfile();
    p.sceneVariants[0].confidence = 1.5;
    const result = validateStyleProfileV2(p);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(e => e.includes('sceneVariants[0].confidence')),
    ).toBe(true);
  });

  it('rejects global confidence out of range', () => {
    const p = validProfile();
    p.confidence = -0.1;
    const result = validateStyleProfileV2(p);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('confidence'))).toBe(true);
  });

  it('accepts a character voice with null canonCharacterId', () => {
    const p = validProfile();
    p.characterVoices[0].canonCharacterId = null;
    const result = validateStyleProfileV2(p);
    expect(result.ok).toBe(true);
  });

  it('rejects sampledChapterCount greater than sourceChapterCount', () => {
    const p = validProfile();
    p.coverage.sourceChapterCount = 5;
    p.coverage.sampledChapterCount = 8;
    const result = validateStyleProfileV2(p);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(e => e.includes('sampledChapterCount')),
    ).toBe(true);
  });

  it('aggregates multiple errors in one pass (so one repair retry can address them all)', () => {
    const p = validProfile();
    p.summary = '';
    (p.global.narrative as unknown as { person: unknown }).person = 123;
    p.globalAvoid = 'not an array' as unknown as string[];
    const result = validateStyleProfileV2(p);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

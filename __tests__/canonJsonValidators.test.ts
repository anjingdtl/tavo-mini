import {
  parseExtractionResultJson,
  stripModelJson,
  validateExtractionResult,
  validateExtractionResultWithStats,
  normalizeExtractionItem,
  EXTRACTION_RESULT_SCHEMA_VERSION,
} from '../src/services/continuation/canon/canonJsonValidators';

describe('Canon extraction JSON validators (Spec §17.1)', () => {
  const valid = {
    schemaVersion: EXTRACTION_RESULT_SCHEMA_VERSION,
    worldRules: [
      {
        category: 'fundamental',
        title: '灵气复苏',
        description: '天地灵气回归',
        constraintLevel: 'hard',
        confidence: 0.9,
        evidence: [
          {
            chapterId: 1,
            chapterPosition: 0,
            charStart: 0,
            charEnd: 4,
            quotePreview: '灵气',
          },
        ],
      },
    ],
    characters: [
      {
        canonicalName: '林凡',
        aliases: ['小凡'],
        description: '主角',
        importance: 'primary',
        confidence: 0.8,
        evidence: [],
      },
    ],
    relationships: [],
    plotThreads: [],
    experiences: [],
    knowledge: [],
    states: [],
    timelineEvents: [],
  };

  it('accepts valid structured output', () => {
    const r = validateExtractionResult(valid);
    expect(r.worldRules).toHaveLength(1);
    expect(r.characters[0].canonicalName).toBe('林凡');
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n' + JSON.stringify(valid) + '\n```';
    expect(stripModelJson(raw)).toContain('"schemaVersion"');
    const r = parseExtractionResultJson(raw);
    expect(r.characters).toHaveLength(1);
  });

  it('recovers the JSON object when a provider adds prose or another JSON value', () => {
    const raw = `模型说明：{"ok":true}\n\n结果如下：\n${JSON.stringify(
      valid,
    )}\n\n调用结束`;
    const r = parseExtractionResultJson(raw);
    expect(r.characters[0].canonicalName).toBe('林凡');
  });

  it('recovers a JSON object that an OpenAI-compatible gateway encoded twice', () => {
    const raw = JSON.stringify(JSON.stringify(valid));
    const r = parseExtractionResultJson(raw);
    expect(r.characters[0].canonicalName).toBe('林凡');
  });

  it('keeps braces inside JSON strings intact while extracting the result', () => {
    const raw = `前缀 ${JSON.stringify({
      ...valid,
      worldRules: [
        { ...valid.worldRules[0], description: '规则文本含有 {花括号}。' },
      ],
    })} 后缀`;
    const r = parseExtractionResultJson(raw);
    expect(r.worldRules[0].description).toContain('{花括号}');
  });

  it('rejects wrong schema version', () => {
    expect(() =>
      validateExtractionResult({ ...valid, schemaVersion: 99 }),
    ).toThrow(/schema 版本/);
  });

  it('keeps invalid enums with a fallback but drops empty titles', () => {
    const r = validateExtractionResult({
      ...valid,
      worldRules: [
        { ...valid.worldRules[0], constraintLevel: 'nope' },
        { ...valid.worldRules[0], title: '  ' },
        valid.worldRules[0],
      ],
    });
    expect(r.worldRules).toHaveLength(2);
    expect(r.worldRules[0].constraintLevel).toBe('reference');
  });

  it('rejects illegal evidence ranges', () => {
    const r = validateExtractionResult({
      ...valid,
      worldRules: [
        {
          ...valid.worldRules[0],
          evidence: [
            {
              chapterId: 1,
              chapterPosition: 0,
              charStart: 10,
              charEnd: 5,
              quotePreview: 'x',
            },
            {
              chapterId: 1,
              chapterPosition: 0,
              charStart: 0,
              charEnd: 3,
              quotePreview: 'ok',
            },
          ],
        },
      ],
    });
    expect(r.worldRules[0].evidence).toHaveLength(1);
  });

  it('throws on non-JSON truncated output', () => {
    expect(() => parseExtractionResultJson('{not json')).toThrow(/合法 JSON/);
  });

  describe('field-name alias normalization (S3 fix)', () => {
    it('normalizes name→canonicalName for characters', () => {
      const normalized = normalizeExtractionItem('characters', {
        name: '林凡',
        importance: 'primary',
        evidence: [],
      });
      expect(normalized).toEqual(
        expect.objectContaining({ canonicalName: '林凡' }),
      );
    });

    it('normalizes source/from→sourceName and target/to→targetName for relationships', () => {
      const from = normalizeExtractionItem('relationships', {
        source: '林凡',
        target: '苏婉',
        publicStatus: 'public',
        evidence: [],
      });
      const fromAlt = normalizeExtractionItem('relationships', {
        from: '林凡',
        to: '苏婉',
        publicStatus: 'public',
        evidence: [],
      });
      expect(from).toEqual(
        expect.objectContaining({ sourceName: '林凡', targetName: '苏婉' }),
      );
      expect(fromAlt).toEqual(
        expect.objectContaining({ sourceName: '林凡', targetName: '苏婉' }),
      );
    });

    it('normalizes character→characterName for experiences/knowledge/states', () => {
      const exp = normalizeExtractionItem('experiences', {
        character: '林凡',
        title: '拜师',
        evidence: [],
      });
      const know = normalizeExtractionItem('knowledge', {
        character: '林凡',
        fact: '灵根',
        knowledgeState: 'known',
        evidence: [],
      });
      const st = normalizeExtractionItem('states', {
        character: '林凡',
        aliveState: 'alive',
        summary: 's',
        evidence: [],
      });
      expect(exp).toEqual(
        expect.objectContaining({ characterName: '林凡' }),
      );
      expect(know).toEqual(
        expect.objectContaining({ characterName: '林凡', factKey: '灵根' }),
      );
      expect(st).toEqual(expect.objectContaining({ characterName: '林凡' }));
    });

    it('normalizes key|event→eventKey for timelineEvents', () => {
      const byKey = normalizeExtractionItem('timelineEvents', {
        key: 'evt-1',
        title: '拜师',
        evidence: [],
      });
      const byEvent = normalizeExtractionItem('timelineEvents', {
        event: 'evt-2',
        title: '渡劫',
        evidence: [],
      });
      expect(byKey).toEqual(expect.objectContaining({ eventKey: 'evt-1' }));
      expect(byEvent).toEqual(expect.objectContaining({ eventKey: 'evt-2' }));
    });

    it('normalizes name→title for worldRules/plotThreads only when title missing', () => {
      const rule = normalizeExtractionItem('worldRules', {
        name: '灵气复苏',
        category: 'fundamental',
        constraintLevel: 'hard',
        evidence: [],
      });
      const plot = normalizeExtractionItem('plotThreads', {
        name: '主线',
        level: 'main',
        status: 'active',
        evidence: [],
      });
      expect(rule).toEqual(expect.objectContaining({ title: '灵气复苏' }));
      expect(plot).toEqual(expect.objectContaining({ title: '主线' }));
    });

    it('does not overwrite an explicit canonical field with the alias', () => {
      const normalized = normalizeExtractionItem('characters', {
        name: '别名',
        canonicalName: '本名',
        importance: 'primary',
        evidence: [],
      });
      expect(normalized).toEqual(
        expect.objectContaining({ canonicalName: '本名' }),
      );
    });

    it('keeps validateExtractionResult signature unchanged while accepting aliases', () => {
      const r = validateExtractionResult({
        schemaVersion: EXTRACTION_RESULT_SCHEMA_VERSION,
        worldRules: [],
        characters: [
          { name: '林凡', importance: 'primary', evidence: [] },
        ],
        relationships: [
          {
            source: '林凡',
            target: '苏婉',
            publicStatus: 'public',
            evidence: [],
          },
        ],
        plotThreads: [],
        experiences: [
          { character: '林凡', title: '拜师', importance: 1, evidence: [] },
        ],
        knowledge: [
          {
            character: '林凡',
            fact: '灵根',
            knowledgeState: 'known',
            evidence: [],
          },
        ],
        states: [],
        timelineEvents: [
          { key: 'evt-1', title: '拜师', importance: 1, evidence: [] },
        ],
      });
      expect(r.characters[0].canonicalName).toBe('林凡');
      expect(r.relationships[0].sourceName).toBe('林凡');
      expect(r.experiences[0].characterName).toBe('林凡');
      expect(r.knowledge[0].factKey).toBe('灵根');
      expect(r.timelineEvents[0].eventKey).toBe('evt-1');
    });
  });

  describe('validateExtractionResultWithStats (S3 visibility)', () => {
    it('reports received/accepted/dropped counts per category and the first drop reason', () => {
      const { result, stats } = validateExtractionResultWithStats({
        schemaVersion: EXTRACTION_RESULT_SCHEMA_VERSION,
        worldRules: [],
        characters: [
          // valid via alias
          { name: '林凡', importance: 'primary', evidence: [] },
          // invalid: missing both name and canonicalName
          { importance: 'primary', evidence: [] },
        ],
        relationships: [],
        plotThreads: [],
        experiences: [],
        knowledge: [],
        states: [],
        timelineEvents: [],
      });
      expect(result.characters).toHaveLength(1);
      expect(result.characters[0].canonicalName).toBe('林凡');
      expect(stats.characters).toEqual({
        received: 2,
        accepted: 1,
        dropped: 1,
        firstDropReason: expect.stringContaining('canonicalName'),
      });
    });

    it('reports all-zero stats for an empty payload', () => {
      const { stats } = validateExtractionResultWithStats({
        schemaVersion: EXTRACTION_RESULT_SCHEMA_VERSION,
        worldRules: [],
        characters: [],
        relationships: [],
        plotThreads: [],
        experiences: [],
        knowledge: [],
        states: [],
        timelineEvents: [],
      });
      expect(stats.plotThreads).toEqual({
        received: 0,
        accepted: 0,
        dropped: 0,
      });
    });
  });

  it('keeps the time, location, people and event details for plot and timeline facts', () => {
    const result = validateExtractionResult({
      ...valid,
      plotThreads: [
        {
          title: '雁门救援',
          description: '主角前往雁门救援同伴',
          characterNames: ['林凡', '苏婉'],
          time: '第三日清晨',
          place: '雁门关',
          evidence: [],
        },
      ],
      timelineEvents: [
        {
          eventKey: 'yanmen-rescue',
          title: '雁门救援',
          summary: '林凡与苏婉在雁门关会合后救援',
          characterNames: ['林凡', '苏婉'],
          time: '第三日清晨',
          place: '雁门关',
          evidence: [],
        },
      ],
    });

    expect((result.plotThreads[0] as any).timeDescription).toBe('第三日清晨');
    expect((result.plotThreads[0] as any).location).toBe('雁门关');
    expect((result.timelineEvents[0] as any).timeDescription).toBe(
      '第三日清晨',
    );
    expect((result.timelineEvents[0] as any).location).toBe('雁门关');
    expect(result.timelineEvents[0].characterNames).toEqual(['林凡', '苏婉']);
  });

  it('accepts observed DeepSeek enum variants without changing canonical values', () => {
    const result = validateExtractionResult({
      schemaVersion: EXTRACTION_RESULT_SCHEMA_VERSION,
      worldRules: [
        {
          title: '宗门戒律',
          constraintLevel: '未明',
          evidence: [],
        },
      ],
      characters: [
        { canonicalName: '林凡', importance: '高', evidence: [] },
      ],
      relationships: [
        {
          sourceName: '林凡',
          targetName: '师父',
          publicStatus: '公开（师徒）',
          evidence: [],
        },
        {
          sourceName: '林凡',
          targetName: '仇人',
          publicStatus: '隐秘',
          evidence: [],
        },
      ],
      plotThreads: [
        { title: '主线', level: 'primary', status: 'active', evidence: [] },
        { title: '次主线', level: 'major', status: 'active', evidence: [] },
        { title: '中文主线', level: '主要', status: 'active', evidence: [] },
      ],
      experiences: [],
      knowledge: [
        {
          characterName: '林凡',
          factKey: '身世',
          knowledgeState: '确知',
          evidence: [],
        },
      ],
      states: [
        { characterName: '林凡', aliveState: '活着', evidence: [] },
      ],
      timelineEvents: [],
    });

    expect(result.worldRules[0].constraintLevel).toBe('reference');
    expect(result.plotThreads.map(item => item.level)).toEqual([
      'main',
      'main',
      'main',
    ]);
    expect(result.characters[0].importance).toBe('major');
    expect(result.relationships.map(item => item.publicStatus)).toEqual([
      'public',
      'secret',
    ]);
    expect(result.knowledge[0].knowledgeState).toBe('known');
    expect(result.states[0].aliveState).toBe('alive');
  });

  it('keeps otherwise valid Canon facts when a model emits descriptive enum prose', () => {
    const result = validateExtractionResult({
      schemaVersion: EXTRACTION_RESULT_SCHEMA_VERSION,
      worldRules: [
        { title: '天道规则', constraintLevel: '极其关键', evidence: [] },
      ],
      characters: [
        { canonicalName: '主角', importance: '核心人物', evidence: [] },
      ],
      relationships: [
        {
          sourceName: '主角',
          targetName: '同伴',
          publicStatus: '关系尚待确认',
          evidence: [],
        },
      ],
      plotThreads: [
        {
          title: '谜团',
          level: '贯穿全书的叙事线',
          status: '仍在发展中',
          evidence: [],
        },
      ],
      experiences: [],
      knowledge: [
        {
          characterName: '主角',
          factKey: '身世',
          knowledgeState: '暂时无法判断',
          evidence: [],
        },
      ],
      states: [
        { characterName: '主角', aliveState: '生死未明', evidence: [] },
      ],
      timelineEvents: [],
    });

    expect(result.worldRules).toHaveLength(1);
    expect(result.characters[0].importance).toBe('supporting');
    expect(result.relationships[0].publicStatus).toBe('public');
    expect(result.plotThreads[0]).toMatchObject({
      level: 'subplot',
      status: 'active',
    });
    expect(result.knowledge[0].knowledgeState).toBe('unknown');
    expect(result.states[0].aliveState).toBe('unknown');
  });
});

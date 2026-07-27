import {
  parseExtractionResultJson,
  stripModelJson,
  validateExtractionResult,
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
        evidence: [{ chapterId: 1, chapterPosition: 0, charStart: 0, charEnd: 4, quotePreview: '灵气' }],
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

  it('rejects wrong schema version', () => {
    expect(() =>
      validateExtractionResult({ ...valid, schemaVersion: 99 }),
    ).toThrow(/schema 版本/);
  });

  it('drops invalid enums and empty titles', () => {
    const r = validateExtractionResult({
      ...valid,
      worldRules: [
        { ...valid.worldRules[0], constraintLevel: 'nope' },
        { ...valid.worldRules[0], title: '  ' },
        valid.worldRules[0],
      ],
    });
    expect(r.worldRules).toHaveLength(1);
  });

  it('rejects illegal evidence ranges', () => {
    const r = validateExtractionResult({
      ...valid,
      worldRules: [
        {
          ...valid.worldRules[0],
          evidence: [
            { chapterId: 1, chapterPosition: 0, charStart: 10, charEnd: 5, quotePreview: 'x' },
            { chapterId: 1, chapterPosition: 0, charStart: 0, charEnd: 3, quotePreview: 'ok' },
          ],
        },
      ],
    });
    expect(r.worldRules[0].evidence).toHaveLength(1);
  });

  it('throws on non-JSON truncated output', () => {
    expect(() => parseExtractionResultJson('{not json')).toThrow(/合法 JSON/);
  });
});

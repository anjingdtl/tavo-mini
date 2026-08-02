import {
  parseV3WriterResult,
  parseV3ReviserResult,
} from '../src/services/continuation/generation/continuationV3Parsers';

const TARGET = 3000;

function writerJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    plan: {
      targetHanCharacters: TARGET,
      chapterGoal: '推进主线',
      centralConflict: '主角与反派对峙',
      beats: [
        { order: 1, summary: '承接上一章', targetHanCharacters: 1000 },
        { order: 2, summary: '发展冲突', targetHanCharacters: 1200 },
        { order: 3, summary: '章末钩子', targetHanCharacters: 800 },
      ],
      participatingCharacterIds: [1, 2],
      characterActions: [],
      plotAdvances: [],
      foreshadowingActions: [],
      proposedStateChanges: [],
      risks: [],
    },
    content: '这是本章正文内容，应当是非空的纯小说正文。',
    ...overrides,
  });
}

describe('parseV3WriterResult', () => {
  it('parses a valid V3 Writer payload and derives a V2-compatible plan', () => {
    const result = parseV3WriterResult(writerJson(), TARGET);
    expect(result.v3Plan.schemaVersion).toBe(2);
    expect(result.v3Plan.targetHanCharacters).toBe(TARGET);
    expect(result.v3Plan.beats).toHaveLength(3);
    expect(result.v3Plan.beats[0].targetHanCharacters).toBe(1000);
    // Derived V2 plan
    expect(result.plan.schemaVersion).toBe(1);
    expect(result.plan.chapterGoal).toBe('推进主线');
    expect(result.plan.beats).toHaveLength(3);
    expect(result.plan.participatingCharacterIds).toEqual([1, 2]);
    expect(result.content).toContain('本章正文');
  });

  it('rejects schemaVersion other than 2', () => {
    expect(() =>
      parseV3WriterResult(writerJson({ schemaVersion: 1 }), TARGET),
    ).toThrow(/schemaVersion=2/);
    expect(() =>
      parseV3WriterResult(writerJson({ schemaVersion: 3 }), TARGET),
    ).toThrow(/schemaVersion=2/);
  });

  it('rejects when plan.targetHanCharacters does not match the frozen target', () => {
    const mismatched = JSON.stringify({
      schemaVersion: 2,
      plan: {
        targetHanCharacters: 2000, // frozen is 3000
        chapterGoal: 'g',
        centralConflict: 'c',
        beats: [{ order: 1, summary: 'b', targetHanCharacters: 2000 }],
        participatingCharacterIds: [],
      },
      content: '正文',
    });
    expect(() => parseV3WriterResult(mismatched, TARGET)).toThrow(
      /与冻结目标.*不一致/,
    );
  });

  it('rejects beats missing positive order, summary or target', () => {
    const bad = (beats: unknown) =>
      JSON.stringify({
        schemaVersion: 2,
        plan: {
          targetHanCharacters: TARGET,
          chapterGoal: 'g',
          centralConflict: 'c',
          beats,
          participatingCharacterIds: [],
        },
        content: '正文',
      });
    expect(() =>
      parseV3WriterResult(bad([{ order: 0, summary: 'b', targetHanCharacters: 100 }]), TARGET),
    ).toThrow(/order/);
    expect(() =>
      parseV3WriterResult(bad([{ order: 1, summary: '', targetHanCharacters: 100 }]), TARGET),
    ).toThrow(/summary/);
    expect(() =>
      parseV3WriterResult(bad([{ order: 1, summary: 'b', targetHanCharacters: 0 }]), TARGET),
    ).toThrow(/targetHanCharacters/);
  });

  it('rejects empty content', () => {
    expect(() =>
      parseV3WriterResult(writerJson({ content: '   ' }), TARGET),
    ).toThrow(/非空 content/);
  });

  it('rejects content that is nested JSON with plan/content', () => {
    const nested = JSON.stringify({
      schemaVersion: 2,
      plan: {
        targetHanCharacters: TARGET,
        chapterGoal: 'g',
        centralConflict: 'c',
        beats: [{ order: 1, summary: 'b', targetHanCharacters: TARGET }],
        participatingCharacterIds: [],
      },
      content: JSON.stringify({ plan: { x: 1 }, content: 'nested' }),
    });
    expect(() => parseV3WriterResult(nested, TARGET)).toThrow(
      /不能再次包含/,
    );
  });

  it('rejects non-JSON output', () => {
    expect(() => parseV3WriterResult('not json at all', TARGET)).toThrow(
      /合法 JSON/,
    );
  });

  it('tolerates markdown code fences via stripModelJson', () => {
    const fenced = '```json\n' + writerJson() + '\n```';
    expect(() => parseV3WriterResult(fenced, TARGET)).not.toThrow();
  });
});

describe('parseV3ReviserResult', () => {
  it('parses a valid reviser payload', () => {
    const result = parseV3ReviserResult(
      JSON.stringify({ schemaVersion: 1, content: '完整修订正文...' }),
    );
    expect(result.content).toBe('完整修订正文...');
  });

  it('rejects schemaVersion other than 1', () => {
    expect(() =>
      parseV3ReviserResult(
        JSON.stringify({ schemaVersion: 2, content: 'x' }),
      ),
    ).toThrow(/schemaVersion=1/);
  });

  it('rejects empty content', () => {
    expect(() =>
      parseV3ReviserResult(JSON.stringify({ schemaVersion: 1, content: '' })),
    ).toThrow(/非空 content/);
  });

  it('rejects an offset patch payload (the reviser must return full text)', () => {
    expect(() =>
      parseV3ReviserResult(
        JSON.stringify({
          schemaVersion: 1,
          content: 'x',
          patches: [{ start: 0, end: 1, replacement: 'y' }],
        }),
      ),
    ).toThrow(/完整修订正文/);
  });

  it('rejects non-JSON output', () => {
    expect(() => parseV3ReviserResult('plain text chapter')).toThrow(
      /合法 JSON/,
    );
  });
});

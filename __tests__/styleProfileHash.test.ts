import {
  computeStyleProfileHash,
  stableJson,
} from '../src/services/continuation/styleProfile/styleProfileHash';

function input(overrides: Record<string, unknown> = {}) {
  return {
    profile: {
      schemaVersion: 2,
      global: { tone: { baseline: '克制', nested: { value: 'a' } } },
      sceneVariants: [{ sceneType: 'dialogue', instructions: ['短句'] }],
    },
    metrics: { sentence: { p50: 12, p90: 30 } },
    sampleRefs: [{ sampleKind: 'boundary', sourceChapterId: 2, charStart: 5, charEnd: 20, contentHash: 'h1' }],
    profileSchemaVersion: 2,
    analyzerVersion: 'style-analyzer-v2',
    userOverrides: {},
    ...overrides,
  };
}

describe('style profile canonical hash', () => {
  it('sorts nested object keys but preserves array order', () => {
    expect(stableJson({ b: { z: 1, a: 2 }, a: 3 })).toBe('{"a":3,"b":{"a":2,"z":1}}');
    expect(stableJson(['b', 'a'])).toBe('["b","a"]');
  });

  it('changes when any nested profile field changes', () => {
    const base = computeStyleProfileHash(input());
    const changed = computeStyleProfileHash(input({
      profile: {
        ...(input().profile as object),
        global: { tone: { baseline: '克制', nested: { value: 'changed' } } },
      },
    }));
    expect(changed).not.toBe(base);
  });

  it('covers metrics, sample range/content hash, versions and overrides', () => {
    const base = computeStyleProfileHash(input());
    for (const patch of [
      { metrics: { sentence: { p50: 99, p90: 30 } } },
      { sampleRefs: [{ sampleKind: 'boundary', sourceChapterId: 2, charStart: 6, charEnd: 20, contentHash: 'h1' }] },
      { sampleRefs: [{ sampleKind: 'boundary', sourceChapterId: 2, charStart: 5, charEnd: 20, contentHash: 'h2' }] },
      { analyzerVersion: 'style-analyzer-v3' },
      { userOverrides: { tone: '更克制' } },
    ]) {
      expect(computeStyleProfileHash(input(patch))).not.toBe(base);
    }
  });

  it('does not depend on object insertion order or sample reference order', () => {
    const a = input();
    const b = input({
      profile: {
        sceneVariants: [{ instructions: ['短句'], sceneType: 'dialogue' }],
        global: { tone: { nested: { value: 'a' }, baseline: '克制' } },
        schemaVersion: 2,
      },
      sampleRefs: [
        { contentHash: 'h1', charEnd: 20, charStart: 5, sourceChapterId: 2, sampleKind: 'boundary' },
      ],
    });
    expect(computeStyleProfileHash(a)).toBe(computeStyleProfileHash(b));
  });
});

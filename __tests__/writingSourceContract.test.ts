import {
  adaptContinuationWritingSources,
  adaptOutlineWritingSources,
  fingerprintWritingSourceBundle,
  validateWritingSourceBundle,
} from '../src/services/writing';
import { WRITING_GOLDEN_FIXTURES } from '../src/services/writing/regression/writingGoldenFixtures';
import { sha256Hex } from '../src/services/continuation/hashUtils';
import type { WritingSourceBundle } from '../src/services/writing';

function outlineInput() {
  return {
    projectId: 7,
    chapter: {
      id: 11,
      position: 0,
      title: '第一章',
      synopsis: '发现线索',
      content: '',
      updated_at: 'r1',
    },
    context: {
      presetText: '中文小说基线',
      storyMemoryText: '已知线索',
      characterText: '主角：林遥',
      noteText: '',
      worldbookText: '城市规则',
      episodicMemoryText: '前情摘要',
      recentBridgeText: '上一章结尾',
      outlineText: '主角发现线索并追查。',
      outlineFingerprint: 'outline-rev-1',
      outlineIds: [3],
      outlineComplete: true,
      writerStyleText: '克制叙事',
    },
  } as const;
}

function continuationSnapshot() {
  return {
    projectId: 7,
    targetChapterId: 12,
    targetPosition: 1 as any,
    source: {
      sourceId: 9,
      sourceVersion: 2,
      normalizedSha256: 'source-hash',
      parserVersion: 'p1',
      normalizationVersion: 'n1',
      boundary: { chapterId: 4, chapterPosition: 3 as any, charOffsetExclusive: 100 },
    },
    canon: {
      snapshotId: 'canon-1',
      revision: 3,
      boundaryGlobalCharOffset: 100,
      capabilities: {},
    },
    storyMemory: { stateFingerprint: 'sm-1', throughPosition: 0 as any, status: 'ready' },
    inputRevisionHash: 'chapter-hash',
    style: {
      profileId: 'style-1',
      profileHash: 'style-hash',
      frozenProfile: { global: { narrative: { person: 'third' } } },
    },
    bundles: {
      userInstruction: '从边界继续。',
      lockedRules: [],
      canon: {
        worldRules: [{ title: '规则', description: '魔法有代价' }],
        characters: [],
        characterStates: [],
        relationships: [],
        experiences: [],
        knowledge: [],
        plotThreads: [],
        timelineEvents: [],
      },
      seam: { summary: '末章', excerpt: '门后传来脚步声。' },
      recentChapters: [],
      storyMemory: { summary: '状态摘要' },
      episodic: [],
      style: null,
      supplements: { characterText: '', worldbookText: '', noteText: '', presetText: '', selected: [], excluded: [] },
    },
    primaryAnchor: { kind: 'source_seam', chapterId: 4, position: 3 as any, summary: '末章', excerpt: '门后传来脚步声。' },
  } as any;
}

describe('Writing Source Interface Unification / Phase I', () => {
  it('adapts outline and continuation into the same bundle shape', () => {
    const outline = adaptOutlineWritingSources(outlineInput());
    const continuation = adaptContinuationWritingSources({ snapshot: continuationSnapshot() });
    expect(outline.bundle).toEqual(expect.objectContaining({ mandatory: expect.any(Array), preferred: expect.any(Array), optional: expect.any(Array) }));
    expect(continuation.bundle).toEqual(expect.objectContaining({ mandatory: expect.any(Array), preferred: expect.any(Array), optional: expect.any(Array) }));
    expect(outline.trace.scenario).toBe('outline');
    expect(continuation.trace.scenario).toBe('continuation');
    expect(outline.bundle.mandatory.map(item => item.kind)).toEqual(expect.arrayContaining(['instruction', 'chapter', 'outline', 'preset']));
    expect(continuation.bundle.mandatory.map(item => item.kind)).toEqual(expect.arrayContaining(['instruction', 'canon', 'source_boundary', 'seam']));
  });

  it('keeps source hashes and fingerprints deterministic across ten builds', () => {
    for (const fixture of WRITING_GOLDEN_FIXTURES) {
      const fingerprints = Array.from({ length: 10 }, () => fingerprintWritingSourceBundle(fixture.bundle));
      expect(new Set(fingerprints).size).toBe(1);
      expect(validateWritingSourceBundle(fixture.scenario, fixture.bundle).ok).toBe(true);
    }
  });

  it('fails closed for missing mandatory, corrupted hash, duplicates and scenario leakage', () => {
    const base = WRITING_GOLDEN_FIXTURES.find(item => item.id === 'OUTLINE_BASIC')!.bundle;
    const corrupted: WritingSourceBundle = {
      ...base,
      mandatory: [
        { ...base.mandatory[0], contentHash: sha256Hex('different') },
        base.mandatory[1],
        base.mandatory[2],
        base.mandatory[2],
      ],
    };
    const result = validateWritingSourceBundle('outline', corrupted);
    expect(result.ok).toBe(false);
    expect(result.issues.map(item => item.code)).toEqual(expect.arrayContaining(['INVALID_SOURCE_HASH', 'DUPLICATE_CANDIDATE']));

    const leaked: WritingSourceBundle = {
      ...base,
      preferred: [
        {
          ...base.mandatory[2],
          candidateId: 'canon:leak',
          kind: 'canon',
          requirement: 'preferred',
        },
      ],
    };
    expect(validateWritingSourceBundle('outline', leaked).issues.map(item => item.code)).toContain('INVALID_SCENARIO_SOURCE');
  });
});

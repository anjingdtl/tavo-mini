import {
  countHanCharacters,
  evaluateContinuationLength,
  resolveContinuationLengthContract,
} from '../src/services/continuation/generation/continuationLengthContract';
import {
  applyRepairPatches,
  parseRepairPatches,
  validateRepairPatchCoverage,
  validateRepairPatches,
  isRepairCandidateUsable,
} from '../src/services/continuation/generation/continuationRepairPatch';
import {
  bindIssuesToArtifact,
  filterBySettings,
  runDeterministicChecks,
} from '../src/services/continuation/generation/continuationChecker';

const han = (length: number) => '甲'.repeat(length);

function snapshot(targetChapterChars = 3000): any {
  return {
    settingsSnapshot: {
      values: {
        targetChapterChars,
        worldRuleLevel: 'off',
        characterLevel: 'off',
        relationshipLevel: 'off',
        plotLevel: 'off',
        experienceLevel: 'off',
        knowledgeLevel: 'off',
        styleLevel: 'off',
        resurrectionPolicy: 'allow',
      },
    },
    bundles: {
      canon: { worldRules: [], evidenceRefs: [] },
      effectiveState: { knowledge: [] },
      seam: { summary: '', excerpt: '' },
      recentChapters: [],
      style: null,
    },
    primaryAnchor: null,
  };
}

describe('continuation target Han length contract', () => {
  it('uses target ±500 and ignores punctuation/whitespace/Latin characters', () => {
    expect(resolveContinuationLengthContract(3000)).toEqual({
      targetHanCharacters: 3000,
      minHanCharacters: 2500,
      maxHanCharacters: 3500,
      toleranceHanCharacters: 500,
    });
    expect(countHanCharacters('甲，乙。\nABC 123！')).toBe(2);
    expect(evaluateContinuationLength(han(2500), 3000).status).toBe('within');
    expect(evaluateContinuationLength(han(3500), 3000).status).toBe('within');
    expect(evaluateContinuationLength(han(2499), 3000).status).toBe('under');
    expect(evaluateContinuationLength(han(3501), 3000).status).toBe('over');
  });

  it('keeps local length errors severe even without evidence and with style checks off', () => {
    const snap = snapshot();
    const local = runDeterministicChecks(han(2499), snap);
    const bound = bindIssuesToArtifact(local, han(2499), new Set());
    const filtered = filterBySettings(bound, snap.settingsSnapshot.values);
    expect(filtered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subtype: 'chapter_length_under_target',
          severity: 'error',
        }),
      ]),
    );
  });
});

describe('continuation repair patch safety', () => {
  it('supports pure insertion patches', () => {
    const original = '甲甲\n\n乙乙';
    const result = applyRepairPatches(
      original,
      JSON.stringify({
        patches: [{ start: 4, end: 4, replacement: '新增段落\n\n' }],
      }),
    );
    expect(result).toBe('甲甲\n\n新增段落\n\n乙乙');
  });

  it('rejects raw full-text fallback, overlap and duplicate insertions', () => {
    expect(applyRepairPatches(han(3000), '几百字摘要')).toBeNull();
    expect(
      applyRepairPatches(
        'abcdef',
        JSON.stringify({
          patches: [
            { start: 1, end: 4, replacement: 'x' },
            { start: 3, end: 5, replacement: 'y' },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      applyRepairPatches(
        'abcdef',
        JSON.stringify({
          patches: [
            { start: 2, end: 2, replacement: 'x' },
            { start: 2, end: 2, replacement: 'y' },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('separates patch parsing, safety validation, and issue coverage', () => {
    const original = '甲甲乙乙丙丙';
    const patches = parseRepairPatches(
      JSON.stringify({
        patches: [{ start: 0, end: 2, replacement: '改写' }],
      }),
    );
    expect(patches).not.toBeNull();
    expect(validateRepairPatches(original, patches!)).toBe(true);

    const coverage = validateRepairPatchCoverage({
      patches: patches!,
      issues: [
        {
          id: 1,
          severity: 'blocking',
          subtype: 'knowledge_violation',
          generatedStart: 0,
          generatedEnd: 2,
        },
        {
          id: 2,
          severity: 'blocking',
          subtype: 'world_conflict',
          generatedStart: 4,
          generatedEnd: 6,
        },
        {
          id: 3,
          severity: 'error',
          subtype: 'chapter_length_under_target',
          generatedStart: null,
          generatedEnd: null,
        },
        {
          id: 4,
          severity: 'blocking',
          subtype: 'global_rule',
          generatedStart: null,
          generatedEnd: null,
        },
      ],
    });

    expect(coverage.coveredIssues.map(issue => issue.id)).toEqual([1]);
    expect(coverage.uncoveredIssues.map(issue => issue.id)).toEqual([2, 4]);
    expect(coverage.chapterLengthIssues.map(issue => issue.id)).toEqual([3]);
  });

  it('rejects pure insertion away from a paragraph boundary', () => {
    const patches = parseRepairPatches(
      JSON.stringify({
        patches: [{ start: 2, end: 2, replacement: '插入' }],
      }),
    );
    expect(validateRepairPatches('甲乙丙丁', patches!)).toBe(false);
  });

  it('accepts the project single-newline paragraph boundary without allowing sentence-middle insertion', () => {
    const paragraphBoundary = parseRepairPatches(
      JSON.stringify({
        patches: [{ start: 2, end: 2, replacement: '新增段落' }],
      }),
    );
    expect(validateRepairPatches('甲乙\n丙丁', paragraphBoundary!)).toBe(true);

    const betweenCrLf = parseRepairPatches(
      JSON.stringify({
        patches: [{ start: 2, end: 2, replacement: '新增段落' }],
      }),
    );
    expect(validateRepairPatches('甲\r\n乙', betweenCrLf!)).toBe(false);
  });

  it('rejects collapse and preserves a previously valid length band', () => {
    expect(isRepairCandidateUsable(han(3000), han(600), 3000)).toBe(false);
    expect(isRepairCandidateUsable(han(3000), han(2400), 3000)).toBe(false);
    expect(isRepairCandidateUsable(han(3000), han(2800), 3000)).toBe(true);
  });

  it('allows a safe first Repair to improve an invalid Writer candidate', () => {
    expect(isRepairCandidateUsable(han(2100), han(2400), 3000)).toBe(true);
    expect(isRepairCandidateUsable(han(2100), han(1200), 3000)).toBe(false);
    expect(isRepairCandidateUsable(han(2100), han(1800), 3000)).toBe(false);
  });

  it('does not accept an additional Repair that moves farther from target', () => {
    expect(
      isRepairCandidateUsable(han(2600), han(2550), 3000, 'additional'),
    ).toBe(false);
    expect(
      isRepairCandidateUsable(han(2400), han(2600), 3000, 'additional'),
    ).toBe(true);
  });

  it('rejects unchanged candidates in both Repair modes', () => {
    expect(isRepairCandidateUsable(han(3000), han(3000), 3000)).toBe(false);
    expect(
      isRepairCandidateUsable(han(3000), han(3000), 3000, 'additional'),
    ).toBe(false);
  });
});

describe('countHanCharacters supported Unicode Han ranges', () => {
  it('counts BMP CJK Unified Ideographs', () => {
    expect(countHanCharacters('汉字')).toBe(2);
  });

  it('counts Extension A and Compatibility Ideographs', () => {
    expect(countHanCharacters('\u{349D}\u{FA10}')).toBe(2);
  });

  it('counts supplementary-plane Han characters and 〇', () => {
    expect(countHanCharacters('\u{20000}\u{2A6D6}〇')).toBe(3);
  });

  it('does not count punctuation, whitespace, digits, Latin, kana, or Hangul', () => {
    expect(countHanCharacters('，。！？\nABC 123！あいうえ안녕하세요')).toBe(0);
  });
});

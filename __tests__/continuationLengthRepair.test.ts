import {
  countHanCharacters,
  evaluateContinuationLength,
  resolveContinuationLengthContract,
} from '../src/services/continuation/generation/continuationLengthContract';
import {
  applyRepairPatches,
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
});

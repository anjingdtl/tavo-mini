const assert = require('node:assert/strict');
const test = require('node:test');
const {
  countHanCharacters,
  evaluateContinuationLength,
  resolveContinuationLengthContract,
} = require('../dist/services/continuation/generation/continuationLengthContract.js');
const {
  applyRepairPatches,
  isRepairCandidateUsable,
} = require('../dist/services/continuation/generation/continuationRepairPatch.js');

const han = length => '甲'.repeat(length);

test('resolves target ±500 as the frozen Han-character contract', () => {
  assert.deepEqual(resolveContinuationLengthContract(3000), {
    targetHanCharacters: 3000,
    minHanCharacters: 2500,
    maxHanCharacters: 3500,
    toleranceHanCharacters: 500,
  });
});

test('counts Han while ignoring punctuation, whitespace, digits and Latin text', () => {
  assert.equal(countHanCharacters('甲，乙。\nABC 123！'), 2);
});

test('accepts inclusive boundaries and classifies values outside the band', () => {
  assert.equal(evaluateContinuationLength(han(2500), 3000).status, 'within');
  assert.equal(evaluateContinuationLength(han(3500), 3000).status, 'within');
  assert.equal(evaluateContinuationLength(han(2499), 3000).status, 'under');
  assert.equal(evaluateContinuationLength(han(3501), 3000).status, 'over');
});

test('supports pure insertion patches without trimming paragraph whitespace', () => {
  const original = '甲甲\n\n乙乙';
  const raw = JSON.stringify({
    patches: [{ start: 4, end: 4, replacement: '新增段落\n\n' }],
  });
  assert.equal(applyRepairPatches(original, raw), '甲甲\n\n新增段落\n\n乙乙');
  assert.equal(
    applyRepairPatches(
      '甲甲乙乙',
      JSON.stringify({ patches: [{ start: 2, end: 2, replacement: '插入' }] }),
    ),
    null,
  );
});

test('rejects raw full-text fallback, overlap and duplicate insertion', () => {
  assert.equal(applyRepairPatches(han(3000), '几百字摘要'), null);
  assert.equal(
    applyRepairPatches(
      'abcdef',
      JSON.stringify({ patches: [
        { start: 1, end: 4, replacement: 'x' },
        { start: 3, end: 5, replacement: 'y' },
      ] }),
    ),
    null,
  );
  assert.equal(
    applyRepairPatches(
      'abcdef',
      JSON.stringify({ patches: [
        { start: 2, end: 2, replacement: 'x' },
        { start: 2, end: 2, replacement: 'y' },
      ] }),
    ),
    null,
  );
});

test('rejects a Repair that breaks an already valid chapter', () => {
  assert.equal(isRepairCandidateUsable(han(3000), han(600), 3000), false);
  assert.equal(isRepairCandidateUsable(han(3000), han(2400), 3000), false);
  assert.equal(isRepairCandidateUsable(han(3000), han(2800), 3000), true);
});

test('allows a safe first Repair to improve an invalid Writer candidate', () => {
  assert.equal(isRepairCandidateUsable(han(2100), han(2400), 3000), true);
  assert.equal(isRepairCandidateUsable(han(2100), han(1200), 3000), false);
  assert.equal(isRepairCandidateUsable(han(2100), han(1800), 3000), false);
});

import { continuationRound2StageForIndex } from '../src/services/writing/execution/continuationStageDriver';

describe('Continuation shared Kernel round2 DAG', () => {
  test('starts ONE QA before conditional Revision in Compact Standard', () => {
    const stages = ['qa', 'revision'] as const;
    expect(
      continuationRound2StageForIndex({
        compactTopology: true,
        stages,
        index: 0,
      }),
    ).toBe('qa');
    expect(
      continuationRound2StageForIndex({
        compactTopology: true,
        stages,
        index: 1,
      }),
    ).toBe('revision');
    expect(
      continuationRound2StageForIndex({
        compactTopology: true,
        stages,
        index: 2,
      }),
    ).toBeUndefined();
  });

  test('does not change the legacy compatibility driver schedule', () => {
    expect(
      continuationRound2StageForIndex({
        compactTopology: false,
        stages: ['revision', 'audit', 'factCheck'],
        index: 0,
      }),
    ).toBeUndefined();
  });
});

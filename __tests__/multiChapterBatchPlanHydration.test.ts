import { hydratePersistedBatchPlan } from '../src/screens/MultiChapterBatchScreen';

const plannerChapters = [
  {
    ordinal: 1,
    title: '第一章',
    synopsis: '完整规划摘要',
    keyBeats: ['推进线索'],
    carryIn: '承接',
    carryOut: '留下悬念',
    targetWords: 3000,
  },
];

describe('multi-chapter preview plan hydration', () => {
  it('prefers the persisted planner output over placeholder item rows', () => {
    const hydrated = hydratePersistedBatchPlan(
      JSON.stringify({ chapters: plannerChapters }),
      [
        {
          ordinal: 1,
          title: '第 1 章',
          synopsis: '',
          keyBeatsJson: '[]',
          carryIn: null,
          carryOut: null,
          targetWords: 3000,
        },
      ],
    );

    expect(hydrated).toEqual(plannerChapters);
  });

  it('falls back to complete persisted item rows when planner output is absent', () => {
    const hydrated = hydratePersistedBatchPlan(null, [
      {
        ordinal: 1,
        title: '第一章',
        synopsis: '已保存摘要',
        keyBeatsJson: '["已保存节拍"]',
        carryIn: '承接',
        carryOut: '悬念',
        targetWords: 3000,
      },
    ]);

    expect(hydrated).toEqual([
      {
        ordinal: 1,
        title: '第一章',
        synopsis: '已保存摘要',
        keyBeats: ['已保存节拍'],
        carryIn: '承接',
        carryOut: '悬念',
        targetWords: 3000,
      },
    ]);
  });

  it('does not turn placeholder rows into a falsely valid plan', () => {
    expect(
      hydratePersistedBatchPlan(null, [
        {
          ordinal: 1,
          title: '第 1 章',
          synopsis: '',
          keyBeatsJson: '[]',
          carryIn: null,
          carryOut: null,
          targetWords: 3000,
        },
      ]),
    ).toEqual([]);
  });
});

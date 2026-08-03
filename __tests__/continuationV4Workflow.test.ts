import {
  parseContinuationV4RepairEnvelope,
  parseContinuationV4WriterEnvelope,
  runContinuationV4LocalFinalGate,
  validateContinuationV4RepairCompliance,
} from '../src/services/continuation/generation';
import type {
  ContinuationContextSnapshotV3,
  ContinuationV4RepairEnvelope,
} from '../src/services/continuation/generation/types';

function snapshot(): ContinuationContextSnapshotV3 {
  return {
    schemaVersion: 3,
    workflowVersion: 4,
    projectId: 1,
    targetChapterId: 2,
    targetPosition: 1 as any,
    source: {} as any,
    canon: {
      snapshotId: 'canon-v4',
      revision: 1,
      boundaryGlobalCharOffset: 0,
      capabilities: {} as any,
    },
    storyMemory: { stateFingerprint: 'state', throughPosition: -1, status: 'ready' },
    inputRevisionHash: 'input',
    settingsSnapshot: {
      schemaVersion: 1,
      workflowVersion: 4,
      values: {
        targetChapterChars: 600,
        styleLevel: 'strict',
      },
    } as any,
    bundles: {
      lockedRules: [],
      canon: {
        snapshot: {} as any,
        worldRules: [],
        characters: [],
        characterStates: [],
        relationships: [],
        experiences: [],
        knowledge: [],
        plotThreads: [],
        timelineEvents: [],
        evidenceRefs: [],
        estimatedTokens: 0,
        omittedReasonCounts: {},
      },
      effectiveState: {
        characterStates: [],
        relationships: [],
        plotThreads: [],
        knowledge: [],
        experiences: [],
      } as any,
      seam: { summary: '', excerpt: '' },
      recentChapters: [],
      storyMemory: { summary: '', estimatedTokens: 0 },
      episodic: [],
      style: null,
      userInstruction: '推进冲突',
    },
    style: null,
    primaryAnchor: undefined,
    createdAt: '2026-08-03T00:00:00.000Z',
    budgetPolicy: {} as any,
    stageBudgets: {} as any,
    stageViews: {} as any,
  };
}

describe('Continuation V4 workflow contracts', () => {
  test('Writer and Repair accept only complete envelopes', () => {
    const writer = parseContinuationV4WriterEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        plan: {
          chapterGoal: '推进冲突',
          centralConflict: '门外有追兵',
          beats: [{ id: 'beat_1', summary: '承接并升级' }],
        },
        content: '完整的 Writer 初稿正文。',
      }),
    );
    expect(writer.plan.beats).toHaveLength(1);
    expect(writer.content).toContain('完整');

    const relaxedWriter = parseContinuationV4WriterEnvelope(
      JSON.stringify({
        text: '兼容 transport 别名的完整 Writer 正文。',
        chapterGoal: '继续推进',
      }),
    );
    expect(relaxedWriter.content).toContain('兼容 transport');
    expect(relaxedWriter.plan.chapterGoal).toBe('继续推进');
    expect(relaxedWriter.plan.beats).toHaveLength(1);

    const wrappedWriter = parseContinuationV4WriterEnvelope(
      JSON.stringify({
        schemaVersion: '1',
        content: { paragraphs: ['第一段完整正文。', '第二段完整正文。'] },
        outline: JSON.stringify({
          chapterGoal: '继续推进',
          centralConflict: '阻力升级',
          beats: ['承接', '升级'],
        }),
      }),
    );
    expect(wrappedWriter.content).toContain('第二段完整正文');
    expect(wrappedWriter.plan.centralConflict).toBe('阻力升级');
    expect(wrappedWriter.plan.beats).toHaveLength(2);

    const repair = parseContinuationV4RepairEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        content: '完整 Repair 终稿正文。',
        appliedCheckerIssueIds: ['chk_1'],
        appliedControlSuggestionIds: ['ctrl_1'],
        unappliedItems: [],
      }),
    );
    expect(repair.content).toContain('完整');
    expect(() =>
      parseContinuationV4RepairEnvelope(
        JSON.stringify({
          schemaVersion: 1,
          content: '只返回局部修改',
          patches: [{ start: 0, end: 1, replacement: 'x' }],
          appliedCheckerIssueIds: [],
          appliedControlSuggestionIds: [],
          unappliedItems: [],
        }),
      ),
    ).toThrow('局部修改字段');
  });

  test('Local Final Gate uses the local Han count and rejects protocol leakage', () => {
    const base = '这是完整正文。'.repeat(30);
    const gate = runContinuationV4LocalFinalGate({
      writerText: base,
      candidateText: base,
      snapshot: snapshot(),
      controlMetrics: {
        actualHanCharacters: 210,
        targetHanCharacters: 600,
        minHanCharacters: 100,
        maxHanCharacters: 1100,
        missingToMinimum: 0,
        excessOverMaximum: 0,
        deltaToTarget: -390,
        paragraphs: [],
        dialogueHanRatio: 0,
        paragraphLengthDistribution: { min: 0, max: 0, mean: 0, median: 0 },
        duplicateWindows: [],
        beatCoverage: [],
        insertionBoundaries: [],
      },
    });
    expect(gate.passed).toBe(false);
    expect(gate.candidateMetrics.actualHanCharacters).toBeGreaterThan(0);
    const lengthSnapshot = snapshot();
    lengthSnapshot.settingsSnapshot = {
      ...lengthSnapshot.settingsSnapshot,
      values: {
        ...lengthSnapshot.settingsSnapshot.values,
        targetChapterChars: 1000,
      },
    } as any;
    const lengthAdvisory = runContinuationV4LocalFinalGate({
      writerText: base,
      candidateText: '这是修订后的完整正文。'.repeat(20),
      snapshot: lengthSnapshot,
      controlMetrics: gate.candidateMetrics,
    });
    expect(
      lengthAdvisory.checks.find(
        check => check.subtype === 'chapter_length_under_target',
      )?.severity,
    ).toBe('warning');
    expect(lengthAdvisory.passed).toBe(true);
    expect(gate.checks.map(check => check.subtype)).toContain(
      'repair_candidate_unchanged',
    );

    const rejected = runContinuationV4LocalFinalGate({
      writerText: base,
      candidateText: `${base}\n思考过程：需要继续修改`,
      snapshot: snapshot(),
      controlMetrics: gate.candidateMetrics,
    });
    expect(rejected.passed).toBe(false);
    expect(rejected.checks.map(check => check.subtype)).toContain(
      'repair_prompt_leakage',
    );
  });

  test('Repair compliance requires actual Checker and Control progress', () => {
    const writerText = '问题原句需要被改写。'.repeat(20);
    const controlReport = {
      schemaVersion: 1 as const,
      action: 'expand' as const,
      currentHan: 200,
      targetHan: 600,
      allowedMinHan: 500,
      allowedMaxHan: 700,
      suggestions: [
        {
          suggestionId: 'ctrl_1',
          type: 'expand_scene',
          location: 'paragraph_1_after',
          expectedDeltaHan: 400,
          instruction: '补充行动阻力和因果推进',
          preserveBeatIds: ['beat_1'],
        },
      ],
      preserve: ['章末钩子'],
    };
    const checkerIssues = [
      {
        id: 7,
        generatedExcerpt: '问题原句',
        description: '冻结剧情冲突',
        evidenceIds: [39],
        category: 'plot',
        severity: 'error',
      },
    ] as any;
    const failed = validateContinuationV4RepairCompliance({
      writerText,
      candidateText: writerText,
      checkerIssues,
      controlReport,
      envelope: {
        schemaVersion: 1,
        content: writerText,
        appliedCheckerIssueIds: ['7'],
        appliedControlSuggestionIds: ['ctrl_1'],
        unappliedItems: [],
      } satisfies ContinuationV4RepairEnvelope,
    });
    expect(failed.map(check => check.subtype)).toEqual(
      expect.arrayContaining([
        'repair_checker_issue_unchanged',
        'repair_control_no_progress',
      ]),
    );

    const passed = validateContinuationV4RepairCompliance({
      writerText,
      candidateText: `${'改写后的行动推进。'.repeat(45)}终稿`,
      checkerIssues,
      controlReport,
      envelope: {
        schemaVersion: 1,
        content: `${'改写后的行动推进。'.repeat(45)}终稿`,
        appliedCheckerIssueIds: ['chk_7'],
        appliedControlSuggestionIds: ['ctrl_1'],
        unappliedItems: [],
      } satisfies ContinuationV4RepairEnvelope,
    });
    expect(passed).toEqual([]);
  });

  test('Repair cannot hide unaddressed requirements in unappliedItems', () => {
    const checkerIssues = [
      {
        id: 3,
        generatedExcerpt: '问题',
        description: '问题',
        evidenceIds: [1],
        category: 'plot',
        severity: 'error',
      },
    ] as any;
    const checks = validateContinuationV4RepairCompliance({
      writerText: '原稿。',
      candidateText: '修订后的原稿。',
      checkerIssues,
      controlReport: {
        schemaVersion: 1,
        action: 'keep',
        currentHan: 3,
        targetHan: 3,
        allowedMinHan: 2,
        allowedMaxHan: 4,
        suggestions: [],
        preserve: [],
      },
      envelope: {
        schemaVersion: 1,
        content: '修订后的原稿。',
        appliedCheckerIssueIds: ['3'],
        appliedControlSuggestionIds: [],
        unappliedItems: ['无法处理冻结事实冲突'],
      },
    });
    expect(checks.map(check => check.subtype)).toContain('repair_unapplied_item');
  });
});

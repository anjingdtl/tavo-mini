import {
  parseContinuationV4RepairEnvelope,
  parseContinuationV4WriterEnvelope,
  runContinuationV4LocalFinalGate,
} from '../src/services/continuation/generation';
import type { ContinuationContextSnapshotV3 } from '../src/services/continuation/generation/types';

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
    ).toThrow();
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
    expect(gate.passed).toBe(true);
    expect(gate.candidateMetrics.actualHanCharacters).toBeGreaterThan(0);

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
});

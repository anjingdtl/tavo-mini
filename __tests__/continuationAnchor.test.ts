import {
  selectContinuationAnchor,
} from '../src/services/continuation/generation/continuationAnchor';
import {
  compilePlannerMessages,
  compileWriterMessages,
} from '../src/services/continuation/generation/legacy/continuationPromptCompiler';
import { runDeterministicChecks } from '../src/services/continuation/generation/continuationChecker';
import { summarizeTrace } from '../src/services/continuation/generation/continuationContextTrace';

const sourceTail = '【ORIGINAL_FINAL_TAIL】原著末章尾段唯一标记，连续复制必须被阻止。';
const continuation1Tail = '【CONTINUATION_1_TAIL】第一篇续写的章尾唯一标记，连续复制必须被阻止。';
const continuation2Tail = '【CONTINUATION_2_TAIL】第二篇续写的章尾唯一标记，连续复制必须被阻止。';

describe('selectContinuationAnchor', () => {
  const sourceSeam = { summary: '原著边界', excerpt: sourceTail };

  test('first continuation uses the original boundary tail', () => {
    expect(
      selectContinuationAnchor({
        targetPosition: 0 as any,
        priorChapters: [],
        sourceSeam,
      }),
    ).toEqual({
      kind: 'source_seam',
      summary: '原著边界',
      excerpt: sourceTail,
      chapterId: null,
      position: null,
    });
  });

  test('second and third continuations choose the nearest non-empty chapter', () => {
    const chapters = [
      { id: 10, position: 0 as any, content: continuation1Tail },
      { id: 11, position: 1 as any, content: continuation2Tail },
    ];
    expect(
      selectContinuationAnchor({
        targetPosition: 1 as any,
        priorChapters: chapters,
        sourceSeam,
      }).chapterId,
    ).toBe(10);
    expect(
      selectContinuationAnchor({
        targetPosition: 2 as any,
        priorChapters: chapters,
        sourceSeam,
      }).chapterId,
    ).toBe(11);
  });

  test('ignores empty/planned chapters and resolves holes and duplicate positions stably', () => {
    const result = selectContinuationAnchor({
      targetPosition: 5 as any,
      priorChapters: [
        { id: 2, position: 0 as any, content: '旧正文' },
        { id: 3, position: 4 as any, content: '   ' },
        { id: 8, position: 2 as any, content: 'position 2 / lower id' },
        { id: 9, position: 2 as any, content: 'position 2 / higher id' },
      ],
      sourceSeam,
    });
    expect(result.kind).toBe('continuation_chapter');
    expect(result.chapterId).toBe(9);
    expect(result.position).toBe(2);
  });
});

function snapshot(overrides: Record<string, unknown> = {}): any {
  return {
    schemaVersion: 2,
    projectId: 1,
    targetChapterId: 99,
    targetPosition: 0,
    source: { boundary: { chapterPosition: 0 } },
    canon: {
      snapshotId: 'canon',
      revision: 1,
      capabilities: {},
      worldRules: [],
    },
    storyMemory: { stateFingerprint: 'fp', throughPosition: -1, status: 'ready' },
    inputRevisionHash: 'hash',
    settingsSnapshot: {
      schemaVersion: 1,
      values: { styleLevel: 'balanced', targetChapterChars: 100 },
      resolvedModelConfigIds: {
        planner: 1,
        writer: 1,
        checker: 1,
        repair: 1,
        stateExtraction: 1,
      },
    },
    bundles: {
      lockedRules: [],
      canon: {
        worldRules: [],
        characters: [],
        characterStates: [],
        relationships: [],
        experiences: [],
        knowledge: [],
        plotThreads: [],
        timelineEvents: [],
        evidenceRefs: [],
      },
      effectiveState: {
        characterStates: [],
        relationships: [],
        knowledge: [],
        experiences: [],
        plotThreads: [],
      },
      seam: { summary: '', excerpt: '' },
      recentChapters: [],
      storyMemory: { summary: '', estimatedTokens: 0 },
      episodic: [],
      style: null,
      userInstruction: '推进主线',
    },
    ...overrides,
  };
}

describe('continuation anchor prompt and checker behavior', () => {
  test('first prompt uses source seam; later prompts use only the selected continuation seam', () => {
    const first = snapshot({
      primaryAnchor: {
        kind: 'source_seam',
        summary: '原著边界',
        excerpt: sourceTail,
        chapterId: null,
        position: null,
      },
    });
    const second = snapshot({
      targetPosition: 1,
      primaryAnchor: {
        kind: 'continuation_chapter',
        summary: '续写第一章',
        excerpt: continuation1Tail,
        chapterId: 10,
        position: 0,
      },
      bundles: {
        ...first.bundles,
        seam: { summary: '（已替代）', excerpt: '' },
      },
    });
    const third = snapshot({
      targetPosition: 2,
      primaryAnchor: {
        kind: 'continuation_chapter',
        summary: '续写第二章',
        excerpt: continuation2Tail,
        chapterId: 11,
        position: 1,
      },
      bundles: {
        ...first.bundles,
        seam: { summary: '（已替代）', excerpt: '' },
      },
    });

    const plan = {
      schemaVersion: 1,
      chapterGoal: '推进',
      centralConflict: '冲突',
      beats: [],
      participatingCharacterIds: [],
      characterActions: [],
      plotAdvances: [],
      foreshadowingActions: [],
      proposedStateChanges: [],
      risks: [],
    } as any;
    const firstWriter = compileWriterMessages(first, plan)[0].content;
    const secondPlanner = compilePlannerMessages(second)[0].content;
    const secondWriter = compileWriterMessages(second, plan)[0].content;
    const thirdPlanner = compilePlannerMessages(third)[0].content;
    const thirdWriter = compileWriterMessages(third, plan)[0].content;

    expect(firstWriter).toContain(sourceTail);
    for (const prompt of [secondPlanner, secondWriter]) {
      expect(prompt).toContain('当前正文接缝：最近续写第 2 章');
      expect(prompt).toContain(continuation1Tail);
      expect(prompt).not.toContain(sourceTail);
    }
    for (const prompt of [thirdPlanner, thirdWriter]) {
      expect(prompt).toContain('当前正文接缝：最近续写第 3 章');
      expect(prompt).toContain(continuation2Tail);
      expect(prompt).not.toContain(sourceTail);
      expect(prompt).not.toContain(continuation1Tail);
    }
  });

  test('schemaVersion 1 snapshots retain the legacy seam compiler path', () => {
    const legacy = snapshot({
      schemaVersion: 1,
      bundles: {
        ...snapshot().bundles,
        seam: { summary: 'legacy seam', excerpt: sourceTail },
      },
    });
    expect(compilePlannerMessages(legacy)[0].content).toContain(sourceTail);
  });

  test('source and continuation anchor copies are hard errors for adoption', () => {
    const sourceIssues = runDeterministicChecks(
      sourceTail + sourceTail,
      snapshot({
        primaryAnchor: {
          kind: 'source_seam',
          summary: '原著边界',
          excerpt: sourceTail,
          chapterId: null,
          position: null,
        },
      }),
    );
    const continuationIssues = runDeterministicChecks(
      continuation1Tail + continuation1Tail,
      snapshot({
        primaryAnchor: {
          kind: 'continuation_chapter',
          summary: '续写第一章',
          excerpt: continuation1Tail,
          chapterId: 10,
          position: 0,
        },
      }),
    );
    expect(sourceIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subtype: 'source_overlap', severity: 'error' }),
      ]),
    );
    expect(continuationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subtype: 'continuation_anchor_overlap',
          severity: 'error',
        }),
      ]),
    );

    const styleOffIssues = runDeterministicChecks(
      sourceTail + sourceTail,
      snapshot({
        primaryAnchor: {
          kind: 'source_seam',
          summary: '原著边界',
          excerpt: sourceTail,
          chapterId: null,
          position: null,
        },
        settingsSnapshot: {
          ...snapshot().settingsSnapshot,
          values: { ...snapshot().settingsSnapshot.values, styleLevel: 'off' },
        },
      }),
    );
    expect(styleOffIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subtype: 'source_overlap', severity: 'error' }),
      ]),
    );
  });

  test('trace summary exposes frozen anchor without正文', () => {
    const summary = summarizeTrace({
      sourceId: 1,
      canonSnapshotId: 'canon',
      canonRevision: 1,
      targetPosition: 2 as any,
      entityRefs: [],
      storyMemoryFingerprint: 'fp',
      freshness: {
        canonReady: true,
        storyMemoryStatus: 'ready',
        pendingStateExtractionCount: 0,
        pendingMajorProposalCount: 0,
      },
      categories: [],
      totalInputTokens: 1,
      reservedOutputTokens: 1,
      omittedCapabilities: [],
      primaryAnchorKind: 'continuation_chapter',
      primaryAnchorChapterId: 11,
      primaryAnchorPosition: 1 as any,
    });
    expect(summary).toContain('本章接缝：续写第 2 章');
    expect(summary).not.toContain(continuation2Tail);
  });
});

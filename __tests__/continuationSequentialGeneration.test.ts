import { selectContinuationAnchor } from '../src/services/continuation/generation/continuationAnchor';
import {
  compilePlannerMessages,
  compileWriterMessages,
} from '../src/services/continuation/generation/legacy/continuationPromptCompiler';
import type { ContinuationContextTrace } from '../src/services/continuation/generation/types';

const original = '【ORIGINAL_FINAL_TAIL】原著末章唯一锚点，不应进入后续续写正文接缝，也不得在后续 Prompt 中重复出现。';
const one = '【CONTINUATION_1_TAIL】第一篇续写章尾，作为第二篇唯一接缝，并且需要冻结到本次上下文。';
const two = '【CONTINUATION_2_TAIL】第二篇续写章尾，作为第三篇唯一接缝，并且需要冻结到本次上下文。';

const plan: any = {
  schemaVersion: 1,
  chapterGoal: '推进主线',
  centralConflict: '冲突升级',
  beats: [],
  participatingCharacterIds: [],
  characterActions: [],
  plotAdvances: [],
  foreshadowingActions: [],
  proposedStateChanges: [],
  risks: [],
};

function makeSnapshot(anchor: any, targetPosition: number): any {
  return {
    schemaVersion: 2,
    projectId: 1,
    targetChapterId: targetPosition + 100,
    targetPosition,
    source: { boundary: { chapterPosition: 20 } },
    canon: { snapshotId: 'canon-frozen', revision: 3, capabilities: {} },
    storyMemory: { stateFingerprint: 'sm-frozen', throughPosition: -1, status: 'ready' },
    inputRevisionHash: `revision-${targetPosition}`,
    primaryAnchor: anchor,
    settingsSnapshot: {
      schemaVersion: 1,
      values: { styleLevel: 'off', targetChapterChars: 100 },
      resolvedModelConfigIds: {
        planner: 1,
        writer: 1,
        checker: 1,
        repair: 1,
        stateExtraction: 77,
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
        plotThreads: [],
        knowledge: [],
        experiences: [],
      },
      seam: {
        summary: anchor.kind === 'source_seam' ? '原著边界' : '已被续写接缝替代',
        excerpt: anchor.kind === 'source_seam' ? anchor.excerpt : '',
      },
      recentChapters: [],
      storyMemory: { summary: '', estimatedTokens: 0 },
      episodic: [],
      style: null,
      userInstruction: '继续写作',
    },
  };
}

function traceFor(anchor: any, targetPosition: number): ContinuationContextTrace {
  return {
    sourceId: 1,
    canonSnapshotId: 'canon-frozen',
    canonRevision: 3,
    targetPosition: targetPosition as any,
    entityRefs: [],
    storyMemoryFingerprint: 'sm-frozen',
    freshness: {
      canonReady: true,
      storyMemoryStatus: 'ready',
      pendingStateExtractionCount: 0,
      pendingMajorProposalCount: 0,
    },
    categories: [],
    totalInputTokens: 10,
    reservedOutputTokens: 10,
    omittedCapabilities: [],
    primaryAnchorKind: anchor.kind,
    primaryAnchorChapterId: anchor.chapterId,
    primaryAnchorPosition: anchor.position,
  };
}

test('three consecutive continuation snapshots freeze one changing primary anchor', () => {
  const chapter1 = { id: 101, position: 0 as any, content: one, title: '续写一' };
  const chapter2 = { id: 102, position: 1 as any, content: two, title: '续写二' };
  const sourceSeam = { summary: '原著边界', excerpt: original };

  const anchor1 = selectContinuationAnchor({
    targetPosition: 0 as any,
    priorChapters: [],
    sourceSeam,
  });
  const anchor2 = selectContinuationAnchor({
    targetPosition: 1 as any,
    priorChapters: [chapter1],
    sourceSeam,
  });
  const anchor3 = selectContinuationAnchor({
    targetPosition: 2 as any,
    priorChapters: [chapter1, chapter2],
    sourceSeam,
  });

  expect(anchor1.kind).toBe('source_seam');
  expect(anchor2).toMatchObject({ kind: 'continuation_chapter', chapterId: 101, position: 0 });
  expect(anchor3).toMatchObject({ kind: 'continuation_chapter', chapterId: 102, position: 1 });

  const snapshots = [
    makeSnapshot(anchor1, 0),
    makeSnapshot(anchor2, 1),
    makeSnapshot(anchor3, 2),
  ];
  const prompts = snapshots.map(snapshot => ({
    planner: compilePlannerMessages(snapshot)[0].content,
    writer: compileWriterMessages(snapshot, plan)[0].content,
  }));
  expect(prompts[0].writer).toContain(original);
  expect(prompts[1].writer).toContain(one);
  expect(prompts[1].writer).not.toContain(original);
  expect(prompts[2].writer).toContain(two);
  expect(prompts[2].writer).not.toContain(original);
  expect(prompts[2].writer).not.toContain(one);

  const traces = [traceFor(anchor1, 0), traceFor(anchor2, 1), traceFor(anchor3, 2)];
  expect(traces.map(trace => [trace.primaryAnchorKind, trace.primaryAnchorPosition])).toEqual([
    ['source_seam', null],
    ['continuation_chapter', 0],
    ['continuation_chapter', 1],
  ]);
  expect(snapshots.map(snapshot => snapshot.settingsSnapshot.resolvedModelConfigIds.stateExtraction)).toEqual([
    77,
    77,
    77,
  ]);
});

import {
  reconcileStoryMemoryMainlineDraft,
  type BatchDraftWithMainline,
} from '../src/services/storyMemory/storyMemoryMainlineReconciler';
import type { Chapter } from '../src/types/novel';

function chapter(position: number, content: string): Chapter {
  return {
    id: position + 1,
    project_id: 1,
    position,
    title: `第 ${position + 1} 章`,
    synopsis: '',
    content,
    status: 'final',
    summary_json: null,
    created_at: '',
    updated_at: '',
  };
}

const chapters = [
  chapter(6, '林岚与苏白对峙，发现调查方向转向地下室。'),
  chapter(7, '林岚在地下室入口发现新的加密线索。'),
  chapter(8, '林岚决定暂时封锁地下室的消息。'),
];

function emptyMainlinePatch() {
  return {
    currentArcUpdate: {
      action: 'none' as const,
      arcRef: '',
      name: '',
      summary: '',
      evidence: [],
    },
    assessment: { result: 'unchanged' as const, reason: '本批无持续主线变化' },
    conflictUpserts: [],
    conflictResolutions: [],
    threadOpens: [],
    threadUpdates: [],
    threadResolutions: [],
    foreshadowingUpserts: [],
    timelineAnchors: [],
    completedBeats: [],
  };
}

function baseDraft(): BatchDraftWithMainline {
  return {
    schemaVersion: 2,
    rangeRef: {
      fromChapterId: 7,
      fromPosition: 6,
      throughChapterId: 9,
      throughPosition: 8,
    },
    chapterSummaries: chapters.map(item => ({
      chapterId: item.id,
      chapterPosition: item.position,
      brief: `第${item.position + 1}章事件`,
      keywords: [],
      events: [],
      characterChanges: [],
      relationshipChanges: [],
      mainlineChanges: [],
      newThreads: [],
      resolvedThreads: [],
    })),
    newCharacters: [],
    characterUpdates: [],
    newRelationships: [],
    relationshipUpdates: [],
    mainlinePatch: emptyMainlinePatch(),
  };
}

describe('reconcileStoryMemoryMainlineDraft', () => {
  it('Rule A: summary mainlineChanges but no structured mutation → downgrade to events', () => {
    const draft = baseDraft();
    draft.chapterSummaries[0].mainlineChanges = ['调查方向转向地下室'];
    // mainlinePatch is all-empty → hasMainlineStateMutation=false

    const { reconciledDraft, diagnostics } = reconcileStoryMemoryMainlineDraft(draft);

    // Information preserved for retrieval, moved to events (tagged so the
    // retrieval layer keeps the mainline-classification origin).
    expect(reconciledDraft.chapterSummaries[0].events).toContain(
      '[主线] 调查方向转向地下室',
    );
    // mainlineChanges cleared so strict validator no longer hard-fails.
    expect(
      reconciledDraft.chapterSummaries[0].mainlineChanges,
    ).toHaveLength(0);
    expect(diagnostics.downgradedMainlineChanges).toBe(1);
  });

  it('Rule A does NOT discard info: appends to existing events', () => {
    const draft = baseDraft();
    draft.chapterSummaries[0].events = ['既有事件'];
    draft.chapterSummaries[0].mainlineChanges = ['主线转向'];

    const { reconciledDraft } = reconcileStoryMemoryMainlineDraft(draft);

    expect(reconciledDraft.chapterSummaries[0].events).toContain('既有事件');
    expect(reconciledDraft.chapterSummaries[0].events).toContain(
      '[主线] 主线转向',
    );
  });

  it('Rule A: leaves mainlineChanges when structured mutation exists', () => {
    const draft = baseDraft();
    draft.chapterSummaries[0].mainlineChanges = ['调查方向转向地下室'];
    draft.mainlinePatch.threadOpens = [
      {
        ref: 'new_thread_1',
        title: '地下室线索',
        description: '地下室入口的加密线索',
        evidence: [{ chapterId: 8, quote: '林岚在地下室入口发现新的加密线索' }],
      },
    ];

    const { reconciledDraft, diagnostics } = reconcileStoryMemoryMainlineDraft(draft);

    expect(
      reconciledDraft.chapterSummaries[0].mainlineChanges,
    ).toHaveLength(1);
    expect(diagnostics.downgradedMainlineChanges).toBe(0);
  });

  it('Rule B: summary newThreads but no thread op → downgrade to events', () => {
    const draft = baseDraft();
    draft.chapterSummaries[1].newThreads = ['地下室的加密线索'];

    const { reconciledDraft, diagnostics } = reconcileStoryMemoryMainlineDraft(draft);

    expect(reconciledDraft.chapterSummaries[1].events).toContain(
      '[新线索] 地下室的加密线索',
    );
    expect(reconciledDraft.chapterSummaries[1].newThreads).toHaveLength(0);
    expect(diagnostics.downgradedNewThreads).toBe(1);
  });

  it('Rule C: summary resolvedThreads but no closure op → downgrade to events', () => {
    const draft = baseDraft();
    draft.chapterSummaries[2].resolvedThreads = ['封锁地下室消息'];

    const { reconciledDraft, diagnostics } = reconcileStoryMemoryMainlineDraft(draft);

    expect(reconciledDraft.chapterSummaries[2].events).toContain(
      '[已解决] 封锁地下室消息',
    );
    expect(reconciledDraft.chapterSummaries[2].resolvedThreads).toHaveLength(0);
    expect(diagnostics.downgradedResolvedThreads).toBe(1);
  });

  it('Rule D: structured mutation but assessment=unchanged → normalize to changed', () => {
    const draft = baseDraft();
    draft.mainlinePatch.threadOpens = [
      {
        ref: 'new_thread_1',
        title: '地下室线索',
        description: '',
        evidence: [{ chapterId: 8, quote: '林岚在地下室入口发现新的加密线索' }],
      },
    ];
    draft.mainlinePatch.assessment = {
      result: 'unchanged',
      reason: '错误标签',
    };

    const { reconciledDraft, diagnostics } = reconcileStoryMemoryMainlineDraft(draft);

    expect(reconciledDraft.mainlinePatch.assessment?.result).toBe('changed');
    expect(diagnostics.normalizedAssessment).toBe('changed');
  });

  it('Rule E: no mutation but assessment=changed → normalize to unchanged', () => {
    const draft = baseDraft();
    draft.mainlinePatch.assessment = {
      result: 'changed',
      reason: '错误标签',
    };

    const { reconciledDraft, diagnostics } = reconcileStoryMemoryMainlineDraft(draft);

    expect(reconciledDraft.mainlinePatch.assessment?.result).toBe('unchanged');
    expect(diagnostics.normalizedAssessment).toBe('unchanged');
  });

  it('does NOT reverse-synthesize State from summaries', () => {
    const draft = baseDraft();
    draft.chapterSummaries[0].mainlineChanges = ['主线转向'];
    draft.chapterSummaries[0].newThreads = ['新线索'];
    draft.chapterSummaries[0].resolvedThreads = ['已解决事项'];

    const { reconciledDraft } = reconcileStoryMemoryMainlineDraft(draft);

    // Structured state must remain empty — reconciler only moves text to events.
    expect(reconciledDraft.mainlinePatch.threadOpens).toHaveLength(0);
    expect(reconciledDraft.mainlinePatch.conflictUpserts).toHaveLength(0);
    expect(reconciledDraft.mainlinePatch.threadResolutions).toHaveLength(0);
    expect(reconciledDraft.mainlinePatch.currentObjective).toBeUndefined();
  });

  it('never mutates the original draft (returns a new object)', () => {
    const draft = baseDraft();
    draft.chapterSummaries[0].mainlineChanges = ['主线转向'];
    const originalEvents = draft.chapterSummaries[0].events.length;

    const { reconciledDraft } = reconcileStoryMemoryMainlineDraft(draft);

    expect(draft.chapterSummaries[0].mainlineChanges).toHaveLength(1);
    expect(draft.chapterSummaries[0].events).toHaveLength(originalEvents);
    expect(reconciledDraft).not.toBe(draft);
  });

  it('complex-fixture reproduction: summary mainlineChanges + structured none → reconciled, strict validator PASS', () => {
    // This is the shape of the real-world complex-novel failure: HTTP 200 x3,
    // each time chapterSummaries.mainlineChanges was set but mainlinePatch had
    // no structured mutation, so validateBatchMainlineSummaryConsistency threw
    // MEMORY_CHECKPOINT_SCHEMA_INVALID three times and failed closed.
    const draft = baseDraft();
    draft.chapterSummaries[0].mainlineChanges = ['调查方向转向地下室'];
    draft.chapterSummaries[1].newThreads = ['地下室加密线索'];
    draft.chapterSummaries[2].resolvedThreads = ['封锁消息'];

    const { reconciledDraft, diagnostics } = reconcileStoryMemoryMainlineDraft(draft);

    expect(diagnostics.downgradedMainlineChanges).toBe(1);
    expect(diagnostics.downgradedNewThreads).toBe(1);
    expect(diagnostics.downgradedResolvedThreads).toBe(1);

    // After reconcile, no summary carries mainline-classification text that
    // would trip validateBatchMainlineSummaryConsistency.
    reconciledDraft.chapterSummaries.forEach(summary => {
      expect(summary.mainlineChanges).toHaveLength(0);
      expect(summary.newThreads).toHaveLength(0);
      expect(summary.resolvedThreads).toHaveLength(0);
    });

    // Information is retained in events for retrieval (tagged by origin).
    const allEvents = reconciledDraft.chapterSummaries.flatMap(s => s.events);
    expect(allEvents).toContain('[主线] 调查方向转向地下室');
    expect(allEvents).toContain('[新线索] 地下室加密线索');
    expect(allEvents).toContain('[已解决] 封锁消息');
  });

  it('leaves truly-structured data untouched for strict validator to check', () => {
    // Reconciler handles only classification divergence. Real schema/reference
    // errors (e.g. a threadOpens referencing a bad shape) still flow through to
    // validateChapterMemoryPatch and hard-fail there.
    const draft = baseDraft();
    draft.mainlinePatch.threadOpens = [
      {
        ref: 'new_thread_1',
        title: '地下室线索',
        description: '',
        evidence: [{ chapterId: 8, quote: '林岚在地下室入口发现新的加密线索' }],
      },
    ];
    draft.mainlinePatch.assessment = { result: 'changed', reason: '有线索' };

    const { reconciledDraft } = reconcileStoryMemoryMainlineDraft(draft);

    expect(reconciledDraft.mainlinePatch.threadOpens).toHaveLength(1);
    expect(reconciledDraft.mainlinePatch.assessment?.result).toBe('changed');
  });
});

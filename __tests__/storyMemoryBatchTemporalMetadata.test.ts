/**
 * P0-1: Batch → Merger temporal metadata must come from Evidence chapters,
 * not the batch through chapter.
 *
 * Path under test:
 * compile → hard validate → applyStoryMemoryBatchPatch → final StoryMemoryState
 */
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import { buildStoryMemoryEntityHandles } from '../src/services/storyMemory/storyMemoryEntityHandles';
import { buildStoryMemoryEvidenceAnchors } from '../src/services/storyMemory/storyMemoryEvidenceAnchors';
import { applyStoryMemoryBatchPatch } from '../src/services/storyMemory/storyMemoryMerger';
import {
  compileStoryMemoryObservations,
  validateCompiledStoryMemoryBatchPatch,
} from '../src/services/storyMemory/storyMemoryObservationCompiler';
import { normalizeStoryMemoryObservationPayload } from '../src/services/storyMemory/storyMemoryObservationNormalizer';
import type { Chapter } from '../src/types/novel';
import type {
  StoryCharacter,
  StoryMemoryBatchPatchDraft,
  StoryMemoryState,
} from '../src/services/storyMemory/storyMemoryTypes';

function chapter(id: number, position: number, content: string): Chapter {
  return {
    id,
    project_id: 1,
    position,
    title: `第 ${position + 1} 章`,
    synopsis: `第 ${position + 1} 章推进主线。`,
    content,
    status: 'final',
    summary_json: null,
    memory_summary: '',
    created_at: '',
    updated_at: '',
  };
}

function character(id: string, name: string): StoryCharacter {
  return {
    id,
    canonicalName: name,
    aliases: [],
    role: '调查者',
    immutableProfile: {
      identity: '',
      stableTraits: [],
      affiliations: [],
    },
    currentState: {
      location: '钟楼',
      physicalState: '',
      emotionalState: '警惕',
      currentGoal: '查明入口',
      knowledge: [],
      possessions: [],
      secrets: [],
    },
    status: 'active',
    firstSeenChapterId: 1,
    firstSeenPosition: 0,
    lastChangedChapterId: 1,
    lastChangedPosition: 0,
    evidenceChapterIds: [1],
  };
}

function baseState(): StoryMemoryState {
  const state = createEmptyStoryMemory(1);
  state.characters = {
    hero: character('hero', '林岚'),
    companion: character('companion', '陈叔'),
  };
  return state;
}

function rawChapter(
  chapterHandle: string,
  observations: unknown[],
  brief = '本章推进连续性状态。',
): Record<string, unknown> {
  return {
    chapter: chapterHandle,
    brief,
    events: ['连续性事件'],
    keywords: ['主线'],
    observations,
  };
}

function compile(
  state: StoryMemoryState,
  chapters: Chapter[],
  rawChapters: Array<Record<string, unknown>>,
) {
  const handles = buildStoryMemoryEntityHandles(state, chapters);
  const evidence = buildStoryMemoryEvidenceAnchors(
    chapters,
    handles.chapterHandleById,
  );
  const normalized = normalizeStoryMemoryObservationPayload(
    { chapters: rawChapters },
    handles.chapters.map(item => item.handle),
  );
  const result = compileStoryMemoryObservations({
    chapters,
    previousState: state,
    normalized: normalized.chapters,
    handles,
    evidence,
  });
  return { ...result, evidence, handles };
}

function applyLifecycle(patch: StoryMemoryBatchPatchDraft, state: StoryMemoryState) {
  return applyStoryMemoryBatchPatch(state, patch, {
    projectId: 1,
    sourceFingerprint: 'batch-temporal-metadata',
    batchId: 'batch-temporal-metadata',
  });
}

describe('Story Memory batch temporal metadata', () => {
  // Content sentences must stay aligned with Q001..Q014 anchors used below.
  const chapters = [
    chapter(
      1,
      0,
      '守门人首次出现。守门人与林岚建立对峙关系。入口阻拦冲突开启。地下室钥匙线索出现。墙上留下三角刻痕。',
    ),
    chapter(
      2,
      1,
      '守门人改变态度。关系状态明显缓和。入口阻拦暂时缓和。钥匙线索补充来源。三角刻痕出现新的指向。',
    ),
    chapter(
      3,
      2,
      '守门人最终放行。入口阻拦冲突解决。钥匙来源得到确认。三角刻痕部分回收。三角刻痕完成回收。',
    ),
  ];

  function compileLifecycle() {
    const state = baseState();
    const result = compile(state, chapters, [
      rawChapter('CH01', [
        {
          kind: 'character_new',
          key: 'N_GUARD',
          name: '守门人',
          evidence: ['Q001'],
        },
        {
          kind: 'relationship',
          op: 'open',
          key: 'N_REL',
          from: 'C01',
          to: 'N_GUARD',
          type: '对峙',
          state: '互相试探',
          evidence: ['Q002'],
        },
        {
          kind: 'conflict',
          op: 'open',
          key: 'N_CONFLICT',
          title: '入口阻拦',
          parties: ['C01', 'N_GUARD'],
          state: '守门人阻止进入',
          evidence: ['Q003'],
        },
        {
          kind: 'thread',
          op: 'open',
          key: 'N_THREAD',
          title: '钥匙来源',
          owners: ['C01'],
          description: '钥匙制造者尚未确认',
          evidence: ['Q004'],
        },
        {
          kind: 'foreshadowing',
          op: 'open',
          key: 'N_FORE',
          setup: '墙上三角刻痕',
          expectedPayoff: '指向地下机关',
          evidence: ['Q005'],
        },
      ]),
      rawChapter('CH02', [
        {
          kind: 'character_state',
          ref: 'N_GUARD',
          field: 'location',
          op: 'set',
          value: '地下入口',
          evidence: ['Q006'],
        },
        {
          kind: 'relationship',
          op: 'update',
          ref: 'N_REL',
          state: '关系缓和',
          trust: 'high',
          evidence: ['Q007'],
        },
        {
          kind: 'conflict',
          op: 'update',
          ref: 'N_CONFLICT',
          state: '暂时缓和',
          evidence: ['Q008'],
        },
        {
          kind: 'thread',
          op: 'update',
          ref: 'N_THREAD',
          description: '钥匙来自旧仓库',
          evidence: ['Q009'],
        },
        {
          kind: 'foreshadowing',
          op: 'update',
          ref: 'N_FORE',
          expectedPayoff: '指向地下机关入口',
          evidence: ['Q010'],
        },
      ]),
      rawChapter('CH03', [
        {
          kind: 'conflict',
          op: 'resolve',
          ref: 'N_CONFLICT',
          payoff: '守门人放行',
          evidence: ['Q011'],
        },
        {
          kind: 'thread',
          op: 'resolve',
          ref: 'N_THREAD',
          payoff: '钥匙来自旧仓库',
          evidence: ['Q012'],
        },
        {
          kind: 'foreshadowing',
          op: 'partial',
          ref: 'N_FORE',
          payoff: '确认与机关有关',
          evidence: ['Q013'],
        },
        {
          kind: 'foreshadowing',
          op: 'resolve',
          ref: 'N_FORE',
          payoff: '机关入口已经开启',
          evidence: ['Q014'],
        },
      ]),
    ]);
    validateCompiledStoryMemoryBatchPatch(
      result.patch,
      state,
      chapters,
      result.evidence,
    );
    const applied = applyLifecycle(result.patch, state);
    return { state, result, applied };
  }

  it('character firstSeen stays on CH1 and lastChanged on latest evidence', () => {
    const { applied } = compileLifecycle();
    const guard = Object.values(applied.state.characters).find(
      item => item.canonicalName === '守门人',
    );
    expect(guard).toBeTruthy();
    expect(guard!.firstSeenChapterId).toBe(1);
    expect(guard!.firstSeenPosition).toBe(0);
    expect(guard!.lastChangedChapterId).toBe(2);
    expect(guard!.lastChangedPosition).toBe(1);
    expect(guard!.currentState.location).toBe('地下入口');
    // Must not flatten everything to through chapter (CH3 / position 2).
    expect(guard!.firstSeenChapterId).not.toBe(3);
    expect(guard!.firstSeenPosition).not.toBe(2);
  });

  it('relationship firstSeen=CH1 and lastChanged=CH2', () => {
    const { applied } = compileLifecycle();
    const relationship = Object.values(applied.state.relationships).find(
      item => item.relationType === '对峙',
    );
    expect(relationship).toBeTruthy();
    expect(relationship!.firstSeenChapterId).toBe(1);
    expect(relationship!.lastChangedChapterId).toBe(2);
    expect(relationship!.lastChangedPosition).toBe(1);
    expect(relationship!.currentState).toBe('关系缓和');
    expect(relationship!.firstSeenChapterId).not.toBe(3);
    expect(relationship!.lastChangedChapterId).not.toBe(3);
  });

  it('conflict opens on CH1 and resolves into CH3 completed beat', () => {
    const { applied } = compileLifecycle();
    expect(Object.values(applied.state.mainline.activeConflicts)).toEqual([]);
    const beat = applied.state.mainline.recentCompletedBeats.find(item =>
      item.summary.includes('入口阻拦'),
    );
    expect(beat).toBeTruthy();
    expect(beat!.chapterId).toBe(3);
    expect(beat!.chapterId).not.toBe(1);
  });

  it('resolved thread keeps opened=CH1 and resolved=CH3', () => {
    const { applied } = compileLifecycle();
    expect(Object.values(applied.state.mainline.openThreads)).toEqual([]);
    const resolved = applied.state.mainline.recentResolvedThreads.find(
      item => item.title === '钥匙来源',
    );
    expect(resolved).toBeTruthy();
    expect(resolved!.openedChapterId).toBe(1);
    expect(resolved!.resolvedChapterId).toBe(3);
    expect(resolved!.openedChapterId).not.toBe(resolved!.resolvedChapterId);
  });

  it('foreshadow opened=CH1 lastChanged=CH3 status=paid', () => {
    const { applied } = compileLifecycle();
    const foreshadow = Object.values(applied.state.mainline.foreshadowing).find(
      item => item.setup.includes('三角刻痕'),
    );
    expect(foreshadow).toBeTruthy();
    expect(foreshadow!.status).toBe('paid');
    expect(foreshadow!.openedChapterId).toBe(1);
    expect(foreshadow!.lastChangedChapterId).toBe(3);
    expect(foreshadow!.openedChapterId).not.toBe(3);
  });

  it('timeline chapterId uses evidence chapter CH2 not through CH3', () => {
    const { result } = compileLifecycle();
    // Timeline is injected at BatchPatch level with CH2 evidence so this case
    // isolates Merger temporal recovery without depending on Q-id shifts.
    const draft: StoryMemoryBatchPatchDraft = {
      ...result.patch,
      mainlinePatch: {
        ...result.patch.mainlinePatch,
        timelineAnchors: [
          {
            ref: 'timeline_midnight',
            label: '子夜',
            timeDescription: '子夜时分',
            event: '时钟指向子夜',
            pinned: false,
            evidence: [{ chapterId: 2, quote: '关系状态明显缓和' }],
          },
        ],
      },
    };
    const full = applyLifecycle(draft, baseState());
    const timeline = Object.values(full.state.mainline.timelineAnchors)[0];
    expect(timeline).toBeTruthy();
    expect(timeline.chapterId).toBe(2);
    expect(timeline.chapterId).not.toBe(3);
    expect(full.state.throughChapterPosition).toBe(2);
  });

  it('keeps single batch CAS semantics: one through chapter advance', () => {
    const { applied } = compileLifecycle();
    expect(applied.state.throughChapterId).toBe(3);
    expect(applied.state.throughChapterPosition).toBe(2);
    expect(applied.resolvedBatch.status).toBe('applied');
    expect(applied.resolvedBatch.batchId).toBe('batch-temporal-metadata');
  });

  it('preserves character CH1 and CH2 boundaries after folding more than three observations', () => {
    const state = baseState();
    const boundaryChapters = [
      chapter(
        101,
        0,
        '守门人首次出现。\n守门人站在旧门厅。\n守门人情绪紧张。\n守门人守住入口。',
      ),
      chapter(7, 1, '守门人最终到达地下入口。'),
    ];
    const result = compile(state, boundaryChapters, [
      rawChapter('CH01', [
        {
          kind: 'character_new',
          key: 'N_GUARD',
          name: '守门人',
          evidence: ['Q001'],
        },
        {
          kind: 'character_state',
          ref: 'N_GUARD',
          field: 'location',
          op: 'set',
          value: '旧门厅',
          evidence: ['Q002'],
        },
        {
          kind: 'character_state',
          ref: 'N_GUARD',
          field: 'emotionalState',
          op: 'set',
          value: '紧张',
          evidence: ['Q003'],
        },
        {
          kind: 'character_state',
          ref: 'N_GUARD',
          field: 'currentGoal',
          op: 'set',
          value: '守住入口',
          evidence: ['Q004'],
        },
      ]),
      rawChapter('CH02', [
        {
          kind: 'character_state',
          ref: 'N_GUARD',
          field: 'location',
          op: 'set',
          value: '地下入口',
          evidence: ['Q005'],
        },
      ]),
    ]);

    validateCompiledStoryMemoryBatchPatch(
      result.patch,
      state,
      boundaryChapters,
      result.evidence,
    );
    const applied = applyLifecycle(result.patch, state);
    const guard = Object.values(applied.state.characters).find(
      item => item.canonicalName === '守门人',
    );

    expect(result.patch.newCharacters[0].evidence).toEqual(
      expect.arrayContaining([
        { chapterId: 101, quote: '守门人首次出现。' },
        { chapterId: 7, quote: '守门人最终到达地下入口。' },
      ]),
    );
    expect(result.patch.newCharacters[0].evidence.length).toBeLessThanOrEqual(3);
    expect(guard?.firstSeenChapterId).toBe(101);
    expect(guard?.firstSeenPosition).toBe(0);
    expect(guard?.lastChangedChapterId).toBe(7);
    expect(guard?.lastChangedPosition).toBe(1);
    expect(guard?.currentState.location).toBe('地下入口');
  });

  it('preserves relationship CH1 and CH2 boundaries after folding more than three observations', () => {
    const state = baseState();
    const boundaryChapters = [
      chapter(
        42,
        0,
        '林岚与陈叔建立对峙。\n两人关系仍然紧张。\n两人开始互相试探。\n关系出现细微变化。',
      ),
      chapter(7, 1, '两人关系最终缓和。'),
    ];
    const result = compile(state, boundaryChapters, [
      rawChapter('CH01', [
        {
          kind: 'relationship',
          op: 'open',
          key: 'N_REL',
          from: 'C01',
          to: 'C02',
          type: '对峙',
          state: '互相试探',
          evidence: ['Q001'],
        },
        {
          kind: 'relationship',
          op: 'update',
          ref: 'N_REL',
          state: '仍然紧张',
          evidence: ['Q002'],
        },
        {
          kind: 'relationship',
          op: 'update',
          ref: 'N_REL',
          state: '开始试探',
          evidence: ['Q003'],
        },
        {
          kind: 'relationship',
          op: 'update',
          ref: 'N_REL',
          state: '出现变化',
          evidence: ['Q004'],
        },
      ]),
      rawChapter('CH02', [
        {
          kind: 'relationship',
          op: 'update',
          ref: 'N_REL',
          state: '最终缓和',
          evidence: ['Q005'],
        },
      ]),
    ]);

    validateCompiledStoryMemoryBatchPatch(
      result.patch,
      state,
      boundaryChapters,
      result.evidence,
    );
    const applied = applyLifecycle(result.patch, state);
    const relationship = Object.values(applied.state.relationships).find(
      item => item.relationType === '对峙',
    );

    expect(result.patch.newRelationships[0].evidence).toEqual(
      expect.arrayContaining([
        { chapterId: 42, quote: '林岚与陈叔建立对峙。' },
        { chapterId: 7, quote: '两人关系最终缓和。' },
      ]),
    );
    expect(result.patch.newRelationships[0].evidence.length).toBeLessThanOrEqual(3);
    expect(relationship?.firstSeenChapterId).toBe(42);
    expect(relationship?.lastChangedChapterId).toBe(7);
    expect(relationship?.lastChangedPosition).toBe(1);
    expect(relationship?.currentState).toBe('最终缓和');
  });

  it('preserves a CH3 foreshadow resolution after three earlier CH1 observations', () => {
    const state = baseState();
    const boundaryChapters = [
      chapter(
        1000,
        0,
        '墙上出现三角刻痕。\n刻痕边缘被重新描摹。\n刻痕与机关出现部分联系。',
      ),
      chapter(17, 1, '守门人继续观察入口。'),
      chapter(3, 2, '机关入口已经开启。'),
    ];
    const result = compile(state, boundaryChapters, [
      rawChapter('CH01', [
        {
          kind: 'foreshadowing',
          op: 'open',
          key: 'N_FORE',
          setup: '墙上三角刻痕',
          expectedPayoff: '指向地下机关',
          evidence: ['Q001'],
        },
        {
          kind: 'foreshadowing',
          op: 'update',
          ref: 'N_FORE',
          expectedPayoff: '指向地下机关入口',
          evidence: ['Q002'],
        },
        {
          kind: 'foreshadowing',
          op: 'partial',
          ref: 'N_FORE',
          payoff: '确认与机关有关',
          evidence: ['Q003'],
        },
      ]),
      rawChapter('CH02', []),
      rawChapter('CH03', [
        {
          kind: 'foreshadowing',
          op: 'resolve',
          ref: 'N_FORE',
          payoff: '机关入口已经开启',
          evidence: ['Q005'],
        },
      ]),
    ]);

    validateCompiledStoryMemoryBatchPatch(
      result.patch,
      state,
      boundaryChapters,
      result.evidence,
    );
    const applied = applyLifecycle(result.patch, state);
    const foreshadow = Object.values(applied.state.mainline.foreshadowing).find(
      item => item.setup.includes('三角刻痕'),
    );

    expect(result.patch.mainlinePatch.foreshadowingUpserts[0].evidence).toEqual(
      expect.arrayContaining([
        { chapterId: 1000, quote: '墙上出现三角刻痕。' },
        { chapterId: 3, quote: '机关入口已经开启。' },
      ]),
    );
    expect(
      result.patch.mainlinePatch.foreshadowingUpserts[0].evidence.length,
    ).toBeLessThanOrEqual(3);
    expect(foreshadow?.status).toBe('paid');
    expect(foreshadow?.openedChapterId).toBe(1000);
    expect(foreshadow?.lastChangedChapterId).toBe(3);
  });

  it('keeps all three ordered chapters covered when one Patch Item has four observations', () => {
    const state = baseState();
    const boundaryChapters = [
      chapter(50, 0, '关系首次建立。\n关系第一次变化。'),
      chapter(1, 1, '关系在中段继续变化。'),
      chapter(10, 2, '关系在末章最终稳定。'),
    ];
    const result = compile(state, boundaryChapters, [
      rawChapter('CH01', [
        {
          kind: 'relationship',
          op: 'open',
          key: 'N_REL',
          from: 'C01',
          to: 'C02',
          type: '同盟',
          state: '初步结盟',
          evidence: ['Q001'],
        },
        {
          kind: 'relationship',
          op: 'update',
          ref: 'N_REL',
          state: '暂时结盟',
          evidence: ['Q002'],
        },
      ]),
      rawChapter('CH02', [
        {
          kind: 'relationship',
          op: 'update',
          ref: 'N_REL',
          state: '中段稳固',
          evidence: ['Q003'],
        },
      ]),
      rawChapter('CH03', [
        {
          kind: 'relationship',
          op: 'update',
          ref: 'N_REL',
          state: '最终稳定',
          evidence: ['Q004'],
        },
      ]),
    ]);

    validateCompiledStoryMemoryBatchPatch(
      result.patch,
      state,
      boundaryChapters,
      result.evidence,
    );
    const applied = applyLifecycle(result.patch, state);
    const relationshipPatch = result.patch.newRelationships[0];
    const relationship = Object.values(applied.state.relationships).find(
      item => item.relationType === '同盟',
    );

    expect(relationshipPatch.evidence.length).toBeLessThanOrEqual(3);
    expect(
      [...new Set(relationshipPatch.evidence.map(item => item.chapterId))],
    ).toEqual([50, 1, 10]);
    expect(relationship?.firstSeenChapterId).toBe(50);
    expect(relationship?.lastChangedChapterId).toBe(10);
    expect(relationship?.lastChangedPosition).toBe(2);
    expect(relationship?.currentState).toBe('最终稳定');
  });
});

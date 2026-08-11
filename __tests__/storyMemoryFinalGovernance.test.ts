import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import { buildStoryMemoryEntityHandles } from '../src/services/storyMemory/storyMemoryEntityHandles';
import { buildStoryMemoryEvidenceAnchors } from '../src/services/storyMemory/storyMemoryEvidenceAnchors';
import { applyStoryMemoryBatchPatch } from '../src/services/storyMemory/storyMemoryMerger';
import {
  compileStoryMemoryObservations,
  validateCompiledStoryMemoryBatchPatch,
} from '../src/services/storyMemory/storyMemoryObservationCompiler';
import { normalizeStoryMemoryObservationPayload } from '../src/services/storyMemory/storyMemoryObservationNormalizer';
import { STORY_MEMORY_V2_OBSERVER_CONTRACT } from '../src/services/storyMemory/storyMemoryObservationPrompts';
import {
  evaluateStoryMemoryKnownChangeSemanticGate,
  recordStoryMemoryV2Warnings,
  type StoryMemoryV2Diagnostics,
} from '../src/services/storyMemory/storyMemoryV2Diagnostics';
import type { Chapter } from '../src/types/novel';
import type {
  StoryCharacter,
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
  return { ...result, evidence };
}

function rawChapter(
  chapterHandle: string,
  observations: unknown[],
  brief = '本章推进连续性状态。',
): Record<string, unknown> {
  return { chapter: chapterHandle, brief, events: [], observations };
}

describe('Story Memory V2 final governance — chronology', () => {
  it('documents the relationship-open shape required by the temp-ref lifecycle', () => {
    expect(STORY_MEMORY_V2_OBSERVER_CONTRACT).toContain(
      'relationship","op":"open","key":"N5","from":"C01","to":"C02"',
    );
  });

  it.each([
    {
      name: 'character',
      before: {
        kind: 'character_state',
        ref: 'N1',
        field: 'location',
        op: 'set',
        value: '地下室',
        evidence: ['Q001'],
      },
      definition: {
        kind: 'character_new',
        key: 'N1',
        name: '守门人',
        evidence: ['Q002'],
      },
    },
    {
      name: 'relationship',
      before: {
        kind: 'relationship',
        op: 'update',
        ref: 'N1',
        state: '关系缓和',
        evidence: ['Q001'],
      },
      definition: {
        kind: 'relationship',
        op: 'open',
        key: 'N1',
        from: 'C01',
        to: 'C02',
        type: '对峙',
        evidence: ['Q002'],
      },
    },
    {
      name: 'conflict',
      before: {
        kind: 'conflict',
        op: 'update',
        ref: 'N1',
        title: '入口阻拦',
        state: '暂时缓和',
        evidence: ['Q001'],
      },
      definition: {
        kind: 'conflict',
        op: 'open',
        key: 'N1',
        title: '入口阻拦',
        parties: ['C01'],
        evidence: ['Q002'],
      },
    },
    {
      name: 'thread',
      before: {
        kind: 'thread',
        op: 'update',
        ref: 'N1',
        title: '钥匙来源',
        description: '仍未确认',
        evidence: ['Q001'],
      },
      definition: {
        kind: 'thread',
        op: 'open',
        key: 'N1',
        title: '钥匙来源',
        owners: ['C01'],
        evidence: ['Q002'],
      },
    },
    {
      name: 'foreshadowing',
      before: {
        kind: 'foreshadowing',
        op: 'partial',
        ref: 'N1',
        setup: '三角刻痕',
        payoff: '机关',
        evidence: ['Q001'],
      },
      definition: {
        kind: 'foreshadowing',
        op: 'open',
        key: 'N1',
        setup: '三角刻痕',
        expectedPayoff: '机关',
        evidence: ['Q002'],
      },
    },
  ])(
    '$name ref from an earlier chapter cannot see a later definition',
    scenario => {
      const state = baseState();
      const chapters = [
        chapter(1, 0, '林岚先记录了未知状态。'),
        chapter(2, 1, '后来才出现守门人与新的连续性实体。'),
      ];
      const result = compile(state, chapters, [
        rawChapter('CH01', [scenario.before]),
        rawChapter('CH02', [scenario.definition]),
      ]);

      expect(result.acceptedObservations).toBe(1);
      expect(result.droppedObservations).toBe(1);
      expect(result.warnings.map(item => item.code)).toContain(
        'OBS_FUTURE_REF',
      );
    },
  );

  it('drops same-chapter earlier references while allowing later references', () => {
    const state = baseState();
    const chapters = [chapter(1, 0, '未知状态先出现。守门人随后现身。')];

    const earlier = compile(state, chapters, [
      rawChapter('CH01', [
        {
          kind: 'character_state',
          ref: 'N1',
          field: 'location',
          op: 'set',
          value: '地下室',
          evidence: ['Q001'],
        },
        {
          kind: 'character_new',
          key: 'N1',
          name: '守门人',
          evidence: ['Q002'],
        },
      ]),
    ]);
    expect(earlier.acceptedObservations).toBe(1);
    expect(earlier.patch.characterUpdates).toHaveLength(0);

    const later = compile(state, chapters, [
      rawChapter('CH01', [
        {
          kind: 'character_new',
          key: 'N1',
          name: '守门人',
          evidence: ['Q001'],
        },
        {
          kind: 'character_state',
          ref: 'N1',
          field: 'location',
          op: 'set',
          value: '地下室',
          evidence: ['Q002'],
        },
      ]),
    ]);
    expect(later.acceptedObservations).toBe(2);
    expect(later.patch.newCharacters).toHaveLength(1);
  });

  it.each([
    {
      name: 'relationship',
      before: {
        kind: 'relationship',
        op: 'update',
        ref: 'N1',
        state: '关系缓和',
        evidence: ['Q001'],
      },
      definition: {
        kind: 'relationship',
        op: 'open',
        key: 'N1',
        from: 'C01',
        to: 'C02',
        type: '对峙',
        evidence: ['Q002'],
      },
    },
    {
      name: 'conflict',
      before: {
        kind: 'conflict',
        op: 'update',
        ref: 'N1',
        state: '暂时缓和',
        evidence: ['Q001'],
      },
      definition: {
        kind: 'conflict',
        op: 'open',
        key: 'N1',
        title: '入口阻拦',
        parties: ['C01'],
        evidence: ['Q002'],
      },
    },
    {
      name: 'thread',
      before: {
        kind: 'thread',
        op: 'update',
        ref: 'N1',
        title: '钥匙来源',
        evidence: ['Q001'],
      },
      definition: {
        kind: 'thread',
        op: 'open',
        key: 'N1',
        title: '钥匙来源',
        owners: ['C01'],
        evidence: ['Q002'],
      },
    },
    {
      name: 'foreshadowing',
      before: {
        kind: 'foreshadowing',
        op: 'partial',
        ref: 'N1',
        payoff: '机关',
        evidence: ['Q001'],
      },
      definition: {
        kind: 'foreshadowing',
        op: 'open',
        key: 'N1',
        setup: '三角刻痕',
        expectedPayoff: '机关',
        evidence: ['Q002'],
      },
    },
  ])('$name same-chapter future ref is dropped', scenario => {
    const result = compile(
      baseState(),
      [chapter(1, 0, '未知状态先出现。随后定义新的连续性实体。')],
      [rawChapter('CH01', [scenario.before, scenario.definition])],
    );

    expect(result.acceptedObservations).toBe(1);
    expect(result.droppedObservations).toBe(1);
    expect(result.warnings.map(item => item.code)).toContain('OBS_FUTURE_REF');
  });
});

describe('Story Memory V2 final governance — known-change QA gate', () => {
  it('rejects HTTP-success-shaped results with zero accepted observations', () => {
    const result = evaluateStoryMemoryKnownChangeSemanticGate({
      observationsReceived: 0,
      observationsAccepted: 0,
      patch: {
        mainlinePatch: {
          conflictUpserts: [],
          conflictResolutions: [],
          threadOpens: [],
          threadUpdates: [],
          threadResolutions: [],
          foreshadowingUpserts: [],
        },
        newCharacters: [],
        characterUpdates: [],
        newRelationships: [],
        relationshipUpdates: [],
      } as any,
    });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain('observationsAccepted');
  });
});

describe('Story Memory V2 final governance — future_ref diagnostics', () => {
  it('classifies OBS_FUTURE_REF as future_ref instead of invalid_observation', () => {
    const diagnostics = {
      normalizerWarnings: 0,
      dropReasons: {
        invalid_anchor: 0,
        invalid_ref: 0,
        future_ref: 0,
        invalid_kind: 0,
        invalid_op: 0,
        invalid_field: 0,
        invalid_endpoint: 0,
        duplicate: 0,
        invalid_observation: 0,
      },
    } as Pick<StoryMemoryV2Diagnostics, 'normalizerWarnings' | 'dropReasons'>;

    recordStoryMemoryV2Warnings(diagnostics as StoryMemoryV2Diagnostics, [
      {
        code: 'OBS_FUTURE_REF',
        message: '跨章节未来引用',
      },
    ]);

    expect(diagnostics.dropReasons.future_ref).toBe(1);
    expect(diagnostics.dropReasons.invalid_observation).toBe(0);
    expect(diagnostics.dropReasons.invalid_ref).toBe(0);
  });
});

describe('Story Memory V2 final governance — same-batch lifecycle', () => {
  it('compiles, hard-validates, merges, and persists the final state for every entity lifecycle', () => {
    const state = baseState();
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
    const applied = applyStoryMemoryBatchPatch(state, result.patch, {
      projectId: 1,
      sourceFingerprint: 'final-governance-lifecycle',
      batchId: 'batch-final-governance-lifecycle',
    });

    const guard = Object.values(applied.state.characters).find(
      item => item.canonicalName === '守门人',
    );
    expect(guard?.currentState.location).toBe('地下入口');
    const relationship = Object.values(applied.state.relationships).find(
      item => item.relationType === '对峙',
    );
    expect(relationship?.currentState).toBe('关系缓和');
    expect(relationship?.trustLevel).toBe('high');
    expect(Object.values(applied.state.mainline.activeConflicts)).toEqual([]);
    expect(Object.values(applied.state.mainline.openThreads)).toEqual([]);
    expect(Object.values(applied.state.mainline.recentResolvedThreads)).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: '钥匙来源' })]),
    );
    expect(
      Object.values(applied.state.mainline.foreshadowing).some(
        item => item.status === 'paid',
      ),
    ).toBe(true);
  });
});

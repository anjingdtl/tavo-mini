import { estimateMessagesTokens } from '../src/utils/tokenEstimator';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import {
  buildStoryMemoryEvidenceAnchors,
  isExactEvidenceSubstring,
} from '../src/services/storyMemory/storyMemoryEvidenceAnchors';
import { buildStoryMemoryEntityHandles } from '../src/services/storyMemory/storyMemoryEntityHandles';
import {
  buildMessagesFromObservationMaterials,
  buildStoryMemoryObservationMaterials,
  packWholeItems,
} from '../src/services/storyMemory/storyMemoryObservationMaterials';
import {
  buildStoryMemoryObservationFormatterMessages,
  buildStoryMemoryObservationFreshRetryMessages,
} from '../src/services/storyMemory/storyMemoryObservationFormatter';
import { normalizeStoryMemoryObservationPayload } from '../src/services/storyMemory/storyMemoryObservationNormalizer';
import {
  compileStoryMemoryObservations,
  validateCompiledStoryMemoryBatchPatch,
} from '../src/services/storyMemory/storyMemoryObservationCompiler';
import {
  planStoryMemoryFreshRetryRequest,
  planStoryMemoryObservationRequest,
  resolveStoryMemoryV2OutputBudget,
  type FrozenStoryMemoryLLMConfig,
} from '../src/services/storyMemory/storyMemoryRequestBudget';
import { estimateTokens } from '../src/utils/tokenEstimator';
import {
  createStoryMemoryV2Diagnostics,
  getRecentStoryMemoryV2Diagnostics,
  recordRecentStoryMemoryV2Diagnostics,
  recordStoryMemoryV2Plan,
} from '../src/services/storyMemory/storyMemoryV2Diagnostics';
import type { Chapter } from '../src/types/novel';
import type {
  StoryCharacter,
  StoryMemoryState,
  StoryRelationship,
} from '../src/services/storyMemory/storyMemoryTypes';

function chapter(
  id: number,
  position: number,
  content = '雨夜里，林岚推开钟楼暗门。陈叔在门后留下银钥匙，众人决定进入地下室。',
): Chapter {
  return {
    id,
    project_id: 1,
    position,
    title: `第 ${position + 1} 章`,
    synopsis: `第 ${position + 1} 章推进调查。`,
    content,
    status: 'final',
    summary_json: null,
    memory_summary: '',
    created_at: '',
    updated_at: '',
  };
}

function character(
  id: string,
  name: string,
  position = 0,
): StoryCharacter {
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
      currentGoal: '查明暗门来源',
      knowledge: [],
      possessions: [],
      secrets: [],
    },
    status: 'active',
    firstSeenChapterId: 1,
    firstSeenPosition: position,
    lastChangedChapterId: 1,
    lastChangedPosition: position,
    evidenceChapterIds: [1],
  };
}

function richState(): StoryMemoryState {
  const state = createEmptyStoryMemory(1);
  const lin = character('char_lin', '林岚');
  const chen = character('char_chen', '陈叔');
  state.characters = { [lin.id]: lin, [chen.id]: chen };
  const relationship: StoryRelationship = {
    id: 'rel_ally',
    fromCharacterId: lin.id,
    toCharacterId: chen.id,
    direction: 'bidirectional',
    relationType: '同伴',
    currentState: '互相试探',
    trustLevel: 'medium',
    publicStatus: '同伴',
    hiddenStatus: '',
    reason: '共同调查',
    firstSeenChapterId: 1,
    lastChangedChapterId: 1,
    lastChangedPosition: 0,
    evidenceChapterIds: [1],
  };
  state.relationships = { [relationship.id]: relationship };
  state.mainline.currentArc = {
    id: 'arc_investigation',
    name: '钟楼调查',
    summary: '追查暗门与地下室的关系',
    startedChapterId: 1,
  };
  state.mainline.currentObjective = '找到地下室入口';
  state.mainline.activeConflicts = {
    conflict_guard: {
      id: 'conflict_guard',
      title: '入口阻拦',
      parties: [lin.id],
      state: '守墓人阻止进入',
      stakes: '调查可能中断',
      openedChapterId: 1,
      lastChangedChapterId: 1,
      evidenceChapterIds: [1],
    },
  };
  state.mainline.openThreads = {
    thread_key: {
      id: 'thread_key',
      title: '银钥匙来源',
      description: '钥匙的制造者尚未确认',
      ownerCharacterIds: [lin.id],
      priority: 'high',
      openedChapterId: 1,
      lastChangedChapterId: 1,
      deadlineOrTrigger: '进入地下室前',
      evidenceChapterIds: [1],
    },
  };
  state.mainline.foreshadowing = {
    foreshadow_mark: {
      id: 'foreshadow_mark',
      setup: '墙上出现三角刻痕',
      expectedPayoff: '与地下室机关有关',
      status: 'open',
      openedChapterId: 1,
      lastChangedChapterId: 1,
      evidenceChapterIds: [1],
    },
  };
  return state;
}

function frozenConfig(
  contextWindow = 131072,
  maxOutputTokens = 65536,
): FrozenStoryMemoryLLMConfig {
  return {
    configId: 1,
    providerType: 'openai_compatible',
    modelName: 'protocol-v2-test-model',
    contextWindow,
    maxOutputTokens,
    requestConfig: {
      id: 1,
      provider_type: 'openai_compatible',
      api_key: 'test-only',
      model_name: 'protocol-v2-test-model',
      url: 'https://example.invalid/v1/chat/completions',
    },
  };
}

describe('Story Memory Protocol V2 anchors and handles', () => {
  const anchorCases = [
    '甲乙丙丁。',
    '雨夜里，林岚推开暗门。',
    '他说：“现在进去！”',
    'A short English sentence.',
    'emoji 😀 也必须保持原文。',
    '第一段。\n第二段。',
    '第一段。\r\n第二段。',
    '没有句号但足够长的正文片段',
    '带有，逗号：和冒号的片段。',
    '括号（线索）与「引号」同时出现。',
    '数字 2026-08-11 仍然是连续性证据。',
    '赵甲与乙方交换了钥匙。',
    '一二三四五六七八九十。',
    'The fox crossed the bridge at dawn!',
    '多行\n包含 emoji 🗝️\n和结尾。',
    '问句？随后还有一句。',
    '感叹！随后还有一句。',
    '分号；后面仍有连续事实。',
    '很短但满足最小长度。',
    '这是一个超过八十个字符的长句，包含足够多的连续性描述，锚点生成器必须稳定地切成多个完整且可精确回填的片段，而不能复制或截断半个字符。',
  ];

  it.each(anchorCases)('keeps exact source substring for anchor case %#', text => {
    const source = chapter(1, 0, text);
    const envelope = buildStoryMemoryEvidenceAnchors([source]);
    expect(envelope.anchors.every(anchor => isExactEvidenceSubstring(text, anchor))).toBe(
      true,
    );
    expect(envelope.anchors.every(anchor => Array.from(anchor.text).length <= 80)).toBe(
      true,
    );
    expect(envelope.anchors.every(anchor => text.slice(anchor.startOffset, anchor.endOffset) === anchor.text)).toBe(
      true,
    );
  });

  it('assigns deterministic Q and entity handles without exposing database ids', () => {
    const state = richState();
    const chapters = [chapter(2, 1), chapter(1, 0)];
    const handles = buildStoryMemoryEntityHandles(state, chapters);
    const evidence = buildStoryMemoryEvidenceAnchors(chapters, handles.chapterHandleById);
    expect(handles.reverseCharacter.get('char_chen')).toBe('C01');
    expect(handles.reverseCharacter.get('char_lin')).toBe('C02');
    expect(handles.reverseRelationship.get('rel_ally')).toBe('R01');
    expect(handles.reverseConflict.get('conflict_guard')).toBe('F01');
    expect(handles.reverseThread.get('thread_key')).toBe('T01');
    expect(handles.reverseForeshadowing.get('foreshadow_mark')).toBe('P01');
    expect(handles.arcHandle).toBe('A01');
    expect(handles.chapterHandleById.get(1)).toBe('CH01');
    expect(handles.chapterHandleById.get(2)).toBe('CH02');
    expect(evidence.anchors.map(anchor => anchor.id)).toEqual(['Q001', 'Q002', 'Q003', 'Q004']);
    const materialText = JSON.stringify(handles) + JSON.stringify(evidence.anchors);
    expect(materialText).not.toContain('char_lin');
    expect(materialText).not.toContain('rel_ally');
  });
});

describe('Story Memory Protocol V2 normalizer and deterministic compiler', () => {
  it('normalizes wrappers, deduplicates observations, and reports coverage gaps', () => {
    const normalized = normalizeStoryMemoryObservationPayload(
      {
        result: {
          chapters: [
            {
              chapter: 'CH01',
              brief: '',
              events: ['林岚拿到钥匙'],
              observations: [
                {
                  kind: 'character_new',
                  key: 'N1',
                  name: '新人物',
                  evidence: ['Q001'],
                },
                {
                  kind: 'character_new',
                  key: 'N1',
                  name: '新人物',
                  evidence: ['Q001'],
                },
                {
                  kind: 'not_a_kind',
                  evidence: ['Q001'],
                },
              ],
            },
            {
              chapter: 'CH01',
              brief: '重复章节的补充事实',
              events: [],
              observations: [
                {
                  kind: 'objective',
                  op: 'set',
                  value: '进入地下室',
                  evidence: ['Q002'],
                },
              ],
            },
          ],
        },
      },
      ['CH01', 'CH02'],
      { fallbackBriefByChapter: new Map([['CH02', '第二章 Anchor fallback']]) },
    );
    expect(normalized.chapters.map(chapterItem => chapterItem.chapter)).toEqual(['CH01']);
    expect(normalized.missingChapterHandles).toEqual(['CH02']);
    expect(normalized.chapters[0].brief).toBe('重复章节的补充事实');
    expect(normalized.chapters[0].observations).toHaveLength(2);
    expect(normalized.warnings.map(item => item.code)).toEqual(
      expect.arrayContaining(['OBS_DUPLICATE', 'OBS_INVALID_KIND', 'OBS_CHAPTER_DUPLICATE']),
    );
  });

  it('compiles every V2 observation kind into the existing Batch Patch schema', () => {
    const state = richState();
    const chapters = [
      chapter(
        1,
        0,
        '雨夜里，林岚推开钟楼暗门。陈叔在门后留下银钥匙。守门人退到石阶下。林岚确认墙上有三角刻痕。众人决定进入地下室。',
      ),
    ];
    const handles = buildStoryMemoryEntityHandles(state, chapters);
    const evidence = buildStoryMemoryEvidenceAnchors(chapters, handles.chapterHandleById);
    const ids = evidence.anchors.map(anchor => anchor.id);
    const normalized = normalizeStoryMemoryObservationPayload(
      {
        chapters: [
          {
            chapter: 'CH01',
            brief: '林岚进入钟楼并推动调查。',
            events: ['调查转向地下室。'],
            keywords: ['钟楼', '地下室'],
            observations: [
              { kind: 'character_new', key: 'N1', name: '守门人', evidence: [ids[0]] },
              { kind: 'character_state', ref: 'C02', field: 'location', op: 'set', value: '地下室', evidence: [ids[1]] },
              { kind: 'character_set', ref: 'C02', field: 'possession', op: 'add', value: '银钥匙', evidence: [ids[2]] },
              { kind: 'relationship', op: 'update', ref: 'R01', state: '信任加深', trust: 'high', evidence: [ids[3]] },
              { kind: 'arc', op: 'update', ref: 'A01', name: '钟楼调查', summary: '调查转向地下室', evidence: [ids[0]] },
              { kind: 'objective', op: 'set', value: '进入地下室', evidence: [ids[1]] },
              { kind: 'conflict', op: 'update', ref: 'F01', title: '入口阻拦', state: '守墓人暂时退开', parties: ['C02'], evidence: [ids[2]] },
              { kind: 'thread', op: 'update', ref: 'T01', title: '银钥匙来源', description: '钥匙来自旧仓库', owners: ['C02'], evidence: [ids[3]] },
              { kind: 'foreshadowing', op: 'partial', ref: 'P01', setup: '墙上出现三角刻痕', payoff: '与机关有关', evidence: [ids[0]] },
              { kind: 'timeline', op: 'add', label: '进入地下室', time: '当晚', event: '众人进入地下室', pinned: false, evidence: [ids[1]] },
            ],
          },
        ],
      },
      ['CH01'],
    );
    const result = compileStoryMemoryObservations({
      chapters,
      previousState: state,
      normalized: normalized.chapters,
      handles,
      evidence,
    });
    expect(result.patch.schemaVersion).toBe(2);
    expect(result.patch.chapterSummaries).toHaveLength(1);
    expect(result.patch.newCharacters[0].tempRef).toMatch(/^new_char_/u);
    expect(result.patch.characterUpdates).toHaveLength(2);
    expect(result.patch.relationshipUpdates[0].relationshipRef).toBe('rel_ally');
    expect(result.patch.mainlinePatch.currentObjective?.value).toBe('进入地下室');
    expect(result.patch.mainlinePatch.conflictUpserts).toHaveLength(1);
    expect(result.patch.mainlinePatch.threadUpdates[0].ref).toBe('thread_key');
    expect(result.patch.mainlinePatch.foreshadowingUpserts[0].status).toBe('partially_paid');
    expect(result.patch.mainlinePatch.timelineAnchors).toHaveLength(1);
    expect(result.patch.mainlinePatch.assessment?.result).toBe('changed');
    validateCompiledStoryMemoryBatchPatch(result.patch, state, chapters, evidence);
  });

  it('locally drops invalid evidence, references, kinds, and relationship endpoints', () => {
    const state = richState();
    const chapters = [chapter(1, 0)];
    const handles = buildStoryMemoryEntityHandles(state, chapters);
    const evidence = buildStoryMemoryEvidenceAnchors(chapters, handles.chapterHandleById);
    const normalized = normalizeStoryMemoryObservationPayload(
      {
        chapters: [
          {
            chapter: 'CH01',
            brief: '有效事实保留。',
            events: [],
            observations: [
              { kind: 'character_new', key: 'N1', name: '有效人物', evidence: ['Q001'] },
              { kind: 'character_state', ref: 'C99', field: 'location', op: 'set', value: '不存在', evidence: ['Q001'] },
              { kind: 'character_set', ref: 'C02', field: 'possession', op: 'add', value: '坏锚点', evidence: ['Q999'] },
              { kind: 'relationship', op: 'open', key: 'NREL', from: 'C02', to: 'C02', evidence: ['Q001'] },
            ],
          },
        ],
      },
      ['CH01'],
    );
    const result = compileStoryMemoryObservations({
      chapters,
      previousState: state,
      normalized: normalized.chapters,
      handles,
      evidence,
    });
    expect(result.patch.newCharacters).toHaveLength(1);
    expect(result.patch.characterUpdates).toHaveLength(0);
    expect(result.patch.newRelationships).toHaveLength(0);
    expect(result.warnings.map(item => item.code)).toEqual(
      expect.arrayContaining(['OBS_INVALID_REF', 'OBS_INVALID_EVIDENCE', 'OBS_INVALID_ENDPOINT']),
    );
    expect(result.droppedObservations).toBeGreaterThan(0);
  });

  it('does not pollute episodic summary when evidence is valid but ref is invalid', () => {
    const state = richState();
    const chapters = [chapter(1, 0)];
    const handles = buildStoryMemoryEntityHandles(state, chapters);
    const evidence = buildStoryMemoryEvidenceAnchors(chapters, handles.chapterHandleById);
    const normalized = normalizeStoryMemoryObservationPayload(
      {
        chapters: [
          {
            chapter: 'CH01',
            brief: '有效 brief。',
            events: ['模型原始事件可保留。'],
            keywords: ['钟楼'],
            observations: [
              {
                kind: 'character_state',
                ref: 'C99',
                field: 'location',
                op: 'set',
                value: '地下密室',
                evidence: ['Q001'],
              },
            ],
          },
        ],
      },
      ['CH01'],
    );
    const result = compileStoryMemoryObservations({
      chapters,
      previousState: state,
      normalized: normalized.chapters,
      handles,
      evidence,
    });
    const summary = result.patch.chapterSummaries[0];
    expect(result.patch.characterUpdates).toHaveLength(0);
    expect(result.acceptedObservations).toBe(0);
    expect(result.droppedObservations).toBe(1);
    expect(result.warnings.map(item => item.code)).toContain('OBS_INVALID_REF');
    expect(summary.events).toEqual(['模型原始事件可保留。']);
    expect(summary.characterChanges).toEqual([]);
    expect(summary.events.join('\n')).not.toMatch(/C99|地下密室/u);
  });

  it('drops rejected N1 dependency without hard-failing the batch', () => {
    const state = richState();
    const chapters = [chapter(1, 0)];
    const handles = buildStoryMemoryEntityHandles(state, chapters);
    const evidence = buildStoryMemoryEvidenceAnchors(chapters, handles.chapterHandleById);
    const normalized = normalizeStoryMemoryObservationPayload(
      {
        chapters: [
          {
            chapter: 'CH01',
            brief: '局部降级。',
            events: [],
            observations: [
              {
                kind: 'character_new',
                key: 'N1',
                name: '陈叔假影',
                evidence: ['Q999'],
              },
              {
                kind: 'relationship',
                op: 'open',
                key: 'N2',
                from: 'C01',
                to: 'N1',
                type: '同伴',
                evidence: ['Q001'],
              },
              {
                kind: 'thread',
                op: 'open',
                key: 'N3',
                title: '假影线索',
                owners: ['N1'],
                evidence: ['Q001'],
              },
              {
                kind: 'character_state',
                ref: 'C01',
                field: 'location',
                op: 'set',
                value: '钟楼',
                evidence: ['Q001'],
              },
            ],
          },
        ],
      },
      ['CH01'],
    );
    const result = compileStoryMemoryObservations({
      chapters,
      previousState: state,
      normalized: normalized.chapters,
      handles,
      evidence,
    });
    expect(result.patch.newCharacters).toHaveLength(0);
    expect(result.patch.newRelationships).toHaveLength(0);
    expect(result.patch.mainlinePatch.threadOpens).toHaveLength(0);
    expect(result.patch.characterUpdates).toHaveLength(1);
    expect(result.acceptedObservations).toBe(1);
    expect(result.droppedObservations).toBe(3);
    expect(result.warnings.map(item => item.code)).toEqual(
      expect.arrayContaining([
        'OBS_INVALID_EVIDENCE',
        'OBS_INVALID_ENDPOINT',
      ]),
    );
    const summary = result.patch.chapterSummaries[0];
    expect(summary.characterChanges.join('\n')).not.toMatch(/陈叔假影|假影线索/u);
    expect(summary.relationshipChanges).toEqual([]);
    expect(summary.newThreads).toEqual([]);
    validateCompiledStoryMemoryBatchPatch(result.patch, state, chapters, evidence);
  });

  it('accepts same-batch valid N1 dependency after two-pass resolve', () => {
    const state = richState();
    const chapters = [chapter(1, 0)];
    const handles = buildStoryMemoryEntityHandles(state, chapters);
    const evidence = buildStoryMemoryEvidenceAnchors(chapters, handles.chapterHandleById);
    const normalized = normalizeStoryMemoryObservationPayload(
      {
        chapters: [
          {
            chapter: 'CH01',
            brief: '新人物加入。',
            events: [],
            observations: [
              {
                kind: 'character_new',
                key: 'N1',
                name: '守门人',
                evidence: ['Q001'],
              },
              {
                kind: 'relationship',
                op: 'open',
                key: 'N2',
                from: 'C01',
                to: 'N1',
                type: '对峙',
                evidence: ['Q001'],
              },
              {
                kind: 'thread',
                op: 'open',
                key: 'N3',
                title: '守门人来历',
                owners: ['N1'],
                evidence: ['Q001'],
              },
            ],
          },
        ],
      },
      ['CH01'],
    );
    const result = compileStoryMemoryObservations({
      chapters,
      previousState: state,
      normalized: normalized.chapters,
      handles,
      evidence,
    });
    expect(result.acceptedObservations).toBe(3);
    expect(result.patch.newCharacters).toHaveLength(1);
    expect(result.patch.newRelationships).toHaveLength(1);
    expect(result.patch.mainlinePatch.threadOpens).toHaveLength(1);
    validateCompiledStoryMemoryBatchPatch(result.patch, state, chapters, evidence);
  });

  it('drops cross-chapter evidence anchors entirely', () => {
    const state = richState();
    const chapters = [
      chapter(1, 0, '雨夜里，林岚推开钟楼暗门。'),
      chapter(2, 1, '陈叔在门后留下银钥匙。众人决定进入地下室。'),
    ];
    const handles = buildStoryMemoryEntityHandles(state, chapters);
    const evidence = buildStoryMemoryEvidenceAnchors(chapters, handles.chapterHandleById);
    const ch01Anchors = evidence.anchors.filter(item => item.chapterId === 1);
    const ch02Anchors = evidence.anchors.filter(item => item.chapterId === 2);
    expect(ch01Anchors.length).toBeGreaterThan(0);
    expect(ch02Anchors.length).toBeGreaterThan(0);
    const normalized = normalizeStoryMemoryObservationPayload(
      {
        chapters: [
          {
            chapter: 'CH01',
            brief: '跨章证据应被丢弃。',
            events: [],
            observations: [
              {
                kind: 'character_state',
                ref: 'C01',
                field: 'location',
                op: 'set',
                value: '错误归属',
                evidence: [ch02Anchors[0].id],
              },
              {
                kind: 'character_state',
                ref: 'C01',
                field: 'emotionalState',
                op: 'set',
                value: '混杂',
                evidence: [ch01Anchors[0].id, ch02Anchors[0].id],
              },
              {
                kind: 'character_state',
                ref: 'C01',
                field: 'location',
                op: 'set',
                value: '钟楼',
                evidence: [ch01Anchors[0].id],
              },
            ],
          },
        ],
      },
      ['CH01', 'CH02'],
    );
    const result = compileStoryMemoryObservations({
      chapters,
      previousState: state,
      normalized: normalized.chapters,
      handles,
      evidence,
    });
    expect(result.patch.characterUpdates).toHaveLength(1);
    expect(result.patch.characterUpdates[0].stateChanges?.location).toBe('钟楼');
    expect(result.acceptedObservations).toBe(1);
    expect(result.droppedObservations).toBe(2);
    expect(result.warnings.filter(item => item.code === 'OBS_INVALID_EVIDENCE')).toHaveLength(
      2,
    );
    expect(result.patch.chapterSummaries[0].characterChanges.join('\n')).not.toMatch(
      /错误归属|混杂/u,
    );
  });

  it('keeps 20 valid observations when 3 malformed observations are present', () => {
    const state = createEmptyStoryMemory(1);
    const chapters = [chapter(1, 0)];
    const handles = buildStoryMemoryEntityHandles(state, chapters);
    const evidence = buildStoryMemoryEvidenceAnchors(chapters, handles.chapterHandleById);
    const valid = Array.from({ length: 20 }, (_, index) => ({
      kind: 'character_new',
      key: `N${index + 1}`,
      name: `新人物${index + 1}`,
      evidence: ['Q001'],
    }));
    const invalid = [
      { kind: 'bad_kind', evidence: ['Q001'] },
      { kind: 'bad_kind', evidence: ['Q001'] },
      { kind: 'bad_kind', evidence: ['Q001'] },
    ];
    const normalized = normalizeStoryMemoryObservationPayload(
      {
        chapters: [
          {
            chapter: 'CH01',
            brief: '本章仍有有效事实。',
            events: [],
            observations: [...valid, ...invalid],
          },
        ],
      },
      ['CH01'],
    );
    const result = compileStoryMemoryObservations({
      chapters,
      previousState: state,
      normalized: normalized.chapters,
      handles,
      evidence,
    });
    expect(result.acceptedObservations).toBe(20);
    expect(result.patch.newCharacters).toHaveLength(20);
    expect(
      [...normalized.warnings, ...result.warnings].filter(
        warning => warning.code === 'OBS_INVALID_KIND',
      ),
    ).toHaveLength(3);
    validateCompiledStoryMemoryBatchPatch(result.patch, state, chapters, evidence);
  });
});

describe('Story Memory Protocol V2 bounded requests', () => {
  it('uses the prescribed bounded output reservations', () => {
    expect(resolveStoryMemoryV2OutputBudget({ batchSize: 1 })).toBe(8192);
    expect(resolveStoryMemoryV2OutputBudget({ batchSize: 2 })).toBe(14336);
    expect(resolveStoryMemoryV2OutputBudget({ batchSize: 3 })).toBe(20480);
    expect(resolveStoryMemoryV2OutputBudget({ batchSize: 3, modelMaxOutputTokens: 12288 })).toBe(12288);
  });

  it('packs whole modules and never clips an item', () => {
    const items = ['甲'.repeat(100), '乙'.repeat(100), '丙'.repeat(100)];
    const packed = packWholeItems(items, 45, item => item);
    expect(packed).toEqual([]);
    const second = packWholeItems(items, 90, item => item);
    expect(second).toEqual([]);
    const exact = packWholeItems(items, 100, item => item);
    expect(exact).toEqual([items[0]]);
  });

  it('skips oversized whole items without starving later smaller items', () => {
    // CJK estimator: 1 char ≈ 1 token.
    const itemA = '甲'.repeat(1200);
    const itemB = '乙'.repeat(600);
    const itemC = '丙'.repeat(300);
    expect(estimateTokens(itemA)).toBeGreaterThan(1000);
    const packed = packWholeItems([itemA, itemB, itemC], 1000, item => item);
    expect(packed).toEqual([itemB, itemC]);
    expect(packed).not.toContain(itemA);
  });

  it('protects currentArc/currentObjective as separate modules and whole-item mainline entities', () => {
    const state = richState();
    const chapters = [chapter(1, 0)];
    const handles = buildStoryMemoryEntityHandles(state, chapters);
    const evidence = buildStoryMemoryEvidenceAnchors(chapters, handles.chapterHandleById);
    const materials = buildStoryMemoryObservationMaterials(chapters, state, handles, evidence);
    const ids = materials.modules.map(module => module.id);
    expect(ids).toEqual(expect.arrayContaining(['v2_current_arc', 'v2_current_objective']));
    expect(ids).not.toContain('v2_active_mainline');
    expect(ids).toEqual(
      expect.arrayContaining([
        'v2_conflict_conflict_guard',
        'v2_thread_thread_key',
        'v2_foreshadow_foreshadow_mark',
      ]),
    );
    expect(
      materials.modules.find(module => module.id === 'v2_current_arc')?.tier,
    ).toBe('mandatory');
    expect(
      materials.modules.find(module => module.id === 'v2_current_objective')?.tier,
    ).toBe('mandatory');
  });

  it('drops whole low-priority materials before splitting a 64K-window request', () => {
    const state = richState();
    state.mainline.archiveDigest = '历史归档。'.repeat(600);
    const chapters = [chapter(1, 0), chapter(2, 1), chapter(3, 2)];
    const handles = buildStoryMemoryEntityHandles(state, chapters);
    const evidence = buildStoryMemoryEvidenceAnchors(chapters, handles.chapterHandleById);
    const materials = buildStoryMemoryObservationMaterials(chapters, state, handles, evidence);
    const plan = planStoryMemoryObservationRequest({
      config: frozenConfig(10500, 8192),
      materials,
      batchSize: 1,
    });
    expect(plan.strategy).toBe('full_prompt');
    expect(plan.messages.join('\n')).not.toContain(state.mainline.archiveDigest.slice(0, 100));
    expect(plan.droppedModuleIds).toContain('v2_archive_digest');
    expect(plan.includedModuleIds).toEqual(
      expect.arrayContaining([
        'v2_system_protocol',
        'v2_output_contract',
        'v2_chapter_1',
        'v2_current_arc',
        'v2_current_objective',
      ]),
    );
  });

  it('keeps Formatter body-free and Fresh Retry free of an assistant candidate', () => {
    const state = richState();
    const chapters = [chapter(1, 0)];
    const handles = buildStoryMemoryEntityHandles(state, chapters);
    const evidence = buildStoryMemoryEvidenceAnchors(chapters, handles.chapterHandleById);
    const formatter = buildStoryMemoryObservationFormatterMessages({
      candidate: '{bad candidate}',
      chapterHandles: ['CH01'],
      existingHandles: {
        characters: ['C01'],
        relationships: ['R01'],
        conflicts: ['F01'],
        threads: ['T01'],
        foreshadowing: ['P01'],
        arc: 'A01',
      },
      evidenceIds: evidence.anchors.map(anchor => anchor.id),
      failureCode: 'OBS_INVALID_JSON',
    });
    expect(formatter.map(message => message.content).join('\n')).toContain('{bad candidate}');
    expect(formatter.map(message => message.content).join('\n')).not.toContain(chapters[0].content);
    const fresh = buildStoryMemoryObservationFreshRetryMessages(
      buildMessagesFromObservationMaterials(
        buildStoryMemoryObservationMaterials(chapters, state, handles, evidence),
      ),
      'coverage gap',
    );
    expect(fresh.some(message => (message.role as string) === 'assistant')).toBe(false);
    expect(fresh.map(message => message.content).join('\n')).toContain('coverage gap');
  });

  it('re-plans Fresh Retry with elastic whole-item compact instead of full state', () => {
    const state = richState();
    state.mainline.archiveDigest = '历史归档。'.repeat(800);
    for (let i = 0; i < 80; i += 1) {
      const id = `char_hist_${i}`;
      state.characters[id] = character(id, `历史人物${i}`, i);
      state.mainline.openThreads[`thread_hist_${i}`] = {
        id: `thread_hist_${i}`,
        title: `旧线索${i}`,
        description: `无关旧线索描述${i}。`.repeat(20),
        ownerCharacterIds: [id],
        priority: 'low',
        openedChapterId: 1,
        lastChangedChapterId: 1,
        deadlineOrTrigger: '',
        evidenceChapterIds: [1],
      };
    }
    const chapters = [chapter(1, 0, `${'林岚在钟楼调查。'.repeat(40)}`)];
    const handles = buildStoryMemoryEntityHandles(state, chapters);
    const evidence = buildStoryMemoryEvidenceAnchors(chapters, handles.chapterHandleById);
    const materials = buildStoryMemoryObservationMaterials(chapters, state, handles, evidence);
    // Tight enough that preferred/optional items must drop, but mandatory still fits.
    const config = frozenConfig(24000, 8192);
    const primary = planStoryMemoryObservationRequest({
      config,
      materials,
      batchSize: 1,
    });
    expect(primary.strategy).toBe('full_prompt');
    expect(primary.droppedModuleIds.length).toBeGreaterThan(0);
    const fresh = planStoryMemoryFreshRetryRequest({
      config,
      materials,
      batchSize: 1,
      failureCode: 'OBS_INVALID_JSON',
    });
    expect(fresh.strategy).toBe('full_prompt');
    expect(fresh.estimatedInputTokens).toBeLessThanOrEqual(fresh.burstInputLimit);
    expect(fresh.includedModuleIds).toEqual(primary.includedModuleIds);
    expect(fresh.droppedModuleIds).toEqual(primary.droppedModuleIds);
    expect(fresh.messages.map(message => message.content).join('\n')).toContain(
      'OBS_INVALID_JSON',
    );
    expect(fresh.messages.some(message => (message.role as string) === 'assistant')).toBe(
      false,
    );
    // Must not expand back to full uncompacted material set.
    expect(fresh.includedModuleIds.length).toBeLessThan(materials.modules.length);
  });

  it('records redacted V2 diagnostics without chapter bodies or model responses', () => {
    const state = richState();
    const chapters = [chapter(1, 0)];
    const handles = buildStoryMemoryEntityHandles(state, chapters);
    const evidence = buildStoryMemoryEvidenceAnchors(chapters, handles.chapterHandleById);
    const materials = buildStoryMemoryObservationMaterials(chapters, state, handles, evidence);
    const plan = planStoryMemoryObservationRequest({
      config: frozenConfig(),
      materials,
      batchSize: 1,
    });
    const diagnostics = createStoryMemoryV2Diagnostics({
      chapters,
      config: frozenConfig(),
      materials,
      handles,
      evidence,
      fullInputTokens: estimateMessagesTokens(
        buildMessagesFromObservationMaterials(materials),
      ),
    });
    recordStoryMemoryV2Plan(diagnostics, plan, materials);
    diagnostics.physicalAttemptCount = 2;
    diagnostics.formatterUsed = true;
    recordRecentStoryMemoryV2Diagnostics(diagnostics);
    const latest = getRecentStoryMemoryV2Diagnostics().at(-1)!;
    expect(latest.protocolVersion).toBe(2);
    expect(latest.outputReservation).toBe(8192);
    expect(latest.anchorCount).toBeGreaterThan(0);
    expect(JSON.stringify(latest)).not.toContain(chapters[0].content);
    expect(JSON.stringify(latest)).not.toContain('api_key');
  });

  function buildAccumulatedState(chapterCount: number): StoryMemoryState {
    const state = createEmptyStoryMemory(1);
    const characterCount =
      chapterCount <= 100 ? 50 : chapterCount <= 300 ? 150 : 400;
    const relationshipCount =
      chapterCount <= 100 ? 40 : chapterCount <= 300 ? 120 : 300;
    const conflictCount =
      chapterCount <= 100 ? 8 : chapterCount <= 300 ? 16 : 30;
    const threadCount =
      chapterCount <= 100 ? 15 : chapterCount <= 300 ? 45 : 120;
    const foreshadowCount =
      chapterCount <= 100 ? 15 : chapterCount <= 300 ? 45 : 120;
    const timelineCount =
      chapterCount <= 100 ? 60 : chapterCount <= 300 ? 180 : 520;
    const resolvedCount =
      chapterCount <= 100 ? 25 : chapterCount <= 300 ? 60 : 120;

    for (let i = 0; i < characterCount; i += 1) {
      const id = `char_${i}`;
      const person = character(
        id,
        i < 4 ? ['林岚', '陈叔', '守墓人', '银钥匠'][i] : `角色${i}`,
        i % chapterCount,
      );
      person.currentState.location = `地点${i % 40}`;
      person.currentState.currentGoal = `目标${i % 20}`;
      person.currentState.knowledge = [`知识${i}`];
      state.characters[id] = person;
    }
    for (let i = 0; i < relationshipCount; i += 1) {
      const from = `char_${i % characterCount}`;
      const to = `char_${(i + 1) % characterCount}`;
      if (from === to) continue;
      const id = `rel_${i}`;
      state.relationships[id] = {
        id,
        fromCharacterId: from,
        toCharacterId: to,
        direction: 'bidirectional',
        relationType: i % 2 === 0 ? '同伴' : '敌对',
        currentState: `关系状态${i}`,
        trustLevel: 'medium',
        publicStatus: '公开',
        hiddenStatus: '',
        reason: `原因${i}`,
        firstSeenChapterId: 1,
        lastChangedChapterId: 1,
        lastChangedPosition: i % chapterCount,
        evidenceChapterIds: [1],
      };
    }
    state.mainline.currentArc = {
      id: 'arc_long_form',
      name: '长篇主线弧',
      summary: '追查钟楼暗门、银钥匙与地下室机关之间的历史因果。',
      startedChapterId: 1,
    };
    state.mainline.currentObjective = '进入地下室并确认三角刻痕含义';
    for (let i = 0; i < conflictCount; i += 1) {
      const id = `conflict_${i}`;
      state.mainline.activeConflicts[id] = {
        id,
        title: i === 0 ? '入口阻拦' : `冲突${i}`,
        parties: [`char_${i % Math.min(4, characterCount)}`],
        state: i === 0 ? '守墓人阻止进入' : `冲突状态${i}`,
        stakes: `赌注${i}`,
        openedChapterId: 1,
        lastChangedChapterId: 1,
        evidenceChapterIds: [1],
      };
    }
    for (let i = 0; i < threadCount; i += 1) {
      const id = `thread_${i}`;
      state.mainline.openThreads[id] = {
        id,
        title: i === 0 ? '银钥匙来源' : `线索${i}`,
        description: i === 0 ? '钥匙的制造者尚未确认' : `线索描述${i}。`.repeat(3),
        ownerCharacterIds: [`char_${i % Math.min(4, characterCount)}`],
        priority: i % 5 === 0 ? 'high' : 'normal',
        openedChapterId: 1,
        lastChangedChapterId: 1,
        deadlineOrTrigger: '',
        evidenceChapterIds: [1],
      };
    }
    for (let i = 0; i < foreshadowCount; i += 1) {
      const id = `foreshadow_${i}`;
      state.mainline.foreshadowing[id] = {
        id,
        setup: i === 0 ? '墙上出现三角刻痕' : `伏笔铺垫${i}`,
        expectedPayoff: i === 0 ? '与地下室机关有关' : `伏笔回收${i}`,
        status: i % 4 === 0 ? 'partially_paid' : 'open',
        openedChapterId: 1,
        lastChangedChapterId: 1,
        evidenceChapterIds: [1],
      };
    }
    for (let i = 0; i < timelineCount; i += 1) {
      const id = `time_${i}`;
      state.mainline.timelineAnchors[id] = {
        id,
        label: `时间点${i}`,
        timeDescription: `第${i}夜`,
        event: `事件${i}`,
        chapterId: (i % chapterCount) + 1,
        pinned: false,
      };
    }
    for (let i = 0; i < resolvedCount; i += 1) {
      state.mainline.recentResolvedThreads.push({
        id: `resolved_${i}`,
        title: `已解决线索${i}`,
        resolution: `解决结果${i}`,
        openedChapterId: 1,
        resolvedChapterId: Math.min(chapterCount, i + 1),
      });
    }
    state.mainline.archiveDigest = (
      chapterCount >= 1000 ? '归档摘要。'.repeat(400) : '归档摘要。'.repeat(200)
    ).slice(0, chapterCount >= 1000 ? 1600 : 1200);
    state.throughChapterId = chapterCount;
    state.throughChapterPosition = chapterCount - 1;
    return state;
  }

  it.each([
    [100, 50, 40],
    [300, 150, 120],
    [1000, 400, 300],
  ] as const)(
    'keeps accumulated %i-chapter state bounded with arc/objective protection',
    (chapterCount, minCharacters, minRelationships) => {
      const state = buildAccumulatedState(chapterCount);
      expect(Object.keys(state.characters).length).toBeGreaterThanOrEqual(minCharacters);
      expect(Object.keys(state.relationships).length).toBeGreaterThanOrEqual(
        minRelationships,
      );

      const relevantBody =
        '雨夜里，林岚与陈叔继续调查入口阻拦，确认银钥匙来源与墙上三角刻痕。';
      const batch = [
        chapter(chapterCount + 1, chapterCount, relevantBody),
        chapter(chapterCount + 2, chapterCount + 1, `${relevantBody}众人决定进入地下室。`),
        chapter(chapterCount + 3, chapterCount + 2, `${relevantBody}守墓人退到石阶下。`),
      ];
      const handles = buildStoryMemoryEntityHandles(state, batch);
      const evidence = buildStoryMemoryEvidenceAnchors(batch, handles.chapterHandleById);
      const materials = buildStoryMemoryObservationMaterials(
        batch,
        state,
        handles,
        evidence,
      );
      const fullMessages = buildMessagesFromObservationMaterials(materials);
      const fullInputTokens = estimateMessagesTokens(fullMessages);

      const windows: Array<[number, number]> = [
        [1_048_576, 200_000],
        [131_072, 32_768],
        [65_536, 32_768],
      ];
      for (const [contextWindow, maxOutputTokens] of windows) {
        const plan = planStoryMemoryObservationRequest({
          config: frozenConfig(contextWindow, maxOutputTokens),
          materials,
          batchSize: 3,
        });
        expect(['full_prompt', 'preflight_split']).toContain(plan.strategy);
        if (plan.strategy === 'full_prompt') {
          expect(plan.estimatedInputTokens).toBeLessThanOrEqual(plan.burstInputLimit);
          expect(plan.includedModuleIds).toEqual(
            expect.arrayContaining([
              'v2_current_arc',
              'v2_current_objective',
              `v2_chapter_${batch[0].id}`,
            ]),
          );
          const joined = plan.messages.map(message => message.content).join('\n');
          expect(joined).toContain('长篇主线弧');
          expect(joined).toContain('进入地下室并确认三角刻痕含义');
          expect(joined).toContain('林岚');
          // No half-item clipping markers from character-level truncation.
          expect(joined).not.toMatch(/\u2026{2,}/u);
        }
      }

      // Under a tighter window, archive/optional must drop first while spine stays.
      const tight = planStoryMemoryObservationRequest({
        config: frozenConfig(28_000, 8_192),
        materials,
        batchSize: 3,
      });
      if (tight.strategy === 'full_prompt') {
        expect(tight.includedModuleIds).toEqual(
          expect.arrayContaining(['v2_current_arc', 'v2_current_objective']),
        );
        expect(tight.droppedModuleIds.length).toBeGreaterThan(0);
        expect(tight.droppedModuleIds).toContain('v2_archive_digest');
        expect(tight.estimatedInputTokens).toBeLessThanOrEqual(tight.burstInputLimit);
      } else {
        expect(tight.strategy).toBe('preflight_split');
      }

      // Prompt must not grow roughly linearly with total entity count.
      const emptyLike = createEmptyStoryMemory(1);
      emptyLike.mainline.currentArc = state.mainline.currentArc;
      emptyLike.mainline.currentObjective = state.mainline.currentObjective;
      const emptyMaterials = buildStoryMemoryObservationMaterials(
        batch,
        emptyLike,
        buildStoryMemoryEntityHandles(emptyLike, batch),
        evidence,
      );
      const emptyFull = estimateMessagesTokens(
        buildMessagesFromObservationMaterials(emptyMaterials),
      );
      const plan64k = planStoryMemoryObservationRequest({
        config: frozenConfig(65_536, 32_768),
        materials,
        batchSize: 3,
      });
      if (plan64k.strategy === 'full_prompt') {
        // Compacted final input stays far below full accumulated material size
        // when low-priority modules are dropped; otherwise full state still
        // fits and final == full (acceptable for large windows).
        if (plan64k.droppedModuleIds.length > 0) {
          expect(plan64k.estimatedInputTokens).toBeLessThan(fullInputTokens);
        }
        expect(plan64k.estimatedInputTokens).toBeLessThanOrEqual(plan64k.burstInputLimit);
      }
      expect(fullInputTokens).toBeGreaterThan(emptyFull);
    },
  );
});

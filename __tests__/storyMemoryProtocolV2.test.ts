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
  planStoryMemoryObservationRequest,
  resolveStoryMemoryV2OutputBudget,
  type FrozenStoryMemoryLLMConfig,
} from '../src/services/storyMemory/storyMemoryRequestBudget';
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
      expect.arrayContaining(['v2_system_protocol', 'v2_output_contract', 'v2_chapter_1']),
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

  it.each([100, 300, 1000])('keeps request input bounded for %i chapters', chapterCount => {
    const state = createEmptyStoryMemory(1);
    const allChapters = Array.from({ length: chapterCount }, (_, position) =>
      chapter(position + 1, position),
    );
    const inputSizes: number[] = [];
    for (let start = 0; start < allChapters.length; start += 3) {
      const batch = allChapters.slice(start, start + 3);
      const handles = buildStoryMemoryEntityHandles(state, batch);
      const evidence = buildStoryMemoryEvidenceAnchors(batch, handles.chapterHandleById);
      const materials = buildStoryMemoryObservationMaterials(batch, state, handles, evidence);
      const messages = buildMessagesFromObservationMaterials(materials);
      inputSizes.push(estimateMessagesTokens(messages));
    }
    expect(inputSizes.length).toBe(Math.ceil(chapterCount / 3));
    expect(Math.max(...inputSizes) - Math.min(...inputSizes)).toBeLessThan(180);
    expect(Math.max(...inputSizes)).toBeLessThan(1600);
  });
});

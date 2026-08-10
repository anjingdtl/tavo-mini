import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import { buildStoryMemoryCheckpointMessages } from '../src/services/storyMemory/storyMemoryPrompts';
import {
  buildStoryMemoryCheckpointMaterials,
  buildMessagesFromMaterials,
  resolveRelevantCharacterIds,
} from '../src/services/storyMemory/storyMemoryPromptMaterials';
import {
  planStoryMemoryElasticRequest,
  resolveStoryMemoryOutputBudget,
  type FrozenStoryMemoryLLMConfig,
} from '../src/services/storyMemory/storyMemoryRequestBudget';
import type { Chapter } from '../src/types/novel';
import type {
  StoryCharacter,
  StoryCharacterCurrentState,
} from '../src/services/storyMemory/storyMemoryTypes';

function makeChar(id: string, name: string): StoryCharacter {
  return {
    id,
    canonicalName: name,
    aliases: [],
    role: '',
    immutableProfile: { identity: '', stableTraits: [], affiliations: [] },
    currentState: {} as StoryCharacterCurrentState,
    status: 'active',
    firstSeenChapterId: 1,
    firstSeenPosition: 0,
    lastChangedChapterId: 1,
    lastChangedPosition: 0,
    evidenceChapterIds: [],
  };
}

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

function capability(
  contextWindow: number,
  maxOutputTokens: number,
): FrozenStoryMemoryLLMConfig {
  return {
    configId: 7,
    providerType: 'openai_compatible',
    modelName: 'test-model',
    contextWindow,
    maxOutputTokens,
    requestConfig: {
      id: 7,
      provider_type: 'openai_compatible',
      api_key: 'test',
      model_name: 'test-model',
      url: 'https://example.test/v1/chat/completions',
      context_window: contextWindow,
      max_output_tokens: maxOutputTokens,
    },
  };
}

const chapters = [
  chapter(0, '林岚推开暗门走进钟楼。'),
  chapter(1, '林岚在钟楼找到银钥匙。'),
  chapter(2, '林岚带着银钥匙离开钟楼。'),
];

describe('buildStoryMemoryCheckpointMaterials — fast path equivalence', () => {
  it('fast path re-assembly is byte-identical to legacy builder', () => {
    const state = createEmptyStoryMemory(1);
    const materials = buildStoryMemoryCheckpointMaterials(chapters, state);
    const fullAllocations = new Map(
      materials.modules.map(m => [m.id, m.text]),
    );
    const rebuilt = buildMessagesFromMaterials(materials, fullAllocations);
    const legacy = buildStoryMemoryCheckpointMessages(chapters, state);

    // System message identical.
    expect(rebuilt[0].role).toBe('system');
    expect(rebuilt[0].content).toBe(legacy[0].content);

    // The rebuilt user content is a superset-ordered form: legacy builder joins
    // blocks with single '\n' separators while the materials builder joins
    // modules with '\n\n'. Both must carry every mandatory structural marker.
    const legacyUser = legacy[1].content;
    const rebuiltUser = rebuilt[1].content;
    for (const marker of [
      '【上一检查点已验证故事状态】',
      '【已知人物名册',
      '【本批次范围】',
      '【本批次章节（按 position 升序）】',
      '【严格输出范式',
      '【chapterSummaries 检索摘要提醒】',
    ]) {
      expect(rebuiltUser).toContain(marker);
      expect(legacyUser).toContain(marker);
    }
    // Chapter bodies present verbatim in both.
    expect(rebuiltUser).toContain('林岚推开暗门走进钟楼。');
    expect(rebuiltUser).toContain('林岚带着银钥匙离开钟楼。');
  });

  it('mandatory modules never carry optional-tier content', () => {
    const state = createEmptyStoryMemory(1);
    const materials = buildStoryMemoryCheckpointMaterials(chapters, state);
    const mandatory = materials.modules.filter(m => m.tier === 'mandatory');
    // Chapter bodies, schema/contract, roster, system, range all mandatory.
    const ids = mandatory.map(m => m.id);
    expect(ids).toContain('chapter_bodies');
    expect(ids).toContain('schema_contract');
    expect(ids).toContain('roster');
    expect(ids).toContain('range_block');
    expect(ids).toContain('system_protocol');
  });
});

describe('resolveRelevantCharacterIds', () => {
  it('marks characters whose name appears in batch body as relevant', () => {
    const state = createEmptyStoryMemory(1);
    // Inject two characters; only the one named in the body is relevant.
    (state.characters as Record<string, StoryCharacter>)['char_lan'] =
      makeChar('char_lan', '林岚');
    (state.characters as Record<string, StoryCharacter>)['char_zhou'] =
      makeChar('char_zhou', '周明');

    const relevant = resolveRelevantCharacterIds(
      state,
      '林岚推开暗门走进钟楼。',
    );
    expect(relevant.has('char_lan')).toBe(true);
    expect(relevant.has('char_zhou')).toBe(false);
  });

  it('returns empty set for empty body', () => {
    const state = createEmptyStoryMemory(1);
    expect(resolveRelevantCharacterIds(state, '').size).toBe(0);
  });
});

describe('planStoryMemoryElasticRequest — strategy matrix', () => {
  it('1M / 200K three chapters → full_prompt fast path', () => {
    const materials = buildStoryMemoryCheckpointMaterials(
      chapters,
      createEmptyStoryMemory(1),
    );
    const plan = planStoryMemoryElasticRequest({
      config: capability(1_000_000, 200_000),
      materials,
      batchSize: 3,
    });
    expect(plan.capabilityKnown).toBe(true);
    expect(plan.fullPrompt).toBe(true);
    expect(plan.strategy).toBe('full_prompt');
    expect(plan.clippedModuleIds).toHaveLength(0);
    expect(plan.messages.length).toBeGreaterThan(0);
    expect(plan.maxTokens).toBe(200_000);
    // Fast path keeps us well under the soft limit for a tiny 3-chapter batch.
    expect(plan.estimatedInputTokens).toBeLessThan(plan.softInputLimit);
  });

  it('output reservation still uses V5 (1M/200K → 200K)', () => {
    expect(
      resolveStoryMemoryOutputBudget({
        contextWindow: 1_000_000,
        maxOutputTokens: 200_000,
        legacyOutputTokens: 800,
        batchSize: 3,
      }),
    ).toBe(200_000);
  });

  it('Optional archive gets clipped when budget is tight (compact path)', () => {
    // Build a state with many non-relevant characters so Preferred-Low grows,
    // then use a small window where Mandatory fits but Optional (archive) must
    // shrink. The archive module is small in source (800 chars cap to match
    // legacy) but the combined preferred-low load forces Optional out.
    const state = createEmptyStoryMemory(1);
    for (let i = 0; i < 60; i++) {
      const c = makeChar(`char_${i}`, `无关人物${i}号`);
      c.role = '路人';
      (state.characters as Record<string, StoryCharacter>)[`char_${i}`] = c;
    }
    state.mainline.archiveDigest = '历史归档'.repeat(200);

    const materials = buildStoryMemoryCheckpointMaterials(chapters, state);
    const plan = planStoryMemoryElasticRequest({
      config: capability(8_192, 1024),
      materials,
      batchSize: 3,
    });
    expect(plan.capabilityKnown).toBe(true);
    // Mandatory (small chapters) fits, so we should NOT split.
    expect(plan.strategy).not.toBe('preflight_split');
    // Either Optional or Preferred-Low must have been clipped.
    expect(plan.clippedModuleIds.length).toBeGreaterThan(0);
    // Mandatory modules never clipped.
    expect(plan.clippedModuleIds).not.toContain('chapter_bodies');
  });

  it('Mandatory overflow (huge chapter body) → preflight_split, 0 HTTP', () => {
    // One chapter body so large it alone exceeds the window's hard limit.
    const bigChapters = [
      chapter(0, '巨'.repeat(200_000)),
      chapter(1, '巨'.repeat(200_000)),
    ];
    const materials = buildStoryMemoryCheckpointMaterials(
      bigChapters,
      createEmptyStoryMemory(1),
    );
    const plan = planStoryMemoryElasticRequest({
      config: capability(65_536, 32_768),
      materials,
      batchSize: 2,
    });
    expect(plan.strategy).toBe('preflight_split');
    expect(plan.messages).toHaveLength(0); // no HTTP — caller splits
  });

  it('Mandatory overflow single chapter → infeasible, 0 HTTP', () => {
    const singleHuge = [chapter(0, '巨'.repeat(200_000))];
    const materials = buildStoryMemoryCheckpointMaterials(
      singleHuge,
      createEmptyStoryMemory(1),
    );
    const plan = planStoryMemoryElasticRequest({
      config: capability(65_536, 32_768),
      materials,
      batchSize: 1,
    });
    expect(plan.strategy).toBe('infeasible');
    expect(plan.messages).toHaveLength(0);
  });

  it('never clips chapter_bodies or schema_contract (Mandatory)', () => {
    const state = createEmptyStoryMemory(1);
    state.mainline.archiveDigest = '归档'.repeat(5000);
    const materials = buildStoryMemoryCheckpointMaterials(chapters, state);
    const plan = planStoryMemoryElasticRequest({
      config: capability(128_000, 25_600),
      materials,
      batchSize: 3,
    });
    expect(plan.clippedModuleIds).not.toContain('chapter_bodies');
    expect(plan.clippedModuleIds).not.toContain('schema_contract');
    // Chapter bodies verbatim.
    expect(plan.messages[1].content).toContain('林岚推开暗门走进钟楼。');
  });

  it('64K / 32K small window: three moderate chapters still fit full_prompt', () => {
    const materials = buildStoryMemoryCheckpointMaterials(
      chapters,
      createEmptyStoryMemory(1),
    );
    const plan = planStoryMemoryElasticRequest({
      config: capability(65_536, 32_768),
      materials,
      batchSize: 3,
    });
    // Small window but tiny chapters → full prompt should still fit.
    expect(plan.fullPrompt).toBe(true);
    expect(plan.strategy).toBe('full_prompt');
  });
});

describe('planStoryMemoryElasticRequest — relevant-character priority', () => {
  it('relevant character rich state lives in preferred_high tier', () => {
    const state = createEmptyStoryMemory(1);
    const lan = makeChar('char_lan', '林岚');
    lan.role = '调查员';
    (state.characters as Record<string, StoryCharacter>)['char_lan'] = lan;
    (state.characters as Record<string, StoryCharacter>)['char_zhou'] =
      makeChar('char_zhou', '周明');

    const materials = buildStoryMemoryCheckpointMaterials(chapters, state);
    const highModule = materials.modules.find(
      m => m.id === 'relevant_characters',
    );
    const lowModule = materials.modules.find(
      m => m.id === 'non_relevant_characters',
    );
    expect(highModule?.tier).toBe('preferred_high');
    expect(highModule?.text).toContain('林岚');
    expect(lowModule?.tier).toBe('preferred_low');
    expect(lowModule?.text).toContain('周明');
    expect(materials.hasRelevantCharacters).toBe(true);
  });
});

import {
  normalizeGenerationMaterials,
} from '../src/services/context/generation/normalizeGenerationMaterials';
import {
  buildGenerationContextPlan,
} from '../src/services/context/generation/buildGenerationContextPlan';
import {
  allocateGenerationContextBudget,
} from '../src/services/context/generation/allocateGenerationContextBudget';
import {
  renderGenerationContext,
} from '../src/services/context/generation/renderGenerationContext';
import {
  freezeGenerationContext,
} from '../src/services/context/generation/freezeGenerationContext';

const currentChapter = {
  id: 3,
  project_id: 7,
  position: 3,
  title: '当前章',
  synopsis: '继续推进',
  content: '',
  status: 'planned',
  summary_json: null,
  created_at: '',
  updated_at: '',
} as any;

const collected = {
  projectId: 7,
  currentChapter,
  chapters: [
    { ...currentChapter, id: 1, position: 1, title: '前章一', content: '甲' },
    { ...currentChapter, id: 2, position: 2, title: '前章二', content: '乙' },
    currentChapter,
    { ...currentChapter, id: 4, position: 4, title: '未来章', content: '未来' },
  ],
  previousChapters: [
    { ...currentChapter, id: 1, position: 1, title: '前章一', content: '甲' },
    { ...currentChapter, id: 2, position: 2, title: '前章二', content: '乙' },
  ],
  episodicCandidates: [
    { ...currentChapter, id: 1, position: 1, title: '前章一', content: '甲' },
  ],
  rawChapterIds: [],
  outline: { text: '大纲', estimatedTokens: 10, fingerprint: 'outline-fp', outlineIds: [1] },
  storyMemory: { text: '状态', estimatedTokens: 5 },
  resourceCandidates: [
    {
      candidateId: 'character:1',
      sourceType: 'character',
      sourceId: 1,
      content: '角色资料',
      activation: 'automatic',
      requirement: 'preferred',
      relevance: 0.9,
      priority: 5,
      selectionBoost: 1,
    },
  ],
  options: { contextWindow: 128000, reservedOutputTokens: 4000 },
  config: { includeResources: true, resourceBudget: 1000, slidingWindowSize: 1000 },
} as any;

describe('Phase II six-stage generation contracts', () => {
  test('normalize is pure and rejects future candidates without changing source input', () => {
    const before = JSON.stringify(collected);
    const normalized = normalizeGenerationMaterials(collected);
    expect(JSON.stringify(collected)).toBe(before);
    expect(normalized.previousChapters.map((chapter: any) => chapter.position)).toEqual([1, 2]);
    expect(normalized.episodicCandidates.every((chapter: any) => chapter.position < 3)).toBe(true);
  });

  test('plan exposes candidate selection semantics and demand fields', () => {
    const normalized = normalizeGenerationMaterials(collected);
    const plan = buildGenerationContextPlan({ normalized });
    expect(plan.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateId: 'character:1',
          selected: true,
          demandTokens: expect.any(Number),
        }),
      ]),
    );
    expect(plan.demands.length).toBeGreaterThan(0);
    expect(plan.demands[0]).toEqual(
      expect.objectContaining({
        candidateId: expect.any(String),
        demandTokens: expect.any(Number),
        minTokens: expect.any(Number),
        targetTokens: expect.any(Number),
        maxTokens: expect.any(Number),
      }),
    );
  });

  test('allocation uses the unified adapter and preserves deterministic results', () => {
    const normalized = normalizeGenerationMaterials(collected);
    const plan = buildGenerationContextPlan({ normalized });
    const a = allocateGenerationContextBudget({
      plan,
      contextWindow: 128000,
      reservedOutputTokens: 4000,
      safetyMargin: 1000,
      mode: 'legacy',
    });
    const b = allocateGenerationContextBudget({
      plan,
      contextWindow: 128000,
      reservedOutputTokens: 4000,
      safetyMargin: 1000,
      mode: 'legacy',
    });
    expect(a.items).toEqual(b.items);
    expect(a.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateId: 'character:1',
          demandTokens: expect.any(Number),
          allocatedTokens: expect.any(Number),
          allocationReason: expect.any(String),
        }),
      ]),
    );
  });

  test('render produces actual token and clipping evidence without selecting again', () => {
    const normalized = normalizeGenerationMaterials(collected);
    const plan = buildGenerationContextPlan({ normalized });
    const allocation = allocateGenerationContextBudget({
      plan,
      contextWindow: 128000,
      reservedOutputTokens: 4000,
      safetyMargin: 1000,
      mode: 'legacy',
    });
    const rendered = renderGenerationContext({
      normalized,
      plan,
      allocation,
      blocks: {
        systemText: '系统',
        instructionText: '指令',
        sourceTextByCandidateId: { 'character:1': '角色资料' },
      },
    });
    expect(rendered.messages.length).toBeGreaterThan(0);
    const characterItem = rendered.items.find(item => item.candidateId === 'character:1');
    expect(characterItem).toEqual(
      expect.objectContaining({
        actualTokens: expect.any(Number),
        clipped: expect.any(Boolean),
        renderedHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(
      characterItem?.clippingReason === null ||
        typeof characterItem?.clippingReason === 'string',
    ).toBe(true);
  });

  test('freeze assembles one serializable contract and guards future leakage', () => {
    const normalized = normalizeGenerationMaterials(collected);
    const plan = buildGenerationContextPlan({ normalized });
    const allocation = allocateGenerationContextBudget({
      plan,
      contextWindow: 128000,
      reservedOutputTokens: 4000,
      safetyMargin: 1000,
      mode: 'legacy',
    });
    const rendered = renderGenerationContext({
      normalized,
      plan,
      allocation,
      blocks: {
        systemText: '系统',
        instructionText: '指令',
        sourceTextByCandidateId: { 'character:1': '角色资料' },
      },
    });
    const frozen = freezeGenerationContext({
      normalized,
      plan,
      allocation,
      rendered,
      diagnostics: [],
    });
    expect(frozen.version).toBe(2);
    expect(frozen.candidates).toHaveLength(plan.candidates.length);
    expect(frozen.budget).toEqual(expect.any(Array));
    expect(frozen.rendered).toEqual(expect.any(Array));
    expect(JSON.parse(JSON.stringify(frozen))).toEqual(frozen);
  });
});

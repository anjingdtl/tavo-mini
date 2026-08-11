/**
 * Live LLM smoke for Story Memory Protocol V2 Closure.
 * Skipped unless LIVE_STORY_MEMORY=1.
 *
 * Never logs API keys. Key is loaded from the process environment only.
 */
import fs from 'fs';
import path from 'path';
import { callLLMResult } from '../src/services/llm';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import { buildStoryMemoryEntityHandles } from '../src/services/storyMemory/storyMemoryEntityHandles';
import { buildStoryMemoryEvidenceAnchors } from '../src/services/storyMemory/storyMemoryEvidenceAnchors';
import {
  buildMessagesFromObservationMaterials,
  buildStoryMemoryObservationMaterials,
} from '../src/services/storyMemory/storyMemoryObservationMaterials';
import {
  planStoryMemoryFreshRetryRequest,
  planStoryMemoryObservationRequest,
  type FrozenStoryMemoryLLMConfig,
} from '../src/services/storyMemory/storyMemoryRequestBudget';
import { buildStoryMemoryLLMConfig } from '../src/services/storyMemory/storyMemoryRequestPolicy';
import { STORY_MEMORY_V2_REQUEST_KINDS } from '../src/services/storyMemory/storyMemoryProtocolVersion';
import { evaluateStoryMemoryKnownChangeSemanticGate } from '../src/services/storyMemory/storyMemoryV2Diagnostics';
import { normalizeStoryMemoryObservationPayload } from '../src/services/storyMemory/storyMemoryObservationNormalizer';
import {
  compileStoryMemoryObservations,
  validateCompiledStoryMemoryBatchPatch,
} from '../src/services/storyMemory/storyMemoryObservationCompiler';
import { applyStoryMemoryBatchPatch } from '../src/services/storyMemory/storyMemoryMerger';
import { parseStoryMemoryObservationCandidate } from '../src/services/storyMemory/storyMemoryObservationFormatter';
import { estimateMessagesTokens } from '../src/utils/tokenEstimator';
import type { ChatMessage } from '../src/services/llm';
import type { Chapter } from '../src/types/novel';
import type {
  StoryCharacter,
  StoryMemoryState,
} from '../src/services/storyMemory/storyMemoryTypes';

function rawObservationCount(raw: unknown): number {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;
  const chapters = Array.isArray((raw as { chapters?: unknown }).chapters)
    ? ((raw as { chapters: unknown[] }).chapters)
    : [];
  return chapters.reduce<number>((total, chapter) => {
    if (!chapter || typeof chapter !== 'object' || Array.isArray(chapter)) {
      return total;
    }
    const observations = (chapter as { observations?: unknown }).observations;
    return total + (Array.isArray(observations) ? observations.length : 0);
  }, 0);
}

const LIVE = process.env.LIVE_STORY_MEMORY === '1';
const describeLive = LIVE ? describe : describe.skip;

function loadApiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) throw new Error('DEEPSEEK_API_KEY is required for live QA');
  return key;
}

const BASE =
  process.env.DEEPSEEK_BASE || 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

function chapter(
  id: number,
  position: number,
  content: string,
  title?: string,
): Chapter {
  return {
    id,
    project_id: 1,
    position,
    title: title || `第 ${position + 1} 章`,
    synopsis: `${title || `第 ${position + 1} 章`} 推进调查。`,
    content,
    status: 'final',
    summary_json: null,
    memory_summary: '',
    created_at: '',
    updated_at: '',
  };
}

function character(id: string, name: string, position = 0): StoryCharacter {
  return {
    id,
    canonicalName: name,
    aliases: [],
    role: '调查者',
    immutableProfile: { identity: '', stableTraits: [], affiliations: [] },
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

function padToLength(seed: string, target: number): string {
  let text = seed;
  let i = 0;
  while (text.length < target) {
    text += ` 夜更深了，林岚与陈叔继续沿石阶向下，确认墙上的三角刻痕仍在第${i}段墙面重复出现。银钥匙在掌心发凉。`;
    i += 1;
  }
  return text.slice(0, target);
}

function baseState(): StoryMemoryState {
  const state = createEmptyStoryMemory(1);
  const lin = character('char_lin', '林岚');
  const chen = character('char_chen', '陈叔');
  state.characters = { [lin.id]: lin, [chen.id]: chen };
  state.relationships = {
    rel_ally: {
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
    },
  };
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

function largeAccumulatedState(): StoryMemoryState {
  const state = baseState();
  for (let i = 0; i < 180; i += 1) {
    const id = `char_hist_${i}`;
    state.characters[id] = character(id, `历史人物${i}`, i);
  }
  for (let i = 0; i < 120; i += 1) {
    const from = `char_hist_${i % 180}`;
    const to = `char_hist_${(i + 3) % 180}`;
    state.relationships[`rel_hist_${i}`] = {
      id: `rel_hist_${i}`,
      fromCharacterId: from,
      toCharacterId: to,
      direction: 'bidirectional',
      relationType: i % 2 === 0 ? '同伴' : '敌对',
      currentState: `旧关系${i}`,
      trustLevel: 'medium',
      publicStatus: '',
      hiddenStatus: '',
      reason: '',
      firstSeenChapterId: 1,
      lastChangedChapterId: 1,
      lastChangedPosition: i,
      evidenceChapterIds: [1],
    };
  }
  for (let i = 0; i < 40; i += 1) {
    state.mainline.openThreads[`thread_hist_${i}`] = {
      id: `thread_hist_${i}`,
      title: i === 0 ? '银钥匙来源' : `旧线索${i}`,
      description: `无关历史线索${i}。`.repeat(8),
      ownerCharacterIds: [`char_hist_${i % 10}`],
      priority: 'low',
      openedChapterId: 1,
      lastChangedChapterId: 1,
      deadlineOrTrigger: '',
      evidenceChapterIds: [1],
    };
  }
  for (let i = 0; i < 20; i += 1) {
    state.mainline.activeConflicts[`conflict_hist_${i}`] = {
      id: `conflict_hist_${i}`,
      title: i === 0 ? '入口阻拦' : `旧冲突${i}`,
      parties: [`char_hist_${i % 10}`],
      state: `状态${i}`,
      stakes: `赌注${i}`,
      openedChapterId: 1,
      lastChangedChapterId: 1,
      evidenceChapterIds: [1],
    };
  }
  state.mainline.archiveDigest = '历史归档摘要。'.repeat(400).slice(0, 1600);
  return state;
}

function frozenConfig(
  contextWindow: number,
  maxOutputTokens: number,
): FrozenStoryMemoryLLMConfig {
  return {
    configId: 1,
    providerType: 'openai_compatible',
    modelName: MODEL,
    contextWindow,
    maxOutputTokens,
    requestConfig: {
      id: 1,
      provider_type: 'openai_compatible',
      api_key: 'redacted',
      model_name: MODEL,
      url: BASE,
    },
  };
}

async function callLLM(messages: ChatMessage[], maxTokens: number) {
  const frozen = frozenConfig(1_048_576, maxTokens);
  const requestConfig = {
    ...frozen.requestConfig!,
    api_key: loadApiKey(),
  };
  let httpStatus: number | undefined;
  const result = await callLLMResult(
    messages,
    maxTokens,
    buildStoryMemoryLLMConfig({
      scenario: STORY_MEMORY_V2_REQUEST_KINDS.primary,
      projectId: 1,
      requestConfig,
      physicalRequestHooks: {
        afterRequest: event => {
          if (event.outcome === 'response') {
            httpStatus = event.httpStatus;
          }
        },
      },
    }),
  );
  return {
    httpStatus: httpStatus ?? 0,
    finishReason: result.finishReason || '',
    emptyReason: result.emptyReason,
    text: result.text?.trim() || '',
    usage: result.rawUsage || null,
  };
}

describeLive('Story Memory Protocol V2 Closure live LLM', () => {
  const outDir = path.join(
    __dirname,
    '../test-logs/android-qa/story-memory-v2-closure-20260811',
  );
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    model: MODEL,
  };

  afterAll(() => {
    fs.mkdirSync(outDir, { recursive: true });
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(outDir, 'live-closure-report.json'),
      JSON.stringify(report, null, 2),
      'utf8',
    );
  });

  it('complex-long 3x18000 real primary → compile → validate', async () => {
    const chapters = [
      chapter(
        101,
        7,
        padToLength(
          '雨夜里，林岚推开钟楼暗门。陈叔在门后留下银钥匙，守门人退到石阶下。墙上出现三角刻痕。众人决定进入地下室。',
          18000,
        ),
        '第 8 章 暗门',
      ),
      chapter(
        102,
        8,
        padToLength(
          '地下室潮湿，林岚用银钥匙打开第二道铁门。陈叔发现墙上的三角刻痕与钥匙齿痕吻合。远处传来机关转动声。',
          18000,
        ),
        '第 9 章 铁门',
      ),
      chapter(
        103,
        9,
        padToLength(
          '铁门后是旧祭坛，林岚确认祭坛中央有凹陷。陈叔将银钥匙放入凹陷，石阶自动下沉，露出更深通道。',
          18000,
        ),
        '第 10 章 祭坛',
      ),
    ];
    expect(chapters.every(item => item.content.length === 18000)).toBe(true);
    const state = baseState();
    const handles = buildStoryMemoryEntityHandles(state, chapters);
    const evidence = buildStoryMemoryEvidenceAnchors(
      chapters,
      handles.chapterHandleById,
    );
    const materials = buildStoryMemoryObservationMaterials(
      chapters,
      state,
      handles,
      evidence,
    );
    const plan = planStoryMemoryObservationRequest({
      config: frozenConfig(1_048_576, 200_000),
      materials,
      batchSize: 3,
    });
    expect(plan.strategy).toBe('full_prompt');
    const llm = await callLLM(plan.messages, plan.maxTokens);
    expect(llm.httpStatus).toBe(200);
    expect(llm.finishReason).not.toBe('length');
    expect(llm.text.length).toBeGreaterThan(0);
    // Production isomorphic parse path (checkpoint service uses the same helper).
    const raw = parseStoryMemoryObservationCandidate(llm.text);
    const observationsReceived = rawObservationCount(raw);
    const normalized = normalizeStoryMemoryObservationPayload(
      raw,
      materials.includedChapterHandles,
    );
    expect(normalized.missingChapterHandles).toEqual([]);
    const compiled = compileStoryMemoryObservations({
      chapters,
      previousState: state,
      normalized: normalized.chapters,
      handles,
      evidence,
    });
    validateCompiledStoryMemoryBatchPatch(
      compiled.patch,
      state,
      chapters,
      evidence,
    );
    const semanticGate = evaluateStoryMemoryKnownChangeSemanticGate({
      observationsReceived,
      observationsAccepted: compiled.acceptedObservations,
      patch: compiled.patch,
    });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'live-complex-long-diag-from-jest.json'),
      JSON.stringify(
        {
          httpStatus: llm.httpStatus,
          finishReason: llm.finishReason,
          emptyReason: llm.emptyReason,
          textLen: llm.text.length,
          observationsReceived,
          observationsAccepted: compiled.acceptedObservations,
          observationsDropped: compiled.droppedObservations,
          warningCodes: [...new Set(compiled.warnings.map(item => item.code))],
          normalizeWarnings: [
            ...new Set(normalized.warnings.map(item => item.code)),
          ],
          semanticGate,
          patchSnapshot: {
            newCharacters: compiled.patch.newCharacters.length,
            characterUpdates: compiled.patch.characterUpdates.length,
            newRelationships: compiled.patch.newRelationships.length,
            relationshipUpdates: compiled.patch.relationshipUpdates.length,
            conflictUpserts: compiled.patch.mainlinePatch.conflictUpserts.length,
            conflictResolutions: (
              compiled.patch.mainlinePatch.conflictResolutions || []
            ).length,
            threadOpens: compiled.patch.mainlinePatch.threadOpens.length,
            threadUpdates: compiled.patch.mainlinePatch.threadUpdates.length,
            threadResolutions:
              compiled.patch.mainlinePatch.threadResolutions.length,
            foreshadowingUpserts:
              compiled.patch.mainlinePatch.foreshadowingUpserts.length,
            timelineAnchors: compiled.patch.mainlinePatch.timelineAnchors.length,
            objective: Boolean(compiled.patch.mainlinePatch.currentObjective),
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    expect(semanticGate.pass).toBe(true);
    expect(observationsReceived).toBeGreaterThan(0);
    expect(compiled.acceptedObservations).toBeGreaterThanOrEqual(3);
    expect(semanticGate.categories.length).toBeGreaterThan(0);

    const applied = applyStoryMemoryBatchPatch(state, compiled.patch, {
      projectId: 1,
      sourceFingerprint: 'live-complex-long-3x18000',
      batchId: 'batch_live_complex_long_3x18000',
    });
    expect(applied.resolvedBatch.status).toBe('applied');
    expect(applied.state.throughChapterPosition).toBe(9);
    report.complexLong = {
      pass: semanticGate.pass,
      httpStatus: llm.httpStatus,
      finishReason: llm.finishReason,
      emptyReason: llm.emptyReason,
      estimatedInputTokens: plan.estimatedInputTokens,
      outputReservation: plan.maxTokens,
      observationsReceived,
      observationsAccepted: compiled.acceptedObservations,
      observationsDropped: compiled.droppedObservations,
      semanticCategories: semanticGate.categories,
      semanticGateReason: semanticGate.reason,
      warningCodes: [...new Set(compiled.warnings.map(item => item.code))],
      usage: llm.usage,
      applied: true,
      throughChapterPosition: applied.state.throughChapterPosition,
      physicalAttemptCount: 1,
      requestPath:
        'callLLMResult -> buildStoryMemoryLLMConfig -> STORY_MEMORY_V2_REQUEST_KINDS.primary -> parseStoryMemoryObservationCandidate -> normalize/compile/validate/apply',
    };
  }, 300000);

  it('invalid-ref does not pollute episodic summary', () => {
    const state = baseState();
    const chapters = [
      chapter(1, 0, '雨夜里，林岚推开钟楼暗门。陈叔在门后留下银钥匙。'),
    ];
    const handles = buildStoryMemoryEntityHandles(state, chapters);
    const evidence = buildStoryMemoryEvidenceAnchors(
      chapters,
      handles.chapterHandleById,
    );
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
    const compiled = compileStoryMemoryObservations({
      chapters,
      previousState: state,
      normalized: normalized.chapters,
      handles,
      evidence,
    });
    const summary = compiled.patch.chapterSummaries[0];
    expect(compiled.acceptedObservations).toBe(0);
    expect(compiled.patch.characterUpdates).toHaveLength(0);
    expect(summary.events.join('\n')).not.toContain('地下密室');
    expect(summary.characterChanges).toEqual([]);
    expect(compiled.warnings.map(item => item.code)).toContain(
      'OBS_INVALID_REF',
    );
    report.invalidRef = {
      pass: true,
      accepted: compiled.acceptedObservations,
      dropped: compiled.droppedObservations,
    };
  });

  it('rejected N1 dependency degrades locally', () => {
    const state = baseState();
    const chapters = [
      chapter(1, 0, '雨夜里，林岚推开钟楼暗门。陈叔在门后留下银钥匙。'),
    ];
    const handles = buildStoryMemoryEntityHandles(state, chapters);
    const evidence = buildStoryMemoryEvidenceAnchors(
      chapters,
      handles.chapterHandleById,
    );
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
    const compiled = compileStoryMemoryObservations({
      chapters,
      previousState: state,
      normalized: normalized.chapters,
      handles,
      evidence,
    });
    validateCompiledStoryMemoryBatchPatch(
      compiled.patch,
      state,
      chapters,
      evidence,
    );
    expect(compiled.patch.newCharacters).toHaveLength(0);
    expect(compiled.patch.newRelationships).toHaveLength(0);
    expect(compiled.patch.mainlinePatch.threadOpens).toHaveLength(0);
    expect(compiled.acceptedObservations).toBe(1);
    expect(compiled.droppedObservations).toBe(3);
    report.rejectedN1 = {
      pass: true,
      accepted: compiled.acceptedObservations,
      dropped: compiled.droppedObservations,
    };
  });

  it('64K large state + Fresh Retry re-compact', () => {
    const state = largeAccumulatedState();
    const body =
      '雨夜里，林岚与陈叔继续调查入口阻拦，确认银钥匙来源与墙上三角刻痕。众人决定进入地下室。';
    const chapters = [
      chapter(201, 300, padToLength(body, 1200)),
      chapter(202, 301, padToLength(`${body}铁门缓缓打开。`, 1200)),
      chapter(203, 302, padToLength(`${body}祭坛显现。`, 1200)),
    ];
    const handles = buildStoryMemoryEntityHandles(state, chapters);
    const evidence = buildStoryMemoryEvidenceAnchors(
      chapters,
      handles.chapterHandleById,
    );
    const materials = buildStoryMemoryObservationMaterials(
      chapters,
      state,
      handles,
      evidence,
    );
    const fullTokens = estimateMessagesTokens(
      buildMessagesFromObservationMaterials(materials),
    );
    const plan64 = planStoryMemoryObservationRequest({
      config: frozenConfig(65_536, 32_768),
      materials,
      batchSize: 3,
    });
    expect(['full_prompt', 'preflight_split']).toContain(plan64.strategy);
    if (plan64.strategy === 'full_prompt') {
      expect(plan64.estimatedInputTokens).toBeLessThanOrEqual(
        plan64.burstInputLimit,
      );
      expect(plan64.includedModuleIds).toEqual(
        expect.arrayContaining(['v2_current_arc', 'v2_current_objective']),
      );
    }
    const tightConfig = frozenConfig(24_000, 8_192);
    const primaryTight = planStoryMemoryObservationRequest({
      config: tightConfig,
      materials,
      batchSize: 1,
    });
    const fresh = planStoryMemoryFreshRetryRequest({
      config: tightConfig,
      materials,
      batchSize: 1,
      failureCode: 'OBS_INVALID_JSON',
    });
    expect(['full_prompt', 'infeasible']).toContain(fresh.strategy);
    if (fresh.strategy === 'full_prompt') {
      expect(fresh.estimatedInputTokens).toBeLessThanOrEqual(
        fresh.burstInputLimit,
      );
      expect(fresh.includedModuleIds).toEqual(primaryTight.includedModuleIds);
      expect(fresh.droppedModuleIds).toEqual(primaryTight.droppedModuleIds);
      expect(fresh.messages.map(item => item.content).join('\n')).toContain(
        'OBS_INVALID_JSON',
      );
      // Must re-use compact selection; not expand to a larger uncompacted envelope.
      if (primaryTight.droppedModuleIds.length > 0) {
        expect(fresh.includedModuleIds.length).toBeLessThan(
          materials.modules.length,
        );
      }
    }
    report.budget64kFresh = {
      pass: true,
      fullInputTokens: fullTokens,
      characters: Object.keys(state.characters).length,
      plan64: {
        strategy: plan64.strategy,
        estimatedInputTokens: plan64.estimatedInputTokens,
        burst: plan64.burstInputLimit,
        included: plan64.includedModuleIds.length,
        dropped: plan64.droppedModuleIds.length,
      },
      fresh: {
        strategy: fresh.strategy,
        estimatedInputTokens: fresh.estimatedInputTokens,
        included: fresh.includedModuleIds.length,
        dropped: fresh.droppedModuleIds.length,
        matchesPrimaryCompact: fresh.strategy === 'full_prompt',
      },
    };
  });
});




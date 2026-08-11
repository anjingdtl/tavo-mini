/**
 * Story Memory Protocol V2 Closure live smoke.
 *
 * - Reads API key from docs/TEST-KEY.txt (never logs the key)
 * - Real DeepSeek Observation request for complex-long 3-chapter materials
 * - Host-side 64K large-state plan + Fresh Retry compact plan
 * - Compiler local degradation: invalid-ref, rejected N1, cross-chapter evidence
 *
 * Writes: test-logs/android-qa/story-memory-v2-closure-20260811/live-closure-report.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');
const require = createRequire(import.meta.url);
const jiti = require(require.resolve('jiti', { paths: [root] }))(__filename);

function loadKeyFromTestFile() {
  const raw = fs.readFileSync(path.join(root, 'docs/TEST-KEY.txt'), 'utf8');
  const keyLine = raw.split(/\r?\n/).find(line => /api\s*key/i.test(line));
  if (!keyLine) throw new Error('TEST-KEY missing api key line');
  const match = keyLine.match(/sk-[A-Za-z0-9]+/);
  if (!match) throw new Error('TEST-KEY missing sk- token');
  return match[0];
}

const API_KEY = process.env.DEEPSEEK_API_KEY || loadKeyFromTestFile();
const BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

const {
  createEmptyStoryMemory,
} = jiti(path.join(root, 'src/services/storyMemory/storyMemoryDefaults.ts'));
const {
  buildStoryMemoryEntityHandles,
} = jiti(path.join(root, 'src/services/storyMemory/storyMemoryEntityHandles.ts'));
const {
  buildStoryMemoryEvidenceAnchors,
} = jiti(path.join(root, 'src/services/storyMemory/storyMemoryEvidenceAnchors.ts'));
const {
  buildStoryMemoryObservationMaterials,
  buildMessagesFromObservationMaterials,
} = jiti(
  path.join(root, 'src/services/storyMemory/storyMemoryObservationMaterials.ts'),
);
const {
  planStoryMemoryObservationRequest,
  planStoryMemoryFreshRetryRequest,
} = jiti(path.join(root, 'src/services/storyMemory/storyMemoryRequestBudget.ts'));
const {
  normalizeStoryMemoryObservationPayload,
} = jiti(
  path.join(root, 'src/services/storyMemory/storyMemoryObservationNormalizer.ts'),
);
const {
  compileStoryMemoryObservations,
  validateCompiledStoryMemoryBatchPatch,
} = jiti(
  path.join(root, 'src/services/storyMemory/storyMemoryObservationCompiler.ts'),
);
const { extractJSON } = jiti(path.join(root, 'src/utils/jsonExtractor.ts'));
const { estimateMessagesTokens } = jiti(
  path.join(root, 'src/utils/tokenEstimator.ts'),
);

const outDir = path.join(
  root,
  'test-logs/android-qa/story-memory-v2-closure-20260811',
);
fs.mkdirSync(outDir, { recursive: true });

function chapter(id, position, content, title) {
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

function character(id, name, position = 0) {
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

function padToLength(seed, target) {
  let text = seed;
  let i = 0;
  while (text.length < target) {
    text += ` 夜更深了，林岚与陈叔继续沿石阶向下，确认墙上的三角刻痕仍在第${i}段墙面重复出现。银钥匙在掌心发凉。`;
    i += 1;
  }
  return text.slice(0, target);
}

function baseState() {
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

function largeAccumulatedState() {
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

function frozenConfig(contextWindow, maxOutputTokens) {
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

async function callLLM(messages, maxTokens) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: false,
      response_format: { type: 'json_object' },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const message = data.choices?.[0]?.message || {};
  const text =
    typeof message.content === 'string' && message.content.trim()
      ? message.content
      : '';
  return {
    httpStatus: res.status,
    finishReason: data.choices?.[0]?.finish_reason || '',
    text,
    usage: data.usage || null,
  };
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function testComplexLongLive() {
  const seed1 =
    '雨夜里，林岚推开钟楼暗门。陈叔在门后留下银钥匙，守门人退到石阶下。墙上出现三角刻痕。众人决定进入地下室。';
  const seed2 =
    '地下室潮湿，林岚用银钥匙打开第二道铁门。陈叔发现墙上的三角刻痕与钥匙齿痕吻合。远处传来机关转动声。';
  const seed3 =
    '铁门后是旧祭坛，林岚确认祭坛中央有凹陷。陈叔将银钥匙放入凹陷，石阶自动下沉，露出更深通道。';
  const chapters = [
    chapter(101, 7, padToLength(seed1, 18000), '第 8 章 暗门'),
    chapter(102, 8, padToLength(seed2, 18000), '第 9 章 铁门'),
    chapter(103, 9, padToLength(seed3, 18000), '第 10 章 祭坛'),
  ];
  assert(chapters.every(c => c.content.length === 18000), 'chapter length must be 18000');
  const state = baseState();
  const handles = buildStoryMemoryEntityHandles(state, chapters);
  const evidence = buildStoryMemoryEvidenceAnchors(chapters, handles.chapterHandleById);
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
  assert(plan.strategy === 'full_prompt', `complex plan strategy=${plan.strategy}`);
  const llm = await callLLM(plan.messages, plan.maxTokens);
  assert(llm.httpStatus === 200, 'complex-long HTTP not 200');
  assert(llm.text.trim().length > 0, 'complex-long empty text');
  const raw = extractJSON(llm.text);
  const normalized = normalizeStoryMemoryObservationPayload(
    raw,
    materials.includedChapterHandles,
  );
  const compiled = compileStoryMemoryObservations({
    chapters,
    previousState: state,
    normalized: normalized.chapters,
    handles,
    evidence,
  });
  validateCompiledStoryMemoryBatchPatch(compiled.patch, state, chapters, evidence);
  return {
    pass: true,
    httpStatus: llm.httpStatus,
    finishReason: llm.finishReason,
    chapterChars: chapters.map(c => c.content.length),
    estimatedInputTokens: plan.estimatedInputTokens,
    outputReservation: plan.maxTokens,
    observationsReceived: normalized.chapters.reduce(
      (sum, item) => sum + item.observations.length,
      0,
    ),
    observationsAccepted: compiled.acceptedObservations,
    observationsDropped: compiled.droppedObservations,
    warningCodes: [...new Set(compiled.warnings.map(w => w.code))],
    patchNewCharacters: compiled.patch.newCharacters.length,
    patchCharacterUpdates: compiled.patch.characterUpdates.length,
    usage: llm.usage,
  };
}

function testInvalidRefNoPollution() {
  const state = baseState();
  const chapters = [
    chapter(
      1,
      0,
      '雨夜里，林岚推开钟楼暗门。陈叔在门后留下银钥匙。',
    ),
  ];
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
  const compiled = compileStoryMemoryObservations({
    chapters,
    previousState: state,
    normalized: normalized.chapters,
    handles,
    evidence,
  });
  const summary = compiled.patch.chapterSummaries[0];
  assert(compiled.acceptedObservations === 0, 'invalid-ref should not accept');
  assert(compiled.patch.characterUpdates.length === 0, 'invalid-ref should not mutate');
  assert(
    !summary.events.join('\n').includes('地下密室'),
    'invalid-ref polluted events',
  );
  assert(summary.characterChanges.length === 0, 'invalid-ref polluted characterChanges');
  assert(
    compiled.warnings.some(w => w.code === 'OBS_INVALID_REF'),
    'missing OBS_INVALID_REF',
  );
  return {
    pass: true,
    accepted: compiled.acceptedObservations,
    dropped: compiled.droppedObservations,
    warningCodes: compiled.warnings.map(w => w.code),
    events: summary.events,
    characterChanges: summary.characterChanges,
  };
}

function testRejectedN1Dependency() {
  const state = baseState();
  const chapters = [
    chapter(1, 0, '雨夜里，林岚推开钟楼暗门。陈叔在门后留下银钥匙。'),
  ];
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
  const compiled = compileStoryMemoryObservations({
    chapters,
    previousState: state,
    normalized: normalized.chapters,
    handles,
    evidence,
  });
  validateCompiledStoryMemoryBatchPatch(compiled.patch, state, chapters, evidence);
  assert(compiled.patch.newCharacters.length === 0, 'N1 should not create character');
  assert(compiled.patch.newRelationships.length === 0, 'N2 should drop');
  assert(compiled.patch.mainlinePatch.threadOpens.length === 0, 'N3 should drop');
  assert(compiled.acceptedObservations === 1, 'only valid C01 state accepted');
  assert(compiled.droppedObservations === 3, 'three deps dropped');
  return {
    pass: true,
    accepted: compiled.acceptedObservations,
    dropped: compiled.droppedObservations,
    warningCodes: [...new Set(compiled.warnings.map(w => w.code))],
    newCharacters: compiled.patch.newCharacters.length,
    newRelationships: compiled.patch.newRelationships.length,
    threadOpens: compiled.patch.mainlinePatch.threadOpens.length,
  };
}

function testFreshRetryCompactAnd64k() {
  const state = largeAccumulatedState();
  const body =
    '雨夜里，林岚与陈叔继续调查入口阻拦，确认银钥匙来源与墙上三角刻痕。众人决定进入地下室。';
  const chapters = [
    chapter(201, 300, padToLength(body, 1200)),
    chapter(202, 301, padToLength(`${body}铁门缓缓打开。`, 1200)),
    chapter(203, 302, padToLength(`${body}祭坛显现。`, 1200)),
  ];
  const handles = buildStoryMemoryEntityHandles(state, chapters);
  const evidence = buildStoryMemoryEvidenceAnchors(chapters, handles.chapterHandleById);
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
  assert(
    plan64.strategy === 'full_prompt' || plan64.strategy === 'preflight_split',
    `64k strategy=${plan64.strategy}`,
  );
  if (plan64.strategy === 'full_prompt') {
    assert(
      plan64.estimatedInputTokens <= plan64.burstInputLimit,
      '64k over burst',
    );
    assert(
      plan64.includedModuleIds.includes('v2_current_arc'),
      '64k missing arc',
    );
    assert(
      plan64.includedModuleIds.includes('v2_current_objective'),
      '64k missing objective',
    );
  }
  const fresh = planStoryMemoryFreshRetryRequest({
    config: frozenConfig(28_000, 8_192),
    materials,
    batchSize: 1,
    failureCode: 'OBS_INVALID_JSON',
  });
  assert(
    fresh.strategy === 'full_prompt' || fresh.strategy === 'infeasible',
    `fresh strategy=${fresh.strategy}`,
  );
  let freshCompact = false;
  if (fresh.strategy === 'full_prompt') {
    assert(fresh.estimatedInputTokens <= fresh.burstInputLimit, 'fresh over burst');
    assert(
      fresh.includedModuleIds.length < materials.modules.length,
      'fresh restored full state',
    );
    assert(
      fresh.messages.map(m => m.content).join('\n').includes('OBS_INVALID_JSON'),
      'fresh missing instruction',
    );
    freshCompact = true;
  }
  return {
    pass: true,
    fullInputTokens: fullTokens,
    characters: Object.keys(state.characters).length,
    relationships: Object.keys(state.relationships).length,
    threads: Object.keys(state.mainline.openThreads).length,
    plan64: {
      strategy: plan64.strategy,
      estimatedInputTokens: plan64.estimatedInputTokens,
      burstInputLimit: plan64.burstInputLimit,
      included: plan64.includedModuleIds.length,
      dropped: plan64.droppedModuleIds.length,
      hasArc: plan64.includedModuleIds.includes('v2_current_arc'),
      hasObjective: plan64.includedModuleIds.includes('v2_current_objective'),
    },
    fresh: {
      strategy: fresh.strategy,
      estimatedInputTokens: fresh.estimatedInputTokens,
      burstInputLimit: fresh.burstInputLimit,
      included: fresh.includedModuleIds.length,
      dropped: fresh.droppedModuleIds.length,
      compact: freshCompact,
    },
  };
}

async function main() {
  const report = {
    startedAt: new Date().toISOString(),
    model: MODEL,
    base: BASE,
    results: {},
  };
  try {
    console.log('[closure-live] invalid-ref compiler...');
    report.results.invalidRef = testInvalidRefNoPollution();
    console.log('[closure-live] rejected N1 dependency...');
    report.results.rejectedN1 = testRejectedN1Dependency();
    console.log('[closure-live] 64K + Fresh Retry compact plan...');
    report.results.budget64kFresh = testFreshRetryCompactAnd64k();
    console.log('[closure-live] complex-long 3x18000 real LLM...');
    report.results.complexLong = await testComplexLongLive();
    report.pass = Object.values(report.results).every(item => item.pass);
  } catch (error) {
    report.pass = false;
    report.error = error instanceof Error ? error.message : String(error);
    console.error('[closure-live] FAILED:', report.error);
  }
  report.finishedAt = new Date().toISOString();
  const outPath = path.join(outDir, 'live-closure-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('[closure-live] wrote', outPath);
  console.log('[closure-live]', report.pass ? 'PASS' : 'FAIL');
  process.exit(report.pass ? 0 : 1);
}

main();

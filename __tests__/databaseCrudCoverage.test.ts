/* eslint-env jest */

import * as database from '../src/services/database';

type FakeRow = Record<string, any>;

function createRows(values: FakeRow[]) {
  return {
    length: values.length,
    item: (index: number) => values[index],
    raw: () => values,
  };
}

function createCrudDatabase() {
  const settings = new Map<string, string>([
    ['app_version', '2.4.3'],
    ['first_install_version', '2.4.0'],
    ['schema_version', '14'],
    ['context_strategy', 'sliding'],
    ['sliding_window_size', '5'],
    ['custom_range_start', '0'],
    ['custom_range_end', '3'],
    ['resource_budget', '50000'],
    ['include_resources', 'true'],
    ['summary_budget_tokens', '500'],
    ['memory_top_k', '3'],
    ['recent_chapter_count', '3'],
    ['worldbook_recursive', 'true'],
    ['worldbook_scan_depth', '2'],
    ['background_pipeline_enabled', 'true'],
    ['tts_engine', 'system'],
    ['voice_config', '{}'],
    ['system_tts_config', '{}'],
  ]);
  let nextId = 100;
  const executed: string[] = [];
  const overrides = new Map<string, FakeRow[]>();
  const baseRow: FakeRow = {
    id: 1,
    project_id: 1,
    projectId: 1,
    target_id: 1,
    position: 0,
    title: '测试标题',
    name: '测试名称',
    content: '测试内容',
    synopsis: '测试梗概',
    status: 'ready',
    mode: 'outline',
    type: 'character',
    source_type: 'json',
    data_json: '{}',
    collection_id: 1,
    keyword_primary: '关键词',
    keyword_secondary: '',
    comment: '',
    enabled: 1,
    constant: 0,
    max_tokens: 1000,
    estimated_tokens: 10,
    summary_json: null,
    memory_summary: '',
    memory_summary_tokens: 0,
    finalized_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    provider_type: 'openai_compatible',
    base_url: 'https://example.com/v1',
    api_key: '',
    model_name: 'test-model',
    is_active: 1,
    local_model_id: null,
    local_backend: null,
    context_window: 4096,
    max_output_tokens: 4000,
    display_name: '测试模型',
    original_filename: 'test.gguf',
    relative_path: 'models/test.gguf',
    file_size: 1,
    sha256: 'sha-test',
    backend_preference: 'auto',
    validated_backend: 'cpu',
    context_length: 4096,
    load_time_ms: 10,
    first_token_ms: 10,
    tokens_per_second: 10,
    imported_at: '2026-01-01T00:00:00.000Z',
    last_used_at: null,
    last_validated_at: null,
    error_code: '',
    error_message: '',
    value: '',
    key: '',
    chunk: '测试片段',
    length: 0,
    cnt: 2,
    count: 2,
    stage_results: '[]',
    target_type: 'chapter',
    resolved_at: null,
    resolved_action: null,
    final_text: null,
    error: null,
    profile_text: '风格',
    profile_json: '{}',
    analyzed_at: '2026-01-01T00:00:00.000Z',
    source_hash: 'hash',
    style_weights: '{}',
    retrieval_top_k: 5,
    retrieval_fragment_chars: 1000,
    enabled_note_ids: '[]',
  };

  const result = (values: FakeRow[] = [], insertId = nextId++) => [
    { rows: createRows(values), rowsAffected: 1, insertId },
  ];

  const executeSql = jest.fn(async (sql: string, params: any[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    executed.push(normalized);
    const lower = normalized.toLowerCase();

    if (lower.startsWith('select value from settings')) {
      const value = settings.get(String(params[0])) ?? '';
      return result([{ value }], 0);
    }
    if (lower.startsWith('select key, value from settings')) {
      return result(
        Array.from(settings.entries()).map(([key, value]) => ({ key, value })),
        0,
      );
    }
    if (lower.startsWith('insert or replace into settings')) {
      settings.set(String(params[0]), String(params[1] ?? ''));
      return result([], 0);
    }
    for (const [fragment, values] of overrides) {
      if (lower.includes(fragment)) return result(values, 0);
    }
    if (lower.includes('last_insert_rowid')) {
      return result([{ id: nextId }], 0);
    }
    if (lower.includes('count(*) as cnt')) {
      return result([{ cnt: 2 }], 0);
    }
    if (lower.startsWith('select * from llm_config order by')) {
      return result(
        [baseRow, { ...baseRow, id: 2, is_active: 0 }],
        0,
      );
    }
    if (lower.includes('select id from llm_config where id <>')) {
      return result([{ id: 2 }], 0);
    }
    if (lower.startsWith('select * from local_llm_models')) {
      return result([baseRow], 0);
    }
    if (lower.startsWith('select length(content)')) {
      return result([{ length: 0 }], 0);
    }
    if (lower.startsWith('select id, substr(content')) {
      return result([{ id: 1, chunk: '测试片段' }], 0);
    }
    if (lower.startsWith('select id, length(content)')) {
      return result([{ id: 1, length: 0 }], 0);
    }
    if (lower.startsWith('select name from sqlite_master')) {
      return result([{ name: 'projects' }], 0);
    }
    if (lower.startsWith('pragma')) {
      return result([{ foreign_keys: 1 }], 0);
    }
    if (lower.startsWith('select')) {
      return result([{ ...baseRow }], 0);
    }
    return result([], nextId++);
  });

  const transaction = jest.fn(
    (
      scope: (tx: { executeSql: (sql: string, params?: any[]) => void }) => void,
      onError: (error: unknown) => void,
      onSuccess: () => void,
    ) => {
      try {
        scope({
          executeSql: (sql, _params = []) => {
            executed.push(sql.replace(/\s+/g, ' ').trim());
          },
        });
        onSuccess();
      } catch (error) {
        onError(error);
      }
    },
  );

  return {
    database: { executeSql, transaction } as any,
    executed,
    setRows: (fragment: string, values: FakeRow[]) => {
      overrides.set(fragment.toLowerCase(), values);
    },
    setSetting: (key: string, value: string) => {
      settings.set(key, value);
    },
    removeSetting: (key: string) => {
      settings.delete(key);
    },
  };
}

describe('database CRUD contract coverage', () => {
  afterEach(() => {
    database.__resetForTest();
  });

  test('covers the public data-access contract on a deterministic SQLite double', async () => {
    const fake = createCrudDatabase();
    database.__setDatabaseForTest(fake.database);

    expect(await database.openDatabase()).toBe(fake.database);
    expect(await database.detectInstallType(fake.database)).toMatchObject({
      installType: 'upgrade',
      schemaVersion: 14,
      previousVersion: '2.4.3',
    });
    await database.repairKnownSchemaDefects(fake.database, 1);

    const calls: Array<[string, unknown[]]> = [
      ['getAllProjects', []],
      ['getProjectById', [1]],
      ['createProject', ['项目', 'outline']],
      ['updateProject', [1, '新项目']],
      ['deleteProject', [0]],
      ['deleteProject', [1]],
      ['getChaptersByProject', [1]],
      ['getChapterById', [1]],
      ['buildChapterReadingText', [1, 1, 'current']],
      ['buildChapterReadingText', [1, 1, 'fromCurrent']],
      ['buildChapterReadingText', [1, 1, 'all']],
      ['createChapter', [1, 0, '第一章']],
      ['updateChapter', [1, { title: '新标题', summary_json: { ok: true } }]],
      ['updateChapter', [1, {}]],
      ['deleteChapter', [1]],
      ['getFragmentsByProject', [1]],
      ['createFragment', [1, 'scene', '片段', 0]],
      ['deleteFragment', [1]],
      ['getPlotlinesByProject', [1]],
      ['createPlotline', [1, '主线', '内容']],
      ['deletePlotline', [1]],
      ['setChapterPlotlines', [1, [1, 2]]],
      ['getChapterPlotlineIds', [1]],
      ['setProjectResourceEnabled', [1, 'character', 1, true]],
      ['getAllCharacters', []],
      ['getAllCharacters', [1]],
      ['getCharactersByProject', [1]],
      ['getCharacterById', [1]],
      ['getCharacterCollections', []],
      ['getCharacterCollections', [1]],
      ['createCharacterCollection', [1, '角色合集', { enabled: 1 }]],
      ['updateCharacterCollection', [1, { name: '新合集', enabled: 1 }]],
      ['updateCharacterCollectionTokenEstimate', [1]],
      ['ensureDefaultCharacterCollection', [1, '未分组']],
      ['getCharactersByCollection', [1]],
      ['setCharacterCollectionEnabledForProject', [1, 1, true]],
      ['setCharacterCollectionEnabledForProject', [0, 1, false]],
      ['setAllCharactersCollectionId', [1, 1]],
      ['deleteCharacterCollection', [1]],
      ['createCharacter', [1, '角色', 'json', '{}', { collectionId: 1 }]],
      ['updateCharacter', [1, '角色', '{}']],
      ['updateCharacterTokenBudget', [1, 1000]],
      ['deleteCharacter', [1]],
      ['getAllWorldbookEntries', []],
      ['getAllWorldbookEntries', [1]],
      ['setAllProjectResourcesEnabled', [1, 'worldbook', true]],
      ['setWorldbookCollectionEnabledForProject', [1, 1, true]],
      ['setWorldbookCollectionEnabledForProject', [1, 1, false]],
      ['getWorldbookEntriesByProject', [1]],
      ['getWorldbookCollections', []],
      ['getWorldbookCollections', [1]],
      ['createWorldbookCollection', [1, '世界观', { enabled: 1 }]],
      ['updateWorldbookCollection', [1, { name: '新世界观' }]],
      ['updateWorldbookCollectionTokenEstimate', [1]],
      ['deleteWorldbookCollection', [1]],
      ['getWorldbookEntryById', [1]],
      ['getWorldbookEntriesByCollection', [1]],
      ['createWorldbookEntry', [1, '关键词', '世界书内容', 1, { collection_id: 1 }]],
      ['updateWorldbookEntry', [1, { content: '更新内容' }]],
      ['deleteWorldbookEntry', [1]],
      ['createNotesFromTextChunks', [1, '笔记', '笔记内容']],
      ['getNoteContentById', [1]],
      ['getNotesContentByIds', [[]]],
      ['getNotesContentByIds', [[1, 2]]],
      ['getAllNotes', []],
      ['getAllNotes', [1]],
      ['getNotesByProject', [1]],
      ['createNote', [1, '笔记标题', '笔记内容']],
      ['updateNote', [1, '新标题', '新内容']],
      ['updateNoteTokenBudget', [1, 2000]],
      ['deleteNote', [1]],
      ['getAllPresets', []],
      ['getAllPresets', [1]],
      ['getPresetsByProject', [1]],
      ['updatePreset', [1, { name: '新预设', is_default: 1 }]],
      ['createPreset', [1, '默认预设', true]],
      ['deletePreset', [1]],
      ['getLLMConfigs', []],
      ['getActiveLLMConfig', []],
      ['saveLLMConfig', [{ name: '在线配置', base_url: 'https://example.com', is_active: 1 }]],
      ['saveLLMConfig', [{ id: 1, name: '更新配置', api_key: 'secret' }]],
      ['setActiveLLMConfig', [1]],
      ['deleteLLMConfig', [1]],
      ['getLLMConfig', []],
      ['setLLMConfig', ['https://example.com', 'secret', 'model']],
      ['listLocalModels', []],
      ['getLocalModelById', ['model-id']],
      ['getLocalModelBySha256', ['sha-test']],
      ['createLocalModel', [baseLocalModel()]],
      ['updateLocalModel', ['model-id', { display_name: '更新模型' }]],
      ['deleteLocalModelRecord', ['model-id']],
      ['countLLMConfigsUsingModel', ['model-id']],
      ['getSetting', ['context_strategy']],
      ['setSetting', ['custom_key', 'custom_value']],
      ['getContextConfig', []],
      ['setContextConfig', [contextConfig()]],
      ['getBackgroundPipelineEnabled', []],
      ['setBackgroundPipelineEnabled', [false]],
      ['getVoiceConfig', []],
      ['setVoiceConfig', [voiceConfig()]],
      ['getTtsEngine', []],
      ['setTtsEngine', ['cloud']],
      ['getSystemTtsConfig', []],
      ['setSystemTtsConfig', [systemTtsConfig()]],
      ['logLLMUsage', [usageFields()]],
      ['getFreeformDocument', [1]],
      ['setFreeformDocument', [1, '自由文档']],
      ['getPipelineConfig', []],
      ['setPipelineConfig', [pipelineConfig()]],
      ['savePipelineTask', [pipelineTask()]],
      ['getUnresolvedPipelineTasks', []],
      ['getAllPipelineTasks', []],
      ['deletePipelineTask', ['task-1']],
      ['deleteResolvedPipelineTasks', []],
      ['setAllWorldbookEntriesEnabledByCollection', [1, true]],
      ['createContentRevision', [revisionFields()]],
      ['getContentRevisions', ['chapter', 1]],
      ['getLatestContentRevision', ['chapter', 1]],
      ['deleteContentRevision', [1]],
      ['trimContentRevisions', ['chapter', 1, 1, 1]],
      ['createGenerationDraft', [generationDraftFields()]],
      ['getGenerationDrafts', ['chapter', 1]],
      ['getGenerationDraft', [1]],
      ['deleteGenerationDraft', [1]],
      ['deleteGenerationDraftsByTarget', ['chapter', 1]],
      ['getLLMUsageStats', [1]],
      ['getLLMUsageStats', [null]],
      ['getLLMUsageSummary', [1]],
      ['getLLMUsageSummary', [null]],
      ['getLLMUsageByConfig', [1]],
      ['getProjectNoteConfig', [1]],
      ['setProjectNoteConfig', [1, { mode: 'retrieval', retrievalTopK: 3 }]],
      ['getNoteStyleProfile', [1]],
      ['setNoteStyleProfile', [1, '风格', '{}', 'hash']],
      ['deleteNoteStyleProfile', [1]],
      ['computeNoteSourceHash', ['用于计算哈希的文本']],
    ];

    const callable = database as unknown as Record<
      string,
      (...args: any[]) => unknown
    >;
    const failures: string[] = [];
    for (const [name, args] of calls) {
      try {
        await callable[name](...args);
      } catch (error) {
        failures.push(`${name}: ${String(error)}`);
      }
    }

    expect(failures).toEqual([]);
    expect(await database.getAllProjects()).toHaveLength(1);
    expect(await database.getChapterById(1)).not.toBeNull();
    expect(await database.getNotesContentByIds([])).toEqual({});
    expect(database.splitNoteTextIntoChunks('')).toEqual(['']);
    expect(database.splitNoteTextIntoChunks('短文本', 100)).toEqual(['短文本']);
    expect(database.splitNoteTextIntoChunks('第一章\n内容\n第二章\n内容', 6).length).toBeGreaterThan(1);
    expect(fake.executed.some(sql => sql.startsWith('INSERT INTO projects'))).toBe(true);
  });

  test('covers empty-result, default, and cancellation-safe branches', async () => {
    const fake = createCrudDatabase();
    database.__setDatabaseForTest(fake.database);

    await database.__resetForTest();
    await expect(database.openDatabase()).rejects.toBeTruthy();
    database.__setDatabaseForTest(fake.database);

    fake.setRows('select * from chapters', []);
    expect(await database.getChapterById(999)).toBeNull();
    expect(await database.buildChapterReadingText(1, 999, 'current')).toBe('');

    fake.setRows('select id from character_collections', []);
    expect(await database.ensureDefaultCharacterCollection(1)).toBeGreaterThan(0);
    fake.setRows('select id from worldbook_entries', []);
    await database.setWorldbookCollectionEnabledForProject(1, 1, true);

    fake.setRows('select * from local_llm_models', []);
    expect(await database.getLocalModelById('missing')).toBeNull();
    expect(await database.getLocalModelBySha256('missing')).toBeNull();
    fake.setRows('select * from local_llm_models', [
      { ...baseLocalModel(), status: 'missing' },
    ]);
    expect(await database.getLocalModelById('missing')).toMatchObject({ status: 'missing' });

    fake.setSetting('voice_config', 'not-json');
    fake.setSetting('system_tts_config', 'not-json');
    fake.setSetting('tts_engine', 'cloud');
    fake.removeSetting('background_pipeline_enabled');
    expect(await database.getVoiceConfig()).toBeDefined();
    expect(await database.getSystemTtsConfig()).toBeDefined();
    expect(await database.getTtsEngine()).toBe('cloud');
    expect(await database.getBackgroundPipelineEnabled()).toBe(true);

    fake.setRows('select * from project_note_config', []);
    expect(await database.getProjectNoteConfig(1)).toBeNull();
    fake.setRows('select * from note_style_profiles', []);
    expect(await database.getNoteStyleProfile(1)).toBeNull();
    fake.setRows('select * from pipeline_tasks', [
      { ...basePipelineTaskRow(), stage_results: 'not-json' },
    ]);
    expect((await database.getAllPipelineTasks())[0].stageResults).toEqual([]);

    fake.setRows('from llm_usage_logs', []);
    expect(await database.getLLMUsageSummary(null)).toMatchObject({
      total_calls: 0,
    });
    expect(await database.getLLMUsageStats(null)).toEqual([]);

    await database.updatePreset(1, { name: '只更新名称' });
    await database.createPreset(1, '非默认预设', false);
    await database.createChapter(1, 1);
    await database.updateChapter(1, { title: '存在的章节' });
    await database.deleteChapter(1);
    await database.createCharacterCollection(1, '禁用合集', { enabled: 0, max_tokens: 0, estimated_tokens: 0 });
    await database.createCharacter(1, '无合集角色', 'json', '{}', {});
    await database.createWorldbookCollection(1, '禁用世界书', { enabled: 0, max_tokens: 0, estimated_tokens: 0 });
    await database.createWorldbookEntry(1, '关键词', '内容', 0, {});
    await database.getNotesContentByIds([0, Number.NaN] as any);
    await database.createNotesFromTextChunks(1, '长笔记', '内容'.repeat(3));
    await database.trimContentRevisions('chapter', 1, 0, 0);
  });
});

function baseLocalModel() {
  return {
    id: 'model-id',
    display_name: '测试模型',
    original_filename: 'test.gguf',
    relative_path: 'models/test.gguf',
    file_size: 1,
    sha256: 'sha-test',
    status: 'ready',
    backend_preference: 'auto',
    validated_backend: 'cpu',
    context_length: 4096,
    max_output_tokens: 4000,
    load_time_ms: 10,
    first_token_ms: null,
    tokens_per_second: null,
    imported_at: '2026-01-01T00:00:00.000Z',
    last_used_at: null,
    last_validated_at: null,
    error_code: null,
    error_message: null,
  };
}

function contextConfig() {
  return {
    strategy: 'sliding',
    slidingWindowSize: 5,
    customRangeStart: 0,
    customRangeEnd: 3,
    resourceBudget: 50000,
    includeResources: true,
    summaryBudgetTokens: 500,
    memoryTopK: 3,
    recentChapterCount: 3,
    worldbookRecursive: true,
    worldbookScanDepth: 2,
  };
}

function voiceConfig() {
  return {
    enabled: true,
    provider: 'system',
    voiceId: '',
    speed: 1,
    pitch: 1,
    volume: 1,
  };
}

function systemTtsConfig() {
  return {
    engine: '',
    voice: '',
    language: 'zh-CN',
    speechRate: 1,
    pitch: 1,
  };
}

function pipelineConfig() {
  return {
    pipelineMode: 'twoStage',
    draftPresetId: null,
    reviewPresetId: null,
    factCheckPresetId: null,
    proofPresetId: null,
    draftMaxTokens: 4000,
    reviewMaxTokens: 1500,
    factCheckMaxTokens: 1500,
    proofMaxTokens: 4000,
  };
}

function usageFields() {
  return {
    scenario: 'test',
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    status: 'success',
    modelName: 'test-model',
    projectId: 1,
    llmConfigId: 1,
    llmConfigName: '测试配置',
  };
}

function pipelineTask() {
  return {
    id: 'task-1',
    targetType: 'chapter',
    targetId: 1,
    status: 'completed',
    stageResults: [],
    finalText: '结果',
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resolvedAt: Date.now(),
    resolvedAction: 'adopt',
  };
}

function revisionFields() {
  return {
    projectId: 1,
    targetType: 'chapter',
    targetId: 1,
    title: '标题',
    content: '内容',
    source: 'manual_checkpoint',
    sourceRef: 'test',
  };
}

function generationDraftFields() {
  return {
    projectId: 1,
    targetType: 'chapter',
    targetId: 1,
    content: '草稿',
    source: 'pipeline',
    pipelineTaskId: 'task-1',
    tokenCount: 10,
  };
}

function basePipelineTaskRow() {
  return {
    id: 'task-1',
    target_type: 'chapter',
    target_id: 1,
    status: 'completed',
    stage_results: '[]',
    final_text: '结果',
    error: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    resolved_at: null,
    resolved_action: null,
  };
}

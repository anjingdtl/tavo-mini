/* eslint-env jest */

import {
  listLocalModels,
  getLocalModelById,
  getLocalModelBySha256,
  createLocalModel,
  updateLocalModel,
  deleteLocalModelRecord,
  countLLMConfigsUsingModel,
  cleanupOrphanedModels,
  cleanupStagingFiles,
  importLocalModel,
} from '../../src/services/localModels';
import { deleteModelFiles } from '../../src/native/LlamaCppModule';

const mockModels: any[] = [];

jest.mock('../../src/services/database', () => ({
  listLocalModels: jest.fn(async () => [...mockModels]),
  getLocalModelById: jest.fn(async (id: string) => mockModels.find(m => m.id === id) || null),
  getLocalModelBySha256: jest.fn(async (sha256: string) => mockModels.find(m => m.sha256 === sha256) || null),
  createLocalModel: jest.fn(async (model: any) => {
    mockModels.push({ ...model, imported_at: model.imported_at || new Date().toISOString() });
  }),
  updateLocalModel: jest.fn(async (id: string, fields: any) => {
    const index = mockModels.findIndex(m => m.id === id);
    if (index >= 0) mockModels[index] = { ...mockModels[index], ...fields };
  }),
  deleteLocalModelRecord: jest.fn(async (id: string) => {
    const index = mockModels.findIndex(m => m.id === id);
    if (index >= 0) mockModels.splice(index, 1);
  }),
  countLLMConfigsUsingModel: jest.fn(async (_modelId: string) => 0),
}));

// Mock LlamaCpp 原生模块：modelFileExists 默认返回 false 以模拟文件缺失，
// 使 cleanupOrphanedModels 能把模型标记为 missing。
jest.mock('../../src/native/LlamaCppModule', () => ({
  isLlamaCppAvailable: jest.fn(() => true),
  getCapabilities: jest.fn(async () => ({ available: true, cpuSupported: true, freeMemoryMB: 4096, totalMemoryMB: 8192 })),
  importModel: jest.fn(async (_uri: string, originalFilename: string, displayName: string) => ({
    importId: 'import-test',
    originalFilename,
    displayName,
    fileSize: 0,
    sha256: 'sha-test',
    stagingRelativePath: 'test/test.gguf',
  })),
  validateModel: jest.fn(async () => ({ backend: 'cpu', loadTimeMs: 100 })),
  loadModel: jest.fn(async () => ({ backend: 'cpu', loadTimeMs: 100 })),
  generate: jest.fn(async () => undefined),
  cancel: jest.fn(async () => undefined),
  unloadModel: jest.fn(async () => undefined),
  deleteModelFiles: jest.fn(async () => undefined),
  modelFileExists: jest.fn(async () => false),
  cleanupStagingFiles: jest.fn(async () => 0),
  observeGeneration: jest.fn(() => () => {}),
  observeImport: jest.fn(() => () => {}),
  subscribeImportEvents: jest.fn(() => () => {}),
  LlamaCppEvents: {
    TOKEN: 'LlamaCppToken',
    COMPLETED: 'LlamaCppCompleted',
    ERROR: 'LlamaCppError',
    IMPORT_PROGRESS: 'LlamaCppImportProgress',
    IMPORT_STATE: 'LlamaCppImportState',
  },
  LlamaCppNative: {},
}));

function makeModel(overrides: Partial<Record<string, any>> = {}): any {
  return {
    id: 'model-x',
    display_name: 'Test Model',
    original_filename: 'test.gguf',
    relative_path: 'model-x/model.gguf',
    file_size: 1024,
    sha256: 'sha-x',
    status: 'ready',
    backend_preference: 'auto',
    validated_backend: 'cpu',
    context_length: 2048,
    max_output_tokens: 512,
    load_time_ms: null,
    first_token_ms: null,
    tokens_per_second: null,
    imported_at: new Date().toISOString(),
    last_used_at: null,
    last_validated_at: null,
    error_code: null,
    error_message: null,
    prompt_template: 'chatml',
    actual_backend: null,
    ...overrides,
  };
}

describe('localModels service', () => {
  beforeEach(() => {
    mockModels.length = 0;
    jest.clearAllMocks();
  });

  it('creates and lists a local model', async () => {
    await createLocalModel(makeModel({ id: 'model-1', display_name: 'Test Model' }));

    const models = await listLocalModels();
    expect(models).toHaveLength(1);
    expect(models[0].display_name).toBe('Test Model');
  });

  it('finds model by sha256', async () => {
    await createLocalModel(makeModel({ id: 'model-2', display_name: 'Another Model', sha256: 'def456' }));

    const found = await getLocalModelBySha256('def456');
    expect(found?.display_name).toBe('Another Model');
    expect(await getLocalModelBySha256('missing')).toBeNull();
  });

  it('removes the copied native file when an already-imported model is selected again', async () => {
    mockModels.push(makeModel({ id: 'existing-model', sha256: 'sha-test' }));

    await expect(importLocalModel('content://downloads/again.gguf', 'again.gguf')).rejects.toThrow(
      '该模型文件已导入',
    );

    expect(deleteModelFiles).toHaveBeenCalledWith('import-test', 'test/test.gguf');
    expect(mockModels).toHaveLength(1);
  });

  it('updates and deletes a model', async () => {
    await createLocalModel(makeModel({ id: 'model-3', display_name: 'Old Name', status: 'importing', sha256: 'ghi789' }));

    await updateLocalModel('model-3', { display_name: 'New Name', status: 'ready' });
    const updated = await getLocalModelById('model-3');
    expect(updated?.display_name).toBe('New Name');
    expect(updated?.status).toBe('ready');

    await deleteLocalModelRecord('model-3');
    expect(await getLocalModelById('model-3')).toBeNull();
  });

  it('counts LLM configs using a model', async () => {
    const count = await countLLMConfigsUsingModel('model-x');
    expect(typeof count).toBe('number');
  });

  it('cleans up orphaned models when native module reports file missing', async () => {
    await createLocalModel(makeModel({ id: 'model-orphan', display_name: 'Orphan', sha256: 'orphan-sha' }));

    await cleanupOrphanedModels();
    const model = await getLocalModelById('model-orphan');
    expect(model?.status).toBe('missing');
    expect(model?.error_code).toBe('MODEL_FILE_MISSING');
  });

  it('returns 0 for cleanupStagingFiles with the stub native module', async () => {
    const removed = await cleanupStagingFiles();
    expect(removed).toBe(0);
  });
});

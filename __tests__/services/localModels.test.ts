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
} from '../../src/services/localModels';

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

describe('localModels service', () => {
  beforeEach(() => {
    mockModels.length = 0;
    jest.clearAllMocks();
  });

  it('creates and lists a local model', async () => {
    await createLocalModel({
      id: 'model-1',
      display_name: 'Test Model',
      original_filename: 'test.litertlm',
      relative_path: 'model-1/model.litertlm',
      file_size: 1024,
      sha256: 'abc123',
      status: 'ready',
      backend_preference: 'auto',
      validated_backend: 'cpu',
      context_length: 2048,
      max_output_tokens: 512,
      load_time_ms: null,
      first_token_ms: null,
      tokens_per_second: null,
      last_used_at: null,
      last_validated_at: null,
      error_code: null,
      error_message: null,
    });

    const models = await listLocalModels();
    expect(models).toHaveLength(1);
    expect(models[0].display_name).toBe('Test Model');
  });

  it('finds model by sha256', async () => {
    await createLocalModel({
      id: 'model-2',
      display_name: 'Another Model',
      original_filename: 'another.litertlm',
      relative_path: 'model-2/model.litertlm',
      file_size: 2048,
      sha256: 'def456',
      status: 'ready',
      backend_preference: 'gpu',
      validated_backend: 'gpu',
      context_length: 4096,
      max_output_tokens: 1024,
      load_time_ms: null,
      first_token_ms: null,
      tokens_per_second: null,
      last_used_at: null,
      last_validated_at: null,
      error_code: null,
      error_message: null,
    });

    const found = await getLocalModelBySha256('def456');
    expect(found?.display_name).toBe('Another Model');
    expect(await getLocalModelBySha256('missing')).toBeNull();
  });

  it('updates and deletes a model', async () => {
    await createLocalModel({
      id: 'model-3',
      display_name: 'Old Name',
      original_filename: 'old.litertlm',
      relative_path: 'model-3/model.litertlm',
      file_size: 512,
      sha256: 'ghi789',
      status: 'importing',
      backend_preference: 'auto',
      validated_backend: null,
      context_length: null,
      max_output_tokens: null,
      load_time_ms: null,
      first_token_ms: null,
      tokens_per_second: null,
      last_used_at: null,
      last_validated_at: null,
      error_code: null,
      error_message: null,
    });

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
    await createLocalModel({
      id: 'model-orphan',
      display_name: 'Orphan',
      original_filename: 'orphan.litertlm',
      relative_path: 'model-orphan/model.litertlm',
      file_size: 100,
      sha256: 'orphan-sha',
      status: 'ready',
      backend_preference: 'auto',
      validated_backend: 'cpu',
      context_length: 2048,
      max_output_tokens: 512,
      load_time_ms: null,
      first_token_ms: null,
      tokens_per_second: null,
      last_used_at: null,
      last_validated_at: null,
      error_code: null,
      error_message: null,
    });

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

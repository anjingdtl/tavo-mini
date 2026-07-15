/* eslint-env jest */

const mockListLocalModels = jest.fn();
const mockGetLocalModelById = jest.fn();
const mockImportLocalModel = jest.fn();
const mockValidateLocalModel = jest.fn();
const mockLoadLocalModel = jest.fn();
const mockDeleteLocalModel = jest.fn();
const mockIsLlamaCppAvailable = jest.fn();
const mockProbeLlamaCppAvailable = jest.fn();
const mockSubscribeImportEvents = jest.fn();

jest.mock('../src/services/localModels', () => ({
  listLocalModels: (...args: any[]) => mockListLocalModels(...args),
  getLocalModelById: (...args: any[]) => mockGetLocalModelById(...args),
  importLocalModel: (...args: any[]) => mockImportLocalModel(...args),
  validateLocalModel: (...args: any[]) => mockValidateLocalModel(...args),
  loadLocalModel: (...args: any[]) => mockLoadLocalModel(...args),
  deleteLocalModel: (...args: any[]) => mockDeleteLocalModel(...args),
}));

jest.mock('../src/native/LlamaCppModule', () => ({
  isLlamaCppAvailable: (...args: any[]) => mockIsLlamaCppAvailable(...args),
  probeLlamaCppAvailable: (...args: any[]) => mockProbeLlamaCppAvailable(...args),
  subscribeImportEvents: (...args: any[]) => mockSubscribeImportEvents(...args),
}));

import { useLocalModelStore } from '../src/store/localModelStore';

const model = {
  id: 'model-1',
  display_name: '测试模型',
  original_filename: 'test.gguf',
  relative_path: 'models/test.gguf',
  file_size: 100,
  sha256: 'sha-1',
  status: 'ready',
  backend_preference: 'auto',
  validated_backend: 'cpu',
  context_length: null,
  max_output_tokens: null,
  load_time_ms: 10,
  first_token_ms: null,
  tokens_per_second: null,
  imported_at: '2026-01-01',
  last_used_at: null,
  last_validated_at: null,
  error_code: null,
  error_message: null,
  prompt_template: 'chatml',
  actual_backend: 'cpu',
} as any;

describe('local model store lifecycle', () => {
  let observers: any;
  let unsubscribe: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    unsubscribe = jest.fn();
    observers = null;
    mockListLocalModels.mockResolvedValue([model]);
    mockGetLocalModelById.mockResolvedValue(model);
    mockImportLocalModel.mockResolvedValue(model);
    mockValidateLocalModel.mockResolvedValue(undefined);
    mockLoadLocalModel.mockResolvedValue({ backend: 'cpu', loadTimeMs: 10 });
    mockDeleteLocalModel.mockResolvedValue(undefined);
    mockIsLlamaCppAvailable.mockReturnValue(true);
    mockProbeLlamaCppAvailable.mockResolvedValue(true);
    mockSubscribeImportEvents.mockImplementation((nextObservers: any) => {
      observers = nextObservers;
      return unsubscribe;
    });
    useLocalModelStore.setState({
      models: [],
      import: {
        importId: null,
        state: 'idle',
        bytesCopied: 0,
        totalBytes: 0,
        errorCode: null,
        errorMessage: null,
      },
      loadingModelId: null,
    });
  });

  test('refreshes, loads, validates, deletes, and cancels a model', async () => {
    await useLocalModelStore.getState().refreshModels();
    expect(useLocalModelStore.getState().models).toEqual([model]);
    await useLocalModelStore.getState().loadModel(model.id);
    expect(useLocalModelStore.getState().loadingModelId).toBeNull();

    mockGetLocalModelById.mockResolvedValueOnce(null);
    await expect(useLocalModelStore.getState().loadModel('missing')).rejects.toThrow('模型不存在');
    await useLocalModelStore.getState().validateModel(model.id);
    expect(useLocalModelStore.getState().import.state).toBe('idle');
    await useLocalModelStore.getState().deleteModel(model.id);
    expect(mockDeleteLocalModel).toHaveBeenCalledWith(model);

    mockGetLocalModelById.mockResolvedValueOnce(null);
    await expect(useLocalModelStore.getState().deleteModel('missing')).rejects.toThrow('模型不存在');
    await useLocalModelStore.getState().cancelImport();
    expect(useLocalModelStore.getState().import.state).toBe('idle');
  });

  test('imports with progress events and transitions to ready', async () => {
    mockImportLocalModel.mockImplementationOnce(async () => {
      observers.onProgress({ importId: 'native-id', bytesCopied: 50, totalBytes: 100 });
      observers.onProgress({ importId: 'other-id', bytesCopied: 10, totalBytes: 100 });
      observers.onState({ importId: 'native-id', state: 'hashing' });
      return model;
    });
    await useLocalModelStore.getState().startImport('content://model', 'test.gguf', '显示名', 100);
    expect(mockImportLocalModel).toHaveBeenCalledWith('content://model', 'test.gguf', '显示名');
    expect(mockValidateLocalModel).toHaveBeenCalledWith(model);
    expect(useLocalModelStore.getState().import.state).toBe('ready');
    expect(useLocalModelStore.getState().import.importId).toBe(model.id);
    expect(unsubscribe).toHaveBeenCalled();
  });

  test('reports engine-unavailable and native failure states', async () => {
    mockIsLlamaCppAvailable.mockReturnValue(false);
    mockProbeLlamaCppAvailable.mockResolvedValue(false);
    await expect(useLocalModelStore.getState().startImport('content://model', 'test.gguf')).rejects.toThrow('初始化失败');
    expect(useLocalModelStore.getState().import.errorCode).toBe('ENGINE_UNAVAILABLE');

    mockIsLlamaCppAvailable.mockReturnValue(true);
    mockImportLocalModel.mockRejectedValueOnce(Object.assign(new Error('llama.cpp native error'), { code: 'NATIVE_FAILED' }));
    await expect(useLocalModelStore.getState().startImport('content://model', 'test.gguf')).rejects.toThrow('llama.cpp');
    expect(useLocalModelStore.getState().import.errorMessage).toContain('本地模型引擎');
    expect(unsubscribe).toHaveBeenCalled();
  });

  test('cleans validation failure state and accepts missing-model imports', async () => {
    mockValidateLocalModel.mockRejectedValueOnce(new Error('校验失败'));
    await expect(useLocalModelStore.getState().validateModel(model.id)).rejects.toThrow('校验失败');
    expect(useLocalModelStore.getState().import.state).toBe('idle');

    mockGetLocalModelById.mockResolvedValueOnce({ ...model, status: 'missing' });
    await useLocalModelStore.getState().loadModel(model.id);
    expect(mockLoadLocalModel).toHaveBeenCalled();
  });
});

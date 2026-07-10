/* eslint-env jest */

import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';

const mockStartImport = jest.fn();
const mockSaveLLMConfig = jest.fn();
const mockAlert = jest.fn();
const mockIsLlamaCppAvailable = jest.fn(() => true);

const mockPick = jest.fn();
const mockIsCancel = jest.fn(() => false);

// 不 mock localModelStore，使用真实 zustand store；
// 通过 mock 它依赖的 LlamaCppModule + 数据库服务来跑真实状态机。
jest.mock('../src/native/LlamaCppModule', () => ({
  isLlamaCppAvailable: () => mockIsLlamaCppAvailable(),
  probeLlamaCppAvailable: jest.fn(async (_timeoutMs = 2000) => {
    return mockIsLlamaCppAvailable();
  }),
  subscribeImportEvents: jest.fn(() => () => {}),
  importModel: (...args: any[]) => mockStartImport(...args),
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
  LlamaCppEvents: {
    TOKEN: 'LlamaCppToken',
    COMPLETED: 'LlamaCppCompleted',
    ERROR: 'LlamaCppError',
    IMPORT_PROGRESS: 'LlamaCppImportProgress',
    IMPORT_STATE: 'LlamaCppImportState',
  },
  LlamaCppNative: {},
}));

const mockListLocalModels = jest.fn(async () => []);
const mockGetLocalModelById = jest.fn(async () => null);
const mockCreateLocalModel = jest.fn(async () => undefined);
const mockUpdateLocalModel = jest.fn(async () => undefined);
const mockGetLocalModelBySha256 = jest.fn(async () => null);
const mockDeleteLocalModelRecord = jest.fn(async () => undefined);
const mockCountLLMConfigsUsingModel = jest.fn(async () => 0);

jest.mock('../src/services/database', () => ({
  listLocalModels: (...args: any[]) => mockListLocalModels(...args),
  getLocalModelById: (...args: any[]) => mockGetLocalModelById(...args),
  getLocalModelBySha256: (...args: any[]) => mockGetLocalModelBySha256(...args),
  createLocalModel: (...args: any[]) => mockCreateLocalModel(...args),
  updateLocalModel: (...args: any[]) => mockUpdateLocalModel(...args),
  deleteLocalModelRecord: (...args: any[]) => mockDeleteLocalModelRecord(...args),
  countLLMConfigsUsingModel: (...args: any[]) => mockCountLLMConfigsUsingModel(...args),
}));

jest.mock('../src/services/llm/llamaCppProvider', () => ({
  invalidateLoadedModel: jest.fn(),
}));

jest.mock('../src/store/settingsStore', () => ({
  useSettingsStore: () => ({ saveLLMConfig: mockSaveLLMConfig }),
}));

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      colors: {
        accent: '#439EA6',
        accentSoft: '#D7F1F4',
        textPrimary: '#222',
        textSecondary: '#666',
        card: '#fff',
        background: '#fff',
        border: '#ddd',
        surface: '#fff',
      },
    },
  }),
}));

jest.mock('@react-native-documents/picker', () => ({
  pick: (...args: any[]) => mockPick(...args),
  keepLocalCopy: (...args: any[]) => mockKeepLocalCopy(...args),
  types: { json: 'application/json', images: 'image/*', plainText: 'text/plain', allFiles: '*/*' },
  isCancel: (...args: any[]) => mockIsCancel(...args),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
}));

import { useLocalModelStore } from '../src/store/localModelStore';
import { LocalModelManagerScreen } from '../src/screens/LocalModelManagerScreen';

beforeAll(() => {
  (Alert as any).alert = mockAlert;
});

describe('LocalModelManagerScreen import regression', () => {
  let rtl: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsLlamaCppAvailable.mockReturnValue(true);
    // 重置 store 状态
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

  afterEach(() => {
    if (rtl && rtl.unmount) {
      rtl.unmount();
      rtl = null;
    }
    // 清掉 store 内可能残留的 setTimeout
    jest.useFakeTimers();
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('exposes a visible preparing state right after the user picks a .gguf file, even when the native import never resolves', async () => {
    mockPick.mockResolvedValue([
      { uri: 'content://downloads/qwen.gguf', name: 'qwen.gguf', type: 'application/octet-stream' },
    ]);
    // 模拟原生层挂起：永远不 resolve
    let resolveImport: (() => void) | null = null;
    mockStartImport.mockImplementation(
      () => new Promise<any>((resolve) => { resolveImport = () => resolve(undefined as any); }),
    );

    rtl = render(<LocalModelManagerScreen />);
    const importLabel = rtl.getByText('导入 .gguf 模型');
    let importButton: any = importLabel;
    while (importButton && !importButton.props?.onPress && importButton.parent) {
      importButton = importButton.parent;
    }
    expect(importButton).toBeTruthy();

    await act(async () => {
      fireEvent.press(importButton);
    });
    // 等待微任务链让 set state 落定
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const currentState = useLocalModelStore.getState().import.state;
    expect(['preparing', 'selecting', 'copying', 'hashing', 'validating', 'ready']).toContain(
      currentState,
    );
    expect(mockAlert).not.toHaveBeenCalled();

    // 主动让 mock 解析，防止 store 内 await 链悬挂到测试结束之后
    if (resolveImport) resolveImport();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('shows an error Alert when the native module is not available, instead of leaving the UI hanging', async () => {
    mockIsLlamaCppAvailable.mockReturnValue(false);
    mockPick.mockResolvedValue([
      { uri: 'content://downloads/qwen.gguf', name: 'qwen.gguf', type: 'application/octet-stream' },
    ]);

    rtl = render(<LocalModelManagerScreen />);
    const importLabel = rtl.getByText('导入 .gguf 模型');
    let importButton: any = importLabel;
    while (importButton && !importButton.props?.onPress && importButton.parent) {
      importButton = importButton.parent;
    }
    expect(importButton).toBeTruthy();

    await act(async () => {
      fireEvent.press(importButton);
    });
    // 等待 store 内探测 + microtask 链全部走完
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const finalState = useLocalModelStore.getState().import;
    // 状态必须落到 error，不能卡在 idle 或 preparing
    expect(finalState.state).toBe('error');
    // Alert 必须被调用，给用户反馈
    expect(mockAlert).toHaveBeenCalled();
    const args = mockAlert.mock.calls[0];
    expect(args[0]).toBe('导入失败');
    expect(typeof args[1]).toBe('string');
    expect((args[1] as string).length).toBeGreaterThan(0);
  });

  it('translates engine unavailable error into a Chinese friendly message', async () => {
    mockIsLlamaCppAvailable.mockReturnValue(false);
    mockPick.mockResolvedValue([
      { uri: 'content://downloads/qwen.gguf', name: 'qwen.gguf', type: 'application/octet-stream' },
    ]);

    rtl = render(<LocalModelManagerScreen />);
    const importLabel = rtl.getByText('导入 .gguf 模型');
    let importButton: any = importLabel;
    while (importButton && !importButton.props?.onPress && importButton.parent) {
      importButton = importButton.parent;
    }

    await act(async () => {
      fireEvent.press(importButton);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const errorMessage = useLocalModelStore.getState().import.errorMessage || '';
    // 关键：要么是 store 内置的 ENGINE_UNAVAILABLE 消息，要么是 UI 翻译
    const allMessageTexts = [errorMessage, ...mockAlert.mock.calls.flat().map(String)];
    const hasFriendlyText = allMessageTexts.some(
      (m) => m.includes('本地模型引擎') || m.includes('llama.cpp') || m.includes('重启'),
    );
    expect(hasFriendlyText).toBe(true);
  });

  it('uses the async probe to recover when the sync TurboModule check reports false on RN 0.85 bridgeless', async () => {
    // 模拟 RN 0.85 bridgeless 模式下：同步判定为 false，但异步探测能拿到 TurboModule
    let firstCheck = true;
    mockIsLlamaCppAvailable.mockImplementation(() => {
      // 同步判定返回 false（首次）；异步探测返回 true（TurboModule 异步注入完成）
      const v = firstCheck;
      firstCheck = true;
      return v;
    });
    // 用 setTimeout 在第 3 次检查（async probe）时返回 true
    let probeCalls = 0;
    const realProbe = (timeoutMs = 1500) =>
      new Promise<boolean>((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
          probeCalls += 1;
          if (probeCalls >= 2) {
            resolve(true);
            return;
          }
          if (Date.now() >= deadline) {
            resolve(false);
            return;
          }
          setTimeout(check, 20);
        };
        check();
      });
    // 重新覆盖 probe 的实现
    const { probeLlamaCppAvailable } = require('../src/native/LlamaCppModule');
    probeLlamaCppAvailable.mockImplementation(realProbe);

    mockPick.mockResolvedValue([
      { uri: 'content://downloads/qwen.gguf', name: 'qwen.gguf', type: 'application/octet-stream' },
    ]);
    let resolveImport: (() => void) | null = null;
    mockStartImport.mockImplementation(
      () => new Promise<any>((resolve) => { resolveImport = () => resolve(undefined as any); }),
    );

    rtl = render(<LocalModelManagerScreen />);
    const importLabel = rtl.getByText('导入 .gguf 模型');
    let importButton: any = importLabel;
    while (importButton && !importButton.props?.onPress && importButton.parent) {
      importButton = importButton.parent;
    }

    await act(async () => {
      fireEvent.press(importButton);
    });
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 100));
      await Promise.resolve();
    });

    const state = useLocalModelStore.getState().import.state;
    expect(['preparing', 'selecting', 'copying', 'hashing', 'validating', 'ready']).toContain(
      state,
    );
    expect(state).not.toBe('error');
    expect(mockAlert).not.toHaveBeenCalled();

    if (resolveImport) resolveImport();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('creates llama.cpp configs with a local-friendly max output default when the model has no token limit', async () => {
    mockListLocalModels.mockResolvedValue([
      {
        id: 'local-qwen3',
        display_name: 'Qwen3-0.6B-Q2_K',
        original_filename: 'Qwen3-0.6B-Q2_K.gguf',
        file_size: 296238784,
        sha256: 'abc',
        relative_path: 'local-qwen3/model.gguf',
        status: 'ready',
        backend_preference: 'cpu',
        validated_backend: 'cpu',
        actual_backend: 'cpu',
        prompt_template: 'chatml',
        context_length: 4096,
        max_output_tokens: null,
        load_time_ms: 2957,
        imported_at: '2026-07-09T18:16:38.397Z',
        last_validated_at: '2026-07-09T18:16:38.397Z',
        error_code: null,
        error_message: null,
      },
    ]);
    mockSaveLLMConfig.mockResolvedValue(2);

    rtl = render(<LocalModelManagerScreen />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const createLabel = rtl.getByText('创建 AI 配置');
    let createButton: any = createLabel;
    while (createButton && !createButton.props?.onPress && createButton.parent) {
      createButton = createButton.parent;
    }

    await act(async () => {
      fireEvent.press(createButton);
    });

    expect(mockSaveLLMConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider_type: 'llama_cpp',
        local_model_id: 'local-qwen3',
        max_output_tokens: 512,
      }),
    );
  });
});

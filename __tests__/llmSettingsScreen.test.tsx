import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import type { LLMConfig } from '../src/types/novel';

// LLMSettingsScreen 顶部 Tab 过滤的单元测试：
// - 列表按当前 Tab 的 provider_type 过滤
// - 新增配置预填当前 Tab 类型
// - 删除限制按当前 Tab 同类计数（每类至少保留一个）
// - Header 跨 Tab 提示全局 active 配置

// Alert.alert 在 testing-library 环境可能未定义，用 jest.fn 替换并恢复。
const mockAlert = jest.fn();
const originalAlert = (Alert as { alert?: (...args: any[]) => void }).alert;
beforeAll(() => {
  (Alert as any).alert = mockAlert;
});
afterAll(() => {
  if (originalAlert) {
    (Alert as any).alert = originalAlert;
  } else {
    delete (Alert as any).alert;
  }
});

const onlineConfig = (overrides: Partial<LLMConfig> = {}): LLMConfig => ({
  id: 1,
  name: 'DeepSeek',
  provider_type: 'openai_compatible',
  base_url: 'https://api.deepseek.com',
  api_key: 'sk-xxx',
  model_name: 'deepseek-chat',
  is_active: 1,
  local_model_id: null,
  local_backend: null,
  context_window: 8192,
  max_output_tokens: 4000,
  ...overrides,
});

const localConfig = (overrides: Partial<LLMConfig> = {}): LLMConfig => ({
  id: 2,
  name: '本地 Qwen',
  provider_type: 'llama_cpp',
  base_url: '',
  api_key: '',
  model_name: '',
  is_active: 0,
  local_model_id: 'model-abc',
  local_backend: 'cpu',
  context_window: 2048,
  max_output_tokens: 2000,
  ...overrides,
});

let mockLlmConfigs: LLMConfig[] = [];
const mockSaveLLMConfig = jest.fn(async (config: Partial<LLMConfig>) => {
  return (config as LLMConfig).id || 999;
});
const mockSetActiveLLMConfig = jest.fn(async () => undefined);
const mockDeleteLLMConfig = jest.fn(async () => undefined);
const mockLoadSettings = jest.fn(async () => undefined);
const mockSetAllowInsecureLanHttp = jest.fn(async () => undefined);

jest.mock('../src/store/settingsStore', () => ({
  useSettingsStore: () => ({
    llmConfig: mockLlmConfigs.find(c => c.is_active === 1) || mockLlmConfigs[0],
    llmConfigs: mockLlmConfigs,
    loadSettings: mockLoadSettings,
    saveLLMConfig: mockSaveLLMConfig,
    setActiveLLMConfig: mockSetActiveLLMConfig,
    deleteLLMConfig: mockDeleteLLMConfig,
    allowInsecureLanHttp: false,
    setAllowInsecureLanHttp: mockSetAllowInsecureLanHttp,
  }),
}));

// 屏蔽 navigation / Toast / 连接测试 / 上下文同步 / 本地模型选择器（避免 DB）
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
}));
jest.mock('react-native-toast-message', () => ({
  show: jest.fn(),
}));
jest.mock('../src/services/llm', () => ({
  testLLMConnection: jest.fn(async () => 'ok'),
}));
jest.mock('../src/services/contextAutoAllocator', () => ({
  syncPipelineMaxTokensFromContextWindow: jest.fn(async () => ({
    draftMaxTokens: 800,
    reviewMaxTokens: 240,
    factCheckMaxTokens: 240,
    proofMaxTokens: 320,
  })),
}));
jest.mock('../src/components/LocalModelSelector', () => ({
  LocalModelSelector: () => null,
}));

import { LLMSettingsScreen } from '../src/screens/LLMSettingsScreen';

describe('LLMSettingsScreen Tab 过滤', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAlert.mockClear();
    mockLlmConfigs = [onlineConfig(), localConfig()];
  });

  // 顶部 Tab 与编辑区 SegmentedControl 都含「本地 GGUF」文本；
  // Tab 渲染在前，getAllByText 取第一个即为 Tab。
  const pressLocalTab = (utils: ReturnType<typeof render>) => {
    const tabs = utils.getAllByText('本地 GGUF');
    fireEvent.press(tabs[0]);
  };

  it('默认显示在线 API Tab，列表只含在线配置', () => {
    const { getByText, queryByText } = render(<LLMSettingsScreen />);
    expect(getByText('DeepSeek')).toBeTruthy();
    expect(queryByText('本地 Qwen')).toBeNull();
  });

  it('切到本地 GGUF Tab 后列表只含本地配置', () => {
    const utils = render(<LLMSettingsScreen />);
    pressLocalTab(utils);
    expect(utils.getByText('本地 Qwen')).toBeTruthy();
    expect(utils.queryByText('DeepSeek')).toBeNull();
  });

  it('Header 跨 Tab 提示全局 active 配置（在本地 Tab 也能看到在线 active 名）', () => {
    const utils = render(<LLMSettingsScreen />);
    pressLocalTab(utils);
    // Header subtitle 仍含全局 active 名称 DeepSeek
    expect(utils.getAllByText(/DeepSeek/).length).toBeGreaterThan(0);
  });

  it('在在线 API Tab 点新增，draft 的 provider_type 为 openai_compatible', () => {
    const { getByText } = render(<LLMSettingsScreen />);
    fireEvent.press(getByText('新增'));
    expect(getByText('Base URL')).toBeTruthy();
    expect(getByText('API Key')).toBeTruthy();
  });

  it('在本地 GGUF Tab 点新增，draft 的 provider_type 为 llama_cpp 且隐藏在线字段', () => {
    const utils = render(<LLMSettingsScreen />);
    pressLocalTab(utils);
    fireEvent.press(utils.getByText('新增'));
    expect(utils.queryByText('Base URL')).toBeNull();
    expect(utils.queryByText('API Key')).toBeNull();
    expect(utils.getByText('配置名称')).toBeTruthy();
  });

  it('当前 Tab 仅剩一个配置时禁止删除并提示该类型', () => {
    const { getByText } = render(<LLMSettingsScreen />);
    fireEvent.press(getByText('删除'));
    expect(mockAlert).toHaveBeenCalledWith(
      '无法删除',
      '至少需要保留一个在线 API配置。',
    );
  });

  it('当前 Tab 有多个配置时允许进入删除确认', async () => {
    mockLlmConfigs = [
      onlineConfig({ id: 1, name: 'DeepSeek', is_active: 1 }),
      onlineConfig({ id: 3, name: 'OpenAI', is_active: 0 }),
      localConfig(),
    ];
    const { getByText } = render(<LLMSettingsScreen />);
    fireEvent.press(getByText('删除'));
    await waitFor(() => {
      expect(mockAlert).toHaveBeenCalledWith(
        '删除配置',
        expect.stringContaining('确定删除'),
        expect.any(Array),
      );
    });
  });
});

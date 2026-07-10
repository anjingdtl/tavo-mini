/* eslint-env jest */

const mockGetLLMConfig = jest.fn();
const mockGetLLMConfigs = jest.fn();
const mockGetLocalModelById = jest.fn();
const mockSetActiveLLMConfig = jest.fn(async () => undefined);

jest.mock('../src/services/database', () => ({
  getLLMConfig: (...args: any[]) => mockGetLLMConfig(...args),
  getLLMConfigs: (...args: any[]) => mockGetLLMConfigs(...args),
  getLocalModelById: (...args: any[]) => mockGetLocalModelById(...args),
  setActiveLLMConfig: (...args: any[]) => mockSetActiveLLMConfig(...args),
}));

import { resolveLLMRequestConfig } from '../src/services/llm';

const blankOnlineConfig = {
  id: 1,
  name: '默认配置',
  provider_type: 'openai_compatible',
  base_url: '',
  api_key: '',
  model_name: '',
  is_active: 1,
  local_model_id: null,
  local_backend: null,
  context_window: 4096,
  max_output_tokens: 4000,
};

const localConfig = {
  id: 2,
  name: '本地：Qwen3',
  provider_type: 'llama_cpp',
  base_url: '',
  api_key: '',
  model_name: 'Qwen3',
  is_active: 0,
  local_model_id: 'local-qwen3',
  local_backend: 'cpu',
  context_window: 4096,
  max_output_tokens: 512,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetLLMConfig.mockResolvedValue(blankOnlineConfig);
  mockGetLLMConfigs.mockResolvedValue([blankOnlineConfig, localConfig]);
  mockGetLocalModelById.mockResolvedValue({ id: 'local-qwen3', status: 'ready' });
});

test('repairs a legacy inactive local config before pipeline generation', async () => {
  await expect(resolveLLMRequestConfig()).resolves.toMatchObject({
    id: 2,
    provider_type: 'llama_cpp',
    local_model_id: 'local-qwen3',
    url: '',
  });
  expect(mockSetActiveLLMConfig).toHaveBeenCalledWith(2);
});

test('does not replace an explicitly configured online provider', async () => {
  mockGetLLMConfig.mockResolvedValue({
    ...blankOnlineConfig,
    base_url: 'https://api.example.com',
    api_key: 'sk-test',
    model_name: 'online-model',
  });

  await expect(resolveLLMRequestConfig()).resolves.toMatchObject({
    id: 1,
    provider_type: 'openai_compatible',
    model_name: 'online-model',
  });
  expect(mockGetLLMConfigs).not.toHaveBeenCalled();
  expect(mockSetActiveLLMConfig).not.toHaveBeenCalled();
});

test('does not activate a local config whose imported model is unavailable', async () => {
  mockGetLocalModelById.mockResolvedValue({ id: 'local-qwen3', status: 'missing' });

  await expect(resolveLLMRequestConfig()).resolves.toMatchObject({
    id: 1,
    provider_type: 'openai_compatible',
  });
  expect(mockSetActiveLLMConfig).not.toHaveBeenCalled();
});

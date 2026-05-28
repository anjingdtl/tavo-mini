import { create } from 'zustand';
import * as db from '../services/database';
import type { ContextConfig, LLMConfig } from '../types/novel';

interface SettingsState {
  llmConfig: LLMConfig;
  contextConfig: ContextConfig;
  loadSettings: () => Promise<void>;
  setLLMConfig: (baseUrl: string, apiKey: string, modelName: string) => Promise<void>;
  setContextConfig: (config: ContextConfig) => Promise<void>;
}

const defaultContextConfig: ContextConfig = {
  strategy: 'sliding',
  slidingWindowSize: 4000,
  customRangeStart: 0,
  customRangeEnd: -1,
  resourceBudget: 2000,
  includeResources: true,
};

export const useSettingsStore = create<SettingsState>((set) => ({
  llmConfig: { id: 1, base_url: '', api_key: '', model_name: '' },
  contextConfig: defaultContextConfig,

  loadSettings: async () => {
    const [llmConfig, contextConfig] = await Promise.all([db.getLLMConfig(), db.getContextConfig()]);
    set({ llmConfig, contextConfig });
  },

  setLLMConfig: async (baseUrl, apiKey, modelName) => {
    await db.setLLMConfig(baseUrl, apiKey, modelName);
    set({ llmConfig: { id: 1, base_url: baseUrl, api_key: apiKey, model_name: modelName } });
  },

  setContextConfig: async (contextConfig) => {
    await db.setContextConfig(contextConfig);
    set({ contextConfig });
  },
}));

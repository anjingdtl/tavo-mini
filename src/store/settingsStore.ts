import { create } from 'zustand';
import * as db from '../services/database';
import { DEFAULT_CONTEXT_CONFIG } from '../constants/defaults';
import type { ContextConfig, LLMConfig } from '../types/novel';

interface SettingsState {
  llmConfig: LLMConfig;
  llmConfigs: LLMConfig[];
  contextConfig: ContextConfig;
  backgroundPipelineEnabled: boolean;
  loadSettings: () => Promise<void>;
  setLLMConfig: (baseUrl: string, apiKey: string, modelName: string) => Promise<void>;
  saveLLMConfig: (config: Partial<LLMConfig>) => Promise<number>;
  setActiveLLMConfig: (id: number) => Promise<void>;
  deleteLLMConfig: (id: number) => Promise<void>;
  setContextConfig: (config: ContextConfig) => Promise<void>;
  setBackgroundPipelineEnabled: (enabled: boolean) => Promise<void>;
}

const emptyLLMConfig: LLMConfig = {
  id: 1,
  name: '默认配置',
  base_url: '',
  api_key: '',
  model_name: '',
  is_active: 1,
};

export const useSettingsStore = create<SettingsState>((set) => ({
  llmConfig: emptyLLMConfig,
  llmConfigs: [emptyLLMConfig],
  contextConfig: DEFAULT_CONTEXT_CONFIG,
  backgroundPipelineEnabled: true,

  loadSettings: async () => {
    const [llmConfigs, contextConfig, backgroundPipelineEnabled] = await Promise.all([
      db.getLLMConfigs(),
      db.getContextConfig(),
      db.getBackgroundPipelineEnabled(),
    ]);
    const llmConfig = llmConfigs.find((config) => config.is_active === 1) || llmConfigs[0] || emptyLLMConfig;
    set({ llmConfig, llmConfigs, contextConfig, backgroundPipelineEnabled });
    // 同步到 PipelineForeground 桥接，决定流水线入口是否起前台服务
    const { PipelineForeground } = require('../native/PipelineForegroundModule');
    PipelineForeground.setEnabled(backgroundPipelineEnabled);
  },

  setLLMConfig: async (baseUrl, apiKey, modelName) => {
    await db.setLLMConfig(baseUrl, apiKey, modelName);
    const llmConfigs = await db.getLLMConfigs();
    const llmConfig = llmConfigs.find((config) => config.is_active === 1) || llmConfigs[0] || emptyLLMConfig;
    set({ llmConfig, llmConfigs });
  },

  saveLLMConfig: async (config) => {
    const id = await db.saveLLMConfig(config);
    const llmConfigs = await db.getLLMConfigs();
    const llmConfig = llmConfigs.find((item) => item.is_active === 1) || llmConfigs[0] || emptyLLMConfig;
    set({ llmConfig, llmConfigs });
    return id;
  },

  setActiveLLMConfig: async (id) => {
    await db.setActiveLLMConfig(id);
    const llmConfigs = await db.getLLMConfigs();
    const llmConfig = llmConfigs.find((config) => config.is_active === 1) || llmConfigs[0] || emptyLLMConfig;
    set({ llmConfig, llmConfigs });
  },

  deleteLLMConfig: async (id) => {
    await db.deleteLLMConfig(id);
    const llmConfigs = await db.getLLMConfigs();
    const llmConfig = llmConfigs.find((config) => config.is_active === 1) || llmConfigs[0] || emptyLLMConfig;
    set({ llmConfig, llmConfigs });
  },

  setContextConfig: async (contextConfig) => {
    await db.setContextConfig(contextConfig);
    set({ contextConfig });
  },

  setBackgroundPipelineEnabled: async (enabled) => {
    await db.setBackgroundPipelineEnabled(enabled);
    set({ backgroundPipelineEnabled: enabled });
    const { PipelineForeground } = require('../native/PipelineForegroundModule');
    PipelineForeground.setEnabled(enabled);
  },
}));

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
    // 后台保活必须独立于其余设置加载：LLM 配置或上下文配置读失败时，
    // 仍要把已持久化的后台开关同步给原生前台服务桥接。
    let backgroundPipelineEnabled = true;
    try {
      backgroundPipelineEnabled = await db.getBackgroundPipelineEnabled();
    } catch (error) {
      console.warn('[settingsStore] load background pipeline setting failed:', error);
    }
    const { PipelineForeground } = require('../native/PipelineForegroundModule');
    PipelineForeground.setEnabled(backgroundPipelineEnabled);
    set({ backgroundPipelineEnabled });

    try {
      const [llmConfigsInitial, contextConfig] = await Promise.all([
        db.getLLMConfigs(),
        db.getContextConfig(),
      ]);
      // 修复#C: 自愈——若 DB 中无 active 配置（历史 bug 或外部修改导致 is_active 全为 0），
      // 自动激活第一个配置，避免 UI 一直显示"当前：未选择"
      let llmConfigs = llmConfigsInitial;
      if (llmConfigs.length > 0 && !llmConfigs.some((c) => c.is_active === 1)) {
        await db.setActiveLLMConfig(llmConfigs[0].id);
        llmConfigs = await db.getLLMConfigs();
      }
      const llmConfig = llmConfigs.find((config) => config.is_active === 1) || llmConfigs[0] || emptyLLMConfig;
      set({ llmConfig, llmConfigs, contextConfig, backgroundPipelineEnabled });
    } catch (error) {
      console.warn('[settingsStore] loadSettings failed:', error);
    }
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

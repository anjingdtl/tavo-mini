import { create } from 'zustand';
import * as db from '../services/database';
import {
  DEFAULT_BACKGROUND_PIPELINE_ENABLED,
  DEFAULT_CONTEXT_CONFIG,
} from '../constants/defaults';
import type { ContextConfig, LLMConfig } from '../types/novel';

interface SettingsState {
  llmConfig: LLMConfig;
  llmConfigs: LLMConfig[];
  contextConfig: ContextConfig;
  backgroundPipelineEnabled: boolean;
  allowInsecureLanHttp: boolean;
  loadSettings: () => Promise<void>;
  setLLMConfig: (
    baseUrl: string,
    apiKey: string,
    modelName: string,
  ) => Promise<void>;
  saveLLMConfig: (config: Partial<LLMConfig>) => Promise<number>;
  setActiveLLMConfig: (id: number) => Promise<void>;
  deleteLLMConfig: (id: number) => Promise<void>;
  setContextConfig: (config: ContextConfig) => Promise<void>;
  setBackgroundPipelineEnabled: (enabled: boolean) => Promise<void>;
  setAllowInsecureLanHttp: (enabled: boolean) => Promise<void>;
}

const emptyLLMConfig: LLMConfig = {
  id: 1,
  name: '默认配置',
  provider_type: 'openai_compatible',
  base_url: '',
  api_key: '',
  model_name: '',
  is_active: 1,
  // 0 is the persisted AUTO/unknown sentinel. Runtime derives output from
  // the selected model context; the store must not manufacture a capability.
  context_window: 0,
  max_output_tokens: 0,
};

export const useSettingsStore = create<SettingsState>(set => ({
  llmConfig: emptyLLMConfig,
  llmConfigs: [emptyLLMConfig],
  contextConfig: DEFAULT_CONTEXT_CONFIG,
  backgroundPipelineEnabled: DEFAULT_BACKGROUND_PIPELINE_ENABLED,
  allowInsecureLanHttp: false,

  loadSettings: async () => {
    // 后台保活必须独立于其余设置加载：LLM 配置或上下文配置读失败时，
    // 仍要把全局默认开启状态同步给原生前台服务桥接。
    let backgroundPipelineEnabled = DEFAULT_BACKGROUND_PIPELINE_ENABLED;
    let allowInsecureLanHttp = false;
    try {
      backgroundPipelineEnabled = await db.getBackgroundPipelineEnabled();
    } catch (error) {
      console.warn(
        '[settingsStore] load background pipeline setting failed:',
        error,
      );
    }
    if (typeof (db as any).getAllowInsecureLanHttp === 'function') {
      try {
        allowInsecureLanHttp = await db.getAllowInsecureLanHttp();
      } catch (error) {
        console.warn(
          '[settingsStore] load network policy setting failed:',
          error,
        );
      }
    }
    // 忽略历史数据库中的关闭值，后台写作始终全局开启。
    backgroundPipelineEnabled = DEFAULT_BACKGROUND_PIPELINE_ENABLED;
    const {
      PipelineForeground,
    } = require('../native/PipelineForegroundModule');
    PipelineForeground.setEnabled(backgroundPipelineEnabled);
    set({ backgroundPipelineEnabled, allowInsecureLanHttp });

    try {
      const [llmConfigsInitial, contextConfig] = await Promise.all([
        db.getLLMConfigs(),
        db.getContextConfig(),
      ]);
      let usableConfigs = llmConfigsInitial;
      // 修复#C: 自愈——若 DB 中无 active 配置（历史 bug 或外部修改导致 is_active 全为 0），
      // 自动激活第一个配置，避免 UI 一直显示"当前：未选择"
      let llmConfigs = llmConfigsInitial;
      if (
        usableConfigs.length > 0 &&
        !usableConfigs.some(c => c.is_active === 1)
      ) {
        await db.setActiveLLMConfig(usableConfigs[0].id);
        llmConfigs = await db.getLLMConfigs();
        usableConfigs = llmConfigs;
      }
      const llmConfig =
        usableConfigs.find(config => config.is_active === 1) ||
        usableConfigs[0] ||
        emptyLLMConfig;
      set({
        llmConfig,
        llmConfigs,
        contextConfig,
        backgroundPipelineEnabled,
        allowInsecureLanHttp,
      });
    } catch (error) {
      console.warn('[settingsStore] loadSettings failed:', error);
    }
  },

  setLLMConfig: async (baseUrl, apiKey, modelName) => {
    await db.setLLMConfig(baseUrl, apiKey, modelName);
    const llmConfigs = await db.getLLMConfigs();
    const llmConfig =
      llmConfigs.find(config => config.is_active === 1) ||
      llmConfigs[0] ||
      emptyLLMConfig;
    set({ llmConfig, llmConfigs });
  },

  saveLLMConfig: async config => {
    const id = await db.saveLLMConfig(config);
    const llmConfigs = await db.getLLMConfigs();
    const llmConfig =
      llmConfigs.find(item => item.is_active === 1) ||
      llmConfigs[0] ||
      emptyLLMConfig;
    set({ llmConfig, llmConfigs });
    return id;
  },

  setActiveLLMConfig: async id => {
    await db.setActiveLLMConfig(id);
    const llmConfigs = await db.getLLMConfigs();
    const llmConfig =
      llmConfigs.find(config => config.is_active === 1) ||
      llmConfigs[0] ||
      emptyLLMConfig;
    set({ llmConfig, llmConfigs });
  },

  deleteLLMConfig: async id => {
    await db.deleteLLMConfig(id);
    const llmConfigs = await db.getLLMConfigs();
    const llmConfig =
      llmConfigs.find(config => config.is_active === 1) ||
      llmConfigs[0] ||
      emptyLLMConfig;
    set({ llmConfig, llmConfigs });
  },

  setContextConfig: async contextConfig => {
    await db.setContextConfig(contextConfig);
    set({ contextConfig });
  },

  setBackgroundPipelineEnabled: async _enabled => {
    // 保留旧 API 以兼容历史调用方，但后台写作不再允许被关闭。
    await db.setBackgroundPipelineEnabled(DEFAULT_BACKGROUND_PIPELINE_ENABLED);
    set({ backgroundPipelineEnabled: DEFAULT_BACKGROUND_PIPELINE_ENABLED });
    const {
      PipelineForeground,
    } = require('../native/PipelineForegroundModule');
    PipelineForeground.setEnabled(DEFAULT_BACKGROUND_PIPELINE_ENABLED);
  },

  setAllowInsecureLanHttp: async enabled => {
    if (typeof (db as any).setAllowInsecureLanHttp === 'function') {
      await db.setAllowInsecureLanHttp(enabled);
    }
    set({ allowInsecureLanHttp: enabled });
  },
}));
